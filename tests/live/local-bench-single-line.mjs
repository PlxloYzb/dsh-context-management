// Measure the single-line-block case the bounded-allocation fix targets: a match
// late in one long block. Compares the gated candidate 9 build (99f372c) with the
// fixed build. No provider calls.
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { runCompactionTransaction } from '../../src/region.ts'
import { ArchiveReader as ReaderFixed } from '../../src/archive.ts'
import { loadArchiveAtRevision } from './local-bench-modules.mjs'
import { appendUser } from '../helpers.ts'

const night = resolve('.test-runtime/nightly-20260915')
const { ArchiveReader: ReaderGated } = await loadArchiveAtRevision('99f372c')
const ctx = new Context()
new SessionProjectionRegistry(ctx); new TokenMeter(ctx)
const session = Session.create('bench-single-line-allocation')
session.append('turn/start', { turn: 1 })
appendUser(session, `RECORD_HEAD_MARKER ${'pad '.repeat(100_000)}checksum=deadbeef01 end`)
const source = session.surface.nodes[0]
appendUser(session, 'Protected current input')
runCompactionTransaction(session, {
  start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Single-line allocation fixture' }],
  shadowedTokenCount: ctx.tokenMeter.measure(session).nodes.find(n => n.seq === source).heuristicTokens,
  provider: 'fixture', model: 'single-line-allocation',
})
const query = { query: 'checksum=deadbeef01', limit: 3 }
const measure = (Reader, runs) => {
  const reader = new Reader()
  const times = []
  let snippet = null
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    const page = reader.search(session, query, 4096)
    times.push(performance.now() - started)
    snippet = page.status === 'success' ? page.hits[0]?.snippet ?? null : `error:${page.code}`
  }
  return { times, snippet }
}
measure(ReaderGated, 1); measure(ReaderFixed, 1)
const gated = measure(ReaderGated, 5), fixed = measure(ReaderFixed, 5)
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const report = {
  schemaVersion: 1, kind: 'offline-single-line-allocation-benchmark',
  blockChars: 1 + 'pad '.repeat(100_000).length + 24,
  gatedMedianMs: Number(median(gated.times).toFixed(3)), fixedMedianMs: Number(median(fixed.times).toFixed(3)),
  gatedRawMs: gated.times.map(v => Number(v.toFixed(3))), fixedRawMs: fixed.times.map(v => Number(v.toFixed(3))),
  snippetsIdentical: gated.snippet === fixed.snippet,
  snippet: fixed.snippet,
  note: 'Gated is the candidate 9 source committed as 99f372c; fixed is the current bounded-allocation source. Same-machine synthetic measurement.',
}
await writeFile(join(night, 'snippet-allocation-microbenchmark.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ gated: report.gatedMedianMs, fixed: report.fixedMedianMs, identical: report.snippetsIdentical, chars: report.blockChars }))
ctx.fiber.dispose()
