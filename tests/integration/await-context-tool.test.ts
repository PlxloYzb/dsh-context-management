import test from 'node:test'
import assert from 'node:assert/strict'
import { createCore } from 'acp-kernel'
import { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ArcStateStore } from '../../src/state.ts'
import { makeTools } from '../../src/tools.ts'

function execution(session: Session, signal: AbortSignal): ToolRunContext {
  return { agent: { session, options: {} } as unknown as Agent, signal } as unknown as ToolRunContext
}

function baseEnvironment(overrides: { awaitContext?: (agent: Agent, signal: AbortSignal) => Promise<object> } = {}) {
  return { kernel: createCore({}), store: new ArcStateStore(), modelContextLimit: 128000, ...overrides }
}

test('await_context forwards the agent signal and can release a pending handoff on abort', async () => {
  const session = Session.create('await-context-abort')
  const controller = new AbortController()
  let receivedAgent: Agent | undefined
  let receivedSignal: AbortSignal | undefined
  let entered: (() => void) | undefined
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  const tool = makeTools(baseEnvironment({
    awaitContext: async (agent, signal) => {
      receivedAgent = agent
      receivedSignal = signal
      entered!()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { status: 'ready', reason: 'handoff-aborted' }
    },
  })).find(candidate => candidate.name === 'await_context')
  assert.ok(tool)
  const agent = { session, options: {} } as unknown as Agent
  const executionContext = { agent, signal: controller.signal } as unknown as ToolRunContext
  const pending = tool.execute({}, executionContext)
  await enteredPromise
  assert.equal(receivedAgent, agent)
  assert.equal(receivedSignal, controller.signal)
  controller.abort()
  assert.deepEqual(JSON.parse((await pending).text), { status: 'ready', reason: 'handoff-aborted' })
  assert.equal(session.snapshotEvents().length, 0, 'waiting must not append session events')
})

test('await_context is omitted when no host handoff callback is configured', () => {
  const tools = makeTools(baseEnvironment())
  assert.equal(tools.some(tool => tool.name === 'await_context'), false)
  assert.deepEqual(tools.map(tool => tool.name), ['compress', 'decompress', 'search_context', 'arc_status'])
})

test('await_context forwards callback status without writing it into the session', async () => {
  const session = Session.create('await-context-status')
  const tool = makeTools(baseEnvironment({ awaitContext: async () => ({ status: 'ready' }) }))
    .find(candidate => candidate.name === 'await_context')
  assert.ok(tool)
  const before = session.snapshotEvents().length
  const result = await tool.execute({}, execution(session, new AbortController().signal))
  assert.deepEqual(JSON.parse(result.text), { status: 'ready' })
  assert.equal(session.snapshotEvents().length, before, 'tool result must remain host-managed')
})
