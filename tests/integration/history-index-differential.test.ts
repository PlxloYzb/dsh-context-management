import test from 'node:test'
import assert from 'node:assert/strict'
import { ArchiveReader } from '../../src/archive.ts'
import { runCompactionTransaction } from '../../src/region.ts'
import { host, newSession } from './runtime.ts'
import { appendUser } from '../helpers.ts'

/**
 * Differential harness for the history index contract (docs/DESIGN-HISTORY-INDEX.*).
 *
 * I1 says: under the same session snapshot, query semantics and initial state,
 * a complete pagination must yield the same hit POSITIONS and ownership whether
 * the index accelerates the search or not - at least (seq, path, offset). Per
 * page splits may differ, because indexing is charged to the work budget, so
 * this compares the exhausted traversal rather than any single page.
 *
 * The scan-only reader is the reference. It is produced by the isolation the
 * contract documents: replacing the candidate stage with "may contain", which
 * leaves every other decision - ownership, folding, chunking, overlap handling,
 * snippet packing and cursors - untouched.
 */
type Hit = { seq: number; path: number[]; offset: number }
type Page = { status: string; hits: { seq: number; textBlockPath: number[]; offset: number }[]; nextCursor: string | null; scanBudgetReached: boolean }

function scanOnly(): ArchiveReader {
  const reader = new ArchiveReader()
  ;(reader as unknown as { blockMayContain: () => { verdict: boolean; cost: number } }).blockMayContain = () => ({ verdict: true, cost: 0 })
  return reader
}

/** Walks every page the cursor offers and returns the exhausted hit list. */
function exhaust(reader: ArchiveReader, session: Parameters<ArchiveReader['search']>[0], query: string): Hit[] {
  const out: Hit[] = []
  let cursor: string | undefined
  for (let page = 0; page < 200; page++) {
    const result = reader.search(session, cursor === undefined ? { query, limit: 20 } : { query, limit: 20, cursor }, 4096) as Page
    assert.equal(result.status, 'success', `page ${page} of ${query}`)
    for (const hit of result.hits) out.push({ seq: hit.seq, path: hit.textBlockPath, offset: hit.offset })
    if (result.nextCursor === null) return out
    cursor = result.nextCursor
  }
  throw new Error(`pagination did not terminate for ${query}`)
}

const cases: { name: string; body: string; queries: string[] }[] = [
  {
    // Capital sigma on a scan chunk boundary: bulk toLowerCase folds it to the
    // final form when a cased letter precedes it, so a context-sensitive fold
    // makes the answer depend on chunk alignment.
    name: 'greek sigma on a chunk boundary',
    body: `${'x'.repeat(16_383)}ΟΣ xyz ${'y'.repeat(40_000)}ΟΣ tail`,
    queries: ['Σ xyz', 'ΟΣ', 'ος', 'σ xyz'],
  },
  {
    name: 'chinese and multi-byte text',
    body: `前綴${'中'.repeat(20_000)}字符測試環境 錯誤代碼 E1234`,
    queries: ['字符測試', '錯誤代碼 E1234', 'E1234'],
  },
  {
    // The literal straddles the 16384 boundary, so one occurrence is only
    // reachable through the scan's overlap between neighbouring chunks.
    name: 'literal spanning a chunk boundary',
    body: `${'a'.repeat(16_378)}STRADDLE_MARKER_9f3a ${'b'.repeat(30_000)}STRADDLE_MARKER_9f3a`,
    queries: ['STRADDLE_MARKER_9f3a'],
  },
  {
    // Overlapping occurrences must all be found: the scan advances one scalar
    // after a hit rather than past the whole match.
    name: 'overlapping occurrences',
    body: `abababab ${'c'.repeat(40)} ababab`,
    queries: ['abab', 'aba'],
  },
  {
    name: 'substring of a longer token, and a field-shaped literal',
    body: `record=alpha-42; state=retrying; checksum=059d707a35\n${'z'.repeat(20_000)}\nchecksum=059d707a35 tail`,
    queries: ['059d707a35', 'checksum=059d707a35', 'alpha-42', 'state=retrying'],
  },
]

for (const item of cases) {
  test(`R12/I1 differential: ${item.name}`, async t => {
    const h = await host(); t.after(h.close)
    const session = newSession(h.ctx, `experiment-differential-${item.queries.length}-${item.name.replace(/\W+/g, '-').slice(0, 32)}`)
    session.append('turn/start', { turn: 1 })
    appendUser(session, item.body)
    const source = session.surface.nodes[0]!
    appendUser(session, 'Protected current input')
    runCompactionTransaction(session, {
      start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Original archived' }],
      shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
      provider: 'fixture', model: 'differential',
    })
    for (const query of item.queries) {
      const accelerated = exhaust(new ArchiveReader(), session, query)
      const reference = exhaust(scanOnly(), session, query)
      assert.deepEqual(accelerated, reference, `index and scan must agree on every hit for ${JSON.stringify(query)}`)
      // A literal that is present must be found by the accelerated path too;
      // agreeing on an empty list would otherwise hide a shared blind spot.
      if (item.body.includes(query)) assert.ok(accelerated.length > 0, `${JSON.stringify(query)} is present in the original`)
    }
  })
}

test('R12/I1 differential: nested sources keep positions and ownership identical', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-differential-nested')
  session.append('turn/start', { turn: 1 })
  appendUser(session, `TIER1_MARKER = "kept"\n${'n'.repeat(30_000)}\nTIER1_TAIL = "end"`)
  const first = session.surface.nodes[0]!
  appendUser(session, 'middle input')
  runCompactionTransaction(session, {
    start: first, end: first, shadowedSeqs: [first], summary: [{ type: 'text', text: 'Tier one distills the first original' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === first)!.heuristicTokens,
    provider: 'fixture', model: 'differential-tier1',
  })
  // Distil the tier-1 block itself, so the original is reachable only through a
  // parent block and its sequence has two candidate owners.
  const tier1 = session.surface.nodes[session.surface.nodes.length - 1]!
  appendUser(session, 'tail input')
  runCompactionTransaction(session, {
    start: tier1, end: tier1, shadowedSeqs: [tier1], summary: [{ type: 'text', text: 'Tier two distils the tier-one block' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === tier1)!.heuristicTokens,
    provider: 'fixture', model: 'differential-tier2',
  })
  for (const query of ['TIER1_MARKER', 'TIER1_TAIL', 'Tier one distills']) {
    const accelerated = exhaust(new ArchiveReader(), session, query)
    const reference = exhaust(scanOnly(), session, query)
    assert.deepEqual(accelerated, reference, `nested agreement for ${query}`)
  }
})
