// Did any retained empty/absent search target text that exists only in a
// compaction summary? Decides whether summary indexing is a real gap or just a
// misleading tool description.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { ArchiveReader } from '../../src/archive.ts'
import { observedEvents } from './local/observed-events.mjs'

const night = resolve('.test-runtime/nightly-20260915')
const dirs = (await readdir(night, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)
let emptySearches = 0, inSummaryOnly = 0, inSummaryAtAll = 0, scannedSummaries = 0
const examples = []
for (const dir of dirs) {
  let meta
  try { meta = JSON.parse(await readFile(join(night, dir, 'summary.json'), 'utf8')) } catch { continue }
  if (!meta.sessionId) continue
  let events
  try { events = await observedEvents(join(night, dir, 'observed'), meta.sessionId) } catch { continue }
  const session = Session.create(`${dir}-summary-gap`, events)
  const ledger = new ArchiveReader().ledger(session)
  const summaries = ledger.map(entry => entry.summary)
  scannedSummaries += summaries.length
  const calls = new Map(), pending = []
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, event.data)
    else if (event.type === 'tool/result') {
      for (const part of event.data?.message?.content ?? []) {
        if (part?.type !== 'tool-result') continue
        const call = calls.get(part.toolCallId)
        if (call?.name === 'search_context') pending.push({ call, text: (part.content ?? []).filter(i => i?.type === 'text').map(i => i.text).join('') })
      }
    }
  }
  for (const { call, text } of pending) {
    let args, page
    try { args = JSON.parse(call.arguments); page = JSON.parse(text) } catch { continue }
    if (!Array.isArray(page.hits) || page.hits.length > 0) continue
    emptySearches += 1
    const needle = String(args.query).toLowerCase()
    const hit = summaries.some(summary => summary.toLowerCase().includes(needle))
    if (hit) {
      inSummaryAtAll += 1
      if (examples.length < 8) examples.push({ run: dir, query: args.query, absent: page.absent ?? false })
    }
  }
}
const report = {
  schemaVersion: 1, kind: 'offline-summary-index-gap',
  scannedSummaries, emptySearches, emptySearchesMatchingAnySummary: inSummaryAtAll, inSummaryOnly,
  examples,
  note: 'A query that matches a compaction summary but no archived original is not searchable by design (DESIGN: summaries are lossy, originals are the recoverable archive) but the search_context tool description currently claims summaries are searched.',
}
await writeFile(join(night, 'summary-index-gap.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify(report))
