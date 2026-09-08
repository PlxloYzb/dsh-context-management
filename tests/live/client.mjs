import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export async function webClient(logPath, port) {
  const readyDeadline = Date.now() + 30000
  let match
  do {
    const log = await readFile(logPath, 'utf8').catch(() => '')
    match = log.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/[^\\s\\u001b]+`))
    if (!match) await new Promise(resolve => setTimeout(resolve,250))
  } while (!match && Date.now() < readyDeadline)
  if (!match) throw new Error('loopback Web launch URL unavailable')
  const launch = new URL(match[0]), base = launch.origin
  const auth = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  const cookie = auth.headers.getSetCookie().map(s => s.split(';')[0]).join('; ')
  if (!cookie) throw new Error('Web authentication exchange failed')
  let rpc = 0
  async function callArgs(method, args) {
    const res = await fetch(`${base}/api/${method}`, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: base },
      body: JSON.stringify({ type: 'client-request', rpcId: `context-test-${++rpc}`, method,
        payload: { args } }),
      signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
    const body = await res.json()
    if (!body.result?.ok) throw new Error(`${method}: ${body.result?.error?.code ?? 'remote-error'} ${body.result?.error?.message ?? ''}`)
    return body.result.value
  }
  const call = (method, request) => callArgs(method, { [method === 'session/list' ? '_request' : 'request']: request })
  async function history(sessionId) {
    const list = await call('session/list', {})
    const row = list.items.find(r => r.sessionId === sessionId)
    if (!Number.isSafeInteger(row?.projections?.asOfSeq)) throw new Error('Session history cursor unavailable')
    const events = new Map()
    let beforeSeq
    for (let pageIndex = 0; pageIndex < 1000; pageIndex++) {
      const page = await call('session/page', { address: { kind: 'session', sessionId }, throughSeq: row.projections.asOfSeq, maxMessages: 1000, ...(beforeSeq === undefined ? {} : { beforeSeq }) })
      for (const record of page.records) if (record.type === 'event') events.set(record.event.seq, record.event)
      if (!page.hasMore) return [...events.values()].sort((a, b) => a.seq - b.seq)
      const minimum = Math.min(...events.keys())
      if (minimum === beforeSeq || !Number.isFinite(minimum)) throw new Error('History pagination made no progress')
      beforeSeq = minimum
    }
    throw new Error('History pagination limit exceeded')
  }
  async function prompt(sessionId, text, timeout = 240000) {
    const previous = await history(sessionId), through = previous.at(-1)?.seq ?? -1
    const start = Date.now()
    await call('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] })
    while (Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, 1500))
      const events = await history(sessionId)
      const recent = events.filter(e => e.seq > through)
      const end = recent.find(e => e.type === 'turn/end')
      if (end) return { events, recent, elapsedMs: Date.now() - start, end: end.data.reason }
    }
    try { await call('session/cancel', { sessionId }) } catch { /* retain timeout as primary failure */ }
    throw new Error('model turn timeout (240 seconds)')
  }
  return { call, callArgs, history, prompt }
}

export function responseText(events) {
  return events.filter(e => e.type === 'assistant/message').flatMap(e => e.data.message.content.filter(b => b.type === 'text').map(b => b.text)).join('\n')
}
