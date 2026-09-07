// DSH 0.1.2-rc.1 Web transport smoke. Uses the existing host model credentials.
// Never prints/persists the launch URL, authentication cookie, or raw headers.
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const launch = new URL(process.env.DSH_WEB_LAUNCH_URL ?? '')
if (launch.hostname !== '127.0.0.1' && launch.hostname !== 'localhost') throw new Error('A loopback Web URL is required')
const out = resolve(process.env.DSH_SMOKE_OUTPUT ?? `docs/evidence/web-smoke-${Date.now()}.json`)
const report = { startedAt: new Date().toISOString(), scope: 'host-web-model-smoke-only', pluginInstalled: false, baseUrl: launch.origin, requestedRoute: { provider: 'opencode-go', model: 'glm-5.3-flash' }, checks: {}, limitations: ['No candidate plugin exists; this is not plugin acceptance or a compaction quality benchmark.'] }
let cookie
let rpc = 0
async function call(method, payload) {
  method = method.replace('.', '/')
  const response = await fetch(`${launch.origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: launch.origin },
    body: JSON.stringify({ type: 'client-request', rpcId: `docs-${++rpc}`, method, payload: { args: { [method === 'session/list' ? '_request' : 'request']: payload } } }),
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
  const body = await response.json()
  if (body.result?.ok !== true) throw new Error(`${method}: remote call failed (${body.result?.error?.code ?? 'unknown'}): ${body.result?.error?.message ?? ''}`)
  return body.result.value
}
try {
  const auth = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  cookie = auth.headers.getSetCookie().map(x => x.split(';')[0]).join('; ')
  if (!cookie) throw new Error('Launch-token exchange did not return a browser cookie')
  report.checks.authenticationExchange = auth.status
  const ui = await fetch(launch.origin, { headers: { cookie }, signal: AbortSignal.timeout(10000) })
  report.checks.webRoot = { status: ui.status, html: (await ui.text()).includes('<html') }
  const created = process.env.DSH_SMOKE_SESSION_ID ? { sessionId: process.env.DSH_SMOKE_SESSION_ID, agentPreset: 'standard' } : await call('session.create', { cwd: process.cwd(), agentPreset: 'standard' })
  report.sessionId = created.sessionId
  report.agentPreset = created.agentPreset
  report.selected = await call('session.selectModel', { sessionId: created.sessionId, ...report.requestedRoute })
  report.prompt = 'This is a transport smoke test. Do not use tools or modify files. Reply with exactly DSH-CONTEXT-MANAGEMENT-SMOKE-OK.'
  if (!process.env.DSH_SMOKE_SESSION_ID) await call('session.prompt', { requestId: randomUUID(), sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: report.prompt }] })
  const deadline = Date.now() + 180000
  let history
  let completed = false
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000))
    const list = await call('session.list', {})
    const row = list.items.find(r => r.sessionId === created.sessionId)
    const throughSeq = row?.projections?.asOfSeq
    if (!Number.isSafeInteger(throughSeq)) throw new Error(`Missing projection cursor; row keys: ${Object.keys(row ?? {}).join(',')}`)
    history = await call('session.page', { address: { kind: 'session', sessionId: created.sessionId }, throughSeq, maxMessages: 1000 })
    const events = history.records.filter(e => e.type === 'event').map(e => e.event)
    if (events.some(e => e.type === 'turn/end')) { completed = true; break }
  }
  if (!completed) throw new Error('No turn/end within 180 seconds')
  const events = history.records.filter(e => e.type === 'event').map(e => e.event)
  if (history.hasMore) throw new Error('Smoke history exceeded one page; refusing an incomplete verdict')
  report.eventTypes = [...new Set(events.map(e => e.type))]
  report.requests = events.filter(e => e.type === 'request/header').map(e => ({ seq: e.seq, provider: e.data.header?.config?.provider, model: e.data.header?.config?.model, maxTokens: e.data.header?.config?.maxTokens }))
  report.requestContexts = events.filter(e => e.type === 'request/context').map(e => ({ seq: e.seq, provider: e.data.provider, model: e.data.model, contextWindow: e.data.contextWindow }))
  report.responses = events.filter(e => e.type === 'assistant/message').map(e => ({ seq: e.seq, usage: e.data.usage, text: (e.data.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n') }))
  report.turnEnds = events.filter(e => e.type === 'turn/end').map(e => ({ seq: e.seq, data: e.data }))
  report.checks.reply = report.responses.some(r => r.text.trim() === 'DSH-CONTEXT-MANAGEMENT-SMOKE-OK')
  report.checks.requestRoute = report.requests.length > 0 && report.requests.every(r => r.provider === report.requestedRoute.provider && r.model === report.requestedRoute.model)
  report.passed = report.checks.reply && report.checks.requestRoute && ui.ok
  if (!report.passed) process.exitCode = 1
} catch (error) {
  report.passed = false
  report.error = error.message
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await mkdir(resolve(out, '..'), { recursive: true })
  await writeFile(out, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
