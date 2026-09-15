import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../turnover/wire-observer.mjs'

async function settled(check) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { return await check() } catch { await new Promise(resolve => setTimeout(resolve, 5)) }
  }
  return check()
}

test('wire observer keeps concurrent Responses request/response pairs isolated and restores fetch', async t => {
  const output = await mkdtemp(join(tmpdir(), 'dsh-wire-observer-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const prior = globalThis.fetch
  const calls = []
  const fakeFetch = async (input, init) => {
    calls.push({ input, init })
    const payload = JSON.parse(init.body)
    await new Promise(resolve => setTimeout(resolve, payload.input === 'one' ? 10 : 1))
    return new Response(`data: ${payload.input}\n\n`, { status: 200, headers: { 'x-request-id': `request-${payload.input}` } })
  }
  globalThis.fetch = fakeFetch
  const dispose = apply({ on() {} }, { output })
  const one = { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: JSON.stringify({ model: 'muse-spark-1.3-contributor', input: 'one' }) }
  const two = { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: JSON.stringify({ model: 'muse-spark-1.3-contributor', input: 'two' }) }
  const [first, second] = await Promise.all([
    globalThis.fetch('https://example.test/v1/responses', one),
    globalThis.fetch('https://example.test/v1/responses', two),
  ])
  assert.equal(await first.text(), 'data: one\n\n')
  assert.equal(await second.text(), 'data: two\n\n')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init, one)
  assert.equal(calls[1].init, two)
  const rows = await settled(async () => {
    const text = await readFile(join(output, 'wire.jsonl'), 'utf8')
    const parsed = text.trim().split('\n').map(JSON.parse)
    assert.equal(parsed.filter(row => row.phase === 'response').length, 2)
    return parsed
  })
  const responses = rows.filter(row => row.phase === 'response')
  const requests = rows.filter(row => row.phase === 'request')
  assert.equal(requests.length, 2)
  assert.equal(new Set(responses.map(row => row.wireId)).size, 2)
  responses.forEach(row => assert.ok(Number.isFinite(row.completedAtMs) && row.completedAtMs >= row.time))
  for (const row of responses) {
    const body = await readFile(join(output, `wire-${row.wireId}.response.sse`), 'utf8')
    const request = JSON.parse(await readFile(join(output, `wire-${row.wireId}.request.json`), 'utf8'))
    assert.equal(body, `data: ${request.input}\n\n`)
  }
  const persisted = await Promise.all((await readdir(output)).map(name => readFile(join(output, name), 'utf8')))
  assert.equal(persisted.join('\n').includes('Bearer secret'), false)
  dispose()
  assert.equal(globalThis.fetch, fakeFetch)
  globalThis.fetch = prior
})

test('wire observer leaves non-target traffic transparent', async t => {
  const output = await mkdtemp(join(tmpdir(), 'dsh-wire-observer-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const prior = globalThis.fetch
  const fakeFetch = async (_input, init) => new Response(init.body, { status: 201 })
  globalThis.fetch = fakeFetch
  const dispose = apply({ on() {} }, { output })
  const init = { method: 'POST', headers: { Authorization: 'Bearer other-secret' }, body: JSON.stringify({ model: 'other-model', input: 'unchanged' }) }
  const response = await globalThis.fetch('https://example.test/v1/responses', init)
  assert.equal(await response.text(), init.body)
  assert.equal(JSON.stringify(init), JSON.stringify({ method: 'POST', headers: { Authorization: 'Bearer other-secret' }, body: JSON.stringify({ model: 'other-model', input: 'unchanged' }) }))
  assert.deepEqual(await readdir(output), [])
  dispose()
  assert.equal(globalThis.fetch, fakeFetch)
  globalThis.fetch = prior
})
