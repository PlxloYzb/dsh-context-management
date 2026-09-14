import test from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ContextManagementEngine } from '../../src/index.ts'
import { WindowController, windowIdentity, resolveArchiveConfig } from '../../src/window-controller.ts'
import { host, newSession, oldWork, newInput } from './runtime.ts'
import { appendUser, appendToolCall, appendToolResult } from '../helpers.ts'

const signal = () => new AbortController().signal
const config = { modelContextLimit: 32768, autoNudge: false, adaptiveGovernor: { windowBudgetTokens: 32768, maxOutputTokens: 8192, safetyMarginTokens: 4096 } }

test('W04: oversized retained tail stops the next request after at most one durable turnover', async t => {
  const h = await host(); t.after(h.close)
  const engine = new ContextManagementEngine(h.ctx, config)
  const session = newSession(h.ctx, 'oversized-tail')
  oldWork(session)
  newInput(session, 'Current user input is protected. '.repeat(4000))
  const agent = { session, ctx: h.ctx, options: {} }
  await assert.rejects(engine.compactIfNeeded(agent, 'pressure', signal()), /context-budget-exhausted/)
  assert.equal(windowIdentity(session).generation, 1)
  const status = engine.windows.status(session) as { lastOperation: { targetReached: boolean; degradation: string } }
  assert.equal(status.lastOperation.targetReached, false)
  assert.equal(status.lastOperation.degradation, 'retained-tail-above-target')
  await assert.rejects(engine.compactIfNeeded(agent, 'pressure', signal()), /context-budget-exhausted/)
  assert.equal(windowIdentity(session).generation, 1, 'no-net-reduction cannot create repeated windows')
})

test('B05: real token meter reprices a switched route before a smaller model can be called', async t => {
  const h = await host(); t.after(h.close)
  new ContextManagementEngine(h.ctx, { ...config, modelContextLimit: undefined })
  h.ctx.provide('llm', { imageRequestPricing: () => undefined, resolveModelInfo: async () => ({ context: { contextWindow: 16000 } }) } as never)
  const session = newSession(h.ctx, 'route-switch')
  oldWork(session)
  newInput(session, 'Keep all current constraints')
  session.append('request/header', { header: { config: { provider: 'old', model: 'large', maxTokens: 8192 } } })
  const agent = { session, ctx: h.ctx, options: { provider: 'old', model: 'large' } } as unknown as Agent
  await assert.rejects(h.ctx.waterfall('agent/request', { agent, turn: 2, step: 1, signal: signal() }, async () => ({ provider: 'new', model: 'small', maxTokens: 8192 })), /selected model route/)
  assert.equal(windowIdentity(session).generation, 0, 'late route check cannot mutate an already assembled request')
})

test('L02: prepare failure closure is flushed and combined persistence errors remain visible', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'prepare-flush')
  oldWork(session); newInput(session, 'Keep current')
  const windows = new WindowController()
  let flushed = false
  await assert.rejects(windows.exclusive(session, async () => {
    session.append('step/start', { turn: 2, step: 1 })
    throw new Error('prepare-failed')
  }, async () => { flushed = true; throw new Error('flush-failed') }), (error: unknown) => error instanceof AggregateError && error.errors.some(e => String(e).includes('prepare-failed')) && error.errors.some(e => String(e).includes('flush-failed')))
  assert.equal(flushed, true)
  assert.throws(() => windows.assertReady(session), /recovery-required/)
})

test('W04: pruner relief skips turnover but still flushes its durable replacement', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'pruner-relief')
  oldWork(session); newInput(session, 'Latest')
  let flushed = 0
  const windows = new WindowController()
  const result = await windows.turnover({ session, ctx: h.ctx, options: {} }, 'pressure', signal(), resolveArchiveConfig(), async () => { flushed++; await h.ctx.sessions.flush(session) }, undefined, () => {
    // The caller owns pruning; a changed durable revision must still flush on relief.
    session.append('step/start', { turn: 2, step: 1 })
    return false
  })
  assert.equal(result, null)
  assert.equal(windowIdentity(session).generation, 0)
  assert.equal(flushed, 1)
})

test('lifetime disposal aborts a new maintenance operation before appending', async t => {
  const h = await host()
  const engine = new ContextManagementEngine(h.ctx, config)
  const session = newSession(h.ctx, 'disposed-engine')
  oldWork(session); newInput(session, 'Latest')
  await h.close()
  const before = session.seq
  await assert.rejects(engine.compactIfNeeded({ session, options: {}, ctx: h.ctx } as never, 'context-overflow', signal()), /disposed/)
  assert.equal(session.seq, before)
})

test('W04b: bounded overshoot between the effective line and the physical limit no longer kills the turn (400k-experiment regression)', async t => {
  const h = await host(); t.after(h.close)
  // Geometry: C=W=32768, R=8192, S=4096 → effective line 20480, physical limit 24576.
  const engine = new ContextManagementEngine(h.ctx, config)
  const session = newSession(h.ctx, 'bounded-overshoot')
  const agent = { session, ctx: h.ctx, options: {} }
  // No compressible history at all: turnover has no safe range, the local
  // fallback has no range, and the entire pressure is protected input — the
  // exact shape of the experiment's CONTEXT_BUDGET_EXHAUSTED deaths, where the
  // retained tail was only ~0.3% over the effective line and far below physical.
  newInput(session, 'Protected current user input. '.repeat(2750)) // ~21.3k heuristic tokens: over emergency 18432 and effective 20480, under physical 24576
  const before = session.surface.replaceGeneration
  assert.equal(await engine.compactIfNeeded(agent, 'pressure', signal()), null, 'no reduction mechanism can act')
  assert.equal(session.surface.replaceGeneration, before)
  const status = engine.windows.status(session) as { lastOperation: { degradation: string; inputBudget: number; physicalInputLimit: number } }
  assert.equal(status.lastOperation.degradation, 'overshoot-within-physical-limit')
  assert.equal(status.lastOperation.inputBudget, 20480)
  assert.equal(status.lastOperation.physicalInputLimit, 24576)
  // Beyond the physical limit the turn still fails closed.
  newInput(session, 'Unfitting protected input. '.repeat(5000))
  await assert.rejects(engine.compactIfNeeded(agent, 'pressure', signal()), /physical input limit/)
})

test('W04c: a post-window state with no new history degrades without repeating windows or crashing', async t => {
  const h = await host(); t.after(h.close)
  const engine = new ContextManagementEngine(h.ctx, config)
  const session = newSession(h.ctx, 'no-new-history-degrade'), windows = new WindowController()
  oldWork(session)
  newInput(session, 'Current instruction stays. ')
  const agent = { session, ctx: h.ctx, options: {} }
  const pending = windows.accept(session, 'seed handoff', 'call-degrade')
  assert.ok(pending)
  session.append('step/start', { turn: 2, step: 1 })
  appendToolCall(session, 'seed handoff', 'call-degrade', 2, 1)
  appendToolResult(session, JSON.stringify(pending), 'call-degrade', 2, 1)
  session.append('step/end', { turn: 2, step: 1 })
  const committed = await windows.commitPending(agent, signal(), resolveArchiveConfig(), async () => {})
  assert.ok(committed, 'window 1 commits')
  assert.equal(windowIdentity(session).generation, 1)
  // No new history after the seed: a further turnover no-ops; the degraded
  // path must also return null (nothing foldable) instead of throwing when
  // pressure is within the physical limit, and must not mint window 2.
  const result = await engine.compactIfNeeded(agent, 'pressure', signal())
  assert.equal(result, null)
  assert.equal(windowIdentity(session).generation, 1, 'no-new-history cannot create repeated windows')
})

test('W04d: idle maintenance never selects the protected current user input (150k adaptive regression)', async t => {
  const h = await host(); t.after(h.close)
  const engine = new ContextManagementEngine(h.ctx, config)
  const session = newSession(h.ctx, 'maintenance-protected')
  session.append('turn/start', { turn: 1 })
  appendUser(session, 'Phase instruction that must stay visible. ')
  for (let i = 0; i < 5; i++) {
    session.append('step/start', { turn: 1, step: i + 1 })
    appendToolCall(session, `op ${i}`, `m-call-${i}`, 1, i + 1)
    appendToolResult(session, `maintenance historical payload ${i}. `.repeat(300), `m-call-${i}`, 1, i + 1)
    session.append('step/end', { turn: 1, step: i + 1 })
  }
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const runMaintenance = async fn => fn(new AbortController().signal)
  const agent = { session, ctx: h.ctx, options: {}, runMaintenance }
  const result = await engine.compactNow(agent, signal())
  const lastUser = [...session.snapshotEvents()].filter(e => e.type === 'user/message' && e.data.source.kind === 'user').at(-1)
  if (result) {
    assert.ok(!result.shadowedSeqs.includes(lastUser!.seq), 'maintenance checkpoint must never archive the latest user input')
  } else {
    assert.equal(result, null, 'graceful degradation reports nothing-safe instead of throwing')
  }
})
