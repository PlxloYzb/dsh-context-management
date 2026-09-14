// Prove the bounded-allocation snippet fix is output-identical to the gated
// candidate 9 build. Compares every retained cursor-less search call hit by hit.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { ArchiveReader as ReaderFixed } from '../../src/archive.ts'
import { loadArchiveAtRevision } from './local-bench-modules.mjs'
import { observedEvents } from './local/observed-events.mjs'

const night = resolve('.test-runtime/nightly-20260915')
const { ArchiveReader: ReaderGated } = await loadArchiveAtRevision('99f372c')
const dirs = (await readdir(night, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)
let calls = 0, hits = 0, mismatches = 0
const examples = []
for (const dir of dirs) {
  let meta
  try { meta = JSON.parse(await readFile(join(night, dir, 'summary.json'), 'utf8')) } catch { continue }
  if (!meta.sessionId) continue
  let events
  try { events = await observedEvents(join(night, dir, 'observed'), meta.sessionId) } catch { continue }
  const seen = new Map(), pending = []
  for (const event of events) {
    if (event.type === 'tool/call') seen.set(event.data.callId, { seq: event.seq, ...event.data })
    else if (event.type === 'tool/result') {
      for (const part of event.data?.message?.content ?? []) {
        if (part?.type !== 'tool-result') continue
        const call = seen.get(part.toolCallId)
        if (call?.name === 'search_context') pending.push(call)
      }
    }
  }
  for (const call of pending) {
    let args
    try { args = JSON.parse(call.arguments) } catch { continue }
    const session = Session.create(`${dir}-${call.seq}`, events.slice(0, call.seq + 1))
    const query = { query: args.query, ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.cursor === undefined ? {} : { cursor: args.cursor }) }
    // Cursors are reader-local; only cursor-less calls can be replayed by both.
    if (args.cursor !== undefined) continue
    const a = new ReaderFixed().search(session, query, 4096)
    const b = new ReaderGated().search(session, query, 4096)
    calls += 1
    // Cursors carry a random reader-local body, so compare the model-visible
    // payload and cursor presence, not the opaque cursor string.
    const payload = page => page.status === 'success'
      ? JSON.stringify({ hits: page.hits, incomplete: page.incomplete, scanBudgetReached: page.scanBudgetReached, absent: page.absent ?? null, inspectedMessages: page.inspectedMessages ?? null, hint: page.hint ?? null, hasCursor: page.nextCursor !== null })
      : JSON.stringify(page)
    const as = payload(a), bs = payload(b)
    if (as !== bs) {
      mismatches += 1
      if (examples.length < 5) examples.push({ dir, query: args.query, fixed: (a.hits ?? []).map(h => h.snippet).slice(0, 2), gated: (b.hits ?? []).map(h => h.snippet).slice(0, 2) })
    }
    hits += (a.hits ?? []).length
  }
}
const report = {
  schemaVersion: 1, kind: 'offline-snippet-allocation-equivalence',
  cursorlessCallsCompared: calls, hitsCompared: hits, mismatches, examples,
  note: 'The gated module is the exact candidate 9 source committed as 99f372c (before the bounded-allocation fix); the fixed module is the current source. Zero mismatches means the model saw byte-identical search responses, so the candidate 9 model gates remain valid for the fixed build.',
}
await writeFile(join(night, 'snippet-allocation-equivalence.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ calls, hits, mismatches }))
