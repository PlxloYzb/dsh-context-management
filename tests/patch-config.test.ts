import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Config, validateContextConfig } from '../src/index.ts'
import { apply } from '../src/bridge.ts'
import { ArcStateStore } from '../src/state.ts'
import { Session } from '@deepseek-ai/dsh-session'
import { ContextManagementError, waitForContext } from '../src/errors.ts'

test('F01/F11: invalid static budget geometry fails before backend publication', () => {
  for (const adaptiveGovernor of [
    { windowBudgetTokens: 8192, maxOutputTokens: 8192 },
    { windowBudgetTokens: 8192 },
    { windowBudgetTokens: 10240 },
  ]) {
    assert.throws(() => Config({ adaptiveGovernor }), /budget|context window/)
    assert.throws(() => validateContextConfig({ adaptiveGovernor }), error => error instanceof ContextManagementError && error.code === 'CONTEXT_INVALID_CONFIG')
  }
  assert.doesNotThrow(() => Config({ adaptiveGovernor: { windowBudgetTokens: 32768, maxOutputTokens: 8192 } }))
  // A small archive can fit a small static budget; the real envelope is checked at runtime.
  assert.doesNotThrow(() => Config({ adaptiveGovernor: { windowBudgetTokens: 8192 }, archive: { seedMaxTokens: 1024, retrievalDefaultMaxTokens: 1024, retrievalMaxTokens: 1024 } }))
})

test('F12: prompt errors fail before bridge effects and preserve the existing backend', () => {
  const ctx = new Context(), builtins = {}, existingBackend = {}
  ctx.provide('loader', { builtins } as never)
  ctx.provide('compaction', existingBackend as never)
  const bad = { prompts: { nudge: { normal: 'BAD {unknownplaceholder}' } } }
  assert.throws(() => Config(bad), /unknown placeholder/)
  assert.throws(() => apply(ctx, bad), error => error instanceof ContextManagementError && error.code === 'CONTEXT_INVALID_CONFIG')
  assert.deepEqual(builtins, {})
  assert.equal(ctx.get('compaction'), existingBackend)
  assert.throws(() => validateContextConfig({ prompts: { nudge: { typo: 'x' } } } as never), /not a supported/)
})

test('F14: reconstructed Session objects cannot share stale kernel state by id', () => {
  const store = new ArcStateStore(), first = Session.create('same-id'), reloaded = Session.create('same-id')
  const oldState = store.stateFor(first)
  oldState.nextBlockId = 88
  assert.equal(store.stateFor(first).nextBlockId, 88)
  assert.equal(store.stateFor(reloaded).nextBlockId, 1)
  store.delete(first)
  assert.equal(store.stateFor(first).nextBlockId, 1)
})

test('bridge cancellation stops only the waiter, preserving shared takeover work', async () => {
  let complete!: (value: number) => void
  const shared = new Promise<number>(resolve => { complete = resolve })
  const abort = new AbortController()
  const waiting = waitForContext(shared, abort.signal)
  abort.abort(new Error('cancelled waiter'))
  await assert.rejects(waiting, /cancelled waiter/)
  complete(42)
  assert.equal(await waitForContext(shared), 42)
})

test('runtime error boundary uses the public host loader to preserve foreign module error identity', async () => {
  const { ContextManagementError, runtimeContextError } = await import('../src/errors.ts')
  class HostLlmError extends Error { constructor(message: string, readonly code: string) { super(message) } }
  const imports: string[] = []
  const ctx = { get(name: string): unknown { return name === 'loader' ? { import(specifier: string) { imports.push(specifier); return { LlmError: HostLlmError } } } : undefined } }
  const policy = new ContextManagementError('CONTEXT_ENVELOPE_TOO_LARGE', 'Fixed prompt cannot fit')
  const normalized = await runtimeContextError(ctx, policy)
  assert.ok(normalized instanceof HostLlmError)
  assert.equal(normalized.code, policy.code)
  assert.deepEqual(imports, ['@deepseek-ai/dsh-llm'])
  const ordinary = new Error('ordinary')
  assert.equal(await runtimeContextError(ctx, ordinary), ordinary)
})
