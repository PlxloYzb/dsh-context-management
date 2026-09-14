import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// A cancelled turn may never publish a final snapshot. Reconcile its durable
// event stream with the prior snapshot (which also holds inherited fork data).
export async function observedEvents(directory, sessionId) {
  const optional = async path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const snapshotText = await optional(join(directory, `${sessionId}.events.json`))
  const streamText = await optional(join(directory, `${sessionId}.events.jsonl`))
  const snapshot = snapshotText ? JSON.parse(snapshotText) : []
  const stream = streamText.split('\n').filter(Boolean).map(JSON.parse)
  const bySeq = new Map()
  for (const event of [...snapshot, ...stream]) {
    if (bySeq.has(event.seq)) assert.deepEqual(bySeq.get(event.seq), event, `Conflicting observed event ${event.seq}`)
    else bySeq.set(event.seq, event)
  }
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  for (let i = 0; i < events.length; i++) assert.equal(events[i].seq, i, 'Observed event history has a gap')
  return events
}
