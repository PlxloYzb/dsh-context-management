// Normal Web turns through rc.1; no direct provider bypass or daily profile edits.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { startHost } from './local/runtime.mjs'
import { responseText } from './client.mjs'

const root = resolve('.test-runtime/turnover-muse-20260915', `preflight-${Date.now()}`)
await mkdir(root, { recursive: true })
const patch = join(root, 'host.patch.yml')
const settingsPath = join(homedir(), '.dsh/settings.yaml'), settingsBytes = await readFile(settingsPath)
const settingsHash = createHash('sha256').update(settingsBytes).digest('hex'), isolatedSettings = join(root, 'private-settings.yaml')
await writeFile(isolatedSettings, settingsBytes, { mode: 0o600 })
await writeFile(patch, JSON.stringify([{ id: 'settings', config: { path: isolatedSettings } }, { id: 'session-title-llm', disabled: true }, { insert: [{ id: 'turnover-observer', name: resolve('tests/live/turnover/observer.mjs'), config: { output: root, maxTokens: 2048 } }] }]), { mode: 0o600 })
const dshBin = resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh')
const version = JSON.parse(await readFile(resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/@deepseek-ai/dsh/package.json'))).version
if (version !== '0.1.2-rc.1') throw new Error('Host pin mismatch')
const host = await startHost({ dshBin, directory: root, profile: 'ctx-v012-mini-native', patch, port: 3323 }, 'preflight')
const rows = [], active = new Set()
const routes = { cloud: { provider: 'opencode-go-muse', model: 'muse-spark-1.3-contributor', reasoningEffort: 'minimal' }, local: { provider: 'ubuntu-lora', model: 'Qwen3.8-27B-NVFP4KV-384K' } }
async function run(name, route, text) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-context-experiment-turnover-'))
  const { sessionId } = await host.client.call('session/create', { cwd, agentPreset: 'standard' })
  active.add(sessionId)
  await host.client.call('session/selectModel', { sessionId, ...route })
  const start = Date.now()
  try {
    const result = await host.client.prompt(sessionId, text, 180000)
    const answer = responseText(result.recent)
    const row = { name, route, sessionId, start, end: Date.now(), elapsedMs: result.elapsedMs, completed: result.end.kind === 'completed', endKind: result.end.kind, answer, events: result.recent.length }
    rows.push(row); console.log(JSON.stringify({ ...row, answer: answer.slice(0, 200) }))
    return row
  } catch (error) { const row = { name, route, sessionId, completed: false, error: error.code ?? 'turn-failed', elapsedMs: Date.now() - start }; rows.push(row); console.log(JSON.stringify(row)); return row }
  finally { active.delete(sessionId) }
}
const stop = async () => { await Promise.allSettled([...active].map(sessionId => host.client.call('session/cancel', { sessionId }))); await host.stop() }
process.once('SIGTERM', () => { void stop() }); process.once('SIGINT', () => { void stop() })
try {
  const cloud = await run('cloud-smoke', routes.cloud, 'Synthetic connectivity test. Reply exactly MUSE_ROUTE_OK. Do not use tools.')
  if (!cloud.completed) throw new Error('Cloud rc.1 preflight failed')
  await run('local-smoke', routes.local, 'Synthetic connectivity test. Reply exactly LOCAL_ROUTE_OK. Do not use tools.')
  const prefix = Array.from({ length: 90 }, (_, i) => `Observation ${i}: svc${i} checksum=${(i * 2654435761 >>> 0).toString(16)}; ${'synthetic context '.repeat(12)}`).join('\n')
  for (let repeat = 0; repeat < 3; repeat++) {
    const pair = await Promise.all([
      run(`pair-${repeat}-cloud`, routes.cloud, `Summarize this synthetic archived transcript in at most 900 characters, preserving the checksums of svc17 and svc73. Do not use tools.\n${prefix}`),
      run(`pair-${repeat}-local`, routes.local, 'Synthetic foreground work. Produce a numbered list of 40 concise distinct checks for a toy in-memory cache implementation. Do not use tools.')
    ])
    if (pair.some(row => !row.completed)) break
  }
} catch (error) { console.log(JSON.stringify({ status: 'failed', code: error.code ?? 'preflight-failed' })) }
finally { await stop(); const settingsUnchanged = settingsHash === createHash('sha256').update(await readFile(settingsPath)).digest('hex'); await writeFile(join(root, 'result.json'), JSON.stringify({ hostVersion: version, settingsHash, settingsUnchanged, rows }, null, 2), { mode: 0o600 }); console.log(JSON.stringify({ output: root })); process.exitCode = rows.some(row => !row.completed) ? 1 : 0 }
