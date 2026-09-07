import test from 'node:test'
import assert from 'node:assert/strict'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createCore } from 'acp-kernel'
import { ArchiveReader } from '../../src/archive.ts'
import { ArcStateStore } from '../../src/state.ts'
import { makeTools } from '../../src/tools.ts'
import { runCompactionTransaction } from '../../src/region.ts'
import { host, newSession } from './runtime.ts'
import { appendUser } from '../helpers.ts'

test('R03/R04: search locators seek to the exact original Unicode block offset, and cannot address a foreign source', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'seek-source'), reader = new ArchiveReader()
  session.append('turn/start', { turn: 1 })
  const text = `İ${'甲🙂\r\n '.repeat(1000)}FIND_ME_7319${' trailing'.repeat(100)}`
  appendUser(session, text)
  const source = session.surface.nodes.at(-1)!
  appendUser(session, 'Current user message')
  const current = session.surface.nodes.at(-1)!
  const block = runCompactionTransaction(session, { start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'seek fixture' }], shadowedTokenCount: 2000, provider: 'fixture', model: 'seek' })
  const result = reader.search(session, { query: 'find_me_7319' }) as { hits: { seq: number; textBlockPath: number[]; offset: number }[] }
  const hit = result.hits[0]!
  assert.equal(hit.seq, source)
  assert.equal(hit.offset, text.indexOf('FIND_ME_7319'), 'case folding expansion must not shift raw offsets')
  const page = reader.decompress(session, { blockId: block.compactionId, sourceSeq: hit.seq, textBlockPath: hit.textBlockPath, offset: hit.offset }) as { status: string; segments: { text: string; offset: number }[] }
  assert.equal(page.status, 'success')
  assert.equal(page.segments[0]!.offset, hit.offset)
  assert.ok(page.segments[0]!.text.startsWith('FIND_ME_7319'))
  assert.match(JSON.stringify(reader.decompress(session, { blockId: block.compactionId, sourceSeq: current })), /source-not-in-archive/)
  assert.match(JSON.stringify(reader.decompress(session, { blockId: block.compactionId, sourceSeq: source, offset: 3 })), /invalid-text-offset/)
})

test('parallel retrieval calls share one step budget and a later step receives a fresh budget', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'parallel-budget')
  session.append('turn/start', { turn: 1 }); appendUser(session, '甲🙂\r\n'.repeat(4000))
  const source = session.surface.nodes[0]!
  appendUser(session, 'Current request')
  const block = runCompactionTransaction(session, { start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'parallel fixture' }], shadowedTokenCount: 4000, provider: 'fixture', model: 'budget' })
  session.append('step/start', { turn: 1, step: 1 })
  const tools = makeTools({ kernel: createCore({}), store: new ArcStateStore(), modelContextLimit: 128000, retrievalBudget: () => 4096 })
  const tool = tools.find(tool => tool.name === 'decompress')!
  const exec = { agent: { session, ctx: h.ctx, options: {} }, signal: new AbortController().signal } as unknown as ToolRunContext
  const outputs = await Promise.all(Array.from({ length: 8 }, () => tool.execute({ blockId: block.compactionId, maxTokens: 4096 }, exec)))
  const successful = outputs.filter(output => JSON.parse(output.text).status === 'success')
  assert.ok(successful.length > 0 && successful.length < outputs.length)
  assert.ok(successful.reduce((sum, output) => sum + Buffer.byteLength(output.text), 0) <= 4096)
  assert.ok(outputs.some(output => output.text.includes('insufficient-headroom')))
  session.append('step/end', { turn: 1, step: 1 }); session.append('step/start', { turn: 1, step: 2 })
  assert.equal(JSON.parse((await tool.execute({ blockId: block.compactionId, maxTokens: 4096 }, exec)).text).status, 'success')
})

test('bounded output over Unicode/control text, small budgets, and oversized imported identifiers', async t => {
  const h = await host(); t.after(h.close)
  for (const idLength of [36, 4000]) {
    const session = newSession(h.ctx, `budget-fuzz-${idLength}`), reader = new ArchiveReader()
    session.append('turn/start', { turn: 1 }); appendUser(session, '\u0000\"\\\r\n甲🙂'.repeat(3000))
    const source = session.surface.nodes[0]!
    appendUser(session, 'Latest')
    const block = runCompactionTransaction(session, { operationId: 'x'.repeat(idLength), start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'fuzz' }], shadowedTokenCount: 6000, provider: 'fixture', model: 'budget' })
    for (const budget of [768, 1024, 2048, 4096]) {
      const page = reader.decompress(session, { blockId: block.compactionId, maxTokens: budget }, budget)
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= budget)
      const search = reader.search(session, { query: '甲🙂', limit: 20 }, budget)
      assert.ok(Buffer.byteLength(JSON.stringify(search)) <= budget)
    }
  }
})
