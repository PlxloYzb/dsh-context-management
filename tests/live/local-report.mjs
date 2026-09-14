// Deliberately allowlisted public aggregates from one stopped private run.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { requestRecords } from './local/request-client.mjs'
import { observedEvents } from './local/observed-events.mjs'

const root = resolve(process.argv[2] ?? '')
assert.ok(root.startsWith(resolve('.test-runtime') + '/'), 'Read retained private experiment output only')
const summary = JSON.parse(await readFile(join(root, 'summary.json'), 'utf8'))
assert.ok(summary.finishedAt, 'Report a stopped run')
const audit = JSON.parse(await readFile(join(root, 'audit.json'), 'utf8'))
assert.equal(audit.name, summary.name)
const records = await requestRecords(join(root, 'observed', 'requests.jsonl'))
const toolActivity = {}
const trackedTools = new Set(['search_context','decompress','arc_status','compress','new_context'])
const errorCodes = new Set(['insufficient-headroom','retrieval-allowance-exhausted','retrieval-step-allowance-exhausted','requested-budget-too-small','no-net-reduction'])
let nudgesInjected = 0
for (const event of await observedEvents(join(root, 'observed'), summary.sessionId)) {
  if (event.type === 'user/message' && event.data.source?.kind === 'plugin' && event.data.source.plugin === 'arc-nudge') nudgesInjected++
  if (!['tool/call','tool/result'].includes(event.type)) continue
  const turn = event.data.turn
  const row = toolActivity[turn] ??= { calls: {}, errors: {} }
  if (event.type === 'tool/call' && trackedTools.has(event.data.name)) row.calls[event.data.name] = (row.calls[event.data.name] ?? 0) + 1
  if (event.type === 'tool/result') for (const block of event.data.message.content) for (const part of block.content ?? []) {
    if (part.type !== 'text') continue
    try {
      const result = JSON.parse(part.text)
      if (errorCodes.has(result?.code)) row.errors[result.code] = (row.errors[result.code] ?? 0) + 1
    } catch { /* Non-JSON source pages are not retrieval error records. */ }
  }
}
const score = summary.score
const compactions = audit.compactionsObserved ?? summary.compactions
const windows = compactions.filter(c => c.kind === 'window').length
const inPlaceCompactions = compactions.length - windows
const mechanismExercised = summary.fork ? null : summary.arm === 'C400_WINDOWED' ? windows >= 2
  : summary.arm === 'B_IN_PLACE' ? inPlaceCompactions > 0 && windows === 0 : null
const report = {
  name: summary.name, arm: summary.arm, family: summary.family, seed: summary.seed,
  hostVersion: summary.hostVersion, candidateHash: summary.candidateHash,
  ...(summary.clientHash ? { clientHash: summary.clientHash } : {}),
  fixture: summary.fixture, geometry: summary.geometry, restart: summary.restart,
  concise: summary.concise, probeOnly: !!summary.fork, probeMode: summary.probeMode ?? 'full',
  readingInstructionVersion: summary.readingInstructionVersion ?? 1,
  autoNudge: summary.autoNudge ?? (['B_IN_PLACE','C400_WINDOWED'].includes(summary.arm) ? true : null),
  ...(summary.fork ? { inheritedFrom: summary.fork.name, inheritedPages: summary.fork.inheritedPages,
    inheritedThroughSeq: summary.fork.throughSeq, inheritedQueueChecks: summary.fork.inheritedQueueChecks ?? null } : {}),
  startedAt: summary.startedAt, finishedAt: summary.finishedAt, elapsedSeconds: summary.elapsedSeconds,
  completed: summary.completed === true, error: summary.error?.replace(/; call [a-f0-9-]+/g, '') ?? null,
  intervention: await readFile(join(root, 'intervention.json'), 'utf8').then(JSON.parse).then(r => ({ reason: r.reason, elapsedSecondsAtDecision: r.elapsedSecondsAtDecision, pagesReadAtDecision: r.pagesReadAtDecision })).catch(error => { if (error.code === 'ENOENT') return null; throw error }),
  phases: summary.phases,
  factsScore: score ? { correct: score.factsCorrect, total: score.factsTotal,
    correctionsCorrect: score.correctionsCorrect, correctionsTotal: score.correctionsTotal,
    deliverablePassed: score.deliverablePassed, passed: score.passed } : null,
  verbatimScore: summary.score2 ? { correct: summary.score2.verbatimCorrect, total: summary.score2.verbatimTotal } : null,
  allQualityPassed: summary.strictPassed === true && summary.score2?.verbatimCorrect === summary.score2?.verbatimTotal && !!summary.score2,
  verbatimOnlyPassed: summary.verbatimOnlyPassed ?? null,
  mechanismCoverage: { windows, inPlaceCompactions, mechanismExercised },
  ...(summary.arm === 'A_NATIVE' ? { nativeThresholdTokens: Math.floor(summary.geometry.routeCapacity * 0.8), nativeCompactionRequired: false } : {}),
  restartVerified: summary.restartVerified ?? null,
  restartEvidence: summary.restartEvidence ? {
    distinctHostProcesses: summary.restartEvidence.beforePid !== summary.restartEvidence.afterPid,
    throughSeq: summary.restartEvidence.throughSeq, eventCount: summary.restartEvidence.eventCount,
    beforeHash: summary.restartEvidence.beforeHash, afterHash: summary.restartEvidence.afterHash,
    ...(summary.restartEvidence.paginatedEventCount === undefined ? {} : {
      rawEventPrefixVerified: true,
      paginatedEventCount: summary.restartEvidence.paginatedEventCount,
      paginatedBeforeHash: summary.restartEvidence.paginatedBeforeHash,
      paginatedAfterHash: summary.restartEvidence.paginatedAfterHash,
    }),
  } : null,
  retrievalsDuringP1: summary.retrievalsDuringP1 ?? null, retrievalsDuringP2: summary.retrievalsDuringP2 ?? null,
  p1ElapsedMs: summary.p1ElapsedMs ?? null, p2ElapsedMs: summary.p2ElapsedMs ?? null,
  toolActivity,
  nudgesInjected,
  calls: summary.calls, reportedTokens: summary.reportedTokens,
  usageComplete: records.every(r => r.terminal && Number.isFinite(r.usage?.totalTokens)),
  timedCalls: records.filter(r => r.firstContentMs !== undefined && r.terminal).map(r => ({
    purpose: r.purpose, firstContentMs: r.firstContentMs, elapsedMs: r.elapsedMs,
    outputCharacters: r.outputCharacters, outputTokens: r.usage?.outputTokens ?? null,
  })),
  deniedTools: summary.deniedTools.length, archives: audit.archives,
  exactPagesInRequests: audit.exactPagesInRequests, archiveBytesVerified: audit.archiveBytesVerified,
  archiveAuditPassed: audit.completed,
}
const output = resolve('docs/data/nightly-model-2026-09-15.json')
const current = JSON.parse(await readFile(output, 'utf8'))
const index = current.runs.findIndex(r => r.name === report.name)
if (index < 0) current.runs.push(report)
else current.runs[index] = report
current.latestReviewedRun = report.name
delete current.candidateRepeat
await writeFile(output, JSON.stringify(current, null, 2) + '\n')
console.log(JSON.stringify({ name: report.name, allQualityPassed: report.allQualityPassed, verbatimOnlyPassed: report.verbatimOnlyPassed, probeOnly: report.probeOnly, usageComplete: report.usageComplete }))
