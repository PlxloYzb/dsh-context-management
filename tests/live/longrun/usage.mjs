// Usage ledger and accounting rules for the muse-longrun-v1 harness.
//
// Protocol section 2.1 fixes six counters that must never be conflated. This
// module owns the normalization rules, the deduplication key
// `(logicalRequestId, streamId, attemptId)`, the conservative reservation that
// must never enter the foreground floor, and the append-only JSONL ledger.
// It has no host dependency and is unit-testable without a running DSH.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'

export const USAGE_SCHEMA_VERSION = 1

/** Accounting classes from INTERFACES.md `accountingOf`. */
export const ACCOUNTING_CLASSES = Object.freeze([
  'foreground', 'summary', 'sentinel', 'final-probe', 'failed', 'cancelled', 'retry', 'unknown',
])

/** Purpose classes the observer must keep apart. `title` must stay absent. */
export const PURPOSE_CLASSES = Object.freeze([
  'main-foreground', 'sentinel-probe', 'final-probe', 'background-summary', 'title', 'other',
])

export const DEFAULT_PURPOSE_MAP = Object.freeze({
  agent: 'main-foreground',
  work: 'main-foreground',
  compaction: 'background-summary',
  'session-title': 'title',
  sentinel: 'sentinel-probe',
  'sentinel-probe': 'sentinel-probe',
  probe: 'final-probe',
  'final-probe': 'final-probe',
})

const KNOWN_PURPOSE_CLASSES = new Set(PURPOSE_CLASSES)

export function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')
}

/**
 * Classify a raw request purpose into one frozen purpose class. This is a
 * declarative mapping, deliberately unrelated to the short harness
 * `promptControlled()` semantics (which timed out and cancelled whole turns).
 */
export function classifyPurpose(rawPurpose, policy = {}) {
  const mapping = policy.purposes ?? DEFAULT_PURPOSE_MAP
  if (rawPurpose === undefined || rawPurpose === null || rawPurpose === '') return policy.defaultClass ?? 'main-foreground'
  if (Object.prototype.hasOwnProperty.call(mapping, rawPurpose)) return mapping[rawPurpose]
  return policy.unknownClass ?? 'other'
}

export function isPurposeClass(value) {
  return KNOWN_PURPOSE_CLASSES.has(value)
}

/**
 * Normalize one raw provider usage object. Cached-read/write and reasoning
 * subtotals are preserved for reporting but never added on top of the
 * input+output/total they are already contained in.
 */
export function normalizeUsageValue(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return { known: false, rule: 'missing-usage', inconsistent: false, normalized: null, raw: raw ?? null }
  }
  const pick = (...names) => {
    for (const name of names) {
      const value = raw[name]
      if (Number.isFinite(value)) return value
    }
    return null
  }
  const inputTokens = pick('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens')
  const outputTokens = pick('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens')
  const totalReported = pick('totalTokens', 'total_tokens', 'total')
  const cacheReadTokens = pick('cacheReadTokens', 'cache_read_input_tokens', 'cacheReadInputTokens')
  const cacheWriteTokens = pick('cacheWriteTokens', 'cache_creation_input_tokens', 'cacheWriteInputTokens')
  const reasoningTokens = pick('reasoningTokens', 'reasoning_tokens')
  const derived = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
  const normalized = { inputTokens, outputTokens, totalTokens: null, cacheReadTokens, cacheWriteTokens, reasoningTokens }
  if (totalReported !== null) {
    normalized.totalTokens = totalReported
    const inconsistent = derived !== null && totalReported !== derived
    return { known: true, rule: inconsistent ? 'reported-total+inconsistent-input-output' : 'reported-total', inconsistent, normalized, raw }
  }
  if (derived !== null) {
    normalized.totalTokens = derived
    return { known: true, rule: 'input+output', inconsistent: false, normalized, raw }
  }
  return { known: false, rule: 'uninterpretable-usage', inconsistent: false, normalized, raw }
}

/** Dedupe key: exactly one contribution per logical request stream attempt. */
export function usageDedupeKey(row) {
  if (!row || typeof row !== 'object') return null
  const logical = row.logicalRequestId ?? row.callId ?? null
  if (logical === null || logical === undefined || logical === '') return null
  const stream = row.streamId ?? null
  const attempt = row.attemptId ?? 'unknown'
  return `${logical}\u0000${stream ?? 'unknown'}\u0000${attempt}`
}

const FAILED_TERMINALS = new Set(['failed', 'error', 'errored', 'timeout', 'incomplete', 'incomplete-stream', 'provider-error'])
const CANCELLED_TERMINALS = new Set(['cancelled', 'canceled', 'aborted', 'stopped'])

/**
 * Map one request/usage row to its accounting class. Explicit product
 * classification wins; failure/cancellation/retry override ordinary purpose.
 */
export function accountingOf(requestRow = {}) {
  const explicit = requestRow.accounting ?? requestRow.accountingClass
  if (explicit) {
    if (ACCOUNTING_CLASSES.includes(explicit)) return explicit
    throw new Error(`UNKNOWN_ACCOUNTING_CLASS: ${explicit}`)
  }
  const terminal = requestRow.terminalState ?? requestRow.status ?? requestRow.terminalReason ?? null
  if (requestRow.cancelled === true || CANCELLED_TERMINALS.has(terminal)) return 'cancelled'
  if (requestRow.failed === true || requestRow.error != null || FAILED_TERMINALS.has(terminal)) return 'failed'
  if (requestRow.retry === true || requestRow.isRetry === true || (Number.isFinite(Number(requestRow.attemptNumber)) && Number(requestRow.attemptNumber) > 1)) return 'retry'
  const purposeClass = requestRow.purposeClass ?? classifyPurpose(requestRow.purpose)
  if (purposeClass === 'sentinel-probe') return 'sentinel'
  if (purposeClass === 'final-probe') return 'final-probe'
  if (purposeClass === 'background-summary') return 'summary'
  if (purposeClass === 'main-foreground') return 'foreground'
  return 'unknown'
}

const SUCCESS_TERMINALS = new Set(['succeeded', 'completed', 'finish', 'finished', undefined, null])

function terminalSucceeded(row) {
  if (row.failed === true || row.cancelled === true) return false
  const terminal = row.terminalState ?? row.status ?? row.terminalReason
  return SUCCESS_TERMINALS.has(terminal)
}

/**
 * Normalize request/usage rows into per-call records and the protocol totals.
 * Cumulative adapters take the final (maximum) cumulative value per dedupe key;
 * a repeated cumulative chunk therefore never double counts. Incremental
 * adapters sum raw chunks and ignore the aggregate normalized row.
 */
export function normalizeUsage(rows, options = {}) {
  const semantics = options.semantics ?? 'cumulative'
  if (!['cumulative', 'incremental'].includes(semantics)) throw new Error(`UNKNOWN_USAGE_SEMANTICS: ${semantics}`)
  const fallbackReserve = Number.isFinite(options.perCallConservativeReserve) ? options.perCallConservativeReserve : null
  const groups = new Map()
  const reservations = new Map()
  for (const row of rows ?? []) {
    if (!row || typeof row !== 'object') continue
    const key = usageDedupeKey(row)
    if (key === null) continue
    if (row.phase === 'reserved') {
      const reserve = firstFinite(row.conservativeReserveTokens, row.reservedExposureTokens, row.reserveTokens)
      const prior = reservations.get(key)
      reservations.set(key, prior === undefined ? reserve : Math.max(prior ?? 0, reserve ?? 0))
      continue
    }
    let group = groups.get(key)
    if (!group) {
      group = { key, rows: [], accounting: null, retry: false, failed: false, cancelled: false, terminalState: null, purposeClass: null, provider: null, model: null, streamId: row.streamId ?? null, logicalRequestId: row.logicalRequestId ?? row.callId ?? null, attemptId: row.attemptId ?? 'unknown', dispatchedAt: null }
      groups.set(key, group)
    }
    group.rows.push(row)
    if (row.accounting ?? row.accountingClass) group.accounting = row.accounting ?? row.accountingClass
    if (row.retry === true || row.isRetry === true) group.retry = true
    if (row.failed === true || row.error != null) group.failed = true
    if (row.cancelled === true) group.cancelled = true
    if (row.terminalState ?? row.status) group.terminalState = row.terminalState ?? row.status
    if (row.purposeClass) group.purposeClass = row.purposeClass
    if (row.provider) group.provider = row.provider
    if (row.model) group.model = row.model
    if (row.streamId) group.streamId = row.streamId
    if (row.dispatchedAt ?? row.dispatchedAtMs) group.dispatchedAt = row.dispatchedAt ?? new Date(row.dispatchedAtMs).toISOString()
  }

  const calls = []
  for (const group of groups.values()) {
    const usageRows = group.rows
      .map(row => {
        const source = row.usageNormalized ?? row.normalizedUsage ?? null
        const raw = row.usageRaw ?? row.usage ?? null
        const normalized = source && Number.isFinite(source.totalTokens)
          ? { known: true, rule: row.usageRule ?? 'provided-normalized', inconsistent: false, normalized: normalizeShape(source), raw }
          : normalizeUsageValue(raw)
        return { row, normalized }
      })
      .filter(entry => entry.row.phase !== 'reserved')

    let chosen = null
    if (semantics === 'incremental') {
      const rawOnly = usageRows.filter(entry => entry.row.phase !== 'normalized')
      const pool = rawOnly.length ? rawOnly : usageRows
      let total = 0, found = false, rule = 'incremental-sum', inconsistent = false
      let shape = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null }
      for (const entry of pool) {
        if (!entry.normalized.known) continue
        found = true
        total += entry.normalized.normalized.totalTokens
        inconsistent = inconsistent || entry.normalized.inconsistent
        shape = mergeShapes(shape, entry.normalized.normalized)
      }
      if (found) chosen = { known: true, rule, inconsistent, normalized: { ...shape, totalTokens: total } }
    } else {
      for (const entry of usageRows) {
        if (!entry.normalized.known) continue
        if (chosen === null || entry.normalized.normalized.totalTokens >= chosen.normalized.totalTokens) {
          chosen = { known: true, rule: entry.normalized.rule, inconsistent: entry.normalized.inconsistent, normalized: entry.normalized.normalized }
        }
      }
    }

    const explicit = group.accounting
    const accounting = explicit ?? accountingOf({
      purposeClass: group.purposeClass,
      retry: group.retry,
      failed: group.failed,
      cancelled: group.cancelled,
      terminalState: group.terminalState,
    })
    const purposeClass = group.purposeClass ?? (accounting === 'summary' ? 'background-summary' : accounting === 'sentinel' ? 'sentinel-probe' : accounting === 'final-probe' ? 'final-probe' : accounting === 'foreground' ? 'main-foreground' : 'other')
    const unknownReason = chosen === null ? (group.rows.length ? 'no-usable-usage' : 'no-dispatch-record') : null
    const reserve = reservations.get(group.key)
    calls.push({
      callKey: group.key,
      logicalRequestId: group.logicalRequestId,
      streamId: group.streamId,
      attemptId: group.attemptId,
      attemptIdentity: group.attemptId === 'unknown' ? 'unknown' : 'explicit',
      purposeClass,
      accounting,
      provider: group.provider,
      model: group.model,
      terminalState: group.terminalState,
      dispatchedAt: group.dispatchedAt,
      known: chosen !== null,
      rule: chosen?.rule ?? null,
      inconsistent: chosen?.inconsistent ?? false,
      totalTokens: chosen?.normalized.totalTokens ?? null,
      inputTokens: chosen?.normalized.inputTokens ?? null,
      outputTokens: chosen?.normalized.outputTokens ?? null,
      cacheReadTokens: chosen?.normalized.cacheReadTokens ?? null,
      cacheWriteTokens: chosen?.normalized.cacheWriteTokens ?? null,
      reasoningTokens: chosen?.normalized.reasoningTokens ?? null,
      unknownReason,
      conservativeReserveTokens: reserve ?? null,
      reservedExposureTokens: 0,
      rowCount: group.rows.length,
    })
  }

  let foregroundVerifiedTokens = 0
  let allReportedTokens = 0
  let probeReportedTokens = 0
  let summaryReportedTokens = 0
  const byAccounting = {}
  for (const name of ACCOUNTING_CLASSES) byAccounting[name] = { calls: 0, knownCalls: 0, unknownCalls: 0, knownTokens: 0, reservedExposureTokens: 0 }
  for (const call of calls) {
    const bucket = byAccounting[call.accounting]
    bucket.calls += 1
    if (call.known) {
      bucket.knownCalls += 1
      bucket.knownTokens += call.totalTokens
      allReportedTokens += call.totalTokens
      if (call.accounting === 'foreground' && terminalSucceeded({ terminalState: call.terminalState, failed: false, cancelled: false })) foregroundVerifiedTokens += call.totalTokens
      if (call.accounting === 'sentinel' || call.accounting === 'final-probe') probeReportedTokens += call.totalTokens
      if (call.accounting === 'summary') summaryReportedTokens += call.totalTokens
    } else {
      bucket.unknownCalls += 1
    }
  }

  // Reservations never touch the floor: they are a separate conservative number.
  const unknownUsageCalls = []
  let reservedExposureTokens = 0
  const callKeys = new Set(calls.map(call => call.callKey))
  for (const call of calls) {
    if (call.known) continue
    const reserve = call.conservativeReserveTokens ?? fallbackReserve ?? 0
    call.reservedExposureTokens = reserve
    byAccounting[call.accounting].reservedExposureTokens += reserve
    reservedExposureTokens += reserve
    unknownUsageCalls.push({
      callKey: call.callKey,
      logicalRequestId: call.logicalRequestId,
      streamId: call.streamId,
      attemptId: call.attemptId,
      accounting: call.accounting,
      purposeClass: call.purposeClass,
      provider: call.provider,
      model: call.model,
      known: false,
      totalTokens: null,
      reason: call.unknownReason,
      dispatchedAt: call.dispatchedAt,
      reservedExposureTokens: reserve,
    })
  }
  // A reservation with no matching usage/request row is still an unknown call.
  // A reservation whose call later reported usage is superseded, not extra.
  for (const [key, reserve] of reservations) {
    if (callKeys.has(key)) continue
    const value = reserve ?? fallbackReserve ?? 0
    reservedExposureTokens += value
    const [logical, stream, attempt] = key.split('\u0000')
    unknownUsageCalls.push({
      callKey: key,
      logicalRequestId: logical,
      streamId: stream === 'unknown' ? null : stream,
      attemptId: attempt,
      accounting: 'unknown',
      purposeClass: 'other',
      provider: null,
      model: null,
      known: false,
      totalTokens: null,
      reason: 'reserved-without-usage-row',
      dispatchedAt: null,
      reservedExposureTokens: value,
    })
  }

  const titleCalls = calls.filter(call => call.purposeClass === 'title')
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    semantics,
    calls,
    requests: calls,
    counts: { calls: calls.length, knownUsageCalls: calls.length - unknownUsageCalls.length, unknownUsageCalls: unknownUsageCalls.length },
    byAccounting,
    foregroundVerifiedTokens,
    allReportedTokens,
    probeReportedTokens,
    summaryReportedTokens,
    unknownUsageCalls,
    unknownUsageCallCount: unknownUsageCalls.length,
    reservedExposureTokens,
    titleCalls,
    titleCallsAbsent: titleCalls.length === 0,
    reservationsCountTowardFloor: false,
  }
}

function firstFinite(...values) {
  for (const value of values) if (Number.isFinite(value)) return value
  return null
}

function normalizeShape(source) {
  return {
    inputTokens: Number.isFinite(source.inputTokens) ? source.inputTokens : null,
    outputTokens: Number.isFinite(source.outputTokens) ? source.outputTokens : null,
    totalTokens: Number.isFinite(source.totalTokens) ? source.totalTokens : null,
    cacheReadTokens: Number.isFinite(source.cacheReadTokens) ? source.cacheReadTokens : null,
    cacheWriteTokens: Number.isFinite(source.cacheWriteTokens) ? source.cacheWriteTokens : null,
    reasoningTokens: Number.isFinite(source.reasoningTokens) ? source.reasoningTokens : null,
  }
}

function mergeShapes(target, source) {
  const merged = { ...target }
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (Number.isFinite(source[key])) merged[key] = (Number.isFinite(merged[key]) ? merged[key] : 0) + source[key]
  }
  return merged
}

/**
 * One page identity presented to the model counts once for the coverage gate,
 * regardless of how many requests re-sent it.
 */
export function exposedSourcePageSet(pages) {
  const set = new Map()
  for (const entry of pages ?? []) {
    const page = normalizePageEntry(entry)
    if (page.id === null || page.id === undefined || page.id === '') continue
    if (set.has(page.id)) continue
    set.set(page.id, page)
  }
  return set
}

export function uniqueExposedSourceTokens(pages, heuristicTokens) {
  const set = exposedSourcePageSet(pages)
  let total = 0
  for (const page of set.values()) total += pageHeuristicTokens(page, heuristicTokens)
  return total
}

function normalizePageEntry(entry) {
  if (entry === null || entry === undefined) return { id: null, text: '', tokens: null }
  if (typeof entry === 'number' || typeof entry === 'string') return { id: entry, text: '', tokens: null }
  const id = entry.page ?? entry.pageNumber ?? entry.id ?? null
  const text = typeof entry.text === 'string' ? entry.text : ''
  const tokens = Number.isFinite(entry.tokens) ? entry.tokens : Number.isFinite(entry.heuristicTokens) ? entry.heuristicTokens : null
  return { id, text, tokens }
}

function pageHeuristicTokens(page, heuristicTokens) {
  if (Number.isFinite(page.tokens)) return page.tokens
  if (typeof heuristicTokens === 'function') {
    const value = heuristicTokens(page.text ?? '', page)
    if (Number.isFinite(value)) return value
    return 0
  }
  if (Number.isFinite(heuristicTokens)) return heuristicTokens
  if (heuristicTokens instanceof Map) {
    const value = heuristicTokens.get(page.id)
    return Number.isFinite(value) ? value : 0
  }
  if (heuristicTokens && typeof heuristicTokens === 'object') {
    const value = heuristicTokens[page.id]
    return Number.isFinite(value) ? value : 0
  }
  return 0
}

/**
 * Read a JSONL file. A torn trailing line (writer still appending) is returned
 * as `tornTail` and never parsed; a malformed complete line in the middle is a
 * hard error (`malformedMiddleJsonlIgnored` is false in the frozen plan).
 */
export function readJsonl(path, { tolerateTornTail = true } = {}) {
  if (!existsSync(path)) return { path, rows: [], tornTail: '', completeBytes: 0, lineCount: 0 }
  const text = readFileSync(path, 'utf8')
  const lastNewline = text.lastIndexOf('\n')
  let body = ''
  let tornTail = ''
  if (lastNewline === -1) tornTail = text
  else if (lastNewline === text.length - 1) body = text
  else {
    body = text.slice(0, lastNewline + 1)
    tornTail = text.slice(lastNewline + 1)
  }
  if (tornTail && !tolerateTornTail) throw new Error(`JSONL_TORN_TAIL: ${path}`)
  const rows = []
  if (body) {
    const lines = body.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (!line) continue
      try {
        rows.push(JSON.parse(line))
      } catch (error) {
        throw new Error(`JSONL_MALFORMED_MIDDLE: ${path} line ${index + 1}: ${error.message}`)
      }
    }
  }
  return { path, rows, tornTail, completeBytes: Buffer.byteLength(body), lineCount: rows.length }
}

export function appendJsonlRow(path, row) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(row) + '\n', { mode: 0o600 })
}

const ACTIVE_LEDGERS = new Set()

/**
 * Append-only usage ledger with a single writer per file. `recordChunk` writes
 * one row per raw usage chunk; `recordNormalized` writes the final normalized
 * row. Both share the dedupe key so a repeated cumulative chunk cannot double
 * count when the ledger is read back.
 */
export function createUsageLedger({ file, runId = null, semantics = 'cumulative', writerId = null, perCallConservativeReserve = null } = {}) {
  if (!file) throw new Error('createUsageLedger requires a file')
  const path = resolve(file)
  if (ACTIVE_LEDGERS.has(path)) throw new Error(`USAGE_LEDGER_MULTIPLE_WRITERS: ${path}`)
  ACTIVE_LEDGERS.add(path)
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, 'a', 0o600)
  closeSync(fd)
  const id = writerId ?? `writer-${process.pid}-${Math.random().toString(16).slice(2, 10)}`
  const append = row => appendJsonlRow(path, { schemaVersion: USAGE_SCHEMA_VERSION, time: new Date().toISOString(), runId, writerId: id, ...row })
  const keyOf = row => {
    const key = usageDedupeKey(row)
    if (key === null) throw new Error('usage ledger row requires logicalRequestId/streamId/attemptId')
    return key
  }
  return {
    path,
    writerId: id,
    semantics,
    perCallConservativeReserve,
    recordChunk(row, rawUsage) {
      const normalized = normalizeUsageValue(rawUsage)
      append({ ...row, phase: 'raw', callKey: keyOf(row), usageRaw: rawUsage ?? null, usageNormalized: normalized.normalized, usageKnown: normalized.known, usageRule: normalized.rule })
      return normalized
    },
    recordNormalized(row, normalizedValue) {
      const normalized = normalizedValue ?? normalizeUsageValue(row.usageRaw ?? row.usage ?? null)
      append({ ...row, phase: 'normalized', callKey: keyOf(row), usageRaw: row.usageRaw ?? row.usage ?? null, usageNormalized: normalized.normalized, usageKnown: normalized.known, usageRule: normalized.rule })
      return normalized
    },
    recordReservation(row, conservativeReserveTokens = null) {
      const reserve = Number.isFinite(conservativeReserveTokens)
        ? conservativeReserveTokens
        : Number.isFinite(row.conservativeReserveTokens)
          ? row.conservativeReserveTokens
          : perCallConservativeReserve
      append({ ...row, phase: 'reserved', callKey: keyOf(row), conservativeReserveTokens: reserve ?? null })
      return reserve
    },
    read() {
      return readJsonl(path)
    },
    totals(options = {}) {
      const read = readJsonl(path)
      return normalizeUsage(read.rows, { semantics, perCallConservativeReserve, ...options })
    },
    close() {
      ACTIVE_LEDGERS.delete(path)
    },
  }
}

/**
 * The six required totals, always reported separately. `officialFloor` is the
 * only number that may be compared with the 3M gate; reservations and unknown
 * usage stay outside it.
 */
export function summarizeUsage(options = {}) {
  const normalized = normalizeUsage(options.rows ?? [], { semantics: options.semantics, perCallConservativeReserve: options.perCallConservativeReserve })
  const uniqueExposed = uniqueExposedSourceTokens(options.exposedPages ?? [], options.heuristicTokens)
  const projected = typeof options.projectedTokens === 'function' ? options.projectedTokens() : options.projectedTokens
  const currentProjectedTokens = Number.isFinite(projected) ? projected : null
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    mode: options.mode ?? 'observe',
    foregroundVerifiedTokens: normalized.foregroundVerifiedTokens,
    allReportedTokens: normalized.allReportedTokens,
    unknownUsageCalls: normalized.unknownUsageCalls,
    unknownUsageCallCount: normalized.unknownUsageCallCount,
    reservedExposureTokens: normalized.reservedExposureTokens,
    uniqueExposedSourceTokens: uniqueExposed,
    currentProjectedTokens,
    probeReportedTokens: normalized.probeReportedTokens,
    summaryReportedTokens: normalized.summaryReportedTokens,
    titleCallsAbsent: normalized.titleCallsAbsent,
    byAccounting: normalized.byAccounting,
    counts: normalized.counts,
    officialFloorTokens: normalized.foregroundVerifiedTokens,
    floorIncludesReservations: false,
    floorIncludesProbes: false,
    floorIncludesSummaries: false,
  }
}
