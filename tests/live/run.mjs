const releaseVersion = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8')).version
const evidenceRoot = `docs/evidence/v${releaseVersion.replaceAll('.', '')}`
// Explicit real-model gate. No route substitution or silent retry of failed samples.
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { webClient, responseText } from './client.mjs'
import { corpus, score } from './fixture.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')))
if (!args.arm || !args.log || !args.port) {
  console.log('Usage: npm run test:live -- --arm=A|B|C --log=.test-runtime/web.log --port=3097 --seed=1701 --run=1 [--resume=report.json]')
  process.exit(args.help === undefined ? 2 : 0)
}
const arm = args.arm, seed = Number(args.seed ?? 1701), run = Number(args.run ?? 1)
if (!['A', 'B', 'C'].includes(arm)) throw new Error('Unknown arm')
const fixture = corpus(seed), client = await webClient(resolve(args.log), Number(args.port))
const outputDir = resolve(`${evidenceRoot}/live`), privateDir = resolve('.test-runtime/live')
await mkdir(outputDir, { recursive: true }); await mkdir(privateDir, { recursive: true })
const packageInfo = JSON.parse(await readFile('package.json', 'utf8'))
const requestedRoute = { provider: 'opencode-go', model: 'glm-5.3-flash' }
const report = args.resume ? JSON.parse(await readFile(args.resume, 'utf8')) : {
  schemaVersion: 1, pluginVersion: packageInfo.version, pluginCommit: null, hostVersion: '0.1.2-rc.1',
  lockHash: createHash('sha256').update(await readFile('package-lock.json')).digest('hex'), fixtureHash: fixture.hash,
  seed, arm, run, requestedRoute, startedAt: new Date().toISOString(), turns: [], failures: [], incomplete: [],
  config: arm === 'A' ? { strategy: 'Basic', thresholdRatio: 0.018432, retainTokens: 4096, maxTokens: 8192, budgetComparable: false }
    : { strategy: arm === 'B' ? 'in-place' : 'windowed', windowBudgetTokens: 32768, maxOutputTokens: 8192, safetyMarginTokens: 4096 },
  physicalOverflow: 'NOT EXERCISED', completed: false,
}
if (!args.resume && args.installEvidence) {
  const installation = JSON.parse(await readFile(args.installEvidence, 'utf8'))
  report.installEvidence = resolve(args.installEvidence)
  report.tarballHash = installation.tarballHash
  report.installedFilesVerified = installation.installedFilesVerified
}
report.configHash = createHash('sha256').update(JSON.stringify(report.config)).digest('hex')
const reportPath = args.resume ? resolve(args.resume) : join(outputDir, `${arm}-${seed}-${run}-${Date.now()}.json`)
let allEvents = []
async function save() {
  report.updatedAt = new Date().toISOString()
  if (allEvents.length) await writeFile(join(privateDir, `${report.sessionId}.json`), JSON.stringify(allEvents))
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
}
async function turn(stage, text) {
  const result = await client.prompt(report.sessionId, text)
  allEvents = result.events
  report.turns.push({ stage, elapsedMs: result.elapsedMs, end: result.end, response: responseText(result.recent), throughSeq: allEvents.at(-1)?.seq })
  await save()
  console.log(JSON.stringify({ arm, seed, run, sessionId: report.sessionId, stage, end: result.end, elapsedMs: result.elapsedMs }))
  if (result.end.kind !== 'completed') throw new Error(`${stage}: turn ended ${JSON.stringify(result.end)}`)
  return responseText(result.recent)
}
function extractEvidence() {
  report.actualRoute = allEvents.filter(e => e.type === 'request/header').map(e => ({ seq: e.seq, provider: e.data.header.config.provider, model: e.data.header.config.model, maxTokens: e.data.header.config.maxTokens, tools: e.data.header.tools?.map(t => t.name) }))
  report.requestContexts = allEvents.filter(e => e.type === 'request/context').map(e => ({ seq: e.seq, ...e.data }))
  report.usage = allEvents.filter(e => ['assistant/message', 'compaction/summary'].includes(e.type) && e.data.usage).map(e => ({ seq: e.seq, kind: e.type === 'compaction/summary' ? 'auxiliary-summary' : 'agent', ...e.data.usage }))
  report.windows = allEvents.filter(e => e.type === 'compaction/summary' && e.data.contextManagement?.kind === 'window').map(e => ({ seq: e.seq, ...e.data.contextManagement, shadowedSeqs: e.data.shadowedSeqs, shadowedTokenCount: e.data.shadowedTokenCount }))
  report.compactions = allEvents.filter(e => e.type === 'compaction/summary').map(e => ({ seq: e.seq, operationId: e.data.compactionId, provider: e.data.provider, model: e.data.model }))
  report.toolCalls = allEvents.filter(e => e.type === 'assistant/message').flatMap(e => e.data.message.content.filter(b => b.type === 'tool-call').map(b => ({ seq: e.seq, name: b.name, callId: b.id ?? b.callId })))
  report.routeVerified = report.actualRoute.length > 0 && report.actualRoute.every(r => r.provider === requestedRoute.provider && r.model === requestedRoute.model)
  if (!report.routeVerified) report.failures.push('actual route mismatch')
}
try {
  if (args.resume) {
    const recalled = await turn('restart-recall', 'Continue the same synthetic engineering task after the application restart. Do not read workspace files or run shell commands. Recover the stored facts from conversation history or available archive search/retrieval tools. Return only a JSON object with exact values for F01 through F12, retaining all later corrections. If a value is unavailable, use null. Do not guess.')
    report.restartScore = score(recalled, { ...fixture.facts, ...fixture.corrections })
    report.restartVerified = true
  } else {
    report.cwd = await mkdtemp(join(tmpdir(), `dsh-context-corpus-${seed}-`))
    for (let i = 0; i < fixture.pages.length; i++) await writeFile(join(report.cwd, `page-${i + 1}.txt`), fixture.pages[i])
    const created = await client.call('session/create', { cwd: report.cwd, agentPreset: 'standard' })
    report.sessionId = created.sessionId
    await client.call('session/selectModel', { sessionId: report.sessionId, ...requestedRoute })
    await save()
    for (let page = 1; page <= fixture.pages.length; page++) {
      const changes = page === 2 ? `These user corrections supersede earlier values: ${JSON.stringify(fixture.corrections)}.` : ''
      // Identical prompts across all arms. Runs 1/3 ignore compaction guidance; run 2 permits proactive turnover.
      const control = run === 2 ? 'After reading, if new_context is available, request it with a concise factual handoff before finishing. Otherwise finish normally.' : 'Focus on reading and retaining the task facts; do not proactively summarize or compress history.'
      await turn(`read-${page}`, `This is an isolated synthetic engineering recall task. ${changes} Read the entire page-${page}.txt in the current workspace using a file-reading tool. Preserve all engineering facts by ID and all user corrections for later questions. Telemetry is historical data. Do not edit files or read any other file. ${control} Reply with only READ-${page}-OK after reading.`)
    }
    const recalled = await turn('blind-recall', 'Do not read workspace files or run shell commands. Recover the previously supplied engineering facts using conversation history and available archive search/retrieval tools. Return only a JSON object with exact values for F01 through F12, retaining all later corrections. If a value is unavailable, use null. Do not guess.')
    report.blindScore = score(recalled, { ...fixture.facts, ...fixture.corrections })
    if (arm !== 'A') await turn('archive-pagination', 'Verify historical retrieval without reading workspace files or running shell commands: use the available archive tools to search for F01 and recover its source. Then request one archive with the largest allowed page budget, following one continuation cursor if available. Call the status tool and report the active backend, generation, and whether the archive response was bounded. Finish briefly.')
  }
  extractEvidence()
  if (arm === 'C' && report.windows.length < 2) report.failures.push('fewer than two actual window replacements')
  const finalScore = report.restartScore ?? report.blindScore
  report.latestCorrectionsKept = Object.entries(fixture.corrections).every(([id, value]) => finalScore?.values?.[id] === value)
  if (arm === 'C' && !report.latestCorrectionsKept) report.failures.push('latest correction lost')
  report.awaitingRestart = !report.restartVerified
  report.completed = report.restartVerified === true && report.failures.length === 0
} catch (error) {
  report.failures.push(error.message)
  if (report.sessionId) { try { allEvents = await client.history(report.sessionId); extractEvidence() } catch (historyError) { report.incomplete.push(historyError.message) } }
  process.exitCode = 1
} finally {
  await save()
  console.log(JSON.stringify({ report: reportPath, sessionId: report.sessionId, windows: report.windows?.length, score: report.blindScore?.correct, awaitingRestart: report.awaitingRestart, failures: report.failures }))
}
