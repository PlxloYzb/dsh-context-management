import { testContext } from './host-helpers.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { ArcCompactionEngine } from '../src/index.ts'
import { appendUser, buildTextSession } from './helpers.ts'

function closeTurn(session: import('@deepseek-ai/dsh-session').Session, turn = 1): void {
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

test('seam: compactRegion performs a standard local reversible replacement', async () => {
  const engine = new ArcCompactionEngine(testContext())
  const session = buildTextSession(10)
  const before = [...session.surface.nodes]
  const result = await engine.compactRegion(
    before[0]!,
    before[5]!,
    { session, options: { provider: 'test', model: 'test' } },
    new AbortController().signal,
  )

  assert.deepEqual(result.shadowedSeqs, before.slice(0, 6))
  assert.equal(result.summary[0]?.type, 'text')
  assert.match(result.summary[0]?.type === 'text' ? result.summary[0].text : '', /ARC LOCAL REVERSIBLE/)
  assert.deepEqual(
    session.snapshotEvents().slice(-4).map(event => event.type),
    ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'],
  )
})

test('seam: compactNow owns idle admission, command correlation, and a null-turn durable bracket', async () => {
  const engine = new ArcCompactionEngine(testContext())
  const session = buildTextSession(12)
  closeTurn(session)
  const commandId = CommandId('cmd-arc-manual-1')
  let maintenanceCalls = 0
  const result = await engine.compactNow({
    session,
    options: { provider: 'test', model: 'test' },
    runMaintenance: async task => {
      maintenanceCalls += 1
      return await task(new AbortController().signal)
    },
  }, new AbortController().signal, commandId)

  assert.ok(result !== null)
  assert.equal(maintenanceCalls, 1)
  assert.equal(result.sourceCommandId, commandId)
  const lifecycle = session.snapshotEvents().filter(event => event.type === 'compaction/start' || event.type === 'compaction/end')
  assert.deepEqual(lifecycle.map(event => event.data.turn), [null, null])
  assert.deepEqual(lifecycle.map(event => event.data.sourceCommandId), [commandId, commandId])
  const checkpoint = session.snapshotEvents().find(event => event.seq === result.summarySeq + 1)
  assert.equal(checkpoint?.type, 'user/message')
  assert.equal(checkpoint?.type === 'user/message' ? checkpoint.data.source.sourceCommandId : undefined, commandId)
  assert.deepEqual(checkpoint?.sourceEventSeqs?.slice(0, 2), [result.startSeq, result.summarySeq])
})

test('seam: compactNow returns null without writing when no useful history exists', async () => {
  const engine = new ArcCompactionEngine(testContext())
  const session = buildTextSession(0)
  appendUser(session, 'short current request')
  closeTurn(session)
  const before = session.snapshotEvents().length
  const result = await engine.compactNow({
    session,
    options: {},
    runMaintenance: task => task(new AbortController().signal),
  }, new AbortController().signal)
  assert.equal(result, null)
  assert.equal(session.snapshotEvents().length, before)
})

test('seam: compactNow maps synchronous maintenance refusal to busy', () => {
  const engine = new ArcCompactionEngine(testContext())
  const session = buildTextSession(4)
  closeTurn(session)
  assert.throws(() => engine.compactNow({
    session,
    options: {},
    runMaintenance: () => { throw new Error('agent is running') },
  }, new AbortController().signal), (error: unknown) => {
    return error instanceof ManualCompactionError && error.code === 'busy'
  })
})

test('seam: compactNow reports persistence failure after closing the committed bracket', async () => {
  const ctx = testContext(async () => { throw new Error('synthetic flush failure') })
  const engine = new ArcCompactionEngine(ctx)
  const session = buildTextSession(12)
  closeTurn(session)
  await assert.rejects(engine.compactNow({
    session,
    options: {},
    runMaintenance: task => task(new AbortController().signal),
  }, new AbortController().signal), (error: unknown) => {
    return error instanceof ManualCompactionError && error.code === 'persistence'
  })
  assert.equal(session.snapshotEvents().some(event => event.type === 'compaction/summary'), true)
  assert.equal(session.snapshotEvents().at(-1)?.type, 'compaction/end')
})

test('seam: compactRegion rejects idle invocation and preserves the surface', async () => {
  const engine = new ArcCompactionEngine(testContext())
  const session = buildTextSession(8)
  closeTurn(session)
  const before = [...session.surface.nodes]
  await assert.rejects(
    engine.compactRegion(before[0]!, before[3]!, { session, options: {} }),
    /requires an open turn/,
  )
  assert.deepEqual(session.surface.nodes, before)
})

test('seam: compactRegion observes a pre-aborted signal before any durable write', async () => {
  const engine = new ArcCompactionEngine(testContext())
  const session = buildTextSession(8)
  const beforeEvents = session.snapshotEvents().length
  const beforeSurface = [...session.surface.nodes]
  const controller = new AbortController()
  const reason = new Error('caller cancelled')
  controller.abort(reason)
  await assert.rejects(
    engine.compactRegion(
      beforeSurface[0]!,
      beforeSurface[3]!,
      { session, options: {} },
      controller.signal,
    ),
    reason,
  )
  assert.equal(session.snapshotEvents().length, beforeEvents)
  assert.deepEqual(session.surface.nodes, beforeSurface)
})
