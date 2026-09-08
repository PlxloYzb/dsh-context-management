// Own all processes for one isolated three-arm cohort, including a real restart.
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { webClient } from './client.mjs'
const version = JSON.parse(await readFile('package.json', 'utf8')).version
const root = '.test-runtime/reports'
if (process.argv.includes('--help')) {
  console.log('Usage: node tests/live/gates.mjs [run-name] [existing-basic-manifest]')
  process.exit(0)
}
const suffix = process.argv[2] ?? String(Date.now())
if (!/^[a-z0-9-]+$/.test(suffix)) throw new Error('Invalid cohort suffix')
const children = new Set()
process.on('SIGTERM', () => { for (const child of children) child.kill('SIGTERM'); process.exit(143) })
async function run(file, args, log) {
  const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child)
  child.stdout.on('data', data => appendFileSync(log, data)); child.stderr.on('data', data => appendFileSync(log, data))
  const code = await new Promise(resolve => child.once('exit', resolve)); children.delete(child); return code
}
async function arm(name, profile, port, patch, observer) {
  const log = resolve(`.test-runtime/v011-web-${name}-${suffix}.log`)
  const manifest = `${root}/live/cohort-${name}-${suffix}.json`
  const stageLog = resolve(`.test-runtime/v011-cohort-${name}-${suffix}.log`)
  const args = ['--profile', profile, ...(patch ? ['--patch', patch] : []), '--patch', observer, '--host', '127.0.0.1', '--no-open', '--port', String(port)]
  let server
  async function start() {
    await writeFile(log, '')
    server = spawn('dsh', args, { stdio: ['ignore', 'pipe', 'pipe'] }); children.add(server)
    server.stdout.on('data', data => appendFileSync(log, data)); server.stderr.on('data', data => appendFileSync(log, data))
    await webClient(log, port)
  }
  async function stop() {
    if (!server || server.exitCode !== null) return
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited; children.delete(server)
  }
  const report = { arm: name, profile, port, manifest, stages: [], failures: [] }
  try {
    await start(); console.log(JSON.stringify({ arm: name, phase: 'initial', port }))
    const records = name === 'A' ? [] : await Promise.all((await readdir(`${root}/install`)).filter(file => file.startsWith(`${profile}-`)).map(async file => ({ file, report: JSON.parse(await readFile(`${root}/install/${file}`, 'utf8')) })))
    records.sort((a, b) => b.report.installedAt.localeCompare(a.report.installedAt))
    const installation = records[0] ? `${root}/install/${records[0].file}` : undefined
    report.stages.push({ stage: 'initial', code: await run('tests/live/cohort.mjs', [`--arm=${name}`, `--port=${port}`, `--log=${log}`, `--output=${manifest}`, '--concurrency=3', ...(installation ? [`--installEvidence=${installation}`] : [])], stageLog) })
    await stop(); await start(); console.log(JSON.stringify({ arm: name, phase: 'restart' }))
    report.stages.push({ stage: 'restart', code: await run('tests/live/resume-cohort.mjs', [`--manifest=${manifest}`, `--port=${port}`, `--log=${log}`], stageLog) })
    report.stages.push({ stage: 'sources', code: await run('tests/live/verify-cohort.mjs', [manifest], stageLog) })
  } catch (error) { report.failures.push(error.message) }
  finally { await stop(); await writeFile(`${root}/live/driver-${name}-${suffix}.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report)) }
  return manifest
}
await mkdir(`${root}/live`, { recursive: true })
// Create all fixture profiles and overlays explicitly; no old development files are required.
const profileNames = Object.fromEntries(['A', 'B', 'C'].map(arm => [arm, `ctx-v011-${arm.toLowerCase()}-${suffix}`]))
for (const name of ['A', 'B', 'C']) {
  if (name === 'A' && process.argv[3]) continue
  const profileRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profileNames[name])
  await mkdir(profileRoot, { recursive: false })
  await writeFile(join(profileRoot, 'package.json'), JSON.stringify({ name: `dsh-profile-${profileNames[name]}`, private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } } }))
  if (name !== 'A') {
    const code = await run('tests/live/install-candidate.mjs', [profileNames[name]], resolve(`.test-runtime/install-${name}-${suffix}.log`))
    if (code !== 0) throw new Error(`Candidate installation failed for arm ${name}`)
  }
  await writeFile(`.test-runtime/observer-${name}.patch.yml`, `- insert:\n    - id: model-observer\n      name: ${JSON.stringify(resolve('tests/live/model-observer.mjs'))}\n      config:\n        output: ${JSON.stringify(resolve('.test-runtime/observed'))}\n        arm: ${name}\n`)
  if (name !== 'A') await writeFile(`.test-runtime/installed-${name}.patch.yml`, `- id: compaction-context-management-bridge\n  config:\n    adaptiveGovernor:\n      enabled: true\n      strategy: ${name === 'B' ? 'in-place' : 'windowed'}\n      windowBudgetTokens: 32768\n      maxOutputTokens: 8192\n      safetyMarginTokens: 4096\n`)
}
const manifests = await Promise.all([
  process.argv[3] ?? arm('A', profileNames.A, 3117, null, '.test-runtime/observer-A.patch.yml'),
  arm('B', profileNames.B, 3118, '.test-runtime/installed-B.patch.yml', '.test-runtime/observer-B.patch.yml'),
  arm('C', profileNames.C, 3119, '.test-runtime/installed-C.patch.yml', '.test-runtime/observer-C.patch.yml'),
])
process.exitCode = await run('tests/release/summarize.mjs', manifests, resolve(`.test-runtime/v011-gate-summary-${suffix}.log`))
