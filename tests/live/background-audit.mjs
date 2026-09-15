// Offline audit of stopped real-host boundary runs, including complete archive
// pagination. Never turns an unobserved/failed condition into a passing score.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { ArchiveReader, resolveSources, eventTextParts } from '../../src/archive.ts'
import { retrievalOutcomes } from './turnover/retrieval-outcomes.mjs'

const root = resolve(process.argv[2] ?? '')
assert.ok(root.startsWith(resolve('.test-runtime/turnover-muse-20260915') + '/'))
const report = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'))
assert.ok(report.finishedAt && report.stages.length === 3 && report.stages.every(s => s.end === 'completed'), 'Audit requires three completed turns in a stopped sample; the original run verdict is preserved')
const rows = JSON.parse(await readFile(join(root, 'final-events.json'), 'utf8'))
const session = Session.create(report.sessionId, rows), reader = new ArchiveReader(), ledger = reader.ledger(session)
assert.equal(ledger.length, 1, 'one pressure replacement expected')
assert.ok(report.appendOnly)
const current = rows.find(event => event.type === 'user/message' && event.data.id === ledger[0].contextManagement.incomingUserId)
assert.ok(current && !ledger[0].shadowedSeqs.includes(current.seq))
assert.ok(toolPairingBalancedBefore(session, session.surface.nodes[0]))
assert.ok(toolPairingBalancedAfter(session, session.surface.nodes.at(-1)))
const metadata = ledger[0].contextManagement
const boundaryEnd = rows.find(e => e.type === 'compaction/end' && e.data.compactionId === ledger[0].blockId)
const atBoundary = Session.create(report.sessionId, rows.slice(0, boundaryEnd.seq + 1))
const prior = JSON.parse(await readFile(join(root, 'foreground-events.json'), 'utf8'))
const latestUserSeq = prior.filter(e => e.type === 'user/message' && e.data.source.kind === 'user').at(-1)?.seq ?? Infinity
const freshSeq = prior.filter(e => e.type === 'assistant/message' && e.seq > latestUserSeq).at(-1)?.seq
const freshRawRetained = atBoundary.surface.nodes.includes(freshSeq)
const foregroundAnswer = report.stages.find(s => s.phase === 'foreground').answer
const markerProduced = foregroundAnswer.includes(`fresh-${report.seed}-7e0183`)
if (metadata.seed.prepared) {
  assert.equal(ledger[0].shadowedSeqs.at(-1), metadata.seed.prepared.throughSeq)
  assert.ok(freshRawRetained, 'work after the summary snapshot remains verbatim')
  const sourceEvents = ledger[0].shadowedSeqs.map(seq => session.eventAt(seq))
  assert.equal(createHash('sha256').update(JSON.stringify(sourceEvents)).digest('hex'), metadata.seed.prepared.sourceHash)
}
assert.ok(Buffer.byteLength(ledger[0].summary) <= 4096)
let restoredBytes = 0, pages = 0
for (const block of ledger) {
  const sources = resolveSources(session, block.shadowedSeqs, ledger)
  assert.equal(sources.incomplete, false)
  const expected = new Map(), actual = new Map()
  for (const seq of sources.seqs) for (const part of eventTextParts(session.eventAt(seq)).texts) expected.set(`${seq}:${JSON.stringify(part.path)}`, part.text)
  let cursor
  do {
    const page = reader.decompress(session, { blockId: block.blockId, maxTokens: 4096, ...(cursor ? { cursor } : {}) })
    assert.equal(page.status, 'success'); assert.equal(page.incomplete, false)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096)
    for (const part of page.segments) {
      const key = `${part.seq}:${JSON.stringify(part.textBlockPath)}`
      if (!expected.has(key) && part.text === '') continue
      const before = actual.get(key) ?? ''
      assert.equal(part.offset, before.length)
      actual.set(key, before + part.text); restoredBytes += Buffer.byteLength(part.text)
    }
    cursor = page.nextCursor
    assert.ok(++pages < 2000, 'Archive cursor must terminate')
  } while (cursor)
  assert.deepEqual(actual, expected)
}
const streams = (await readFile(join(root, 'streams.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
const calls = new Map()
for (const row of streams) {
  const call = calls.get(row.id) ?? {}
  Object.assign(call, row)
  if (row.phase === 'start') call.start = row.time
  if (row.phase === 'first') call.first = row.time
  if (['finish', 'incomplete'].includes(row.phase)) call.end = row.time
  calls.set(row.id, call)
}
// Provider identity cannot distinguish foreground and auxiliary streams when
// both roles use the same cloud route. The AgentLoop itself is still serial.
const local = [...calls.values()].filter(call => call.purpose === 'agent').sort((a, b) => a.start - b.start)
assert.ok([...calls.values()].every(call => call.purpose === 'agent' || call.purpose === 'compaction'), 'Only foreground and compaction streams are permitted')
for (let i = 1; i < local.length; i++) assert.ok(local[i].start >= local[i - 1].end, 'Foreground requests must be serial')
const cloud = [...calls.values()].filter(call => call.purpose === 'compaction')
if (report.arm === 'C') assert.ok(cloud.length >= 1, 'C must actually dispatch a summary request')
else assert.equal(cloud.length, 0, 'A must not dispatch a summary request')
for (const call of calls.values()) {
  const route = call.purpose === 'compaction' ? report.summaryRoute : report.mainRoute
  assert.equal(call.provider, route.provider); assert.equal(call.model, route.model)
  assert.equal(call.reasoningEffort, route.reasoningEffort)
  assert.ok(call.end >= call.start, 'Every observed stream must terminate')
}
const maximumInFlight = selected => {
  const points = selected.flatMap(c => [{ time: c.start, delta: 1 }, { time: c.end, delta: -1 }]).sort((a, b) => a.time - b.time || a.delta - b.delta)
  let active = 0, maximum = 0
  for (const point of points) { active += point.delta; maximum = Math.max(maximum, active) }
  return maximum
}
const intersection = (a, b, from = 'start', to = 'end') => a[from] === undefined || b[from] === undefined || a[to] == null || b[to] == null ? 0 : Math.max(0, Math.min(a[to], b[to]) - Math.max(a[from], b[from]))
const streamOverlapMs = cloud.reduce((sum, c) => sum + local.reduce((n, f) => n + intersection(c, f), 0), 0)
const contentOverlapMs = cloud.reduce((sum, c) => sum + local.reduce((n, f) => n + intersection(c, f, 'first', 'lastContent'), 0), 0)
const orchestration = (await readFile(join(root, 'engine.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
const accesses = orchestration.filter(row => row.phase === 'tool')
const allowedRetrievalAttempts = accesses.filter(row => row.allowed && ['search_context', 'decompress'].includes(row.name)).length
const retrieval = retrievalOutcomes(rows)
const foreground = local[0]
const overlapMs = cloud.reduce((sum, call) => sum + Math.max(0, Math.min(call.end, foreground.end) - Math.max(call.start, foreground.start)), 0)
assert.ok(cloud.every(call => call.reasoningEffort === 'minimal'))
assert.ok([...calls.values()].every(call => call.purpose !== 'session-title'))
const boundary = orchestration.find(row => row.phase === 'pre-step' && row.after > row.before)
assert.ok(boundary)
let lateDelivery = null
if (report.fault === 'late') {
  const network = orchestration.find(row => row.phase === 'fault-network-finish')
  const delivery = orchestration.find(row => row.phase === 'fault-delivery-released')
  assert.equal(metadata.seed.mode, 'extractive')
  assert.equal(boundary.summary?.status, 'late')
  assert.ok(network && delivery && network.time < boundaryEnd.time && delivery.time >= boundaryEnd.time)
  lateDelivery = { networkFinishedBeforeCommit: true, deliveredAfterCommit: true, noExtraWindow: ledger.length === 1, heldMs: delivery.time - network.time }
}
const naturalLateDelivery = !report.fault && boundary.summary?.status === 'late'
if (naturalLateDelivery) { assert.equal(metadata.seed.mode, 'extractive'); assert.ok(!metadata.seed.prepared); assert.equal(ledger.length, 1) }
const maximumTotal = maximumInFlight([...calls.values()]), maximumSummary = maximumInFlight(cloud)
assert.ok(maximumSummary <= 1, 'At most one background summary stream may be in flight')
assert.ok(maximumTotal <= 2, 'At most one foreground and one background summary stream may be in flight')
const output = { name: report.name, originalRunCompleted: report.completed, markerProduced, lateDelivery, naturalLateDelivery, arm: report.arm, fault: report.fault, archiveBytesVerified: true, currentInputProtected: true, toolPairsBalanced: true, appendOnly: true, foregroundRequestsSerial: true, localRequestsSerial: report.mainRoute.provider === 'ubuntu-lora' ? true : null, overlapMetric: 'host-stream-lifecycle-pairwise-ms', pairwiseOverlapNoDoubleCount: true, restoredBytes, archivePages: pages, generation: metadata.generationAfter, seedMode: metadata.seed.mode, seedBytes: Buffer.byteLength(ledger[0].summary), summaryRejected: metadata.seed.rejected ?? null, freshRawRetained, sourceHashVerified: !!metadata.seed.prepared, firstForegroundOverlapMs: overlapMs, streamOverlapMs, contentOverlapMs, maximumInFlight: maximumTotal, maximumSummaryInFlight: maximumSummary, firstSummaryStartLeadMs: cloud[0] ? boundaryEnd.time - cloud[0].start : null, firstSummaryEndLeadMs: cloud[0] ? boundaryEnd.time - cloud[0].end : null, boundaryMs: boundary.elapsedMs, backgroundAtBoundary: boundary.summary, allowedRetrievalAttempts, retrieval, deniedToolAttempts: accesses.filter(row => !row.allowed).map(row => row.name), settingsUnchanged: report.settingsUnchanged,
  calls: [...calls.values()].map(call => ({ provider: call.provider, model: call.model, purpose: call.purpose, reasoningEffort: call.reasoningEffort, start: call.start, first: call.first ?? null, lastContent: call.lastContent ?? null, end: call.end ?? null, elapsedMs: call.end ? call.end - call.start : null, usage: call.usage ?? null, reason: call.reason ?? null })) }
await writeFile(join(root, 'audit.json'), JSON.stringify(output, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ ...output, calls: output.calls.length }))
