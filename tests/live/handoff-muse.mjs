// One bounded real-host deferred-handoff mechanism sample. It deliberately
// drives the installed governor through a normal tool result; this harness
// never requests a turnover or writes a handoff into the session.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { startHost } from './local/runtime.mjs'
import { responseText } from './client.mjs'
import { fixture } from './turnover/fixture.mjs'
import { writePrivateSettings } from './local/private-settings.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')))
const task = args.task ?? 'independent', background = args.background ?? 'true', seed = Number(args.seed ?? 91541)
if (!['independent', 'dependent'].includes(task) || !['true', 'false'].includes(background) || !Number.isSafeInteger(seed)) throw new Error('Usage: --task=independent|dependent --background=true|false [--seed=91541] [--name=unique-name]')
const name = args.name ?? `${task}-${background}-${seed}-${Date.now()}`
if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid run name')
const root = resolve('.test-runtime/handoff-muse-20260915', name)
await mkdir(resolve('.test-runtime/handoff-muse-20260915'), { recursive: true })
await mkdir(root, { recursive: false })
const hash = value => createHash('sha256').update(value).digest('hex')
const save = (file, value) => writeFile(join(root, file), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
const settingsPath = join(homedir(), '.dsh/settings.yaml'), settingsHash = hash(await readFile(settingsPath))
const isolatedSettings = join(root, 'private-settings.yaml')
await writePrivateSettings(isolatedSettings, await readFile(settingsPath), true)
const dshBin = resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh')
const hostPackage = resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/@deepseek-ai/dsh/package.json')
const hostVersion = JSON.parse(await readFile(hostPackage)).version
if (hostVersion !== '0.1.2-rc.1') throw new Error('Host pin mismatch')
const candidateHash = hash(await readFile('dist/index.js'))
const installed = join(homedir(), '.dsh/profiles/ctx-v012-smoke-c/node_modules/dsh-context-management/dist/index.js')
if (candidateHash !== hash(await readFile(installed))) throw new Error('Installed candidate differs')
const route = { provider: 'opencode-go-muse', model: 'muse-spark-1.3-contributor', reasoningEffort: 'minimal' }
const data = fixture(seed), fixturePath = join(root, 'fixture.json'), patch = join(root, 'host.patch.yml')
await save('fixture.json', data)
await save('phase.json', { phase: 'initial' })
await writeFile(patch, JSON.stringify([
  { id: 'settings', config: { path: isolatedSettings } },
  { id: 'session-title-llm', disabled: true },
  { id: 'compaction-context-management-bridge', config: {
    autoNudge: false,
    adaptiveGovernor: { enabled: true, strategy: 'windowed', windowBudgetTokens: 44000, maxOutputTokens: 2048, safetyMarginTokens: 4096, emergencyFallback: true },
    archive: { seedMaxTokens: 4096, retrievalDefaultMaxTokens: 2048, retrievalMaxTokens: 4096 },
    ...(background === 'true' ? { backgroundSummary: { ...route, allowSameProvider: true, delivery: 'deferred', maxSummaryBytes: 4096, prepareAtEffectiveCapacityPct: 0.25, timeoutMs: 60000 } } : {}),
  } },
  { insert: [
    { id: 'turnover-observer', name: resolve('tests/live/turnover/observer.mjs'), config: { output: root, maxTokens: 2048, mainRoute: route, summaryRoute: route } },
    { id: 'handoff-observer', name: resolve('tests/live/turnover/handoff-observer.mjs'), config: { output: root, fixturePath, task, background: background === 'true', route } },
  ] },
]), { mode: 0o600 })
const report = { schemaVersion: 1, kind: 'deferred-handoff-mechanism', name, task, background: background === 'true', seed, hostVersion, candidateHash, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), settingsHash, geometry: { windowBudgetTokens: 44000, maxOutputTokens: 2048, safetyMarginTokens: 4096, currentPayloadLines: 100, prepareFraction: 0.25, maxSummaryBytes: 4096 }, route, fixtureHash: data.hash, startedAt: new Date().toISOString(), stages: [], completed: false }
report.harnessHashes = Object.fromEntries(await Promise.all(['handoff-muse.mjs', 'turnover/handoff-observer.mjs', 'turnover/observer.mjs', 'turnover/fixture.mjs', 'local/private-settings.mjs'].map(async file => [file, hash(await readFile(resolve('tests/live', file)))])))
await save('result.json', report)
let host, sessionId
const caffeine = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
const stop = async () => { if (sessionId && host) await host.client.call('session/cancel', { sessionId }).catch(() => {}); await host?.stop(); caffeine.kill() }
process.once('SIGTERM', () => { void stop() }); process.once('SIGINT', () => { void stop() })
const deadline = setTimeout(() => { void stop() }, 600000)
const prompt = task === 'independent'
  ? 'Call handoff_current_payload exactly once, then pass its currentToken to handoff_current_verify. These tools use only current-task data and no historical release facts. Return exactly one JSON object with currentToken and verified from the verification result. Do not call await_context, search_context, decompress, arc_status, or new_context.'
  : `Call handoff_current_payload exactly once, then ${background === 'true' ? 'call await_context exactly once' : 'use search_context and decompress'} before answering. After it reports status, return one JSON object with bare string fields owner, rollback, gate. Do not guess missing history. If await_context reports unavailable, use search_context and decompress to recover the values. Do not call arc_status or new_context.`
try {
  host = await startHost({ dshBin, directory: root, profile: 'ctx-v012-smoke-c', patch, port: 3324 }, name)
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-context-experiment-turnover-handoff-'))
  sessionId = (await host.client.call('session/create', { cwd, agentPreset: 'standard' })).sessionId
  report.sessionId = sessionId
  await host.client.call('session/selectModel', { sessionId, ...route })
  await save('phase.json', { phase: 'task', task })
  const result = await host.client.prompt(sessionId, prompt, 480000)
  const answer = responseText(result.recent)
  const expected = task === 'dependent' ? { owner: data.expected.owner, rollback: data.expected.rollback, gate: data.expected.gate } : null
  const objects = answer.match(/\{[^{}]*\}/g) ?? []
  let parsed = {}
  for (const value of objects) { try { parsed = JSON.parse(value) } catch { /* malformed output remains a scored failure */ } }
  const score = expected && Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, parsed[key] === value]))
  report.stages.push({ phase: 'task', end: result.end.kind, elapsedMs: result.elapsedMs, answer, ...(score ? { score: { fields: score, correct: Object.values(score).filter(Boolean).length, total: Object.keys(score).length } } : { score: { correct: Number(parsed.currentToken === `current-${data.seed}-${data.liveRegion}` && parsed.verified === true), total: 1 }, currentToken: parsed.currentToken ?? null }) })
  await save('rpc-history.json', await host.client.history(sessionId))
  const observed = JSON.parse(await readFile(join(root, 'observer-state.json'), 'utf8'))
  const events = observed.events
  if (!events.every((event, index) => event.seq === index)) throw new Error('Observer snapshot must be contiguous from zero')
  await save('final-events.json', events)
  if (result.end.kind !== 'completed') {
    report.turnFailure = events.filter(event => event.type === 'turn/end').at(-1)?.data?.reason ?? null
    throw new Error('Incomplete task turn')
  }
  const windows = events.filter(event => event.type === 'compaction/summary' && event.data?.contextManagement)
  report.windows = windows.map(event => event.data.contextManagement)
  report.windowObserved = windows.length > 0
  const statuses = (observed?.states ?? []).map(row => row.summary?.status).filter(Boolean)
  const delivered = (observed?.handoffs ?? []).some(row => row.handoff.status === 'delivered')
  const readyObserved = (observed?.states ?? []).some(row => Number.isFinite(row.summary?.readyAt))
  report.handoffCoverage = background === 'false' ? { classification: 'not-applicable' } : {
    pendingObserved: statuses.includes('pending'), readyObserved, deliveredObserved: delivered,
    classification: statuses.includes('pending') && readyObserved && delivered ? 'covered' : 'uncovered-natural-timing',
  }
  if (!report.windowObserved) throw new Error('The real governor did not produce a window replacement')
  report.completed = true
} catch (error) {
  report.error = { code: error.code ?? 'sample-failed', message: String(error.message).replace(/https?:\/\/\S+/g, '[url redacted]').slice(0, 500) }
  console.log(JSON.stringify({ name, error: report.error }))
} finally {
  clearTimeout(deadline); await stop()
  report.settingsUnchanged = settingsHash === hash(await readFile(settingsPath))
  report.finishedAt = new Date().toISOString()
  await save('result.json', report)
  console.log(JSON.stringify({ name, completed: report.completed, windowObserved: report.windowObserved ?? false, output: root }))
  process.exitCode = report.completed ? 0 : 1
}
