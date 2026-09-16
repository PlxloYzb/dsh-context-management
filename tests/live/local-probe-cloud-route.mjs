// Preflight for using a cloud provider as an out-of-band summariser next to the
// local serial model. Starts the pinned host, selects one route, asks for a
// bounded summary of a synthetic prefix, and reports wall latency plus whether
// the turn completed. Never prints credentials.
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startHost } from './local/runtime.mjs'
import { requestRecords } from './local/request-client.mjs'

const night = resolve('.test-runtime/nightly-20260915')
const out = join(night, 'cloud-route-preflight')
await mkdir(out, { recursive: true })
const patch = join(out, 'host.patch.yml')
await writeFile(patch, '[]\n', { mode: 0o600 })

const route = process.argv[2] === 'cloud'
  ? { provider: 'opencode-go-muse', model: 'muse-spark-1.3-contributor' }
  : { provider: 'ubuntu-lora', model: 'Qwen3.8-27B-NVFP4KV-384K' }
// ~10k tokens of synthetic transcript to summarise, close to the real load.
const body = Array.from({ length: 90 }, (_, i) => `Observation ${i}: service=svc${i}; state=ready; checksum=${(i * 2654435761 % 4294967296).toString(16).padStart(8, '0')}; note=${'context '.repeat(12)}`).join('\n')
const prompt = `Summarise the following archived transcript for a context handoff. Keep goals, constraints, verified facts (id -> value) and next actions. Be dense and literal. Return at most 900 characters.\n\n${body}`

const spec = { dshBin: resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh'), root: out, directory: out, observed: out, controlRoot: out, profile: 'ctx-v012-mini-native', patch, port: 3322, route }
const host = await startHost(spec, `cloud-probe-${Date.now()}`)
let result = { route, ok: false }
try {
  const created = await host.client.call('session/create', { cwd: out, agentPreset: 'standard' })
  const sessionId = created.sessionId
  await host.client.call('session/selectModel', { sessionId, ...route })
  const started = Date.now()
  await host.client.call('session/prompt', { sessionId, requestId: `probe-${Date.now()}`, mode: 'queue', content: [{ type: 'text', text: prompt }] })
  let events = []
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000))
    try { events = JSON.parse(await import('node:fs').then(m => m.promises.readFile(join(out, `${sessionId}.events.json`), 'utf8'))) } catch { continue }
    if (events.some(e => e.type === 'turn/end')) break
  }
  const elapsedMs = Date.now() - started
  const end = events.find(e => e.type === 'turn/end')
  const answer = events.filter(e => e.type === 'assistant/message').flatMap(e => e.data?.message?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('').trim()
  let records = []
  try { records = await requestRecords(join(out, 'requests.jsonl')) } catch { /* observer absent */ }
  result = {
    route, ok: end?.data?.reason?.kind === 'completed', elapsedMs,
    endReason: end?.data?.reason ?? null,
    answerChars: answer.length, answerHead: answer.slice(0, 160),
    requests: records.length,
  }
} catch (error) {
  result = { route, ok: false, error: String(error.message ?? error) }
} finally {
  await host.stop().catch(() => {})
}
console.log(JSON.stringify(result))
