// Additional same-route/background checks after the ordinary full archive audit.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Session } from '@deepseek-ai/dsh-session'
import { retrievalOutcomes } from './turnover/retrieval-outcomes.mjs'
import { readContextHandoff, readWindowContextHandoff } from '../../src/region.ts'

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
const session = Session.create(result.sessionId, events)
const records = (await readFile(join(root, 'observed/requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
const calls = records.filter(r => r.phase === 'before-route-guard').map(r => {
  assert.equal(r.provider, result.route.provider); assert.equal(r.model, result.route.model)
  assert.equal(r.effectiveReasoningEffort, 'minimal')
  const terminal = records.find(row => row.callId === r.callId && ['finish', 'incomplete-stream'].includes(row.phase))
  assert.ok(terminal, 'Every request must terminate before audit')
  const start = r.startedAtMs ?? Date.parse(r.time), end = terminal.endedAtMs ?? start + terminal.elapsedMs
  return { callId: r.callId, purpose: r.purpose, start, end, terminalPhase: terminal.phase, elapsedMs: terminal.elapsedMs, firstContentMs: terminal.firstContentMs, reason: terminal.reason ?? null, usage: records.find(row => row.callId === r.callId && row.phase === 'usage')?.usage ?? null }
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
// Deferred handoffs are optional in the older seed/background gates.  When a
// receipt exists, however, audit its durable source and host append boundary;
// "uncovered" remains a reported condition, never a structural pass.
const eventBySeq = new Map(events.map(event => [event.seq, event]))
const windowHandoffs = events
  .filter(event => event.type === 'compaction/summary' && event.data.contextManagement)
  .map(event => ({ event, receipt: readWindowContextHandoff(session, event) }))
  .filter(item => item.receipt)
const messageHandoffs = events
  .map(event => ({ event, receipt: readContextHandoff(event) }))
  .filter(item => item.receipt)
const windowByGeneration = new Map(events
  .filter(event => event.type === 'compaction/summary' && event.data.contextManagement)
  .map(event => {
    const metadata = event.data.contextManagement
    const end = events.find(candidate => candidate.type === 'compaction/end' && candidate.data.compactionId === metadata.operationId)
    return [metadata.generationAfter, { summarySeq: event.seq, endSeq: end?.seq ?? null, endTime: end?.time ?? null, operationId: metadata.operationId }]
  }))
const operations = new Map()
const operation = id => {
  let row = operations.get(id)
  if (!row) { row = { operationId: id, pending: [], delivered: [], unavailable: [], status: [] }; operations.set(id, row) }
  return row
}
for (const { event, receipt } of windowHandoffs) operation(receipt.operationId).pending.push({ seq: event.seq, time: event.time ?? null, receipt, source: 'window-metadata' })
for (const { event, receipt } of messageHandoffs) operation(receipt.operationId)[receipt.status].push({ seq: event.seq, time: event.time ?? null, receipt, source: 'user-message' })
for (const row of pressure) {
  const summary = row.backgroundSummary
  if (typeof summary?.operationId === 'string') operation(summary.operationId).status.push({ time: row.time ? Date.parse(row.time) : null, stage: row.stage ?? null, summary })
}
const receiptHash = receipt => createHash('sha256').update(JSON.stringify(receipt.sourceSeqs.map(seq => eventBySeq.get(seq)))).digest('hex')
// Associate a job with its own stream by the timestamps carried in the status
// snapshot. Request ordering is not a correlation key: a later job can finish
// while an earlier one is still pending delivery.
const streamFor = summary => {
  if (!Number.isFinite(summary?.startedAt) || !Number.isFinite(summary?.readyAt)) return null
  const candidates = summaries.filter(call => Number.isFinite(call.start) && Number.isFinite(call.end))
    .map(call => ({ call, startDeltaMs: Math.abs(call.start - summary.startedAt), readyDeltaMs: Math.abs(call.end - summary.readyAt) }))
    .sort((left, right) => left.startDeltaMs + left.readyDeltaMs - right.startDeltaMs - right.readyDeltaMs)
  const match = candidates[0] ?? null
  return match && match.startDeltaMs <= 250 && match.readyDeltaMs <= 250 ? match : null
}
const handoffs = []
const handoffFailures = []
for (const row of operations.values()) {
  const receipt = row.pending[0]?.receipt ?? row.delivered[0]?.receipt ?? row.unavailable[0]?.receipt
  const sourceCoverage = receipt ? {
    seqs: receipt.sourceSeqs,
    throughSeq: receipt.throughSeq,
    complete: receipt.sourceSeqs.every(seq => eventBySeq.has(seq)),
    sourceHashValid: receipt.sourceSeqs.every(seq => eventBySeq.has(seq)) && receiptHash(receipt) === receipt.sourceHash,
  } : null
  if (sourceCoverage && !sourceCoverage.sourceHashValid) handoffFailures.push(`handoff-source-hash:${row.operationId}`)
  if (row.delivered.length > 1) handoffFailures.push(`handoff-duplicate-delivery:${row.operationId}`)
  const window = receipt ? windowByGeneration.get(receipt.windowGeneration) : null
  const delivery = row.delivered[0] ?? null
  const unavailable = row.unavailable[0] ?? null
  let appendWithoutGenerationChange = null
  if (delivery) {
    const index = events.findIndex(event => event.seq === delivery.seq)
    const event = eventBySeq.get(delivery.seq)
    const before = index >= 0 ? Session.create(result.sessionId, events.slice(0, index)) : null
    const after = index >= 0 ? Session.create(result.sessionId, events.slice(0, index + 1)) : null
    appendWithoutGenerationChange = Boolean(event?.surfaceOp === 'append' && before && after
      && before.surface.replaceGeneration === after.surface.replaceGeneration
      && before.surface.replaceGeneration === delivery.receipt.windowGeneration)
    if (!appendWithoutGenerationChange) handoffFailures.push(`handoff-not-safe-append:${row.operationId}`)
    if (!window || window.endSeq === null || delivery.seq <= window.endSeq) handoffFailures.push(`handoff-before-window-commit:${row.operationId}`)
  }
  const ready = row.status.find(item => Number.isFinite(item.summary?.readyAt))?.summary ?? null
  const stream = streamFor(ready)
  if (ready && !stream) handoffFailures.push(`handoff-stream-status-unmatched:${row.operationId}`)
  const pending = row.pending[0] ?? null
  const summaryFinish = stream?.call.end ?? null
  const deliveryTime = delivery?.time ?? null
  const committedAt = window?.endTime ?? null
  const readyBeforeWindow = Number.isFinite(ready?.readyAt) && committedAt !== null && ready.readyAt <= committedAt
  const ordering = pending && ready?.readyAt !== undefined && deliveryTime !== null && committedAt !== null
    ? readyBeforeWindow ? ready.readyAt <= committedAt && committedAt <= deliveryTime : committedAt <= ready.readyAt && ready.readyAt <= deliveryTime : null
  if (ordering === false) handoffFailures.push(`handoff-ordering:${row.operationId}`)
  const recoveryNotificationValid = unavailable?.receipt.reason === 'interrupted' ? (() => {
    const event = eventBySeq.get(unavailable.seq)
    return event?.surfaceOp === 'append' && window?.endSeq !== null && unavailable.seq > window.endSeq
  })() : null
  if (unavailable?.receipt.reason === 'interrupted' && !recoveryNotificationValid) handoffFailures.push(`handoff-interrupted-recovery-invalid:${row.operationId}`)
  const classification = unavailable?.receipt.reason === 'interrupted' ? 'terminated-interrupted'
    : !pending && ready ? 'uncovered-source-still-current'
      : !pending ? 'receipt-without-observed-window-pending'
        : !ready?.readyAt ? 'uncovered-natural-pending-without-ready-observation'
          : !delivery ? 'uncovered-natural-ready-undelivered-at-task-end'
            : ordering ? (readyBeforeWindow ? 'covered-ready-before-window' : 'covered-pending-crossed-window') : 'observed-ordering-invalid'
  handoffs.push({ operationId: row.operationId, pending: row.pending, delivered: row.delivered, unavailable: row.unavailable, sourceCoverage, window: window ?? null,
    readyStatus: ready, stream: stream ? { callId: stream.call.callId ?? null, start: stream.call.start, finish: stream.call.end, startDeltaMs: stream.startDeltaMs, readyDeltaMs: stream.readyDeltaMs } : null,
    readyAt: ready?.readyAt ?? null, summaryFinishAt: summaryFinish, deliveryAt: deliveryTime, appendWithoutGenerationChange, recoveryNotificationValid: recoveryNotificationValid ?? null, ordering, classification })
}
// A real await_context invocation must have the host's paired result.  Its
// duration is the user-visible wait; background-stream duration is reported
// separately and does not prove the foreground waited.
const toolCalls = events.filter(event => event.type === 'assistant/message').flatMap(event => (event.data.message?.content ?? [])
  .filter(block => block.type === 'tool-call').map(block => ({ block, time: event.time ?? null })))
const toolResults = events.filter(event => event.type === 'tool/result').flatMap(event => (event.data.message?.content ?? [])
  .filter(block => block.type === 'tool-result').map(block => ({ block, sourceCallId: event.data.message.source?.callId ?? null, time: event.time ?? null })))
const resultByCall = new Map(toolResults.map(item => [item.block.toolCallId, item]))
const awaitContext = toolCalls.filter(item => item.block.name === 'await_context').map(item => {
  const result = resultByCall.get(item.block.id)
  const text = result?.block.content?.filter(part => part.type === 'text').map(part => part.text).join('') ?? ''
  let value = null
  try { value = JSON.parse(text.match(/\{[^{}]*\}/)?.[0] ?? 'null') } catch { /* malformed tool output remains auditable */ }
  const paired = result?.sourceCallId === item.block.id
  if (!paired) handoffFailures.push(`await-context-unpaired:${item.block.id}`)
  return { callId: item.block.id, paired, status: value?.status ?? null, startedAt: item.time, completedAt: result?.time ?? null, elapsedMs: item.time !== null && result?.time !== null ? result.time - item.time : null }
})
const deferredReceiptAudit = {
  observed: handoffs.length > 0,
  pending: handoffs.flatMap(item => item.pending),
  delivered: handoffs.flatMap(item => item.delivered),
  unavailable: handoffs.flatMap(item => item.unavailable),
  handoffs,
  awaitContext,
  summaryReadyStatusObservations: pressure.filter(row => Number.isFinite(row.backgroundSummary?.readyAt)).map(row => ({ time: row.time, stage: row.stage, summary: row.backgroundSummary })),
  structuralFailures: handoffFailures,
  structuralPassed: handoffs.length > 0 && handoffFailures.length === 0,
  coverage: handoffs.length === 0 ? 'not-observed-in-this-legacy-or-seed-gate'
    : handoffs.every(item => item.classification.startsWith('covered-') || item.classification === 'terminated-interrupted') ? 'covered'
      : 'partially-covered-with-natural-uncovered-work',
}
const output = { name: result.name, completed: true, effectiveEffort: 'minimal', allRequestsSameCloudRoute: true, costControl: 'observe', archiveBytesVerified: true, overlapMetric: 'host-stream-lifecycle-pairwise-ms', pairwiseOverlapNoDoubleCount: true, calls, maximumInFlight: maximumTotal, maximumSummaryInFlight: maximumSummary, observedStreamOverlapMs: overlapMs, summaryStatusObservations: states, boundaries, windows, retrieval: retrievalOutcomes(events), deferredReceiptAudit, originalStrictPassed: result.strictPassed, originalAllQualityPassed: result.allQualityPassed, restartVerified: result.restartVerified ?? null }
await writeFile(join(root, 'cloud-audit.json'), JSON.stringify(output, null, 2) + '\n')
console.log(JSON.stringify({ ...output, calls: calls.length }))
