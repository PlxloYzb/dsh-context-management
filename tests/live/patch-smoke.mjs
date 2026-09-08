// Isolated installed-package failure diagnostics over the real Web API.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdir, writeFile, readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { webClient } from './client.mjs'
const installation = JSON.parse(await readFile(process.argv[2], 'utf8'))
assert.equal(installation.profile, 'ctx-v011-diagnostics')
const root = 'docs/evidence/v011/live', port = 3122, profile = installation.profile
const patch = resolve('.test-runtime/v011-diagnostics.patch.yml'), log = resolve('.test-runtime/v011-web-diagnostics.log')
const report = { pluginVersion: installation.pluginVersion, tarballHash: installation.tarballHash, hostVersion: '0.1.2-rc.1', startedAt: new Date().toISOString(), checks: [], completed: false, failures: [] }
let server
async function stop() { if (!server || server.exitCode !== null) return; const exit = new Promise(r => server.once('exit', r)); server.kill('SIGTERM'); await exit }
async function start(config, injectRollback = false) {
  await writeFile(patch, `- id: compaction-context-management-bridge\n  config: ${JSON.stringify(config)}\n`)
  const failurePatch = resolve('.test-runtime/v011-rollback-fixture.patch.yml')
  await writeFile(failurePatch, `- insert:\n    - id: release-rollback-fixture\n      name: ${JSON.stringify(resolve('tests/live/rollback-observer.mjs'))}\n`)
  await writeFile(log, '')
  server = spawn('dsh', ['--profile', profile, ...(injectRollback ? ['--patch', failurePatch] : []), '--patch', patch, '--patch', '.test-runtime/observer.patch.yml', '--host', '127.0.0.1', '--port', String(port), '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', data => appendFileSync(log, data)); server.stderr.on('data', data => appendFileSync(log, data))
  return webClient(log, port)
}
async function create(client) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-context-corpus-diagnostic-'))
  const { sessionId } = await client.call('session/create', { cwd, agentPreset: 'standard' })
  await client.call('session/selectModel', { sessionId, provider: 'opencode-go', model: 'glm-5.3-flash' }); return sessionId
}
try {
  let startupError
  try { await start({ prompts: { systemPrompt: '{unknown_slot}' } }) } catch (error) { startupError = error }
  assert.ok(startupError)
  const startupLog = await readFile(log, 'utf8')
  assert.match(startupLog, /CONTEXT_INVALID_CONFIG/)
  assert.doesNotMatch(startupLog, /http:\/\/127\.0\.0\.1:3122\//)
  report.checks.push({ name: 'invalid-template-rejected-before-Web', code: 'CONTEXT_INVALID_CONFIG', serverExited: server.exitCode !== null })
  await stop()
  let client = await start({})
  for (let index = 0; index < 2; index++) {
    const sessionId = await create(client), result = await client.prompt(sessionId, 'This isolated diagnostics test asks for the single word READY. Do not call any tools.')
    assert.equal(result.end.kind, 'completed')
    const pressure = (await readFile(`.test-runtime/observed/${sessionId}.pressure.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(pressure.at(-1).backend, 'ArcCompactionEngine')
    report.checks.push({ name: `repaired-config-request-${index + 1}`, sessionId, end: result.end, backend: pressure.at(-1).backend })
  }
  await stop()
  client = await start({}, true)
  for (let index = 0; index < 2; index++) {
    const id = await create(client), result = await client.prompt(id, 'Isolated rollback check. Reply only READY; use no tools.')
    assert.equal(result.end.kind, 'completed')
    const pressure = (await readFile(`.test-runtime/observed/${id}.pressure.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(pressure.at(-1).backend, 'BasicCompactionEngine')
    report.checks.push({ name: `verified-rollback-request-${index + 1}`, sessionId: id, end: result.end, backend: pressure.at(-1).backend })
  }
  assert.match(await readFile(log, 'utf8'), /CONTEXT_TAKEOVER_FALLBACK/)
  await stop()
  client = await start({ prompts: { tools: { compress: 'X'.repeat(120000) } }, adaptiveGovernor: { windowBudgetTokens: 32768, maxOutputTokens: 8192 } })
  const sessionId = await create(client), result = await client.prompt(sessionId, 'Short diagnostic request')
  report.envelopeObserved = { sessionId, end: result.end }
  assert.equal(result.end.kind, 'error'); assert.equal(result.end.error.code, 'CONTEXT_ENVELOPE_TOO_LARGE')
  const events = JSON.parse(await readFile(`.test-runtime/observed/${sessionId}.events.json`, 'utf8'))
  assert.equal(events.filter(event => event.type === 'request/header').length, 0)
  report.checks.push({ name: 'oversized-envelope', sessionId, end: result.end, providerRequests: 0 })
  report.completed = true
} catch (error) { report.failures.push(error.message); process.exitCode = 1 }
finally { await stop(); report.finishedAt = new Date().toISOString(); await mkdir(root, { recursive: true }); await writeFile(`${root}/patch-smoke.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report)) }
