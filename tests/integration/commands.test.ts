import test from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { createCore } from 'acp-kernel'
import { contextCommand } from '../../src/commands.ts'
import { ArcStateStore } from '../../src/state.ts'
import { host, newSession } from './runtime.ts'

test('G6: native command discovery advertises input and execution pairs lifecycle without creating a model turn', async t => {
  const h = await host(); t.after(h.close)
  const runtime = new CommandRuntime(h.ctx), session = newSession(h.ctx, 'native-command')
  const agent = { ctx: h.ctx, session } as unknown as Agent
  const abort = new AbortController()
  let called = 0
  runtime.register(contextCommand({ kernel: createCore({}), store: new ArcStateStore(), manualNew: async (received, signal) => {
    assert.equal(received.session, session); assert.equal(signal, abort.signal); called++
    return { status: 'no-op', code: 'no-safe-range' }
  } }))
  assert.ok(runtime.list(agent).find(command => command.name === 'context')?.input?.hint.includes('new'))
  const result = await runtime.execute(agent, '/context new', [], abort.signal)
  assert.equal(result?.result.kind, 'success'); assert.equal(called, 1)
  assert.deepEqual(session.snapshotEvents().map(event => event.type), ['command/run', 'command/done'])
  const events = session.snapshotEvents()
  assert.equal((events[0]!.data as { commandId: string }).commandId, (events[1]!.data as { commandId: string }).commandId)
  abort.abort('cancelled by UI')
  await assert.rejects(runtime.execute(agent, '/context new', [], abort.signal), /cancelled by UI/)
  assert.equal(called, 1)
})
