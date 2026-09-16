import test from 'node:test'
import assert from 'node:assert/strict'
import { ArchiveReader } from '../../src/archive.ts'
import { runCompactionTransaction } from '../../src/region.ts'
import { host, newSession } from './runtime.ts'
import { appendUser } from '../helpers.ts'

/**
 * Cache lifecycle and cold/hot accounting for the history index
 * (docs/DESIGN-HISTORY-INDEX.*, sections 7 and 9). The index is a cache, not
 * state: it is session-isolated, bounded, disposable, and every one of those
 * properties must be invisible in the answers a search returns.
 */
type Host = Awaited<ReturnType<typeof host>>
type Session = ReturnType<typeof newSession>
type Page = { status: string; hits: { seq: number }[]; nextCursor: string | null; absent?: boolean }

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

test('C1: a cold query indexes, the identical hot query pays nothing and answers the same', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-index-cold-hot')
  session.append('turn/start', { turn: 1 })
  archive(h, session, `${'w'.repeat(400_000)}\nTEMPERATURE_MARKER = "late"`, 'cold-hot')
  const reader = new ArchiveReader(), query = 'TEMPERATURE_MARKER ='
  const cold = reader.search(session, { query, limit: 5 }, 1100) as Page
  const coldState = reader.indexState(session)
  assert.ok(coldState, 'the first search creates the index')
  assert.ok(coldState.lastColdChars > 0, 'a cold query pays indexing work')
  assert.ok(coldState.lastIndexedEvents > 0)
  assert.ok(coldState.events > 0 && coldState.entries > 0)
  const hot = reader.search(session, { query, limit: 5 }, 1100) as Page
  const hotState = reader.indexState(session)!
  assert.equal(hotState.lastColdChars, 0, 'a hot query does no indexing')
  assert.equal(hotState.lastIndexedEvents, 0)
  // Warm cache must not change the answer.
  assert.deepEqual(hot.hits, cold.hits)
  assert.equal(hot.nextCursor, cold.nextCursor)
  assert.equal(hotState.events, coldState.events, 'the hot query adds no events')
})

test('C2: an evicted index is rebuilt on demand and answers identically', async t => {
  const h = await host(); t.after(h.close)
  const reader = new ArchiveReader(), query = 'EVICTION_MARKER ='
  // One more session than the retention limit, so the first one is evicted.
  let first: { session: Session; baseline: Page } | undefined
  for (let index = 0; index < 65; index++) {
    const session = newSession(h.ctx, `experiment-index-eviction-${index}`)
    session.append('turn/start', { turn: 1 })
    archive(h, session, `${'e'.repeat(200)}\nEVICTION_MARKER = "value-${index}"`, `eviction-${index}`)
    const page = reader.search(session, { query, limit: 5 }, 1100) as Page
    if (index === 0) first = { session, baseline: page }
    assert.equal(reader.indexState(session)!.sessions <= 65, true)
  }
  assert.ok(first)
  const bounded = reader.indexState(first.session)!
  assert.ok(bounded.sessions <= 64, 'retention is bounded')
  assert.equal(bounded.events, 0, 'the least recently used index was evicted')
  // Rebuilding must be invisible in the answer.
  const rebuilt = reader.search(first.session, { query, limit: 5 }, 1100) as Page
  assert.deepEqual(rebuilt.hits, first.baseline.hits, 'an evicted index rebuilds to the same answer')
  assert.ok(reader.indexState(first.session)!.lastColdChars > 0, 'the rebuild is cold work')
})

test('C3: disposal is observable, and a disposed index rebuilds identically', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-index-dispose')
  session.append('turn/start', { turn: 1 })
  archive(h, session, `${'d'.repeat(300_000)}\nDISPOSAL_MARKER = "late"`, 'dispose')
  const reader = new ArchiveReader(), query = 'DISPOSAL_MARKER ='
  const before = reader.search(session, { query, limit: 5 }, 1100) as Page
  assert.equal(reader.disposeIndex(session), true)
  assert.equal(reader.disposeIndex(session), false, 'disposal is not silently repeated')
  const after = reader.search(session, { query, limit: 5 }, 1100) as Page
  assert.deepEqual(after.hits, before.hits)
})

test('C4: indexes are session-isolated, so indexing one session never warms another', async t => {
  const h = await host(); t.after(h.close)
  const reader = new ArchiveReader(), query = 'ISOLATION_MARKER ='
  const warm = newSession(h.ctx, 'experiment-index-isolation-warm')
  warm.append('turn/start', { turn: 1 })
  archive(h, warm, `${'i'.repeat(300_000)}\nISOLATION_MARKER = "warm"`, 'isolation-warm')
  const coldSession = newSession(h.ctx, 'experiment-index-isolation-cold')
  coldSession.append('turn/start', { turn: 1 })
  archive(h, coldSession, `${'j'.repeat(300_000)}\nISOLATION_MARKER = "cold"`, 'isolation-cold')
  assert.equal(reader.indexState(coldSession), null, 'nothing is indexed before a search')
  reader.search(warm, { query, limit: 5 }, 1100)
  assert.ok(reader.indexState(warm)!.events > 0)
  assert.equal(reader.indexState(coldSession), null, 'another session stays untouched')
  const coldPage = reader.search(coldSession, { query, limit: 5 }, 1100) as Page
  assert.ok(reader.indexState(coldSession)!.lastColdChars > 0, 'the second session still pays its own cold cost')
  assert.equal(coldPage.hits.length, 1, 'and still finds its own original')
})

test('C5: a cursor survives an index disposal and resumes correctly', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-index-cursor-rebuild')
  session.append('turn/start', { turn: 1 })
  archive(h, session, `${'k'.repeat(1_100_000)}\nREBUILD_MARKER = "late"`, 'cursor-rebuild')
  const reader = new ArchiveReader(), query = 'REBUILD_MARKER ='
  const first = reader.search(session, { query, limit: 5 }, 1100) as Page
  assert.equal(first.hits.length, 0); assert.ok(first.nextCursor)
  reader.disposeIndex(session)
  const resumed = reader.search(session, { query, limit: 5, cursor: first.nextCursor! }, 1100) as Page
  assert.equal(resumed.status, 'success', 'the cursor is not bound to the index cache generation')
  assert.equal(resumed.hits.length, 1, 'the resumed page still finds the late original')
})
