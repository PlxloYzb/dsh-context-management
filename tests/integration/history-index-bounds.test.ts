import test from 'node:test'
import assert from 'node:assert/strict'
import { ArchiveReader } from '../../src/archive.ts'
import { runCompactionTransaction } from '../../src/region.ts'
import { host, newSession } from './runtime.ts'
import { appendUser } from '../helpers.ts'

/**
 * Storage bounds for the history index (docs/DESIGN-HISTORY-INDEX.*, section 7).
 *
 * INDEX_ENTRY_BUDGET caps stored grams and INDEX_EVENT_LIMIT caps indexed
 * containers. Both are memory-safety bounds whose only purpose is to hold when a
 * session grows past what the process can afford, so the property that matters
 * is not "the numbers are right" but "the caps actually stop indexing". These
 * cases lower the bounds through the constructor options and watch the index
 * stop growing, while checking the answers stay identical.
 *
 * The options default to the module constants, so production geometry is
 * untouched by anything here.
 */
type Host = Awaited<ReturnType<typeof host>>
type Session = ReturnType<typeof newSession>
type Page = { status: string; hits: { seq: number }[]; nextCursor: string | null; absent?: boolean }
type State = NonNullable<ReturnType<ArchiveReader['indexState']>>

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

/** Ten archived sources, each carrying its own unique needle. */
function seed(h: Host, session: Session, count = 10) {
  for (let i = 0; i < count; i += 1) archive(h, session, `needle-${i} alpha payload body ${i}`, `m${i}`)
}

function indexed(session: Session, reader: ArchiveReader, query: string): { page: Page; state: State } {
  const page = reader.search(session, { query, limit: 5 }, 4096) as Page
  return { page, state: reader.indexState(session)! }
}

test('B6: lowering the container cap stops indexing at the cap', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-index-bound-containers')
  seed(h, session)

  const reader = new ArchiveReader(undefined, { eventLimit: 2 })
  const { state } = indexed(session, reader, 'needle-7')
  assert.equal(state.lastIndexedEvents, 2, `indexed beyond the cap: ${state.lastIndexedEvents}`)
  assert.equal(state.events, 2, 'the index must hold no more containers than the cap')
})

test('B7: a capped index still answers identically to an uncapped one', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-index-bound-equivalence')
  seed(h, session)

  const capped = new ArchiveReader(undefined, { eventLimit: 1 })
  const uncapped = new ArchiveReader(undefined, { eventLimit: 10_000 })
  for (let i = 0; i < 10; i += 1) {
    const a = indexed(session, capped, `needle-${i}`)
    const b = indexed(session, uncapped, `needle-${i}`)
    assert.deepEqual(a.page.hits.map(x => x.seq), b.page.hits.map(x => x.seq),
      `capping the index changed the answer for needle-${i}`)
    assert.equal(a.page.nextCursor, b.page.nextCursor, `capping changed the cursor for needle-${i}`)
  }
})

test('B8: the entry budget stops gram storage, and the defaults keep indexing', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'experiment-index-bound-entries')
  seed(h, session)

  // The budget is checked before a container is stored, so the first one is
  // always admitted; what the guard promises is that growth stops there rather
  // than running through the session. Ten sources would otherwise index as ten
  // containers, so a budget of zero holding at one is the bound doing its job.
  const tiny = new ArchiveReader(undefined, { entryBudget: 0 })
  const { page, state } = indexed(session, tiny, 'needle-3')
  assert.equal(state.events, 1, `entry budget 0 stored ${state.events} containers, expected the first only`)
  assert.equal(page.hits.length, 1, 'and must still find the answer by scanning')

  // The overrides are opt-in: a default reader indexes normally.
  const dflt = new ArchiveReader()
  const normal = indexed(session, dflt, 'needle-3')
  assert.ok(normal.state.entries > 0, 'the default reader must still store grams')
})
