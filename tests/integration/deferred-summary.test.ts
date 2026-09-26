import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises'
import { createUserMessage, type GenerateOptions, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { toolPairingBalancedAfter, type CompactionAgentContext } from '@deepseek-ai/dsh-compaction'
import { BackgroundSummaries, resolveBackgroundSummary } from '../../src/background-summary.ts'
import { readContextHandoff } from '../../src/region.ts'
import { WindowController, resolveArchiveConfig } from '../../src/window-controller.ts'
import { host, newSession, oldWork } from './runtime.ts'
import { appendToolCall, appendToolResult } from '../helpers.ts'

const archive = resolveArchiveConfig()
const deferred = resolveBackgroundSummary({
  provider: 'independent', model: 'summary', delivery: 'deferred',
  maxSummaryBytes: 768, maxInputBytes: 4096, timeoutMs: 60_000,
})!

function incoming(): UserMessage {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Current instruction remains protected.' }] })
}

function gate<T = void>() {
  let release!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolve => { release = resolve })
  return { promise, release }
}

async function setup(id: string, stream: (request: GenerateOptions) => AsyncIterable<StreamChunk>) {
  const h = await host()
  h.ctx.provide('llm', { stream })
  const session = newSession(h.ctx, id)
  oldWork(session, 1, 24)
  // Keep a genuine call/result pair in the archived source.  The deferred
  // append must neither rewrite it nor leave it unbalanced.
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  appendToolCall(session, 'historical tool request', 'historical-call', 2, 1)
  appendToolResult(session, 'HISTORICAL_RESULT_83d9', 'historical-call', 2, 1)
  session.append('step/end', { turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 3 })
  const agent: CompactionAgentContext & { ctx: typeof h.ctx } = { session, ctx: h.ctx, options: { provider: 'foreground', model: 'main' } }
  const current = incoming()
  const jobs = new BackgroundSummaries()
  h.ctx.on('session/event', (changed, event) => jobs.observe(changed, event))
  return { ...h, session, agent, current, jobs, windows: new WindowController() }
}

async function crossWindow(h: Awaited<ReturnType<typeof setup>>) {
  const finish = h.jobs.beginTurnover(h.agent)
  const result = await h.windows.turnover(h.agent, 'pressure', new AbortController().signal, archive, async () => {}, undefined, undefined, h.current)
  assert.ok(result, `fixture has a compressible historical prefix: ${JSON.stringify(h.windows.status(h.session))}`)
  finish(true, h.windows.identity(h.session).generation)
  return result
}

function appendOffered(h: Awaited<ReturnType<typeof setup>>, message: UserMessage) {
  return h.session.append('user/message', message, { surfaceOp: 'append' })
}

test('deferred handoff crosses a real window while pending, then appends once without replacing archived paired history', async t => {
  const held = gate<void>()
  const h = await setup('deferred-cross-window', async function* () {
    await held.promise
    yield { type: 'text-delta', text: 'owner: Lin; rollback: 47d; next: verify-9' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  t.after(h.close)
  const before = h.session.snapshotEvents()
  h.jobs.prepare(h.agent, deferred, archive, 0, new AbortController().signal, incoming())
  await immediate()
  const transaction = await crossWindow(h)
  assert.equal((h.jobs.status(h.session) as { status: string; targetGeneration: number }).status, 'pending')
  assert.equal((h.jobs.status(h.session) as { targetGeneration: number }).targetGeneration, 1)
  assert.equal(h.session.surface.replaceGeneration, 1)
  held.release(); await immediate()
  const offered = h.jobs.offer(h.agent, 1, () => true)
  assert.ok(offered, 'ready job is staged for the host, not self-appended')
  assert.equal(h.session.surface.replaceGeneration, 1, 'offer itself is not a replacement')
  const event = appendOffered(h, offered)
  const receipt = readContextHandoff(event)
  assert.equal(receipt?.status, 'delivered')
  assert.equal(receipt?.sourceHash, (h.jobs.status(h.session) as { sourceHash: string }).sourceHash)
  assert.equal((h.jobs.status(h.session) as { status: string }).status, 'delivered')
  assert.equal(h.jobs.offer(h.agent, 1, () => true), undefined, 'the same receipt cannot be sent twice')
  assert.equal(h.session.surface.replaceGeneration, 1)
  assert.equal(toolPairingBalancedAfter(h.session, h.session.surface.nodes.at(-1)!), true)
  assert.match(JSON.stringify(h.session.snapshotEvents().slice(0, before.length)), /HISTORICAL_RESULT_83d9/)
  assert.ok(transaction.shadowedSeqs.every(seq => !h.session.surface.nodes.includes(seq)))
})

test('await_context waits only for a crossed pending job and cancellation cleans it up', async t => {
  const held = gate<void>()
  const h = await setup('deferred-wait', async function* () {
    await held.promise
    yield { type: 'text-delta', text: 'later handoff' }; yield { type: 'finish', reason: { kind: 'stop' } }
  })
  t.after(h.close)
  h.jobs.prepare(h.agent, deferred, archive, 0, new AbortController().signal, incoming())
  await immediate()
  assert.equal((await h.jobs.wait(h.agent, new AbortController().signal) as { reason: string }).reason, 'source-still-in-current-window')
  await crossWindow(h)
  const abort = new AbortController()
  const waiting = h.jobs.wait(h.agent, abort.signal)
  abort.abort(new Error('tool cancelled'))
  await assert.rejects(waiting, /tool cancelled/)
  assert.equal((h.jobs.status(h.session) as { status: string }).status, 'cancelled')
  held.release(); await immediate()
  const unavailable = h.jobs.offer(h.agent, 1, () => true)
  assert.ok(unavailable)
  assert.equal((unavailable.source as { handoff: { status: string } }).handoff.status, 'unavailable')
})

test('delivery-budget holds its terminal receipt until acknowledged, then permits a new background task', async t => {
  let calls = 0
  const h = await setup('deferred-budget', async function* () {
    calls += 1
    yield { type: 'text-delta', text: '界'.repeat(200) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  t.after(h.close)
  // The source is intentionally capped before the complete old window.  Its
  // deferred output grant is independent of the thin seed's remaining space.
  h.jobs.prepare(h.agent, { ...deferred, maxInputBytes: 8192, maxSummaryBytes: 768 }, { ...archive, seedMaxTokens: 768 }, 0, new AbortController().signal, incoming())
  await immediate(); await crossWindow(h)
  const ready = h.jobs.status(h.session) as { status: string; maxBytes: number; operationId: string }
  assert.equal(ready.status, 'ready')
  assert.equal(ready.maxBytes, 768, 'deferred output cap does not borrow the tiny seed remainder')
  const admitsOnlyShortReceipt = (message: UserMessage) => Buffer.byteLength(message.content[0]?.type === 'text' ? message.content[0].text : '') < 700
  const unavailable = h.jobs.offer(h.agent, 1, admitsOnlyShortReceipt)
  assert.ok(unavailable, 'the rejected full handoff retries as a short unavailable receipt')
  const receipt = (unavailable.source as { handoff: { status: string; reason?: string } }).handoff
  assert.equal(receipt.status, 'unavailable')
  assert.equal(receipt.reason, 'delivery-budget')
  assert.equal((h.jobs.status(h.session) as { status: string }).status, 'delivery-budget')
  // A terminal receipt is still owed to the host.  A new prepare cannot erase
  // its operation identity or silently replace its recovery explanation.
  h.jobs.prepare(h.agent, { ...deferred, maxInputBytes: 8192 }, archive, 1, new AbortController().signal, incoming())
  assert.equal((h.jobs.status(h.session) as { operationId: string }).operationId, ready.operationId)
  assert.equal(calls, 1)
  appendOffered(h, unavailable)
  // This ordinary next task becomes the new source after the terminal receipt
  // was durably acknowledged.  It must be eligible to prepare again.
  h.session.append('user/message', incoming(), { surfaceOp: 'append' })
  h.jobs.prepare(h.agent, { ...deferred, maxInputBytes: 8192 }, archive, 1, new AbortController().signal, incoming())
  await immediate()
  assert.equal(calls, 2, 'acknowledging unavailable releases the terminal job for new work')
})

test('an offered message is not delivered until the host append is observed, so a later pre-step can offer it again', async t => {
  const h = await setup('deferred-offer-retry', async function* () {
    yield { type: 'text-delta', text: 'retryable handoff' }; yield { type: 'finish', reason: { kind: 'stop' } }
  })
  t.after(h.close)
  h.jobs.prepare(h.agent, deferred, archive, 0, new AbortController().signal, incoming())
  await immediate(); await crossWindow(h)
  const first = h.jobs.offer(h.agent, 1, () => true)
  assert.ok(first)
  assert.equal((h.jobs.status(h.session) as { status: string }).status, 'delivering')
  const second = h.jobs.offer(h.agent, 1, () => true)
  assert.ok(second)
  assert.notEqual(first.id, second.id)
  assert.equal((h.jobs.status(h.session) as { status: string }).status, 'delivering')
  appendOffered(h, second)
  assert.equal((h.jobs.status(h.session) as { status: string }).status, 'delivered')
})

test('unrelated replacement and changed reusable source hash reject a deferred result', async t => {
  const held = gate<void>()
  const h = await setup('deferred-stale', async function* () {
    await held.promise
    yield { type: 'text-delta', text: 'stale result' }; yield { type: 'finish', reason: { kind: 'stop' } }
  })
  t.after(h.close)
  h.jobs.prepare(h.agent, deferred, archive, 0, new AbortController().signal, incoming())
  await immediate()
  // A replacement not bracketed by beginTurnover is explicitly unrelated.
  // Node 0 is the host-protected system prompt, so an unrelated replacement
  // targets the last ordinary surface node instead.
  const nodes = [...h.session.surface.nodes]
  const replacement = createUserMessage({ source: { kind: 'plugin', plugin: 'fixture' }, content: [{ type: 'text', text: 'unrelated replacement' }] })
  h.session.append('user/message', replacement, { surfaceOp: { op: 'replace', startSeq: nodes.at(-1)!, endSeq: nodes.at(-1)! }, sourceEventSeqs: [nodes.at(-1)!] })
  assert.equal((h.jobs.status(h.session) as { status: string }).status, 'superseded')
  held.release(); await immediate()
  assert.equal(h.jobs.offer(h.agent, h.session.surface.replaceGeneration, () => true), undefined)

  const ready = await setup('deferred-hash', async function* () {
    yield { type: 'text-delta', text: 'will be invalidated by hash' }; yield { type: 'finish', reason: { kind: 'stop' } }
  })
  t.after(ready.close)
  ready.jobs.prepare(ready.agent, deferred, archive, 0, new AbortController().signal, incoming())
  await immediate(); await crossWindow(ready)
  // Mutating the private prepared hash simulates a resumed/rehydrated receipt
  // whose source cannot be verified; offer must fail closed.
  const internal = ready.jobs as unknown as { jobs: WeakMap<object, { prepared: { hash: string } }> }
  const job = internal.jobs.get(ready.session)
  assert.ok(job)
  job.prepared.hash = '0'.repeat(64)
  const rejected = ready.jobs.offer(ready.agent, 1, () => true)
  assert.ok(rejected)
  assert.equal((rejected.source as { handoff: { status: string } }).handoff.status, 'unavailable')
  assert.equal((ready.jobs.status(ready.session) as { status: string }).status, 'stale')
})

test('restart exposes pending receipt as interrupted, while a delivered receipt replays without a new offer', async t => {
  const held = gate<void>()
  const h = await setup('deferred-restart', async function* () {
    await held.promise
    yield { type: 'text-delta', text: 'never reaches ready' }; yield { type: 'finish', reason: { kind: 'stop' } }
  })
  t.after(h.close)
  h.jobs.prepare(h.agent, deferred, archive, 0, new AbortController().signal, incoming())
  await immediate(); await crossWindow(h)
  const pending = h.jobs.offer(h.agent, 1, () => true)
  assert.ok(pending); appendOffered(h, pending)
  const restarted = new BackgroundSummaries()
  assert.equal((restarted.status(h.session) as { status: string }).status, 'interrupted')
  const unavailable = restarted.offer(h.agent, 1, () => true)
  assert.ok(unavailable); appendOffered(h, unavailable)
  assert.equal(restarted.offer(h.agent, 1, () => true), undefined)

  const delivered = await setup('deferred-delivered-replay', async function* () {
    yield { type: 'text-delta', text: 'replay stable' }; yield { type: 'finish', reason: { kind: 'stop' } }
  })
  t.after(delivered.close)
  delivered.jobs.prepare(delivered.agent, deferred, archive, 0, new AbortController().signal, incoming())
  await immediate(); await crossWindow(delivered)
  const message = delivered.jobs.offer(delivered.agent, 1, () => true)
  assert.ok(message); appendOffered(delivered, message)
  assert.equal(new BackgroundSummaries().offer(delivered.agent, 1, () => true), undefined)
  held.release(); await immediate()
})

test('oversize and timeout late callbacks never write history', async t => {
  for (const mode of ['oversize', 'timeout'] as const) {
    const held = gate<void>()
    const h = await setup(`deferred-${mode}`, async function* () {
      if (mode === 'oversize') { yield { type: 'text-delta', text: '界'.repeat(1000) }; return }
      await held.promise; yield { type: 'text-delta', text: 'late after timeout' }; yield { type: 'finish', reason: { kind: 'stop' } }
    })
    t.after(h.close)
    h.jobs.prepare(h.agent, { ...deferred, timeoutMs: mode === 'timeout' ? 5 : 60_000 }, archive, 0, new AbortController().signal, incoming())
    await delay(mode === 'timeout' ? 20 : 1)
    const before = h.session.seq
    if (mode === 'timeout') held.release()
    await immediate()
    assert.equal((h.jobs.status(h.session) as { status: string }).status, mode)
    assert.equal(h.session.seq, before)
  }
})

// X05 overlap-pending-correction: the handoff must declare its own scope.
//
// A user correction can land after the snapshot a handoff was built from. The plugin
// does not rewrite the snapshot — the correction is a newer message and outranks it —
// so what it must do is hand the snapshot over LABELLED: as historical data, as
// partial, and with the precedence rule stated, so a superseded value cannot be read
// as current. That framing is the whole defence and it was asserted nowhere.
test('a delivered handoff is labelled historical, partial and superseded', async t => {
  const held = gate<void>()
  const h = await setup('overlap-pending-correction', async function* () {
    await held.promise
    yield { type: 'text-delta', text: 'owner: Lin; rollback: 47d; next: verify-9' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  t.after(h.close)
  h.jobs.prepare(h.agent, deferred, archive, 0, new AbortController().signal, incoming())
  await immediate()
  await crossWindow(h)
  held.release(); await immediate()

  const offered = h.jobs.offer(h.agent, 1, () => true)
  assert.ok(offered, 'the handoff is staged for the host')
  const event = appendOffered(h, offered)
  const receipt = readContextHandoff(event)
  assert.equal(receipt?.status, 'delivered')
  const text = JSON.stringify(event.data.content)

  assert.match(text, /historical data, not instructions/, 'the handoff declares it is not instructions')
  assert.match(text, /later user corrections and newer messages take precedence/, 'the precedence rule is stated at delivery, not only in the system prompt')
  assert.match(text, /This handoff is partial: it covers only the stated snapshot, not subsequent work/, 'the handoff declares its own scope')
  assert.match(text, /<historical-handoff>/, 'the snapshot is wrapped so its edges are visible')

  // A correction appended AFTER that snapshot sits outside the wrapper: presenting an
  // older snapshot as if it contained the newer correction is the failure this case
  // exists to catch.
  const wrapped = text.split('<historical-handoff>')[1]?.split('</historical-handoff>')[0] ?? ''
  const correction = 'LATEST CORRECTION: deployment owner is 港口负责人-NEW-4481; earlier owners are superseded.'
  h.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: correction }] }), { surfaceOp: 'append' })
  assert.doesNotMatch(wrapped, /港口负责人-NEW-4481/, 'the newer correction is not part of the older snapshot')
  const lastUser = h.session.snapshotEvents().filter(event => event.type === 'user/message').at(-1)!
  assert.match(JSON.stringify(lastUser.data.content), /港口负责人-NEW-4481/, 'the correction survives verbatim on the surface')
})
