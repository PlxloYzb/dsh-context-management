// Additional same-route/background checks after the ordinary full archive audit.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Session } from '@deepseek-ai/dsh-session'
import { retrievalOutcomes } from './turnover/retrieval-outcomes.mjs'

const root = resolve(process.argv[2] ?? '')
assert.ok(root.startsWith(resolve('.test-runtime/nightly-20260915') + '/'))
const read = async path => JSON.parse(await readFile(path, 'utf8'))
const result = await read(join(root, 'summary.json')), archive = await read(join(root, 'audit.json'))
assert.ok(result.completed && result.finishedAt && result.settingsUnchanged && archive.archiveBytesVerified)
assert.equal(result.route.provider, 'opencode-go-muse')
assert.equal(result.route.model, 'muse-spark-1.3-contributor')
assert.equal(result.costControl, 'observe')
assert.equal((await read(join(root, 'budget/limits.json'))).tokenCeiling, null)
const events = await read(join(root, 'observed', `${result.sessionId}.events.json`))
const records = (await readFile(join(root, 'observed/requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
const calls = records.filter(r => r.phase === 'before-route-guard').map(r => {
  assert.equal(r.provider, result.route.provider); assert.equal(r.model, result.route.model)
  assert.equal(r.effectiveReasoningEffort, 'minimal')
  const terminal = records.find(row => row.callId === r.callId && ['finish', 'incomplete-stream'].includes(row.phase))
  assert.ok(terminal, 'Every request must terminate before audit')
  const start = r.startedAtMs ?? Date.parse(r.time), end = terminal.endedAtMs ?? start + terminal.elapsedMs
  return { purpose: r.purpose, start, end, terminalPhase: terminal.phase, elapsedMs: terminal.elapsedMs, firstContentMs: terminal.firstContentMs, reason: terminal.reason ?? null, usage: records.find(row => row.callId === r.callId && row.phase === 'usage')?.usage ?? null }
})
const foreground = calls.filter(c => c.purpose === 'agent'), summaries = calls.filter(c => c.purpose === 'compaction')
assert.equal(foreground.length + summaries.length, calls.length, 'No unrequested title or other auxiliary generation')
assert.ok(calls.every(call => call.purpose === 'agent' || call.purpose === 'compaction'), 'Only foreground and compaction streams are permitted')
for (let i = 1; i < foreground.length; i++) assert.ok(foreground[i].start >= foreground[i - 1].end, 'Foreground calls remain serial')
if (result.backgroundSummaryEnabled) assert.ok(summaries.length, 'Enabled cloud gate must actually dispatch background work')
const maximum = selected => {
  const points = selected.flatMap(c => [{ t: c.start, n: 1 }, { t: c.end, n: -1 }]).sort((a, b) => a.t - b.t || a.n - b.n)
  let active = 0, peak = 0
  for (const point of points) { active += point.n; peak = Math.max(peak, active) }
  return peak
}
const overlapMs = summaries.reduce((sum, s) => sum + foreground.reduce((n, f) => n + Math.max(0, Math.min(s.end, f.end) - Math.max(s.start, f.start)), 0), 0)
const maximumTotal = maximum(calls), maximumSummary = maximum(summaries)
assert.ok(maximumSummary <= 1, 'At most one background summary stream may be in flight')
assert.ok(maximumTotal <= 2, 'At most one foreground and one background summary stream may be in flight')
const windows = []
for (const event of events.filter(e => e.type === 'compaction/summary' && e.data.contextManagement)) {
  const metadata = event.data.contextManagement, seqs = event.data.shadowedSeqs
  const start = events.find(e => e.type === 'compaction/start' && e.data.compactionId === metadata.operationId)
  const end = events.find(e => e.type === 'compaction/end' && e.data.compactionId === metadata.operationId)
  assert.ok(start && end)
  const before = Session.create(result.sessionId, events.filter(e => e.seq < start.seq))
  const after = Session.create(result.sessionId, events.filter(e => e.seq <= end.seq))
  let sourceHashVerified = false, newerSuffixRetained = null
  if (metadata.seed.prepared) {
    assert.equal(seqs.at(-1), metadata.seed.prepared.throughSeq)
    assert.equal(createHash('sha256').update(JSON.stringify(seqs.map(seq => before.eventAt(seq)))).digest('hex'), metadata.seed.prepared.sourceHash)
    assert.equal(metadata.seed.prepared.provider, result.route.provider); assert.equal(metadata.seed.prepared.model, result.route.model)
    assert.equal(metadata.seed.prepared.reasoningEffort, 'minimal')
    const newer = before.surface.nodes.filter(seq => seq > metadata.seed.prepared.throughSeq)
    assert.ok(newer.every(seq => after.surface.nodes.includes(seq)), 'Every newer surface message survives the prepared-prefix replacement')
    sourceHashVerified = true; newerSuffixRetained = newer.length
  }
  windows.push({ seq: event.seq, mode: metadata.seed.mode, rejected: metadata.seed.rejected ?? null, sourceHashVerified, newerSuffixRetained })
}
const pressure = (await readFile(join(root, 'observed', `${result.sessionId}.pressure.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse)
const states = Object.fromEntries([...new Set(pressure.map(r => r.backgroundSummary?.status).filter(Boolean))].map(s => [s, pressure.filter(r => r.backgroundSummary?.status === s).length]))
const boundaries = []
let beforeStep
for (const row of pressure) {
  if (row.stage === 'before-pre-step') beforeStep = row
  if (row.stage === 'after-pre-step' && beforeStep) {
    if (row.replaceGeneration > beforeStep.replaceGeneration) boundaries.push({ elapsedMs: Date.parse(row.time) - Date.parse(beforeStep.time), backgroundBefore: beforeStep.backgroundSummary?.status ?? null, backgroundAfter: row.backgroundSummary?.status ?? null })
    beforeStep = undefined
  }
}
const output = { name: result.name, completed: true, effectiveEffort: 'minimal', allRequestsSameCloudRoute: true, costControl: 'observe', archiveBytesVerified: true, overlapMetric: 'host-stream-lifecycle-pairwise-ms', pairwiseOverlapNoDoubleCount: true, calls, maximumInFlight: maximumTotal, maximumSummaryInFlight: maximumSummary, observedStreamOverlapMs: overlapMs, summaryStatusObservations: states, boundaries, windows, retrieval: retrievalOutcomes(events), originalStrictPassed: result.strictPassed, originalAllQualityPassed: result.allQualityPassed, restartVerified: result.restartVerified ?? null }
await writeFile(join(root, 'cloud-audit.json'), JSON.stringify(output, null, 2) + '\n')
console.log(JSON.stringify({ ...output, calls: calls.length }))
