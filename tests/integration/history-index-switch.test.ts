import test from 'node:test'
import assert from 'node:assert/strict'
import { ArchiveReader } from '../../src/archive.ts'
import { runCompactionTransaction } from '../../src/region.ts'
import { host, newSession } from './runtime.ts'
import { appendUser } from '../helpers.ts'

/**
 * The rollback switch (docs/DESIGN-HISTORY-INDEX.*, section 13). Turning the
 * index off must reproduce the scan path exactly and must be observable, so
 * that a fallback can never be mistaken for normal operation.
 */
type Host = Awaited<ReturnType<typeof host>>
type Session = ReturnType<typeof newSession>
type Page = { status: string; hits: { seq: number; textBlockPath: number[]; offset: number }[]; nextCursor: string | null }

function exhaust(reader: ArchiveReader, session: Session, query: string) {
  const out: { seq: number; path: number[]; offset: number }[] = []
  let cursor: string | undefined
  for (let page = 0; page < 40; page++) {
    const result = reader.search(session, cursor === undefined ? { query, limit: 20 } : { query, limit: 20, cursor }, 4096) as Page
    assert.equal(result.status, 'success')
    for (const hit of result.hits) out.push({ seq: hit.seq, path: hit.textBlockPath, offset: hit.offset })
    if (result.nextCursor === null) return out
    cursor = result.nextCursor
  }
  throw new Error('pagination did not terminate')
}

test('S1: the rollback switch defaults on, can be turned off, and is observable', async t => {
  const h = await host(); t.after(h.close)
  assert.equal(new ArchiveReader().indexEnabled, true, 'indexing is on by default')
  assert.equal(new ArchiveReader(undefined, {}).indexEnabled, true)
  assert.equal(new ArchiveReader(undefined, { index: true }).indexEnabled, true)
  assert.equal(new ArchiveReader(undefined, { index: false }).indexEnabled, false, 'the switch is readable')
})

test('S2: with the index off every hit matches the indexed path exactly', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-switch-equivalence')
  session.append('turn/start', { turn: 1 })
  appendUser(session, `SWITCH_MARKER = "value"\n${'s'.repeat(60_000)}\nSWITCH_MARKER again`)
  const source = session.surface.nodes[0]!
  appendUser(session, 'Protected current input')
  runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Original archived' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
    provider: 'fixture', model: 'switch-equivalence',
  })
  for (const query of ['SWITCH_MARKER', 'value', 'SWITCH_MARKER again']) {
    const indexed = exhaust(new ArchiveReader(), session, query)
    const plain = exhaust(new ArchiveReader(undefined, { index: false }), session, query)
    assert.deepEqual(plain, indexed, `the fallback must reproduce the indexed path for ${JSON.stringify(query)}`)
    if (query !== 'value') assert.ok(indexed.length >= 1, `${query} is present in the original`)
  }
})

test('S3: a disabled reader indexes nothing at all', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-switch-inert')
  session.append('turn/start', { turn: 1 })
  appendUser(session, `INERT_MARKER = "value"\n${'t'.repeat(40_000)}`)
  const source = session.surface.nodes[0]!
  appendUser(session, 'Protected current input')
  runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Original archived' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === source)!.heuristicTokens,
    provider: 'fixture', model: 'switch-inert',
  })
  const reader = new ArchiveReader(undefined, { index: false })
  const page = reader.search(session, { query: 'INERT_MARKER', limit: 5 }, 4096) as Page
  assert.equal(page.hits.length, 1, 'the fallback still answers')
  assert.equal(reader.indexState(session), null, 'a disabled reader builds no index')
})
