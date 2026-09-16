// Independent persistent supervisor for one campaign pair.
//
// Runnable as `node tests/live/longrun/supervise.mjs --campaign ID --pair PAIR`
// and as a single poll with `--once` (used by tests). The supervisor is its own
// process owner: it survives a driver crash, holds an atomic lease, renews a
// heartbeat every 5s even when nothing changed, warns at 15s without a driver
// heartbeat, expires its own lease at 30s, and never sends prompts to a
// session. It only ever signals a host whose PID, OS start identity, runId,
// launchId, profile and binary realpath it can prove it owns.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, statfsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { appendJsonlRow, readJsonl } from './usage.mjs'

export const SUPERVISOR_SCHEMA_VERSION = 1
export const LEASE_SCHEMA_VERSION = 1
export const EVIDENCE_ROOT = '.test-runtime/longrun-20260915'

/** Frozen values from plan.json `supervision` and `resources`. */
export const LIMITS = Object.freeze({
  pollMs: 5000,
  driverHeartbeatMs: 5000,
  humanStatusMs: 30000,
  supervisorWarningMs: 15000,
  leaseExpiryMs: 30000,
  hostRssSoftBytes: 2147483648,
  hostRssHardBytes: 4294967296,
  hostRssHardSustainedMs: 30000,
  diskPauseBelowBytes: 5368709120,
  diskStopBelowBytes: 2147483648,
  termToKillMs: 10000,
  resourceSampleMs: 5000,
})

export const STATES = Object.freeze([
  'PLANNED', 'PREFLIGHT', 'READY', 'RUNNING', 'CHECKPOINT', 'WAIT_DEPENDENCY', 'PROVIDER_BACKOFF',
  'RECOVERING', 'STOP_REQUESTED', 'DRAINING', 'STOPPED', 'AUDITING', 'REVIEW_REQUIRED', 'SEALED',
])

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export function resolveRoots({ root, campaign, pair } = {}) {
  const evidenceRoot = resolve(root ?? process.env.EXPERIMENT_LONGRUN_ROOT ?? EVIDENCE_ROOT)
  return {
    evidenceRoot,
    campaignRoot: join(evidenceRoot, campaign),
    pairDir: join(evidenceRoot, campaign, pair),
  }
}

function assertIds({ campaign, pair }) {
  if (!campaign || !ID_PATTERN.test(campaign)) throw new Error(`INVALID_CAMPAIGN: ${campaign}`)
  if (!pair || !ID_PATTERN.test(pair)) throw new Error(`INVALID_PAIR: ${pair}`)
}

// --- atomic small-JSON helpers ------------------------------------------------

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, path)
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function iso(ms) {
  return new Date(ms).toISOString()
}

function safeReaddir(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function realpathOrNull(path) {
  if (!path) return null
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// --- process identity / ownership --------------------------------------------

export function processIdentity(pid, exec = execFileSync) {
  try {
    return exec('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

export function processAlive(pid) {
  if (!Number.isFinite(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export function createLeaseIdentity(options = {}) {
  const pid = options.pid ?? process.pid
  return {
    supervisorId: options.supervisorId ?? randomUUID(),
    pid,
    startIdentity: options.startIdentity ?? processIdentity(pid),
    runId: options.runId ?? null,
    launchId: options.launchId ?? null,
    profile: options.profile ?? null,
    binaryRealpath: options.binaryRealpath ?? null,
  }
}

export function leaseState(lease, now = Date.now(), limits = LIMITS) {
  if (!lease) return { state: 'none', ageMs: null, expiresAtMs: null }
  if (lease.releasedAt) return { state: 'released', ageMs: null, expiresAtMs: lease.expiresAtMs ?? null }
  const heartbeatAtMs = Number.isFinite(lease.heartbeatAtMs) ? lease.heartbeatAtMs : null
  const expiresAtMs = Number.isFinite(lease.expiresAtMs)
    ? lease.expiresAtMs
    : heartbeatAtMs === null ? null : heartbeatAtMs + limits.leaseExpiryMs
  const ageMs = heartbeatAtMs === null ? null : now - heartbeatAtMs
  if (expiresAtMs !== null && now >= expiresAtMs) return { state: 'expired', ageMs, expiresAtMs }
  if (ageMs !== null && ageMs >= limits.supervisorWarningMs) return { state: 'warning', ageMs, expiresAtMs }
  return { state: 'held', ageMs, expiresAtMs }
}

/** Lease expiry blocks new work; the driver must reconcile before reacquiring. */
export function assertLeaseAllowsNewWork(lease, now = Date.now(), limits = LIMITS, { supervisorId } = {}) {
  const state = leaseState(lease, now, limits)
  if (state.state !== 'held' && state.state !== 'warning') return { allowed: false, reason: `LEASE_${String(state.state).toUpperCase()}`, state }
  if (supervisorId && lease.supervisorId !== supervisorId) return { allowed: false, reason: 'LEASE_OWNED_BY_OTHER', state }
  return { allowed: true, reason: 'OK', state }
}

/**
 * A held lease whose recorded owner process no longer exists (or whose PID was
 * reused by a different start identity) may be reclaimed before its 30s expiry.
 * A live PID with a matching identity is never reclaimed.
 */
export function leaseOwnerAlive(lease) {
  if (!lease || !Number.isFinite(lease.pid) || !lease.startIdentity) return false
  if (!processAlive(lease.pid)) return false
  const actual = processIdentity(lease.pid)
  return actual !== null && actual === lease.startIdentity
}

export function verifyOwnership({ pid, expected } = {}) {
  const problems = []
  if (!Number.isFinite(pid)) problems.push('missing-pid')
  for (const field of ['runId', 'launchId', 'startIdentity', 'profile', 'binaryRealpath']) {
    if (!expected?.[field]) problems.push(`missing-${field}`)
  }
  if (problems.length) return { owned: false, actual: null, problems }
  const actual = processIdentity(pid)
  if (!actual) problems.push('process-not-observable')
  else if (actual !== expected.startIdentity) problems.push('os-start-identity-mismatch')
  return { owned: problems.length === 0, actual, problems }
}

/** Only a fully proven owned process is ever signalled. */
export function terminateOwned({ pid, expected, limits = LIMITS, kill = process.kill } = {}) {
  const proof = verifyOwnership({ pid, expected })
  if (!proof.owned) return { killed: false, reason: 'UNPROVEN_OWNERSHIP', proof }
  try {
    kill(pid, 'SIGTERM')
  } catch (error) {
    if (error?.code === 'ESRCH') return { killed: false, reason: 'ALREADY_EXITED', proof }
    return { killed: false, reason: 'SIGNAL_FAILED', proof, error: String(error?.message ?? error) }
  }
  const deadline = Date.now() + limits.termToKillMs
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return { killed: true, signal: 'SIGTERM', proof }
    sleepSync(50)
  }
  try {
    kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
  return { killed: true, signal: 'SIGKILL', proof }
}

/**
 * Build the ownership proof for one run's host launch record. A missing field
 * stays missing so `terminateOwned` refuses instead of guessing.
 */
export function hostProof(run) {
  const launch = run?.host
  let binaryRealpath = null
  try {
    binaryRealpath = launch?.dshBin ? realpathSync(launch.dshBin) : null
  } catch {
    binaryRealpath = null
  }
  return {
    pid: launch?.pid,
    expected: {
      runId: run?.run?.runId ?? run?.runId ?? null,
      launchId: launch?.launchId ?? null,
      startIdentity: launch?.startIdentity ?? null,
      profile: launch?.profile ?? null,
      binaryRealpath,
    },
  }
}

// --- run discovery and sampling ----------------------------------------------

export function listOwnedRuns(roots) {
  const runs = []
  if (!existsSync(roots.pairDir)) return runs
  for (const arm of safeReaddir(roots.pairDir)) {
    if (['home', 'model-cwd', 'private', 'objects', 'events'].includes(arm)) continue
    const armDir = join(roots.pairDir, arm)
    if (!isDirectory(armDir)) continue
    for (const runId of safeReaddir(armDir)) {
      const dir = join(armDir, runId)
      if (!isDirectory(dir)) continue
      const runJson = join(dir, 'run.json')
      if (!existsSync(runJson)) continue
      runs.push({
        arm,
        runId,
        dir,
        run: readJson(runJson, null),
        checkpoint: readJson(join(dir, 'checkpoint.json'), null),
        progress: readJson(join(dir, 'progress.json'), null),
        host: newestHostLaunch(dir),
      })
    }
  }
  return runs
}

function newestHostLaunch(runDir) {
  const hostDir = join(runDir, 'host')
  let newest = null
  for (const name of safeReaddir(hostDir)) {
    if (!name.startsWith('launch-') || !name.endsWith('.json')) continue
    const value = readJson(join(hostDir, name), null)
    if (!value) continue
    if (!newest || (value.startedAtMs ?? 0) > (newest.startedAtMs ?? 0)) newest = value
  }
  return newest
}

function requestTraffic(run) {
  const read = readJsonl(join(run.dir, 'requests.jsonl'))
  const calls = new Map()
  for (const row of read.rows) {
    if (!row?.callId) continue
    const prior = calls.get(row.callId) ?? {}
    calls.set(row.callId, {
      ...prior,
      dispatched: prior.dispatched || row.phase === 'dispatched',
      terminal: prior.terminal || row.phase === 'finish' || row.phase === 'incomplete-stream' || row.phase === 'terminal',
    })
  }
  return { calls, inFlight: [...calls.values()].filter(call => call.dispatched && !call.terminal).length, tornTail: read.tornTail }
}

export function sampleResources({ run, lease = null, now = Date.now(), supervisorPid = process.pid, eventLoopLagMs = null } = {}) {
  const hostPid = lease?.host?.pid ?? run?.host?.pid ?? null
  const driverPid = run?.progress?.pid ?? run?.run?.driverPid ?? null
  const processes = {
    host: sampleProcess(hostPid),
    driver: sampleProcess(driverPid),
    supervisor: sampleProcess(supervisorPid),
  }
  const summaryRead = readJsonl(join(run?.dir ?? '.', 'summary-jobs.jsonl'))
  const jobIds = new Set(summaryRead.rows.map(row => row.operationId).filter(Boolean))
  const receipts = summaryRead.rows.filter(row => row.phase === 'receipt').length
  const temporaryFiles = run?.dir ? safeReaddir(run.dir).filter(name => name.endsWith('.tmp')).length : 0
  let diskAvailableBytes = null
  try {
    const stats = statfsSync(run?.dir ?? '.')
    diskAvailableBytes = Number(stats.bavail) * Number(stats.bsize)
  } catch {
    diskAvailableBytes = null
  }
  return {
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    time: iso(now),
    monotonicMs: now,
    runId: run?.runId ?? null,
    arm: run?.arm ?? null,
    processes,
    hostRssBytes: processes.host.rssBytes,
    eventLoopLagMs,
    diskAvailableBytes,
    archiveBlocks: run?.checkpoint?.archiveBlocks ?? null,
    summaryReceipts: receipts,
    jobs: jobIds.size,
    listeners: run?.checkpoint?.listeners ?? null,
    temporaryFiles,
  }
}

export function sampleProcess(pid, exec = execFileSync) {
  if (!Number.isFinite(pid)) return { pid: null, alive: null, rssBytes: null, cpuPercent: null }
  try {
    const out = exec('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    const [rssKb, cpuPercent] = out.split(/\s+/)
    return { pid, alive: true, rssBytes: Number(rssKb) * 1024, cpuPercent: Number(cpuPercent) }
  } catch {
    return { pid, alive: false, rssBytes: null, cpuPercent: null }
  }
}

export function driverHeartbeat(roots, now = Date.now()) {
  const candidates = [join(roots.pairDir, 'driver-heartbeat.json')]
  for (const run of listOwnedRuns(roots)) {
    candidates.push(join(run.dir, 'driver-heartbeat.json'), join(run.dir, 'progress.json'))
  }
  let best = null
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const value = readJson(path, null)
    let atMs = null
    if (value) {
      atMs = [value.heartbeatAtMs, value.updatedAtMs, value.timeMs].find(Number.isFinite) ?? null
      if (atMs === null && typeof value.updatedAt === 'string') atMs = Date.parse(value.updatedAt)
      if (atMs === null && typeof value.heartbeatAt === 'string') atMs = Date.parse(value.heartbeatAt)
    }
    if (atMs === null || !Number.isFinite(atMs)) {
      try {
        atMs = statSync(path).mtimeMs
      } catch {
        continue
      }
    }
    if (!best || atMs > best.atMs) best = { source: path, atMs, value }
  }
  if (!best) return { source: null, atMs: null, ageMs: null, stale: false }
  const ageMs = now - best.atMs
  return { source: best.source, atMs: best.atMs, ageMs, stale: ageMs > LIMITS.supervisorWarningMs }
}

// --- alerts -------------------------------------------------------------------

function evaluateAlerts({ runs, heartbeat, lease, leaseInfo, now, limits, previous, stopRequested }) {
  const evaluations = []
  evaluations.push({
    code: 'DRIVER_HEARTBEAT_STALE',
    scope: 'pair',
    active: runs.length > 0 && heartbeat.ageMs !== null && heartbeat.ageMs > limits.supervisorWarningMs,
    detail: { source: heartbeat.source, ageMs: heartbeat.ageMs, warningMs: limits.supervisorWarningMs },
  })
  const rssHardSince = { ...(previous?.rssHardSince ?? {}) }
  for (const run of runs) {
    const sample = sampleResources({ run, lease, now })
    const rss = sample.hostRssBytes
    const soft = Number.isFinite(rss) && rss > limits.hostRssSoftBytes
    const hard = Number.isFinite(rss) && rss > limits.hostRssHardBytes
    if (hard) {
      if (!Number.isFinite(rssHardSince[run.runId])) rssHardSince[run.runId] = now
    } else {
      delete rssHardSince[run.runId]
    }
    const sustained = hard && Number.isFinite(rssHardSince[run.runId]) && now - rssHardSince[run.runId] >= limits.hostRssHardSustainedMs
    evaluations.push({ code: 'HOST_RSS_SOFT', scope: run.runId, active: soft, detail: { runId: run.runId, rssBytes: rss, softLimit: limits.hostRssSoftBytes } })
    evaluations.push({ code: 'HOST_RSS_HARD', scope: run.runId, active: sustained, detail: { runId: run.runId, rssBytes: rss, hardLimit: limits.hostRssHardBytes, sinceMs: rssHardSince[run.runId] ?? null } })
    if (Number.isFinite(sample.diskAvailableBytes)) {
      evaluations.push({ code: 'DISK_STOP', scope: run.runId, active: sample.diskAvailableBytes < limits.diskStopBelowBytes, detail: { runId: run.runId, availableBytes: sample.diskAvailableBytes, stopBelow: limits.diskStopBelowBytes } })
      evaluations.push({ code: 'DISK_PAUSE', scope: run.runId, active: sample.diskAvailableBytes < limits.diskPauseBelowBytes && sample.diskAvailableBytes >= limits.diskStopBelowBytes, detail: { runId: run.runId, availableBytes: sample.diskAvailableBytes, pauseBelow: limits.diskPauseBelowBytes } })
    }
  }
  return { evaluations, rssHardSince }
}

function applyAlerts({ alertPath, evaluations, previous, now, mirrorPaths = [] }) {
  const activeAlerts = { ...(previous?.activeAlerts ?? {}) }
  const emitted = []
  for (const evaluation of evaluations) {
    const key = evaluation.scope === 'pair' ? evaluation.code : `${evaluation.code}:${evaluation.scope}`
    const prior = activeAlerts[key]
    if (evaluation.active && !prior) {
      const row = { schemaVersion: SUPERVISOR_SCHEMA_VERSION, time: iso(now), monotonicMs: now, phase: 'raised', code: evaluation.code, scope: evaluation.scope, detail: evaluation.detail }
      appendJsonlRow(alertPath, row)
      for (const path of mirrorPaths) appendJsonlRow(path, row)
      activeAlerts[key] = { raisedAt: iso(now), code: evaluation.code, scope: evaluation.scope }
      emitted.push(row)
    } else if (!evaluation.active && prior) {
      const row = { schemaVersion: SUPERVISOR_SCHEMA_VERSION, time: iso(now), monotonicMs: now, phase: 'cleared', code: evaluation.code, scope: evaluation.scope, detail: evaluation.detail, raisedAt: prior.raisedAt }
      appendJsonlRow(alertPath, row)
      for (const path of mirrorPaths) appendJsonlRow(path, row)
      delete activeAlerts[key]
      emitted.push(row)
    }
  }
  return { activeAlerts, emitted }
}

// --- state machine ------------------------------------------------------------

function deriveState({ runs, previousState, previousLeaseState, supervisorHeld, stopRequested, hardStop }) {
  if (stopRequested || hardStop) return 'STOP_REQUESTED'
  if (!runs.length) return supervisorHeld ? 'READY' : previousLeaseState === 'expired' ? 'RECOVERING' : 'PLANNED'
  if (runs.some(run => run.traffic?.inFlight > 0)) return 'RUNNING'
  if (runs.some(run => run.checkpoint)) return 'READY'
  return 'PREFLIGHT'
}

// --- the poll -----------------------------------------------------------------

export function pollOnce(options = {}) {
  assertIds(options)
  const limits = { ...LIMITS, ...(options.limits ?? {}) }
  const now = options.now ?? Date.now()
  const roots = resolveRoots(options)
  mkdirSync(roots.pairDir, { recursive: true })
  const statePath = join(roots.pairDir, 'supervisor.json')
  const leasePath = join(roots.pairDir, 'supervisor-lease.json')
  const eventsPath = join(roots.pairDir, 'supervisor-events.jsonl')
  const alertsPath = join(roots.pairDir, 'alerts.jsonl')

  const previous = readJson(statePath, null)
  const identity = options.identity ?? createLeaseIdentity({ supervisorId: options.supervisorId })
  const previousLease = readJson(leasePath, null)
  const previousLeaseState = leaseState(previousLease, now, limits)
  const newWork = assertLeaseAllowsNewWork(previousLease, now, limits, { supervisorId: identity.supervisorId })
  const previousOwnerAlive = leaseOwnerAlive(previousLease)
  const canTakeover = ['none', 'expired', 'released'].includes(previousLeaseState.state) || previousLease?.supervisorId === identity.supervisorId || !previousOwnerAlive
  const rawRuns = listOwnedRuns(roots)
  for (const run of rawRuns) run.traffic = requestTraffic(run)
  const firstHost = rawRuns.find(run => run.host)?.host ?? null

  let lease = previousLease
  if (options.acquireLease !== false && canTakeover) {
    const acquired = previousLease?.supervisorId !== identity.supervisorId
    lease = {
      schemaVersion: LEASE_SCHEMA_VERSION,
      campaign: options.campaign,
      pair: options.pair,
      supervisorId: identity.supervisorId,
      pid: identity.pid,
      startIdentity: identity.startIdentity,
      runId: identity.runId ?? rawRuns[0]?.runId ?? null,
      launchId: identity.launchId ?? firstHost?.launchId ?? null,
      profile: identity.profile ?? firstHost?.profile ?? null,
      binaryRealpath: identity.binaryRealpath ?? realpathOrNull(options.dshBin) ?? realpathOrNull(firstHost?.dshBin),
      acquiredAt: previousLease?.supervisorId === identity.supervisorId ? previousLease.acquiredAt ?? iso(now) : iso(now),
      acquiredAtMs: previousLease?.supervisorId === identity.supervisorId ? previousLease.acquiredAtMs ?? now : now,
      heartbeatAt: iso(now),
      heartbeatAtMs: now,
      expiresAt: iso(now + limits.leaseExpiryMs),
      expiresAtMs: now + limits.leaseExpiryMs,
      releasedAt: null,
    }
    atomicWriteJson(leasePath, lease)
    if (acquired) {
      appendJsonlRow(eventsPath, {
        schemaVersion: SUPERVISOR_SCHEMA_VERSION,
        time: iso(now),
        monotonicMs: now,
        kind: 'lease',
        action: previousLeaseState.state === 'expired'
          ? 'acquired-after-expiry'
          : previousLease && !previousOwnerAlive ? 'acquired-after-owner-exit' : 'acquired',
        supervisorId: identity.supervisorId,
        previousSupervisorId: previousLease?.supervisorId ?? null,
        previousLeaseState: previousLeaseState.state,
      })
    }
  }
  const leaseInfo = leaseState(lease, now, limits)

  const heartbeat = driverHeartbeat(roots, now)
  const stopRequested = [join(roots.pairDir, 'stop.json'), options.stopFile].filter(Boolean).some(path => existsSync(path))
    || rawRuns.some(run => existsSync(join(run.dir, 'stop.json')))
  const { evaluations, rssHardSince } = evaluateAlerts({ runs: rawRuns, heartbeat, lease, leaseInfo, now, limits, previous, stopRequested })
  const hardStop = evaluations.some(evaluation => evaluation.active && (evaluation.code === 'HOST_RSS_HARD' || evaluation.code === 'DISK_STOP'))
  const mirrorPaths = rawRuns.map(run => join(run.dir, 'alerts.jsonl'))
  const { activeAlerts, emitted } = applyAlerts({ alertPath: alertsPath, evaluations, previous, now, mirrorPaths })

  // After this poll the effective owner is whichever lease survives: a fresh
  // expired lease is taken over, a live foreign lease still blocks new work.
  const ownedLease = lease?.supervisorId === identity.supervisorId && ['held', 'warning'].includes(leaseInfo.state)
  const state = deriveState({ runs: rawRuns, previousState: previous?.state ?? 'PLANNED', previousLeaseState: previousLeaseState.state, supervisorHeld: ownedLease, stopRequested, hardStop })
  const newWorkAllowed = ownedLease
  const newWorkReason = newWorkAllowed ? 'OK' : newWork.allowed ? 'LEASE_TAKEOVER_FAILED' : newWork.reason
  const reason = !rawRuns.length ? 'NOT_READY' : newWorkAllowed ? 'OK' : newWorkReason
  const ready = newWorkAllowed && rawRuns.length > 0

  const runs = rawRuns.map(run => ({
    arm: run.arm,
    runId: run.runId,
    dir: run.dir,
    declaration: run.checkpoint?.state ?? null,
    hostPid: run.host?.pid ?? null,
    hostStartIdentity: run.host?.startIdentity ?? null,
    inFlight: run.traffic.inFlight,
    requestsTornTail: run.traffic.tornTail || null,
  }))

  if (previous?.state !== state) {
    const row = { schemaVersion: SUPERVISOR_SCHEMA_VERSION, time: iso(now), monotonicMs: now, kind: 'state', from: previous?.state ?? null, to: state, reason }
    appendJsonlRow(eventsPath, row)
    for (const run of rawRuns) appendJsonlRow(join(run.dir, 'supervisor-events.jsonl'), row)
  }

  const resources = []
  for (const run of rawRuns) {
    const sample = sampleResources({ run, lease, now, supervisorPid: identity.pid, eventLoopLagMs: options.eventLoopLagMs ?? null })
    appendJsonlRow(join(run.dir, 'resources.jsonl'), sample)
    resources.push(sample)
  }

  // Stop handling only ever signals a process whose full ownership proof
  // matches. `--once` never terminates anything.
  const stopActions = []
  if (options.terminateOnStop === true && (state === 'STOP_REQUESTED' || stopRequested || hardStop)) {
    for (const run of rawRuns) {
      const { pid, expected } = hostProof(run)
      if (!Number.isFinite(pid)) continue
      const result = terminateOwned({ pid, expected, limits })
      const row = {
        schemaVersion: SUPERVISOR_SCHEMA_VERSION,
        time: iso(now),
        monotonicMs: now,
        kind: 'terminate',
        runId: run.runId,
        pid,
        killed: result.killed,
        reason: result.reason,
        signal: result.signal ?? null,
        problems: result.proof?.problems ?? [],
      }
      appendJsonlRow(eventsPath, row)
      appendJsonlRow(join(run.dir, 'supervisor-events.jsonl'), row)
      if (!result.killed) {
        appendJsonlRow(join(run.dir, 'alerts.jsonl'), { schemaVersion: SUPERVISOR_SCHEMA_VERSION, time: iso(now), monotonicMs: now, phase: 'raised', code: 'KILL_REFUSED_UNPROVEN_OWNERSHIP', scope: run.runId, detail: { pid, problems: result.proof?.problems ?? [], reason: result.reason } })
      }
      stopActions.push(row)
    }
  }

  const status = {
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    campaign: options.campaign,
    pair: options.pair,
    supervisorId: identity.supervisorId,
    pid: identity.pid,
    state,
    ready,
    reason,
    newWorkAllowed,
    newWorkReason,
    previousLeaseState: previousLeaseState.state,
    lease: lease
      ? { supervisorId: lease.supervisorId, pid: lease.pid, startIdentity: lease.startIdentity, runId: lease.runId, launchId: lease.launchId, profile: lease.profile, binaryRealpath: lease.binaryRealpath, acquiredAt: lease.acquiredAt, heartbeatAt: lease.heartbeatAt, expiresAt: lease.expiresAt, state: leaseInfo.state }
      : null,
    leaseExpiresAt: lease?.expiresAt ?? null,
    leaseExpiresAtMs: lease?.expiresAtMs ?? null,
    driverHeartbeat: { source: heartbeat.source, atMs: heartbeat.atMs, ageMs: heartbeat.ageMs, stale: heartbeat.ageMs !== null && heartbeat.ageMs > limits.supervisorWarningMs },
    runs,
    resources,
    stopActions,
    alertsActive: Object.keys(activeAlerts),
    alertsEmitted: emitted.length,
    limits,
    sampledAt: iso(now),
    sampledAtMs: now,
  }
  // The persisted heartbeat JSON stays small: resource samples live in
  // resources.jsonl, not in the state view.
  const { resources: _resourceSamples, ...smallStatus } = status
  atomicWriteJson(statePath, {
    ...smallStatus,
    activeAlerts,
    rssHardSince,
    updatedAt: iso(now),
    heartbeatAt: iso(now),
    heartbeatAtMs: now,
  })
  return status
}

/** Read-only status; does not acquire a lease or write anything. */
export function status(options = {}) {
  assertIds(options)
  const roots = resolveRoots(options)
  const limits = { ...LIMITS, ...(options.limits ?? {}) }
  const now = options.now ?? Date.now()
  const state = readJson(join(roots.pairDir, 'supervisor.json'), null)
  const lease = readJson(join(roots.pairDir, 'supervisor-lease.json'), null)
  const runs = listOwnedRuns(roots)
  const leaseInfo = leaseState(lease, now, limits)
  const newWork = assertLeaseAllowsNewWork(lease, now, limits)
  return {
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    campaign: options.campaign,
    pair: options.pair,
    state: state?.state ?? (runs.length ? 'PREFLIGHT' : 'PLANNED'),
    ready: newWork.allowed && runs.length > 0,
    reason: runs.length ? (newWork.allowed ? 'OK' : newWork.reason) : 'NOT_READY',
    newWorkAllowed: newWork.allowed,
    newWorkReason: newWork.reason,
    leaseState: leaseInfo.state,
    lease,
    runs: runs.map(run => ({ arm: run.arm, runId: run.runId, dir: run.dir })),
    sampledAt: iso(now),
    sampledAtMs: now,
  }
}

export function humanStatusLine(statusValue) {
  const alertText = statusValue.alertsActive?.length ? statusValue.alertsActive.join(',') : 'none'
  const driverAge = Number.isFinite(statusValue.driverHeartbeat?.ageMs) ? `${statusValue.driverHeartbeat.ageMs}ms` : 'unknown'
  return `[supervisor] ${statusValue.sampledAt} ${statusValue.campaign}/${statusValue.pair} state=${statusValue.state} ready=${statusValue.ready} readyReason=${statusValue.reason} lease=${statusValue.lease?.state ?? 'none'} driverHeartbeatAge=${driverAge} runs=${statusValue.runs.length} alerts=${alertText}`
}

// --- daemon -------------------------------------------------------------------

export function runDaemon(options = {}) {
  assertIds(options)
  const limits = { ...LIMITS, ...(options.limits ?? {}) }
  const roots = resolveRoots(options)
  const eventsPath = join(roots.pairDir, 'supervisor-events.jsonl')
  // One identity for the whole supervisor lifetime: a fresh id per poll would
  // make the supervisor lock itself out as a foreign owner.
  const identity = options.identity ?? createLeaseIdentity({ supervisorId: options.supervisorId })
  const heartbeat = monitorEventLoopDelay({ resolution: 20 })
  heartbeat.enable()
  let lastHuman = 0
  let stopped = false
  let resolveShutdown
  const finished = new Promise(resolvePromise => { resolveShutdown = resolvePromise })

  const poll = () => {
    try {
      const value = pollOnce({ ...options, identity, now: Date.now(), terminateOnStop: options.terminateOnStop !== false, eventLoopLagMs: Number.isFinite(heartbeat.mean) ? heartbeat.mean / 1e6 : null })
      const now = Date.now()
      if (now - lastHuman >= limits.humanStatusMs) {
        lastHuman = now
        process.stdout.write(humanStatusLine(value) + '\n')
      }
    } catch (error) {
      appendJsonlRow(eventsPath, { schemaVersion: SUPERVISOR_SCHEMA_VERSION, time: iso(Date.now()), monotonicMs: Date.now(), kind: 'error', error: String(error?.message ?? error) })
    }
  }

  const timer = setInterval(poll, limits.pollMs)
  poll()
  const shutdown = signal => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    heartbeat.disable()
    const leasePath = join(roots.pairDir, 'supervisor-lease.json')
    const lease = readJson(leasePath, null)
    if (lease) {
      atomicWriteJson(leasePath, { ...lease, releasedAt: iso(Date.now()), releasedAtMs: Date.now() })
      appendJsonlRow(eventsPath, { schemaVersion: SUPERVISOR_SCHEMA_VERSION, time: iso(Date.now()), monotonicMs: Date.now(), kind: 'lease', action: 'released', signal, supervisorId: lease.supervisorId })
    }
    process.stdout.write(`[supervisor] released on ${signal}\n`)
    resolveShutdown(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  return finished
}

// --- CLI ----------------------------------------------------------------------

export function parseArgs(argv = []) {
  const args = { once: false, help: false }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--once') args.once = true
    else if (token === '--help' || token === '-h') args.help = true
    else if (token === '--campaign') args.campaign = argv[++index]
    else if (token === '--pair') args.pair = argv[++index]
    else if (token === '--root') args.root = argv[++index]
    else if (token === '--stop-file') args.stopFile = argv[++index]
    else if (token === '--dsh-bin') args.dshBin = argv[++index]
    else if (token === '--poll-ms') args.pollMs = Number(argv[++index])
    else if (token === '--supervisor-id') args.supervisorId = argv[++index]
    else throw new Error(`UNKNOWN_ARGUMENT: ${token}`)
  }
  return args
}

export const USAGE = 'usage: node tests/live/longrun/supervise.mjs --campaign ID --pair PAIR [--once] [--root DIR] [--dsh-bin PATH]'

export async function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(String(error?.message ?? error) + '\n' + USAGE + '\n')
    return 2
  }
  if (args.help) {
    process.stdout.write(USAGE + '\n')
    return 0
  }
  if (!args.campaign || !args.pair) {
    process.stderr.write(USAGE + '\n')
    return 2
  }
  try {
    if (args.once) {
      const value = pollOnce({ ...args, now: Date.now(), acquireLease: true })
      process.stdout.write(JSON.stringify(value) + '\n')
      return 0
    }
    const limit = Number.isFinite(args.pollMs) ? { pollMs: args.pollMs } : {}
    await runDaemon({ ...args, limits: limit })
    return 0
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, error: String(error?.message ?? error) }) + '\n')
    return 1
  }
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false
if (invoked) {
  main().then(code => { process.exitCode = code }).catch(error => {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    process.exitCode = 1
  })
}
