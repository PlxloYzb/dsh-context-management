// Gate-evidence builder: turns one pair's sealed artifacts into the structured
// evidence a review decision must cite. It never changes a score; it only
// reports what the audits already say.
import { join } from 'node:path'
import { campaignRoot, readJson, atomicJson, listRuns } from './context.mjs'
import { sha256 } from './plan.mjs'

export async function buildPairEvidence({ campaign, pairId, plan }) {
  const pairRoot = join(campaignRoot(campaign), pairId)
  const pairSpec = await readJson(join(pairRoot, 'pair.json'), null)
  if (!pairSpec) throw new Error(`Pair ${pairId} is not sealed`)
  const runs = await listRuns(campaign, pairId)
  const rows = []
  for (const run of runs) {
    const progress = await readJson(join(run.root, 'progress.json'), {})
    const audit = await readJson(join(run.root, 'audit.json'), null)
    const score = await readJson(join(run.root, 'score.json'), null)
    const restart = await readJson(join(pairRoot, `restart-${run.arm}.json`), null)
    rows.push({
      arm: run.arm,
      runId: run.runId,
      terminalReason: progress.terminalReason ?? null,
      episode: progress.episode ?? 0,
      foregroundVerifiedTokens: audit?.usage?.foregroundVerifiedTokens ?? progress.usage?.foregroundVerifiedTokens ?? 0,
      allReportedTokens: audit?.usage?.allReportedTokens ?? 0,
      unknownUsageCalls: audit?.usage?.unknownUsageCallCount ?? 0,
      uniqueExposedSourceTokens: audit?.usage?.uniqueExposedSourceTokens ?? 0,
      windowCommits: audit?.coverage?.arcCoverage?.windowCommits ?? progress.coverage?.windows ?? 0,
      pressureWindowCommits: audit?.coverage?.arcCoverage?.pressureWindowCommits ?? progress.coverage?.pressureWindows ?? 0,
      nativeCompactions: audit?.coverage?.basicCoverage?.nativeAutomaticCompactions ?? 0,
      deliveredSummaries: audit?.coverage?.arcCoverage?.distinctDeliveredSourceCount ?? progress.coverage?.deliveredSummaries ?? 0,
      integrityPassed: audit?.integrityPassed ?? null,
      coveragePassed: audit?.coveragePassed ?? null,
      // The scorer exposes both `qualityPassed` (frozen gate) and a legacy
      // `passed`; the gate is what the protocol accepts.
      qualityPassed: score?.qualityPassed ?? score?.passed ?? null,
      quality: score ? { correct: score.correct, denominator: score.denominator, perQuartile: score.perQuartile, requiredLatestUser: score.requiredLatestUser, longTailCorrect: score.longTailCorrect, formatFailures: score.formatFailures } : null,
      restartVerified: restart?.verified ?? null,
      schedulerBarrierMs: progress.schedulerBarrierMs ?? 0,
      evidenceBytes: audit?.evidenceBytes ?? 0,
    })
  }
  const pilot = pairSpec.pilot === true || pairId.startsWith('pilot-')
  const criteria = pilot
    ? {
        perArmForegroundInRange: rows.length === 2 && rows.every(row => row.foregroundVerifiedTokens >= 200000 && row.foregroundVerifiedTokens <= 800000),
        arcWindowsAtLeast2: rows.filter(row => row.arm === 'ARC_DEFERRED').every(row => row.windowCommits >= 2),
        basicCompactionsAtLeast2: rows.filter(row => row.arm === 'BASIC_MATCHED').every(row => row.nativeCompactions >= 2),
        arcDeliveredSummaryAtLeast1: rows.filter(row => row.arm === 'ARC_DEFERRED').every(row => row.deliveredSummaries >= 1),
        formalCredit: false,
      }
    : {
        everyRunTerminal: rows.length === 2 && rows.every(row => row.terminalReason !== null),
        tokenFloor: rows.every(row => row.foregroundVerifiedTokens >= 3000000),
        materialFloor: true,
        integrity: rows.every(row => row.integrityPassed === true),
        restartVerified: rows.every(row => row.restartVerified === true),
      }
  return {
    schemaVersion: 1,
    campaign,
    pairId,
    seed: pairSpec.seed,
    arms: pairSpec.startOrder,
    builtAt: new Date().toISOString(),
    runs: rows,
    criteria,
    notes: pilot
      ? ['A calibration prefix shortens the journey on purpose; it can never satisfy the 3M floor and is not formal credit.']
      : ['Quality and coverage failures are reported as-is and are never converted into a pass by this evidence file.'],
    planHash: plan ? sha256(JSON.stringify(plan)) : null,
  }
}

export async function writePairEvidence({ campaign, pairId, plan }) {
  const evidence = await buildPairEvidence({ campaign, pairId, plan })
  const path = join(campaignRoot(campaign), 'reviews', `${pairId}.evidence.json`)
  await atomicJson(path, evidence)
  return { path, evidence }
}
