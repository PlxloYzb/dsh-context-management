import test from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ContextManagementEngine } from '../../src/index.ts'
import { WindowController, windowIdentity, resolveArchiveConfig } from '../../src/window-controller.ts'
import { host, newSession, oldWork, newInput } from './runtime.ts'

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
