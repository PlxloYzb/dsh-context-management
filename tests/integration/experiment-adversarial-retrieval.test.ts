// Adversarial retrieval tests: deliberately try to falsify the candidate 8/9
// contracts (absence claims and line-anchored snippets) at their boundaries.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ArchiveReader } from '../../src/archive.ts'
import { runCompactionTransaction } from '../../src/region.ts'
import { host, newSession } from './runtime.ts'
import { appendUser } from '../helpers.ts'

type Hit = { seq: number; offset: number; snippet: string; textBlockPath: number[] }
type Page = {
  status: string; code?: string; hits: Hit[]; incomplete: boolean; nextCursor: string | null
  scanBudgetReached: boolean; absent?: boolean; inspectedMessages?: number; hint?: string
}
const hasLoneSurrogate = (text: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)

function archiveOneMessage(h: Awaited<ReturnType<typeof host>>, id: string, text: string) {
  const session = newSession(h.ctx, id)
  session.append('turn/start', { turn: 1 })
  appendUser(session, text)
  const source = session.surface.nodes[0]!
  appendUser(session, 'Protected current input')
  runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Adversarial fixture archived' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
    provider: 'fixture', model: 'adversarial-retrieval',
  })
  return { session, reader: new ArchiveReader() }
}

test('ADV1: the matched literal survives the snippet budget for every query length up to the cap', async t => {
  const h = await host(); t.after(h.close)
  const run = 'z'.repeat(130)
  const { session, reader } = archiveOneMessage(h, 'adversarial-query-length', `HEADER_MARK ${'pad '.repeat(20)}${run} TAIL_MARK\nsecond line`)
  for (const length of [1, 2, 40, 60, 80, 84, 85, 88, 90, 91, 92, 95, 99, 100, 101, 110, 130]) {
    const query = run.slice(0, length)
    const page = reader.search(session, { query, limit: 5 }, 1536) as Page
    assert.equal(page.status, 'success', `length ${length} must succeed`)
    assert.ok(page.hits.length > 0, `length ${length} must match`)
    const snippet = page.hits[0]!.snippet
    assert.ok([...snippet].length <= 100, `length ${length}: snippet cap`)
    if (length <= 100) assert.ok(snippet.includes(query), `length ${length}: the whole queried literal must stay visible`)
  }
})

test('ADV2: a line opening made of surrogate pairs is anchored without breaking a code point', async t => {
  const h = await host(); t.after(h.close)
  const opening = '🙂'.repeat(40)
  const { session, reader } = archiveOneMessage(h, 'adversarial-surrogate-opening', `${opening} service=beacon; state=ready; checksum=deadbeef01 end\nnext`)
  const page = reader.search(session, { query: 'checksum=deadbeef01', limit: 3 }, 1536) as Page
  assert.equal(page.status, 'success'); assert.equal(page.hits.length, 1)
  const snippet = page.hits[0]!.snippet
  assert.ok(snippet.startsWith('🙂'), 'the lead must start with the record opening')
  assert.ok(snippet.includes('checksum=deadbeef01'), 'the match must survive')
  assert.ok(!hasLoneSurrogate(snippet), 'the snippet must not cut a surrogate pair')
  assert.ok([...snippet].length <= 100)
})

test('ADV3: CRLF line endings do not leak a carriage return into the lead and still name the record', async t => {
  const h = await host(); t.after(h.close)
  const { session, reader } = archiveOneMessage(h, 'adversarial-crlf', 'Record A: service=alpha; state=ready; checksum=aaaaaaaaaa.\r\nRecord B: service=beta; state=draining; checksum=bbbbbbbbbb.\r\n')
  const page = reader.search(session, { query: 'checksum=bbbbbbbbbb', limit: 3 }, 1536) as Page
  assert.equal(page.status, 'success'); assert.equal(page.hits.length, 1)
  const snippet = page.hits[0]!.snippet
  assert.ok(snippet.startsWith('Record B:'), `lead must name the second record, got ${JSON.stringify(snippet)}`)
  assert.ok(!snippet.startsWith('\r') && !snippet.startsWith('\n'), 'the lead must not start at the previous line ending')
})

test('ADV4: an archive with no searchable history never claims absence', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'adversarial-empty-archive')
  session.append('turn/start', { turn: 1 })
  appendUser(session, 'Nothing has been archived yet')
  const page = new ArchiveReader().search(session, { query: 'ANYTHING' }, 1100) as Page
  assert.equal(page.status, 'success'); assert.deepEqual(page.hits, [])
  assert.equal(page.absent, undefined, 'no archived ledger means no absence claim')
  assert.equal(page.inspectedMessages, undefined)
})

test('ADV5: nested archives reused across queries never let ownership dedup fake an absence', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'adversarial-ownership-absent')
  session.append('turn/start', { turn: 1 })
  appendUser(session, 'NEEDLE_IN_FIRST_BLOCK token=findme01')
  appendUser(session, 'Other archived material with no marker')
  const originals = [...session.surface.nodes]
  appendUser(session, 'Protected current input')
  const price = seq => h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === seq)!.heuristicTokens
  const first = runCompactionTransaction(session, {
    start: originals[0]!, end: originals[0]!, shadowedSeqs: [originals[0]!], summary: [{ type: 'text', text: 'First block' }],
    shadowedTokenCount: price(originals[0]!), provider: 'fixture', model: 'adversarial-ownership',
  })
  runCompactionTransaction(session, {
    start: originals[1]!, end: originals[1]!, shadowedSeqs: [originals[1]!], summary: [{ type: 'text', text: 'Second block' }],
    shadowedTokenCount: price(originals[1]!), provider: 'fixture', model: 'adversarial-ownership',
  })
  const reader = new ArchiveReader()
  // Warm ownership with an unrelated query first, then search the marker and a
  // literal that is genuinely absent. Ownership must not suppress the marker.
  reader.search(session, { query: 'unrelated-probe' }, 1536)
  const found = reader.search(session, { query: 'token=findme01' }, 1536) as Page
  assert.equal(found.status, 'success'); assert.equal(found.hits.length, 1, 'ownership dedup must not hide a real match')
  assert.equal(found.absent, undefined)
  const missing = reader.search(session, { query: 'token=absent99' }, 1536) as Page
  assert.equal(missing.status, 'success'); assert.equal(missing.hits.length, 0)
  assert.equal(missing.absent, true, 'a complete scan of an intact archive may claim absence')
  assert.ok((missing.inspectedMessages ?? 0) >= 2)
  assert.ok(first.compactionId.length > 0)
})

test('ADV6: checkpoint echoes are not indexed, never displace originals, and never reach decompress as evidence', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'adversarial-summary-not-indexed')
  session.append('turn/start', { turn: 1 })
  appendUser(session, 'ORIGINAL_EVIDENCE_ALPHA payload=alpha1')
  const source = session.surface.nodes[0]!
  appendUser(session, 'Protected current input')
  const block = runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source],
    summary: [{ type: 'text', text: `Checkpoint echo of seq ${source} offset 0: ORIGINAL_EVIDENCE_ALPHA payload=alpha1` }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
    provider: 'fixture', model: 'adversarial-summary-not-indexed',
  })
  const reader = new ArchiveReader()
  type Marked = Page & { hits: (Hit & { source?: string })[] }
  // The archived original is found exactly once; the checkpoint's echo of the
  // same text must not add a second, summary-sourced hit.
  const original = reader.search(session, { query: 'ORIGINAL_EVIDENCE_ALPHA' }, 1536) as Marked
  assert.equal(original.status, 'success'); assert.equal(original.hits.length, 1, 'echoes must not dilate the hit list')
  assert.equal(original.hits[0]!.seq, source)
  assert.equal(original.hits[0]!.source, undefined, 'no hit may be attributed to a summary')
  // Wording that exists only in the checkpoint is out of the documented index.
  const echo = reader.search(session, { query: 'Checkpoint echo of seq' }, 1536) as Marked
  assert.equal(echo.status, 'success'); assert.deepEqual(echo.hits, [], 'summaries are not part of the search index')
  // decompress still restores originals only and never fabricates summary text.
  const restored = reader.decompress(session, { blockId: block.compactionId, maxTokens: 1024 }) as { segments: { text: string }[] }
  const text = restored.segments.map(segment => segment.text).join('')
  assert.match(text, /ORIGINAL_EVIDENCE_ALPHA payload=alpha1/)
  assert.doesNotMatch(text, /Checkpoint echo of seq/, 'a summary is not original evidence')
})

test('ADV7: absence requires a matched-free page even when the same literal exists in a later block only', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'adversarial-late-hit')
  session.append('turn/start', { turn: 1 })
  appendUser(session, 'Early block without the marker')
  appendUser(session, 'Late block carries token=latehit77')
  const originals = [...session.surface.nodes]
  appendUser(session, 'Protected current input')
  const price = seq => h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === seq)!.heuristicTokens
  runCompactionTransaction(session, {
    start: originals[0]!, end: originals[0]!, shadowedSeqs: [originals[0]!], summary: [{ type: 'text', text: 'Early block' }],
    shadowedTokenCount: price(originals[0]!), provider: 'fixture', model: 'adversarial-late-hit',
  })
  runCompactionTransaction(session, {
    start: originals[1]!, end: originals[1]!, shadowedSeqs: [originals[1]!], summary: [{ type: 'text', text: 'Late block' }],
    shadowedTokenCount: price(originals[1]!), provider: 'fixture', model: 'adversarial-late-hit',
  })
  const page = new ArchiveReader().search(session, { query: 'token=latehit77' }, 1536) as Page
  assert.equal(page.status, 'success'); assert.equal(page.hits.length, 1)
  assert.equal(page.absent, undefined, 'a literal found in a later block is not absent')
})
