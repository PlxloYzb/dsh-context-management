import test from 'node:test'
import assert from 'node:assert/strict'
import type { Session } from '@deepseek-ai/dsh-session'
import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { ContextManagementEngine } from '../../src/index.ts'
import { rebuildBlockLedger, readCompactionSummary, type WindowMetadata } from '../../src/region.ts'
import { host, newSession, newInput, oldWork } from './runtime.ts'
import { appendToolCall, appendToolResult } from '../helpers.ts'

const config = {
  modelContextLimit: 32768, autoNudge: false,
  adaptiveGovernor: { windowBudgetTokens: 32768, maxOutputTokens: 8192, safetyMarginTokens: 4096 },
}
const emergencyTokens = 18432

for (const scenario of ['relief', 'still-pressure', 'overflow'] as const) {
  test(`window governor preserves the post-pruner pressure decision: ${scenario}`, async t => {
    const h = await host(); t.after(h.close)
    const session = newSession(h.ctx, `governor-pruner-${scenario}`)
    oldWork(session, 1, scenario === 'still-pressure' ? 40 : 24)
    newInput(session, 'Keep the current request protected.')
    const currentUser = session.surface.nodes.at(-1)!
    session.append('step/start', { turn: 2, step: 1 })
    appendToolCall(session, 'Get current payload', 'current', 2, 1)
    appendToolResult(session, 'current payload '.repeat(4000), 'current', 2, 1)
    session.append('step/end', { turn: 2, step: 1 })
    const source = session.snapshotEvents().findLast(event => event.type === 'tool/result')
    assert.ok(source?.type === 'tool/result')
    const engine = new ContextManagementEngine(h.ctx, config), agent = { session, ctx: h.ctx, options: {} }
    let pruneCalls = 0, postPruneTokens = 0
    // The installed pruner is not a declared development dependency. This
    // fixture implements its public service and adjacent heuristic-price /
    // replacement event contract against the real host session and meter.
    h.ctx.provide('toolResultPruner', {
      pruneSession(target: Session) {
        pruneCalls++
        if (pruneCalls !== 1) return
        const pricedSource = h.ctx.tokenMeter.measure(target).nodes.find(node => node.seq === source.seq)
        assert.ok(pricedSource)
        target.append('compaction/prune', {
          shadowedRange: { start: source.seq, end: source.seq }, shadowedSeqs: [source.seq],
          shadowedTokenCount: pricedSource.heuristicTokens,
        })
        target.append('tool/result', {
          ...source.data, message: { ...source.data.message, content: [{
            type: 'tool-result', toolCallId: 'current', content: [{ type: 'text', text: 'Current payload pruned; original remains available.' }],
          }] },
        }, { surfaceOp: { op: 'replace', start: source.seq, end: source.seq }, sourceEventSeqs: [source.seq] })
        postPruneTokens = h.ctx.tokenMeter.measure(target).totalTokens
      },
    })
    assert.ok(h.ctx.tokenMeter.measure(session).totalTokens > emergencyTokens)
    const revision = session.seq
    const result = await engine.compactIfNeeded(agent, scenario === 'overflow' ? 'context-overflow' : 'pressure', new AbortController().signal)
    assert.equal(pruneCalls, 1, 'a completed pruner pass must not be repeated after relief')
    const appended = session.snapshotEvents().slice(revision)
    if (scenario === 'relief') {
      assert.ok(postPruneTokens < emergencyTokens)
      assert.equal(result, null)
      assert.deepEqual(appended.map(event => event.type), ['compaction/prune', 'tool/result'])
      assert.equal(rebuildBlockLedger(session.snapshotEvents()).length, 0, 'relief must not create an in-place archive or a window')
      const status = engine.windows.status(session) as { generation: number; lastOperation: { code: string; pressureAfter: number } }
      assert.equal(status.generation, 0)
      assert.equal(status.lastOperation.code, 'pruner-relieved-pressure')
      assert.equal(status.lastOperation.pressureAfter, postPruneTokens)
    } else {
      assert.ok(scenario === 'overflow' ? postPruneTokens < emergencyTokens : postPruneTokens > emergencyTokens)
      assert.ok(result)
      const summary = appended.find(event => event.type === 'compaction/summary')
      assert.ok(summary)
      const metadata: WindowMetadata | undefined = readCompactionSummary(summary).contextManagement
      assert.equal(metadata?.generationAfter, 1)
      assert.equal(metadata?.trigger, scenario === 'overflow' ? 'context-overflow' : 'pressure')
    }
    assert.ok(session.surface.nodes.includes(currentUser))
    assert.equal(toolPairingBalancedAfter(session, session.surface.nodes.at(-1)!), true)
    // Both the early return and the successful window must already have
    // flushed their replacement, without relying on a follow-up request.
    assert.deepEqual((await h.ctx.sessionPersistence.inspect(session.id)).events, session.snapshotEvents())
  })
}

test('pressure without a safe window prefix retains the in-place emergency fallback', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'pruner-relief-no-safe-window')
  oldWork(session, 1, 40)
  const currentUser = session.surface.nodes[0]!
  const engine = new ContextManagementEngine(h.ctx, config), agent = { session, ctx: h.ctx, options: {} }
  assert.ok(h.ctx.tokenMeter.measure(session).totalTokens > emergencyTokens)
  const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
  assert.ok(result, 'current pressure still requires a useful reduction')
  const status = engine.windows.status(session) as { generation: number; lastOperation: { code: string } }
  assert.equal(status.generation, 0)
  assert.equal(status.lastOperation.code, 'no-safe-range')
  const blocks = rebuildBlockLedger(session.snapshotEvents())
  assert.ok(blocks.length > 0)
  assert.ok(blocks.every(block => block.contextManagement === undefined))
  assert.ok(session.surface.nodes.includes(currentUser))
  assert.deepEqual((await h.ctx.sessionPersistence.inspect(session.id)).events, session.snapshotEvents())
})
