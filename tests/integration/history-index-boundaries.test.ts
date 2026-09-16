import test from 'node:test'
import assert from 'node:assert/strict'
import { ArchiveReader } from '../../src/archive.ts'
import { runCompactionTransaction } from '../../src/region.ts'
import { host, newSession } from './runtime.ts'
import { appendUser } from '../helpers.ts'

/**
 * Boundary coverage the history index contract requires before the index is
 * rewritten (docs/DESIGN-HISTORY-INDEX.*, section 12). Everything here pins
 * behaviour that already exists and that the index must inherit unchanged:
 * cursor lifetime, scope binding, pagination completeness, oversized text and
 * cancellation. The index-specific cases - stop-keys, a partially built index,
 * cache capacity, eviction and rebuild - arrive with the implementation.
 */
type Page = {
  status: string; code?: string; hits: { seq: number; textBlockPath: number[]; offset: number }[]
  nextCursor: string | null; scanBudgetReached: boolean; absent?: boolean; inspectedMessages?: number
}

function archive(h: Awaited<ReturnType<typeof host>>, session: ReturnType<typeof newSession>, body: string, model: string): number {
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

test('B1: a cursor keeps working when events are appended after its anchor', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-cursor-append')
  session.append('turn/start', { turn: 1 })
  archive(h, session, `${'q'.repeat(1_100_000)}\nAPPEND_MARKER = "late"`, 'cursor-append')
  const reader = new ArchiveReader(), query = 'APPEND_MARKER'
  const first = reader.search(session, { query, limit: 5 }, 1100) as Page
  assert.equal(first.status, 'success'); assert.deepEqual(first.hits, [])
  assert.equal(first.scanBudgetReached, true); assert.ok(first.nextCursor)
  // The cursor binds the event at its anchor by fingerprint. Appending leaves
  // that prefix intact, so the page must still resume - a contract the previous
  // wording described incorrectly as "any append invalidates".
  appendUser(session, 'input appended after the cursor was issued')
  const resumed = reader.search(session, { query, limit: 5, cursor: first.nextCursor! }, 1100) as Page
  assert.equal(resumed.status, 'success', 'an append must not invalidate a cursor')
  assert.equal(resumed.code, undefined)
  assert.equal(resumed.hits.length, 1, 'the late original is still reachable')
})

test('B2: a cursor is bound to its query and limit', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-cursor-scope')
  session.append('turn/start', { turn: 1 })
  archive(h, session, `${'r'.repeat(1_100_000)}\nSCOPE_MARKER = "late"`, 'cursor-scope')
  const reader = new ArchiveReader()
  const page = reader.search(session, { query: 'SCOPE_MARKER', limit: 5 }, 1100) as Page
  assert.ok(page.nextCursor)
  const otherQuery = reader.search(session, { query: 'SCOPE_MARKER_OTHER', limit: 5, cursor: page.nextCursor! }, 1100) as Page
  assert.equal(otherQuery.status, 'error'); assert.equal(otherQuery.code, 'invalid-cursor')
  const otherLimit = reader.search(session, { query: 'SCOPE_MARKER', limit: 6, cursor: page.nextCursor! }, 1100) as Page
  assert.equal(otherLimit.status, 'error'); assert.equal(otherLimit.code, 'invalid-cursor')
})

test('B3: pagination returns every archived hit exactly once', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-pagination-complete')
  session.append('turn/start', { turn: 1 })
  // Four separate originals, each archived into its own block, so the traversal
  // has to cross blocks and the ownership map has to hold across pages.
  const seqs: number[] = []
  for (let index = 0; index < 4; index++) {
    seqs.push(archive(h, session, `${'p'.repeat(300_000)}\nSHARED_MARKER occurrence ${index}`, `pagination-${index}`))
  }
  const reader = new ArchiveReader()
  const seen: { seq: number; path: number[]; offset: number }[] = []
  let cursor: string | undefined
  for (let page = 0; page < 40; page++) {
    const result = reader.search(session, cursor === undefined ? { query: 'SHARED_MARKER', limit: 2 } : { query: 'SHARED_MARKER', limit: 2, cursor }, 1100) as Page
    assert.equal(result.status, 'success')
    for (const hit of result.hits) seen.push({ seq: hit.seq, path: hit.textBlockPath, offset: hit.offset })
    if (result.nextCursor === null) break
    cursor = result.nextCursor
  }
  assert.equal(seen.length, 4, 'every archived occurrence is returned exactly once')
  assert.equal(new Set(seen.map(hit => hit.seq)).size, 4, 'no original is reported twice')
  assert.deepEqual([...seen.map(hit => hit.seq)].sort((a, b) => a - b), [...seqs].sort((a, b) => a - b))
})

test('B4: text larger than the whole work budget never yields a false absent', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-oversized-text')
  session.append('turn/start', { turn: 1 })
  archive(h, session, `${'s'.repeat(1_200_000)}\nOVERSIZED_MARKER = "late"`, 'oversized-text')
  const reader = new ArchiveReader(), query = 'OVERSIZED_MARKER'
  let cursor: string | undefined, found = 0, pages = 0
  for (; pages < 40; pages++) {
    const result = reader.search(session, cursor === undefined ? { query, limit: 5 } : { query, limit: 5, cursor }, 1100) as Page
    assert.equal(result.status, 'success')
    found += result.hits.length
    // A capped page may never claim the archive lacks the literal.
    if (result.scanBudgetReached) assert.equal(result.absent, undefined, 'a capped page cannot claim absence')
    if (result.nextCursor === null) { assert.equal(found, 1, 'the traversal still reaches the literal'); break }
    cursor = result.nextCursor
  }
  assert.ok(pages > 0 && found === 1, 'an oversized block is walked to completion rather than skipped')
})

test('B5: an aborted signal never turns into an answer', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-cancellation')
  session.append('turn/start', { turn: 1 })
  archive(h, session, `${'c'.repeat(1_100_000)}\nCANCEL_MARKER = "late"`, 'cancellation')
  const reader = new ArchiveReader(), controller = new AbortController()
  controller.abort()
  assert.throws(
    () => reader.search(session, { query: 'CANCEL_MARKER', limit: 5 }, 1100, controller.signal),
    'an aborted search must raise rather than return a result',
  )
  // The same query without a signal still works, so the abort left no residue.
  const page = reader.search(session, { query: 'CANCEL_MARKER', limit: 5 }, 1100) as Page
  assert.equal(page.status, 'success')
})
