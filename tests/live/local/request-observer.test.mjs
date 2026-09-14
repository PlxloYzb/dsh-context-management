import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './request-observer.mjs'

async function observer(t) {
  const output = await mkdtemp(join(tmpdir(), 'dsh-local-observer-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const hooks = new Map(), session = { id: 'synthetic-observer', seq: 10, header: { cwd: '/synthetic/dsh-context-experiment-observer' } }
  const ctx = { on(name, hook) { hooks.set(name, hook) }, sessions: { get() { return session } }, llm: { async resolveModelInfo() { return { context: { contextWindow: 393216 } } } } }
  const route = { provider: 'synthetic', model: 'local-test' }
  apply(ctx, { output, route, mainMaxTokens: 8192, expectedContextWindow: 393216 })
  const request = Object.freeze({ sessionId: session.id, ...route, maxTokens: 8192, messages: Object.freeze([{ role: 'user', content: [{ type: 'text', text: 'Synthetic input' }] }]) })
  return { hook: hooks.get('llm/stream'), request, async records() { return (await readFile(join(output, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) } }
}

test('local timing observer leaves the request and every streamed chunk unchanged', async t => {
  const o = await observer(t), before = JSON.stringify(o.request)
  const chunks = [
    { type: 'reasoning-delta', index: 0, text: 'Checking synthetic evidence.' },
    { type: 'text-delta', index: 1, text: 'Ready.' },
    { type: 'tool-call-delta', index: 2, id: 'call', name: 'fixture', argumentsDelta: '{"page":1}' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ].map(Object.freeze)
  const actual = []
  for await (const chunk of o.hook(o.request, async function* () { yield* chunks })) actual.push(chunk)
  assert.equal(JSON.stringify(o.request), before)
  actual.forEach((chunk, index) => assert.equal(chunk, chunks[index]))
  const records = await o.records(), finish = records.find(row => row.phase === 'finish')
  assert.equal(records.filter(row => row.phase === 'first-content').length, 1)
  assert.equal(typeof finish.firstContentMs, 'number')
  assert.ok(finish.outputCharacters.reasoning > 0 && finish.outputCharacters.arguments > 0)
})

test('local timing observer preserves a provider failure and records the interrupted stream', async t => {
  const o = await observer(t), failure = new Error('synthetic provider failure')
  await assert.rejects(async () => {
    for await (const _ of o.hook(o.request, async function* () { yield { type: 'text-delta', index: 0, text: 'Partial' }; throw failure })) {}
  }, error => error === failure)
  const records = await o.records()
  assert.equal(records.filter(row => row.phase === 'finish').length, 0)
  assert.equal(records.filter(row => row.phase === 'incomplete-stream').length, 1)
})
