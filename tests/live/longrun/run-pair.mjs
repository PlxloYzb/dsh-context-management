// Pair orchestration: exactly two concurrent runs, independent episode
// advancement, rendezvous only at precommitted expansion endpoints, and a
// data-driven extension rule. Never schedules a second pair.
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { atomicJson, readJson, campaignRoot } from './context.mjs'
import { commandSpec } from './plan.mjs'
import { Driver, chooseCommonEndpoint, LIMITS } from './driver.mjs'
import { generateCorpus, fixtureManifest } from './fixture.mjs'
import { createEventLog, createPromptJournal } from './checkpoint.mjs'
import { auditRun } from './audit.mjs'

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * Stop the pair's supervisor once the pair is terminal.
 *
 * The supervisor is an independent watchdog that runs until told otherwise, and
 * it is spawned with piped stdio. Without this the orchestrator's event loop
 * stays alive on those pipes forever after the pair settles: the CLI printed its
 * result and then never exited, holding the lease and its ports. Three abandoned
 * orchestrators from failed attempts were still running 30-40 minutes later
 * before this was added.
 */
export async function releaseSupervisor({ campaign, pairId }) {
  const pairRoot = join(campaignRoot(campaign), pairId)
  const lease = await readJson(join(pairRoot, 'supervisor.json'), null)
  if (!lease?.pid) return { released: false, reason: 'no-supervisor-record' }
  if (!processAlive(lease.pid)) return { released: false, reason: 'already-exited', pid: lease.pid }
  try { process.kill(lease.pid, 'SIGTERM') } catch { return { released: false, reason: 'signal-failed', pid: lease.pid } }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && processAlive(lease.pid)) await sleep(200)
  const exited = !processAlive(lease.pid)
  if (!exited) { try { process.kill(lease.pid, 'SIGKILL') } catch { /* reported below */ } }
  return { released: exited, pid: lease.pid, forced: !exited }
}

export async function ensureSupervisor({ campaign, pairId, dshBin }) {
  const pairRoot = join(campaignRoot(campaign), pairId)
  await mkdir(pairRoot, { recursive: true, mode: 0o700 })
  // Readiness is `ready === true` with a usable lease; the derived `state` field
  // stays PREFLIGHT until run checkpoints advance, so it is not the gate.
  const existing = await readJson(join(pairRoot, 'supervisor.json'), null)
  if (existing?.ready === true && existing.newWorkAllowed !== false
    && Date.parse(existing.leaseExpiresAt) > Date.now() && processAlive(existing.pid)) {
    return { attached: true, ...existing }
  }
  const log = join(pairRoot, 'supervisor.log')
  await writeFile(log, '', { mode: 0o600 })
  const child = spawn(process.execPath, [resolve('tests/live/longrun/supervise.mjs'), '--campaign', campaign, '--pair', pairId, '--dsh-bin', dshBin], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  })
  child.stdout.on('data', data => appendFileSync(log, data))
  child.stderr.on('data', data => appendFileSync(log, data))
  child.unref()
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const lease = await readJson(join(pairRoot, 'supervisor.json'), null)
    if (lease?.ready === true && lease.newWorkAllowed !== false) return { attached: false, ...lease }
    if (child.exitCode !== null) break
    await sleep(400)
  }
  throw new Error('SUPERVISOR_NOT_READY: independent supervisor did not reach READY within 30s')
}

// Every pair gets its own precommitted corpus derived from the shared hidden
// salt and that pair's seed. Both arms of the pair therefore read byte-identical
// material, and no arm can ever be given easier pages.
export async function loadSealedCampaign(campaign, seed) {
  const root = campaignRoot(campaign)
  const planJson = await readJson(join(root, 'plan.json'), null)
  if (!planJson) throw new Error(`Campaign ${campaign} is not prepared`)
  const salt = await readFile(join(root, 'private', 'hidden-salt'))
  const corpus = generateCorpus({ seed: seed ?? planJson.plan.schedule.pilot.seed, salt: salt.toString('hex'), episodes: planJson.plan.workload.maximumEpisodes })
  corpus.pageHeuristicTokens = (await import('./fixture.mjs')).pageTokens(corpus)
  const manifest = fixtureManifest(corpus)
  const sealedPath = join(root, 'private', 'corpora', `seed-${seed ?? planJson.plan.schedule.pilot.seed}.json`)
  const previous = await readJson(sealedPath, null)
  // A record sealed before the manifest carried its hash cannot be verified; say so
  // rather than passing unconditionally, which is what comparing `undefined` did.
  if (previous && typeof previous.hash === 'string' && previous.hash !== manifest.hash) throw new Error('SEALED_CORPUS_CHANGED: the hidden salt no longer reproduces the sealed corpus')
  if (!previous) await atomicJson(sealedPath, { ...manifest, pageHeuristicTokens: corpus.pageHeuristicTokens, seed: seed ?? planJson.plan.schedule.pilot.seed })
  return { root, plan: planJson.plan, geometry: planJson.geometry, planHash: planJson.planHash, planPath: planJson.planPath, corpus, corpusMeta: previous ?? manifest }
}

export async function drivePair({ campaign, pairId, dshBin, tarball, calibrationEpisodes = null }) {
  const pairRoot0 = join(campaignRoot(campaign), pairId)
  const pairSpec0 = await readJson(join(pairRoot0, 'pair.json'))
  const sealed = await loadSealedCampaign(campaign, pairSpec0.seed)
  const { plan, geometry, root, corpus } = sealed
  const pairRoot = pairRoot0
  const pairSpec = pairSpec0
  const seed = pairSpec.seed
  const candidate = await readJson(join(root, 'candidate.json'), {})
  const ports = pairSpec.ports ?? plan.environment.defaultPorts
  const { createRun } = await import('./driver.mjs')
  const runs = []
  for (const arm of pairSpec.startOrder) {
    const port = ports[arm]
    if (!Number.isSafeInteger(port)) throw new Error(`No port assigned to arm ${arm}`)
    const command = commandSpec(plan, geometry, arm, { port })
    const created = await createRun({
      plan, geometry, command, arm, seed, campaign, pairId, port, tarball,
      identity: candidate, planPath: sealed.planPath ?? 'docs/experiments/muse-longrun-v1.plan.json', planHash: sealed.planHash,
    })
    const driver = new Driver({
      plan, geometry, command, arm, seed,
      root: created.root, runId: created.runId, route: plan.environment.model,
      corpus, oracle: null, dshBin, tarball,
    })
    driver.runJson = created.runJson
    driver.campaign = campaign
    driver.pairId = pairId
    runs.push({ arm, port, command, driver, created })
  }
  // The supervisor only reports READY once it can see the two owned runs, so it
  // is started after the immutable run directories exist.
  const supervisor = await ensureSupervisor({ campaign, pairId, dshBin })
  await atomicJson(join(pairRoot, 'supervisor-attach.json'), { supervisor, at: new Date().toISOString() })
  // Driver heartbeat: a small JSON refreshed every 5s, written even when nothing
  // changed, so supervisor staleness alerts mean a real stall.
  const heartbeat = { path: join(pairRoot, 'driver-heartbeat.json'), timer: null }
  const beat = () => {
    const now = Date.now()
    try {
      writeFileSync(heartbeat.path, JSON.stringify({
        schemaVersion: 1, campaign, pairId, driverPid: process.pid,
        heartbeatAt: new Date(now).toISOString(), heartbeatAtMs: now, updatedAt: new Date(now).toISOString(),
        runs: runs.map(run => ({ arm: run.arm, runId: run.driver.runId, episode: run.driver.progress.episode })),
      }) + '\n', { mode: 0o600 })
    } catch { /* a missing heartbeat is reported by the supervisor, never hidden */ }
  }
  beat()
  heartbeat.timer = setInterval(beat, 5000)
  const results = await Promise.all(runs.map(async run => {
    const driver = run.driver
    let caffeine = null
    try {
      // Task-owned sleep prevention for the duration of this pair only.
      if (process.platform === 'darwin') caffeine = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
      await driver.prepare()
      await driver.launch('initial')
      await driver.openSession()
      await driveToEndpoint(driver, pairRoot, { calibrationEpisodes })
      return { arm: run.arm, runId: driver.runId, ok: true, terminalReason: driver.progress.terminalReason }
    } catch (error) {
      await driver.finalize({ terminalReason: classifyTerminal(error), error }).catch(() => {})
      return { arm: run.arm, runId: driver.runId, ok: false, error: String(error.message ?? error), terminalReason: driver.progress.terminalReason ?? classifyTerminal(error) }
    } finally {
      caffeine?.kill('SIGTERM')
      if (driver.host) await driver.host.stop().catch(() => {})
    }
  }))
  if (heartbeat.timer) clearInterval(heartbeat.timer)
  for (const run of runs) {
    // Score BEFORE auditing. The audit's probe-clean long-tail observation is
    // something the scorer measures, so auditing first read no score at all,
    // reported the count as 0, and wrote a coverage verdict that its own re-run
    // immediately contradicted.
    const { scoreRun } = await import('./score.mjs')
    await scoreRun({ campaign, pairId, arm: run.arm, runId: run.driver.runId }).catch(error => {
      results.push({ arm: run.arm, scoreError: String(error.message ?? error) })
    })
    await auditRun({ campaign, pairId, arm: run.arm, runId: run.driver.runId }).catch(error => {
      results.push({ arm: run.arm, auditError: String(error.message ?? error) })
    })
    const { writeResult } = await import('./audit.mjs')
    await writeResult({ campaign, pairId, arm: run.arm, runId: run.driver.runId }).catch(error => {
      results.push({ arm: run.arm, resultError: String(error.message ?? error) })
    })
  }
  // The pair is terminal, so its watchdog has nothing left to watch. Releasing it
  // is also what lets this process exit.
  const supervisorRelease = await releaseSupervisor({ campaign, pairId }).catch(error => ({ released: false, reason: String(error.message ?? error) }))
  await atomicJson(join(pairRoot, 'pair-result.json'), { campaign, pairId, finishedAt: new Date().toISOString(), supervisorRelease, results })
  return { runs: results, supervisorRelease }
}

export function classifyTerminal(error) {
  const message = String(error?.message ?? error)
  if (message.startsWith('AMBIGUOUS_DISPATCH')) return 'AMBIGUOUS_DISPATCH'
  if (message.startsWith('SUPERVISOR')) return 'INFRA_INTERRUPTED'
  if (message.startsWith('RUN_DEADLINE')) return 'COVERAGE_INCOMPLETE'
  if (message.includes('INVALID')) return 'INVALID_EVIDENCE'
  return 'FAILED_PRODUCT'
}

// One arm advances independently; the pair only rendezvous at precommitted
// expansion endpoints, after completed turns, exactly as the protocol requires.
export async function driveToEndpoint(driver, pairRoot, { calibrationEpisodes = null } = {}) {
  const plan = driver.plan
  const endpoints = plan.probes.endpoints.map(endpoint => endpoint.endpointEpisodes)
  await driver.setState('RUNNING', 'episode 1')
  const limit = calibrationEpisodes ?? endpoints.at(-1)
  // Resume derives the first incomplete episode from the durable dispatch
  // journal rather than from a counter a crash may have left behind.
  const startEpisode = firstIncompleteEpisode(driver)
  if (startEpisode > 1) await driver.log('resume-start-episode', { startEpisode, progressEpisode: driver.progress.episode })
  let reachedEndpoint = 0
  // The ARC arm has to be able to prove which backend is active (I07). Doing it
  // once, up front, is the difference between a decidable gate and a coin flip.
  if (driver.arm === 'ARC_DEFERRED') await driver.attestBackend()
  for (let episode = startEpisode; episode <= limit; episode++) {
    await driver.runEpisode(episode)
    await driver.runSentinel(episode)
    if (episode === plan.schedule.plannedRestart.afterEpisode) {
      // The planned restart is driven from durable evidence: a resume that finds
      // an existing verified restart record must not restart the host again.
      const existing = existsSync(join(pairRoot, `restart-${driver.arm}.json`))
      const evidence = existing ? await readJson(join(pairRoot, `restart-${driver.arm}.json`), null) : await driver.openSession({ restart: true })
      if (!existing) await atomicJson(join(pairRoot, `restart-${driver.arm}.json`), evidence)
      driver.restartEvidence = [evidence]
      await driver.persist({ restartVerified: evidence?.verified === true })
    }
    if (!endpoints.includes(episode)) continue
    reachedEndpoint = episode
    const decision = chooseCommonEndpoint(plan, {
      episodesCovered: episode,
      foregroundVerifiedTokens: driver.progress.usage?.foregroundVerifiedTokens ?? 0,
      uniqueExposedSourceTokens: driver.progress.coverage?.uniqueSourceTokens ?? 0,
    })
    await atomicJson(join(pairRoot, `barrier-${driver.arm}-E${episode}.json`), {
      arm: driver.arm, episode, at: new Date().toISOString(),
      floorMet: decision.endpoint === episode,
      foregroundVerifiedTokens: driver.progress.usage?.foregroundVerifiedTokens ?? 0,
      uniqueSourceTokens: driver.progress.coverage?.uniqueSourceTokens ?? 0,
    })
    const wait = await waitForPeerBarrier(pairRoot, driver.arm, episode)
    await driver.log('endpoint-barrier', { endpoint: episode, waitedMs: wait.waitedMs })
    await driver.persist({ schedulerBarrierMs: (driver.progress.schedulerBarrierMs ?? 0) + wait.waitedMs })
    const peer = readJsonSync(join(pairRoot, `barrier-${peerArm(driver.arm)}-E${episode}.json`), null)
    // The expansion rule is symmetric: unless BOTH arms have satisfied the token
    // and new-material floors, both take the same next precommitted block.
    // An arm that reached the precommitted endpoint on its own may still run its
    // own final probe when the peer is terminal: the probe scores THIS arm's
    // quality, and refusing it would throw away a 10M-token journey because the
    // other arm died. The pair-level comparison stays explicitly unavailable.
    const peerFloorMet = peer?.floorMet === true
    const bothMet = decision.endpoint === episode && peerFloorMet
    const ownFloorMet = decision.endpoint === episode || own?.floorMet === true
    await driver.log('endpoint-decision', { endpoint: episode, decision, peerFloorMet: peer?.floorMet ?? null, bothMet, unpaired: !peerFloorMet && ownFloorMet })
    if (bothMet || (!peerFloorMet && ownFloorMet && peer === null)) {
      await driver.runFinalProbe(episode)
      await driver.finalize({ terminalReason: 'COMPLETED' })
      return episode
    }
  }
  // A resume whose episodes are all durably complete must still evaluate the
  // precommitted endpoint it already reached instead of silently ending short.
  if (reachedEndpoint === 0 && endpoints.includes(limit)) {
    const peer = readJsonSync(join(pairRoot, `barrier-${peerArm(driver.arm)}-E${limit}.json`), null)
    const decision = chooseCommonEndpoint(plan, {
      episodesCovered: limit,
      foregroundVerifiedTokens: driver.progress.usage?.foregroundVerifiedTokens ?? 0,
      uniqueExposedSourceTokens: driver.progress.coverage?.uniqueSourceTokens ?? 0,
    })
    const own = readJsonSync(join(pairRoot, `barrier-${driver.arm}-E${limit}.json`), null)
    const ownFloorMet = decision.endpoint === limit || own?.floorMet === true
    const peerFloorMet = peer?.floorMet === true
    const bothMet = ownFloorMet && peerFloorMet
    await driver.log('endpoint-decision', { endpoint: limit, decision, resumed: true, peerFloorMet: peer?.floorMet ?? null, bothMet, unpaired: !peerFloorMet && ownFloorMet })
    if (bothMet || (!peerFloorMet && ownFloorMet && peer === null)) {
      await driver.runFinalProbe(limit)
      await driver.finalize({ terminalReason: 'COMPLETED' })
      return limit
    }
  }
  // A calibration prefix stops on its own budget; it never claims the token or
  // material floor and never runs the sealed final probe.
  if (calibrationEpisodes !== null) {
    await driver.finalize({ terminalReason: 'CALIBRATION_PREFIX', calibrationEpisodes })
    return driver.progress.episode
  }
  await driver.finalize({ terminalReason: 'COVERAGE_INCOMPLETE' })
  return endpoints.at(-1)
}

// The highest episode whose bounded work turn is durably completed, plus one.
// The result is clamped to the precommitted endpoint sequence so a resume can
// never advance past an endpoint the experiment already sealed.
export function firstIncompleteEpisode(driver) {
  let last = 0
  for (const row of driver.journal.rows()) {
    const match = /^E(\d+)-WORK$/.exec(row.logicalPromptId ?? '')
    if (match && row.phase === 'completed') last = Math.max(last, Number(match[1]))
  }
  const candidate = Math.max(last + 1, (driver.progress.episode ?? 0) + 1)
  const endpoints = driver.plan.probes.endpoints.map(endpoint => endpoint.endpointEpisodes)
  // A journey already complete through an endpoint resumes at that endpoint so
  // the sealed probe is evaluated instead of advancing to the next block.
  const reached = endpoints.filter(endpoint => endpoint <= last)
  if (reached.length > 0 && candidate > reached.at(-1)) return reached.at(-1)
  return Math.min(candidate, endpoints.at(-1))
}

export function peerArm(arm) {
  return arm === 'ARC_DEFERRED' ? 'BASIC_MATCHED' : 'ARC_DEFERRED'
}

function readJsonSync(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

export async function waitForPeerBarrier(pairRoot, arm, endpoint) {
  const others = ['ARC_DEFERRED', 'BASIC_MATCHED'].filter(name => name !== arm)
  const started = Date.now()
  while (Date.now() - started < LIMITS.runWorkHardMs) {
    const pending = others.filter(other => !existsSync(join(pairRoot, `barrier-${other}-E${endpoint}.json`)))
    if (!pending.length) return { waitedMs: Date.now() - started, peerTerminal: false }
    // A terminal peer will never reach this endpoint, so waiting the full work
    // deadline for it is a deadlock: a Basic arm that failed at E19 parked the ARC
    // arm at the E24 barrier for six hours. Report the peer as terminal so the
    // endpoint decision is recorded as not-barriered instead of hanging.
    const terminal = pending.filter(other => readJsonSync(peerProgressPath(pairRoot, other), null)?.terminalReason)
    if (terminal.length === pending.length) return { waitedMs: Date.now() - started, peerTerminal: true, terminalPeers: terminal }
    await sleep(2000)
  }
  throw new Error(`PAIR_BARRIER_TIMEOUT at endpoint ${endpoint}`)
}

/**
 * Stop any host process this run recorded and that is still alive.
 *
 * Ownership is taken from the run's own launch records, never from a port scan,
 * so a host belonging to another run is never touched.
 */
async function reclaimOwnedHosts(runRoot) {
  const hostDir = join(runRoot, 'host')
  if (!existsSync(hostDir)) return []
  const reclaimed = []
  for (const name of readdirSync(hostDir)) {
    if (!name.startsWith('launch-') || !name.endsWith('.json')) continue
    const launch = readJsonSync(join(hostDir, name), null)
    if (!launch?.pid || !processAlive(launch.pid)) continue
    try { process.kill(launch.pid, 'SIGTERM') } catch { /* reported as not reclaimed */ }
    const deadline = Date.now() + 10000
    while (Date.now() < deadline && processAlive(launch.pid)) await sleep(200)
    if (processAlive(launch.pid)) { try { process.kill(launch.pid, 'SIGKILL') } catch { /* reported below */ } }
    reclaimed.push({ launchId: launch.launchId, pid: launch.pid, alive: processAlive(launch.pid) })
  }
  return reclaimed
}

/** Locate a peer arm's live progress record without knowing its run id. */
function peerProgressPath(pairRoot, arm) {
  try {
    const dir = join(pairRoot, arm)
    const runId = readdirSync(dir).find(name => name.startsWith('main-') || name.startsWith('pilot-'))
    return runId === undefined ? join(dir, 'progress.json') : join(dir, runId, 'progress.json')
  } catch { return join(pairRoot, arm, 'progress.json') }
}

// Resume reconciles against durable state instead of replaying a command line:
// it re-attaches to each existing run, reopens the host, reuses the recorded
// session, and continues from the first episode without a completed turn.
export async function resumePair({ campaign, pairId, dshBin, tarball }) {
  const pairRoot = join(campaignRoot(campaign), pairId)
  const pairSpec = await readJson(join(pairRoot, 'pair.json'), null)
  if (!pairSpec) throw new Error(`Pair ${pairId} is not sealed; nothing to resume`)
  const sealed = await loadSealedCampaign(campaign, pairSpec.seed)
  const { plan, geometry, root, corpus } = sealed
  const candidate = await readJson(join(root, 'candidate.json'), {})
  const { Driver } = await import('./driver.mjs')
  const { listRuns } = await import('./context.mjs')
  const existing = await listRuns(campaign, pairId)
  if (existing.length !== 2) throw new Error(`RESUME_REQUIRES_TWO_RUNS: found ${existing.length}`)
  const { auditRun } = await import('./audit.mjs')
  const results = []
  for (const run of existing) {
    const entry = run.run
    const command = commandSpec(plan, geometry, run.arm, { port: pairSpec.ports?.[run.arm] ?? entry.port })
    const driver = new Driver({
      plan, geometry, command, arm: run.arm, seed: pairSpec.seed,
      root: run.root, runId: run.runId, route: plan.environment.model,
      corpus, oracle: null, dshBin, tarball,
      // The resumed driver must carry its identity: without it the sealed final
      // probe cannot be located, and a run that completed every episode died at
      // the probe with "Driver has no campaign/pair identity".
      campaign, pairId,
    })
    const progress = await readJson(join(run.root, 'progress.json'), {})
    driver.progress = { ...driver.progress, ...progress }
    const homeRecord = await readJson(join(run.root, 'host', 'isolated-home.json'), null)
    if (!homeRecord) { results.push({ arm: run.arm, runId: run.runId, ok: false, error: 'NO_ISOLATED_HOME' }); continue }
    const { launchHost } = await import('./host.mjs')
    driver.home = { ...homeRecord, env: { ...process.env, DSH_HOME: homeRecord.home, COREPACK_ENABLE_AUTO_PIN: '0' } }
    driver.patch = join(run.root, 'host.patch.yml')
    driver.sessionId = progress.sessionId
    if (!driver.sessionId) { results.push({ arm: run.arm, runId: run.runId, ok: false, error: 'NO_SESSION_ID' }); continue }
    try {
      await atomicJson(join(run.root, 'recovery', `resume-${Date.now()}.json`), { resumedAt: new Date().toISOString(), episode: progress.episode ?? 0, sessionId: driver.sessionId })
      // A killed orchestrator leaks its host: the SIGTERM skips the finally that
      // stops it, and the port stays bound. Resuming then dies on
      // `loopback Web launch URL unavailable`. Reclaim the run's own recorded
      // host process before launching, and record what was reclaimed.
      const reclaimed = await reclaimOwnedHosts(run.root)
      if (reclaimed.length) await atomicJson(join(run.root, 'recovery', `reclaimed-${Date.now()}.json`), { reclaimed, at: new Date().toISOString() })
      // A resumed run is live again: a stale terminalReason makes the record lie
      // about it and, worse, makes a peer treat it as terminal at a barrier.
      driver.progress = { ...driver.progress, state: 'RECOVERING', terminalReason: null, error: null, finishedAt: null }
      driver.host = await launchHost({ dshBin, root: run.root, profile: homeRecord.profile, patch: driver.patch, port: command.port, env: driver.home.env }, `${run.runId}-resume-${Date.now()}`)
      await driver.host.client.call('session/selectModel', { sessionId: driver.sessionId, ...plan.environment.model })
      await driveToEndpoint(driver, pairRoot)
      results.push({ arm: run.arm, runId: run.runId, ok: true, terminalReason: driver.progress.terminalReason })
    } catch (error) {
      await driver.finalize({ terminalReason: classifyTerminal(error), error }).catch(() => {})
      results.push({ arm: run.arm, runId: run.runId, ok: false, error: String(error.message ?? error), stack: String(error.stack ?? '').split('\n').slice(0, 5) })
    } finally {
      if (driver.host) await driver.host.stop().catch(() => {})
    }
    // A resumed run needs the same score-then-audit-then-result chain as a fresh
    // one, in that order and for the same reason.
    const { scoreRun } = await import('./score.mjs')
    await scoreRun({ campaign, pairId, arm: run.arm, runId: run.runId }).catch(() => {})
    await auditRun({ campaign, pairId, arm: run.arm, runId: run.runId }).catch(() => {})
    const { writeResult } = await import('./audit.mjs')
    await writeResult({ campaign, pairId, arm: run.arm, runId: run.runId }).catch(() => {})
  }
  await atomicJson(join(pairRoot, 'resume-result.json'), { campaign, pairId, results, at: new Date().toISOString() })
  return { runs: results, candidate }
}
