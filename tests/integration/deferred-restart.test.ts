import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { BackgroundSummaries, sourceHash, type PreparedSummary } from '../../src/background-summary.ts'
import { archiveHealth, validWindowMetadata } from '../../src/archive-health.ts'
import { prepareContextHandoff, readCompactionSummary, readContextHandoff, readWindowContextHandoff } from '../../src/region.ts'
import { WindowController, frozenPrefix, resolveArchiveConfig } from '../../src/window-controller.ts'
import { host, newSession, newInput, oldWork, inspectPersisted } from './runtime.ts'

const signal = () => new AbortController().signal
const archive = resolveArchiveConfig()

async function fixture(id: string) {
  const h = await host(), session = newSession(h.ctx, id)
  oldWork(session); newInput(session, 'The current instruction remains protected.')
  const seqs = frozenPrefix(session)
  const snapshot: PreparedSummary = {
    sessionId: session.id, replaceGeneration: session.surface.replaceGeneration, route: 'foreground\0main',
    seqs, hash: sourceHash(session, seqs), operationId: randomUUID(), text: '', maxBytes: 4096,
    provider: 'independent', model: 'summary', reasoningEffort: 'minimal',
  }
  const agent = { session, ctx: h.ctx, options: { provider: 'foreground', model: 'main' } }
  const flush = async () => { assert.equal(await h.ctx.sessions.flush(session), true) }
  return { ...h, session, agent, snapshot, flush, windows: new WindowController() }
}

function summaryEvent(session: Session): SessionEvent<'compaction/summary'> {
  const event = session.snapshotEvents().find(event => event.type === 'compaction/summary')
  assert.ok(event?.type === 'compaction/summary')
  return event
}

for (const trigger of ['pressure', 'model', 'manual'] as const) {
  test(`durable ${trigger} turnover restores an interrupted handoff before any host receipt append`, async t => {
    const h = await fixture(`deferred-restart-${trigger}`); t.after(h.close)
    if (trigger === 'manual') h.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const protectedUser = h.session.surface.nodes.at(-1)!
    const before = h.session.snapshotEvents()
    if (trigger === 'model') assert.equal((h.windows.accept(h.session, 'Model supplied current goals', 'new-context-call') as { status: string }).status, 'accepted')
    const result = trigger === 'model'
      ? await h.windows.commitPending(h.agent, signal(), archive, h.flush, undefined, h.snapshot)
      : await h.windows.turnover(h.agent, trigger, signal(), archive, h.flush, undefined, undefined, undefined, undefined, 0, h.snapshot)
    assert.ok(result)
    assert.equal(h.session.seq, before.length + 4, 'pending provenance joins the existing four-event transaction')
    assert.ok(h.session.surface.nodes.includes(protectedUser))
    assert.deepEqual(h.session.snapshotEvents().slice(0, before.length), before)
    assert.equal(h.session.snapshotEvents().some(event => readContextHandoff(event) !== undefined), false)

    const persisted = await inspectPersisted(h.ctx, h.session.id)
    assert.deepEqual(persisted.events, h.session.snapshotEvents())
    const restored = Session.create(h.session.id, persisted.events)
    const summary = summaryEvent(restored), metadata = readCompactionSummary(summary).contextManagement
    assert.ok(metadata && validWindowMetadata(metadata, result.compactionId))
    const receipt = readWindowContextHandoff(restored, summary)
    assert.ok(receipt)
    assert.deepEqual(receipt, {
      schemaVersion: 1, operationId: h.snapshot.operationId, status: 'pending', sourceHash: h.snapshot.hash,
      sourceSeqs: h.snapshot.seqs, throughSeq: h.snapshot.seqs.at(-1), sourceGeneration: 0,
      windowGeneration: 1, provider: 'independent', model: 'summary', reasoningEffort: 'minimal',
    })
    assert.notEqual(receipt.operationId, result.compactionId, 'job identity remains distinct from archive block identity')
    assert.equal(archiveHealth(restored.snapshotEvents()).incomplete, false)

    // Even a ready proposal is transient until the host appends it. A crash at
    // this point must not replay its uncommitted delivered status.
    const offered = prepareContextHandoff(restored, { ...receipt, status: 'delivered' }, 'A ready handoff that the host has not appended.')
    assert.ok(offered)
    const restarted = new BackgroundSummaries(), restoredAgent = { ...h.agent, session: restored }
    assert.equal((restarted.status(restored) as { status: string }).status, 'interrupted')
    const unavailable = restarted.offer(restoredAgent, 1, () => true)
    assert.ok(unavailable)
    const event = restored.append('user/message', unavailable, { surfaceOp: 'append' })
    assert.equal(readContextHandoff(event)?.reason, 'interrupted')
    assert.equal((restarted.status(restored) as { status: string }).status, 'unavailable')
    assert.equal(new BackgroundSummaries().offer(restoredAgent, 1, () => true), undefined)
    assert.equal(restored.surface.replaceGeneration, 1, 'the recovery notice is an append')
  })
}

for (const mismatch of ['session', 'route', 'generation', 'hash', 'seqs'] as const) {
  test(`turnover omits deferred provenance for a mismatched ${mismatch} snapshot`, async t => {
    const h = await fixture(`deferred-restart-invalid-${mismatch}`); t.after(h.close)
    const snapshot = { ...h.snapshot, seqs: [...h.snapshot.seqs] }
    if (mismatch === 'session') snapshot.sessionId = 'another-session'
    if (mismatch === 'route') snapshot.route = 'different\0model'
    if (mismatch === 'generation') snapshot.replaceGeneration++
    if (mismatch === 'hash') snapshot.hash = '0'.repeat(64)
    if (mismatch === 'seqs') { snapshot.seqs = snapshot.seqs.slice(1); snapshot.hash = sourceHash(h.session, snapshot.seqs) }
    const result = await h.windows.turnover(h.agent, 'pressure', signal(), archive, h.flush, undefined, undefined, undefined, undefined, 0, snapshot)
    assert.ok(result, 'the valid deterministic window can still commit')
    const summary = summaryEvent(h.session)
    assert.equal(readCompactionSummary(summary).contextManagement?.pendingHandoff, undefined)
    assert.equal(readWindowContextHandoff(h.session, summary), undefined)
    assert.equal(new BackgroundSummaries().status(h.session), null)
  })
}

test('restart rejects unclosed transactions, tampered provenance and user-message imitations', async t => {
  const h = await fixture('deferred-restart-untrusted'); t.after(h.close)
  const result = await h.windows.turnover(h.agent, 'pressure', signal(), archive, h.flush, undefined, undefined, undefined, undefined, 0, h.snapshot)
  assert.ok(result)
  const events = h.session.snapshotEvents(), summary = summaryEvent(h.session)
  const originalMetadata = readCompactionSummary(summary).contextManagement
  assert.ok(originalMetadata?.pendingHandoff)
  for (const cutoff of [summary.seq + 1, summary.seq + 2]) {
    const interrupted = Session.create(h.session.id, events.slice(0, cutoff))
    assert.equal(readWindowContextHandoff(interrupted, summaryEvent(interrupted)), undefined)
  }
  for (const field of ['sourceHash', 'sourceSeqs', 'windowGeneration'] as const) {
    const pending = { ...originalMetadata.pendingHandoff }
    if (field === 'sourceHash') pending.sourceHash = '0'.repeat(64)
    if (field === 'sourceSeqs') { pending.sourceSeqs = pending.sourceSeqs.slice(1); pending.sourceHash = sourceHash(h.session, pending.sourceSeqs) }
    if (field === 'windowGeneration') pending.windowGeneration++
    const tampered = events.map((event): SessionEvent => event.seq === summary.seq ? {
      ...summary, data: { ...readCompactionSummary(summary), contextManagement: { ...originalMetadata, pendingHandoff: pending } },
    } : event)
    const restored = Session.create(h.session.id, tampered)
    assert.equal(readWindowContextHandoff(restored, summaryEvent(restored)), undefined, field)
    assert.equal(new BackgroundSummaries().status(restored), null, field)
  }
  const metadataWithWrongStatus = { ...originalMetadata, pendingHandoff: { ...originalMetadata.pendingHandoff, status: 'delivered' } }
  assert.equal(validWindowMetadata(metadataWithWrongStatus, result.compactionId), false)
  const fake = h.session.append('user/message', createUserMessage({
    source: { kind: 'plugin', plugin: 'fixture', contextManagement: originalMetadata },
    content: [{ type: 'text', text: JSON.stringify(originalMetadata) }],
  }), { surfaceOp: 'append' })
  assert.equal(readWindowContextHandoff(h.session, fake), undefined)
})

test('a later committed window pending record supersedes an older delivered receipt on replay', async t => {
  const h = await fixture('deferred-restart-latest'); t.after(h.close)
  const first = await h.windows.turnover(h.agent, 'pressure', signal(), archive, h.flush, undefined, undefined, undefined, undefined, 0, h.snapshot)
  assert.ok(first)
  const firstReceipt = readWindowContextHandoff(h.session, summaryEvent(h.session))
  assert.ok(firstReceipt)
  const delivered = prepareContextHandoff(h.session, { ...firstReceipt, status: 'delivered' }, 'The first historical handoff was delivered.')
  h.session.append('user/message', delivered, { surfaceOp: 'append' })
  h.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  oldWork(h.session, 3, 12); newInput(h.session, 'Continue the fourth turn.', 4)
  const seqs = frozenPrefix(h.session)
  const snapshot = { ...h.snapshot, operationId: randomUUID(), replaceGeneration: 1, seqs, hash: sourceHash(h.session, seqs) }
  const second = await h.windows.turnover(h.agent, 'pressure', signal(), archive, h.flush, undefined, undefined, undefined, undefined, 0, snapshot)
  assert.ok(second)
  const persisted = await inspectPersisted(h.ctx, h.session.id)
  const restored = Session.create(h.session.id, persisted.events)
  const status = new BackgroundSummaries().status(restored) as { status: string; operationId: string; targetGeneration: number }
  assert.equal(status.status, 'interrupted')
  assert.equal(status.operationId, snapshot.operationId)
  assert.equal(status.targetGeneration, 2)
})
