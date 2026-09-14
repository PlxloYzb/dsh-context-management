// Offline friction sweep over retained runs: repeated queries, cursor pages that
// add nothing, and role of arc_status block listing. No provider calls.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { observedEvents } from './local/observed-events.mjs'

const night = resolve('.test-runtime/nightly-20260915')
const output = resolve(process.argv[2] ?? join(night, 'friction-sweep.json'))
const dirs = (await readdir(night, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)
const summary = { schemaVersion: 1, kind: 'offline-retrieval-friction-sweep', runs: [], totals: {} }
let searches = 0, cursorSearches = 0, cursorEmptyAdds = 0, duplicateQueries = 0, zeroHitPages = 0, deniedOrError = 0
for (const dir of dirs) {
  let meta
  try { meta = JSON.parse(await readFile(join(night, dir, 'summary.json'), 'utf8')) } catch { continue }
  if (!meta.sessionId) continue
  let events
  try { events = await observedEvents(join(night, dir, 'observed'), meta.sessionId) } catch { continue }
  const calls = new Map(), rows = []
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, { seq: event.seq, ...event.data })
    else if (event.type === 'tool/result') {
      for (const part of event.data?.message?.content ?? []) {
        if (part?.type !== 'tool-result') continue
        const call = calls.get(part.toolCallId)
        if (!call) continue
        const text = (part.content ?? []).filter(i => i?.type === 'text').map(i => i.text).join('')
        rows.push({ call, text })
      }
    }
  }
  const seen = new Map(), runStats = { searches: 0, cursorSearches: 0, cursorEmptyAdds: 0, duplicateQueries: 0, zeroHitPages: 0, errors: 0 }
  for (const { call, text } of rows) {
    if (call.name !== 'search_context') continue
    let args, page
    try { args = JSON.parse(call.arguments); page = JSON.parse(text) } catch { continue }
    runStats.searches += 1; searches += 1
    if (page.status === 'error') { runStats.errors += 1; deniedOrError += 1; continue }
    const hits = page.hits?.length ?? 0
    if (hits === 0) { runStats.zeroHitPages += 1; zeroHitPages += 1 }
    if (args.cursor !== undefined) {
      runStats.cursorSearches += 1; cursorSearches += 1
      if (hits === 0) { runStats.cursorEmptyAdds += 1; cursorEmptyAdds += 1 }
    }
    const key = `${args.query}|${args.limit ?? 5}`
    if (seen.has(key)) { runStats.duplicateQueries += 1; duplicateQueries += 1 }
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  if (runStats.searches) summary.runs.push({ run: dir, ...runStats })
}
summary.totals = { searches, cursorSearches, cursorEmptyAdds, duplicateQueries, zeroHitPages, deniedOrError }
await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify(summary.totals))
console.log(JSON.stringify(summary.runs.filter(r => r.duplicateQueries || r.cursorEmptyAdds).slice(0, 12)))
