import { PACKAGE_VERSION } from '../../src/version.ts'
const evidenceRoot = `docs/evidence/v${PACKAGE_VERSION.replaceAll('.', '')}`
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { cpus, totalmem, platform, release } from 'node:os'
import { performance } from 'node:perf_hooks'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { WindowController, resolveArchiveConfig, windowIdentity } from '../../src/window-controller.ts'
import { ArchiveReader } from '../../src/archive.ts'
import { ArcStateStore } from '../../src/state.ts'
import { runCompactionTransaction } from '../../src/region.ts'
import { resolveShadowedTokenCount } from '../../src/fallback.ts'
import { appendAssistant, appendUser } from '../helpers.ts'

async function fixture(): Promise<string> {
  const session = Session.create(SessionId('context-scale-7331')), windows = new WindowController()
  let turn = 0
  for (let block = 0; block < 1000; block++) {
    session.append('turn/start', { turn: ++turn })
    appendUser(session, `Synthetic task ${block}; preserve the data lineage.`)
    const selected: number[] = []
    for (let step = 1; step <= 30; step++) {
      session.append('step/start', { turn, step })
      appendAssistant(session, `PERF_${block}_${step}: synthetic evidence; status healthy; retain the exact source record. ${'Telemetry sample complete. '.repeat(4)}`, turn, step)
      selected.push(session.surface.nodes.at(-1)!)
      session.append('step/end', { turn, step })
    }
    appendUser(session, `Latest requirement ${block}`)
    runCompactionTransaction(session, { operationId: `perf-archive-${block}`, start: selected[0]!, end: selected.at(-1)!, shadowedSeqs: selected,
      summary: [{ type: 'text', text: `Synthetic archive ${block}; use retrieval for exact facts. ${'Checkpoint evidence. '.repeat(40)}` }],
      shadowedTokenCount: resolveShadowedTokenCount({ session, options: {} }, selected), provider: 'fixture', model: 'scale' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    if (block % 10 === 9) {
      session.append('turn/start', { turn: ++turn }); appendUser(session, `Current window task ${block}`)
      const result = await windows.turnover({ session, options: {} }, 'manual', new AbortController().signal, resolveArchiveConfig(), async () => {})
      assert.ok(result)
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
  }
  while (session.seq < 100000) {
    session.append('turn/start', { turn: ++turn })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  assert.equal(windowIdentity(session).generation, 100)
  return JSON.stringify(session.snapshotEvents())
}

await mkdir('.test-runtime', { recursive: true })
const serialized = process.argv.includes('--reuse') ? await readFile('.test-runtime/perf-fixture.json', 'utf8') : await fixture()
if (!process.argv.includes('--reuse')) await writeFile('.test-runtime/perf-fixture.json', serialized)
global.gc?.()
const coldStart = performance.now()
const session = Session.create(SessionId('context-scale-7331'), JSON.parse(serialized))
const reader = new ArchiveReader(), ledger = reader.ledger(session)
const windows = new WindowController(), identity = windows.identity(session)
const kernel = new ArcStateStore().stateFor(session)
const coldMs = performance.now() - coldStart
assert.ok(session.seq >= 100000); assert.ok(ledger.length >= 1000); assert.equal(identity.generation, 100)
assert.ok(kernel.blocks.length <= 1000)
const latencies: number[] = []
for (let i = 0; i < 40; i++) {
  const start = performance.now()
  const result = reader.search(session, { query: i % 2 ? 'PERF_0_1' : 'no-such-needle-7331', limit: 5 }) as { status: string }
  assert.equal(result.status, 'success')
  latencies.push(performance.now() - start)
}
const hotStart = performance.now()
for (let i = 0; i < 100; i++) { reader.ledger(session); windows.identity(session) }
const hotNoChangeMs = (performance.now() - hotStart) / 100
const cancel = new AbortController(); cancel.abort(new Error('cancelled-scale-search'))
const cancelStart = performance.now()
assert.throws(() => reader.search(session, { query: 'no-such-needle' }, 4096, cancel.signal), /cancelled-scale-search/)
const cancelMs = performance.now() - cancelStart
latencies.sort((a, b) => a - b)
const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1]!
const report = { schemaVersion: 1, pluginVersion: PACKAGE_VERSION, pluginCommit: null, hostVersion: '0.1.2-rc.1', seed: 7331,
  fixtureHash: createHash('sha256').update(serialized).digest('hex'), lockHash: createHash('sha256').update(await readFile('package-lock.json')).digest('hex'),
  measuredAt: new Date().toISOString(), machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemory: totalmem(), platform: platform(), release: release(), node: process.version },
  events: session.seq, archives: ledger.length, windows: identity.generation, inputBytes: Buffer.byteLength(serialized),
  heapLimitMiB: 512, memory: process.memoryUsage(), coldMs, searchP95Ms: p95, searchMaxMs: latencies.at(-1), hotNoChangeMs, cancelMs,
  cancellationMode: 'pre-aborted signal; each synchronous search is bounded by scan/visit caps',
  completed: coldMs < 10000 && p95 < 250 && cancelMs < 1000, failures: [] as string[] }
if (coldMs >= 10000) report.failures.push('cold rebuild >= 10s')
if (p95 >= 250) report.failures.push('search p95 >= 250ms')
if (cancelMs >= 1000) report.failures.push('cancel >= 1s')
await mkdir(`${evidenceRoot}/performance`, { recursive: true })
await writeFile(`${evidenceRoot}/performance/scale-7331.json`, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (!report.completed) process.exitCode = 1
