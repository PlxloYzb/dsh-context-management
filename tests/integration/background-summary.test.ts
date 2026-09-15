import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises'
import { type GenerateOptions, type StreamChunk, createUserMessage } from '@deepseek-ai/dsh-llm'
import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { BackgroundSummaries, resolveBackgroundSummary, type PreparedSummary } from '../../src/background-summary.ts'
import { WindowController, seedLayout, resolveArchiveConfig } from '../../src/window-controller.ts'
import { rebuildBlockLedger } from '../../src/region.ts'
import { validWindowMetadata } from '../../src/archive-health.ts'
import { Config, validateContextConfig } from '../../src/index.ts'
import { host, newSession, oldWork, newInput } from './runtime.ts'
import { appendAssistant, appendToolCall, appendToolResult } from '../helpers.ts'

const archive = resolveArchiveConfig(), config = resolveBackgroundSummary({ provider: 'independent', model: 'summary', reasoningEffort: 'minimal', delivery: 'seed' })!
const incoming = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Current instruction overrides history.' }] })
async function setup(id: string, generate: (request: GenerateOptions) => AsyncIterable<StreamChunk>) {
  const h = await host(); h.ctx.provide('llm', { stream: generate })
  const session = newSession(h.ctx, id); oldWork(session)
  const agent = { session, ctx: h.ctx, options: { provider: 'local', model: 'serial' } }
  return { ...h, session, agent, jobs: new BackgroundSummaries(), windows: new WindowController() }
}
async function* good(): AsyncIterable<StreamChunk> { yield { type: 'text-delta', text: 'owner:叶青; rollback:47天; next:verify-9' }; yield { type: 'finish', reason: { kind: 'stop' } } }
async function ready(h: Awaited<ReturnType<typeof setup>>) {
  h.jobs.prepare(h.agent, config, archive, 0, new AbortController().signal, incoming())
  await immediate()
  const result = h.jobs.take(h.agent); assert.ok(result); return result
}

test('prepared summary commits only its snapshot; fresh paired work and current user survive with host shadow pricing and durable replay', async t => {
  let request: GenerateOptions | undefined
  const h = await setup('prepared-suffix', options => { request = options; return good() }); t.after(h.close)
  const before = h.session.snapshotEvents(), seqs = [...h.session.surface.nodes]
  const prepared = await ready(h)
  assert.equal(request?.reasoningEffort, 'minimal')
  assert.equal(request?.purpose, 'compaction')
  assert.equal(h.jobs.take(h.agent), undefined, 'single use')
  assert.deepEqual(h.session.snapshotEvents(), before, 'completion never mutates history')
  newInput(h.session, 'Continue', 2)
  h.session.append('step/start', { turn: 2, step: 1 })
  appendToolCall(h.session, 'fresh read', 'fresh', 2, 1)
  appendToolResult(h.session, 'FRESH-SUFFIX-8cd1', 'fresh', 2, 1)
  h.session.append('step/end', { turn: 2, step: 1 })
  const suffix = h.session.surface.nodes.filter(seq => !seqs.includes(seq))
  const measured = h.ctx.tokenMeter.measure(h.session)
  const result = await h.windows.turnover(h.agent, 'pressure', new AbortController().signal, archive, async () => { await h.ctx.sessions.flush(h.session) }, undefined, undefined, incoming(), prepared)
  assert.ok(result)
  assert.deepEqual(result.shadowedSeqs, seqs)
  assert.ok(suffix.every(seq => h.session.surface.nodes.includes(seq)))
  assert.equal(toolPairingBalancedAfter(h.session, h.session.surface.nodes.at(-1)!), true)
  assert.equal(result.shadowedTokenCount, measured.nodes.filter(n => seqs.includes(n.seq)).reduce((s, n) => s + n.heuristicTokens, 0))
  assert.match(JSON.stringify(h.session.deriveMessages()), /FRESH-SUFFIX-8cd1/)
  assert.deepEqual(h.session.snapshotEvents().slice(0, before.length), before)
  const metadata = rebuildBlockLedger(h.session.snapshotEvents())[0]!.contextManagement!
  assert.equal(metadata.seed.prepared?.throughSeq, seqs.at(-1))
  assert.equal(validWindowMetadata(metadata, metadata.operationId), true)
  assert.equal(validWindowMetadata({ ...metadata, seed: { ...metadata.seed, prepared: null } }, metadata.operationId), false)
  const stored = await h.ctx.sessionPersistence.inspect(h.session.id)
  assert.deepEqual(stored.events, h.session.snapshotEvents())
})

for (const fault of ['route', 'hash', 'generation', 'session', 'byte-budget', 'insufficient-relief'] as const) test(`prepared ${fault} falls back to one deterministic transaction`, async t => {
  const h = await setup(`prepared-${fault}`, good); t.after(h.close)
  let prepared = await ready(h)
  const changes: Partial<PreparedSummary> = fault === 'route' ? { route: 'other' } : fault === 'hash' ? { hash: '0'.repeat(64) } : fault === 'generation' ? { replaceGeneration: 99 } : fault === 'session' ? { sessionId: 'elsewhere' } : fault === 'byte-budget' ? { text: '界'.repeat(5000) } : {}
  prepared = { ...prepared, ...changes }
  newInput(h.session, 'More work', 2); h.session.append('step/start', { turn: 2, step: 1 }); appendAssistant(h.session, 'recent marker', 2, 1); h.session.append('step/end', { turn: 2, step: 1 })
  const result = await h.windows.turnover(h.agent, 'pressure', new AbortController().signal, archive, async () => {}, undefined, undefined, incoming(), prepared, fault === 'insufficient-relief' ? 1e9 : 0)
  assert.ok(result)
  const ledger = rebuildBlockLedger(h.session.snapshotEvents())
  assert.equal(ledger.length, 1); assert.equal(ledger[0]!.contextManagement!.seed.mode, 'extractive')
  assert.ok(ledger[0]!.contextManagement!.seed.rejected)
})

test('manual handoff is accepted whole within real byte allowance; Unicode overflow is rejected whole with explicit metadata', async t => {
  for (const overflow of [false, true]) {
    const h = await setup(`budget-${overflow}`, good); t.after(h.close)
    newInput(h.session, 'Keep current input')
    const seqs = h.session.surface.nodes.slice(0, -1)
    const layout = seedLayout(h.session, seqs, archive, 1, '0'.repeat(36), true)
    const handoff = '界'.repeat(Math.floor(layout.handoffBytes / 3) + (overflow ? 1 : 0))
    h.windows.accept(h.session, handoff)
    const result = await h.windows.commitPending(h.agent, new AbortController().signal, archive, async () => {})
    assert.ok(result)
    const text = result.summary.map(b => b.type === 'text' ? b.text : '').join('')
    assert.ok(Buffer.byteLength(text) <= archive.seedMaxTokens)
    assert.equal(text.includes(handoff), !overflow)
    assert.equal(rebuildBlockLedger(h.session.snapshotEvents())[0]!.contextManagement?.seed.mode, overflow ? 'extractive' : 'model-assisted')
  }
})

for (const reason of ['late', 'cancelled', 'disposed', 'timeout', 'oversize', 'failed', 'invalid-output'] as const) test(`background ${reason} is bounded and cannot append after fallback`, async t => {
  let release!: () => void, requestSignal: AbortSignal | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const h = await setup(`job-${reason}`, async function* (request) {
    requestSignal = request.signal
    if (reason === 'oversize') { yield { type: 'text-delta', text: '界'.repeat(10000) }; return }
    if (reason === 'failed') throw new Error('provider failure')
    if (reason === 'invalid-output') { yield { type: 'finish', reason: { kind: 'length' } }; return }
    await gate // deliberately ignores AbortSignal
    yield* good()
  }); t.after(h.close)
  h.jobs.prepare(h.agent, { ...config, timeoutMs: reason === 'timeout' ? 10 : 60000 }, archive, 0, new AbortController().signal, incoming())
  if (reason === 'late') h.jobs.take(h.agent)
  else if (reason === 'cancelled' || reason === 'disposed') h.jobs.cancel(h.session, reason)
  else await delay(reason === 'timeout' ? 25 : 1)
  assert.equal((h.jobs.status(h.session) as { status: string }).status, reason)
  h.jobs.cancel(h.session, 'superseded')
  assert.equal((h.jobs.status(h.session) as { status: string }).status, reason, 'later surface replacement cannot erase the terminal failure reason')
  assert.equal(requestSignal?.aborted, true)
  const result = await h.windows.turnover(h.agent, 'pressure', new AbortController().signal, archive, async () => {}, undefined, undefined, incoming(), h.jobs.take(h.agent))
  assert.ok(result); const count = h.session.seq
  release(); await immediate()
  assert.equal(h.session.seq, count); assert.equal(h.jobs.take(h.agent), undefined)
  assert.equal(rebuildBlockLedger(h.session.snapshotEvents()).length, 1)
})

test('same provider skips background work by default; explicit opt-in runs once and cancellation cannot write late', async t => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const h = await setup('job-ownership', async function* () {
    calls++
    await gate // deliberately ignores cancellation to prove completion is inert after cancellation
    yield* good()
  }); t.after(h.close)
  h.jobs.prepare(h.agent, { ...config, provider: 'local' }, archive, 0, new AbortController().signal, incoming())
  assert.equal(calls, 0)
  const abort = new AbortController()
  const sameRoute = { ...config, provider: 'local', model: 'serial', allowSameProvider: true }
  h.jobs.prepare(h.agent, sameRoute, archive, 0, abort.signal, incoming())
  h.jobs.prepare(h.agent, sameRoute, archive, 0, abort.signal, incoming())
  await immediate(); assert.equal(calls, 1, 'one session/generation permits only one same-route request')
  const before = h.session.seq
  abort.abort(); assert.equal(h.jobs.take(h.agent), undefined)
  release(); await immediate()
  assert.equal(h.session.seq, before, 'late completion cannot append to the session')
  assert.equal(h.jobs.take(h.agent), undefined)
})

test('background input cap reaches ready state and lifetime abort discards it', async t => {
  let calls = 0
  const h = await setup('job-input-cap', () => { calls++; return good() }); t.after(h.close)
  const abort = new AbortController()
  h.jobs.prepare(h.agent, { ...config, maxInputBytes: 4096 }, archive, 0, abort.signal, incoming())
  await immediate()
  assert.equal(calls, 1)
  assert.equal((h.jobs.status(h.session) as { status: string }).status, 'ready')
  abort.abort()
  assert.equal(h.jobs.take(h.agent), undefined)
})

test('background configuration defaults same-provider work to false and rejects invalid boolean types', () => {
  assert.equal(resolveBackgroundSummary(), undefined)
  assert.equal(resolveBackgroundSummary({ provider: 'cloud', model: 'm' })?.allowSameProvider, false)
  assert.equal(Config({ backgroundSummary: { provider: 'cloud', model: 'm', allowSameProvider: true } }).backgroundSummary?.allowSameProvider, true)
  const invalid: unknown = { backgroundSummary: { provider: 'cloud', model: 'm', allowSameProvider: 'true' } }
  if (typeof invalid !== 'object' || invalid === null || Array.isArray(invalid)) assert.fail('invalid test fixture must be an object')
  assert.throws(() => Config(invalid), /boolean/)
  assert.throws(() => validateContextConfig({ adaptiveGovernor: { enabled: false }, backgroundSummary: { provider: 'cloud', model: 'm' } }))
  assert.throws(() => validateContextConfig({ adaptiveGovernor: { enabled: true }, backgroundSummary: { provider: 'cloud', model: 'm', prepareAtEffectiveCapacityPct: 0.95 } }))
  assert.throws(() => resolveBackgroundSummary({ provider: 'cloud', model: 'm', maxInputBytes: Infinity }))
})

test('pending model selection invalidates a ready summary; a seed alone never starts another model call', async t => {
  let calls = 0
  const h = await setup('selection-and-seed', () => { calls++; return good() }); t.after(h.close)
  await ready(h)
  const result = await h.windows.turnover(h.agent, 'pressure', new AbortController().signal, archive, async () => {}, undefined, undefined, incoming())
  assert.ok(result)
  h.jobs.prepare(h.agent, config, archive, 1, new AbortController().signal, incoming())
  await immediate(); assert.equal(calls, 1, 'do not pay to summarize just the old seed again')
  const other = await setup('pending-selection', good); t.after(other.close)
  other.jobs.prepare(other.agent, config, archive, 0, new AbortController().signal, incoming())
  await immediate()
  other.session.append('model/selection' as never, { provider: 'changed', model: 'route' } as never)
  assert.equal(other.jobs.take(other.agent), undefined)
  assert.equal((other.jobs.status(other.session) as { status: string }).status, 'stale')
})
