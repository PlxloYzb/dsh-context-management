// Real CLI package lifecycle check. It deliberately creates no model request.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { webClient } from '../live/client.mjs'

const runName = process.argv[2] ?? 'lifecycle'
if (!/^[a-z0-9][a-z0-9-]*$/.test(runName)) throw new Error('run name must contain only lowercase letters, digits, and hyphens')
const root = resolve('.test-runtime/reliability-20260915', runName)
const home = join(root, 'home')
const profile = 'ctx-v012-reliability-lifecycle'
const other = 'ctx-v012-reliability-other'
const dsh = resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh')
const tarball = resolve('artifacts/dsh-context-management-0.1.1.tgz')
const presets = resolve(dirname(dirname(dsh)), '@deepseek-ai/dsh-agent-preset-registry/presets')
const env = { ...process.env, DSH_HOME: home, COREPACK_ENABLE_AUTO_PIN: '0', npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'npmrc') }
const sha = text => createHash('sha256').update(text).digest('hex')
const report = { startedAt: new Date().toISOString(), runName, dsh, dshHome: home, profile, otherProfile: other, port: 3336, tarballSha256: sha(await readFile(tarball)), stages: [], failures: [], completed: false }

async function run(args, label) {
  const child = spawn(dsh, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''; child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { out += d })
  let timedOut = false
  const code = await new Promise((ok, bad) => {
    const term = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 30000)
    const kill = setTimeout(() => child.kill('SIGKILL'), 35000)
    child.once('exit', code => { clearTimeout(term); clearTimeout(kill); ok(code) }); child.once('error', bad)
  })
  await writeFile(join(root, `${label}.log`), out)
  assert.ok(!timedOut, `${label} timed out after 30 seconds`)
  assert.equal(code, 0, `${label} exited ${code}: ${out}`)
  return out
}
async function hashes() { return Object.fromEntries(await Promise.all(['standard', 'minimal', 'ptc', 'cordis'].map(async id => [id, sha(await readFile(join(presets, id, 'agent.cordis.yml')))]))) }
async function manifest(name) { return JSON.parse(await readFile(join(home, 'profiles', name, 'package.json'), 'utf8')) }
async function dump(name, label) { return run(['--profile', name, '--dump-config'], label) }
let web
async function stop() {
  if (!web || web.exitCode !== null) return
  await new Promise(ok => {
    const kill = setTimeout(() => web.kill('SIGKILL'), 5000)
    web.once('exit', () => { clearTimeout(kill); ok() }); web.kill('SIGTERM')
  })
}
async function backend(name, label, expectedBackend, agentPreset = 'standard') {
  const log = join(root, `${label}-web.log`); await writeFile(log, '')
  const observed = join(root, `${label}-backend.json`)
  await writeFile(join(root, 'observer.yml'), `- insert:\n    - id: lifecycle-backend-observer\n      name: ${JSON.stringify(join(root, 'observer.mjs'))}\n      config:\n        output: ${JSON.stringify(observed)}\n        requests: ${JSON.stringify(join(root, 'model-requests.jsonl'))}\n`)
  web = spawn(dsh, ['--profile', name, '--patch', join(root, 'observer.yml'), '--host', '127.0.0.1', '--port', '3336', '--no-open'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  web.stdout.on('data', d => { void writeFile(log, d, { flag: 'a' }) }); web.stderr.on('data', d => { void writeFile(log, d, { flag: 'a' }) })
  const client = await webClient(log, 3336)
  const cwd = join(root, `synthetic-${label}`); await mkdir(cwd, { recursive: true })
  const id = (await client.call('session/create', { cwd, agentPreset })).sessionId
  for (let i = 0; i < 100; i++) {
    const commands = await client.callArgs('commands/list', { agentId: id })
    const observation = await readFile(observed, 'utf8').then(JSON.parse).catch(() => null)
    if (observation?.backend === expectedBackend) { await stop(); return { commands: commands.map(x => x.name), backend: observation.backend } }
    await new Promise(ok => setTimeout(ok, 30))
  }
  await stop(); throw new Error(`${label}: command catalog did not settle`)
}
try {
  await mkdir(dirname(root), { recursive: true }); await mkdir(root, { recursive: false }); await mkdir(home, { recursive: true }); await writeFile(join(root, 'npmrc'), '')
  // Custom profiles must name their app surface.  This is the host's documented
  // profile manifest shape, and keeps the Web probe inside the isolated home.
  for (const name of [profile, other]) {
    const dir = join(home, 'profiles', name); await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } } }, null, 2))
  }
  await writeFile(join(root, 'observer.mjs'), "import { appendFileSync, writeFileSync } from 'node:fs'\nexport const inject = ['agentPresets']\nexport function apply(ctx, config) { const record = type => appendFileSync(config.requests, JSON.stringify({ type, at: new Date().toISOString() }) + '\\n'); ctx.on('llm/stream', (_options, next) => { record('llm/stream'); return next() }, { global: true, prepend: true }); ctx.on('agent/request', async (_payload, next) => { record('agent/request'); return next() }); ctx.on('agent/created', ({ agent }) => { void (async () => { for (let i = 0; i < 100; i++) { await new Promise(ok => setTimeout(ok, 20)); const backend = ctx.agentPresets.serviceFor(agent, 'compaction'); if (backend) { writeFileSync(config.output, JSON.stringify({ backend: backend.constructor.name }) + '\\n'); return } } })() }) }\n")
  report.presetsBefore = await hashes()
  await run(['plugin', '--profile', other, 'add', tarball], 'other-add')
  const otherBefore = sha(await readFile(join(home, 'profiles', other, 'package.json')))
  await run(['plugin', '--profile', profile, 'add', tarball], 'add')
  let target = await manifest(profile)
  assert.ok(target.dsh.profile.bundles.includes('dsh-context-management'))
  report.stages.push({ stage: 'installed', bundleEnabled: true })
  const installedDump = await dump(profile, 'installed-dump')
  assert.match(installedDump, /dsh-context-management\/bridge/)
  const installed = await backend(profile, 'installed', 'ArcCompactionEngine')
  assert.ok(installed.commands.includes('context'), 'installed package must expose /context')
  assert.ok(installed.commands.includes('compact'), 'native compact command must remain available')
  report.stages.push({ stage: 'installed-web', contextCommand: true, compactCommand: true, bridgeLoaded: true, backend: installed.backend })
  const fixture = join(root, 'third-party-backend'); await mkdir(fixture, { recursive: true })
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'third-party-compaction-backend', version: '1.0.0', type: 'module', main: 'index.js', dependencies: { '@deepseek-ai/dsh-compaction-basic': '0.1.2-rc.1' } }, null, 2))
  await writeFile(join(fixture, 'index.js'), "export { default } from '@deepseek-ai/dsh-compaction-basic'\n")
  const thirdPreset = join(home, '.agent-presets', 'third-party'); await mkdir(thirdPreset, { recursive: true })
  await writeFile(join(thirdPreset, 'agent.cordis.yml'), (await readFile(join(presets, 'standard', 'agent.cordis.yml'), 'utf8')).replace("name: '@deepseek-ai/dsh-compaction-basic'", 'name: third-party-compaction-backend'))
  await run(['plugin', '--profile', profile, 'add', fixture], 'third-party-add')
  assert.ok(!(await manifest(profile)).dsh.profile.bundles.includes('third-party-compaction-backend'), 'plain third-party backend must not become a bundle')
  const thirdParty = await backend(profile, 'third-party', 'BasicCompactionEngine', 'third-party')
  report.stages.push({ stage: 'third-party-preset', backend: thirdParty.backend, unaffected: true })
  await run(['plugin', '--profile', profile, 'remove', 'dsh-context-management'], 'remove')
  target = await manifest(profile)
  assert.equal(target.dependencies?.['dsh-context-management'], undefined)
  assert.ok(!target.dsh.profile.bundles.includes('dsh-context-management'))
  const removedDump = await dump(profile, 'removed-dump')
  assert.doesNotMatch(removedDump, /dsh-context-management\/bridge/)
  const removed = await backend(profile, 'removed', 'BasicCompactionEngine')
  assert.ok(!removed.commands.includes('context'), 'uninstall must remove /context')
  assert.ok(removed.commands.includes('compact'), 'uninstall must restore native /compact')
  report.stages.push({ stage: 'removed-web', contextCommand: false, compactCommand: true, bridgeAbsent: true, nativeBasicRestoredByCleanRestart: true, backend: removed.backend })
  await run(['plugin', '--profile', profile, 'add', tarball], 'readd')
  target = await manifest(profile); assert.ok(target.dsh.profile.bundles.includes('dsh-context-management'))
  const reinstalledDump = await dump(profile, 'reinstalled-dump'); assert.match(reinstalledDump, /dsh-context-management\/bridge/)
  const reinstalled = await backend(profile, 'reinstalled', 'ArcCompactionEngine')
  assert.ok(reinstalled.commands.includes('context'), 'reinstall must restore /context')
  assert.equal(sha(await readFile(join(home, 'profiles', other, 'package.json'))), otherBefore, 'target lifecycle changed another profile')
  report.presetsAfter = await hashes(); assert.deepEqual(report.presetsAfter, report.presetsBefore, 'shipped preset files changed')
  // Minimal is shipped without compaction, and the bridge is activated only after agent mounting;
  // the unmodified minimal composition remains byte-identical in the host installation.
  const minimal = await readFile(join(presets, 'minimal', 'agent.cordis.yml'), 'utf8')
  assert.doesNotMatch(minimal, /dsh-compaction-basic/)
  const modelRequestCount = (await readFile(join(root, 'model-requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(event => event.type === 'llm/stream').length
  assert.equal(modelRequestCount, 0, 'lifecycle probe must not send model requests')
  report.modelRequestCount = modelRequestCount
  report.stages.push({ stage: 'reinstalled', bundleEnabled: true, backend: reinstalled.backend, otherProfileUnchanged: true, presetsUnchanged: true, noCompactionPresetUnchanged: true, thirdPartyBackendUnchanged: true })
  report.completed = true
} catch (error) { report.failures.push(error.stack ?? String(error)); process.exitCode = 1 }
finally {
  await stop()
  report.modelRequestCount = (await readFile(join(root, 'model-requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(event => event.type === 'llm/stream').length
  report.finishedAt = new Date().toISOString()
  await mkdir(root, { recursive: true }); await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ completed: report.completed, modelRequestCount: report.modelRequestCount, stages: report.stages, failures: report.failures }))
}
