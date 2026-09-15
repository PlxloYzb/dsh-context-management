// Offline audit for one stopped deferred-handoff live sample. It does not
// repair an unsuccessful run: the original result remains the verdict source.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { ArchiveReader, resolveSources, eventTextParts } from '../../src/archive.ts'
import { readContextHandoff, readWindowContextHandoff } from '../../src/region.ts'

const root = resolve(process.argv[2] ?? '.test-runtime/handoff-muse-20260915/deferred-independent-91541')
const allowedRoot = `${resolve('.test-runtime/handoff-muse-20260915')}/`
if (!root.startsWith(allowedRoot)) throw new Error('Audit root must be one ignored handoff sample directory')
const read = async file => JSON.parse(await readFile(join(root, file), 'utf8'))
const readLines = async file => (await readFile(join(root, file), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const result = await read('result.json')
if (!result.finishedAt) throw new Error('Audit requires a stopped sample with result.finishedAt')
const observer = await read('observer-state.json').catch(() => null)
const rpcRows = await read('final-events.json').catch(() => null)
// Web RPC pagination can return a filtered presentation view. The observer
// records the host's complete append-only snapshot and is therefore the only
// valid source when available; never fill or renumber a sparse RPC view.
const rows = Array.isArray(observer?.events) ? observer.events : rpcRows
const eventSource = Array.isArray(observer?.events) ? 'observer-session-snapshot' : 'final-events-rpc-fallback'
if (!Array.isArray(rows)) throw new Error('No retained session event log is available')
if (!rows.every((event, index) => event.seq === index)) throw new Error(`Event source ${eventSource} is not a complete contiguous snapshot from seq 0`)
const session = Session.create(result.sessionId, rows), reader = new ArchiveReader(), ledger = reader.ledger(session)
const engine = await readLines('engine.jsonl'), streamRows = await readLines('streams.jsonl')
const eventBySeq = new Map(rows.map(event => [event.seq, event]))
const failures = []
const check = (condition, label) => { if (!condition) failures.push(label); return condition }
if (!result.completed) failures.push('original-run-incomplete')
const contiguous = rows.every((event, index) => event.seq === index)
check(contiguous, 'event-sequences-not-strictly-append-only')
const metadata = ledger.map(block => block.contextManagement).filter(Boolean)
const paired = session.surface.nodes.length > 0 && toolPairingBalancedBefore(session, session.surface.nodes[0]) && toolPairingBalancedAfter(session, session.surface.nodes.at(-1))
check(paired, 'tool-pairing-unbalanced')

let restoredBytes = 0, archivePages = 0, archiveComplete = true
for (const block of ledger) {
  const sources = resolveSources(session, block.shadowedSeqs, ledger)
  if (sources.incomplete) { archiveComplete = false; failures.push(`archive-source-incomplete:${block.blockId}`); continue }
  const expected = new Map(), actual = new Map()
  for (const seq of sources.seqs) for (const part of eventTextParts(session.eventAt(seq)).texts) expected.set(`${seq}:${JSON.stringify(part.path)}`, part.text)
  let cursor
  do {
    const page = reader.decompress(session, { blockId: block.blockId, maxTokens: 4096, ...(cursor ? { cursor } : {}) })
    if (page.status !== 'success' || page.incomplete || Buffer.byteLength(JSON.stringify(page)) > 4096) { archiveComplete = false; failures.push(`archive-page-invalid:${block.blockId}`); break }
    for (const part of page.segments) {
      const key = `${part.seq}:${JSON.stringify(part.textBlockPath)}`
      if (!expected.has(key) && part.text === '') continue
      const before = actual.get(key) ?? ''
      if (part.offset !== before.length) { archiveComplete = false; failures.push(`archive-offset:${block.blockId}`); break }
      actual.set(key, before + part.text); restoredBytes += Buffer.byteLength(part.text)
    }
    cursor = page.nextCursor
    if (++archivePages >= 2000) { archiveComplete = false; failures.push(`archive-pagination:${block.blockId}`); break }
  } while (cursor)
  if (JSON.stringify([...actual]) !== JSON.stringify([...expected])) { archiveComplete = false; failures.push(`archive-bytes:${block.blockId}`) }
}

const receipts = rows.map(event => ({ event, receipt: readContextHandoff(event), source: 'event' })).filter(row => row.receipt)
const windows = rows.filter(event => event.type === 'compaction/summary' && event.data?.contextManagement?.kind === 'window').map(summaryEvent => {
  const item = summaryEvent.data.contextManagement, blockId = summaryEvent.data.compactionId
  const block = ledger.find(candidate => candidate.blockId === blockId)
  const endEvent = rows.find(event => event.type === 'compaction/end' && event.data?.compactionId === blockId)
  const pendingReceipt = readWindowContextHandoff(session, summaryEvent)
  return { operationId: item.operationId, generation: item.generationAfter, blockId, shadowedSeqs: block?.shadowedSeqs ?? [], commitAt: endEvent?.time ?? summaryEvent.time ?? null, commitSeq: endEvent?.seq ?? summaryEvent.seq, summaryEvent, pendingReceipt }
})
if (!windows.length) failures.push('no-real-window-observed')
const protectedInputs = windows.map(window => {
  const before = Session.create(result.sessionId, rows.filter(event => event.seq < window.summaryEvent.seq)).snapshotEvents()
  const latestUser = before.filter(event => event.type === 'user/message' && event.data?.source?.kind === 'user').at(-1) ?? null
  const preserved = latestUser !== null && !window.shadowedSeqs.includes(latestUser.seq) && session.surface.nodes.includes(latestUser.seq)
  if (!preserved) failures.push(`current-input-not-retained:${window.operationId}`)
  return { operationId: window.operationId, seq: latestUser?.seq ?? null, preserved }
})
const currentInputProtected = protectedInputs.every(item => item.preserved)
const receiptTiming = receipt => engine.find(row => row.phase === 'handoff-message' && row.handoff?.operationId === receipt.operationId && row.handoff?.status === receipt.status)?.time ?? null
const summaries = new Map()
for (const row of streamRows) {
  const call = summaries.get(row.id) ?? {}; Object.assign(call, row)
  if (row.phase === 'start') call.start = row.time
  if (row.phase === 'finish') call.finish = row.time
  if (row.phase === 'usage') call.usage = row.usage
  summaries.set(row.id, call)
}
const calls = [...summaries.values()]
const foreground = calls.filter(call => call.purpose === 'agent').sort((a, b) => a.start - b.start)
const summaryCalls = calls.filter(call => call.purpose === 'compaction')
for (const call of calls) {
  check(call.provider === result.route.provider && call.model === result.route.model && call.reasoningEffort === result.route.reasoningEffort, `route-or-effort:${call.id ?? 'unknown'}`)
  check(call.purpose !== 'session-title', 'session-title-stream')
}
for (let i = 1; i < foreground.length; i++) check(foreground[i].start >= foreground[i - 1].finish, 'foreground-streams-not-serial')
const maximumInFlight = selected => {
  const points = selected.flatMap(call => call.start !== undefined && call.finish !== undefined ? [{ time: call.start, delta: 1 }, { time: call.finish, delta: -1 }] : []).sort((a, b) => a.time - b.time || a.delta - b.delta)
  let active = 0, maximum = 0
  for (const point of points) { active += point.delta; maximum = Math.max(maximum, active) }
  return maximum
}
check(maximumInFlight(summaryCalls) <= 1, 'more-than-one-summary-in-flight')
check(maximumInFlight(calls) <= 2, 'more-than-two-total-streams-in-flight')

const statusRows = engine.filter(row => row.phase === 'status')
const byOperation = new Map()
const addOperation = (operationId, extra = {}) => {
  const row = byOperation.get(operationId) ?? { operationId, receipts: [], pendingTransactions: [], statuses: [] }
  Object.assign(row, extra); byOperation.set(operationId, row)
  return row
}
for (const { event, receipt } of receipts) {
  const row = addOperation(receipt.operationId)
  row.receipts.push({ seq: event.seq, status: receipt.status, time: event.time ?? receiptTiming(receipt), receipt })
}
for (const window of windows) if (window.pendingReceipt) addOperation(window.pendingReceipt.operationId).pendingTransactions.push({ receipt: window.pendingReceipt, seq: window.summaryEvent.seq, time: window.commitAt, windowGeneration: window.generation })
for (const status of statusRows) if (typeof status.summary?.operationId === 'string') addOperation(status.summary.operationId).statuses.push(status)
const handoffs = []
for (const row of byOperation.values()) {
  const pending = row.receipts.find(item => item.status === 'pending') ?? row.pendingTransactions[0]
  const delivered = row.receipts.filter(item => item.status === 'delivered')
  const receipt = pending?.receipt ?? delivered[0]?.receipt ?? row.receipts[0]?.receipt
  const sourceEvents = receipt?.sourceSeqs.map(seq => eventBySeq.get(seq)) ?? []
  const sourceHashValid = receipt ? sourceEvents.length === receipt.sourceSeqs.length && hash(sourceEvents) === receipt.sourceHash : null
  const window = windows.find(item => item.generation === receipt?.windowGeneration)
  const delivery = delivered[0]
  const deliveryEvent = delivery && eventBySeq.get(delivery.seq)
  const appendDelivery = deliveryEvent?.surfaceOp === 'append'
  const deliveryIndex = delivery ? rows.findIndex(event => event.seq === delivery.seq) : -1
  const generationStable = !delivery || (() => {
    if (!window || deliveryIndex < 0) return false
    const before = Session.create(result.sessionId, rows.slice(0, deliveryIndex))
    const after = Session.create(result.sessionId, rows.slice(0, deliveryIndex + 1))
    return receipt.windowGeneration === window.generation && before.surface.replaceGeneration === window.generation && after.surface.replaceGeneration === window.generation
  })()
  const summary = summaryCalls.length === 1 ? summaryCalls[0] : undefined
  const readyStatus = row.statuses.find(item => Number.isFinite(item.summary?.readyAt))?.summary ?? null
  const readyAt = readyStatus?.readyAt ?? null
  const finishAt = summary?.finish ?? null
  const crossedPending = Boolean(pending && window)
  const pendingAt = pending?.time ?? window?.commitAt ?? null
  const ordering = crossedPending && readyAt !== null && delivery?.time !== null && finishAt !== null
    ? pendingAt !== null && pendingAt <= finishAt && finishAt <= readyAt && readyAt <= delivery.time : null
  if (sourceHashValid !== null) check(sourceHashValid, `handoff-source-hash:${row.operationId}`)
  check(delivered.length <= 1, `handoff-duplicate-delivery:${row.operationId}`)
  if (delivery) { check(appendDelivery, `handoff-not-append:${row.operationId}`); check(Boolean(window) && delivery.seq > (rows.find(event => event.type === 'compaction/end' && event.data?.compactionId === window.blockId)?.seq ?? -1), `handoff-before-window:${row.operationId}`); check(generationStable, `handoff-changed-generation:${row.operationId}`) }
  const classification = !window && row.statuses.some(item => item.summary?.status === 'pending') ? 'uncovered-no-window-source-still-current'
    : crossedPending && finishAt === null ? 'uncovered-natural-pending-at-task-end'
    : crossedPending && readyAt === null ? 'uncovered-natural-finish-without-ready-observation'
      : crossedPending && readyAt !== null && !delivery ? 'uncovered-natural-ready-undelivered-at-task-end'
        : crossedPending && delivery?.time ? (ordering ? 'covered' : 'observed-ordering-invalid') : 'uncovered-natural-timing'
  handoffs.push({ operationId: row.operationId, pendingReceipt: pending ?? null, pendingTransactions: row.pendingTransactions, deliveredReceipt: delivery ?? null, sourceHashValid, windowGeneration: receipt?.windowGeneration ?? null, targetGeneration: readyStatus?.targetGeneration ?? null, pendingAt, actualSummaryFinishAt: finishAt, readyAt, deliveryAt: delivery?.time ?? null, ordering, classification })
}

const toolCalls = rows.filter(event => event.type === 'assistant/message').flatMap(event => (event.data.message?.content ?? []).filter(block => block.type === 'tool-call').map(block => ({ block, time: event.time ?? null })))
const callBlocks = toolCalls.map(item => item.block)
const callTime = new Map(toolCalls.map(item => [item.block.id, item.time]))
const resultBlocks = rows.filter(event => event.type === 'tool/result').flatMap(event => (event.data.message?.content ?? []).filter(block => block.type === 'tool-result').map(block => ({ block, sourceCallId: event.data.message?.source?.callId ?? null, time: event.time ?? null })))
const textFrom = block => (block.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('')
const resultByCall = new Map(resultBlocks.map(({ block, sourceCallId, time }) => [block.toolCallId, { text: textFrom(block), sourceCallId, time }]))
const callsByName = name => callBlocks.filter(block => block.name === name)
const awaitCalls = callsByName('await_context').map(block => {
  const result = resultByCall.get(block.id), text = result?.text ?? '', object = (() => { try { return JSON.parse(text.match(/\{[^{}]*\}/)?.[0] ?? '{}') } catch { return null } })()
  const start = callTime.get(block.id) ?? null, end = result?.time ?? null
  return { callId: block.id, status: object?.status ?? null, sourceCallId: result?.sourceCallId ?? null, sourceMatches: result?.sourceCallId === block.id, elapsedMs: start !== null && end !== null ? end - start : null }
})
const retrieval = ['search_context', 'decompress'].flatMap(callsByName).map(block => ({ name: block.name, callId: block.id, result: resultByCall.get(block.id)?.text ?? null, success: /"status"\s*:\s*"success"/.test(resultByCall.get(block.id)?.text ?? '') }))
const tools = engine.filter(row => row.phase === 'tool')
const stage = result.stages?.find(item => item.phase === 'task') ?? null
const independent = result.task === 'independent' ? { currentToken: stage?.currentToken ?? null, verified: stage?.score?.correct === 1, payloadCalls: callsByName('handoff_current_payload').length, verifyCalls: callsByName('handoff_current_verify').length, forbiddenCalls: callsByName('await_context').length + retrieval.length, violations: tools.filter(row => row.violation).map(row => row.name) } : null
const dependent = result.task === 'dependent' ? { score: stage?.score ?? null, awaitCalls, retrieval, violations: tools.filter(row => row.violation).map(row => row.name) } : null
if (dependent) {
  const fixture = await read('fixture.json')
  dependent.factAvailabilityByForegroundRequest = await Promise.all(foreground.map(async (call, index) => {
    const request = await read(`request-${call.id}.json`)
    const text = JSON.stringify(request.messages)
    return { request: index + 1, fields: Object.fromEntries(['owner', 'rollback', 'gate'].map(field => [field, text.includes(fixture.expected[field])])) }
  }))
}
const usageState = usage => {
  if (usage === undefined || usage === null) return 'missing-or-null'
  if (usage === 0 || (typeof usage === 'object' && Object.values(usage).every(value => value === 0))) return 'zero'
  return 'reported'
}
const cost = calls.map(call => ({ id: call.id ?? null, purpose: call.purpose ?? 'agent', provider: call.provider ?? null, model: call.model ?? null, reasoningEffort: call.reasoningEffort ?? null, start: call.start ?? null, first: call.first ?? null, finish: call.finish ?? null, elapsedMs: call.finish !== undefined && call.start !== undefined ? call.finish - call.start : null, reason: call.reason ?? null, usage: call.usage === undefined ? null : call.usage, usageState: usageState(call.usage) }))
const waitedMs = statusRows.map(row => row.summary?.waitedMs).filter(Number.isFinite).at(-1) ?? null
for (const call of awaitCalls) call.waitedMs = waitedMs
const preSteps = statusRows.map(row => ({ time: row.time, stage: row.stage, turn: row.turn ?? null, step: row.step ?? null, generation: row.generation, summary: row.summary ?? null }))
const elapsedAwait = awaitCalls.map(call => call.elapsedMs).filter(Number.isFinite)
const exposedWaitMs = elapsedAwait.length ? elapsedAwait.reduce((sum, value) => sum + value, 0) : waitedMs
const timeline = windows.map(window => {
  const nextForeground = foreground.find(call => window.commitAt !== null && call.start > window.commitAt)
  const boundaryStart = [...statusRows].reverse().find(row => row.stage === 'before-pre-step' && row.time <= window.commitAt)
  const boundaryEnd = statusRows.find(row => row.stage === 'after-pre-step' && row.time >= window.commitAt)
  const boundaryMs = boundaryStart && boundaryEnd ? boundaryEnd.time - boundaryStart.time : null
  const related = handoffs.filter(item => item.windowGeneration === window.generation)
  return { generation: window.generation, preStepBoundaryMs: boundaryMs, commitAt: window.commitAt, commitSeq: window.commitSeq, firstForegroundAfterCommitAt: nextForeground?.start ?? null, firstForegroundAfterCommitMs: nextForeground && window.commitAt !== null ? nextForeground.start - window.commitAt : null, summaryStartAt: summaryCalls.length === 1 ? summaryCalls[0].start ?? null : null, summaryFinishAt: summaryCalls.length === 1 ? summaryCalls[0].finish ?? null : null, handoffs: related.map(item => ({ operationId: item.operationId, pendingAt: item.pendingAt, readyAt: item.readyAt, deliveryAt: item.deliveryAt, classification: item.classification })) }
})
const output = { schemaVersion: 1, kind: 'deferred-handoff-audit', name: result.name, originalRunCompleted: result.completed, originalError: result.error ?? null, finishedAt: result.finishedAt, eventSource, windows: windows.length, appendOnly: contiguous, currentInputProtected, toolPairsBalanced: paired, archiveBytesVerified: archiveComplete, restoredBytes, archivePages, preSteps, timeline, handoffs, streams: { foregroundSerial: foreground.length < 2 || !failures.includes('foreground-streams-not-serial'), summaryInFlightMax: maximumInFlight(summaryCalls), totalInFlightMax: maximumInFlight(calls), calls: cost }, awaitContext: { count: awaitCalls.length, calls: awaitCalls, userVisibleWaitMs: exposedWaitMs, waitedMsFallback: waitedMs, note: 'Only the await_context call interval (or its recorded waitedMs fallback) is user-visible waiting; summary stream elapsed is separate.' }, quality: { independent, dependent }, failures, passedStructuralChecks: failures.length === 0 }
await writeFile(join(root, 'audit.json'), `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ name: output.name, originalRunCompleted: output.originalRunCompleted, windows: output.windows, handoffs: output.handoffs.map(item => ({ operationId: item.operationId, classification: item.classification })), failures: output.failures.length }))
