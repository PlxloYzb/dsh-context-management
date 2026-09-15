// For the retained searches that gained hits from checkpoint indexing, decide
// whether the matching checkpoint is currently visible on the surface (so the
// model already sees it) or genuinely archived.
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { ArchiveReader } from '../../src/archive.ts'
import { observedEvents } from './local/observed-events.mjs'

const night = resolve('.test-runtime/nightly-20260915')
const targets = [
  ['b-f3-91503-24p-candidate6', 'INC-48d574ec'],
  ['b-f3-91503-24p-in-place', 'F07 = '],
  ['legacy-v11-f1-432p', 'PAGE-23'],
  ['c-f6-91502-restart-candidate6-fork-r2', 'forbidden'],
]
const rows = []
for (const [dir, query] of targets) {
  const meta = JSON.parse(await readFile(join(night, dir, 'summary.json'), 'utf8'))
  const events = await observedEvents(join(night, dir, 'observed'), meta.sessionId)
  const session = Session.create(`${dir}-visibility`, events)
  const reader = new ArchiveReader()
  const ledger = reader.ledger(session)
  const surfaceSeqs = new Set(session.surface.nodes)
  const page = reader.search(session, { query, limit: 20 }, 4096)
  const hits = page.status === 'success' ? page.hits : []
  const summaryHits = hits.filter(h => h.source === 'summary')
  const byBlock = summaryHits.map(h => {
    const entry = ledger.find(e => e.blockId === h.blockId)
    const visible = h.seq !== undefined && surfaceSeqs.has(h.seq)
    // Is this checkpoint node already reachable as an original of a later block?
    const alsoOriginalOf = ledger.some((e, i) => ledger.indexOf(entry) < i && e.shadowedSeqs.includes(h.seq))
    return { seq: h.seq, visibleOnSurface: visible, alreadyIndexedAsOriginal: alsoOriginalOf, tier: entry?.tier }
  })
  rows.push({ dir, query, totalHits: hits.length, summaryHits: summaryHits.length, byBlock })
}
const report = {
  schemaVersion: 1, kind: 'offline-summary-hit-provenance',
  rows,
  note: 'visibleOnSurface means the model already sees that checkpoint text in context, so indexing it adds redundant hits; alreadyIndexedAsOriginal means the normal source traversal would have found it anyway.',
}
await writeFile(join(night, 'summary-hit-provenance.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify(rows))
