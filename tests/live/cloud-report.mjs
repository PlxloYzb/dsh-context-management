import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MECHANISM_ROOT = join(REPOSITORY_ROOT, '.test-runtime', 'turnover-muse-20260915')
const WEB_ROOT = join(REPOSITORY_ROOT, '.test-runtime', 'nightly-20260915')
const OUTPUT = join(REPOSITORY_ROOT, 'docs', 'data', 'turnover-muse-cloud-2026-09-15.json')

const MECHANISM_RUNS = Object.freeze([
  'cloud-c-91531',
  'cloud-a-91531',
  'cloud-brief-c-91531',
  'cloud-brief-a-91531',
  'cloud-brief-c-repeat-91531',
  'cloud-brief-c-nocache-91531',
])
const WIRE_RUNS = Object.freeze(['cloud-wire-c-91531'])
const WEB_RUNS = Object.freeze([
  'cloud-windowed-bg-91533',
  'cloud-windowed-early-91533',
  'cloud-native-91533',
  'cloud-inplace-91533',
  'cloud-windowed-control-91533',
])

async function jsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function finite(value) {
  return Number.isFinite(value) ? value : null
}

function score(stage) {
  if (!stage?.score) return null
  return {
    correct: finite(stage.score.correct),
    total: finite(stage.score.total),
  }
}

function stageFor(result, phase) {
  return result?.stages?.find(stage => stage.phase === phase) ?? null
}

function usageSummary(calls, preferredReportedTokens = null) {
  if (!Array.isArray(calls)) return { reportedTokens: finite(preferredReportedTokens), usageMissingCount: null, callCount: null }
  let total = 0
  let usageMissingCount = 0
  for (const call of calls) {
    const tokens = call?.usage?.totalTokens
    if (Number.isFinite(tokens)) total += tokens
    else usageMissingCount += 1
  }
  return {
    reportedTokens: finite(preferredReportedTokens) ?? (usageMissingCount === calls.length ? null : total),
    usageMissingCount,
    zeroUsageCount: calls.filter(c => c?.usage?.totalTokens === 0).length,
    incompleteStreamCount: calls.filter(c => c.terminalPhase === 'incomplete-stream' || c.reason === null).length,
    callCount: calls.length,
  }
}

function retrievalSummary(audit, result, summary) {
  const outcome = audit?.retrieval ?? audit?.retrievalOutcomes
  if (!outcome && !stageFor(result, 'retrieval') && !Number.isFinite(summary?.retrievalsDuringP1) && !Number.isFinite(summary?.retrievalsDuringP2)) return null
  const stage = stageFor(result, 'retrieval')
  const statusCounts = outcome?.statusCounts ?? null
  return {
    attempts: finite(outcome?.attempts) ?? finite(stage?.retrievalCalls) ?? (finite(summary?.retrievalsDuringP1) ?? 0) + (finite(summary?.retrievalsDuringP2) ?? 0),
    successes: finite(outcome?.successes),
    errors: finite(outcome?.failures) ?? finite(statusCounts?.error),
    missingResults: finite(outcome?.missingResults),
  }
}

function summaryFinalScore(summary) {
  if (!summary?.score) return null
  return {
    facts: { correct: finite(summary.score.factsCorrect), total: finite(summary.score.factsTotal) },
    corrections: { correct: finite(summary.score.correctionsCorrect), total: finite(summary.score.correctionsTotal) },
    verbatim: { correct: finite(summary.score2?.verbatimCorrect), total: finite(summary.score2?.verbatimTotal) },
  }
}

function sourceFiles(root, id, names) {
  return names.filter(name => name).map(name => relative(REPOSITORY_ROOT, join(root, id, name)))
}

function failureReasons({ result, audit, summary, wireAudit, foregroundInstructionPassed, status }) {
  const reasons = []
  if (status === 'failed') reasons.push('run-failed')
  if (result?.completed === false) reasons.push('result.completed=false')
  if (audit?.originalRunCompleted === false) reasons.push('audit.originalRunCompleted=false')
  if (audit?.markerProduced === false) reasons.push('audit.markerProduced=false')
  if (result?.error?.code) reasons.push(`error:${result.error.code}`)
  if (summary?.strictPassed === false) reasons.push('summary.strictPassed=false')
  if (summary?.allQualityPassed === false) reasons.push('summary.allQualityPassed=false')
  if (foregroundInstructionPassed === false) reasons.push('foregroundInstructionPassed=false')
  if (audit?.summaryRejected !== null && audit?.summaryRejected !== undefined) reasons.push('summary-rejected')
  if (wireAudit?.allHttp200 === false) reasons.push('wire.allHttp200=false')
  if (wireAudit?.hostOutputMatchesForegroundResponse === false) reasons.push('wire.hostOutputMatchesForegroundResponse=false')
  return reasons
}

function qualityMetrics({ audit, cloudAudit, wireAudit, result, summary }) {
  const source = audit ?? cloudAudit ?? wireAudit ?? {}
  return {
    archiveBytesVerified: source.archiveBytesVerified ?? null,
    currentInputProtected: source.currentInputProtected ?? null,
    toolPairsBalanced: source.toolPairsBalanced ?? null,
    appendOnly: source.appendOnly ?? result?.appendOnly ?? null,
    freshRawRetained: source.freshRawRetained ?? null,
    sourceHashVerified: source.sourceHashVerified ?? null,
    settingsUnchanged: source.settingsUnchanged ?? result?.settingsUnchanged ?? summary?.settingsUnchanged ?? null,
    foregroundRequestsSerial: source.foregroundRequestsSerial ?? null,
    localRequestsSerial: source.localRequestsSerial ?? null,
    allRequestsSameCloudRoute: cloudAudit?.allRequestsSameCloudRoute ?? null,
    allMuseMinimal: wireAudit?.allMuseMinimal ?? null,
    hostOutputMatchesForegroundResponse: wireAudit?.hostOutputMatchesForegroundResponse ?? null,
    restartVerified: cloudAudit?.restartVerified ?? summary?.restartVerified ?? null,
    deliverablePassed: summary?.score?.deliverablePassed ?? null,
  }
}

function timingMetrics({ audit, result, summary, wireAudit }) {
  const geometry = result?.geometry ?? summary?.geometry ?? {}
  const mode = geometry.strategy ?? (wireAudit ? 'wire-diagnostic' : result?.arm === 'C' ? 'windowed' : result?.arm === 'A' ? 'extractive' : result?.arm ?? summary?.arm ?? null)
  return {
    mode,
    overlapMs: {
      firstForeground: finite(audit?.firstForegroundOverlapMs ?? audit?.overlapMs),
      stream: finite(audit?.streamOverlapMs ?? audit?.observedStreamOverlapMs),
      content: finite(audit?.contentOverlapMs),
    },
    window: {
      boundaryMs: finite(audit?.boundaryMs),
      firstSummaryStartLeadMs: finite(audit?.firstSummaryStartLeadMs ?? audit?.firstSummaryLeadMs),
      firstSummaryEndLeadMs: finite(audit?.firstSummaryEndLeadMs),
      summaryRejected: audit?.summaryRejected ?? null,
      backgroundAtBoundary: audit?.backgroundAtBoundary?.status ?? null,
      windowBudget: finite(geometry.windowBudget),
      prepareFraction: finite(geometry.prepareFraction ?? summary?.backgroundPrepareFraction ?? (summary?.backgroundSummaryEnabled ? 0.6 : null)),
    },
    overlapMetric: audit?.overlapMetric ?? null,
    maximumInFlight: finite(audit?.maximumInFlight),
    maximumSummaryInFlight: finite(audit?.maximumSummaryInFlight),
    boundaries: audit?.boundaries ?? null,
    elapsedSeconds: finite(summary?.elapsedSeconds),
    stages: result?.stages.map(s => ({ phase: s.phase, end: s.end, elapsedMs: s.elapsedMs })) ?? null,
  }
}

function runStatus({ result, audit, cloudAudit, wireAudit, summary }) {
  const hasAudit = Boolean(audit || cloudAudit || wireAudit)
  if (!hasAudit) return 'pending'
  if (result?.completed === false || audit?.originalRunCompleted === false) return 'failed'
  if (wireAudit && result?.completed === false) return 'failed'
  if (summary && !cloudAudit && !wireAudit) return 'pending'
  return 'complete'
}

async function collectRun({ group, root, id, auditName = null, cloudAuditName = null, wireAuditName = null }) {
  const directory = join(root, id)
  const [summary, result, audit, cloudAudit, wireAudit] = await Promise.all([
    jsonIfPresent(join(directory, 'summary.json')),
    jsonIfPresent(join(directory, 'result.json')),
    auditName ? jsonIfPresent(join(directory, auditName)) : null,
    cloudAuditName ? jsonIfPresent(join(directory, cloudAuditName)) : null,
    wireAuditName ? jsonIfPresent(join(directory, wireAuditName)) : null,
  ])
  const status = runStatus({ result, audit, cloudAudit, wireAudit, summary })
  const finalStage = stageFor(result, 'retrieval') ?? stageFor(result, 'final')
  const seedStage = stageFor(result, 'seed')
  const foreground = stageFor(result, 'foreground')
  const foregroundInstructionPassed = wireAudit?.foregroundInstructionPassed ?? result?.foregroundInstructionPassed ?? (foreground ? (result?.foregroundWork === 'brief' ? foreground.answer.trim() === `fresh-${result.seed}-7e0183` : foreground.answer.includes(`fresh-${result.seed}-7e0183`)) : null)
  const modelAudit = cloudAudit ?? audit
  const calls = audit?.calls ?? cloudAudit?.calls ?? null
  const preferredReportedTokens = summary?.reportedTokens ?? result?.reportedTokens ?? null
  const completed = result?.completed ?? cloudAudit?.completed ?? summary?.completed ?? (summary ? summary.stage === 'finished' : null)
  const sourceNames = [
    summary ? 'summary.json' : null,
    result ? 'result.json' : null,
    audit ? auditName : null,
    cloudAudit ? cloudAuditName : null,
    wireAudit ? wireAuditName : null,
  ]
  return {
    name: id,
    group,
    status,
    seed: finite(result?.seed ?? summary?.seed),
    route: {
      provider: result?.mainRoute?.provider ?? summary?.route?.provider ?? null,
      model: result?.mainRoute?.model ?? summary?.route?.model ?? null,
      reasoningEffort: result?.mainRoute?.reasoningEffort ?? summary?.route?.reasoningEffort ?? null,
    },
    summaryRoute: result?.summaryRoute ?? (summary?.backgroundSummaryEnabled ? summary.route : null),
    backgroundSummaryEnabled: summary?.backgroundSummaryEnabled ?? (result?.arm === 'C'),
    foregroundWork: result?.foregroundWork ?? 'standard',
    cachePolicy: result?.cachePolicy ?? 'configured',
    hostVersion: result?.hostVersion ?? summary?.hostVersion ?? null,
    fixtureHash: result?.fixtureHash ?? summary?.fixture?.hash ?? null,
    candidateHash: result?.candidateHash ?? summary?.candidateHash ?? null,
    completed,
    foregroundInstructionPassed,
    originalRunCompleted: audit?.originalRunCompleted ?? null,
    markerProduced: audit?.markerProduced ?? null,
    seedScore: score(seedStage),
    finalScore: score(finalStage) ?? summaryFinalScore(summary),
    retrieval: retrievalSummary(modelAudit, result, summary),
    timing: timingMetrics({ audit: modelAudit, result, summary, wireAudit }),
    windows: cloudAudit?.windows ?? (audit?.seedMode ? [{ mode: audit.seedMode, seedBytes: audit.seedBytes, sourceHashVerified: audit.sourceHashVerified, freshRawRetained: audit.freshRawRetained }] : null),
    compactions: audit?.compactionsObserved ?? summary?.compactions ?? null,
    backgroundStates: cloudAudit?.summaryStatusObservations ?? null,
    quality: qualityMetrics({ audit, cloudAudit, wireAudit, result, summary }),
    strict: {
      passed: summary?.strictPassed ?? null,
      allQualityPassed: summary?.allQualityPassed ?? null,
      failureReasons: failureReasons({ result, audit, summary, wireAudit, foregroundInstructionPassed, status }),
      deniedTools: summary?.deniedTools ?? audit?.deniedToolAttempts ?? [],
    },
    usage: usageSummary(calls, preferredReportedTokens),
    callMetrics: calls?.map(c => ({ purpose: c.purpose, elapsedMs: c.elapsedMs, usage: c.usage, terminalPhase: c.terminalPhase ?? null, terminalReason: c.reason })) ?? null,
    wire: wireAudit ? { capturedHttpRequests: wireAudit.capturedHttpRequests, allHttp200: wireAudit.allHttp200, separateResponseIds: wireAudit.separateResponseIds, sharedCacheKey: wireAudit.sharedCacheKey, foregroundInstructionDelivered: wireAudit.foregroundInstructionDelivered, hostOutputMatchesForegroundResponse: wireAudit.hostOutputMatchesForegroundResponse, serverActionNames: wireAudit.serverActions.map(a => a.name) } : null,
    artifacts: {
      summary: Boolean(summary),
      result: Boolean(result),
      audit: Boolean(audit),
      cloudAudit: Boolean(cloudAudit),
      wireAudit: Boolean(wireAudit),
      sourceFiles: sourceFiles(root, id, sourceNames),
    },
  }
}

export async function buildReport() {
  const mechanism = await Promise.all(MECHANISM_RUNS.map(name => collectRun({ group: 'mechanism', root: MECHANISM_ROOT, id: name, auditName: 'audit.json' })))
  const wire = await Promise.all(WIRE_RUNS.map(name => collectRun({ group: 'wire', root: MECHANISM_ROOT, id: name, wireAuditName: 'wire-audit.json' })))
  const web = await Promise.all(WEB_RUNS.map(name => collectRun({ group: 'web', root: WEB_ROOT, id: name, auditName: 'audit.json', cloudAuditName: 'cloud-audit.json' })))
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    classification: 'Offline aggregation of explicitly allowlisted retained artifacts; no model requests. Mechanism, wire diagnostic, and Web gates are separate groups; missing completion audits remain pending.',
    metricDefinitions: {
      completed: 'Execution completion, independent of strict instruction or answer quality; the original failed mechanism run remains failed.',
      overlap: 'Host stream lifecycle interval intersection only. Audits require serial foreground requests and at most one summary, avoiding double counting. Does not establish provider compute parallelism.',
      usage: 'Host/adapter-reported totalTokens, including cache token categories where reported. Cancelled streams may have null or zero usage; neither establishes free service. No billing amount inferred.',
      foregroundInstructionPassed: 'Brief: exact marker-only text. Standard: marker presence only, not full semantic validation of twelve requested checks.',
      retrieval: 'Whole-run durable tool results; success requires status=success. Attempts include denied or errored calls.',
      wire: 'One diagnostic pairs each fetch response to its own request and compares final foreground text; no claim that all host streams were mapped to wire IDs.',
    },
    allowlist: {
      mechanism: [...MECHANISM_RUNS],
      wire: [...WIRE_RUNS],
      web: [...WEB_RUNS],
    },
    groups: { mechanism, wire, web },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await buildReport()
  await writeFile(OUTPUT, JSON.stringify(report, null, 2) + '\n')
  console.log(`wrote ${relative(REPOSITORY_ROOT, OUTPUT)} (${mechanismCount(report)} runs)`)
}

function mechanismCount(report) {
  return report.groups.mechanism.length + report.groups.wire.length + report.groups.web.length
}
