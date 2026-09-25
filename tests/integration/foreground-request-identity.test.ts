import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, LlmRuntime, createUserMessage, isAgentLoopRequest, type ContentBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ContextManagementEngine } from '../../src/index.ts'
import { host, oldWork } from './runtime.ts'

// The background-summary gate must not depend on the host's `isAgentLoopRequest`
// mark. That predicate reads a module-private WeakSet, so whenever the plugin
// and the agent loop resolve different copies of @deepseek-ai/dsh-llm — which is
// what an installed profile does — the plugin's copy always reports false and
// the gate silently never opens. A single-process unit test shares one module
// instance and therefore cannot observe the defect, so these cases drive the
// `llm/stream` waterfall with a request the host never marked.

class SummaryAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id, context: { contextWindow: 1000000 } } }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(request)
    yield { type: 'text-delta', text: 'summary: continue current work' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
function* response(blocks: ContentBlock[]): Generator<StreamChunk> {
  for (const [index, block] of blocks.entries()) {
    yield { type: 'block-start', index, blockType: block.type }
    yield { type: 'block-end', index, block }
  }
  yield { type: 'finish', reason: { kind: blocks.some(b => b.type === 'tool-call') ? 'tool-calls' : 'stop' } }
}
const prompt = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

// An installed-layout runtime: the gate is configured to open at almost any
// pressure so the only variable under test is request identity.
async function runtime(id: string) {
  const h = await host()
  new AgentRegistry(h.ctx)
  new LlmRuntime(h.ctx)
  new SystemPrompt(h.ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new ToolRuntime(h.ctx)
  const foreground = new SummaryAdapter()
  const summary = new SummaryAdapter()
  h.ctx.llm.registerAdapter(['foreground-test'], foreground)
  // A distinct route lets a later hand-driven stream avoid prepare()'s
  // per-route dedup without disturbing the real foreground route.
  h.ctx.llm.registerAdapter(['probe-test'], foreground)
  h.ctx.llm.registerAdapter(['summary-test'], summary)
  new AgentLoop(h.ctx, AgentLoop.Config({ agents: [], maxParallelToolCalls: 10 }))
  const engine = new ContextManagementEngine(h.ctx, {
    autoNudge: false,
    adaptiveGovernor: { windowBudgetTokens: 40000, maxOutputTokens: 2048 },
    backgroundSummary: { provider: 'summary-test', model: 'summary', reasoningEffort: 'minimal', delivery: 'seed', prepareAtEffectiveCapacityPct: 0.000001 },
  })
  h.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: 'foreground-test', model: 'fixture' }))
  // The seeded session is only a source of history events; the registry owns the
  // live session object, so nothing else may register the same id.
  const seedSession = Session.create(SessionId(`seed-${id}`))
  oldWork(seedSession)
  const handle = await h.ctx.agents.create({ sessionId: SessionId(id), seed: seedSession.snapshotEvents(), agentOptions: { provider: 'foreground-test', model: 'fixture' } })
  return { ...h, engine, foreground, summary, agent: handle.agent, dispose: handle.dispose }
}

// Fire the stream waterfall exactly as LlmRuntime does, but with a request this
// process never hand to markAgentLoopRequest.
async function streamUnmarked(h: Awaited<ReturnType<typeof runtime>>, signal: AbortSignal, provider = 'foreground-test', model = 'fixture') {
  const request = {
    provider, model, maxTokens: 2048,
    messages: [prompt('Continue foreground review.')],
    sessionId: h.agent.session.id, signal,
  }
  assert.equal(isAgentLoopRequest(request), false, 'this request must not carry the host mark')
  const stream = h.ctx.waterfall('llm/stream' as never, request as never, () => (async function* () { yield* response([{ type: 'text', text: 'ok' }]) })() as never)
  for await (const _chunk of stream as AsyncIterable<StreamChunk>) { /* drain */ }
}

test('an unmarked stream opens the background-summary gate when its signal came through agent/request', { timeout: 20000 }, async t => {
  const h = await runtime('foreground-identity-positive')
  t.after(async () => { await h.dispose(); await h.close() })
  const jobId = () => (h.engine.summaries.status(h.agent.session) as { operationId?: string } | null)?.operationId ?? null

  // A real foreground turn establishes the request header and admission the
  // pressure projection needs; capture the exact step signal it used.
  let stepSignal: AbortSignal | undefined
  h.ctx.on('agent/request', async (payload, next) => { stepSignal = payload.signal; return next() }, { global: true, prepend: true })
  h.agent.followup(prompt('Continue foreground review.'))
  await h.agent.whenIdle()
  assert.ok(stepSignal !== undefined, 'the foreground turn exposed a step signal')
  assert.notEqual(jobId(), null, 'the foreground turn opened the gate and prepared a summary job')

  // Now the installed-layout condition: the same signal, on a request this
  // process never handed to markAgentLoopRequest, so the host predicate is false.
  // prepare() supersedes the previous job for a different route, so a new
  // operation id is the observable proof that the gate opened again.
  const before = jobId()
  await streamUnmarked(h, stepSignal!, 'probe-test', 'probe')
  const after = jobId()
  assert.notEqual(after, null, 'the unmarked stream prepared a summary job')
  assert.notEqual(after, before, 'the recorded foreground signal opened the gate without the host mark')
})

test('an unmarked stream does not open the gate on a signal the plugin never saw', { timeout: 20000 }, async t => {
  const h = await runtime('foreground-identity-negative')
  t.after(async () => { await h.dispose(); await h.close() })
  const jobId = () => (h.engine.summaries.status(h.agent.session) as { operationId?: string } | null)?.operationId ?? null

  h.agent.followup(prompt('Continue foreground review.'))
  await h.agent.whenIdle()
  // An auxiliary stream that never passed through agent/request carries a signal
  // the plugin never recorded, so the gate must stay shut and the existing job
  // must be left untouched.
  const before = jobId()
  assert.notEqual(before, null, 'the foreground turn established a job to compare against')
  await streamUnmarked(h, new AbortController().signal, 'probe-test', 'probe')
  assert.equal(jobId(), before, 'an unobserved stream must not start a background summary')
})
