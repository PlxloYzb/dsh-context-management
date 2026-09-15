// Test-only, credential-free observations of the pinned host's real streams.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

export const inject = ['llm', 'sessions']
export function apply(ctx, config) {
  mkdirSync(config.output, { recursive: true })
  const owned = session => session?.header.cwd?.includes('dsh-context-experiment-turnover-')
  const log = row => appendFileSync(join(config.output, 'streams.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 })
  ctx.on('agent/created', ({ agent }) => {
    if (owned(agent.session)) agent.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), maxTokens: config.maxTokens ?? 2048 }))
  })
  ctx.on('session/event', (session, event) => {
    if (!owned(session)) return
    if (event.type === 'turn/end') writeFileSync(join(config.output, `${session.id}.events.json`), JSON.stringify(session.snapshotEvents()), { mode: 0o600 })
  })
  ctx.on('llm/stream', async function* (request, next) {
    if (!owned(ctx.sessions.get(request.sessionId))) throw new Error('Unowned experiment request')
    const id = randomUUID(), start = Date.now()
    const expected = request.purpose === 'compaction' ? config.summaryRoute : config.mainRoute
    if (expected && (request.provider !== expected.provider || request.model !== expected.model || request.reasoningEffort !== expected.reasoningEffort)) throw new Error('Experiment stream route/effort differs from the explicit configuration')
    // Synthetic request content, never provider settings or credentials. Keep
    // exact inputs so concurrent-role attribution can be checked after a failure.
    const requestBytes = JSON.stringify({ provider: request.provider, model: request.model, purpose: request.purpose ?? 'agent', maxTokens: request.maxTokens, reasoningEffort: request.reasoningEffort, system: request.system, tools: request.tools, messages: request.messages })
    const requestHash = createHash('sha256').update(requestBytes).digest('hex')
    writeFileSync(join(config.output, `request-${id}.json`), requestBytes, { mode: 0o600 })
    log({ id, phase: 'start', time: start, sessionId: request.sessionId, provider: request.provider, model: request.model, purpose: request.purpose ?? 'agent', maxTokens: request.maxTokens, reasoningEffort: request.reasoningEffort ?? null, requestHash })
    let first = false, terminal = false, lastContent = null, contentChunks = 0
    try {
      for await (const chunk of next()) {
        if (['text-delta', 'reasoning-delta', 'tool-call-delta'].includes(chunk.type)) { lastContent = Date.now(); contentChunks++ }
        if (!first && ['text-delta', 'reasoning-delta', 'tool-call-delta'].includes(chunk.type)) { first = true; log({ id, phase: 'first', time: Date.now() }) }
        if (chunk.type === 'usage') log({ id, phase: 'usage', usage: chunk.usage })
        if (chunk.type === 'finish') { terminal = true; log({ id, phase: 'finish', time: Date.now(), elapsedMs: Date.now() - start, lastContent, contentChunks, reason: chunk.reason }) }
        yield chunk
      }
    } catch (error) {
      log({ id, phase: 'error', time: Date.now(), code: error.code ?? 'unknown', status: error.status ?? error.failure?.status ?? null })
      throw error
    } finally { if (!terminal) log({ id, phase: 'incomplete', time: Date.now(), elapsedMs: Date.now() - start, lastContent, contentChunks }) }
  })
}
