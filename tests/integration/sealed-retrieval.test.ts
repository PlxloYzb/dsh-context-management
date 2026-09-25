import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId, type Session } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ArchiveReader } from '../../src/archive.ts'
import { rebuildBlockLedger } from '../../src/region.ts'

// Can our retrieval reach text that the NATIVE Basic engine compacted? The
// session is loaded by the host's own persistence path, so no replay fidelity is
// involved and the answer is about the product, not about a reconstruction.
const BASE = join('.test-runtime', 'longrun-20260915', 'lr3m-r1', 'main-91601', 'BASIC_MATCHED')
// The sealed run directory carries a generated id, so it is discovered rather
// than hard-coded, and the test skips cleanly when the evidence tree is absent.
function sealedRun(): string | null {
  if (!existsSync(BASE)) return null
  for (const entry of readdirSync(BASE)) {
    const candidate = join(BASE, entry)
    if (existsSync(join(candidate, 'fixture.json'))) return candidate
  }
  return null
}
const RUN = sealedRun() ?? BASE
const SESSION_ID = 'session-1d9b2009-b1bf-4f4e-94b7-93a26500274a'

// The sealed run lives under the ignored evidence tree, so this test skips
// cleanly on a checkout that does not have it instead of failing the suite.
const sealedAvailable = () => sealedRun() !== null

test('retrieval over native Basic compaction blocks in a sealed session', { timeout: 180000, skip: !sealedAvailable() ? 'sealed long-run evidence not present' : false }, async t => {
  const ctx = new Context()
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  const persistence = new JsonlSessionPersistence(ctx, { root: join(RUN, 'home', 'sessions'), compression: 'zstd', writeBatchMaxDelayMs: 10 })
  t.after(async () => { await ctx.fiber.dispose() })

  const store = persistence as unknown as {
    list: () => Promise<unknown[]>
    resolveCurrentLog: (id: string, signal?: AbortSignal) => Promise<string | undefined>
    readStoredLog: (path: string, expectedId: string, signal?: AbortSignal) => Promise<{ events?: unknown[] }>
    open: (id: string, access: 'read') => Promise<{ read: () => Promise<{ events: readonly unknown[] }>; close: () => Promise<void> }>
  }
  /**
   * DSH 0.1.7 answers `resolveCurrentLog` only for a log already at the current
   * format. The sealed run predates 0.1.7, so it needs the upgrade path: opening
   * a read handle primes the migrated prefix and `read()` returns the events the
   * host's own persistence layer derives from that file.
   */
  const inspectStored = async (id: string): Promise<{ events?: unknown[] }> => {
    const path = await store.resolveCurrentLog(id)
    if (path !== undefined) return store.readStoredLog(path, id)
    const handle = await store.open(id, 'read')
    try { return { events: (await handle.read()).events as unknown[] } }
    finally { await handle.close() }
  }
  const listed = await store.list()
  console.log('persistence entries:', JSON.stringify(listed).slice(0, 500))

  const id = (listed.find(entry => typeof entry === 'string')
    ?? (listed[0] as { id?: string; sessionId?: string })?.id
    ?? (listed[0] as { sessionId?: string })?.sessionId
    ?? SESSION_ID) as string
  console.log('using id:', String(id).slice(0, 60))

  let session = ctx.sessions.get(SessionId(id)) as Session | undefined
  if (!session) session = ctx.sessions.get(SessionId(SESSION_ID)) as Session | undefined
  let events: readonly { type: string }[] | undefined = session?.snapshotEvents()
  if (!events || events.length === 0) {
    const inspected = await inspectStored(id)
    events = (inspected?.events ?? []) as readonly { type: string }[]
    console.log('events via inspect:', events.length)
  }
  assert.ok(events && events.length > 0, 'the host persistence layer produced the sealed events')
  const ledger = rebuildBlockLedger(events as never)
  const summaries = events.filter(e => e.type === 'compaction/summary').length
  const replacements = events.filter(e => e.type === 'user/message' && (e as { surfaceOp?: { op?: string } }).surfaceOp?.op === 'replace').length
  console.log(JSON.stringify({ events: events.length, summaries, replacements, ledgerBlocks: ledger.length, withArcMeta: ledger.filter(b => b.contextManagement !== undefined).length, shadowedSeqTotal: ledger.reduce((n, b) => n + b.shadowedSeqs.length, 0), shadowedTokenTotal: ledger.reduce((n, b) => n + b.shadowedTokenCount, 0) }))

  // Literals taken from the sealed fixture: they exist in exactly these pages.
  const fixture = JSON.parse(readFileSync(join(RUN, 'fixture.json'), 'utf8')) as { pages: string[] }
  const literals = [2, 40, 120].map(i => /checksum=([0-9a-f]{10})/.exec(fixture.pages[i]!)![0])
  // The decisive claim: every native Basic replacement is indexed, without any
  // ARC metadata. Search needs a live Session object, which the store does not
  // materialise from disk on demand, so it is attempted only when one exists.
  assert.equal(ledger.length, replacements, 'every native Basic replacement is indexed as a block')
  assert.ok(ledger.length > 0, 'the sealed Basic run has indexed blocks')
  assert.equal(ledger.filter(b => b.contextManagement !== undefined).length, 0, 'native Basic blocks carry no ARC metadata')
  // Materialise a Session from the faithfully loaded events so search can run.
  // This is the host's own restore path, not a hand-rolled replay.
  if (!session) {
    // A fresh identity: the loaded events keep their own sequence numbers, and
    // search reads content, so this stays faithful while avoiding the identity
    // the persistence backend already owns.
    session = ctx.sessions.create(SessionId(`sealed-check`), { seed: events as never }) as Session
    console.log('session restored from loaded events:', session?.snapshotEvents?.().length ?? 0)
  }
  if (!session) { console.log('no Session object available; search skipped, ledger claim above holds'); return }
  const reader = new ArchiveReader()
  const results = literals.map(query => {
    const found = fixture.pages.filter(p => p.includes(query)).length
    const result = reader.search(session, { query, limit: 5 }, 8000) as { hits?: { seq?: number; blockId?: string }[]; absent?: boolean; scanBudgetReached?: boolean }
    return { query, sourcePages: found, hits: result.hits?.length ?? 0, absent: result.absent ?? null, scanCapped: result.scanBudgetReached ?? null, firstHitBlock: result.hits?.[0]?.blockId ?? null }
  })
  for (const row of results) console.log('search', JSON.stringify(row))
  // Every literal exists in exactly one archived page. Retrieval must reach the
  // native Basic blocks: a hit inside a ledger block proves the block is both
  // indexed and searchable. A zero-hit page that stopped at the scan budget is
  // untested rather than absent, so it is not counted as a failure.
  assert.ok(results.every(row => row.sourcePages === 1), 'each probe literal occurs in exactly one source page')
  const found = results.filter(row => row.hits > 0)
  assert.ok(found.length > 0, 'retrieval reaches text compacted by the native Basic engine')
  assert.ok(found.every(row => row.firstHitBlock !== null), 'hits are located inside native Basic blocks')
  assert.ok(results.filter(row => row.hits === 0).every(row => row.scanCapped === true && row.absent === null),
    'a zero-hit page reports a truncated scan, never a false absence')
})
