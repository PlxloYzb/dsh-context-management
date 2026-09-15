// Curate explicit, completed cohorts; raw events/settings remain ignored.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { retrievalOutcomes } from './turnover/retrieval-outcomes.mjs'
const root = resolve('.test-runtime/turnover-muse-20260915'), night = resolve('.test-runtime/nightly-20260915')
const read = async path => JSON.parse(await readFile(path, 'utf8'))
const names = ['engine-a-91521','engine-c-91521','engine-c-91522','engine-v2-c-91522','engine-v2-a-91522','engine-v2-c-91523','engine-v2-timeout-91524','engine-v2-late-91525']
const runs = []
for (const name of names) {
  const r = await read(join(root, name, 'result.json')), audit = await read(join(root, name, 'audit.json'))
  const events = await read(join(root, name, 'final-events.json'))
  assert.ok(r.completed && r.finishedAt && r.settingsUnchanged && audit.archiveBytesVerified)
  const { successfulRetrievalCalls: legacyAllowedRetrievalAttempts, ...audited } = audit
  const allowedRetrievalAttempts = audit.allowedRetrievalAttempts ?? legacyAllowedRetrievalAttempts
  runs.push({ name, arm: r.arm, seed: r.seed, probeVersion: r.probeVersion ?? 1, geometry: r.geometry ?? { windowBudget: 64000, prepareFraction: 0.25 }, fault: r.fault, candidateHash: r.candidateHash,
    stages: r.stages.map(s => ({ phase: s.phase, elapsedMs: s.elapsedMs, freshCorrect: s.score ? s.score.answer?.fresh === `fresh-${r.seed}-7e0183` : s.freshVisible, score: s.score ? { correct: s.score.correct, total: s.score.total, fields: s.score.fields } : null })), audit: { ...audited, allowedRetrievalAttempts, retrievalOutcomes: retrievalOutcomes(events) } })
}
const gates = []
for (const name of ['muse-min-native-91503','muse-min-in-place-91503','muse-min-windowed-91503','muse-min-windowed-repeat-91503']) {
  const r = await read(join(night, name, 'summary.json')), audit = await read(join(night, name, 'audit.json'))
  assert.ok(r.completed && r.settingsUnchanged && audit.archiveBytesVerified)
  const requestEvents = (await readFile(join(night, name, 'observed/requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const requests = requestEvents.filter(row => row.phase === 'before-route-guard')
  assert.ok(requests.length && requests.every(row => row.effectiveReasoningEffort === 'minimal'))
  const events = await read(join(night, name, 'observed', `${r.sessionId}.events.json`))
  const toolCalls = events.filter(e => e.type === 'assistant/message').flatMap(e => e.data.message.content).filter(b => b.type === 'tool-call')
  const adoption = Object.fromEntries(['new_context','compress'].map(tool => [tool, toolCalls.filter(b => b.name === tool).length]))
  const initialReadArguments = toolCalls.filter(b => b.name === 'experiment_read_page').slice(0, 6).map(b => b.arguments)
  const firstRequestArgumentCharacters = requestEvents.find(row => row.callId === requests[0].callId && row.phase === 'finish')?.outputCharacters?.arguments ?? null
  const windowSeeds = events.filter(e => e.type === 'compaction/summary' && e.data.contextManagement).map(e => ({ trigger: e.data.contextManagement.trigger, mode: e.data.contextManagement.seed.mode }))
  gates.push({ name, adoption, initialReadArguments, firstRequestArgumentCharacters, windowSeeds, arm: r.arm, candidateHash: r.candidateHash, elapsedSeconds: r.elapsedSeconds, facts: [r.score.factsCorrect,r.score.factsTotal], corrections: [r.score.correctionsCorrect,r.score.correctionsTotal], verbatim: [r.score2.verbatimCorrect,r.score2.verbatimTotal], strictPassed: r.strictPassed, deniedTools: r.deniedTools, allQualityPassed: r.allQualityPassed, restartVerified: r.restartVerified ?? null, windows: r.compactions.filter(c => c.kind === 'window').length, compactions: r.compactions.length, calls: r.calls, reportedTokens: r.reportedTokens, modelElapsedMs: r.modelElapsedMs, effectiveReasoningEffort: 'minimal', settingsUnchanged: true, archiveBytesVerified: true, exactPagesInRequests: audit.exactPagesInRequests })
}
const calibrations = []
for (const name of ['engine-pilot-91521','engine-ready-91521','engine-admission-91521','engine-debug-91521','engine-route-91521','engine-stream-91521']) {
  const r = await read(join(root, name, 'result.json'))
  calibrations.push({ name, completed: r.completed, candidateHash: r.candidateHash, stages: r.stages.map(s => ({ phase: s.phase, score: s.score?.correct ?? null })), error: r.error?.message ?? null, settingsUnchanged: r.settingsUnchanged })
}
const budgets = await read(join(root, 'engine-seed-budget-stress.json'))
const output = { schemaVersion: 1, hostVersion: '0.1.2-rc.1', defaultEnabled: false, mainModel: 'Qwen3.8-27B-NVFP4KV-384K', mainEffort: 'off', summaryModel: 'muse-spark-1.3-contributor', summaryEffort: 'minimal', mechanism: { windowBudget: 64000, seedBytes: 4096, prepareFraction: 0.25, defaultPrepareFraction: 0.6, source: 'synthetic fixed history; governor triggered by host-priced incoming padding' }, runs, gates, budgets, calibrations,
  limitations: ['Small, synthetic mechanism study; no statistically significant latency or total-cost claim.', 'Probe v1 permitted annotations; one exact-match failure is preserved. Probe v2 explicitly asks for bare original identifiers.', 'Marker answers and raw suffix retention are distinct: the extractive user index can retain a marker even after its assistant message is archived.', 'One live fault uses a real 500 ms summary timeout. Another holds delivery of a real Muse finish chunk until after engine commitment; its elapsed stream time includes this artificial hold. Other cancellation/stale/oversize states have host integration regressions.', 'Global settings preserved at the start-of-follow-up value; the user explicitly declined restoration of the earlier incident.'] }
await writeFile(resolve('docs/data/turnover-muse-engine-2026-09-15.json'), JSON.stringify(output, null, 2) + '\n')
console.log(JSON.stringify({ runs: runs.length, gates: gates.length, settingsUnchanged: true, output: 'docs/data/turnover-muse-engine-2026-09-15.json' }))
