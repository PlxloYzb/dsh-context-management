// Operator recovery: run ONLY the sealed final probe for a run whose episode
// journey already completed. This exists because a harness fault after the last
// episode must not force a re-spend of the whole journey, and it must never
// re-run or extend episodes.
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { campaignRoot, readJson, atomicJson, listRuns } from './context.mjs'
import { commandSpec } from './plan.mjs'
import { Driver } from './driver.mjs'
import { launchHost } from './host.mjs'
import { loadSealedCampaign } from './run-pair.mjs'
import { auditRun } from './audit.mjs'
import { scoreRun } from './score.mjs'

// The session id is durable in the control directory even for runs whose run
// document predates the session.
async function resolveSessionId(root) {
  const entries = await readdir(join(root, 'control')).catch(() => [])
  const match = entries.find(name => name.endsWith('.session.json'))
  if (!match) return null
  return JSON.parse(readFileSync(join(root, 'control', match), 'utf8')).sessionId ?? null
}

export async function recoverProbe({ campaign, pairId, endpoint, dshBin, tarball, arm = null }) {
  const pairRoot = join(campaignRoot(campaign), pairId)
  const pairSpec = await readJson(join(pairRoot, 'pair.json'), null)
  if (!pairSpec) throw new Error(`Pair ${pairId} is not sealed`)
  const sealed = await loadSealedCampaign(campaign, pairSpec.seed)
  const { plan, geometry, corpus } = sealed
  const precommitted = plan.probes.endpoints.map(row => row.endpointEpisodes)
  if (!precommitted.includes(endpoint)) throw new Error(`Endpoint ${endpoint} is not precommitted (${precommitted.join(', ')})`)
  const results = []
  for (const run of await listRuns(campaign, pairId)) {
    if (arm && run.arm !== arm) continue
    const progress = await readJson(join(run.root, 'progress.json'), {})
    // Recovery is only legal for a journey that durably completed the endpoint.
    if ((progress.episode ?? 0) < endpoint) {
      results.push({ arm: run.arm, runId: run.runId, ok: false, error: `ENDPOINT_NOT_REACHED: episode ${progress.episode} < ${endpoint}` })
      continue
    }
    const homeRecord = await readJson(join(run.root, 'host', 'isolated-home.json'), null)
    if (!homeRecord?.profile) { results.push({ arm: run.arm, runId: run.runId, ok: false, error: 'NO_ISOLATED_HOME' }); continue }
    const sessionId = progress.sessionId ?? await resolveSessionId(run.root)
    if (!sessionId) { results.push({ arm: run.arm, runId: run.runId, ok: false, error: 'NO_SESSION_ID' }); continue }
    const command = commandSpec(plan, geometry, run.arm, { port: pairSpec.ports?.[run.arm] ?? run.run.port })
    const driver = new Driver({
      plan, geometry, command, arm: run.arm, seed: pairSpec.seed,
      root: run.root, runId: run.runId, route: plan.environment.model,
      corpus, oracle: null, dshBin, tarball,
    })
    driver.progress = { ...driver.progress, ...progress }
    driver.campaign = campaign
    driver.pairId = pairId
    driver.sessionId = sessionId
    const env = { ...process.env, DSH_HOME: homeRecord.home, COREPACK_ENABLE_AUTO_PIN: '0' }
    try {
      await atomicJson(join(run.root, 'recovery', `probe-recovery-${endpoint}-${Date.now()}.json`), {
        recoveredAt: new Date().toISOString(), endpoint, sessionId, reason: 'operator recovery of the sealed final probe', episode: progress.episode,
      })
      driver.host = await launchHost({ dshBin, root: run.root, profile: homeRecord.profile, patch: join(run.root, 'host.patch.yml'), port: command.port, env }, `${run.runId}-probe-${Date.now()}`)
      await driver.host.client.call('session/selectModel', { sessionId, ...plan.environment.model })
      await driver.runFinalProbe(endpoint)
      await driver.finalize({ terminalReason: 'COMPLETED' })
      results.push({ arm: run.arm, runId: run.runId, ok: true, probeBatches: driver.progress.finalProbeCount })
    } catch (error) {
      await driver.finalize({ terminalReason: 'FAILED_PRODUCT', error }).catch(() => {})
      results.push({ arm: run.arm, runId: run.runId, ok: false, error: String(error.message ?? error) })
    } finally {
      if (driver.host) await driver.host.stop().catch(() => {})
    }
    await auditRun({ campaign, pairId, arm: run.arm, runId: run.runId }).catch(() => {})
    await scoreRun({ campaign, pairId, arm: run.arm, runId: run.runId }).catch(error => {
      results.push({ arm: run.arm, runId: run.runId, scoreError: String(error.message ?? error) })
    })
    const { writeResult } = await import('./audit.mjs')
    await writeResult({ campaign, pairId, arm: run.arm, runId: run.runId }).catch(error => {
      results.push({ arm: run.arm, runId: run.runId, resultError: String(error.message ?? error) })
    })
  }
  await atomicJson(join(pairRoot, `probe-recovery-E${endpoint}.json`), { campaign, pairId, endpoint, results, at: new Date().toISOString() })
  return { endpoint, runs: results }
}
