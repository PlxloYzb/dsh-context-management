// Exercise the documented package-name commands against the candidate package.
// A loopback registry serves only this unpublished package. Other packages use npm.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { webClient } from '../live/client.mjs'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const temporary = await mkdtemp(join(tmpdir(), 'dsh-package-name-'))
const dshHome = join(temporary, 'dsh'), profile = join(dshHome, 'profiles', 'web')
const reportRoot = resolve('.test-runtime/reports/release')
await mkdir(profile, { recursive: true }); await mkdir(reportRoot, { recursive: true })
await writeFile(join(temporary, 'npmrc'), '')
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } } }))
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|AUTH/i.test(key)))
Object.assign(environment, { DSH_HOME: dshHome, npm_config_userconfig: join(temporary, 'npmrc'), npm_config_cache: join(temporary, 'npm-cache') })
const report = { pluginVersion: pkg.version, hostVersion: '0.1.2-rc.1', startedAt: new Date().toISOString(),
  registry: 'isolated loopback candidate registry; public npm publication not performed', commands: [], completed: false, failures: [] }
let registry, web
async function run(binary, args, label, env = environment) {
  const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  await writeFile(join(temporary, `${label}.log`), output)
  assert.equal(exit, 0, `${label} failed; exit ${exit}`)
  return output
}
async function stopWeb() {
  if (!web || web.exitCode !== null) return
  const stopped = new Promise(resolve => web.once('exit', resolve)); web.kill('SIGTERM'); await stopped
}
async function startWeb() {
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve))
  const log = join(temporary, 'web.log'); await writeFile(log, '')
  web = spawn('dsh', ['--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  web.stdout.on('data', data => appendFileSync(log, data)); web.stderr.on('data', data => appendFileSync(log, data))
  return webClient(log, port)
}
async function session(client) {
  const cwd = join(temporary, `dsh-context-corpus-install-${Date.now()}`); await mkdir(cwd)
  return (await client.call('session/create', { cwd, agentPreset: 'standard' })).sessionId
}
try {
  console.log('Packing and checking the candidate…')
  const packOutput = await run('npm', ['pack', '--pack-destination', temporary], 'pack', process.env)
  report.tests = [...packOutput.matchAll(/^# tests (\d+)$/gm)].map(match => Number(match[1]))
  report.prepackPassed = true
  const tarball = await readFile(join(temporary, `${pkg.name}-${pkg.version}.tgz`))
  report.tarballHash = createHash('sha256').update(tarball).digest('hex')
  let candidateRequests = 0
  registry = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    if (path === `/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(tarball)
    } else if (path === `/${pkg.name}`) {
      candidateRequests++
      const origin = `http://127.0.0.1:${registry.address().port}`
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ name: pkg.name, 'dist-tags': { latest: pkg.version }, versions: { [pkg.version]: {
        ...pkg, dist: { tarball: `${origin}/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`,
          shasum: createHash('sha1').update(tarball).digest('hex'), integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}` },
      } } }))
    } else {
      response.writeHead(302, { location: `https://registry.npmjs.org${request.url}` }); response.end()
    }
  })
  await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve))
  environment.npm_config_registry = `http://127.0.0.1:${registry.address().port}`
  environment.NPM_CONFIG_REGISTRY = environment.npm_config_registry
  environment.PNPM_CONFIG_REGISTRY = environment.npm_config_registry
  environment.PNPM_CONFIG_STORE_DIR = join(temporary, 'pnpm-store')
  console.log('Testing dsh plugin --profile web add dsh-context-management')
  await run('dsh', ['plugin', '--profile', 'web', 'add', 'dsh-context-management'], 'add')
  report.commands.push('dsh plugin --profile web add dsh-context-management')
  const installed = JSON.parse(await readFile(join(profile, 'node_modules', pkg.name, 'package.json'), 'utf8'))
  assert.equal(installed.version, pkg.version); assert.ok(candidateRequests > 0)
  const enabled = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.ok(enabled.dsh.profile.bundles.includes(pkg.name)); assert.ok(!enabled.dependencies[pkg.name].startsWith('file:'))
  for (const path of ['dist/index.js', 'dist/bridge.js', 'cordis.patch.yml']) {
    assert.deepEqual(await readFile(join(profile, 'node_modules', pkg.name, path)), await readFile(path))
  }
  let client = await startWeb(), id = await session(client)
  let commands
  for (let attempt = 0; attempt < 100; attempt++) {
    commands = await client.callArgs('commands/list', { agentId: id })
    if (commands.some(command => command.name === 'context')) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(commands.some(command => command.name === 'context'))
  assert.ok(commands.some(command => command.name === 'compact'))
  const status = await client.callArgs('commands/execute', { agentId: id, line: '/context status', images: [] })
  assert.equal(status.result.kind, 'success')
  assert.equal(JSON.parse(status.result.text).version, pkg.version)
  report.installed = { resolvedVersion: installed.version, bundleEnabled: true, nativeContextCommand: true, nativeCompactAvailable: true }
  await stopWeb()
  console.log('Testing dsh plugin --profile web remove dsh-context-management')
  await run('dsh', ['plugin', '--profile', 'web', 'remove', 'dsh-context-management'], 'remove')
  report.commands.push('dsh plugin --profile web remove dsh-context-management')
  const removed = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.equal(removed.dependencies?.[pkg.name], undefined); assert.ok(!removed.dsh.profile.bundles.includes(pkg.name))
  client = await startWeb(); id = await session(client)
  commands = await client.callArgs('commands/list', { agentId: id })
  assert.ok(!commands.some(command => command.name === 'context')); assert.ok(commands.some(command => command.name === 'compact'))
  const compact = await client.callArgs('commands/execute', { agentId: id, line: '/compact', images: [] })
  assert.equal(compact.result.kind, 'success')
  report.removed = { dependencyRemoved: true, bundleRemoved: true, nativeCompactRestored: true }
  await mkdir('artifacts', { recursive: true })
  await copyFile(join(temporary, `${pkg.name}-${pkg.version}.tgz`), `artifacts/${pkg.name}-${pkg.version}.tgz`)
  report.completed = true
} catch (error) { report.failures.push(error.message); process.exitCode = 1 }
finally {
  await stopWeb()
  if (registry) { registry.closeAllConnections(); await new Promise(resolve => registry.close(resolve)) }
  report.finishedAt = new Date().toISOString()
  await writeFile(join(reportRoot, 'package-name.json'), JSON.stringify(report, null, 2) + '\n')
  if (report.completed) await rm(temporary, { recursive: true, force: true })
  else console.log(`Failure logs retained at ${temporary}`)
  console.log(JSON.stringify(report))
}
