import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, LlmRuntime, LlmError, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { ContextManagementEngine } from '../../src/index.ts'
import { windowIdentity } from '../../src/window-controller.ts'
import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { host, oldWork } from './runtime.ts'

function* respond(block: ContentBlock): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: block.type }
  yield { type: 'block-end', index: 0, block }
  yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
}

test('R15 controlled host loop limits overflow recovery across steps in one turn and resets on the next turn', async () => {
  const h = await host()
  class ScopeAdapter extends LlmAdapter {
    readonly calls: GenerateOptions[] = []
    override async resolveModel(provider: string, id: string) { return { provider, id, name: id, context: { contextWindow: 1000000 } } }
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      this.calls.push(request)
      const index = this.calls.length
      if ([1, 3, 4].includes(index)) throw new LlmError(`Controlled scope overflow at request ${index}`, 'CONTEXT_WINDOW_EXCEEDED')
      if (index === 2) yield* respond({ type: 'tool-call', id: ToolCallId('scope-probe'), name: 'scope_probe', arguments: '{}' })
      else yield* respond({ type: 'text', text: 'Completed next turn after one permitted recovery.' })
    }
  }
  try {
    new AgentRegistry(h.ctx); new LlmRuntime(h.ctx)
    new SystemPrompt(h.ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
    new ToolRuntime(h.ctx)
    const adapter = new ScopeAdapter()
    h.ctx.llm.registerAdapter(['controlled-scope'], adapter)
    new AgentLoop(h.ctx, { agents: [], maxParallelToolCalls: 10 })
    new ContextManagementEngine(h.ctx, { autoNudge: false, adaptiveGovernor: { maxOutputTokens: 8192 } })
    h.ctx.tools.register(defineTool({ name: 'scope_probe', description: 'Return synthetic source material in this controlled loop.', parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [{ type: 'text', text: 'Synthetic scope telemetry remains historical data. '.repeat(3000) }] },
      async execute() { return {} },
    }))
    const seed = Session.create(SessionId('overflow-scope-seed')); oldWork(seed)
    const handle = await h.ctx.agents.create({ sessionId: SessionId('experiment-overflow-scope'), seed: seed.snapshotEvents(), agentOptions: { provider: 'controlled-scope', model: 'fixture' } })
    const input = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
    handle.agent.followup(input('FIRST TURN: preserve this current user request.'))
    await handle.agent.whenIdle()
    assert.equal(adapter.calls.length, 3, 'Second-step overflow does not receive another retry in the same turn')
    assert.equal(windowIdentity(handle.agent.session).generation, 1)
    const prefix = handle.agent.session.snapshotEvents()
    const firstEnd = prefix.filter(event => event.type === 'turn/end').at(-1)
    assert.match(JSON.stringify(firstEnd), /CONTEXT_WINDOW_EXCEEDED/)
    assert.ok(prefix.some(event => event.type === 'tool/result'), 'The two overflow points straddle an actual completed tool step')
    handle.agent.followup(input('NEXT TURN: retain both user instructions and continue.'))
    await handle.agent.whenIdle()
    assert.equal(adapter.calls.length, 5, 'The new turn gets one recovery and one successful retry')
    assert.equal(windowIdentity(handle.agent.session).generation, 2)
    const events = handle.agent.session.snapshotEvents()
    assert.deepEqual(events.slice(0, prefix.length), prefix)
    const lastEnd = events.filter(event => event.type === 'turn/end').at(-1)
    assert.equal(lastEnd?.type === 'turn/end' && lastEnd.data.reason.kind, 'completed')
    assert.ok(JSON.stringify(adapter.calls[4]?.messages).includes('NEXT TURN'))
    assert.equal(toolPairingBalancedAfter(handle.agent.session, handle.agent.session.surface.nodes.at(-1)!), true)
    await handle.dispose()
  } finally { await h.close() }
})
