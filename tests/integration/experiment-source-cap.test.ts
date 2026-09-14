import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { ArchiveReader, resolveSources } from '../../src/archive.ts'
import { runCompactionTransaction } from '../../src/region.ts'
import { appendUser } from '../helpers.ts'

test('R11 source traversal cap exposes incomplete retrieval beyond 200000 original messages', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  new SessionProjectionRegistry(ctx); new TokenMeter(ctx)
  const session = Session.create('experiment-source-cap')
  session.append('turn/start', { turn: 1 })
  for (let index = 0; index < 200_001; index++) appendUser(session, index === 200_000 ? 'ONLY_BEYOND_CAP' : '')
  const originals = [...session.surface.nodes]
  appendUser(session, 'Protect current input')
  const exact = resolveSources(session, originals.slice(0, 200_000))
  assert.equal(exact.incomplete, false); assert.equal(exact.seqs.length, 200_000)
  const overflow = resolveSources(session, originals)
  assert.equal(overflow.incomplete, true); assert.deepEqual(overflow.missing, [])
  assert.deepEqual(overflow.seqs, originals.slice(0, 200_000))
  const measured = ctx.tokenMeter.measure(session)
  const shadowedTokenCount = measured.nodes.slice(0, 200_001).reduce((sum, node) => sum + node.heuristicTokens, 0)
  const block = runCompactionTransaction(session, {
    start: originals[0]!, end: originals.at(-1)!, shadowedSeqs: originals,
    summary: [{ type: 'text', text: 'Synthetic source capacity fixture' }],
    shadowedTokenCount, provider: 'controlled', model: 'source-cap',
  })
  const originalEvents = session.snapshotEvents(), reader = new ArchiveReader()
  const first = reader.decompress(session, { blockId: block.compactionId, maxTokens: 4096 }) as {
    status: string; incomplete: boolean; nextCursor: string | null; missing: number[]
  }
  assert.equal(first.status, 'success'); assert.equal(first.incomplete, true)
  assert.deepEqual(first.missing, []); assert.ok(first.nextCursor)
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 4096)
  const search = reader.search(session, { query: 'ONLY_BEYOND_CAP' }) as {
    status: string; incomplete: boolean; hits: unknown[]; nextCursor: string | null
  }
  assert.equal(search.status, 'success'); assert.equal(search.incomplete, true)
  assert.deepEqual(search.hits, []); assert.equal(search.nextCursor, null)
  assert.deepEqual(reader.decompress(session, { blockId: block.compactionId, sourceSeq: originals.at(-1)! }), {
    status: 'error', code: 'source-not-in-archive',
  })
  assert.equal(session.snapshotEvents().length, originalEvents.length)
  assert.ok(session.snapshotEvents().every((event, index) => event === originalEvents[index]))
  assert.equal(session.eventAt(originals.at(-1)!)?.type, 'user/message')
})

test('R11 search ownership cap retains late sources across nested archives with explicit duplicate allowance', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  new SessionProjectionRegistry(ctx); new TokenMeter(ctx)
  const session = Session.create('experiment-search-ownership-cap')
  session.append('turn/start', { turn: 1 })
  for (let index = 0; index < 200_001; index++) appendUser(session, index === 200_000 ? 'LATE_SOURCE_SENTINEL' : '')
  const originals = [...session.surface.nodes]
  appendUser(session, 'Protect current input')
  const prices = new Map(ctx.tokenMeter.measure(session).nodes.map(node => [node.seq, node.heuristicTokens]))
  const archive = (selected: typeof originals) => runCompactionTransaction(session, {
    start: selected[0]!, end: selected.at(-1)!, shadowedSeqs: selected,
    summary: [{ type: 'text', text: 'Nested search capacity fixture' }],
    shadowedTokenCount: selected.reduce((sum, seq) => sum + prices.get(seq)!, 0),
    provider: 'controlled', model: 'search-ownership-cap',
  })
  archive(originals.slice(0, 100_000)); archive(originals.slice(100_000))
  const secondSummary = session.surface.nodes[1]!
  prices.set(secondSummary, ctx.tokenMeter.measure(session).nodes.find(node => node.seq === secondSummary)!.heuristicTokens)
  archive([secondSummary])
  const reader = new ArchiveReader(), before = session.seq
  const miss = reader.search(session, { query: 'UNMATCHED' }) as { status: string; hits: unknown[]; incomplete: boolean; nextCursor: string | null }
  assert.equal(miss.status, 'success'); assert.deepEqual(miss.hits, [])
  assert.equal(miss.incomplete, false); assert.equal(miss.nextCursor, null)
  const found: number[] = []; let cursor: string | undefined
  for (let page = 0; page < 8; page++) {
    const result = reader.search(session, { query: 'LATE_SOURCE_SENTINEL', limit: 1, cursor }) as {
      status: string; hits: { seq: number }[]; incomplete: boolean; nextCursor: string | null
    }
    assert.equal(result.status, 'success'); assert.equal(result.incomplete, false)
    found.push(...result.hits.map(hit => hit.seq)); cursor = result.nextCursor ?? undefined
    if (!cursor) break
  }
  assert.equal(cursor, undefined)
  assert.deepEqual(found, [originals.at(-1)!, originals.at(-1)!], 'Untracked late sources may repeat across parent archives, but are not omitted')
  assert.equal(session.seq, before)
})

test('R11 archive source-cache eviction preserves original bytes and an earlier active cursor', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  new SessionProjectionRegistry(ctx); new TokenMeter(ctx)
  const session = Session.create('experiment-source-cache-eviction'), reader = new ArchiveReader()
  session.append('turn/start', { turn: 1 })
  const original = 'first source 甲🙂\r\n'.repeat(800)
  const blocks: string[] = []
  for (let index = 0; index < 34; index++) {
    appendUser(session, index === 0 ? original : `ORIGINAL_${index}`)
    const source = session.surface.nodes.at(-1)!
    appendUser(session, 'Current instruction')
    const block = runCompactionTransaction(session, {
      start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Archived source' }],
      shadowedTokenCount: ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
      provider: 'controlled', model: 'cache-eviction',
    })
    blocks.push(block.compactionId)
  }
  type Page = { status: string; incomplete: boolean; segments: { text: string }[]; nextCursor: string | null }
  const first = reader.decompress(session, { blockId: blocks[0]!, maxTokens: 4096 }) as Page
  assert.equal(first.status, 'success'); assert.ok(first.nextCursor)
  for (let index = 1; index < blocks.length; index++) {
    const result = reader.decompress(session, { blockId: blocks[index]!, maxTokens: 4096 }) as Page
    assert.equal(result.status, 'success'); assert.equal(result.incomplete, false)
    assert.equal(result.segments.map(segment => segment.text).join(''), `ORIGINAL_${index}`)
  }
  let cursor = first.nextCursor, restored = first.segments.map(segment => segment.text).join('')
  for (let page = 0; cursor && page < 100; page++) {
    const result = reader.decompress(session, { blockId: blocks[0]!, cursor, maxTokens: 4096 }) as Page
    assert.equal(result.status, 'success'); assert.equal(result.incomplete, false)
    restored += result.segments.map(segment => segment.text).join(''); cursor = result.nextCursor
  }
  assert.equal(cursor, null); assert.deepEqual(Buffer.from(restored), Buffer.from(original))
})
