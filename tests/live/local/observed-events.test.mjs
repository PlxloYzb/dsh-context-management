import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { observedEvents } from './observed-events.mjs'

test('cancelled-turn evidence retains events beyond the last completed snapshot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-observed-events-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const old = { seq: 0, type: 'turn/end' }, fresh = { seq: 1, type: 'compaction/summary' }
  await writeFile(join(root, 's.events.json'), JSON.stringify([old]))
  await writeFile(join(root, 's.events.jsonl'), [old, fresh].map(JSON.stringify).join('\n') + '\n')
  assert.deepEqual(await observedEvents(root, 's'), [old, fresh])
  await writeFile(join(root, 's.events.jsonl'), JSON.stringify({ ...old, type: 'conflict' }) + '\n')
  await assert.rejects(observedEvents(root, 's'), /Conflicting observed event/)
  await writeFile(join(root, 's.events.jsonl'), JSON.stringify({ ...fresh, seq: 2 }) + '\n')
  await assert.rejects(observedEvents(root, 's'), /history has a gap/)
})
