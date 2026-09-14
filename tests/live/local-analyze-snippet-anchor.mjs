// Offline measure of the line-anchored snippet: how many retained hits were
// mid-line, and what the fixed snippet now shows. No provider calls.
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { ArchiveReader, eventTextParts } from '../../src/archive.ts'
import { observedEvents } from './local/observed-events.mjs'

const night = resolve('.test-runtime/nightly-20260915')
const output = resolve(process.argv[2] ?? join(night, 'snippet-anchor-analysis.json'))
const dirs = (await readdir(night, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)
let hitPages = 0, totalHits = 0, midLineHits = 0, anchoredHits = 0, cappedHits = 0, midLineAnchored = 0
const samples = []
for (const dir of dirs) {
  let summary
  try { summary = JSON.parse(await readFile(join(night, dir, 'summary.json'), 'utf8')) } catch { continue }
  if (!summary.finishedAt || !summary.sessionId) continue
  let events
  try { events = await observedEvents(join(night, dir, 'observed'), summary.sessionId) } catch { continue }
  const calls = new Map(), pairs = []
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, { seq: event.seq, ...event.data })
    else if (event.type === 'tool/result') {
      for (const part of event.data?.message?.content ?? []) {
        if (part?.type !== 'tool-result') continue
        const call = calls.get(part.toolCallId)
        if (call?.name === 'search_context') pairs.push(call)
      }
    }
  }
  for (const call of pairs) {
    let args
    try { args = JSON.parse(call.arguments) } catch { continue }
    if (args.cursor !== undefined) continue
    const session = Session.create(`${dir}-${call.seq}`, events.slice(0, call.seq + 1))
    const page = new ArchiveReader().search(session, { query: args.query, ...(args.limit === undefined ? {} : { limit: args.limit }) }, 4096)
    if (page.status !== 'success' || !page.hits.length) continue
    hitPages += 1
    const texts = new Map()
    for (const hit of page.hits) {
      totalHits += 1
      const codePoints = [...hit.snippet]
      if (codePoints.length >= 100) cappedHits += 1
      // Resolve the original message text to measure the real distance from the
      // containing line's start, which is what the 32-code-point back window
      // could and could not reach.
      const part = eventTextParts(session.eventAt(hit.seq)).texts.find(entry => JSON.stringify(entry.path) === JSON.stringify(hit.textBlockPath))
      if (part) {
        const lineStart = part.text.lastIndexOf('\n', Math.max(0, hit.offset - 1)) + 1
        const opening = [...part.text.slice(lineStart, hit.offset)].slice(0, 16).join('')
        const reached = hit.offset - lineStart <= 32
        if (!reached) {
          midLineHits += 1
          // The old snippet could not name the record; the new one must.
          if (opening && codePoints.join('').includes(opening)) { anchoredHits += 1; midLineAnchored += 1 }
        } else if (opening && codePoints.join('').includes(opening)) {
          // The back window already covered the line opening.
          anchoredHits += 1
        }
      }
      const key = `${dir}|${args.query}`
      if (!texts.has(key)) texts.set(key, [])
      if (texts.get(key).length < 3) texts.get(key).push({ seq: hit.seq, offset: hit.offset, snippet: hit.snippet })
    }
    if (dir === 'c8r2-f3-91503-24p-fork' && args.query === 'checksum=') {
      samples.push({ run: dir, query: args.query, limit: args.limit, hits: texts.get(`${dir}|${args.query}`) })
    }
  }
}
const report = {
  schemaVersion: 1, kind: 'offline-line-anchored-snippet-analysis',
  hitPages, totalHits, midLineHits, midLineAnchored, anchoredHits, cappedHits,
  midLineShare: totalHits ? Number((midLineHits / totalHits).toFixed(4)) : 0,
  midLineAnchoredShare: midLineHits ? Number((midLineAnchored / midLineHits).toFixed(4)) : 0,
  anchoredShare: totalHits ? Number((anchoredHits / totalHits).toFixed(4)) : 0,
  sampleC8r2ChecksumQuery: samples,
  readerArchiveSourceHash: (await import('node:crypto')).createHash('sha256').update(await readFile(new URL('../../src/archive.ts', import.meta.url))).digest('hex'),
}
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ hitPages, totalHits, midLineHits, midLineAnchored, midLineAnchoredShare: report.midLineAnchoredShare, anchoredHits, anchoredShare: report.anchoredShare, cappedHits }))
for (const s of samples) for (const h of s.hits) console.log('  ', h.seq, h.offset, JSON.stringify(h.snippet))
