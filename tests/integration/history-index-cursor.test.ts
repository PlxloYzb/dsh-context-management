import test from 'node:test'
import assert from 'node:assert/strict'
import { ArchiveReader } from '../../src/archive.ts'
import { runCompactionTransaction } from '../../src/region.ts'
import { host, newSession } from './runtime.ts'
import { appendUser } from '../helpers.ts'

/**
 * Section 8 of the contract requires a cursor to survive the index changing
 * underneath it. The cursor is not bound to the cache generation, so these three
 * cases - a build still in progress, an evicted index, and a rebuilt index - must
 * all resume correctly. The cache is an accelerator; its state may never leak
 * into what a cursor means.
 */
type Host = Awaited<ReturnType<typeof host>>
type Session = ReturnType<typeof newSession>
type Page = { status: string; code?: string; hits: { seq: number }[]; nextCursor: string | null; scanBudgetReached: boolean; absent?: boolean }

function archive(h: Host, session: Session, body: string, model: string) {
  appendUser(session, body)
  const source = session.surface.nodes[session.surface.nodes.length - 1]!
  appendUser(session, 'Protected current input')
  runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Original archived' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
    provider: 'fixture', model,
  })
}

/**
 * Three separately archived originals whose combined text exceeds one work
 * budget, with the target in the last one. The first page therefore stops at the
 * budget while the index is still incomplete, which is exactly the state the
 * cursor has to survive.
 */
function build(h: Host, name: string) {
  const session = newSession(h.ctx, name)
  session.append('turn/start', { turn: 1 })
  archive(h, session, `${'a'.repeat(400_000)}`, `${name}-1`)
  archive(h, session, `${'b'.repeat(400_000)}`, `${name}-2`)
  archive(h, session, `${'c'.repeat(400_000)}\nCURSOR_GENERATION_MARKER = "late"`, `${name}-3`)
  return session
}

const query = 'CURSOR_GENERATION_MARKER'

test('G1: a cursor resumes while the index is still being built', async t => {
  const h = await host(); t.after(h.close)
  const session = build(h, 'experiment-cursor-building')
  const reader = new ArchiveReader()
  const first = reader.search(session, { query, limit: 5 }, 1100) as Page
  assert.equal(first.status, 'success'); assert.deepEqual(first.hits, [])
  assert.equal(first.scanBudgetReached, true); assert.ok(first.nextCursor)
  const partial = reader.indexState(session)!
  assert.ok(partial.events > 0, 'indexing started before the page ended')
  assert.equal(partial.lastExaminedEvents > partial.events, true, 'the index was left incomplete')
  const resumed = reader.search(session, { query, limit: 5, cursor: first.nextCursor! }, 1100) as Page
  assert.equal(resumed.code, undefined)
  assert.equal(resumed.hits.length, 1, 'the resumed page finds the late original')
  assert.ok(reader.indexState(session)!.events > partial.events, 'and indexing made further progress')
})

test('G2: a cursor resumes after its index was evicted', async t => {
  const h = await host(); t.after(h.close)
  const session = build(h, 'experiment-cursor-evicted')
  const reader = new ArchiveReader()
  const first = reader.search(session, { query, limit: 5 }, 1100) as Page
  assert.ok(first.nextCursor)
  const before = reader.indexState(session)!.events
  assert.ok(before > 0)
  // Push the session's index out of the retention window.
  for (let index = 0; index < 65; index++) {
    const other = newSession(h.ctx, `experiment-cursor-pressure-${index}`)
    other.append('turn/start', { turn: 1 })
    archive(h, other, `${'p'.repeat(120)}\nPRESSURE_MARKER = "x"`, `pressure-${index}`)
    reader.search(other, { query: 'PRESSURE_MARKER', limit: 5 }, 1100)
  }
  assert.equal(reader.indexState(session)!.events, 0, 'the index really was evicted')
  const resumed = reader.search(session, { query, limit: 5, cursor: first.nextCursor! }, 1100) as Page
  assert.equal(resumed.code, undefined, 'eviction must not invalidate the cursor')
  assert.equal(resumed.hits.length, 1)
})

test('G3: a cursor resumes after its index was disposed and rebuilt', async t => {
  const h = await host(); t.after(h.close)
  const session = build(h, 'experiment-cursor-rebuilt')
  const reader = new ArchiveReader()
  const first = reader.search(session, { query, limit: 5 }, 1100) as Page
  assert.ok(first.nextCursor)
  reader.disposeIndex(session)
  // A different query rebuilds the index from scratch before the cursor resumes.
  reader.search(session, { query: 'CURSOR_GENERATION', limit: 5 }, 1100)
  assert.ok(reader.indexState(session)!.events > 0, 'the index was rebuilt by another query')
  const resumed = reader.search(session, { query, limit: 5, cursor: first.nextCursor! }, 1100) as Page
  assert.equal(resumed.code, undefined, 'the cursor is not bound to the cache generation')
  assert.equal(resumed.hits.length, 1)
})
