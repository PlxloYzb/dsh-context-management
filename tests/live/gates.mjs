// Own all processes for one isolated three-arm cohort, including a real restart.
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { webClient } from './client.mjs'
const version = JSON.parse(await readFile('package.json', 'utf8')).version
const root = `docs/evidence/v${version.replaceAll('.', '')}`
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
const manifests = await Promise.all([
  process.argv[3] ?? arm('A', 'ctx-v011-basic', 3117, null, '.test-runtime/observer-A.patch.yml'),
  arm('B', 'ctx-v011-inplace', 3118, '.test-runtime/installed-B.patch.yml', '.test-runtime/observer-B.patch.yml'),
  arm('C', 'ctx-v011-test', 3119, '.test-runtime/installed.patch.yml', '.test-runtime/observer.patch.yml'),
])
process.exitCode = await run('tests/release/summarize.mjs', manifests, resolve(`.test-runtime/v011-gate-summary-${suffix}.log`))
