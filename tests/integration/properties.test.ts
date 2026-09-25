import test from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { ContextManagementEngine } from '../../src/index.ts'
import { ArchiveReader, resolveSources } from '../../src/archive.ts'
import { BlockLedgerIndex, rebuildBlockLedger, runCompactionTransaction } from '../../src/region.ts'
import { WindowController, resolveArchiveConfig, windowIdentity } from '../../src/window-controller.ts'
import { host, newSession, oldWork, newInput, inspectPersisted } from './runtime.ts'
import { appendToolCall, appendToolResult, appendUser } from '../helpers.ts'

test('R05: a real local attachment can disappear while the durable source and missing-attachment explanation remain', async t => {
  const h = await host(); t.after(h.close)
  const attachments = new LocalAttachmentStore(h.ctx, { dshHome: h.root })
  const engine = new ContextManagementEngine(h.ctx, { autoNudge: false })
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
  const ref = await attachments.saveImage({ data: image, mediaType: 'image/png', name: 'synthetic.png' })
  const session = newSession(h.ctx, 'deleted-attachment')
  session.append('turn/start', { turn: 1 })
  const source = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic image source' }, { type: 'image', attachment: ref }] }), { surfaceOp: 'append' }).seq
  appendUser(session, 'Current user input stays active')
  const block = runCompactionTransaction(session, { start: source, end: source, shadowedSeqs: [source], shadowedTokenCount: 1600, summary: [{ type: 'text', text: 'Historical image reference' }], provider: 'fixture', model: 'image' })
  const before = JSON.stringify(engine.reader.decompress(session, { blockId: block.compactionId }))
  assert.match(before, /available-reference/)
  await rm(attachments.imageHostPath(ref))
  const after = JSON.stringify(engine.reader.decompress(session, { blockId: block.compactionId }))
  assert.match(after, /missing-attachment/); assert.match(after, /"incomplete":true/)
  assert.doesNotMatch(after, /iVBORw0KGgo/)
  assert.equal(await h.ctx.sessions.flush(session), true)
  const stored = await inspectPersisted(h.ctx, session.id)
  assert.deepEqual(stored.events[source], session.eventAt(source))
})

test('generated seeds 1..20: append/prune/window replay preserves origins, pairing, unique source coverage and isolated identities', async t => {
  const h = await host(); t.after(h.close)
  for (let seed = 1; seed <= 20; seed++) {
    const session = newSession(h.ctx, `generated-${seed}`), windows = new WindowController(), reader = new ArchiveReader(), index = new BlockLedgerIndex()
    let state = seed
    const random = () => (state = (state * 1664525 + 1013904223) >>> 0)
    for (let generation = 1; generation <= 3; generation++) {
      const turn = generation * 2 - 1
      oldWork(session, turn, 5 + random() % 12)
      newInput(session, `Latest correction ${seed}/${generation}: retain 甲🙂\r\n exactly.`, turn + 1)
      const before = session.snapshotEvents()
      const result = await windows.turnover({ session, ctx: h.ctx, options: {} }, 'pressure', new AbortController().signal, resolveArchiveConfig(), async () => { await h.ctx.sessions.flush(session) })
      assert.ok(result, `seed ${seed}, generation ${generation}`)
      assert.deepEqual(session.snapshotEvents().slice(0, before.length), before)
      assert.equal(toolPairingBalancedAfter(session, session.surface.nodes.at(-1)!), true)
      assert.equal(windowIdentity(session).generation, generation)
      const ledger = index.update(session.snapshotEvents())
      assert.deepEqual(ledger, rebuildBlockLedger(session.snapshotEvents()))
      assert.deepEqual(reader.ledger(session), ledger)
      const sources = resolveSources(session, result.shadowedSeqs)
      assert.equal(sources.incomplete, false)
      assert.equal(new Set(sources.seqs).size, sources.seqs.length)
      const restored = Session.create(session.id, session.snapshotEvents())
      assert.deepEqual(restored.surface.nodes, session.surface.nodes)
      assert.deepEqual(windowIdentity(restored), windowIdentity(session))
      session.append('step/start', { turn: turn + 1, step: 1 })
      const callId = `generated-call-${seed}-${generation}`
      appendToolCall(session, 'Read historical data', callId, turn + 1, 1)
      appendToolResult(session, `MIDDLE-${random()} 甲🙂\r\n${'content '.repeat(400)}`, callId, turn + 1, 1)
      const original = session.surface.nodes.at(-1)!
      if (random() % 2) {
        const event = session.eventAt(original)!
        assert.equal(event.type, 'tool/result')
        if (event.type === 'tool/result') session.append('tool/result', { ...event.data, message: { ...event.data.message, content: [{ type: 'tool-result', toolCallId: callId as never, content: [{ type: 'text', text: 'pruned reference' }] }] } }, { surfaceOp: { op: 'replace', start: original, end: original }, sourceEventSeqs: [original] })
      }
      session.append('step/end', { turn: turn + 1, step: 1 })
      session.append('turn/end', { turn: turn + 1, reason: { kind: 'completed' } })
    }
    const foreign = newSession(h.ctx, `foreign-${seed}`)
    assert.match(JSON.stringify(reader.decompress(foreign, { blockId: reader.ledger(session)[0]!.blockId })), /block-not-found/)
  }
})

test('duplicate operation IDs and the current user fence are rejected before a transaction writes', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'duplicate-operation')
  oldWork(session); newInput(session, 'Current protected user')
  const selected = session.surface.nodes.slice(1, 3)
  const input = { operationId: 'stable-operation', start: selected[0]!, end: selected.at(-1)!, shadowedSeqs: selected, summary: [{ type: 'text' as const, text: 'Checkpoint' }], shadowedTokenCount: 1000, provider: 'fixture', model: 'test' }
  runCompactionTransaction(session, input)
  const before = session.seq
  assert.throws(() => runCompactionTransaction(session, input), /duplicate-operation-id/)
  const current = session.surface.nodes.at(-1)!
  assert.throws(() => runCompactionTransaction(session, { ...input, operationId: 'new-operation', start: current, end: current, shadowedSeqs: [current] }), /protected-current-user/)
  assert.equal(session.seq, before)
})
