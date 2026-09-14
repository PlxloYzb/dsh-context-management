import test from 'node:test'
import assert from 'node:assert/strict'
import { ContextManagementEngine } from '../../src/index.ts'
import { host, newSession } from './runtime.ts'
import { appendUser, appendAssistant } from '../helpers.ts'

// Controlled installed-host services, not provider generations or live quality samples.
for (const target of [399999, 400000, 400001]) {
  test(`R01: actual host meter at ${target} tokens drives the frozen 400k intervention boundary`, async t => {
    const h = await host(); t.after(h.close)
    const engine = new ContextManagementEngine(h.ctx, { modelContextLimit: 1000000, autoNudge: false,
      adaptiveGovernor: { windowBudgetTokens: 481309, maxOutputTokens: 32768, safetyMarginTokens: 4096,
        nudgeAtEffectiveCapacityPct: 0.75, emergencyAtEffectiveCapacityPct: 0.9 } })
    const session = newSession(h.ctx, `experiment-boundary-${target}`)
    session.append('turn/start', { turn: 1 }); appendUser(session, 'OLD')
    session.append('step/start', { turn: 1, step: 1 })
    appendAssistant(session, 'x'.repeat((target - 26) * 4))
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 }); appendUser(session, 'NOW')
    assert.equal(h.ctx.tokenMeter.measure(session).totalTokens, target)
    const before = [...session.snapshotEvents()], currentUserSeq = session.surface.nodes.at(-1)!
    const result = await engine.compactIfNeeded({ session, ctx: h.ctx, options: {} }, 'pressure', new AbortController().signal)
    assert.deepEqual(session.snapshotEvents().slice(0, before.length), before, 'original prefix is append-only')
    assert.ok(session.surface.nodes.includes(currentUserSeq), 'current user input remains visible')
    const summaries = session.snapshotEvents().filter(event => event.type === 'compaction/summary')
    if (target < 400000) {
      assert.equal(result, null); assert.equal(summaries.length, 0)
    } else {
      assert.ok(result); assert.equal(summaries.length, 1)
      const replacement = session.eventAt((summaries[0]!.seq + 1) as typeof summaries[0]['seq'])!
      assert.equal(replacement.type, 'user/message')
      assert.equal(typeof replacement.surfaceOp === 'object' ? replacement.surfaceOp.op : null, 'replace')
      assert.ok(h.ctx.tokenMeter.measure(session).totalTokens < target, 'committed window has a real measured reduction')
    }
  })
}
