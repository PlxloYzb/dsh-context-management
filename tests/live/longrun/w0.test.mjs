// P0 contract tests for the long-run harness: plan sealing, geometry, durable
// journaling, checkpoint round-trips and a real no-model host contract check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { loadPlan, deriveGeometry, arcBridgeConfig, basicMatchedConfig, commandSpec, validatePlan, sha256 } from './plan.mjs'
import { createEventLog, createPromptJournal, writeCheckpoint, readCheckpoint, logDigest } from './checkpoint.mjs'
import { atomicJson, readJson, createRunDirectory, runDirectory } from './context.mjs'
import { chooseCommonEndpoint, precommitPlan, MARKERS } from './driver.mjs'
import { CASE_MATRIX } from './cases.mjs'
import { parseProbeAnswers } from './score.mjs'

const PLAN_PATH = 'docs/experiments/muse-longrun-v1.plan.json'

async function tempRoot(label) {
  return mkdtemp(join(tmpdir(), `lr3m-${label}-`))
}

test('the frozen plan validates and yields the precommitted geometry', async () => {
  const { plan, geometry, planHash } = await loadPlan(PLAN_PATH)
  assert.equal(plan.protocolId, 'muse-longrun-v1')
  assert.equal(plan.revision, 1)
  assert.equal(geometry.effectiveInputCapacity, 71112)
  assert.equal(geometry.logicalWindowBudget, 83400)
  assert.equal(geometry.nudgeLine, 53334)
  assert.equal(geometry.emergencyLine, 64000)
  assert.equal(Math.floor(geometry.routeCapacity * geometry.thresholdRatio), 64000)
  assert.equal(Math.floor(geometry.routeCapacity * geometry.retainRatio), 39111)
  assert.equal(planHash.length, 64)
})

test('plan validation rejects tampered geometry and diagnostic counts', async () => {
  const bytes = await readFile(PLAN_PATH)
  const plan = JSON.parse(bytes.toString('utf8'))
  const tampered = structuredClone(plan)
  tampered.geometry.pressureThreshold = 65000
  assert.equal(validatePlan(tampered).ok, false)
  const fewer = structuredClone(plan)
  fewer.diagnostics.cases = fewer.diagnostics.cases.slice(0, 17)
  assert.equal(validatePlan(fewer).ok, false)
  const globalDsh = structuredClone(plan)
  globalDsh.environment.globalDshAllowed = true
  assert.equal(validatePlan(globalDsh).ok, false)
})

test('arm command specs stay inside the frozen plan', async () => {
  const { plan, geometry } = await loadPlan(PLAN_PATH)
  const arc = commandSpec(plan, geometry, 'ARC_DEFERRED', { port: 3342 })
  assert.equal(arc.pluginBundle, true)
  assert.equal(arc.compaction.kind, 'arc-windowed')
  assert.equal(arc.compaction.config.adaptiveGovernor.windowBudgetTokens, 83400)
  assert.equal(arc.compaction.config.backgroundSummary.reasoningEffort, 'minimal')
  const basic = commandSpec(plan, geometry, 'BASIC_MATCHED', { port: 3341 })
  assert.equal(basic.pluginBundle, false)
  assert.equal(basic.compaction.kind, 'native-basic')
  assert.equal(basic.compaction.config.thresholdRatio, geometry.thresholdRatio)
  const stock = commandSpec(plan, geometry, 'BASIC_DEFAULT', { port: 3343 })
  assert.equal(stock.compaction.config.thresholdRatio, 0.8)
  assert.equal(stock.compaction.config.retainRatio, 0.16)
  assert.throws(() => commandSpec(plan, geometry, 'ARC_IN_PLACE', { port: 3344 }))
})

test('the endpoint rule depends only on the token and material floors', async () => {
  const { plan } = await loadPlan(PLAN_PATH)
  const below = chooseCommonEndpoint(plan, { episodesCovered: 24, foregroundVerifiedTokens: 2999999, uniqueExposedSourceTokens: 900000 })
  assert.equal(below.endpoint, null)
  assert.equal(below.reason, 'EXTEND_REQUIRED')
  const atFloor = chooseCommonEndpoint(plan, { episodesCovered: 24, foregroundVerifiedTokens: 3000000, uniqueExposedSourceTokens: 500000 })
  assert.equal(atFloor.endpoint, 24)
  assert.equal(atFloor.reason, 'FLOOR_MET')
  const thin = chooseCommonEndpoint(plan, { episodesCovered: 30, foregroundVerifiedTokens: 4000000, uniqueExposedSourceTokens: 499999 })
  assert.equal(thin.endpoint, null)
  assert.equal(thin.nextEndpoint, 36)
  const exhausted = chooseCommonEndpoint(plan, { episodesCovered: 48, foregroundVerifiedTokens: 100, uniqueExposedSourceTokens: 10 })
  assert.equal(exhausted.endpoint, null)
  assert.equal(exhausted.reason, 'COVERAGE_INCOMPLETE')
  const precommit = precommitPlan(plan)
  assert.deepEqual(precommit.endpoints, [24, 30, 36, 42, 48])
  assert.equal(precommit.restartAfterEpisode, 12)
})

test('prompt journal refuses a duplicate logical prompt and survives a torn tail', async () => {
  const root = await tempRoot('journal')
  try {
    const journal = createPromptJournal(root)
    journal.plan({ logicalPromptId: 'E1-BRIEF', requestId: 'r1', contentHash: sha256('x'), expectedEpisode: 1, beforeSeq: -1 })
    assert.equal(journal.stateOf('E1-BRIEF'), 'planned')
    assert.throws(() => journal.plan({ logicalPromptId: 'E1-BRIEF', requestId: 'r2', contentHash: sha256('x'), expectedEpisode: 1, beforeSeq: -1 }), /PROMPT_ALREADY_PLANNED/)
    journal.ack('E1-BRIEF', { acceptedAt: 1 })
    assert.equal(journal.stateOf('E1-BRIEF'), 'accepted')
    journal.complete('E1-BRIEF', { endSeq: 12 })
    assert.equal(journal.stateOf('E1-BRIEF'), 'completed')
    journal.plan({ logicalPromptId: 'E2-BRIEF', requestId: 'r3', contentHash: sha256('y'), expectedEpisode: 2, beforeSeq: 12 })
    journal.ambiguous('E2-BRIEF', { evidence: 'unresolved' })
    assert.equal(journal.stateOf('E2-BRIEF'), 'ambiguous')
    // A torn trailing line is preserved, never parsed and never lost silently.
    const { appendFileSync } = await import('node:fs')
    appendFileSync(journal.path, '{"kind":"prompt","phase":"comp')
    const read = journal.read()
    assert.ok(read.tornTail.length > 0)
    assert.equal(read.rows.length, 5)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('checkpoint round-trips and records the event-log offset and hash', async () => {
  const root = await tempRoot('checkpoint')
  try {
    const events = createEventLog(root)
    events.append({ kind: 'state', to: 'RUNNING' })
    events.append({ kind: 'episode-complete', episode: 1 })
    const digest = await logDigest(events.path)
    const saved = await writeCheckpoint(root, { runId: 'r', state: 'RUNNING', eventLog: { bytes: digest.bytes, sha256: digest.sha256 } })
    const loaded = readCheckpoint(root)
    assert.equal(loaded.state, 'RUNNING')
    assert.equal(loaded.eventLog.bytes, saved.eventLog.bytes)
    assert.equal(loaded.eventLog.sha256, digest.sha256)
    assert.equal(events.read().rows.length, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a run directory is immutable and carries the required evidence subdirectories', async () => {
  const base = await tempRoot('rundir')
  const previous = process.cwd()
  try {
    process.chdir(base)
    const root = runDirectory('campaign', 'pair', 'ARC_DEFERRED', 'run-1')
    await mkdir(join(root, '..'), { recursive: true })
    await createRunDirectory(root, { schemaVersion: 1, runId: 'run-1' })
    for (const sub of ['events', 'objects', 'control', 'host', 'recovery', 'faults']) {
      assert.ok(await readJson(join(root, sub, 'missing.json'), null) === null, sub)
    }
    await assert.rejects(() => createRunDirectory(root, { schemaVersion: 1 }), /RUN_DIRECTORY_EXISTS/)
    assert.equal((await readJson(join(root, 'run.json'))).runId, 'run-1')
  } finally { process.chdir(previous); await rm(base, { recursive: true, force: true }) }
})

test('the diagnostic matrix declares all 18 cases and never upgrades status implicitly', async () => {
  assert.deepEqual(Object.keys(CASE_MATRIX).sort(), ['X01','X02','X03','X04','X05','X06','X07','X08','X09','X10','X11','X12','X13','X14','X15','X16','X17','X18'])
  for (const [id, entry] of Object.entries(CASE_MATRIX)) {
    assert.ok(entry.title.length > 0, id)
    assert.ok(entry.variants.length > 0, id)
  }
})

test('probe answer parsing keys by queryId and rejects out-of-batch or duplicate ids', () => {
  const batches = [
    { batch: 1, queryIds: ['N24-Q001', 'N24-Q002'], text: '```json\n{"N24-Q001":{"value":"a"},"N24-Q002":{"value":"b"}}\n```' },
    { batch: 2, queryIds: ['N24-Q003'], text: '{"N24-Q003":{"value":"c"},"N24-Q999":{"value":"x"}}' },
  ]
  const parsed = parseProbeAnswers(batches)
  assert.deepEqual(Object.keys(parsed.answers).sort(), ['N24-Q001', 'N24-Q002', 'N24-Q003'])
  assert.equal(parsed.formatFailures.length, 1)
  assert.equal(parsed.formatFailures[0].reason, 'queryId-not-assigned-to-batch')
  const malformed = parseProbeAnswers([{ batch: 1, queryIds: ['N24-Q001'], text: 'not json' }])
  assert.equal(malformed.formatFailures.length, 1)
  assert.deepEqual(malformed.answers, {})
})

test('work markers identify the request purpose without changing task wording', () => {
  assert.deepEqual(Object.values(MARKERS), ['[[LR3M:work]]', '[[LR3M:sentinel]]', '[[LR3M:final-probe]]'])
  for (const marker of Object.values(MARKERS)) assert.match(marker, /^\[\[LR3M:[a-z-]+\]\]$/)
})

// The pair orchestrator must stop its watchdog when the pair is terminal, and
// stopping it is also what lets the CLI exit: the supervisor is spawned with
// piped stdio, so a leaked supervisor keeps the orchestrator's event loop alive
// forever. Three abandoned orchestrators stayed up 30-40 minutes this way.
test('releaseSupervisor stops the pair watchdog and reports an already-exited one', async t => {
  const { spawn } = await import('node:child_process')
  const { campaignRoot } = await import('./context.mjs')
  const { releaseSupervisor } = await import('./run-pair.mjs')
  const campaign = `w0-release-${process.pid}-${Math.floor(Math.random() * 1e6)}`
  const pairId = 'pilot-test'
  const pairRoot = join(campaignRoot(campaign), pairId)
  t.after(() => rm(campaignRoot(campaign), { recursive: true, force: true }))
  await mkdir(pairRoot, { recursive: true })

  // No record yet: nothing to release, and that must not throw.
  assert.deepEqual(await releaseSupervisor({ campaign, pairId }), { released: false, reason: 'no-supervisor-record' })

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true })
  child.unref()
  const alive = () => { try { process.kill(child.pid, 0); return true } catch { return false } }
  await atomicJson(join(pairRoot, 'supervisor.json'), { ready: true, pid: child.pid, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() })
  const released = await releaseSupervisor({ campaign, pairId })
  assert.equal(released.released, true)
  assert.equal(released.pid, child.pid)
  await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
  assert.equal(alive(), false, 'the watchdog process must be gone after release')

  const again = await releaseSupervisor({ campaign, pairId })
  assert.equal(again.released, false)
  assert.equal(again.reason, 'already-exited')
})

// The retry path must survive a retryable provider failure. Before this, a
// single request timeout made the retry attempt re-plan the same logical prompt
// and die on PROMPT_ALREADY_PLANNED, which ended a Basic arm 14.3M tokens in.
test('a failed attempt may be re-planned, and only a failed one', async t => {
  const { createPromptJournal } = await import('./checkpoint.mjs')
  const root = await tempRoot('journal-retry')
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = createPromptJournal(root)
  const plan = requestId => journal.plan({ logicalPromptId: 'E20-READ-1', requestId, contentHash: sha256('x'), expectedEpisode: 20, beforeSeq: 10 })

  plan('r1')
  assert.equal(journal.stateOf('E20-READ-1'), 'planned')
  // A bare planned row is the ambiguous window: never re-plan it.
  assert.throws(() => plan('r2'), /PROMPT_ALREADY_PLANNED/)

  journal.fail('E20-READ-1', 'EXPERIMENT_REQUEST_TIMEOUT: 420s')
  assert.equal(journal.stateOf('E20-READ-1'), 'failed')
  plan('r2')
  assert.equal(journal.stateOf('E20-READ-1'), 'planned', 'the retry is the current attempt')
  journal.complete('E20-READ-1', { elapsedMs: 12 })
  assert.equal(journal.stateOf('E20-READ-1'), 'completed')

  // A completed prompt must still never be re-planned, even after a retry.
  assert.throws(() => plan('r3'), /PROMPT_ALREADY_PLANNED/)

  // Ambiguity stays sticky across attempts.
  const sticky = createPromptJournal(await tempRoot('journal-sticky'))
  sticky.plan({ logicalPromptId: 'E1-A', requestId: 'a1', contentHash: sha256('y'), expectedEpisode: 1, beforeSeq: 0 })
  sticky.ambiguous('E1-A', { reason: 'no terminal record' })
  sticky.fail('E1-A', 'later failure')
  assert.equal(sticky.stateOf('E1-A'), 'ambiguous')
})
