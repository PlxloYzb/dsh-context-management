import test from 'node:test'
import assert from 'node:assert/strict'
import { ArchiveReader } from '../../src/archive.ts'
import { runCompactionTransaction } from '../../src/region.ts'
import { host, newSession } from './runtime.ts'
import { appendUser } from '../helpers.ts'

/**
 * Stop-keys and a partially built index (docs/DESIGN-HISTORY-INDEX.*, sections
 * 3 and 5). Both are cases where the index is deliberately incomplete, and the
 * contract is the same for both: incompleteness may only cost work, never
 * correctness. A stop-key removes evidence; it never removes a source. An
 * unindexed source is unknown, never absent.
 */
type Host = Awaited<ReturnType<typeof host>>
type Session = ReturnType<typeof newSession>
type Page = { status: string; hits: { seq: number }[]; nextCursor: string | null; absent?: boolean; scanBudgetReached: boolean }

function archive(h: Host, session: Session, body: string, model: string): number {
  appendUser(session, body)
  const source = session.surface.nodes[session.surface.nodes.length - 1]!
  appendUser(session, 'Protected current input')
  runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Original archived' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
    provider: 'fixture', model,
  })
  return source
}

test('K1: a stop-key removes evidence but never the source that holds the literal', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-stopkey')
  session.append('turn/start', { turn: 1 })
  // Nine originals carry the shared token, which promotes its grams to
  // stop-keys. The tenth is indexed afterwards, so those grams are omitted from
  // its set even though its text contains them - the only situation in which a
  // stored set is incomplete for its own text.
  for (let index = 0; index < 9; index++) archive(h, session, `FILLER_TOKEN_AB record ${index} ${'f'.repeat(120)}`, `stopkey-${index}`)
  const target = archive(h, session, `FILLER_TOKEN_AB_TAIL ${'g'.repeat(120)}`, 'stopkey-target')
  const reader = new ArchiveReader(), query = 'FILLER_TOKEN_AB_TAIL'
  const page = reader.search(session, { query, limit: 5 }, 4096) as Page
  assert.equal(page.status, 'success')
  assert.notEqual(page.absent, true, 'a stop-key must never produce an absence')
  assert.equal(page.hits.length, 1, 'the literal is present in exactly one original')
  assert.equal(page.hits[0]!.seq, target)
  const state = reader.indexState(session)!
  assert.ok(state.common > 0, 'the shared token really was promoted to stop-keys')
  assert.equal(state.events, 10)
})

test('K2: an unindexed source is read, never excluded', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-partial-index')
  session.append('turn/start', { turn: 1 })
  // One small original that any budget can index, followed by one larger than
  // the entire work budget. The large one must stay unindexed and still be
  // searched, so the literal inside it is found rather than assumed absent.
  const first = archive(h, session, `SMALL_MARKER = "indexed" ${'m'.repeat(200)}`, 'partial-small')
  const large = archive(h, session, `${'b'.repeat(300_000)}\nLARGE_MARKER = "unindexed" ${'c'.repeat(1_100_000)}`, 'partial-large')
  const reader = new ArchiveReader()
  const small = reader.search(session, { query: 'SMALL_MARKER', limit: 5 }, 4096) as Page
  assert.equal(small.hits.length, 1); assert.equal(small.hits[0]!.seq, first)
  assert.ok(reader.indexState(session)!.events >= 1, 'the small original is indexed')
  // The oversized original cannot be indexed within any single budget.
  let cursor: string | undefined, found = 0
  for (let page = 0; page < 40; page++) {
    const step = reader.search(session, cursor === undefined ? { query: 'LARGE_MARKER', limit: 5 } : { query: 'LARGE_MARKER', limit: 5, cursor }, 4096) as Page
    assert.equal(step.status, 'success')
    found += step.hits.length
    if (step.scanBudgetReached) assert.equal(step.absent, undefined, 'a capped page cannot claim absence')
    if (step.nextCursor === null) break
    cursor = step.nextCursor
  }
  assert.equal(found, 1, 'an unindexed original is searched, not skipped')
  assert.equal(reader.indexState(session)!.events, 1, 'the oversized original never entered the index')
  assert.ok(large > first)
})
