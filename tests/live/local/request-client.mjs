import { setTimeout as pause } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
export async function requestRecords(path) {
  const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const records = new Map()
  for (const line of text.split('\n').filter(Boolean)) {
    const row = JSON.parse(line), old = records.get(row.callId) ?? {}
    records.set(row.callId, { ...old, ...row, ...(row.phase === 'dispatched' ? { dispatched: true } : {}),
      ...(['finish','incomplete-stream'].includes(row.phase) ? { terminal: true } : {}) })
  }
  return [...records.values()]
}
export async function promptControlled(client, spec, sessionId, text, { turnSeconds = 1200, requestSeconds = 300, signal } = {}) {
  signal?.throwIfAborted()
  const file = join(spec.observed, `${sessionId}.events.json`)
  let before = []
  try { before = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const seq = before.at(-1)?.seq ?? -1, start = Date.now()
  signal?.throwIfAborted()
  await client.call('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] })
  let mtime = 0
  while (Date.now() - start < turnSeconds * 1000) {
    await pause(1500, undefined, { signal })
    signal?.throwIfAborted()
    const info = await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (info && info.mtimeMs > mtime) {
      mtime = info.mtimeMs
      const events = JSON.parse(await readFile(file, 'utf8')), recent = events.filter(event => event.seq > seq)
      const end = recent.find(event => event.type === 'turn/end')
      if (end) return { events, recent, end: end.data.reason, elapsedMs: Date.now() - start }
    }
    const records = await requestRecords(join(spec.observed, 'requests.jsonl'))
    const timedOut = records.find(record => record.sessionId === sessionId && record.dispatched && !record.terminal && Date.now() - Date.parse(record.time) > requestSeconds * 1000)
    if (timedOut) {
      await client.call('session/cancel', { sessionId })
      throw new Error(`EXPERIMENT_REQUEST_TIMEOUT: ${requestSeconds}s; call ${timedOut.callId}`)
    }
  }
  await client.call('session/cancel', { sessionId })
  throw new Error(`EXPERIMENT_TURN_TIMEOUT: ${turnSeconds}s`)
}
