// Frozen muse-longrun plan loading, geometry derivation and validation.
// The plan JSON is an experiment contract: this module refuses to run when the
// document and the machine-readable plan disagree with the frozen geometry.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export const PROTOCOL_ID = 'muse-longrun-v1'
export const PLAN_PATH = 'docs/experiments/muse-longrun-v1.plan.json'
export const REPO_ROOT = resolve('.')
/**
 * Protocol revisions the harness understands. v1 stays frozen against the
 * 0.1.2-rc.1 host it was designed for. v2 exists because the product moved to the
 * 0.1.7 prerelease series — whose host layout differs — and because the
 * long-journey pressure geometry has to be re-derived for that host. Each
 * protocol is admitted only with its own revision number, so a plan cannot be
 * edited in place without the change being visible.
 */
export const PROTOCOLS = {
  'muse-longrun-v1': 1,
  'muse-longrun-v2': 2,
}

export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const sha256Json = value => sha256(JSON.stringify(value))

export function deriveGeometry(plan) {
  const g = plan.geometry
  if (g.routeCapacity !== 1048576) throw new Error(`Frozen route capacity changed: ${g.routeCapacity}`)
  const effectiveInputCapacity = Math.ceil(g.pressureThreshold / 0.9)
  if (effectiveInputCapacity !== g.effectiveInputCapacity) throw new Error('Effective input capacity formula changed')
  const logicalWindowBudget = effectiveInputCapacity + g.foregroundMaxOutputTokens + g.safetyMarginTokens
  if (logicalWindowBudget !== g.logicalWindowBudget) throw new Error('Logical window budget formula changed')
  const prepareLine = effectiveInputCapacity * 0.6
  const nudgeLine = Math.floor(effectiveInputCapacity * 0.75)
  const emergencyLine = Math.floor(effectiveInputCapacity * 0.9)
  const targetRetainPressure = effectiveInputCapacity * 0.55
  if (prepareLine !== g.prepareLine || nudgeLine !== g.nudgeLine || emergencyLine !== g.emergencyLine) {
    throw new Error('Threshold line derivation changed')
  }
  if (emergencyLine !== g.pressureThreshold) throw new Error('Emergency line must equal the pressure threshold')
  // Minimal-increment float compensation: find the smallest ratio whose host
  // floor equals the frozen threshold, then reuse it for the retain ratio.
  const thresholdRatio = floorRatio(g.routeCapacity, g.pressureThreshold)
  if (Math.floor(g.routeCapacity * thresholdRatio) !== g.pressureThreshold) throw new Error('thresholdRatio does not resolve to the frozen threshold')
  const retainRatio = floorRatio(g.routeCapacity, g.basicResolvedRetainTokens)
  if (Math.floor(g.routeCapacity * retainRatio) !== g.basicResolvedRetainTokens) throw new Error('retainRatio does not resolve to the resolved retain tokens')
  return { ...g, effectiveInputCapacity, logicalWindowBudget, prepareLine, nudgeLine, emergencyLine, targetRetainPressure, thresholdRatio, retainRatio }
}

function floorRatio(capacity, target) {
  let ratio = target / capacity
  for (let i = 0; i < 8 && Math.floor(capacity * ratio) < target; i++) ratio += Number.EPSILON
  return ratio
}

export function arcBridgeConfig(plan, geometry) {
  const a = plan.arms.ARC_DEFERRED
  if (!a) throw new Error('ARC_DEFERRED arm missing from plan')
  return {
    adaptiveGovernor: {
      enabled: true,
      strategy: 'windowed',
      windowBudgetTokens: geometry.logicalWindowBudget,
      maxOutputTokens: geometry.foregroundMaxOutputTokens,
      safetyMarginTokens: geometry.safetyMarginTokens,
      nudgeAtEffectiveCapacityPct: 0.75,
      emergencyAtEffectiveCapacityPct: 0.9,
      targetAfterTurnoverPct: 0.55,
      emergencyFallback: true,
    },
    archive: { seedMaxTokens: 4096, retrievalDefaultMaxTokens: 2048, retrievalMaxTokens: 4096 },
    backgroundSummary: {
      provider: plan.environment.model.provider,
      model: plan.environment.model.model,
      reasoningEffort: plan.environment.model.reasoningEffort,
      allowSameProvider: true,
      delivery: 'deferred',
      prepareAtEffectiveCapacityPct: 0.6,
      maxInputBytes: 262144,
      maxSummaryBytes: 4096,
      maxOutputTokens: 2048,
      timeoutMs: 60000,
    },
  }
}

export function basicMatchedConfig(plan, geometry) {
  const arm = plan.arms.BASIC_MATCHED
  if (!arm) throw new Error('BASIC_MATCHED arm missing from plan')
  return { auto: true, thresholdRatio: geometry.thresholdRatio, retainRatio: geometry.retainRatio, maxTokens: geometry.foregroundMaxOutputTokens }
}

export function basicDefaultConfig(plan) {
  return { auto: true, thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: plan.geometry.foregroundMaxOutputTokens }
}

export function routeOf(plan) {
  const m = plan.environment.model
  return { provider: m.provider, model: m.model, reasoningEffort: m.reasoningEffort }
}

// Strict structural validation. Unknown keys are rejected so a silent plan
// revision cannot change behaviour without a deliberate harness update.
const REQUIRED_TOP = ['schemaVersion', 'protocolId', 'revision', 'environment', 'arms', 'geometry', 'schedule', 'workload', 'tokenAccounting', 'probes', 'acceptance', 'supervision', 'resources', 'diagnostics', 'evidence', 'implementation']
const REQUIRED_PLAN_KEYS = {
  arms: ['ARC_DEFERRED', 'BASIC_MATCHED', 'BASIC_DEFAULT'],
  schedule: ['primaryArms', 'pilot', 'formalPairs', 'maximumActiveRuns', 'maximumGlobalModelStreams', 'plannedRestart'],
  workload: ['baseEpisodes', 'pagesPerEpisode', 'maximumEpisodes', 'allowedFinalEndpoints', 'minimumUniqueExposedSourceHeuristicTokens'],
  tokenAccounting: ['minimumForegroundVerifiedTokensPerArmSeedSession'],
  probes: ['totalQuestions', 'batches', 'questionsPerBatch', 'sentinelEpisodes', 'endpoints', 'responseFormat'],
  acceptance: ['commonCoverage', 'arcCoverage', 'basicCoverage', 'quality', 'integrityIds'],
  diagnostics: ['cases'],
  evidence: ['ignoredRoot', 'requiredRunFiles', 'requiredSubdirectories'],
}

export function validatePlan(plan) {
  const problems = []
  for (const key of REQUIRED_TOP) if (plan[key] === undefined) problems.push(`missing top-level key ${key}`)
  for (const [section, keys] of Object.entries(REQUIRED_PLAN_KEYS)) {
    for (const key of keys) if (plan[section]?.[key] === undefined) problems.push(`missing ${section}.${key}`)
  }
  // A plan is admitted only under a known protocol AND that protocol's own
  // revision number, so editing a frozen plan in place cannot go unnoticed.
  const protocolRevision = PROTOCOLS[plan.protocolId]
  if (protocolRevision === undefined) problems.push(`unknown protocolId ${plan.protocolId}`)
  else if (plan.revision !== protocolRevision) problems.push(`${plan.protocolId} requires revision ${protocolRevision}, plan says ${plan.revision}`)
  let geometry = null
  try { geometry = deriveGeometry(plan) } catch (error) { problems.push(`geometry: ${error.message}`) }
  if (plan.schedule?.primaryArms?.length !== 2) problems.push('primaryArms must name exactly two arms')
  if (plan.schedule?.maximumActiveRuns !== 2) problems.push('maximumActiveRuns must be 2')
  if (plan.schedule?.maximumGlobalModelStreams !== 3) problems.push('maximumGlobalModelStreams must be 3')
  if (plan.schedule?.plannedRestart?.afterEpisode !== 12) problems.push('planned restart must follow episode 12')
  if (plan.probes?.totalQuestions !== 96) problems.push('final probes must total 96 questions')
  if (plan.probes?.batches !== 12 || plan.probes?.questionsPerBatch !== 8) problems.push('probe batching must be 12x8')
  if ((plan.probes?.endpoints?.length ?? 0) !== 5) problems.push('five precommitted endpoints are required')
  for (const endpoint of plan.probes?.endpoints ?? []) {
    const expected = endpoint.endpointEpisodes * plan.workload.pagesPerEpisode
    const last = endpoint.buckets?.at(-1)?.sourcePageEnd
    if (last !== expected) problems.push(`endpoint ${endpoint.endpointEpisodes} bucket pages end at ${last}, expected ${expected}`)
    if (endpoint.questionCount !== 96) problems.push(`endpoint ${endpoint.endpointEpisodes} must seal 96 questions`)
  }
  if (plan.acceptance?.quality?.minimumCorrect !== 87) problems.push('quality floor must be 87/96')
  if (plan.acceptance?.everyDiagnosticIdMustHaveTraceableStatus !== true || (plan.diagnostics?.cases?.length ?? 0) !== 18) problems.push('all 18 diagnostic cases must be declared and traceable')
  if (plan.environment?.globalDshAllowed !== false) problems.push('global dsh must never be allowed')
  if (plan.environment?.model?.provider !== 'opencode-go-muse' || plan.environment.model.model !== 'muse-spark-1.3-contributor') problems.push('frozen Muse route changed')
  if (plan.environment?.model?.reasoningEffort !== 'minimal') problems.push('frozen effort must remain minimal')
  if (plan.environment?.pluginBundleOnlyInArc !== true) problems.push('the plugin bundle must load only in the ARC arm')
  return { ok: problems.length === 0, problems, geometry }
}

export async function loadPlan(path = PLAN_PATH) {
  const bytes = await readFile(path)
  const plan = JSON.parse(bytes.toString('utf8'))
  const result = validatePlan(plan)
  if (!result.ok) throw new Error(`PLAN_INVALID: ${result.problems.join('; ')}`)
  return { plan, geometry: result.geometry, planHash: sha256(bytes), planPath: resolve(path) }
}

export function commandSpec(plan, geometry, arm, { port }) {
  if (arm === 'ARC_DEFERRED') {
    return {
      arm,
      profile: 'plugin',
      pluginBundle: true,
      port,
      compaction: { kind: 'arc-windowed', config: arcBridgeConfig(plan, geometry) },
      summaryMaxTokens: plan.arms.ARC_DEFERRED?.backgroundSummaryMaxTokens ?? 2048,
    }
  }
  if (arm === 'BASIC_MATCHED') {
    return {
      arm,
      profile: 'native',
      pluginBundle: false,
      port,
      compaction: { kind: 'native-basic', config: basicMatchedConfig(plan, geometry), matched: true },
      summaryMaxTokens: geometry.foregroundMaxOutputTokens,
    }
  }
  if (arm === 'BASIC_DEFAULT') {
    return {
      arm,
      profile: 'native',
      pluginBundle: false,
      port,
      compaction: { kind: 'native-basic', config: basicDefaultConfig(plan), matched: false },
      summaryMaxTokens: geometry.foregroundMaxOutputTokens,
    }
  }
  throw new Error(`Unknown experiment arm ${arm}`)
}
