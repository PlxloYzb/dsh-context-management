import test from 'node:test'
import assert from 'node:assert/strict'
import { ArchiveReader } from '../../src/archive.ts'
import { runCompactionTransaction } from '../../src/region.ts'
import { host, newSession } from './runtime.ts'
import { appendUser } from '../helpers.ts'

/**
 * Resource boundaries of the history index (docs/DESIGN-HISTORY-INDEX.* §9, §10).
 *
 * Two claims are pinned here, both behaviourally through the public surface:
 * events that yield no 3-gram must not accumulate index containers, and an
 * original that is only reachable through a parent archive must stay
 * retrievable. Neither test reaches into a private function.
 */
type Host = Awaited<ReturnType<typeof host>>
type Session = ReturnType<typeof newSession>
type Page = { status: string; hits: { seq: number; textBlockPath: number[]; offset: number }[]; nextCursor: string | null; absent?: boolean }

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

test('M1: events that yield no 3-gram allocate no index containers and exclude nothing', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-index-gramless')
  session.append('turn/start', { turn: 1 })
  // Empty text, one and two code points: gramHashes needs three, so none of
  // these produce a gram and none may occupy a container. Before the fix each
  // one stored an empty Set while adding nothing to `entries`, so the entry
  // budget never tripped and the container count grew with session length.
  const texts = ['', 'a', 'ab', '', 'z', 'qq', '', 'x y', 'ab', '']
  for (let index = 0; index < texts.length; index++) archive(h, session, texts[index]!, `gramless-${index}`)
  const target = archive(h, session, `REAL_MARKER = "present" ${'k'.repeat(40)}`, 'gramless-target')
  const reader = new ArchiveReader()
  const hits = exhaust(reader, session, 'REAL_MARKER')
  assert.equal(hits.length, 1, 'a gram-less archive entry never hides a real literal')
  assert.equal(hits[0]!.seq, target)
  const state = reader.indexState(session)!
  // Exactly the events long enough to produce a gram hold a container: the
  // three-code-point 'x y' and the target. Every shorter one must have been
  // skipped rather than stored empty.
  const gramBearing = texts.filter(text => [...text].length >= 3).length + 1
  assert.equal(gramBearing, 2, 'the fixture has one gram-bearing filler plus the target')
  assert.equal(state.events, gramBearing, 'containers exist only for events that produced grams')
  assert.ok(state.entries > 0 && state.entries < 100, 'and the entries come from those events')
})

test('M2: an original reachable only through a parent archive stays retrievable', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-index-nested-premise')
  session.append('turn/start', { turn: 1 })
  const original = archive(h, session, `NESTED_ORIGINAL = "value" ${'n'.repeat(20_000)}`, 'nested-tier1')
  // Distil the tier-1 block, so the original is no longer any block's direct
  // shadowed seq and is reachable only by expanding a parent.
  const tier1 = session.surface.nodes[session.surface.nodes.length - 1]!
  appendUser(session, 'tail input')
  runCompactionTransaction(session, {
    start: tier1, end: tier1, shadowedSeqs: [tier1], summary: [{ type: 'text', text: 'Tier two distils the tier-one block' }],
    shadowedTokenCount: h.ctx.tokenMeter.measure(session).nodes.find(node => node.seq === tier1)!.heuristicTokens,
    provider: 'fixture', model: 'nested-tier2',
  })
  const indexed = exhaust(new ArchiveReader(), session, 'NESTED_ORIGINAL')
  assert.equal(indexed.length, 1, 'the nested original is still found through the parent')
  assert.equal(indexed[0]!.seq, original)
  const scanOnly = new ArchiveReader()
  ;(scanOnly as unknown as { seqMayContain: () => boolean }).seqMayContain = () => true
  assert.deepEqual(indexed, exhaust(scanOnly, session, 'NESTED_ORIGINAL'), 'and the index agrees with the scan')
})
