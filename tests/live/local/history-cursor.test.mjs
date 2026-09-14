import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webClient } from '../client.mjs'

test('cold history can page from an observed cursor without list projections', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-local-cursor-'))
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(302, { 'set-cookie': 'synthetic-test=fixture; HttpOnly' })
      response.end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    if (body.method === 'session/list') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ result: { ok: true, value: { items: [] } } }))
      return
    }
    const page = body.payload.args.request
    const second = page.beforeSeq === 2
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ result: { ok: true, value: {
      records: (second ? [0, 1] : [2, 3]).map(seq => ({ type: 'event', event: { seq, type: 'fixture', data: {} } })),
      hasMore: !second,
    } } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  const port = server.address().port, log = join(directory, 'launch.log')
  await writeFile(log, `http://127.0.0.1:${port}/synthetic-launch`)
  const client = await webClient(log, port)
  assert.deepEqual((await client.history('synthetic-session', 3)).map(event => event.seq), [0, 1, 2, 3])
  assert.equal(requests.length, 2)
  assert.ok(requests.every(request => request.method === 'session/page' && request.payload.args.request.throughSeq === 3))
  await assert.rejects(client.history('synthetic-session', -2), /cursor unavailable/)
  assert.equal(requests.length, 2)
})
