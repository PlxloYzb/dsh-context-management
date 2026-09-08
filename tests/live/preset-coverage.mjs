// Profile-wide, installed-package coverage. Every session/workspace is synthetic.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdir, writeFile, readFile, mkdtemp, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { webClient } from './client.mjs'

const installation = JSON.parse(await readFile(process.argv[2], 'utf8'))
const profile = installation.profile, port = Number(process.argv[3] ?? 3123)
assert.match(profile, /^ctx-v011-preset-/)
const root = resolve('.test-runtime', profile), customRoot = join(root, 'presets'), observed = join(root, 'observed')
// A freshly created DSH profile defaults to base only; this test owns a Web fixture.
const manifestPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profile, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (!manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app')) {
  manifest.dsh.profile.bundles.splice(1, 0, '@deepseek-ai/dsh-web-app')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

const hash = data => createHash('sha256').update(data).digest('hex')
const binary = await realpath(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
const officialRoot = join(dirname(dirname(binary)), 'node_modules/@deepseek-ai/dsh-agent-presets/presets')
const official = ['standard', 'ptc', 'cordis', 'minimal']
const source = await readFile(join(officialRoot, 'standard/agent.cordis.yml'), 'utf8')
const report = { pluginVersion: installation.pluginVersion, hostVersion: '0.1.2-rc.1', profile,
  tarballHash: installation.tarballHash, startedAt: new Date().toISOString(), cases: [], completed: false, failures: [] }
const files = new Set(official.map(id => join(officialRoot, id, 'agent.cordis.yml')))
await mkdir(observed, { recursive: true }); await mkdir(customRoot, { recursive: true })
async function custom(id, yaml) {
  const dir = join(customRoot, id); await mkdir(dir, { recursive: true })
  const path = join(dir, 'agent.cordis.yml'); await writeFile(path, yaml); files.add(path)
}
const renamed = source.replace('id: compaction\n', 'id: my-context-realm\n').replace('id: compaction-basic\n', 'id: my-basic-backend\n')
await custom('custom-renamed', renamed)
await custom('custom-nested', '- id: custom-outer\n  name: cordis:group\n  group: true\n  config:\n' + renamed.split('\n').map(line => '    ' + line).join('\n'))
await custom('custom-switched', renamed)
const late = 'custom-late'
const patch = join(root, 'test.patch.yml'), log = join(root, 'web.log')
await writeFile(patch, `- id: agent-presets\n  config:\n    default: standard\n    roots:\n      - path: ${JSON.stringify(customRoot)}\n        trust: user\n    includeShippedRoot: true\n    includeUserRoot: false\n- insert:\n    - id: preset-coverage-observer\n      name: ${JSON.stringify(resolve('tests/live/observer.mjs'))}\n      config:\n        output: ${JSON.stringify(observed)}\n        arm: preset-coverage\n`)
async function hashes() { return Object.fromEntries(await Promise.all([...files].map(async path => [path, hash(await readFile(path))]))) }
let server
async function stop() {
  if (!server || server.exitCode !== null) return
  const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited
}
async function start() {
  await writeFile(log, '')
  server = spawn('dsh', ['--profile', profile, '--patch', patch, '--host', '127.0.0.1', '--port', String(port), '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', data => appendFileSync(log, data)); server.stderr.on('data', data => appendFileSync(log, data))
  return webClient(log, port)
}
async function create(client, preset) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-context-corpus-preset-'))
  const { sessionId } = await client.call('session/create', { cwd, agentPreset: preset })
  await client.call('session/selectModel', { sessionId, provider: 'opencode-go', model: 'glm-5.3-flash' })
  return { sessionId, preset }
}
async function verify(client, session, stage, expected) {
  const result = await client.prompt(session.sessionId, 'Synthetic preset coverage check. Reply only READY. Do not call any tools.')
  assert.equal(result.end.kind, 'completed', JSON.stringify(result.end))
  const pressures = (await readFile(join(observed, `${session.sessionId}.pressure.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse)
  const backend = pressures.at(-1).backend ?? null
  assert.equal(backend, expected, `${session.preset} ${stage}`)
  const headers = result.recent.filter(e => e.type === 'request/header').map(e => e.data.header)
  assert.ok(headers.length)
  for (const header of headers) {
    assert.equal(header.config.provider, 'opencode-go'); assert.equal(header.config.model, 'glm-5.3-flash')
    const exposesArc = header.tools.some(t => t.name === 'arc_status') || (header.tools.some(t => t.name === 'run_code') && JSON.stringify(header.system).includes('arc_status'))
    assert.equal(exposesArc, expected === 'ArcCompactionEngine', `${session.preset} tool presentation`)
    if (session.preset === 'minimal') assert.deepEqual(header.tools.map(t => t.name).sort(), ['bash', 'str_replace_editor'])
  }
  const commands = await client.callArgs('commands/list', { agentId: session.sessionId })
  assert.equal(commands.some(command => command.name === 'compact'), session.preset !== 'minimal')
  if (expected === 'ArcCompactionEngine') {
    const status = await client.callArgs('commands/execute', { agentId: session.sessionId, line: '/context status', images: [] })
    assert.equal(status.result.kind, 'success')
    const compact = await client.callArgs('commands/execute', { agentId: session.sessionId, line: '/compact', images: [] })
    // Tiny history may have no net reduction; the native consumer still invokes ARC.
    assert.ok(compact?.result)
  }
  report.cases.push({ ...session, stage, backend, requests: headers.length, toolNames: headers[0].tools.map(t => t.name), compactAvailable: commands.some(c => c.name === 'compact'), end: result.end })
  console.log(JSON.stringify({ preset: session.preset, stage, backend }))
}
try {
  let client = await start()
  report.presetsBefore = await hashes()
  // Switch a blank live Agent to a previously unmounted preset. No new agent/created.
  const switched = await create(client, 'minimal')
  await client.callArgs('agentPresets/select', { agentId: switched.sessionId, agentPreset: 'custom-switched' })
  switched.preset = 'custom-switched'
  const immediate = await client.callArgs('commands/execute', { agentId: switched.sessionId, line: '/context status', images: [] })
  assert.equal(immediate?.result.kind, 'success', 'native context command works immediately after preset selection')
  report.immediateCommandAfterSwitch = { sessionId: switched.sessionId, command: '/context status', kind: immediate.result.kind }
  await verify(client, switched, 'switched-before-first-request', 'ArcCompactionEngine')
  const sessions = await Promise.all([...official, 'custom-renamed', 'custom-nested'].map(id => create(client, id)))
  const outcomes = await Promise.allSettled(sessions.map(session => verify(client, session, 'concurrent-first-request', session.preset === 'minimal' ? null : 'ArcCompactionEngine')))
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
  await custom(late, renamed)
  report.presetsBefore = { ...report.presetsBefore, [join(customRoot, late, 'agent.cordis.yml')]: hash(renamed) }
  const lateSession = await create(client, late)
  await verify(client, lateSession, 'added-after-startup', 'ArcCompactionEngine')
  sessions.push(switched, lateSession)
  await stop(); client = await start()
  for (const session of sessions) await verify(client, session, 'restart', session.preset === 'minimal' ? null : 'ArcCompactionEngine')
  await stop()
  const output = execFileSync('dsh', ['plugin', '--profile', profile, 'remove', 'dsh-context-management'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  await writeFile(join(root, 'remove.log'), output)
  client = await start()
  for (const session of sessions) await verify(client, session, 'uninstalled', session.preset === 'minimal' ? null : 'BasicCompactionEngine')
  report.presetsAfter = await hashes(); assert.deepEqual(report.presetsAfter, report.presetsBefore)
  report.completed = true
} catch (error) { report.failures.push(error.message); process.exitCode = 1 }
finally {
  await stop(); report.finishedAt = new Date().toISOString()
  const directory = 'docs/evidence/v011/live'; await mkdir(directory, { recursive: true })
  await writeFile(`${directory}/preset-coverage-${installation.tarballHash.slice(0, 12)}.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ completed: report.completed, cases: report.cases.length, failures: report.failures }))
}
