import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, LlmRuntime, LlmError, ReasoningEffortId, createUserMessage, type GenerateOptions, type StreamChunk, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { ContextManagementEngine } from '../../src/index.ts'
import { ArchiveReader } from '../../src/archive.ts'
import { windowIdentity } from '../../src/window-controller.ts'
import { rebuildBlockLedger } from '../../src/region.ts'
import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { host, oldWork } from './runtime.ts'

class ControlledAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  constructor(readonly respond: (request: GenerateOptions, index: number) => AsyncIterable<StreamChunk>) { super() }
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id, context: { contextWindow: 1000000 } } }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> { this.calls.push(request); yield* this.respond(request, this.calls.length) }
}
function* response(blocks: ContentBlock[]): Generator<StreamChunk> {
  for (const [index, block] of blocks.entries()) {
    yield { type: 'block-start', index, blockType: block.type }
    yield { type: 'block-end', index, block }
  }
  yield { type: 'finish', reason: { kind: blocks.some(b => b.type === 'tool-call') ? 'tool-calls' : 'stop' } }
}
const prompt = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
async function runtime(adapter: ControlledAdapter, governor: { windowBudgetTokens?: number } = {}) {
  const h = await host()
  new AgentRegistry(h.ctx)
  new LlmRuntime(h.ctx)
  new SystemPrompt(h.ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new ToolRuntime(h.ctx)
  h.ctx.llm.registerAdapter(['controlled-test'], adapter)
  new AgentLoop(h.ctx, { agents: [], maxParallelToolCalls: 10 })
  const engine = new ContextManagementEngine(h.ctx, { autoNudge: false, adaptiveGovernor: { maxOutputTokens: 8192, ...governor } })
  return { ...h, engine }
}
function seeded() { const session = Session.create(SessionId('seed')); oldWork(session); return session.snapshotEvents() }

test('background preparation starts on the first admitted request, survives a completed turn and lands at the next real pressure boundary', { timeout: 5000 }, async t => {
  const h = await host(); t.after(h.close)
  new AgentRegistry(h.ctx); new LlmRuntime(h.ctx)
  new SystemPrompt(h.ctx, { includeHarnessIdentity: false, includeRuntimeContext: false }); new ToolRuntime(h.ctx)
  let cloudReady!: () => void
  const ready = new Promise<void>(resolve => { cloudReady = resolve })
  const cloud = new ControlledAdapter(async function* () {
    yield { type: 'text-delta', text: 'Goal: preserve the verified facts; next: continue review.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
    cloudReady()
  })
  cloud.resolveModel = async (provider, id) => ({ provider, id, name: id, context: { contextWindow: 1000000 }, reasoning: { efforts: [{ id: ReasoningEffortId('minimal'), name: 'minimal' }] } })
  const local = new ControlledAdapter(async function* (_request, index) {
    if (index === 1) await Promise.race([ready, new Promise(resolve => setTimeout(resolve, 50))])
    yield* response([{ type: 'text', text: index === 1 ? 'FRESH-LOOP-SUFFIX-821' : 'continued' }])
  })
  h.ctx.llm.registerAdapter(['controlled-test'], local); h.ctx.llm.registerAdapter(['independent-test'], cloud)
  new AgentLoop(h.ctx, { agents: [] })
  const engine = new ContextManagementEngine(h.ctx, { autoNudge: false, adaptiveGovernor: { windowBudgetTokens: 40000, maxOutputTokens: 2048 }, backgroundSummary: { provider: 'independent-test', model: 'summary', reasoningEffort: 'minimal', prepareAtEffectiveCapacityPct: 0.01 } })
  h.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: 'controlled-test', model: 'fixture' }))
  const handle = await h.ctx.agents.create({ sessionId: SessionId('first-request-background'), seed: seeded(), agentOptions: { provider: 'independent-test', model: 'summary' } })
  t.after(() => handle.dispose())
  handle.agent.followup(prompt('Continue foreground review.')); await handle.agent.whenIdle()
  assert.equal(cloud.calls.length, 1); assert.equal(cloud.calls[0]!.reasoningEffort, 'minimal')
  assert.equal((engine.summaries.status(handle.agent.session) as { status: string }).status, 'ready')
  assert.equal(windowIdentity(handle.agent.session).generation, 0)
  const status = await engine.contextStatus(handle.agent) as { budget: { pressure: { projectedTokens: number }; effectiveInputLimit: number } }
  const needed = status.budget.effectiveInputLimit * 1.12 - status.budget.pressure.projectedTokens
  let padding = ''
  while (h.ctx.tokenMeter.estimateMessage(prompt(padding)) < needed) padding += 'Padding for synthetic pressure; no new fact. '.repeat(20)
  handle.agent.followup(prompt(padding + '\nContinue with the fresh checkpoint.')); await handle.agent.whenIdle()
  const ledger = rebuildBlockLedger(handle.agent.session.snapshotEvents())
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0]!.contextManagement?.seed.mode, 'model-assisted')
  assert.equal((engine.windows.status(handle.agent.session) as { lastOperation: { targetReached: boolean } }).lastOperation.targetReached, false, 'soft target may be exceeded while preserving fresh work safely')
  assert.match(JSON.stringify(local.calls.at(-1)!.messages), /FRESH-LOOP-SUFFIX-821/)
})

test('O01/O02: real agent loop retries normalized overflow once after durable progress; ordinary provider error is terminal', async t => {
  for (const code of ['CONTEXT_WINDOW_EXCEEDED', 'RATE_LIMITED']) {
    const adapter = new ControlledAdapter(async function* (_request, index) {
      if (index === 1) throw new LlmError(`synthetic ${code}`, code)
      yield* response([{ type: 'text', text: 'completed after recovery' }])
    })
    const h = await runtime(adapter)
    try {
      const handle = await h.ctx.agents.create({ sessionId: SessionId(`loop-${code}`), seed: seeded(), agentOptions: { provider: 'controlled-test', model: 'fixture' } })
      handle.agent.followup(prompt('LATEST: keep the current user request'))
      await handle.agent.whenIdle()
      assert.equal(adapter.calls.length, code === 'CONTEXT_WINDOW_EXCEEDED' ? 2 : 1)
      assert.equal(windowIdentity(handle.agent.session).generation, code === 'CONTEXT_WINDOW_EXCEEDED' ? 1 : 0)
      const end = handle.agent.session.snapshotEvents().filter(e => e.type === 'turn/end').at(-1)!
      assert.equal(end.type === 'turn/end' && end.data.reason.kind, code === 'CONTEXT_WINDOW_EXCEEDED' ? 'completed' : 'error')
      if (code === 'CONTEXT_WINDOW_EXCEEDED') {
        assert.ok(JSON.stringify(adapter.calls[1]!.messages).includes('LATEST'))
        assert.ok(JSON.stringify(adapter.calls[1]!.messages).length < JSON.stringify(adapter.calls[0]!.messages).length)
      }
      await handle.dispose()
    } finally { await h.close() }
  }
})

test('W01/W05: real parallel tool batch defers turnover, keeps pairing, and preserves steered plus queued user messages', async t => {
  let agent: Agent
  const adapter = new ControlledAdapter(async function* (_request, index) {
    if (index === 1) yield* response([
      { type: 'tool-call', id: 'call-window' as never, name: 'new_context', arguments: JSON.stringify({ handoff: 'Preserve constraints and continue the task.' }) },
      { type: 'tool-call', id: 'call-observe' as never, name: 'observe_boundary', arguments: '{}' },
    ])
    else yield* response([{ type: 'text', text: `completed request ${index}` }])
  })
  const h = await runtime(adapter); t.after(h.close)
  let observedGeneration = -1
  h.ctx.tools.register(defineTool({ name: 'observe_boundary', description: 'Observe the real batch boundary.', parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [{ type: 'text', text: 'observed' }] },
    async execute() {
      observedGeneration = windowIdentity(agent.session).generation
      agent.steer(prompt('STEER: retention must be 47 days'))
      agent.followup(prompt('QUEUED: complete the final confirmation'))
      return {}
    },
  }))
  const handle = await h.ctx.agents.create({ sessionId: SessionId('loop-paired-turnover'), seed: seeded(), agentOptions: { provider: 'controlled-test', model: 'fixture' } })
  agent = handle.agent
  agent.followup(prompt('CURRENT: continue original task'))
  await agent.whenIdle()
  assert.equal(observedGeneration, 0, 'new_context acceptance cannot replace during parallel tools')
  assert.equal(windowIdentity(agent.session).generation, 1)
  assert.equal(toolPairingBalancedAfter(agent.session, agent.session.surface.nodes.at(-1)!), true)
  assert.ok(adapter.calls.length >= 3)
  const histories = adapter.calls.slice(1).map(call => JSON.stringify(call.messages))
  assert.ok(histories.some(history => history.includes('STEER: retention must be 47 days')))
  assert.ok(histories.some(history => history.includes('QUEUED: complete the final confirmation')))
  const originals = agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === 'user').map(e => JSON.stringify(e.data))
  assert.equal(originals.filter(text => text.includes('STEER: retention must be 47 days')).length, 1)
  assert.equal(originals.filter(text => text.includes('QUEUED: complete the final confirmation')).length, 1)
  await handle.dispose()
})

test('O02: repeated overflow and a source-less overflow stop without an unbounded retry loop', async () => {
  for (const seed of [seeded(), undefined]) {
    const adapter = new ControlledAdapter(async function* () { throw new LlmError('fixed normalized overflow', 'CONTEXT_WINDOW_EXCEEDED') })
    const h = await runtime(adapter)
    try {
      const handle = await h.ctx.agents.create({ sessionId: SessionId(`repeated-overflow-${seed ? 'seed' : 'empty'}`), seed, agentOptions: { provider: 'controlled-test', model: 'fixture' } })
      handle.agent.followup(prompt('Retain this latest request'))
      await handle.agent.whenIdle()
      assert.equal(adapter.calls.length, seed ? 2 : 1)
      assert.equal(windowIdentity(handle.agent.session).generation, seed ? 1 : 0)
      const final = handle.agent.session.snapshotEvents().filter(e => e.type === 'turn/end').at(-1)!
      assert.match(JSON.stringify(final), /CONTEXT_WINDOW_EXCEEDED/)
      await handle.dispose()
    } finally { await h.close() }
  }
})

test('W02: cancellation during the real parallel batch clears pending turnover and settles paired results', async t => {
  let agent: Agent
  const adapter = new ControlledAdapter(async function* () {
    yield* response([
      { type: 'tool-call', id: 'pending-before-cancel' as never, name: 'new_context', arguments: '{}' },
      { type: 'tool-call', id: 'cancel-now' as never, name: 'cancel_fixture', arguments: '{}' },
    ])
  })
  const h = await runtime(adapter); t.after(h.close)
  h.ctx.tools.register(defineTool({ name: 'cancel_fixture', description: 'Cancel this synthetic turn.', parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [{ type: 'text', text: 'cancelled' }] },
    async execute() { agent.cancel({ kind: 'user' }); return {} },
  }))
  const handle = await h.ctx.agents.create({ sessionId: SessionId('loop-cancel'), seed: seeded(), agentOptions: { provider: 'controlled-test', model: 'fixture' } })
  agent = handle.agent
  agent.followup(prompt('Try a window and cancel at the tool boundary'))
  await agent.whenIdle()
  assert.equal(adapter.calls.length, 1)
  assert.equal(windowIdentity(agent.session).generation, 0)
  assert.equal((h.engine.windows.status(agent.session) as { pending: unknown }).pending, null)
  assert.equal(toolPairingBalancedAfter(agent.session, agent.session.surface.nodes.at(-1)!), true)
  await handle.dispose()
})

test('W05/resume: incoming user admission forms the virtual fence before the host appends that user message', async t => {
  const adapter = new ControlledAdapter(async function* () { yield* response([{ type: 'text', text: 'continued safely' }]) })
  const h = await runtime(adapter, { windowBudgetTokens: 32768 }); t.after(h.close)
  const previous = Session.create(SessionId('large-previous-turn')); oldWork(previous, 1, 70)
  const seed = previous.snapshotEvents()
  const handle = await h.ctx.agents.create({ sessionId: SessionId('incoming-boundary'), seed, agentOptions: { provider: 'controlled-test', model: 'fixture' } })
  const incoming = prompt('LATEST: retention is now 47 days; continue after restart.')
  handle.agent.followup(incoming)
  await handle.agent.whenIdle()
  assert.equal(adapter.calls.length, 1)
  assert.equal(windowIdentity(handle.agent.session).generation, 1)
  const events = handle.agent.session.snapshotEvents()
  assert.deepEqual(events.slice(0, seed.length), seed)
  const current = events.filter(event => event.type === 'user/message' && event.data.id === incoming.id)
  assert.equal(current.length, 1)
  assert.ok(handle.agent.session.surface.nodes.includes(current[0]!.seq))
  const summary = events.find(event => event.type === 'compaction/summary')!
  assert.ok(summary.seq < current[0]!.seq, 'the host appends the admitted raw message after compaction')
  assert.match(JSON.stringify(summary), new RegExp(incoming.id))
  assert.match(JSON.stringify(adapter.calls[0]!.messages), /retention is now 47 days/)
  assert.ok(JSON.stringify(adapter.calls[0]!.messages).length < 20000)
  await handle.dispose()
})

test('W05: a downstream rejected admission performs no turnover and makes no provider call', async t => {
  const adapter = new ControlledAdapter(async function* () { yield* response([{ type: 'text', text: 'must not run' }]) })
  const h = await runtime(adapter, { windowBudgetTokens: 32768 }); t.after(h.close)
  h.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
  const previous = Session.create(SessionId('reject-previous')); oldWork(previous, 1, 70)
  const handle = await h.ctx.agents.create({ sessionId: SessionId('rejected-admission'), seed: previous.snapshotEvents(), agentOptions: { provider: 'controlled-test', model: 'fixture' } })
  handle.agent.followup(prompt('New input must pass admission first'))
  await handle.agent.whenIdle()
  assert.equal(adapter.calls.length, 0)
  assert.equal(windowIdentity(handle.agent.session).generation, 0)
  await handle.dispose()
})


test('S02: real registry fork inherits only the completed prefix and owns subsequent context independently', async t => {
  const adapter = new ControlledAdapter(async function* () { yield* response([{ type: 'text', text: 'completed' }]) })
  const h = await runtime(adapter); t.after(h.close)
  const parent = await h.ctx.agents.create({ sessionId: SessionId('fork-parent'), seed: seeded(), agentOptions: { provider: 'controlled-test', model: 'fixture' } })
  parent.agent.followup(prompt('Parent latest original requirement'))
  await parent.agent.whenIdle()
  const archived = await h.engine.compactIfNeeded(parent.agent, 'context-overflow', new AbortController().signal)
  assert.ok(archived); assert.equal(windowIdentity(parent.agent.session).generation, 1)
  const seed = parent.agent.session.snapshotEvents()
  const child = await h.ctx.agents.create({ sessionId: SessionId('fork-child'), seed, inheritedEventCount: seed.length as never,
    meta: { parentSession: parent.agent.session.id, isSeeded: true }, agentOptions: { provider: 'controlled-test', model: 'fixture' } })
  assert.equal(windowIdentity(child.agent.session).generation, 1)
  const reader = new ArchiveReader()
  const page = reader.decompress(parent.agent.session, { blockId: archived.compactionId }) as { status: string; nextCursor: string }
  assert.equal(page.status, 'success'); assert.ok(page.nextCursor)
  assert.match(JSON.stringify(reader.decompress(child.agent.session, { blockId: archived.compactionId, cursor: page.nextCursor })), /invalid-cursor/)
  assert.match(JSON.stringify(reader.search(child.agent.session, { query: 'FACT_1_1' })), /FACT_1_1/)
  parent.agent.followup(prompt('PARENT_ONLY_AFTER_FORK_7819'))
  child.agent.followup(prompt('CHILD_ONLY_AFTER_FORK_2917'))
  await Promise.all([parent.agent.whenIdle(), child.agent.whenIdle()])
  assert.doesNotMatch(JSON.stringify(child.agent.session.snapshotEvents()), /PARENT_ONLY_AFTER_FORK_7819/)
  assert.doesNotMatch(JSON.stringify(parent.agent.session.snapshotEvents()), /CHILD_ONLY_AFTER_FORK_2917/)
  assert.equal(child.agent.session.inheritedEventCount, seed.length)
  assert.equal(toolPairingBalancedAfter(child.agent.session, child.agent.session.surface.nodes.at(-1)!), true)
  await child.dispose(); await parent.dispose()
})


test('F01: an oversized assembled envelope reports its own error before any provider call', async t => {
  const adapter = new ControlledAdapter(async function* () { yield* response([{ type: 'text', text: 'must not run' }]) })
  const h = await runtime(adapter, { windowBudgetTokens: 32768 }); t.after(h.close)
  h.ctx.tools.register(defineTool({ name: 'large_fixture', description: 'X'.repeat(120000), parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] }, async execute() { return {} },
  }))
  const handle = await h.ctx.agents.create({ sessionId: SessionId('fixed-envelope'), agentOptions: { provider: 'controlled-test', model: 'fixture' } })
  handle.agent.followup(prompt('Short current request'))
  await handle.agent.whenIdle()
  assert.equal(adapter.calls.length, 0)
  assert.match(JSON.stringify(handle.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')), /CONTEXT_ENVELOPE_TOO_LARGE/)
  await handle.dispose()
})

test('F04: pending no-op is delivered once in the next real request and pairing remains balanced', async t => {
  const adapter = new ControlledAdapter(async function* (_request, index) {
    yield* response(index === 1 ? [{ type: 'tool-call', id: 'no-safe-prefix' as never, name: 'new_context', arguments: '{}' }] : [{ type: 'text', text: 'completed' }])
  })
  const h = await runtime(adapter); t.after(h.close)
  const handle = await h.ctx.agents.create({ sessionId: SessionId('pending-noop'), agentOptions: { provider: 'controlled-test', model: 'fixture' } })
  handle.agent.followup(prompt('Only current input'))
  await handle.agent.whenIdle()
  assert.equal(adapter.calls.length, 2)
  assert.match(JSON.stringify(adapter.calls[1]!.messages), /no-safe-range/)
  const notices = handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && JSON.stringify(event.data).includes('no-safe-range'))
  assert.equal(notices.length, 1)
  assert.equal(windowIdentity(handle.agent.session).generation, 0)
  assert.equal(toolPairingBalancedAfter(handle.agent.session, handle.agent.session.surface.nodes.at(-1)!), true)
  await handle.dispose()
})
