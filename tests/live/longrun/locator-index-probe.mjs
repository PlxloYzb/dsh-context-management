// Locator-index prototype, built from the same source the ledger trusts: each
// block's shadowedSeqs, read through the session's own event text extractor.
// Offline, no model call. Measures what a lookup costs against what the current
// linear scan costs.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ArchiveReader } from '../../../src/archive.ts'
import { extractEventText } from '../../../src/messages.ts'

const run = resolve(process.argv[2])
const ctx = new Context()
new SessionStore(ctx); new SessionProjectionRegistry(ctx); new TokenMeter(ctx)
const persistence = new JsonlSessionPersistence(ctx, { root: join(run, 'home', 'sessions'), compression: 'zstd', writeBatchMaxDelayMs: 10 })
const id = (await persistence.list())[0].id
const session = ctx.sessions.create(SessionId('locator'), { seed: (await persistence.inspect(id)).events })
const reader = new ArchiveReader()
const ledger = reader.ledger(session)

// Build: one pass over every shadowed sequence, indexed by block.
const startedAt = Date.now()
const index = new Map()
const blockChars = new Map()
let indexedChars = 0
for (const block of ledger) {
  let chars = 0
  for (const seq of block.shadowedSeqs) {
    const event = session.eventAt(seq)
    if (!event) continue
    const text = extractEventText(event) ?? ''
    chars += text.length
    for (const match of text.matchAll(/checksum=[0-9a-f]{10}/g)) {
      if (!index.has(match[0])) index.set(match[0], new Set())
      index.get(match[0]).add(block.blockId)
    }
  }
  blockChars.set(block.blockId, chars)
  indexedChars += chars
}
const buildMs = Date.now() - startedAt

const pages = JSON.parse(readFileSync(join(run, 'fixture.json'), 'utf8')).pages
const exposed = 288
const probes = []
for (let i = 0; i < 12; i++) {
  const page = 1 + Math.floor(i * (exposed - 1) / 11)
  const match = /checksum=([0-9a-f]{10})/.exec(pages[page - 1])
  if (match && pages.filter(p => p.includes(match[0])).length === 1) probes.push({ page, literal: match[0] })
}

const rows = []
for (const probe of probes) {
  const blocks = index.get(probe.literal)
  const indexChars = blocks ? [...blocks].reduce((n, b) => n + (blockChars.get(b) ?? 0), 0) : 0
  let cursor, hits = 0, pagesWalked = 0
  for (let i = 0; i < 40; i++) {
    const step = reader.search(session, { query: probe.literal, limit: 5, ...(cursor === undefined ? {} : { cursor }) }, 8000)
    pagesWalked += 1; hits += step.hits?.length ?? 0
    if (!step.nextCursor) break
    cursor = step.nextCursor
  }
  rows.push({ page: probe.page, indexedBlocks: blocks ? blocks.size : 0, indexChars, scanHits: hits, scanPages: pagesWalked })
}
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? null
console.log(JSON.stringify({
  ledgerBlocks: ledger.length,
  shadowedSeqTotal: ledger.reduce((n, b) => n + b.shadowedSeqs.length, 0),
  indexedChars,
  buildMs,
  distinctLiteralsIndexed: index.size,
  probes: rows.length,
  indexFound: rows.filter(r => r.indexedBlocks > 0).length,
  scanFound: rows.filter(r => r.scanHits > 0).length,
  medianLookupChars: median(rows.filter(r => r.indexedBlocks > 0).map(r => r.indexChars)),
  medianBlockChars: median([...blockChars.values()]),
  rows,
}, null, 1))
await ctx.fiber.dispose()
