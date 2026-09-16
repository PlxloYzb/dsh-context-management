// W3 regression tests: observation, usage ledger and independent supervision.
//
// Run with: node --test tests/live/longrun/w3.test.mjs
// All filesystem work happens under .test-runtime/longrun-probe/w3-test/.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  accountingOf,
  appendJsonlRow,
  classifyPurpose,
  createUsageLedger,
  exposedSourcePageSet,
  normalizeUsage,
  readJsonl,
  summarizeUsage,
  uniqueExposedSourceTokens,
} from './usage.mjs'
import { apply as applyObserver, handoffOperationIds } from './observer.mjs'
import {
  LIMITS,
  assertLeaseAllowsNewWork,
  createLeaseIdentity,
  leaseState,
  pollOnce,
  status as supervisorStatus,
} from './supervise.mjs'

const TEST_ROOT = resolve('.test-runtime/longrun-probe/w3-test')
const SUPERVISE_PATH = fileURLToPath(new URL('./supervise.mjs', import.meta.url))

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

function caseDir(t) {
  const dir = join(TEST_ROOT, `case-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function usageRow(overrides = {}) {
  return { logicalRequestId: 'L1', streamId: 'S1', attemptId: 'unknown', purposeClass: 'main-foreground', accountingClass: 'foreground', ...overrides }
}

function readRows(path) {
  return readJsonl(path).rows
}

// --- 1. cumulative usage dedup ------------------------------------------------

test('duplicate cumulative usage chunks never double count', () => {
  const repeated = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
  const rows = [
    usageRow({ phase: 'raw', usageRaw: repeated }),
    usageRow({ phase: 'raw', usageRaw: { ...repeated } }),
    usageRow({ phase: 'raw', usageRaw: { inputTokens: 120, outputTokens: 60, totalTokens: 180 } }),
    usageRow({ phase: 'normalized', usageNormalized: { inputTokens: 120, outputTokens: 60, totalTokens: 180 }, terminalState: 'succeeded' }),
    usageRow({ logicalRequestId: 'L2', streamId: 'S2', phase: 'raw', usageRaw: { inputTokens: 200, outputTokens: 10, totalTokens: 210 }, terminalState: 'succeeded' }),
  ]
  const result = normalizeUsage(rows)
  assert.equal(result.counts.calls, 2)
  assert.equal(result.foregroundVerifiedTokens, 390)
  assert.equal(result.allReportedTokens, 390)
  assert.equal(result.unknownUsageCallCount, 0)
  // Nothing is double counted from the repeated cumulative chunk.
  assert.equal(result.foregroundVerifiedTokens, 180 + 210)
})

test('incremental semantics sum chunks without also counting the aggregate row', () => {
  const rows = [
    usageRow({ phase: 'raw', usageRaw: { totalTokens: 100 } }),
    usageRow({ phase: 'raw', usageRaw: { totalTokens: 50 } }),
    usageRow({ phase: 'normalized', usageNormalized: { totalTokens: 150 }, terminalState: 'succeeded' }),
  ]
  const result = normalizeUsage(rows, { semantics: 'incremental' })
  assert.equal(result.foregroundVerifiedTokens, 150)
})

// --- 2. unknown usage is listed, never zeroed ---------------------------------

test('missing usage is kept as an explicit list, never folded into zero', () => {
  const rows = [
    usageRow({ phase: 'dispatched', dispatchedAt: '2026-09-15T00:00:00.000Z' }),
    usageRow({ logicalRequestId: 'L2', streamId: 'S2', phase: 'raw', usageRaw: { totalTokens: 10 }, terminalState: 'succeeded' }),
  ]
  const result = normalizeUsage(rows, { perCallConservativeReserve: 1234 })
  assert.equal(result.foregroundVerifiedTokens, 10)
  assert.equal(result.allReportedTokens, 10)
  assert.equal(result.unknownUsageCallCount, 1)
  assert.equal(result.unknownUsageCalls[0].logicalRequestId, 'L1')
  assert.equal(result.unknownUsageCalls[0].reason, 'no-usable-usage')
  assert.notEqual(result.unknownUsageCalls[0].reservedExposureTokens, 0)
  // A missing call is not present in the floor as a zero-cost success.
  assert.equal(result.byAccounting.foreground.unknownCalls, 1)
  assert.equal(result.byAccounting.foreground.knownTokens, 10)
})

test('a reservation with no usage row at all is still an unknown call', () => {
  const rows = [usageRow({ phase: 'reserved', conservativeReserveTokens: 777 })]
  const result = normalizeUsage(rows)
  assert.equal(result.unknownUsageCallCount, 1)
  assert.equal(result.unknownUsageCalls[0].reason, 'reserved-without-usage-row')
  assert.equal(result.reservedExposureTokens, 777)
  assert.equal(result.foregroundVerifiedTokens, 0)
})

// --- 3. reservations never enter the floor ------------------------------------

test('reserved exposure is separate and never counts toward the foreground floor', () => {
  const rows = [
    usageRow({ logicalRequestId: 'L1', phase: 'raw', usageRaw: { totalTokens: 150 }, terminalState: 'succeeded' }),
    usageRow({ logicalRequestId: 'L2', phase: 'reserved', conservativeReserveTokens: 999999 }),
    usageRow({ logicalRequestId: 'L2', phase: 'dispatched' }),
  ]
  const summary = summarizeUsage({ rows, perCallConservativeReserve: 5 })
  assert.equal(summary.foregroundVerifiedTokens, 150)
  assert.equal(summary.officialFloorTokens, 150)
  assert.equal(summary.reservedExposureTokens, 999999)
  assert.equal(summary.floorIncludesReservations, false)
  assert.equal(summary.unknownUsageCallCount, 1)
})

test('a reservation for a call that later reported usage is superseded', () => {
  const rows = [
    usageRow({ phase: 'reserved', conservativeReserveTokens: 999999 }),
    usageRow({ phase: 'raw', usageRaw: { totalTokens: 42 }, terminalState: 'succeeded' }),
  ]
  const result = normalizeUsage(rows)
  assert.equal(result.reservedExposureTokens, 0)
  assert.equal(result.foregroundVerifiedTokens, 42)
})

// --- 4. purpose classification ------------------------------------------------

test('purpose classification keeps foreground, probes, summaries and title apart', () => {
  assert.equal(classifyPurpose('agent'), 'main-foreground')
  assert.equal(classifyPurpose(undefined), 'main-foreground')
  assert.equal(classifyPurpose('compaction'), 'background-summary')
  assert.equal(classifyPurpose('session-title'), 'title')
  assert.equal(classifyPurpose('sentinel-probe'), 'sentinel-probe')
  assert.equal(classifyPurpose('final-probe'), 'final-probe')
  assert.equal(classifyPurpose('something-else'), 'other')
  assert.equal(classifyPurpose('synthetic', { purposes: { synthetic: 'sentinel-probe' } }), 'sentinel-probe')

  assert.equal(accountingOf({ purposeClass: 'main-foreground' }), 'foreground')
  assert.equal(accountingOf({ purposeClass: 'background-summary' }), 'summary')
  assert.equal(accountingOf({ purposeClass: 'sentinel-probe' }), 'sentinel')
  assert.equal(accountingOf({ purposeClass: 'final-probe' }), 'final-probe')
  assert.equal(accountingOf({ purposeClass: 'title' }), 'unknown')
  assert.equal(accountingOf({ purposeClass: 'main-foreground', failed: true }), 'failed')
  assert.equal(accountingOf({ purposeClass: 'main-foreground', cancelled: true }), 'cancelled')
  assert.equal(accountingOf({ purposeClass: 'main-foreground', retry: true }), 'retry')
})

test('probe and sentinel usage is reported but never joins the floor', () => {
  const rows = [
    usageRow({ logicalRequestId: 'W1', usageRaw: { totalTokens: 1000 }, terminalState: 'succeeded' }),
    usageRow({ logicalRequestId: 'P1', purposeClass: 'sentinel-probe', accountingClass: 'sentinel', usageRaw: { totalTokens: 200 }, terminalState: 'succeeded' }),
    usageRow({ logicalRequestId: 'P2', purposeClass: 'final-probe', accountingClass: 'final-probe', usageRaw: { totalTokens: 300 }, terminalState: 'succeeded' }),
    usageRow({ logicalRequestId: 'T1', purposeClass: 'title', accountingClass: 'unknown', usageRaw: { totalTokens: 50 }, terminalState: 'succeeded' }),
  ]
  const result = normalizeUsage(rows)
  assert.equal(result.foregroundVerifiedTokens, 1000)
  assert.equal(result.probeReportedTokens, 500)
  assert.equal(result.allReportedTokens, 1550)
  assert.equal(result.titleCallsAbsent, false)
})

// --- 5. unique exposed source pages -------------------------------------------

test('unique exposed source pages are counted once each', () => {
  assert.equal(uniqueExposedSourceTokens([1, 1, 2, 3, 2], 10), 30)
  assert.equal(uniqueExposedSourceTokens([{ page: 1, text: 'abcd' }, { page: 1, text: 'abcd' }, { page: 2, text: 'ab' }], text => text.length), 6)
  assert.equal(exposedSourcePageSet([1, 1, 2, 3, 2]).size, 3)
  assert.equal(uniqueExposedSourceTokens([{ page: 7, tokens: 123 }, { page: 7, tokens: 123 }], () => 1), 123)
})

// --- 6. six required totals ---------------------------------------------------

test('all six required totals are computable and separately reported', () => {
  const summary = summarizeUsage({
    rows: [usageRow({ phase: 'raw', usageRaw: { totalTokens: 150 }, terminalState: 'succeeded' })],
    exposedPages: [1, 1, 2],
    heuristicTokens: 1000,
    projectedTokens: 555,
    perCallConservativeReserve: 7,
  })
  for (const key of ['foregroundVerifiedTokens', 'allReportedTokens', 'unknownUsageCalls', 'reservedExposureTokens', 'uniqueExposedSourceTokens', 'currentProjectedTokens']) {
    assert.ok(key in summary, `missing required total ${key}`)
  }
  assert.equal(summary.foregroundVerifiedTokens, 150)
  assert.equal(summary.uniqueExposedSourceTokens, 2000)
  assert.equal(summary.currentProjectedTokens, 555)
  assert.equal(summary.floorIncludesProbes, false)
  assert.equal(summary.floorIncludesSummaries, false)
})

// --- 7. torn trailing JSONL ---------------------------------------------------

test('a torn trailing JSONL line is reported and never parsed, a malformed middle line throws', (t) => {
  const dir = caseDir(t)
  const path = join(dir, 'ledger.jsonl')
  writeFileSync(path, '{"a":1}\n{"partial":')
  const torn = readJsonl(path)
  assert.equal(torn.rows.length, 1)
  assert.equal(torn.tornTail, '{"partial":')
  appendFileSync(path, 'true}\n')
  assert.equal(readJsonl(path).rows.length, 2)

  const bad = join(dir, 'bad.jsonl')
  writeFileSync(bad, '{"a":1}\nnot json\n{"b":2}\n')
  assert.throws(() => readJsonl(bad), /JSONL_MALFORMED_MIDDLE/)

  const ledger = createUsageLedger({ file: join(dir, 'usage.jsonl') })
  ledger.recordChunk(usageRow(), { totalTokens: 150 })
  appendFileSync(join(dir, 'usage.jsonl'), '{"phase":"normalized","logicalRequest')
  const totals = ledger.totals()
  assert.equal(totals.foregroundVerifiedTokens, 150)
  assert.equal(totals.unknownUsageCallCount, 0)
  ledger.close()
  assert.equal(readJsonl(join(dir, 'usage.jsonl')).tornTail.startsWith('{"phase":"normalized"'), true)
})

// --- 8. lease expiry ----------------------------------------------------------

test('lease expiry blocks new work until a supervisor takes over', async (t) => {
  const { processIdentity, leaseOwnerAlive } = await import('./supervise.mjs')
  const dir = caseDir(t)
  const now = Date.now()
  const liveIdentity = processIdentity(process.pid)
  const heldForeign = { supervisorId: 'foreign', heartbeatAtMs: now - 1000, expiresAtMs: now + 29000, pid: process.pid, startIdentity: liveIdentity }
  assert.equal(leaseState(heldForeign, now).state, 'held')
  assert.equal(leaseOwnerAlive(heldForeign), true)
  assert.equal(assertLeaseAllowsNewWork(heldForeign, now, LIMITS, { supervisorId: 'ours' }).allowed, false)
  assert.equal(assertLeaseAllowsNewWork(heldForeign, now, LIMITS, { supervisorId: 'ours' }).reason, 'LEASE_OWNED_BY_OTHER')

  const expired = { supervisorId: 'foreign', heartbeatAtMs: now - 40000, expiresAtMs: now - 10000, pid: 999999 }
  assert.equal(leaseState(expired, now).state, 'expired')
  assert.equal(assertLeaseAllowsNewWork(expired, now, LIMITS, { supervisorId: 'ours' }).reason, 'LEASE_EXPIRED')

  mkdirSync(join(dir, 'w3probe', 'pilot-1'), { recursive: true })
  writeFileSync(join(dir, 'w3probe', 'pilot-1', 'supervisor-lease.json'), JSON.stringify(expired))
  const takeover = pollOnce({ root: dir, campaign: 'w3probe', pair: 'pilot-1', now, supervisorId: 'ours' })
  assert.equal(takeover.previousLeaseState, 'expired')
  assert.equal(takeover.newWorkAllowed, true)
  assert.equal(takeover.lease.supervisorId, 'ours')

  const heldPath = join(dir, 'w3probe', 'pilot-1', 'supervisor-lease.json')
  writeFileSync(heldPath, JSON.stringify(heldForeign))
  const blocked = pollOnce({ root: dir, campaign: 'w3probe', pair: 'pilot-1', now: now + 1000, supervisorId: 'ours' })
  assert.equal(blocked.newWorkAllowed, false)
  assert.equal(blocked.newWorkReason, 'LEASE_OWNED_BY_OTHER')
  assert.equal(blocked.lease.supervisorId, 'foreign')

  // A held lease whose owner process is provably gone is reclaimed before the
  // 30s expiry (a `--once` probe must not lock out the real supervisor).
  const orphan = { supervisorId: 'gone', heartbeatAtMs: now + 1000, expiresAtMs: now + 31000, pid: 999999, startIdentity: 'not-a-real-process' }
  writeFileSync(heldPath, JSON.stringify(orphan))
  assert.equal(leaseOwnerAlive(orphan), false)
  const reclaimed = pollOnce({ root: dir, campaign: 'w3probe', pair: 'pilot-1', now: now + 2000, supervisorId: 'ours' })
  assert.equal(reclaimed.newWorkAllowed, true)
  assert.equal(reclaimed.lease.supervisorId, 'ours')
})

// --- 9. heartbeat staleness alert dedup ---------------------------------------

test('stale driver heartbeat alerts are deduplicated across polls', (t) => {
  const dir = caseDir(t)
  const pairDir = join(dir, 'w3probe', 'pilot-2')
  const runDir = join(pairDir, 'arc', 'run-1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ runId: 'run-1', arm: 'ARC_DEFERRED' }))
  const now = Date.now()
  const heartbeatPath = join(pairDir, 'driver-heartbeat.json')
  const alertsPath = join(pairDir, 'alerts.jsonl')

  writeFileSync(heartbeatPath, JSON.stringify({ heartbeatAtMs: now - 20000 }))
  pollOnce({ root: dir, campaign: 'w3probe', pair: 'pilot-2', now, supervisorId: 'sup-a' })
  pollOnce({ root: dir, campaign: 'w3probe', pair: 'pilot-2', now: now + 1000, supervisorId: 'sup-a' })
  let rows = readRows(alertsPath).filter(row => row.code === 'DRIVER_HEARTBEAT_STALE')
  assert.equal(rows.filter(row => row.phase === 'raised').length, 1, 'a steady stale condition must raise once')
  assert.equal(rows.filter(row => row.phase === 'cleared').length, 0)

  writeFileSync(heartbeatPath, JSON.stringify({ heartbeatAtMs: now + 3000 }))
  pollOnce({ root: dir, campaign: 'w3probe', pair: 'pilot-2', now: now + 3000, supervisorId: 'sup-a' })
  rows = readRows(alertsPath).filter(row => row.code === 'DRIVER_HEARTBEAT_STALE')
  assert.equal(rows.filter(row => row.phase === 'cleared').length, 1)

  writeFileSync(heartbeatPath, JSON.stringify({ heartbeatAtMs: now + 3000 }))
  pollOnce({ root: dir, campaign: 'w3probe', pair: 'pilot-2', now: now + 300000, supervisorId: 'sup-a' })
  rows = readRows(alertsPath).filter(row => row.code === 'DRIVER_HEARTBEAT_STALE')
  assert.equal(rows.filter(row => row.phase === 'raised').length, 2, 'a new stale episode raises again')
  assert.equal(rows.filter(row => row.phase === 'cleared').length, 1)
})

// --- 10. supervisor CLI with no campaign directories --------------------------

test('supervise.mjs --once returns clean NOT_READY when nothing exists yet', (t) => {
  const dir = caseDir(t)
  const output = execFileSync(process.execPath, [SUPERVISE_PATH, '--campaign', 'w3probe', '--pair', 'pilot-3', '--root', dir, '--once'], { encoding: 'utf8' })
  const value = JSON.parse(output)
  assert.equal(value.ready, false)
  assert.equal(value.reason, 'NOT_READY')
  // The supervisor lease itself is held and READY (so `run-pair` can attach),
  // while the pair is NOT_READY because no run evidence exists yet.
  assert.equal(value.newWorkAllowed, true)
  assert.equal(value.runs.length, 0)
  // The atomic lease exists and carries process identity.
  const lease = JSON.parse(readFileSync(join(dir, 'w3probe', 'pilot-3', 'supervisor-lease.json'), 'utf8'))
  assert.ok(Number.isFinite(lease.pid) && lease.pid > 0)
  assert.ok(typeof lease.startIdentity === 'string' && lease.startIdentity.length > 0)
  assert.ok(Number.isFinite(lease.expiresAtMs) || typeof lease.expiresAt === 'string')
  assert.ok(Number.isFinite(lease.expiresAtMs) && lease.expiresAtMs - lease.heartbeatAtMs === LIMITS.leaseExpiryMs)
})

test('supervise.mjs rejects missing campaign/pair arguments', () => {
  assert.throws(() => execFileSync(process.execPath, [SUPERVISE_PATH, '--once'], { encoding: 'utf8', stdio: 'pipe' }), /status 2|Command failed/)
})

// --- 11. process ownership proof ----------------------------------------------

test('ownership proof requires PID, start identity, runId, launchId, profile and realpath', async () => {
  const { verifyOwnership, terminateOwned, hostProof } = await import('./supervise.mjs')
  const incomplete = verifyOwnership({ pid: process.pid, expected: { runId: 'r', launchId: 'l' } })
  assert.equal(incomplete.owned, false)
  assert.ok(incomplete.problems.includes('missing-startIdentity'))
  const wrongIdentity = verifyOwnership({ pid: process.pid, expected: { runId: 'r', launchId: 'l', startIdentity: 'not-the-real-identity', profile: 'p', binaryRealpath: '/x' } })
  assert.equal(wrongIdentity.owned, false)
  assert.ok(wrongIdentity.problems.includes('os-start-identity-mismatch'))
  // A launch record whose binary cannot be realpath'd yields a missing field,
  // so the proof fails rather than guessing.
  const proof = hostProof({ runId: 'run-x', run: { runId: 'run-x' }, host: { pid: process.pid, launchId: 'L', startIdentity: 'S', profile: 'P', dshBin: '/does/not/exist/dsh' } })
  assert.equal(proof.expected.runId, 'run-x')
  assert.equal(proof.expected.binaryRealpath, null)
  assert.equal(verifyOwnership(proof).owned, false)
  // A refused kill never signals the process.
  let signalled = false
  const result = terminateOwned({ pid: process.pid, expected: { runId: 'r', launchId: 'l' }, kill: () => { signalled = true } })
  assert.equal(result.killed, false)
  assert.equal(result.reason, 'UNPROVEN_OWNERSHIP')
  assert.equal(signalled, false)
})

// --- 12. observer request/job rows --------------------------------------------

test('observer records purpose, hashes and explicit job-to-stream association', async (t) => {
  const output = caseDir(t)
  const events = []
  const session = {
    id: 'sess-w3',
    seq: 3,
    header: { cwd: '/synthetic/dsh-context-experiment-w3' },
    snapshotEvents: () => [...events],
  }
  const hooks = new Map()
  const ctx = {
    on(name, hook) { hooks.set(name, hook) },
    sessions: { get(id) { return id === session.id ? session : undefined } },
    llm: { async resolveModelInfo() { return { context: { contextWindow: 1048576 }, reasoning: { defaultEffort: 'minimal' } } } },
    agentPresets: {
      serviceFor() {
        return { summaries: { status: () => ({ status: 'pending', operationId: 'op-42', throughSeq: 9, sourceHash: 'source-hash-42', provider: 'p', model: 'm', startedAt: Date.now(), readyAt: null }) } }
      },
    },
    tokenMeter: { measure: () => ({ totalTokens: 1, baseline: { kind: 'synthetic' } }) },
    sessionProjections: { snapshot: () => ({ values: { contextPressure: { projectedTokens: 42 } } }) },
  }
  const handle = applyObserver(ctx, {
    output,
    runId: 'run-w3',
    route: { provider: 'p', model: 'm', reasoningEffort: 'minimal' },
    mainMaxTokens: 8192,
    expectedContextWindow: 1048576,
    perCallConservativeReserve: 5000,
  })
  t.after(() => handle.close())

  const agent = { session }
  await hooks.get('agent/pre-step')({ agent, turn: 1, step: 1 }, async () => undefined)

  const foregroundMessages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic work' }] }]
  const foreground = Object.freeze({ sessionId: session.id, provider: 'p', model: 'm', maxTokens: 8192, messages: Object.freeze(foregroundMessages) })
  const before = JSON.stringify(foreground)
  const chunks = Object.freeze([
    Object.freeze({ type: 'text-delta', index: 0, text: 'ok' }),
    Object.freeze({ type: 'usage', usage: Object.freeze({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }) }),
    Object.freeze({ type: 'finish', reason: Object.freeze({ kind: 'stop' }) }),
  ])
  for await (const _ of hooks.get('llm/stream')(foreground, async function* () { yield* chunks })) { /* consume unchanged */ }
  assert.equal(JSON.stringify(foreground), before, 'observer must not rewrite the request')

  const requests = readRows(join(output, 'requests.jsonl'))
  const terminal = requests.find(row => row.phase === 'terminal' && row.purposeClass === 'main-foreground')
  assert.ok(terminal, 'foreground terminal row present')
  assert.equal(terminal.accountingClass, 'foreground')
  assert.equal(terminal.usageKnown, true)
  assert.equal(terminal.usageNormalized.totalTokens, 15)
  assert.equal(terminal.messagesHash.length, 64)
  assert.equal(terminal.jobAssociation, null)
  assert.equal(terminal.purpose, 'agent')
  assert.equal(terminal.purposeSource, 'default-agent')
  assert.equal(terminal.effectiveReasoningEffort, 'minimal')

  // Background summary stream, associated through product metadata (not time).
  const compaction = Object.freeze({ sessionId: session.id, provider: 'p', model: 'm', maxTokens: 2048, purpose: 'compaction', messages: Object.freeze([{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'summarize' }] }]) })
  for await (const _ of hooks.get('llm/stream')(compaction, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) { /* consume */ }
  const summaryTerminal = readRows(join(output, 'requests.jsonl')).find(row => row.phase === 'terminal' && row.purposeClass === 'background-summary')
  assert.ok(summaryTerminal)
  assert.equal(summaryTerminal.accountingClass, 'summary')
  assert.equal(summaryTerminal.jobAssociation.operationId, 'op-42')

  let jobs = readRows(join(output, 'summary-jobs.jsonl'))
  const started = jobs.find(row => row.phase === 'started' && row.operationId === 'op-42')
  assert.ok(started, 'job started row present')
  assert.equal(started.streamId, summaryTerminal.streamId, 'job streamId equals the observed request streamId')
  assert.equal(started.associationEvidence.kind, 'product-metadata')
  assert.ok(started.associationEvidence.matchedFields.includes('operationId'))
  assert.equal(started.consumedByRequestId, null)

  // Durable plugin receipt binds the job to the same stream.
  const receipt = { schemaVersion: 1, operationId: 'op-42', status: 'delivered', sourceSeqs: [1, 2, 3], sourceHash: 'source-hash-42', sourceGeneration: 1, windowGeneration: 2, provider: 'p', model: 'm' }
  const receiptEvent = { seq: 12, type: 'user/message', time: new Date().toISOString(), data: { source: { kind: 'plugin', plugin: 'dsh-context-management/handoff', handoff: receipt }, content: [{ type: 'text', text: 'handoff' }] } }
  events.push(receiptEvent)
  hooks.get('session/event')(session, receiptEvent)
  jobs = readRows(join(output, 'summary-jobs.jsonl'))
  const receiptRow = jobs.find(row => row.phase === 'receipt' && row.operationId === 'op-42')
  assert.ok(receiptRow)
  assert.equal(receiptRow.streamId, summaryTerminal.streamId)
  assert.equal(receiptRow.receiptSeq, 12)
  assert.deepEqual(receiptRow.sourceSeqs, [1, 2, 3])
  assert.equal(receiptRow.associationEvidence.kind, 'receipt')

  // Consumption is proven by content, not by time: the operationId must appear
  // inside a later assembled foreground request.
  assert.deepEqual([...handoffOperationIds([{ source: { kind: 'plugin', plugin: 'dsh-context-management/handoff', handoff: receipt } }])], ['op-42'])
  const consuming = Object.freeze({ sessionId: session.id, provider: 'p', model: 'm', maxTokens: 8192, messages: Object.freeze([{ role: 'user', source: { kind: 'plugin', plugin: 'dsh-context-management/handoff', handoff: receipt }, content: [{ type: 'text', text: 'handoff' }] }]) })
  for await (const _ of hooks.get('llm/stream')(consuming, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) { /* consume */ }
  jobs = readRows(join(output, 'summary-jobs.jsonl'))
  const consumed = jobs.find(row => row.phase === 'consumed' && row.operationId === 'op-42')
  assert.ok(consumed, 'consumed row present')
  assert.equal(consumed.associationEvidence.kind, 'message-content')
  assert.ok(consumed.consumedByRequestId)
  const consumerTerminal = readRows(join(output, 'requests.jsonl')).find(row => row.logicalRequestId === consumed.consumedByRequestId)
  assert.ok(consumerTerminal, 'consumedByRequestId names a real observed request')
  // The audit counts delivered jobs by `status === 'delivered'`; lifecycle
  // continuation rows must not inflate that count.
  assert.equal(consumed.status, 'consumed')
  assert.equal(jobs.filter(row => row.status === 'delivered').length, 1)
  assert.equal(jobs.filter(row => row.status === 'delivered').every(row => Number.isSafeInteger(row.receiptSeq)), true)

  // Event stream is captured incrementally and no credentials/settings leak.
  assert.ok(existsSync(join(output, `${session.id}.events.jsonl`)))
  for (const name of readdirSync(output)) {
    const path = join(output, name)
    if (!readFileSync(path, 'utf8').includes('settings.yaml')) continue
    assert.fail(`observer must not persist private settings: ${name}`)
  }
  const usageRows = readRows(join(output, 'usage.jsonl'))
  assert.ok(usageRows.some(row => row.phase === 'raw'))
  assert.ok(usageRows.some(row => row.phase === 'normalized'))
})

test('observer marks an unassociable summary stream explicitly instead of using time proximity', async (t) => {
  const output = caseDir(t)
  const session = { id: 'sess-w3b', seq: 1, header: { cwd: '/synthetic/dsh-context-experiment-w3b' }, snapshotEvents: () => [] }
  const hooks = new Map()
  const ctx = {
    on(name, hook) { hooks.set(name, hook) },
    sessions: { get() { return session } },
    llm: { async resolveModelInfo() { return { context: { contextWindow: 1048576 }, reasoning: { defaultEffort: 'minimal' } } } },
    agentPresets: { serviceFor() { return {} } },
    tokenMeter: { measure: () => ({ totalTokens: 0, baseline: { kind: 'x' } }) },
    sessionProjections: { snapshot: () => ({ values: {} }) },
  }
  const handle = applyObserver(ctx, { output, route: { provider: 'p', model: 'm' }, mainMaxTokens: 2048, expectedContextWindow: 1048576 })
  t.after(() => handle.close())
  await hooks.get('agent/pre-step')({ agent: { session }, turn: 1, step: 1 }, async () => undefined)
  const compaction = Object.freeze({ sessionId: session.id, provider: 'p', model: 'm', maxTokens: 2048, purpose: 'compaction', messages: Object.freeze([]) })
  for await (const _ of hooks.get('llm/stream')(compaction, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) { /* consume */ }
  const job = readRows(join(output, 'summary-jobs.jsonl')).find(row => row.phase === 'started')
  assert.ok(job)
  assert.equal(job.associationEvidence.kind, 'unresolved')
  assert.equal(job.status, 'unknown')
  assert.equal(job.associationEvidence.streamId, job.streamId)
  assert.equal(job.operationId, null)
})

test('observer classifies sentinel and final-probe streams from durable driver progress', async (t) => {
  const runRoot = caseDir(t)
  const output = join(runRoot, 'observed')
  mkdirSync(output, { recursive: true })
  writeFileSync(join(runRoot, 'run.json'), JSON.stringify({ runId: 'run-progress', arm: 'ARC_DEFERRED' }))
  writeFileSync(join(runRoot, 'progress.json'), JSON.stringify({ currentPurpose: 'sentinel' }))
  const session = { id: 'sess-w3p', seq: 1, header: { cwd: '/synthetic/dsh-context-experiment-w3p' }, snapshotEvents: () => [] }
  const hooks = new Map()
  const ctx = {
    on(name, hook) { hooks.set(name, hook) },
    sessions: { get() { return session } },
    llm: { async resolveModelInfo() { return { context: { contextWindow: 1048576 }, reasoning: { defaultEffort: 'minimal' } } } },
    agentPresets: { serviceFor() { return {} } },
    tokenMeter: { measure: () => ({ totalTokens: 0, baseline: { kind: 'x' } }) },
    sessionProjections: { snapshot: () => ({ values: {} }) },
  }
  const handle = applyObserver(ctx, { output, route: { provider: 'p', model: 'm' }, mainMaxTokens: 8192, expectedContextWindow: 1048576 })
  t.after(() => handle.close())
  await hooks.get('agent/pre-step')({ agent: { session }, turn: 1, step: 1 }, async () => undefined)
  const request = Object.freeze({ sessionId: session.id, provider: 'p', model: 'm', maxTokens: 8192, messages: Object.freeze([]) })
  for await (const _ of hooks.get('llm/stream')(request, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) { /* consume */ }
  const terminal = readRows(join(output, 'requests.jsonl')).find(row => row.phase === 'terminal')
  assert.equal(terminal.purpose, 'agent')
  assert.equal(terminal.driverPurpose, 'sentinel')
  assert.equal(terminal.purposeSource, 'driver-progress')
  assert.equal(terminal.purposeClass, 'sentinel-probe')
  assert.equal(terminal.accountingClass, 'sentinel')
  assert.equal(terminal.runId, 'run-progress')
  assert.equal(summarizeUsage({ rows: readRows(join(output, 'usage.jsonl')) }).foregroundVerifiedTokens, 0)

  writeFileSync(join(runRoot, 'progress.json'), JSON.stringify({ currentPurpose: 'final-probe' }))
  const probe = Object.freeze({ sessionId: session.id, provider: 'p', model: 'm', maxTokens: 8192, messages: Object.freeze([]) })
  for await (const _ of hooks.get('llm/stream')(probe, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) { /* consume */ }
  const probeTerminal = readRows(join(output, 'requests.jsonl')).filter(row => row.phase === 'terminal').at(-1)
  assert.equal(probeTerminal.purposeClass, 'final-probe')
  assert.equal(probeTerminal.accountingClass, 'final-probe')
})

test('observer usage ledger totals agree with the six required counters', async (t) => {
  const output = caseDir(t)
  const session = { id: 'sess-w3c', seq: 1, header: { cwd: '/synthetic/dsh-context-experiment-w3c' }, snapshotEvents: () => [] }
  const hooks = new Map()
  const ctx = {
    on(name, hook) { hooks.set(name, hook) },
    sessions: { get() { return session } },
    llm: { async resolveModelInfo() { return { context: { contextWindow: 1048576 }, reasoning: { defaultEffort: 'minimal' } } } },
    agentPresets: { serviceFor() { return {} } },
    tokenMeter: { measure: () => ({ totalTokens: 0, baseline: { kind: 'x' } }) },
    sessionProjections: { snapshot: () => ({ values: {} }) },
  }
  const handle = applyObserver(ctx, { output, route: { provider: 'p', model: 'm' }, mainMaxTokens: 8192, expectedContextWindow: 1048576, perCallConservativeReserve: 1234 })
  t.after(() => handle.close())
  await hooks.get('agent/pre-step')({ agent: { session }, turn: 1, step: 1 }, async () => undefined)
  const request = Object.freeze({ sessionId: session.id, provider: 'p', model: 'm', maxTokens: 8192, messages: Object.freeze([]) })
  for await (const _ of hooks.get('llm/stream')(request, async function* () { yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } }; yield { type: 'finish', reason: { kind: 'stop' } } })) { /* consume */ }
  // A dispatch with no usage at all must be preserved as an unknown call.
  const stalled = Object.freeze({ sessionId: session.id, provider: 'p', model: 'm', maxTokens: 8192, messages: Object.freeze([]) })
  for await (const _ of hooks.get('llm/stream')(stalled, async function* () { yield { type: 'text-delta', index: 0, text: 'partial' } })) { /* no usage, no finish */ }
  const summary = summarizeUsage({
    rows: readRows(join(output, 'usage.jsonl')),
    exposedPages: [1, 1, 2],
    heuristicTokens: 100,
    projectedTokens: 333,
    perCallConservativeReserve: 1234,
  })
  assert.equal(summary.foregroundVerifiedTokens, 10)
  assert.equal(summary.allReportedTokens, 10)
  assert.equal(summary.unknownUsageCallCount, 1)
  assert.equal(summary.reservedExposureTokens, 1234)
  assert.equal(summary.uniqueExposedSourceTokens, 200)
  assert.equal(summary.currentProjectedTokens, 333)
  assert.equal(existsSync(join(output, 'requests.jsonl')), true)
})

test('observer event capture reconciles with the shared observedEvents reader', async (t) => {
  const { observedEvents } = await import('../local/observed-events.mjs')
  const output = caseDir(t)
  const events = []
  const session = { id: 'sess-ev', seq: 0, header: { cwd: '/synthetic/dsh-context-experiment-ev' }, snapshotEvents: () => [...events] }
  const hooks = new Map()
  const ctx = {
    on(name, hook) { hooks.set(name, hook) },
    sessions: { get() { return session } },
    llm: { async resolveModelInfo() { return { context: { contextWindow: 1048576 }, reasoning: { defaultEffort: 'minimal' } } } },
    agentPresets: { serviceFor() { return {} } },
    tokenMeter: { measure: () => ({ totalTokens: 0, baseline: { kind: 'x' } }) },
    sessionProjections: { snapshot: () => ({ values: {} }) },
  }
  const handle = applyObserver(ctx, { output, route: { provider: 'p', model: 'm' }, mainMaxTokens: 8192, expectedContextWindow: 1048576 })
  t.after(() => handle.close())
  const emitted = [
    { seq: 0, type: 'turn/start', time: new Date().toISOString(), data: {} },
    { seq: 1, type: 'user/message', time: new Date().toISOString(), data: { source: { kind: 'user' }, content: [] } },
    { seq: 2, type: 'turn/end', time: new Date().toISOString(), data: { reason: { kind: 'completed' } } },
  ]
  for (const event of emitted) {
    events.push(event)
    hooks.get('session/event')(session, event)
  }
  const merged = await observedEvents(output, session.id)
  assert.equal(merged.length, 3)
  assert.deepEqual(merged.map(event => event.seq), [0, 1, 2])
})

// --- 13. ledger single writer / status read-only ------------------------------
test('usage ledger refuses a second writer in the same process', (t) => {
  const dir = caseDir(t)
  const ledger = createUsageLedger({ file: join(dir, 'usage.jsonl') })
  assert.throws(() => createUsageLedger({ file: join(dir, 'usage.jsonl') }), /USAGE_LEDGER_MULTIPLE_WRITERS/)
  ledger.close()
  const reopened = createUsageLedger({ file: join(dir, 'usage.jsonl') })
  reopened.close()
})

test('supervisor status is read-only and reports NOT_READY without side effects', (t) => {
  const dir = caseDir(t)
  const value = supervisorStatus({ root: dir, campaign: 'w3probe', pair: 'pilot-4', now: Date.now() })
  assert.equal(value.reason, 'NOT_READY')
  assert.equal(value.runs.length, 0)
  assert.equal(value.leaseState, 'none')
  assert.equal(existsSync(join(dir, 'w3probe', 'pilot-4')), false, 'status must not create directories')
})

test('atomicJson files used for lease and supervisor state are small and valid JSON', (t) => {
  const dir = caseDir(t)
  const runDir = join(dir, 'w3probe', 'pilot-5', 'arc', 'run-9')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ runId: 'run-9' }))
  const now = Date.now()
  const value = pollOnce({ root: dir, campaign: 'w3probe', pair: 'pilot-5', now, supervisorId: 'sup-json', identity: createLeaseIdentity({ supervisorId: 'sup-json', pid: process.pid }) })
  assert.equal(value.state, 'PREFLIGHT')
  const state = JSON.parse(readFileSync(join(dir, 'w3probe', 'pilot-5', 'supervisor.json'), 'utf8'))
  assert.equal(state.heartbeatAtMs, now)
  assert.ok(Number.isFinite(state.limits.leaseExpiryMs))
  const resources = readRows(join(runDir, 'resources.jsonl'))
  assert.equal(resources.length, 1)
  assert.ok('eventLoopLagMs' in resources[0])
})
