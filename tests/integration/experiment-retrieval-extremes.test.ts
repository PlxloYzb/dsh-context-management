import test from 'node:test'
import assert from 'node:assert/strict'
import { ArchiveReader } from '../../src/archive.ts'
import { runCompactionTransaction } from '../../src/region.ts'
import { host, newSession } from './runtime.ts'
import { appendUser } from '../helpers.ts'

type Page = { status: string; code?: string; nextCursor?: string | null; segments?: { text: string; offset: number }[] }

test('R10: an empty scan-limited page explains continuation; the next page finds the late original within unchanged response grants', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-empty-search-page')
  session.append('turn/start', { turn: 1 })
  appendUser(session, 'x'.repeat(1_100_000) + '\nLATE_SOURCE = "original-value"')
  const source = session.surface.nodes[0]!
  appendUser(session, 'Protected current input')
  runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Original source is archived' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
    provider: 'fixture', model: 'empty-search-page',
  })
  const reader = new ArchiveReader(), query = 'LATE_SOURCE ='
  type SearchPage = { status: string; hits: { seq: number; snippet: string }[]; nextCursor: string | null; scanBudgetReached: boolean; hint?: string }
  const first = reader.search(session, { query, limit: 3 }, 1100) as SearchPage
  assert.equal(first.status, 'success'); assert.deepEqual(first.hits, [])
  assert.equal(first.scanBudgetReached, true); assert.ok(first.nextCursor)
  assert.equal((first as { absent?: boolean }).absent, undefined, 'a scan-limited page must not claim absence')
  assert.match(first.hint ?? '', /nextCursor/)
  assert.match(first.hint ?? '', /same query and limit/)
  assert.match(first.hint ?? '', /not.*absence/)
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 1100)
  const next = reader.search(session, { query, limit: 3, cursor: first.nextCursor }, 1100) as SearchPage
  assert.equal(next.status, 'success'); assert.equal(next.hits.length, 1)
  assert.equal(next.hits[0]!.seq, source); assert.match(next.hits[0]!.snippet, /original-value/)
  assert.equal(next.hint, undefined); assert.ok(Buffer.byteLength(JSON.stringify(next)) <= 1100)
})

test('R10b: an exhaustive empty page reports absence instead of an ambiguous empty array, within the minimum grant', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-exhaustive-empty-search')
  session.append('turn/start', { turn: 1 })
  appendUser(session, `ORIGINAL_MARKER = "value-1"\n${'filler '.repeat(40)}`)
  const source = session.surface.nodes[0]!
  appendUser(session, 'Protected current input')
  runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Historical source archived' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
    provider: 'fixture', model: 'exhaustive-empty-search',
  })
  const reader = new ArchiveReader()
  type Page = {
    status: string; hits: { seq: number; snippet: string }[]; incomplete: boolean
    nextCursor: string | null; scanBudgetReached: boolean
    absent?: boolean; inspectedMessages?: number; hint?: string
  }
  const miss = reader.search(session, { query: 'NEVER_PRESENT_LITERAL' }, 1100) as Page
  assert.equal(miss.status, 'success'); assert.deepEqual(miss.hits, [])
  assert.equal(miss.incomplete, false); assert.equal(miss.scanBudgetReached, false); assert.equal(miss.nextCursor, null)
  assert.equal(miss.absent, true, 'a full-archive scan inside the limit establishes absence')
  assert.ok((miss.inspectedMessages ?? 0) > 0, 'the absence claim reports its coverage')
  assert.match(miss.hint ?? '', /end of the archive/)
  assert.match(miss.hint ?? '', /instead of repeating or permuting/)
  assert.ok(Buffer.byteLength(JSON.stringify(miss)) <= 1100)
  const found = reader.search(session, { query: 'ORIGINAL_MARKER' }, 1100) as Page
  assert.equal(found.status, 'success'); assert.equal(found.hits.length, 1)
  assert.equal(found.absent, undefined, 'a page with hits carries no absence claim')
  assert.equal(found.inspectedMessages, undefined)
  assert.equal(found.hint, undefined)
})

test('R10c: a cursor-resumed page that exhausts the archive does not claim absence for earlier pages', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-resumed-empty-search')
  session.append('turn/start', { turn: 1 })
  appendUser(session, `${'x'.repeat(1_100_000)}\nLATE_SOURCE = "original-value"`)
  const source = session.surface.nodes[0]!
  appendUser(session, 'Protected current input')
  runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Long original is archived' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
    provider: 'fixture', model: 'resumed-empty-search',
  })
  // Deliberately shorter than a 3-gram so the locator filter cannot skip the
  // block: this test needs a page that genuinely stops at the scan budget, which
  // is exactly what the filter now avoids for longer needles.
  const reader = new ArchiveReader(), query = 'zz'
  type Page = {
    status: string; hits: unknown[]; incomplete: boolean; nextCursor: string | null
    scanBudgetReached: boolean; absent?: boolean; inspectedMessages?: number; hint?: string
  }
  const first = reader.search(session, { query }, 1100) as Page
  assert.equal(first.status, 'success'); assert.deepEqual(first.hits, [])
  assert.equal(first.scanBudgetReached, true); assert.ok(first.nextCursor)
  assert.equal(first.absent, undefined, 'a scan-limited page cannot claim absence')
  const rest = reader.search(session, { query, cursor: first.nextCursor! }, 1100) as Page
  assert.equal(rest.status, 'success'); assert.deepEqual(rest.hits, [])
  assert.equal(rest.scanBudgetReached, false); assert.equal(rest.nextCursor, null)
  assert.equal(rest.absent, undefined, 'a resumed page cannot speak for the pages it never saw')
  assert.equal(rest.inspectedMessages, undefined)
  assert.ok(Buffer.byteLength(JSON.stringify(rest)) <= 1100)
})

test('R10e: a long absent needle covers the whole archive without the scan budget', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-filtered-empty-search')
  session.append('turn/start', { turn: 1 })
  // Inside the work budget: indexing this block is charged like scanning, so a
  // larger source would exhaust the budget and correctly report a capped page
  // instead of absence (R10g pins that half).
  appendUser(session, `${'y'.repeat(600_000)}\nFILTERED_SOURCE = "original-value"`)
  const source = session.surface.nodes[0]!
  appendUser(session, 'Protected current input')
  runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Long original is archived' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
    provider: 'fixture', model: 'filtered-empty-search',
  })
  const reader = new ArchiveReader()
  // The block filter proves a 21-character needle absent from a source larger
  // than the whole scan budget, so absence is established in one page. Before
  // the filter this query stopped at the budget and could not answer at all.
  const miss = reader.search(session, { query: 'NEVER_PRESENT_LITERAL' }, 1100) as {
    status: string; hits: unknown[]; scanBudgetReached: boolean; nextCursor: string | null; absent?: boolean; inspectedMessages?: number
  }
  assert.equal(miss.status, 'success'); assert.deepEqual(miss.hits, [])
  assert.equal(miss.scanBudgetReached, false, 'the filter avoids the scan budget')
  assert.equal(miss.nextCursor, null, 'the whole archive is covered in one page')
  assert.equal(miss.absent, true, 'a complete filtered scan establishes absence')
  assert.ok((miss.inspectedMessages ?? 0) > 0, 'the absence claim reports its coverage')
})

test('R10f: case folding is context-free so a present literal is never pruned away', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-case-fold-boundary')
  session.append('turn/start', { turn: 1 })
  // Bulk toLowerCase applies the Unicode Final_Sigma condition, so its result
  // depends on context: 'ΟΣ xyz' folds to 'ος xyz' (final sigma) while 'Σ xyz'
  // folds to 'σ xyz' (no preceding cased letter). The scan reads bounded chunks,
  // so a context-sensitive fold made the answer depend on where the boundary
  // fell: only the chunk starting exactly at the sigma produced the needle's
  // 'σ'. A filter indexed from the whole part produced 'ς' instead, pruned the
  // block, and reported this present literal as absent. Placing the sigma on the
  // 16384-code-point boundary pins that alignment.
  appendUser(session, `${'x'.repeat(16_383)}ΟΣ xyz`)
  const source = session.surface.nodes[0]!
  appendUser(session, 'Protected current input')
  runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Long original is archived' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
    provider: 'fixture', model: 'case-fold-boundary',
  })
  const page = new ArchiveReader().search(session, { query: 'Σ xyz' }, 1100) as {
    status: string; hits: { seq: number; offset: number }[]; absent?: boolean; inspectedMessages?: number
  }
  assert.equal(page.status, 'success')
  assert.notEqual(page.absent, true, 'a present literal must never be reported absent')
  assert.equal(page.hits.length, 1, 'the archived original is found')
  assert.equal(page.hits[0]!.seq, source, 'the hit names the archived record')
})

test('R10g: indexing is charged to the work budget so absence never comes from a partial index', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-index-budget')
  session.append('turn/start', { turn: 1 })
  // Indexing this block costs more than the whole per-call work budget. The
  // filter must be abandoned rather than answered from, and the attempt must be
  // charged: otherwise the query looks free while it lowercases and hashes
  // megabytes that the scan budget never saw.
  appendUser(session, `${'z'.repeat(1_200_000)}\nBUDGET_SOURCE = "original-value"`)
  const source = session.surface.nodes[0]!
  appendUser(session, 'Protected current input')
  runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Long original is archived' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
    provider: 'fixture', model: 'index-budget',
  })
  // Count the hashing the filter does, so "never started" is measured rather than
  // inferred from the response. The needle is hashed once by definition; any
  // further characters would be block text.
  const query = 'NEVER_PRESENT_LITERAL'
  let hashedChars = 0
  const original = ArchiveReader.gramHashes
  ArchiveReader.gramHashes = function (text: string) { hashedChars += text.length; return original(text) }
  let page: { status: string; hits: unknown[]; scanBudgetReached: boolean; absent?: boolean; nextCursor: string | null }
  try { page = new ArchiveReader().search(session, { query }, 1100) as typeof page }
  finally { ArchiveReader.gramHashes = original }
  assert.equal(hashedChars, query.length, 'a block too large for the budget is never indexed')
  assert.equal(page.status, 'success'); assert.deepEqual(page.hits, [])
  assert.equal(page.scanBudgetReached, true, 'the page still reports the scan budget it spent')
  assert.equal(page.absent, undefined, 'a block without an index cannot be called absent')
  assert.ok(page.nextCursor, 'the page continues from a cursor')
})

test('R10d: a mid-line hit names the record it belongs to without growing the snippet', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-line-anchored-snippet')
  session.append('turn/start', { turn: 1 })
  const first = 'Observation 1.0: service=beacon; trace=b4feb9e61dab; latency=700ms; replicas=1; state=ready; previous=delta; checksum=da812088a2. Diagnostic context only.'
  const second = 'Observation 2.0: 服务=甲🙂; trace=7ab63eebd3af; latency=491ms; replicas=2; state=retrying; previous=ember; checksum=1805d5d26e. Diagnostic context only.'
  appendUser(session, `${first}\n${second}\n${'tail line\n'.repeat(40)}`)
  const source = session.surface.nodes[0]!
  appendUser(session, 'Protected current input')
  runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Line-anchored snippet fixture' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
    provider: 'fixture', model: 'line-anchored-snippet',
  })
  const reader = new ArchiveReader()
  type Page = { status: string; hits: { seq: number; offset: number; snippet: string }[]; nextCursor: string | null }
  const page = reader.search(session, { query: 'checksum=', limit: 5 }, 1536) as Page
  assert.equal(page.status, 'success'); assert.ok(page.hits.length >= 2)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1536)
  for (const hit of page.hits) {
    // The match and its value survive, the record name leads, and the snippet
    // never exceeds its documented 100-code-point cap.
    assert.ok(hit.snippet.includes('checksum='), 'snippet keeps the matched literal')
    assert.ok([...hit.snippet].length <= 100, 'snippet respects the code-point cap')
  }
  assert.match(page.hits[0]!.snippet, /^Observation 1\.0:/, 'first hit leads with its record name')
  assert.match(page.hits[0]!.snippet, /checksum=da812088a2/)
  assert.match(page.hits[1]!.snippet, /^Observation 2\.0:/, 'unicode record still resolves to its line opening')
  assert.match(page.hits[1]!.snippet, /checksum=1805d5d26e/)
  // A longer query must keep its whole literal visible: the lead and the
  // back-context shrink instead of the match being truncated away.
  const longQuery = first.slice(60, 130)
  assert.ok([...longQuery].length > 60)
  const longPage = reader.search(session, { query: longQuery, limit: 3 }, 1536) as Page
  assert.equal(longPage.status, 'success'); assert.equal(longPage.hits.length, 1)
  assert.ok(longPage.hits[0]!.snippet.includes(longQuery), 'the full matched literal survives a long query')
  assert.ok([...longPage.hits[0]!.snippet].length <= 100)
})

test('R10e: a single-line block anchors to a bounded opening instead of spreading the whole block', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-single-line-snippet')
  session.append('turn/start', { turn: 1 })
  appendUser(session, `RECORD_HEAD_MARKER ${'pad '.repeat(60_000)}checksum=deadbeef01 end`)
  const source = session.surface.nodes[0]!
  appendUser(session, 'Protected current input')
  runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Single-line snippet fixture' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
    provider: 'fixture', model: 'single-line-snippet',
  })
  const reader = new ArchiveReader()
  type Page = { status: string; hits: { snippet: string }[] }
  const page = reader.search(session, { query: 'checksum=deadbeef01', limit: 3 }, 1536) as Page
  assert.equal(page.status, 'success'); assert.equal(page.hits.length, 1)
  // The block has no newline, so its "line opening" is the block heading; the
  // lead must come from a bounded prefix rather than an array of the whole body.
  assert.match(page.hits[0]!.snippet, /^RECORD_HEAD_MARKER/, 'single-line block anchors to its opening')
  assert.ok(page.hits[0]!.snippet.includes('checksum=deadbeef01'), 'snippet keeps the matched value')
  assert.ok([...page.hits[0]!.snippet].length <= 100)
})

test('R09 experiment: one-token and invalid retrieval budgets are explicit; cancelled pagination can resume without losing Unicode source bytes', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-extreme-retrieval')
  session.append('turn/start', { turn: 1 })
  const original = '甲🙂\r\n\u0000"\\ source '.repeat(800)
  appendUser(session, original)
  const source = session.surface.nodes[0]!
  appendUser(session, 'Latest protected user input')
  const block = runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Historical source is archived' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens, provider: 'fixture', model: 'retrieval-extremes',
  })
  const prefix = JSON.stringify(session.snapshotEvents()), reader = new ArchiveReader()
  for (const maxTokens of [1, 300, 512, 767]) {
    const result = reader.decompress(session, { blockId: block.compactionId, maxTokens }, 1536) as { code: string; minimumMaxTokens: number; hint: string }
    assert.equal(result.code, 'requested-budget-too-small')
    assert.equal(result.minimumMaxTokens, 768)
    assert.match(result.hint, /omit maxTokens|at least 768/)
  }
  assert.deepEqual(reader.decompress(session, { blockId: block.compactionId, maxTokens: 512 }, 500), { status: 'error', code: 'insufficient-headroom' })
  assert.equal((reader.decompress(session, { blockId: block.compactionId, maxTokens: 768 }, 1536) as Page).status, 'success')
  for (const maxTokens of [0, -1, 1.5, 4097, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(reader.decompress(session, { blockId: block.compactionId, maxTokens }), { status: 'error', code: 'invalid-arguments' })
  }
  const first = reader.decompress(session, { blockId: block.compactionId, maxTokens: 4096 }) as Page
  assert.equal(first.status, 'success'); assert.ok(first.nextCursor)
  const abort = new AbortController(); abort.abort(new Error('controlled interrupted page request'))
  assert.throws(() => reader.decompress(session, { blockId: block.compactionId, cursor: first.nextCursor!, maxTokens: 4096 }, 4096, abort.signal), /controlled interrupted/)
  const collected = [...first.segments!.map(segment => segment.text)]
  let cursor = first.nextCursor
  for (let pages = 0; cursor; pages++) {
    assert.ok(pages < 100, 'bounded complete traversal')
    const next = reader.decompress(session, { blockId: block.compactionId, cursor, maxTokens: 4096 }) as Page
    assert.equal(next.status, 'success'); assert.ok(Buffer.byteLength(JSON.stringify(next)) <= 4096)
    collected.push(...next.segments!.map(segment => segment.text)); cursor = next.nextCursor
  }
  assert.deepEqual(Buffer.from(collected.join('')), Buffer.from(original))
  assert.equal(JSON.stringify(session.snapshotEvents()), prefix)
})
