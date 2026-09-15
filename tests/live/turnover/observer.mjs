// Test-only, credential-free observations of the pinned host's real streams.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

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
    log({ id, phase: 'start', time: start, sessionId: request.sessionId, provider: request.provider, model: request.model, purpose: request.purpose ?? 'agent', maxTokens: request.maxTokens, reasoningEffort: request.reasoningEffort ?? null })
    let first = false, terminal = false
    try {
      for await (const chunk of next()) {
        if (!first && ['text-delta', 'reasoning-delta', 'tool-call-delta'].includes(chunk.type)) { first = true; log({ id, phase: 'first', time: Date.now() }) }
        if (chunk.type === 'usage') log({ id, phase: 'usage', usage: chunk.usage })
        if (chunk.type === 'finish') { terminal = true; log({ id, phase: 'finish', time: Date.now(), elapsedMs: Date.now() - start, reason: chunk.reason }) }
        yield chunk
      }
    } catch (error) {
      log({ id, phase: 'error', time: Date.now(), code: error.code ?? 'unknown', status: error.status ?? error.failure?.status ?? null })
      throw error
    } finally { if (!terminal) log({ id, phase: 'incomplete', time: Date.now(), elapsedMs: Date.now() - start }) }
  })
}
