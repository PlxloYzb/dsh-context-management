// Small installed-package Web contract cohort; at most two independent model
// turns run together. Native command and scope checks do not require generation.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, mkdtemp, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { startHost } from '../live/local/runtime.mjs'
import { writePrivateSettings } from '../live/local/private-settings.mjs'
import { responseText } from '../live/client.mjs'

const name = process.argv[2] ?? 'web-candidate-1'
assert.match(name, /^[a-z0-9-]+$/)
const directory = resolve('.test-runtime/reliability-20260915', name)
await mkdir(directory, { recursive: false })
const hash = value => createHash('sha256').update(value).digest('hex')
const save = (file, value) => writeFile(join(directory, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const settingsPath = join(homedir(), '.dsh/settings.yaml'), settings = await readFile(settingsPath), settingsHash = hash(settings)
const pinnedRoot = resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1'), dshBin = join(pinnedRoot, 'node_modules/.bin/dsh')
assert.equal(JSON.parse(await readFile(join(pinnedRoot, 'node_modules/@deepseek-ai/dsh/package.json'))).version, '0.1.2-rc.1')
const presets = join(pinnedRoot, 'node_modules/@deepseek-ai/dsh-agent-presets/presets')
const presetHashes = async () => Object.fromEntries(await Promise.all(['standard', 'minimal', 'ptc', 'cordis'].map(async name => [name, hash(await readFile(join(presets, name, 'agent.cordis.yml')))])))
const candidateHash = hash(await readFile('dist/index.js'))
const distHashes = async root => Object.fromEntries(await Promise.all((await readdir(root)).sort().map(async file => [file, hash(await readFile(join(root, file)))])))
const candidateFiles = await distHashes(resolve('dist')), candidateDistHash = hash(Object.entries(candidateFiles).map(([path, digest]) => `${path}\0${digest}\n`).join(''))
assert.deepEqual(await distHashes(join(homedir(), '.dsh/profiles/ctx-v012-smoke-c/node_modules/dsh-context-management/dist')), candidateFiles)
const settingsFile = join(directory, 'settings-private.yaml'), patch = join(directory, 'host.patch.yml')
await writePrivateSettings(settingsFile, settings, true)
await writeFile(patch, JSON.stringify([
  { id: 'settings', config: { path: settingsFile } }, { id: 'session-title-llm', disabled: true },
  { insert: [{ id: 'reliability-observer', name: resolve('tests/reliability/web-observer.mjs'), config: { output: directory } }] },
]), { mode: 0o600 })
const report = { schemaVersion: 1, name, startedAt: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), hostVersion: '0.1.2-rc.1', candidateHash, candidateFiles, candidateDistHash,
  harnessHashes: Object.fromEntries(await Promise.all(['web-contract.mjs', 'web-observer.mjs'].map(async file => [file, hash(await readFile(resolve('tests/reliability', file)))]))),
  presetsBefore: await presetHashes(), settingsHash, cases: [], completed: false }
let host, launch = 0
const sessions = []
const start = async () => { host = await startHost({ dshBin, directory, profile: 'ctx-v012-smoke-c', patch, port: 3327 }, String(++launch)) }
const command = async (sessionId, line) => host.client.callArgs('commands/execute', { agentId: sessionId, line, images: [] })
const snapshot = async (sessionId, stage) => {
  const reply = await command(sessionId, `/reliability ${stage}`)
  assert.equal(reply.result.kind, 'success')
  return JSON.parse(reply.result.text)
}
const verify = value => {
  assert.deepEqual(value.leakedServices, [])
  if (value.preset === 'minimal') { assert.equal(value.backend, null); assert.equal(value.providerCount, 0); assert.deepEqual(value.commands, { compact: 0, context: 0 }) }
  else {
    assert.equal(value.backend, 'ArcCompactionEngine'); assert.equal(value.providerCount, 1); assert.equal(value.basicActive, 0); assert.equal(value.arcActive, 1)
    assert.deepEqual(value.commands, { compact: 1, context: 1 }); assert.ok(value.prunerAvailable)
    assert.ok(value.compactConsumers.length === 1 && value.compactConsumers[0].boundToResolvedBackend)
  }
  report.cases.push(value)
}
async function create(preset) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-context-reliability-web-'))
  const { sessionId } = await host.client.call('session/create', { cwd, agentPreset: preset })
  sessions.push(sessionId)
  await host.client.call('session/selectModel', { sessionId, provider: 'opencode-go-muse', model: 'muse-spark-1.3-contributor', reasoningEffort: 'minimal' })
  return sessionId
}
async function smoke(sessionId, stage) {
  const result = await host.client.prompt(sessionId, 'Synthetic reliability smoke: do not call tools. Reply exactly READY.', 180000)
  assert.equal(result.end.kind, 'completed')
  assert.equal(responseText(result.recent).trim(), 'READY')
  verify(await snapshot(sessionId, stage))
}
try {
  await start()
  const standard = await create('standard'), minimal = await create('minimal')
  // This is the bounded parallel cloud branch; each result is checked before
  // the next group of work, and every branch is settled before cleanup.
  const results = await Promise.allSettled([smoke(standard, 'standard-first'), smoke(minimal, 'minimal-first')])
  for (const result of results) if (result.status === 'rejected') throw result.reason
  await snapshot(standard, 'seed')
  const before = await snapshot(standard, 'before-native-compact')
  const compact = await command(standard, '/compact')
  assert.equal(compact.result.kind, 'success'); assert.ok(Number.isSafeInteger(compact.result.sourceEventSeq), 'native /compact must commit real history')
  const after = await snapshot(standard, 'after-native-compact'); verify(after)
  assert.ok(after.generation > before.generation)
  const history = JSON.parse(await readFile(join(directory, `${standard}.events.json`)))
  const summary = history.find(event => event.seq === compact.result.sourceEventSeq)
  assert.equal(summary?.type, 'compaction/summary')
  assert.equal(summary.data.provider, 'local')
  report.nativeCompact = { kind: compact.result.kind, sourceEventSeq: compact.result.sourceEventSeq, summaryProvider: summary.data.provider, generationBefore: before.generation, generationAfter: after.generation }
  // Blank sessions switch without emitting a replacement agent/created.
  const switching = await create('minimal')
  await host.client.callArgs('agentPresets/select', { agentId: switching, agentPreset: 'ptc' })
  const immediate = await command(switching, '/context status')
  assert.equal(immediate.result.kind, 'success')
  verify(await snapshot(switching, 'switched-ptc-before-model'))
  const cordis = await create('cordis')
  const second = await Promise.allSettled([smoke(switching, 'ptc-first'), smoke(cordis, 'cordis-first')])
  for (const result of second) if (result.status === 'rejected') throw result.reason
  await host.stop(); await start()
  await smoke(standard, 'standard-restart')
  verify(await snapshot(minimal, 'minimal-restart'))
  const observations = (await readFile(join(directory, 'observations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const streams = observations.filter(row => row.kind === 'stream-start')
  assert.equal(streams.length, 5)
  const contextTools = ['arc_status', 'compress', 'decompress', 'new_context', 'search_context']
  for (const row of streams) {
    const preset = report.cases.find(value => value.sessionId === row.sessionId)?.preset
    if (preset === 'minimal') assert.ok(contextTools.every(tool => !row.tools.includes(tool)))
    else if (preset === 'ptc') assert.deepEqual(row.tools, ['run_code'])
    else assert.ok(contextTools.every(tool => row.tools.includes(tool)))
  }
  report.modelRequests = streams.map(({ sessionId, provider, model, effort, tools }) => ({ preset: report.cases.find(value => value.sessionId === sessionId)?.preset, provider, model, effort, tools }))
  report.completed = true
} catch (error) { report.error = { message: String(error.message).slice(0, 500) }; process.exitCode = 1 }
finally {
  for (const sessionId of sessions) await host?.client.call('session/cancel', { sessionId }).catch(() => {})
  await host?.stop()
  report.presetsAfter = await presetHashes(); report.presetsUnchanged = JSON.stringify(report.presetsBefore) === JSON.stringify(report.presetsAfter)
  report.settingsUnchanged = hash(await readFile(settingsPath)) === settingsHash
  report.finishedAt = new Date().toISOString()
  await save('result.json', report)
  console.log(JSON.stringify({ name, completed: report.completed, cases: report.cases.length, error: report.error ?? null, settingsUnchanged: report.settingsUnchanged, presetsUnchanged: report.presetsUnchanged }))
}
