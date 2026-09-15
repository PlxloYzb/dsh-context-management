// One bounded real-host sample. Inspect its evidence before choosing another.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { startHost } from './local/runtime.mjs'
import { responseText } from './client.mjs'
import { fixture, foreground, probe, score } from './turnover/fixture.mjs'
import { writePrivateSettings } from './local/private-settings.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')))
const arm = args.arm ?? 'C', seed = Number(args.seed ?? 91521), fault = args.fault
const main = args.main ?? 'qwen'
if (!['qwen', 'muse'].includes(main)) throw new Error('main must be qwen or muse')
const work = args.work ?? 'standard'
if (!['standard', 'brief'].includes(work)) throw new Error('work must be standard or brief')
const cache = args.cache ?? 'configured'
if (!['configured', 'none'].includes(cache)) throw new Error('cache must be configured or none')
const foregroundOnly = args['stop-after'] === 'foreground', wire = args.wire === 'true'
if (args['stop-after'] !== undefined && !foregroundOnly) throw new Error('stop-after only supports foreground diagnostics')
if (args.wire !== undefined && !['true', 'false'].includes(args.wire)) throw new Error('wire must be true or false')
if (!['A', 'C'].includes(arm) || !Number.isSafeInteger(seed) || (fault && !['timeout', 'late'].includes(fault))) throw new Error('Invalid sample')
const windowBudget = Number(args.window ?? 64000), prepareFraction = Number(args.prepare ?? 0.25)
if (!Number.isSafeInteger(windowBudget) || windowBudget < 48000 || windowBudget > 64000 || !(prepareFraction > 0 && prepareFraction < 0.9)) throw new Error('Invalid mechanism geometry')
const name = args.name ?? `${arm.toLowerCase()}-${seed}-${Date.now()}`
if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid run name')
const root = resolve('.test-runtime/turnover-muse-20260915', name)
await mkdir(root, { recursive: false })
const hash = value => createHash('sha256').update(value).digest('hex')
const settingsPath = join(homedir(), '.dsh/settings.yaml'), settingsHash = hash(await readFile(settingsPath))
const isolatedSettings = join(root, 'private-settings.yaml')
await writePrivateSettings(isolatedSettings, await readFile(settingsPath), true, cache === 'none' ? 'none' : undefined)
const dshBin = resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh')
const version = JSON.parse(await readFile(resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/@deepseek-ai/dsh/package.json'))).version
if (version !== '0.1.2-rc.1') throw new Error('Host pin mismatch')
const candidateHash = hash(await readFile('dist/index.js'))
if (candidateHash !== hash(await readFile(join(homedir(), '.dsh/profiles/ctx-v012-smoke-c/node_modules/dsh-context-management/dist/index.js')))) throw new Error('Installed candidate differs')
const summaryRoute = { provider: 'opencode-go-muse', model: 'muse-spark-1.3-contributor', reasoningEffort: 'minimal' }
const mainRoute = main === 'muse' ? { ...summaryRoute } : { provider: 'ubuntu-lora', model: 'Qwen3.8-27B-NVFP4KV-384K', reasoningEffort: 'off' }
const data = fixture(seed), fixturePath = join(root, 'fixture.json'), patch = join(root, 'host.patch.yml')
const save = (file, value) => writeFile(join(root, file), JSON.stringify(value, null, 2), { mode: 0o600 })
await save('fixture.json', data)
await save('phase.json', { phase: 'foreground' })
await writeFile(patch, JSON.stringify([
  { id: 'settings', config: { path: isolatedSettings } },
  { id: 'session-title-llm', disabled: true },
  { id: 'compaction-context-management-bridge', config: { autoNudge: false, ...(arm === 'C' ? { backgroundSummary: { ...summaryRoute, allowSameProvider: main === 'muse', prepareAtEffectiveCapacityPct: prepareFraction, timeoutMs: fault === 'timeout' ? 500 : 60000 } } : {}), adaptiveGovernor: { enabled: true, strategy: 'windowed', windowBudgetTokens: windowBudget, maxOutputTokens: 2048, safetyMarginTokens: 4096 }, archive: { seedMaxTokens: 4096, retrievalDefaultMaxTokens: 2048, retrievalMaxTokens: 4096 } } },
  { insert: [
    ...(wire ? [{ id: 'turnover-wire-observer', name: resolve('tests/live/turnover/wire-observer.mjs'), config: { output: root } }] : []),
    { id: 'turnover-observer', name: resolve('tests/live/turnover/observer.mjs'), config: { output: root, maxTokens: 2048, mainRoute, summaryRoute } },
    { id: 'turnover-experiment', name: resolve('tests/live/turnover/engine-observer.mjs'), config: { output: root, fixturePath, arm, fault, mainRoute, summaryRoute } },
  ] },
]), { mode: 0o600 })
const report = { kind: foregroundOnly ? 'foreground-input-diagnostic' : 'installed-background-engine', probeVersion: 2, foregroundWork: work, cachePolicy: cache, wireCapture: wire, geometry: { windowBudget, prepareFraction }, schemaVersion: 1, name, arm, seed, fault: fault ?? null, hostVersion: version, candidateHash, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), settingsHash, mainRoute, summaryRoute, allowSameProvider: main === 'muse', fixtureHash: data.hash, startedAt: new Date().toISOString(), stages: [], completed: false }
report.harnessHashes = Object.fromEntries(await Promise.all(['background-muse.mjs', 'turnover/engine-observer.mjs', 'turnover/observer.mjs', 'turnover/fixture.mjs', 'local/private-settings.mjs', ...(wire ? ['turnover/wire-observer.mjs'] : [])].map(async name => [name, hash(await readFile(resolve('tests/live', name)))])))
await save('result.json', report)
let host, sessionId
const caffeine = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
const stop = async () => { if (sessionId && host) await host.client.call('session/cancel', { sessionId }).catch(() => {}); await host?.stop(); caffeine.kill() }
process.once('SIGTERM', () => { void stop() }); process.once('SIGINT', () => { void stop() })
const deadline = setTimeout(() => { void stop() }, 600000)
try {
  host = await startHost({ dshBin, directory: root, profile: 'ctx-v012-smoke-c', patch, port: 3324 }, name)
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-context-experiment-turnover-'))
  sessionId = (await host.client.call('session/create', { cwd, agentPreset: 'standard' })).sessionId
  report.sessionId = sessionId
  await host.client.call('session/selectModel', { sessionId, ...mainRoute })
  for (const phase of foregroundOnly ? ['foreground'] : ['foreground', 'seed', 'retrieval']) {
    await save('phase.json', { phase })
    const fresh = `fresh-${seed}-7e0183`
    const padding = phase === 'seed' ? JSON.parse(await readFile(join(root, 'padding.json'), 'utf8')).text : ''
    const message = phase === 'foreground' ? (work === 'brief' ? `Synthetic foreground acknowledgement. Do not call tools. Reply only with this checkpoint marker: ${fresh}` : foreground + `\nFinish with this new checkpoint marker exactly: ${fresh}.`) : padding + probe(data, phase === 'retrieval') + ' Also include the string field fresh with the checkpoint marker from the latest foreground work. For every field, return only the original bare identifier as the JSON string value. Do not append commentary, conditions such as after approval, source references, or explanations to any value.'
    const result = await host.client.prompt(sessionId, message, 240000)
    const answer = responseText(result.recent)
    const row = { phase, freshVisible: answer.includes(fresh), end: result.end.kind, elapsedMs: result.elapsedMs, answer, ...(phase === 'foreground' ? {} : { score: score(answer, data) }), retrievalCalls: result.recent.filter(e => e.type === 'assistant/message').flatMap(e => e.data.message.content).filter(block => block.type === 'tool-call' && ['search_context', 'decompress'].includes(block.name)).length }
    report.stages.push(row); await save('result.json', report)
    console.log(JSON.stringify({ name, phase, end: row.end, elapsedMs: row.elapsedMs, score: row.score?.correct, retrievalCalls: row.retrievalCalls }))
    if (row.end !== 'completed') throw new Error('Incomplete turn')
  }
  const foregroundAnswer = report.stages.find(s => s.phase === 'foreground').answer
  report.foregroundInstructionPassed = work === 'brief' ? foregroundAnswer.trim() === `fresh-${seed}-7e0183` : foregroundAnswer.includes(`fresh-${seed}-7e0183`)
  if (!foregroundOnly) {
  const events = JSON.parse(await readFile(join(root, 'retrieval-events.json'), 'utf8'))
  const windows = events.filter(e => e.type === 'compaction/summary' && e.data.contextManagement)
  report.windows = windows.map(e => e.data.contextManagement)
  report.finalGeneration = windows.length
  const before = JSON.parse(await readFile(join(root, 'foreground-events.json'), 'utf8'))
  report.appendOnly = JSON.stringify(events.slice(0, before.length)) === JSON.stringify(before)
  const seedEvents = JSON.parse(await readFile(join(root, 'seed-events.json'), 'utf8'))
  const foregroundMessages = before.filter(e => e.type === 'assistant/message')
  const latestUserSeq = before.filter(e => e.type === 'user/message' && e.data.source.kind === 'user').at(-1)?.seq ?? Infinity
  const freshSeq = foregroundMessages.filter(e => e.seq > latestUserSeq).at(-1)?.seq
  report.freshSeq = freshSeq
  report.freshOutsideArchive = freshSeq !== undefined && windows.every(e => !(e.data.shadowedSeqs ?? []).includes(freshSeq))
  report.seedEventsCount = seedEvents.length
  await save('final-events.json', events)
  // A naturally late cloud job is a valid fallback outcome, not proof of a broken boundary.
  // Enforce raw retention only when a prepared snapshot was actually consumed.
  const prepared = windows.some(e => e.data.contextManagement.seed.prepared)
  if (!windows.length || !report.appendOnly || (prepared && !report.freshOutsideArchive)) throw new Error('Engine boundary/continuity invariant failed')
  }
  report.completed = true
} catch (error) { report.error = { code: error.code ?? 'sample-failed', message: String(error.message).replace(/https?:\/\/\S+/g, '[url redacted]').slice(0, 500) }; console.log(JSON.stringify({ name, error: report.error })) }
finally {
  clearTimeout(deadline); await stop()
  report.settingsUnchanged = settingsHash === hash(await readFile(settingsPath))
  report.finishedAt = new Date().toISOString()
  await save('result.json', report)
  console.log(JSON.stringify({ name, completed: report.completed, output: root }))
  process.exitCode = report.completed ? 0 : 1
}
