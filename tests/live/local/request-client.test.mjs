import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promptControlled } from './request-client.mjs'

test('pre-cancelled experiment does not submit a model request', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled before dispatch'))
  await assert.rejects(promptControlled({ call() { assert.fail('No RPC should be submitted') } }, { observed: 'unused' }, 'unused', 'unused', { signal: controller.signal }), /cancelled before dispatch/)
})

test('experiment cancellation interrupts polling without waiting for the turn timeout', async t => {
  const observed = await mkdtemp(join(tmpdir(), 'dsh-local-poll-cancel-'))
  t.after(() => rm(observed, { recursive: true, force: true }))
  const controller = new AbortController(), calls = []
  const client = { async call(method) { calls.push(method); setTimeout(() => controller.abort(new Error('wall deadline')), 10) } }
  const start = performance.now()
  await assert.rejects(promptControlled(client, { observed }, 'synthetic', 'Synthetic prompt', { turnSeconds: 600, signal: controller.signal }), error => error.name === 'AbortError')
  assert.deepEqual(calls, ['session/prompt'])
  assert.ok(performance.now() - start < 1000, 'Polling must not hold a finished driver alive')
})

test('forked history completion cannot be mistaken for the new probe response', async t => {
  const observed = await mkdtemp(join(tmpdir(), 'dsh-local-poll-fork-'))
  t.after(() => rm(observed, { recursive: true, force: true }))
  const file = join(observed, 'fork.events.json')
  const inherited = [{ seq: 10, type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } }]
  await writeFile(file, JSON.stringify(inherited))
  const answer = { seq: 20, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'NEW_PROBE_ANSWER' }] } } }
  const end = { seq: 21, type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } }
  const client = { async call(method) {
    assert.equal(method, 'session/prompt')
    await writeFile(file, JSON.stringify([...inherited, answer, end]))
  } }
  const result = await promptControlled(client, { observed }, 'fork', 'Probe', { turnSeconds: 5 })
  assert.deepEqual(result.recent, [answer, end])
})
