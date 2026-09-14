import test from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ContextManagementEngine } from '../../src/index.ts'
import { makeTools } from '../../src/tools.ts'
import { runCompactionTransaction, shadowedSeqsOf } from '../../src/region.ts'
import { host, newSession, oldWork, newInput } from './runtime.ts'

interface Status {
  surface: string
  compressibleRanges: { start: number; end: number; count: number; tokens: number }[]
  archives: number
}

test('the engine-supplied status tool exposes fresh, safe ranges after a real surface replacement', async t => {
  const h = await host(); t.after(h.close)
  const engine = new ContextManagementEngine(h.ctx, { autoNudge: false, modelContextLimit: 128000 })
  const session = newSession(h.ctx, 'engine-status-ranges')
  oldWork(session, 1, 16); newInput(session, 'CURRENT protected input')
  const current = session.surface.nodes.at(-1)!
  const middle = session.surface.nodes.slice(5, 7)
  runCompactionTransaction(session, { start: middle[0]!, end: middle.at(-1)!, shadowedSeqs: middle,
    summary: [{ type: 'text', text: 'A consumed middle checkpoint' }], shadowedTokenCount: 1000, provider: 'fixture', model: 'status' })
  const agent = { session, ctx: h.ctx, options: {} } as unknown as Agent
  const tool = makeTools({ kernel: engine.kernel, store: engine.store, modelContextLimit: 128000,
    status: owner => engine.contextStatus(owner) }).find(tool => tool.name === 'arc_status')!
  const exec = { agent, signal: new AbortController().signal } as unknown as ToolRunContext
  const status = JSON.parse((await tool.execute({}, exec)).text) as Status
  assert.ok(Array.isArray(status.compressibleRanges), 'Real status must include the refs advertised by prompts')
  assert.ok(status.compressibleRanges.length >= 2 && status.compressibleRanges.length <= 6)
  assert.equal(typeof status.surface, 'string')
  for (let i = 0; i < status.compressibleRanges.length; i++) {
    const range = status.compressibleRanges[i]!
    const selected = shadowedSeqsOf(session, range.start, range.end)
    assert.equal(range.count, selected.length)
    assert.ok(range.tokens > 0 && !selected.includes(current))
    if (i) assert.ok(status.compressibleRanges[i - 1]!.start > range.start)
  }
  const range = status.compressibleRanges[0]!, selected = shadowedSeqsOf(session, range.start, range.end)
  runCompactionTransaction(session, { start: range.start, end: range.end, shadowedSeqs: selected,
    summary: [{ type: 'text', text: 'Consumed advertised range' }], shadowedTokenCount: range.tokens, provider: 'fixture', model: 'status' })
  const refreshed = JSON.parse((await tool.execute({}, exec)).text) as Status
  assert.ok(refreshed.compressibleRanges.every(r => r.start !== range.start || r.end !== range.end), 'Rechecking status cannot return already shadowed refs')
  assert.equal(refreshed.archives, status.archives + 1)
})

test('engine status explicitly reports no compressible ranges for protected-only input', async t => {
  const h = await host(); t.after(h.close)
  const engine = new ContextManagementEngine(h.ctx, { autoNudge: false, modelContextLimit: 128000 })
  const session = newSession(h.ctx, 'engine-status-empty')
  newInput(session, 'Only this current request is present')
  const status = await engine.contextStatus({ session, ctx: h.ctx, options: {} } as unknown as Agent) as Status
  assert.deepEqual(status.compressibleRanges, [])
})
