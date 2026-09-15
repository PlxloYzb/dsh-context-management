// Publish only explicitly selected, sanitized metrics; raw model output,
// settings copies, authentication-bearing host logs and sessions remain private.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const root = resolve('.test-runtime/turnover-muse-20260915')
const names = (await readdir(root, { withFileTypes: true })).filter(row => row.isDirectory()).map(row => row.name)
const samples = [], calibrations = [], faults = [], preflight = []
for (const name of names.filter(name => name.startsWith('preflight-'))) {
  let result, events
  try { result = JSON.parse(await readFile(join(root, name, 'result.json'), 'utf8')); events = (await readFile(join(root, name, 'streams.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) } catch { continue }
  const calls = new Map()
  for (const event of events) {
    const call = calls.get(event.id) ?? {}; Object.assign(call, event)
    if (event.phase === 'start') call.start = event.time
    if (event.phase === 'first') call.first = event.time
    if (event.phase === 'finish') call.end = event.time
    calls.set(event.id, call)
  }
  const pairs = [0, 1, 2].map(repeat => {
    const sessions = result.rows.filter(row => row.name.startsWith(`pair-${repeat}-`)).map(row => row.sessionId)
    const pair = [...calls.values()].filter(call => call.purpose === 'agent' && sessions.includes(call.sessionId))
    return { repeat, overlapMs: pair.length === 2 && pair.every(call => call.end) ? Math.max(0, Math.min(...pair.map(call => call.end)) - Math.max(...pair.map(call => call.start))) : null,
      streams: pair.map(call => ({ provider: call.provider, elapsedMs: call.end ? call.end - call.start : null, firstContentMs: call.first ? call.first - call.start : null, reason: call.reason?.kind ?? null, usage: call.usage ?? null })) }
  })
  preflight.push({ name, hostVersion: result.hostVersion, completed: result.rows.every(row => row.completed), settingsUnchanged: result.settingsUnchanged ?? null, usesPrivateSettings: result.settingsHash !== undefined, pairs })
}
for (const name of names) {
  let result
  try { result = JSON.parse(await readFile(join(root, name, 'result.json'), 'utf8')) } catch { continue }
  if (!result.arm) continue
  let audit = null
  try { audit = JSON.parse(await readFile(join(root, name, 'audit.json'), 'utf8')) } catch { /* Explicitly report missing audit. */ }
  const boundary = result.boundary ?? null
  let sourceBytes = null
  try { sourceBytes = JSON.parse(await readFile(join(root, name, 'snapshot.json'), 'utf8')).sourceBytes } catch { /* Pre-boundary calibration can lack a snapshot. */ }
  const row = { name, arm: result.arm, seed: result.seed, fault: result.fault, completed: result.completed, errorCode: result.error?.code ?? null,
    settingsUnchanged: result.settingsUnchanged ?? null, candidateHash: result.candidateHash, fixtureHash: result.fixtureHash, sourceBytes, harnessHashes: result.harnessHashes ?? null,
    summaryStatus: boundary?.summaryStatus ?? null, boundaryWaitMs: boundary?.waitMs ?? null, transactionMs: boundary?.transactionMs ?? null, totalBoundaryMs: boundary?.totalBoundaryMs ?? null,
    seedBytes: boundary?.seedBytes ?? null, seedOriginalFields: boundary?.seedFields ?? null,
    stages: result.stages.map(stage => ({ phase: stage.phase, end: stage.end, elapsedMs: stage.elapsedMs, correct: stage.score?.correct ?? null, total: stage.score?.total ?? null, fields: stage.score?.fields ?? null, historicalToolAttempts: stage.retrievalCalls, retrievalCalls: audit ? (stage.phase === 'retrieval' ? audit.successfulRetrievalCalls : 0) : null })),
    audit: audit && { archiveBytesVerified: audit.archiveBytesVerified, currentInputProtected: audit.currentInputProtected, toolPairsBalanced: audit.toolPairsBalanced, localRequestsSerial: audit.localRequestsSerial, restoredBytes: audit.restoredBytes, overlapMs: audit.overlapMs, observedEvents: audit.observedEvents, webPageEvents: audit.webPageEvents, deniedToolAttempts: audit.deniedToolAttempts, snapshotGap: audit.snapshotGap },
    calls: audit?.calls.map(call => ({ provider: call.provider, purpose: call.purpose, elapsedMs: call.elapsedMs, usage: call.usage, reason: call.reason?.kind ?? null })) ?? null,
  }
  if (result.fault) faults.push(row)
  else if (name.startsWith('paired-')) samples.push(row)
  else calibrations.push(row)
}
const gates = []
for (const name of ['muse-native-91503', 'muse-in-place-91503', 'muse-windowed-91503']) {
  const path = resolve('.test-runtime/nightly-20260915', name)
  let result
  try { result = JSON.parse(await readFile(join(path, 'summary.json'), 'utf8')) } catch { gates.push({ name, missing: true }); continue }
  let audit = null
  try { audit = JSON.parse(await readFile(join(path, 'audit.json'), 'utf8')) } catch { /* Missing is not passing. */ }
  const events = JSON.parse(await readFile(join(path, 'observed', `${result.sessionId}.events.json`), 'utf8'))
  const calls = events.filter(event => event.type === 'assistant/message').flatMap(event => event.data.message.content).filter(block => block.type === 'tool-call')
  gates.push({ name, arm: result.arm, completed: result.completed ?? false, elapsedSeconds: result.elapsedSeconds ?? null, facts: result.score?.factsCorrect ?? null, factsTotal: result.score?.factsTotal ?? null, corrections: result.score?.correctionsCorrect ?? null, correctionsTotal: result.score?.correctionsTotal ?? null, verbatim: result.score2?.verbatimCorrect ?? null, verbatimTotal: result.score2?.verbatimTotal ?? null, allQualityPassed: result.allQualityPassed ?? false, compactions: result.compactions ?? [], calls: result.calls, reportedTokens: result.reportedTokens, settingsUnchanged: result.settingsUnchanged, restartVerified: result.restartVerified ?? null,
    newContextCalls: calls.filter(call => call.name === 'new_context').length, compressCalls: calls.filter(call => call.name === 'compress').length,
    seedModes: events.filter(event => event.type === 'compaction/summary').map(event => event.data.contextManagement?.seed?.mode ?? 'native-or-in-place'),
    archiveBytesVerified: audit?.archiveBytesVerified ?? null, exactPagesInRequests: audit?.exactPagesInRequests ?? null,
  })
}
let seedBudgetStress = null
try { seedBudgetStress = JSON.parse(await readFile(join(root, 'seed-budget-stress.json'), 'utf8')) } catch { /* Not exercised is null. */ }
let environmentIncident = null
try { environmentIncident = JSON.parse(await readFile(join(root, 'environment-incident.json'), 'utf8')) } catch { /* No separate incident record. */ }
let suffixMechanism = null
try { suffixMechanism = JSON.parse(await readFile(join(root, 'suffix-mechanism.json'), 'utf8')) } catch { /* Not exercised is null. */ }
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), hostVersion: '0.1.2-rc.1', productChanged: false,
  classification: 'Pilot: fixed synthetic boundary with real host transactions and real Qwen/Muse calls; separate Muse autonomous-reading gate. No statistical significance or 400k production claim.',
  plannedSeeds: [91511, 91512, 91513], plannedOrder: ['A', 'B', 'C', 'B', 'C', 'A', 'C', 'A', 'B'],
  preflight, samples, faults, calibrations, gates, seedBudgetStress, suffixMechanism, environmentIncident }
await writeFile(join(root, 'sanitized-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
if (process.argv.includes('--public')) await writeFile(resolve('docs/data/turnover-muse-2026-09-15.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ samples: samples.map(row => ({ name: row.name, completed: row.completed, summary: row.summaryStatus, wait: row.boundaryWaitMs, commit: row.transactionMs, overlap: row.audit?.overlapMs, score: row.stages.map(s => s.correct), retrievals: row.stages.at(-1)?.retrievalCalls })), gates, faults: faults.length, calibrations: calibrations.length }, null, 2))
