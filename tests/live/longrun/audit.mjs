// Independent audit. It consumes only durable artifacts (events, requests,
// receipts, control journals) and never the live session or the scorer.
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runDirectory, readJson, atomicJson } from './context.mjs'
import { observedEvents } from '../local/observed-events.mjs'
import { summarizeUsage } from './usage.mjs'

const sha256 = value => createHash('sha256').update(value).digest('hex')

function readJsonl(path) {
  if (!existsSync(path)) return { rows: [], malformed: [], tornTail: '' }
  const text = readFileSync(path, 'utf8')
  const lastNewline = text.lastIndexOf('\n')
  const body = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1)
  const tornTail = lastNewline === -1 ? text : text.slice(lastNewline + 1)
  const rows = [], malformed = []
  for (const line of body.split('\n')) {
    if (!line) continue
    try { rows.push(JSON.parse(line)) } catch { malformed.push(line) }
  }
  return { rows, malformed, tornTail }
}

export async function auditRun({ campaign, pairId, arm, runId }) {
  const root = runDirectory(campaign, pairId, arm, runId)
  const run = await readJson(join(root, 'run.json'))
  const progress = await readJson(join(root, 'progress.json'), {})
  const requests = readJsonl(join(root, 'observed', 'requests.jsonl'))
  const jobs = readJsonl(join(root, 'summary-jobs.jsonl'))
  const access = readJsonl(join(root, 'control', 'tool-access.jsonl'))
  const sessionId = run.sessionId ?? progress.sessionId ?? await resolveSessionId(root)
  if (!sessionId) return { schemaVersion: 1, runId, arm, auditError: 'NO_SESSION_ID', integrityPassed: false, coveragePassed: false }
  // The snapshot is written asynchronously; wait for it to stop growing before
  // judging tool pairing, so a half-flushed checkpoint is never a failure.
  const events = await settledEvents(join(root, 'observed'), sessionId)
  const pageTokens = readJsonSync(join(root, 'control', 'page-tokens.json'), null)
  const exposedPages = readExposedPageNumbers(root)
  const usage = summarizeUsage({
    rows: requests.rows,
    exposedPages,
    heuristicTokens: pageTokens ?? undefined,
  })
  const integrity = integrityChecks({ run, root, requests: requests.rows, jobs: jobs.rows, access: access.rows, events, progress })
  // The probe-clean long-tail count is an observation the SCORER makes, so the
  // audit reads it rather than recomputing it. A re-asked probe writes
  // `score-reprobe.json`; preferring it keeps the audit consistent with the
  // measurement the report quotes.
  const score = readJsonSync(join(root, 'score-reprobe.json'), null) ?? readJsonSync(join(root, 'score.json'), null)
  const coverage = coverageChecks({ plan: run.protocol.geometry, run, progress, events, jobs: jobs.rows, requests: requests.rows, exposedPages, pageTokens, score })
  const audit = {
    schemaVersion: 1, runId, arm, campaign, pairId, auditedAt: new Date().toISOString(),
    integrity, coverage, usage,
    retrieval: retrievalStatistics(events),
    evidenceBytes: await directoryBytes(root),
    malformedRequestLines: requests.malformed.length,
    tornRequestTail: requests.tornTail.length > 0,
    integrityPassed: Object.values(integrity).every(row => row.status === 'PASS' || row.status === 'NOT_APPLICABLE'),
    coveragePassed: coverage.passed,
  }
  await atomicJson(join(root, 'audit.json'), audit)
  return audit
}

// The single per-run terminal record. Every dimension is separate; a failure is
// never collapsed into one boolean and never converted into a pass.
export async function writeResult({ campaign, pairId, arm, runId }) {
  const root = runDirectory(campaign, pairId, arm, runId)
  const progress = await readJson(join(root, 'progress.json'), {})
  const audit = await readJson(join(root, 'audit.json'), null)
  const score = await readJson(join(root, 'score.json'), null)
  const usage = audit?.usage ?? {}
  const coverage = audit?.coverage ?? {}
  const quality = score ?? null
  const result = {
    schemaVersion: 1, runId, arm, campaign, pairId,
    finalizedAt: new Date().toISOString(),
    terminalReason: progress.terminalReason ?? null,
    executionCompleted: progress.terminalReason === 'COMPLETED',
    tokenFloorMet: (usage.foregroundVerifiedTokens ?? 0) >= 3000000,
    coveragePassed: coverage.passed === true,
    integrityPassed: audit?.integrityPassed ?? null,
    qualityPassed: quality?.qualityPassed ?? null,
    latencyTargetMet: progress.latencyTargetMet ?? null,
    performanceTargetIncludedInReliability: false,
    reliabilityAccepted: progress.terminalReason === 'COMPLETED' && coverage.passed === true && audit?.integrityPassed === true && quality?.qualityPassed === true,
    coverage: coverage.commonCoverage ?? null,
    arcCoverage: coverage.arcCoverage ?? null,
    basicCoverage: coverage.basicCoverage ?? null,
    quality: quality ? { correct: quality.total, denominator: quality.questionCount, perQuartile: quality.perQuartile, requiredLatestUser: quality.requiredLatestUser, longTailRequired: quality.longTailRequired, formatReason: quality.formatReason ?? null } : null,
    usage: {
      foregroundVerifiedTokens: usage.foregroundVerifiedTokens ?? 0,
      allReportedTokens: usage.allReportedTokens ?? 0,
      unknownUsageCalls: usage.unknownUsageCallCount ?? 0,
      reservedExposureTokens: usage.reservedExposureTokens ?? 0,
      uniqueExposedSourceTokens: usage.uniqueExposedSourceTokens ?? 0,
      currentProjectedTokens: usage.currentProjectedTokens ?? null,
    },
    coverageGaps: coverage.arcCoverage ? Object.entries(coverage.arcCoverage).filter(([, value]) => value === 0).map(([key]) => key) : [],
  }
  await atomicJson(join(root, 'result.json'), result)
  return result
}

function integrityChecks({ run, root, requests, jobs, access, events, progress }) {
  const checks = {}
  const route = run.protocol.geometry ? run.protocol.geometry : null
  const expectedRoute = run.command?.compaction?.kind === 'arc-windowed' || run.command?.compaction?.kind === 'native-basic' ? run.command : null
  const routeRows = requests.filter(row => row.provider && row.model)
  const badRoute = routeRows.filter(row => row.provider !== 'opencode-go-muse' || row.model !== 'muse-spark-1.3-contributor')
  const badEffort = routeRows.filter(row => row.effectiveReasoningEffort !== undefined && row.effectiveReasoningEffort !== 'minimal')
  const titleRows = routeRows.filter(row => row.purpose === 'title' || row.purpose === 'session-title')
  checks.I01 = {
    status: badRoute.length === 0 && badEffort.length === 0 && titleRows.length === 0 ? 'PASS' : 'FAILED_PRODUCT',
    detail: { requestCount: routeRows.length, badRoute: badRoute.length, badEffort: badEffort.length, titleStreams: titleRows.length },
  }
  // The user's input must survive the replacement that follows it.
  const replacedAfterUser = events.filter((event, index) => event.type === 'user/message' && events.slice(index + 1).some(later => later.type === 'compaction/summary' && later.seq > event.seq))
  const pairingProblems = toolPairingProblems(events)
  checks.I02 = {
    status: pairingProblems.length === 0 ? 'PASS' : 'FAILED_PRODUCT',
    detail: { userTurnsBeforeSummary: replacedAfterUser.length, pairingProblems: pairingProblems.slice(0, 5) },
  }
  const seqs = events.map(event => event.seq)
  const monotonic = seqs.every((seq, index) => index === 0 || seq > seqs[index - 1])
  const gaps = seqs.filter((seq, index) => index > 0 && seq !== seqs[index - 1] + 1)
  checks.I03 = {
    status: monotonic && gaps.length === 0 ? 'PASS' : 'INVALID_EVIDENCE',
    detail: { eventCount: seqs.length, monotonic, gaps: gaps.length },
  }
  // Exposure comes from the fixture tool's durable access journal, so a page
  // counts only when the tool actually returned it to the model, and a later
  // final-replay audit can re-check the same rows.
  const readPages = new Set(access.filter(row => row.status === 'READ' && Number.isSafeInteger(row.page)).map(row => row.page))
  const assignedCount = progress.coverage?.assignedPages ?? null
  // Boundedness is about the highest assigned page number, not the count: the
  // count is a set size and can legitimately be smaller than a page number.
  // Bound comes from the durable assignment journal when present; the recorded
  // per-episode control window is the authority for what was readable.
  const assignments = readAssignmentBounds(root)
  const assignedEnd = assignments.maxPage ?? progress.coverage?.assignedPageEnd ?? null
  const outsideAssignment = assignedEnd === null ? [] : access.filter(row => row.status === 'READ' && Number.isSafeInteger(row.page) && row.page > assignedEnd)
  const recovery = listRecoveryFiles(root)
  // A recovery record explains WHY the bound was exceeded; it does not restore
  // the boundedness claim. An explained violation stays non-PASS and is marked
  // as a harness defect so the product is not blamed for the operator's own
  // intervention.
  const attributed = outsideAssignment.length > 0 && recovery.length > 0
  checks.I04 = {
    status: outsideAssignment.length === 0 ? 'PASS' : attributed ? 'INVALID_EVIDENCE' : 'FAILED_PRODUCT',
    detail: {
      exposedPages: readPages.size, assignedPages: assignedCount, assignedPageEnd: assignedEnd,
      readsOutsideAssignment: outsideAssignment.length,
      outsideAssignmentCause: outsideAssignment.length === 0 ? null : recovery.length > 0 ? 'harness-defect' : 'product-or-unknown',
      outsideAssignmentDetail: attributed
        ? 'Operator recovery re-drove episodes past the sealed endpoint, so the page-boundedness claim for this run is compromised; the product did not widen its own assignment window.'
        : outsideAssignment.length > 0 ? 'Pages were returned beyond the recorded assignment window with no recorded operator recovery.' : null,
      recoveryRecords: recovery,
      repeatedReads: access.filter(row => row.status === 'READ' && row.repeated === true).length,
    },
  }
  // Count per OPERATION, from the receipt rows only.
  //
  // The ledger carries several rows per operation (`started`, `receipt`,
  // `consumed`/`unconsumed`, `termination`) and a termination row for a delivered
  // job repeats `status: 'delivered'` with no receiptSeq. Counting rows therefore
  // reported one operation twice AND reported a missing receipt for the same
  // operation — three operations produced `duplicateOperation: 3,
  // missingReceipt: 3` on a run where every delivery had a durable receipt.
  // Duplicates now mean two delivered RECEIPTS for one operation, which is the
  // product behaviour worth catching.
  const receipts = jobs.filter(row => row.phase === 'receipt' && row.status === 'delivered')
  const byOperation = new Map()
  for (const row of receipts) {
    const prior = byOperation.get(row.operationId)
    if (prior === undefined) {
      byOperation.set(row.operationId, { receipts: 1, receiptSeq: Number.isSafeInteger(row.receiptSeq) ? row.receiptSeq : null, sourceHash: row.sourceHash ?? null })
      continue
    }
    prior.receipts += 1
    if (prior.receiptSeq === null && Number.isSafeInteger(row.receiptSeq)) prior.receiptSeq = row.receiptSeq
    prior.sourceHash = prior.sourceHash ?? row.sourceHash ?? null
  }
  const duplicateOperation = [...byOperation.values()].reduce((total, entry) => total + (entry.receipts - 1), 0)
  const missingReceipt = [...byOperation.values()].filter(entry => entry.receiptSeq === null).length
  const sourceHashCount = new Set([...byOperation.values()].map(entry => entry.sourceHash).filter(Boolean)).size
  checks.I05 = {
    status: duplicateOperation === 0 && missingReceipt === 0 ? 'PASS' : 'FAILED_PRODUCT',
    detail: { deliveredOperations: byOperation.size, deliveredReceipts: receipts.length, distinctSourceHashes: sourceHashCount, duplicateOperation, missingReceipt },
  }
  const foreignSessions = requests.filter(row => row.purpose === 'agent' && row.sessionId && run.sessionId && row.sessionId !== run.sessionId)
  const secretAccess = access.filter(row => row.status === 'ALLOWED' && /oracle|hidden-salt|endpoint-probes/.test(row.name ?? ''))
  checks.I06 = {
    status: foreignSessions.length === 0 && secretAccess.length === 0 ? 'PASS' : 'INVALID_LEAKAGE',
    detail: { foreignSessions: foreignSessions.length, secretAccess: secretAccess.length, deniedAttempts: access.filter(row => row.status === 'DENIED').length },
  }
  // I07 must be proven from evidence, never asserted. ARC has to show the
  // plugin resolved as the active backend in the arm's own realm; the Basic arm
  // has to show the shipped native engine and no plugin bundle.
  const armBackend = readArmBackend(root)
  const pluginBackend = readPluginBackend(events)
  const bundleInstalled = run.command?.pluginBundle === true
  if (run.arm === 'ARC_DEFERRED') {
    const problems = []
    if (!bundleInstalled) problems.push('plugin bundle was not installed for the ARC arm')
    if (pluginBackend === null) problems.push('no arc_status backend evidence in the observed event stream')
    else {
      if (pluginBackend.status !== 'active') problems.push(`plugin backend reported status ${pluginBackend.status}`)
      if (pluginBackend.resolvedBackend !== 'dsh-context-management') problems.push(`plugin backend resolved ${pluginBackend.resolvedBackend}`)
    }
    checks.I07 = {
      status: problems.length === 0 ? 'PASS' : 'INVALID_EVIDENCE',
      detail: { arm: run.arm, pluginBundle: bundleInstalled, compaction: run.command?.compaction?.kind ?? null, pluginBackend, problems },
    }
  } else {
    const problems = []
    if (bundleInstalled) problems.push('the plugin bundle was installed in a Basic arm realm')
    if (armBackend === null) problems.push('no arm-configuration backend evidence')
    else if (armBackend !== 'BasicCompactionEngine') problems.push(`Basic arm resolved ${armBackend}`)
    if (pluginBackend !== null) problems.push('the plugin reported itself active in a Basic arm realm')
    checks.I07 = {
      status: problems.length === 0 ? 'PASS' : 'INVALID_EVIDENCE',
      detail: { arm: run.arm, pluginBundle: bundleInstalled, compaction: run.command?.compaction?.kind ?? null, backend: armBackend, problems },
    }
  }
  const launches = readJsonSync(join(root, 'host', 'launches.json'), [])
  checks.I08 = {
    status: launches.length === 0 ? 'NOT_APPLICABLE' : 'PASS',
    detail: { launches: launches.map(row => ({ pid: row.pid, launchId: row.launchId }) ) },
  }
  return checks
}

// Bounded-retrieval behaviour for this run. Zero-hit pages that stopped at the
// scan budget are untested pages, not evidence of absence, so they are counted
// separately from genuine zero-hit scans that reached the end of the archive.
export function retrievalStatistics(events) {
  const calls = new Map()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.name === 'search_context') calls.set(event.data.callId, event.data.arguments ?? {})
  }
  const stats = { searches: 0, zeroHit: 0, scanBudgetReached: 0, zeroHitScanCapped: 0, hits: 0, absentConfirmed: 0, cursorResumes: 0 }
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const callId = event.data?.message?.source?.callId
    if (!calls.has(callId)) continue
    stats.searches += 1
    if (calls.get(callId).cursor !== undefined) stats.cursorResumes += 1
    // 0.1.7 tool results are flat `{ type: 'text', text }` blocks; 0.1.2 wrapped
    // them in a `{ type: 'tool-result', content: [...] }` block. Reading only the
    // nested shape left the text empty, so a perfectly good `arc_status` result
    // was never recognised as backend evidence.
    let text = ''
    for (const block of event.data.message.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') text += block.text
      for (const inner of block.content ?? []) if (inner.type === 'text') text += inner.text
    }
    let parsed
    try { parsed = JSON.parse(text) } catch { continue }
    const hits = parsed?.hits ?? []
    stats.hits += hits.length
    if (parsed?.scanBudgetReached === true) stats.scanBudgetReached += 1
    if (hits.length === 0) {
      stats.zeroHit += 1
      if (parsed?.scanBudgetReached === true) stats.zeroHitScanCapped += 1
    }
    if (parsed?.absent === true) stats.absentConfirmed += 1
  }
  return stats
}

// The plugin's own arc_status output is durable in the observed event stream and
// is the arm's self-report of its resolved backend.
function readPluginBackend(events) {
  const calls = new Map()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.name === 'arc_status') calls.set(event.data.callId, event.seq)
  }
  let found = null
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const callId = event.data?.message?.source?.callId
    if (!calls.has(callId)) continue
    // 0.1.7 tool results are flat `{ type: 'text', text }` blocks; 0.1.2 wrapped
    // them in a `{ type: 'tool-result', content: [...] }` block. Reading only the
    // nested shape left the text empty, so a perfectly good `arc_status` result
    // was never recognised as backend evidence.
    let text = ''
    for (const block of event.data.message.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') text += block.text
      for (const inner of block.content ?? []) if (inner.type === 'text') text += inner.text
    }
    try {
      const parsed = JSON.parse(text)
      if (parsed?.backend) found = { ...parsed.backend, atSeq: event.seq }
    } catch { /* non-JSON arc_status output is not evidence */ }
  }
  return found
}

function readArmBackend(root) {
  try {
    const rows = readFileSync(join(root, 'arm-configuration.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    return rows.at(-1)?.backend ?? null
  } catch { return null }
}

// The session id is durable in the control directory even when a run document
// was written before the session existed.
async function resolveSessionId(root) {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(join(root, 'control')).catch(() => [])
  const match = entries.find(name => name.endsWith('.session.json'))
  if (!match) return null
  const value = JSON.parse(readFileSync(join(root, 'control', match), 'utf8'))
  return value.sessionId ?? null
}

// The highest page the run was ever allowed to read. The durable assignment
// journal is authoritative; a run that predates it falls back to the highest
// episode whose bounded work turn completed, times the fixed episode length.
function readAssignmentBounds(root) {
  let maxPage = null, rows = 0
  for (const name of readdirSync(join(root, 'control'))) {
    if (!name.endsWith('.assignments.jsonl')) continue
    for (const line of readFileSync(join(root, 'control', name), 'utf8').split('\n')) {
      if (!line) continue
      try {
        const row = JSON.parse(line)
        if (Number.isSafeInteger(row.lastPage)) { maxPage = maxPage === null ? row.lastPage : Math.max(maxPage, row.lastPage); rows++ }
      } catch { /* torn tail */ }
    }
  }
  if (maxPage !== null) return { maxPage, rows, source: 'assignment-journal' }
  const dispatch = readJsonl(join(root, 'dispatch.jsonl'))
  let lastEpisode = 0
  for (const row of dispatch.rows) {
    const match = /^E(\d+)-WORK$/.exec(row.logicalPromptId ?? '')
    if (match && row.phase === 'completed') lastEpisode = Math.max(lastEpisode, Number(match[1]))
  }
  return { maxPage: lastEpisode > 0 ? lastEpisode * 12 : null, rows: 0, source: 'completed-episodes' }
}

export function readExposedPageNumbers(root) {
  const access = readJsonl(join(root, 'control', 'tool-access.jsonl'))
  return [...new Set(access.rows.filter(row => row.status === 'READ' && Number.isSafeInteger(row.page)).map(row => row.page))]
    .sort((a, b) => a - b)
    .map(page => ({ page, id: page }))
}

function listRecoveryFiles(root) {
  try { return readdirSync(join(root, 'recovery')).filter(name => name.startsWith('resume-') || name.startsWith('probe-recovery-')) }
  catch { return [] }
}

function readJsonSync(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

// A tool call is paired when its result exists in the durable history. Results
// arrive as their own tool/result events, not embedded in assistant messages.
export function toolPairingProblems(events) {
  const open = new Map(), results = new Set()
  for (const event of events) {
    if (event.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        if (block.type === 'tool-call') open.set(block.id ?? block.callId, event.seq)
      }
    }
    if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId ?? event.data?.callId
      if (callId) results.add(callId)
    }
    if (event.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        if (block.type === 'tool-result' && (block.toolCallId ?? block.callId)) results.add(block.toolCallId ?? block.callId)
      }
    }
  }
  return [...open].filter(([callId]) => !results.has(callId)).map(([callId, seq]) => ({ callId, seq }))
}

// Frozen by the protocol: every endpoint seals exactly 96 questions.
const REQUIRED_FINAL_PROBE_COUNT = 96

// The six most recent windows are the working set; everything older is the tail.
const SIX_RECENT_WINDOWS = 6

/**
 * Derive the ARC block lineage from the observed summaries.
 *
 * A summary's own block is its `compactionId`, and `parentBlockIds` names the
 * blocks it descends from — so the lineage is a real graph in the evidence, not a
 * counter. Depth is the longest ancestry chain; a block is a re-archive when its
 * parent had already been delivered as a handoff, which is exactly the "old
 * summary compressed again" condition the protocol wants to observe.
 */
export function blockLineage(windows, deliveredOperations = new Set()) {
  // The block's own id is `event.data.compactionId`; `contextManagement` does not
  // carry it. `parentBlockIds` reference those ids, which is what makes the
  // lineage a real graph rather than a counter.
  const byId = new Map()
  for (const event of windows) {
    const id = event.data?.compactionId
    if (typeof id === 'string') byId.set(id, event.data?.contextManagement ?? {})
  }
  const depthOf = (id, seen = new Set()) => {
    if (seen.has(id)) return 0
    seen.add(id)
    const cm = byId.get(id)
    if (!cm) return 0
    const parents = (cm.parentBlockIds ?? []).filter(parent => byId.has(parent))
    if (!parents.length) return 1
    return 1 + Math.max(...parents.map(parent => depthOf(parent, new Set(seen))))
  }
  let maxDepth = 0, rearchivedDelivered = 0
  for (const [id, cm] of byId) {
    maxDepth = Math.max(maxDepth, depthOf(id))
    // The parent was delivered if its handoff reached a delivered receipt in the
    // job ledger. The summary event itself only ever carries `pending`: delivery
    // happens later, so the ledger is the authority for this question.
    const parents = (cm.parentBlockIds ?? []).filter(parent => byId.has(parent))
    if (parents.length && parents.some(parent => deliveredOperations.has(byId.get(parent)?.pendingHandoff?.operationId))) rearchivedDelivered += 1
  }
  return { blocks: byId.size, maxDepth, rearchivedDelivered }
}

function coverageChecks({ plan, run, progress, events, jobs, requests, exposedPages, pageTokens, score = null }) {
  const usage = summarizeUsage({ rows: requests, exposedPages, heuristicTokens: pageTokens ?? undefined })
  // A committed ARC window is the compaction/summary row carrying sealed window
  // metadata; native Basic summaries have no contextManagement extension and are
  // counted separately as the Basic arm's own compactions.
  const windows = events.filter(event => event.type === 'compaction/summary' && event.data?.contextManagement?.kind === 'window')
  const generations = new Set(windows.map(event => event.data?.contextManagement?.generationAfter).filter(Number.isSafeInteger))
  const delivered = jobs.filter(row => row.status === 'delivered')
  const distinctDelivered = new Set(delivered.map(row => row.operationId)).size
  // Observations are kept separate from gates. `finalProbeCount` is a count, so
  // comparing it against `true` would fail every run regardless of the data.
  const commonCoverage = {
    tokenFloorMet: usage.foregroundVerifiedTokens >= 3000000,
    uniqueSourceFloorMet: (progress.coverage?.uniqueSourceTokens ?? 0) >= 500000,
    // `assignedPages` in the progress record is per-episode while `exposedPages`
    // is cumulative, so comparing them flagged a complete 288-page journey as
    // incomplete. The claim is "every assigned page was exposed", which the
    // exposed set proves against the assignment BOUND: a set of size `bound` drawn
    // from `1..bound` is the whole range, and I04 independently rejects any read
    // past the bound.
    allAssignedPagesFullyExposed: (progress.coverage?.assignedPageEnd ?? 0) > 0 && (progress.coverage?.exposedPages ?? 0) === progress.coverage?.assignedPageEnd,
    finalProbeCount: progress.finalProbeCount ?? 0,
    plannedRestartVerified: progress.restartVerified === true,
  }
  // One explicit expectation per required field; a count is compared with its
  // required value, not coerced to a boolean.
  const commonGates = {
    tokenFloorMet: commonCoverage.tokenFloorMet === true,
    uniqueSourceFloorMet: commonCoverage.uniqueSourceFloorMet === true,
    allAssignedPagesFullyExposed: commonCoverage.allAssignedPagesFullyExposed === true,
    finalProbeCount: commonCoverage.finalProbeCount === REQUIRED_FINAL_PROBE_COUNT,
    plannedRestartVerified: commonCoverage.plannedRestartVerified === true,
  }
  // These four were declared gates whose inputs NOTHING produced: the audit read
  // `progress.coverage.<field> ?? 0` for fields no code ever wrote, so the ARC
  // arm's coverage gate was structurally unsatisfiable and reported 0 for a
  // journey that had in fact satisfied two of them. They are now derived from the
  // observed block lineage and the receipt ledger.
  const lineage = blockLineage(windows, new Set(jobs.filter(row => row.phase === 'receipt' && row.status === 'delivered').map(row => row.operationId)))
  const arcCoverage = run.arm === 'ARC_DEFERRED' ? {
    windowCommits: windows.length,
    pressureWindowCommits: windows.filter(event => event.data?.contextManagement?.trigger === 'pressure').length,
    distinctDeliveredSourceCount: distinctDelivered,
    deliveryGenerationCount: generations.size,
    rearchivedDeliveredReceiptCount: lineage.rearchivedDelivered,
    maxVerifiedSourceProcessingDepth: lineage.maxDepth,
    oldWindowLongTailCount: Math.max(0, lineage.blocks - SIX_RECENT_WINDOWS),
    probeCleanLongTailCount: score?.probeCleanLongTailCount ?? 0,
  } : null
  const basicCoverage = run.arm !== 'ARC_DEFERRED' ? {
    nativeAutomaticCompactions: events.filter(event => event.type === 'compaction/summary').length,
    arcSpecificMechanisms: 'NOT_APPLICABLE',
  } : null
  const arcGates = arcCoverage === null ? null : {
    windowCommits: arcCoverage.windowCommits >= 12,
    pressureWindowCommits: arcCoverage.pressureWindowCommits >= 8,
    distinctDeliveredSourceCount: arcCoverage.distinctDeliveredSourceCount >= 6,
    deliveryGenerationCount: arcCoverage.deliveryGenerationCount >= 6,
    rearchivedDeliveredReceiptCount: arcCoverage.rearchivedDeliveredReceiptCount >= 2,
    maxVerifiedSourceProcessingDepth: arcCoverage.maxVerifiedSourceProcessingDepth >= 3,
    oldWindowLongTailCount: arcCoverage.oldWindowLongTailCount >= 12,
    probeCleanLongTailCount: arcCoverage.probeCleanLongTailCount >= 12,
  }
  const basicGates = basicCoverage === null ? null : {
    nativeAutomaticCompactions: basicCoverage.nativeAutomaticCompactions >= 12,
  }
  const passed = Object.values(commonGates).every(value => value === true)
    && (arcGates === null || Object.values(arcGates).every(value => value === true))
    && (basicGates === null || Object.values(basicGates).every(value => value === true))
  return {
    passed, commonCoverage, commonGates, arcCoverage, arcGates, basicCoverage, basicGates,
    unmetGates: [...Object.entries(commonGates), ...Object.entries(arcGates ?? {}), ...Object.entries(basicGates ?? {})]
      .filter(([, met]) => met !== true).map(([name]) => name),
    unknownAsTrue: false,
  }
}

// Read the durable event history once it has stopped growing for one poll.
async function settledEvents(observed, sessionId, { attempts = 4, pauseMs = 250 } = {}) {
  let previous = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    const events = await observedEvents(observed, sessionId).catch(() => null)
    if (events && previous && events.length === previous.length && events.at(-1)?.seq === previous.at(-1)?.seq) return events
    previous = events
    await new Promise(resolvePromise => setTimeout(resolvePromise, pauseMs))
  }
  return previous ?? []
}

async function directoryBytes(root) {
  let total = 0
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else total += (await stat(path)).size
    }
  }
  await walk(root).catch(() => {})
  return total
}
