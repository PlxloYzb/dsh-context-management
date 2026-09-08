import test from 'node:test'
import assert from 'node:assert/strict'
import { createCore } from 'acp-kernel'
import { Session } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ArchiveReader } from '../../src/archive.ts'
import { archiveHealth } from '../../src/archive-health.ts'
import { ContextManagementEngine } from '../../src/index.ts'
import { ArcStateStore } from '../../src/state.ts'
import { makeTools } from '../../src/tools.ts'
import { runCompactionTransaction, rebuildBlockLedger, resolveSurfaceRange } from '../../src/region.ts'
import { WindowController, resolveArchiveConfig } from '../../src/window-controller.ts'
import { host, newSession, oldWork, newInput } from './runtime.ts'
import { appendAssistant, appendUser } from '../helpers.ts'

test('F02/F08/F18: every occurrence is reachable through search cursors; errors and EOF are explicit', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'all-occurrences'), reader = new ArchiveReader()
  session.append('turn/start', { turn: 1 })
  const text = '🙂 needle '.repeat(50)
  appendUser(session, text); const seq = session.surface.nodes[0]!
  appendUser(session, 'Current request')
  const block = runCompactionTransaction(session, { start: seq, end: seq, shadowedSeqs: [seq], summary: [{ type: 'text', text: 'archive' }], shadowedTokenCount: 250, provider: 'local', model: 'fixture' })
  const offsets: number[] = []; let cursor: string | undefined
  for (let page = 0; page < 80; page++) {
    const result = reader.search(session, { query: 'needle', limit: 20, cursor }) as { hits: { offset: number }[]; nextCursor: string | null }
    offsets.push(...result.hits.map(hit => hit.offset)); cursor = result.nextCursor ?? undefined
    if (!cursor) break
  }
  assert.equal(cursor, undefined)
  assert.deepEqual(offsets, [...text.matchAll(/needle/g)].map(match => match.index))
  assert.match(JSON.stringify(reader.decompress(session, { blockId: 'absent' }, 10)), /block-not-found/)
  const eof = reader.decompress(session, { blockId: block.compactionId, sourceSeq: seq, textBlockPath: [0], offset: text.length }) as { segments: unknown[]; endOfText: boolean }
  assert.deepEqual(eof.segments, []); assert.equal(eof.endOfText, true)
})

test('F03: a non-adjacent window replacement is rejected by both ledger and health diagnostics', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'broken-adjacency')
  oldWork(session); newInput(session, 'Current')
  await new WindowController().turnover({ session, ctx: h.ctx, options: {} }, 'manual', new AbortController().signal, resolveArchiveConfig(), async () => {})
  const events = session.snapshotEvents(), summary = events.findLastIndex(event => event.type === 'compaction/summary')
  const corrupted = [...events.slice(0, summary + 1), { type: 'step/start', seq: summary + 1, time: 0, data: { turn: 2, step: 1 } }, ...events.slice(summary + 1)].map((event, seq) => ({ ...event, seq })) as typeof events
  assert.equal(rebuildBlockLedger(corrupted).length, 0)
  assert.equal(archiveHealth(corrupted).incomplete, true)
  assert.ok(archiveHealth(corrupted).corruptMetadata > 0)
})

test('F04/F20: no-op carries the accepted request id, and empty handoff retains the local fallback', async t => {
  const h = await host(); t.after(h.close)
  const empty = newSession(h.ctx, 'no-prefix'); newInput(empty, 'Only current request', 1)
  const windows = new WindowController()
  const accepted = windows.accept(empty, '', 'call-empty') as { requestId: string }
  assert.equal(await windows.commitPending({ session: empty, ctx: h.ctx, options: {} }, new AbortController().signal, resolveArchiveConfig(), async () => {}), null)
  const notice = windows.takeNotice(empty) as { code: string; requestId: string }
  assert.equal(notice.requestId, accepted.requestId); assert.equal(notice.code, 'no-safe-range')
  assert.equal(windows.takeNotice(empty), undefined)
  const summaries: string[] = []
  for (const handoff of [undefined, '', '   ']) {
    const s = newSession(h.ctx, `handoff-${String(handoff)}`); oldWork(s); newInput(s, 'Current')
    windows.accept(s, handoff)
    await windows.commitPending({ session: s, ctx: h.ctx, options: {} }, new AbortController().signal, resolveArchiveConfig(), async () => {})
    summaries.push(rebuildBlockLedger(s.snapshotEvents())[0]!.summary.split('\n').slice(1).join('\n'))
  }
  assert.equal(summaries[0], summaries[1]); assert.equal(summaries[1], summaries[2])
})

test('F10/F15: malformed seqs and damaged window identity return machine errors without log changes', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'machine-errors'); oldWork(session); newInput(session, 'Current')
  const windows = new WindowController()
  const tools = makeTools({ kernel: createCore({}), store: new ArcStateStore(), modelContextLimit: 128000, newContext: agent => windows.accept(agent.session) })
  const exec = { agent: { session, ctx: h.ctx, options: {} }, signal: new AbortController().signal } as unknown as ToolRunContext
  const before = session.seq
  for (const seq of ['-0', -0, '0x4', '1e1', Number.MAX_SAFE_INTEGER + 1]) {
    const out = await tools.find(tool => tool.name === 'compress')!.execute({ content: [{ startSeq: seq, endSeq: 2, summary: 'A'.repeat(80) }] }, exec)
    assert.equal(JSON.parse(out.text).code, Object.is(seq, -0) ? 'INVALID_ARGS' : 'invalid-seq', `${String(seq)} ${out.text}`)
  }
  assert.equal(session.seq, before)
  await windows.turnover({ session, ctx: h.ctx, options: {} }, 'manual', new AbortController().signal, resolveArchiveConfig(), async () => {})
  const damagedEvents = structuredClone(session.snapshotEvents())
  const summary = damagedEvents.find(event => event.type === 'compaction/summary')!
  if (summary.type === 'compaction/summary' && summary.data.contextManagement) summary.data.contextManagement.generationAfter = 2
  const damaged = new Session('damaged-generation', damagedEvents)
  const damagedExec = { ...exec, agent: { session: damaged, ctx: h.ctx, options: {} } } as unknown as ToolRunContext
  const damagedBefore = damaged.seq
  const out = await tools.find(tool => tool.name === 'new_context')!.execute({}, damagedExec)
  assert.equal(JSON.parse(out.text).code, 'corrupt-metadata'); assert.equal(damaged.seq, damagedBefore)
  assert.throws(() => resolveSurfaceRange(session, 0, 0), /not a surface node/)
})

test('F13: in-place can compact accumulated old checkpoints and recover every original', async t => {
  const h = await host(); t.after(h.close)
  const engine = new ContextManagementEngine(h.ctx, { autoNudge: false, modelContextLimit: 32768, adaptiveGovernor: { strategy: 'in-place', maxOutputTokens: 8192 } })
  const session = newSession(h.ctx, 'inplace-checkpoints')
  session.append('turn/start', { turn: 1 })
  for (let i = 0; i < 8; i++) {
    appendUser(session, `UNIQUE_ORIGINAL_${i} = unchanged-${i}`)
    const source = session.surface.nodes.at(-1)!
    appendUser(session, 'Temporary current request')
    runCompactionTransaction(session, { start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Old checkpoint detail '.repeat(1100) }], shadowedTokenCount: 12, provider: 'local', model: 'fixture' })
  }
  appendUser(session, 'CURRENT_USER_MUST_STAY')
  for (let i = 0; i < 6; i++) {
    session.append('step/start', { turn: 1, step: i + 1 })
    appendAssistant(session, `Recently consumed ${i}`, 1, i + 1)
    session.append('step/end', { turn: 1, step: i + 1 })
  }
  const before = [...session.snapshotEvents()]
  const result = await engine.compactIfNeeded({ session, ctx: h.ctx, options: {} }, 'pressure', new AbortController().signal)
  assert.ok(result)
  assert.deepEqual(session.snapshotEvents().slice(0, before.length), before)
  assert.equal(engine.windows.identity(session).generation, 0, 'in-place does not create a window generation')
  assert.ok(JSON.stringify(session.deriveMessages()).includes('CURRENT_USER_MUST_STAY'))
  const ledger = rebuildBlockLedger(session.snapshotEvents()), last = ledger.at(-1)!
  assert.ok(last.parentBlockIds.length > 0)
  const reader = new ArchiveReader()
  for (let i = 0; i < 8; i++) assert.match(JSON.stringify(reader.search(session, { query: `UNIQUE_ORIGINAL_${i}` })), new RegExp(`unchanged-${i}`))
})

test('F05: extractive mode alone does not imply an incomplete seed', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'small-complete-index'); oldWork(session, 1, 1); newInput(session, 'Current')
  const result = await new WindowController().turnover({ session, ctx: h.ctx, options: {} }, 'manual', new AbortController().signal, resolveArchiveConfig(), async () => {})
  assert.ok(result)
  const seed = rebuildBlockLedger(session.snapshotEvents())[0]!.contextManagement!.seed
  assert.equal(seed.mode, 'extractive'); assert.equal(seed.incomplete, false)
})

test('F17: active cursors survive LRU churn and evicted cursors give a recovery instruction', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'cursor-lru'); oldWork(session); newInput(session, 'Current')
  await new WindowController().turnover({ session, ctx: h.ctx, options: {} }, 'manual', new AbortController().signal, resolveArchiveConfig(), async () => {})
  const reader = new ArchiveReader(), blockId = rebuildBlockLedger(session.snapshotEvents())[0]!.blockId
  const first = reader.decompress(session, { blockId }) as { nextCursor: string }
  assert.ok(first.nextCursor)
  for (let i = 0; i < 255; i++) reader.decompress(session, { blockId })
  assert.equal((reader.decompress(session, { blockId, cursor: first.nextCursor }) as { status: string }).status, 'success')
  reader.decompress(session, { blockId })
  assert.equal((reader.decompress(session, { blockId, cursor: first.nextCursor }) as { status: string }).status, 'success')
  for (let i = 0; i < 257; i++) reader.decompress(session, { blockId })
  const expired = reader.decompress(session, { blockId, cursor: first.nextCursor }) as { code: string; recovery: string }
  assert.equal(expired.code, 'invalid-cursor'); assert.match(JSON.stringify(expired), /restart|again|without.*cursor/i)
})
