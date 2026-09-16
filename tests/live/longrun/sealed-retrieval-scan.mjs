// Offline retrieval measurement over a sealed run: how far does a single
// un-cursored search reach, and how many cursor pages does a full walk need?
//
// Runs against the session the host's own persistence layer loaded, so no model
// call and no replay reconstruction are involved.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ArchiveReader } from '../../../src/archive.ts'

const base = resolve(process.argv[2] ?? join('.test-runtime', 'longrun-20260915', 'lr3m-r1', 'main-91601', 'BASIC_MATCHED'))
// Discover the generated run id directory, or skip when the evidence is absent.
const run = existsSync(join(base, 'fixture.json'))
  ? base
  : (existsSync(base) ? readdirSync(base).map(entry => join(base, entry)).find(candidate => existsSync(join(candidate, 'fixture.json'))) ?? base : base)
if (!existsSync(join(run, 'fixture.json'))) {
  console.log(JSON.stringify({ status: 'SKIPPED', reason: 'sealed long-run evidence not present', run }))
  process.exit(0)
}
const ctx = new Context()
new SessionStore(ctx)
new SessionProjectionRegistry(ctx)
new TokenMeter(ctx)
const persistence = new JsonlSessionPersistence(ctx, { root: join(run, 'home', 'sessions'), compression: 'zstd', writeBatchMaxDelayMs: 10 })
const listed = await persistence.list()
const id = listed[0].id
const inspected = await persistence.inspect(id)
const session = ctx.sessions.create(SessionId('sealed-scan'), { seed: inspected.events })
const events = session.snapshotEvents()
const summaries = events.filter(e => e.type === 'compaction/summary').length

const fixture = JSON.parse(readFileSync(join(run, 'fixture.json'), 'utf8'))
const pages = fixture.pages
// One literal from each page, spread across the whole archive, each verified to
// occur in exactly the page it came from.
// Only pages this run actually exposed exist in the archive; probing beyond the
// read range would measure nothing and misreport it as a retrieval failure.
const progress = JSON.parse(readFileSync(join(run, 'progress.json'), 'utf8'))
const PAGES_PER_EPISODE = 12
const exposed = progress.coverage?.exposedPageEnd
  ?? progress.coverage?.assignedPageEnd
  ?? (progress.episode ? progress.episode * PAGES_PER_EPISODE : pages.length)
const probePages = []
for (let i = 0; i < 12; i++) probePages.push(1 + Math.floor(i * (exposed - 1) / 11))
const probes = []
for (const page of probePages) {
  const text = pages[page - 1]
  const match = /checksum=([0-9a-f]{10})/.exec(text)
  if (!match) continue
  const occurrences = pages.filter(p => p.includes(match[0])).length
  if (occurrences !== 1) continue
  probes.push({ page, literal: match[0], quartile: Math.min(3, Math.floor((page - 1) * 4 / pages.length)) })
}

const reader = new ArchiveReader()
const rows = []
for (const probe of probes) {
  // Single un-cursored search, exactly what the model gets by default.
  const single = reader.search(session, { query: probe.literal, limit: 5 }, 8000)
  // Full walk along nextCursor until the archive is exhausted.
  let cursor, pagesWalked = 0, hits = 0, absent = null
  for (let i = 0; i < 40; i++) {
    const step = reader.search(session, { query: probe.literal, limit: 5, ...(cursor === undefined ? {} : { cursor }) }, 8000)
    pagesWalked += 1
    hits += step.hits?.length ?? 0
    if (step.absent === true) absent = true
    if (step.nextCursor === null || step.nextCursor === undefined) break
    cursor = step.nextCursor
  }
  rows.push({
    page: probe.page, quartile: probe.quartile, literal: probe.literal,
    singleShotHits: single.hits?.length ?? 0,
    singleShotScanCapped: single.scanBudgetReached === true,
    walkHits: hits, walkPages: pagesWalked, walkAbsent: absent,
  })
}
await rm(await mkdtemp(join(tmpdir(), 'unused-')), { recursive: true, force: true })
console.log(JSON.stringify({
  run, sessionId: id, events: events.length, summaries, exposedPages: exposed,
  ledgerBlocks: events.filter(e => e.user?.message).length,
  probed: rows.length,
  singleShotFound: rows.filter(r => r.singleShotHits > 0).length,
  singleShotCapped: rows.filter(r => r.singleShotScanCapped).length,
  walkFound: rows.filter(r => r.walkHits > 0).length,
  walkPagesMedian: rows.map(r => r.walkPages).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  rows,
}, null, 2))
await ctx.fiber.dispose()
void readdirSync; void readFile
