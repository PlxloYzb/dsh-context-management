// Alternating paired micro-benchmark of the real search path on a retained
// 432-page archive: candidate 8 (mid-line snippets) vs candidate 9
// (line-anchored snippets). Reports medians and keeps every raw sample.
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { ArchiveReader as ReaderC9 } from '../../src/archive.ts'
import { loadArchiveAtRevision } from './local-bench-modules.mjs'
import { observedEvents } from './local/observed-events.mjs'

const night = resolve('.test-runtime/nightly-20260915')
const { ArchiveReader: ReaderC8 } = await loadArchiveAtRevision('1747178')
const run = 'legacy-v11-f1-432p'
const summary = JSON.parse(await readFile(join(night, run, 'summary.json'), 'utf8'))
const events = await observedEvents(join(night, run, 'observed'), summary.sessionId)
const session = Session.create('bench-snippet-anchor', events)
const queries = ['Observation 1.0:', 'checksum=', 'Observation 190.0:', 'trace=', 'NEVER_PRESENT_LITERAL']
const warm = 3, rounds = 8
const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function measure(Reader) {
  const reader = new Reader()
  const started = performance.now()
  let hits = 0
  for (const query of queries) {
    const page = reader.search(session, { query, limit: 5 }, 4096)
    hits += page.status === 'success' ? page.hits.length : 0
  }
  return { ms: performance.now() - started, hits }
}

for (let i = 0; i < warm; i++) { measure(ReaderC8); measure(ReaderC9) }
const samples = []
for (let round = 0; round < rounds; round++) {
  const order = round % 2 === 0 ? [['candidate8', ReaderC8], ['candidate9', ReaderC9]] : [['candidate9', ReaderC9], ['candidate8', ReaderC8]]
  const row = { round }
  for (const [name, Reader] of order) row[name] = measure(Reader)
  samples.push(row)
}
const flat = name => samples.map(row => row[name].ms)
const report = {
  schemaVersion: 1, kind: 'offline-search-snippet-anchor-microbenchmark',
  run, queries, warmupRounds: warm, measuredRounds: rounds,
  candidate8MedianMs: Number(median(flat('candidate8')).toFixed(3)),
  candidate9MedianMs: Number(median(flat('candidate9')).toFixed(3)),
  candidate8Hits: samples[0].candidate8.hits, candidate9Hits: samples[0].candidate9.hits,
  samples,
  note: 'Same-process alternating pairs on one machine; a synthetic cost measurement, not a model-task speed claim.',
}
await writeFile(join(night, 'snippet-anchor-microbenchmark.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ c8: report.candidate8MedianMs, c9: report.candidate9MedianMs, hits: [report.candidate8Hits, report.candidate9Hits] }))
