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
  assert.match(first.hint ?? '', /nextCursor/)
  assert.match(first.hint ?? '', /same query and limit/)
  assert.match(first.hint ?? '', /not.*absence/)
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 1100)
  const next = reader.search(session, { query, limit: 3, cursor: first.nextCursor }, 1100) as SearchPage
  assert.equal(next.status, 'success'); assert.equal(next.hits.length, 1)
  assert.equal(next.hits[0]!.seq, source); assert.match(next.hits[0]!.snippet, /original-value/)
  assert.equal(next.hint, undefined); assert.ok(Buffer.byteLength(JSON.stringify(next)) <= 1100)
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
