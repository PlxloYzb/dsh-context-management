// Curate a fixed, redacted deferred-handoff cohort. This never discovers runs:
// names are a reviewable manifest and the public report contains only this
// file's explicit projection.
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const args = new Set(process.argv.slice(2))
if ([...args].some(arg => arg !== '--mechanism-only')) throw new Error('Usage: node --import tsx tests/live/handoff-report.mjs [--mechanism-only]')
const root = resolve('.test-runtime/handoff-muse-20260915')
const nightlyRoot = resolve('.test-runtime/nightly-20260915')
const mechanism = [
  'deferred-independent-91541',
  'deferred-independent-v2-91541',
  'deferred-independent-v3-91541',
  'deferred-independent-v4-91541',
  'deferred-independent-v5-91541',
  'deferred-dependent-91541',
]
const web = ['deferred-windowed-91542', 'deferred-inplace-91542', 'deferred-native-91542']
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const optionalJson = async path => readJson(path).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
const finite = value => Number.isFinite(value) ? value : null
const cleanError = error => error ? { code: typeof error.code === 'string' ? error.code : 'unknown', message: typeof error.message === 'string' ? error.message.replace(/https?:\/\/\S+/g, '[url redacted]').slice(0, 240) : null } : null
const usageSummary = calls => {
  const states = { reported: 0, zero: 0, 'missing-or-null': 0 }
  const fields = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 }
  for (const call of calls ?? []) {
    const state = call.usageState ?? (call.usage === undefined || call.usage === null ? 'missing-or-null' : call.usage.totalTokens === 0 ? 'zero' : 'reported')
    if (state in states) states[state]++
    for (const key of Object.keys(fields)) if (Number.isFinite(call.usage?.[key])) fields[key] += call.usage[key]
  }
  return { calls: calls?.length ?? 0, states, reportedFieldSums: fields }
}
const overlapMs = calls => {
  const foreground = calls.filter(call => call.purpose === 'agent' && Number.isFinite(call.start) && Number.isFinite(call.finish))
  const summary = calls.filter(call => call.purpose === 'compaction' && Number.isFinite(call.start) && Number.isFinite(call.finish))
  return summary.reduce((total, background) => total + foreground.reduce((sum, front) => sum + Math.max(0, Math.min(background.finish, front.finish) - Math.max(background.start, front.start)), 0), 0)
}
const handoffTimings = audit => (audit.timeline ?? []).map(window => ({
  generation: finite(window.generation),
  preStepBoundaryMs: finite(window.preStepBoundaryMs),
  firstForegroundAfterCommitMs: finite(window.firstForegroundAfterCommitMs),
  handoffs: (window.handoffs ?? []).map(handoff => ({
    classification: handoff.classification ?? null,
    pendingAfterCommitMs: Number.isFinite(window.commitAt) && Number.isFinite(handoff.pendingAt) ? handoff.pendingAt - window.commitAt : null,
    readyAfterCommitMs: Number.isFinite(window.commitAt) && Number.isFinite(handoff.readyAt) ? handoff.readyAt - window.commitAt : null,
    deliveryAfterCommitMs: Number.isFinite(window.commitAt) && Number.isFinite(handoff.deliveryAt) ? handoff.deliveryAt - window.commitAt : null,
  })),
}))
const curateMechanism = async name => {
  const directory = join(root, name)
  const [result, audit] = await Promise.all([readJson(join(directory, 'result.json')), readJson(join(directory, 'audit.json'))])
  if (!result.finishedAt || audit.kind !== 'deferred-handoff-audit') throw new Error(`${name}: run is absent or incomplete`)
  const cloud = await optionalJson(join(directory, 'cloud-audit.json'))
  const calls = audit.streams?.calls ?? []
  const stage = result.stages?.find(item => item.phase === 'task') ?? null
  return {
    name,
    task: result.task === 'dependent' ? 'dependent' : 'independent',
    hostVersion: result.hostVersion ?? null,
    candidateHash: typeof result.candidateHash === 'string' ? result.candidateHash : null,
    model: { name: result.route?.model ?? null, reasoningEffort: result.route?.reasoningEffort ?? null },
    geometry: {
      windowBudget: finite(result.geometry?.windowBudget ?? result.geometry?.windowBudgetTokens),
      prepareFraction: finite(result.geometry?.prepareFraction),
      maxSummaryBytes: finite(result.geometry?.maxSummaryBytes),
    },
    result: { completed: result.completed === true, originalError: cleanError(result.error), score: stage?.score ? { correct: finite(stage.score.correct), total: finite(stage.score.total), fields: stage.score.fields ?? null } : null },
    quality: { strictPassed: result.strictPassed ?? cloud?.strictPassed ?? null, allQualityPassed: result.allQualityPassed ?? cloud?.allQualityPassed ?? null, auditStructuralPassed: audit.passedStructuralChecks === true, dependentFactAvailabilityByForegroundRequest: audit.quality?.dependent?.factAvailabilityByForegroundRequest ?? null },
    window: {
      count: finite(audit.windows),
      timings: handoffTimings(audit),
      handoffClassifications: (audit.handoffs ?? []).map(handoff => handoff.classification ?? null),
      await: { count: finite(audit.awaitContext?.count), userVisibleWaitMs: finite(audit.awaitContext?.userVisibleWaitMs), waitedMsFallback: finite(audit.awaitContext?.waitedMsFallback) },
      peak: { summaryInFlight: finite(audit.streams?.summaryInFlightMax), totalInFlight: finite(audit.streams?.totalInFlightMax), foregroundSerial: audit.streams?.foregroundSerial === true },
      streamOverlapMs: overlapMs(calls),
    },
    archive: { appendOnly: audit.appendOnly === true, currentInputProtected: audit.currentInputProtected === true, toolPairsBalanced: audit.toolPairsBalanced === true, bytesVerified: audit.archiveBytesVerified === true, restoredBytes: finite(audit.restoredBytes), pages: finite(audit.archivePages) },
    usage: usageSummary(calls),
  }
}
const webScores = summary => ({
  facts: { correct: finite(summary.score?.factsCorrect), total: finite(summary.score?.factsTotal) },
  corrections: { correct: finite(summary.score?.correctionsCorrect), total: finite(summary.score?.correctionsTotal) },
  verbatim: { correct: finite(summary.score2?.verbatimCorrect), total: finite(summary.score2?.verbatimTotal) },
  deliverablePassed: summary.score?.deliverablePassed ?? null,
})
const webHandoffs = cloud => (cloud.deferredReceiptAudit?.handoffs ?? []).map(handoff => ({
  classification: handoff.classification ?? null,
  ordering: handoff.ordering ?? null,
  sourceComplete: handoff.sourceCoverage?.complete ?? null,
  sourceHashVerified: handoff.sourceCoverage?.sourceHashValid ?? null,
  appendWithoutGenerationChange: handoff.appendWithoutGenerationChange ?? null,
  recoveryNotificationValid: handoff.recoveryNotificationValid ?? null,
}))
const webAwait = cloud => (cloud.deferredReceiptAudit?.awaitContext ?? []).map(call => ({
  status: call.status ?? null,
  elapsedMs: finite(call.elapsedMs),
  waitedMs: finite(call.waitedMs),
  sourceCallMatches: call.sourceMatches ?? null,
}))
const curateWeb = async name => {
  const directory = join(nightlyRoot, name)
  const [summary, audit, cloud] = await Promise.all([readJson(join(directory, 'summary.json')), readJson(join(directory, 'audit.json')), readJson(join(directory, 'cloud-audit.json'))])
  if (!summary.finishedAt || !summary.completed || !cloud.completed) throw new Error(`${name}: run is absent or incomplete`)
  const calls = cloud.calls ?? []
  return {
    name,
    task: 'web',
    hostVersion: summary.hostVersion ?? null,
    candidateHash: typeof summary.candidateHash === 'string' ? summary.candidateHash : null,
    model: { name: summary.route?.model ?? null, reasoningEffort: summary.route?.reasoningEffort ?? null },
    geometry: { strategy: summary.geometry?.strategy ?? null, windowBudget: finite(summary.geometry?.windowBudget), pressure: finite(summary.geometry?.pressure), effective: finite(summary.geometry?.effective), maxTokens: finite(summary.geometry?.maxTokens) },
    result: { completed: summary.completed === true, originalError: cleanError(summary.error), score: null },
    strictPassed: summary.strictPassed ?? null,
    allQualityPassed: summary.allQualityPassed ?? null,
    scores: webScores(summary),
    quality: { strictPassed: summary.strictPassed ?? null, allQualityPassed: summary.allQualityPassed ?? null, auditStructuralPassed: audit.passedStructuralChecks ?? audit.archiveBytesVerified ?? null, cloudCompleted: cloud.completed === true },
    window: {
      count: Array.isArray(cloud.windows) ? cloud.windows.length : null,
      compactions: Array.isArray(summary.compactions) ? summary.compactions.map(item => ({ kind: item.kind ?? null })) : null,
      timings: (cloud.boundaries ?? []).map(boundary => ({ preStepBoundaryMs: finite(boundary.elapsedMs), backgroundBefore: boundary.backgroundBefore ?? null, backgroundAfter: boundary.backgroundAfter ?? null })),
      handoffs: webHandoffs(cloud),
      handoffClassifications: webHandoffs(cloud).map(handoff => handoff.classification),
      await: { count: webAwait(cloud).length, calls: webAwait(cloud), userVisibleWaitMs: null, waitedMsFallback: null },
      peak: { summaryInFlight: finite(cloud.maximumSummaryInFlight), totalInFlight: finite(cloud.maximumInFlight), foregroundSerial: cloud.foregroundRequestsSerial ?? null },
      streamOverlapMs: finite(cloud.observedStreamOverlapMs) ?? overlapMs(calls),
    },
    archive: { appendOnly: cloud.appendOnly ?? audit.appendOnly ?? null, currentInputProtected: cloud.currentInputProtected ?? audit.currentInputProtected ?? null, toolPairsBalanced: cloud.toolPairsBalanced ?? audit.toolPairsBalanced ?? null, bytesVerified: cloud.archiveBytesVerified ?? audit.archiveBytesVerified ?? null, restoredBytes: finite(cloud.restoredBytes ?? audit.restoredBytes), pages: finite(cloud.archivePages ?? audit.archivePages) },
    usage: usageSummary(calls),
    execution: { calls: finite(summary.calls), reportedTokens: finite(summary.reportedTokens), modelElapsedMs: finite(summary.modelElapsedMs), elapsedSeconds: finite(summary.elapsedSeconds) },
  }
}
const runs = []
for (const name of mechanism) runs.push(await curateMechanism(name))
if (!args.has('--mechanism-only')) for (const name of web) runs.push(await curateWeb(name))
const output = { schemaVersion: 1, kind: 'deferred-handoff-curated-report', hostVersion: '0.1.2-rc.1', model: 'muse-spark-1.3-contributor', reasoningEffort: 'minimal', cohort: args.has('--mechanism-only') ? 'mechanism-preview' : 'mechanism-and-web', runs, limitations: ['Fixed named single-run cohort; this is mechanism evidence, not a statistical latency or cost claim.', 'Usage is accounting evidence only. Missing/null and zero usage are kept distinct.', 'Raw request bodies, event logs, paths, session IDs, operation IDs, source hashes, fixture facts, and current tokens are excluded.'] }
const outputPath = args.has('--mechanism-only') ? join(root, 'turnover-deferred-handoff-preview.json') : resolve('docs/data/turnover-deferred-handoff-2026-09-15.json')
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ cohort: output.cohort, runs: output.runs.length, output: args.has('--mechanism-only') ? '.test-runtime/handoff-muse-20260915/turnover-deferred-handoff-preview.json' : 'docs/data/turnover-deferred-handoff-2026-09-15.json' }))
