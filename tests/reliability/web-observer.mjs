// Read-only runtime observations plus an explicit synthetic-history fixture command.
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { symbols } from '@deepseek-ai/cordis'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'

export const inject = ['commands', 'agentPresets', 'loader', 'sessions', 'tools']
export function apply(ctx, config) {
  const owned = agent => agent?.session.header.cwd?.includes('dsh-context-reliability-web-')
  const raw = value => value?.[symbols.original] ?? value
  const log = row => appendFileSync(join(config.output, 'observations.jsonl'), JSON.stringify({ time: Date.now(), ...row }) + '\n', { mode: 0o600 })
  const within = (fiber, root) => {
    for (let i = 0; fiber && i < 100; i++) { if (fiber === root) return true; const parent = fiber.parent?.fiber; if (parent === fiber) break; fiber = parent }
    return false
  }
  async function snapshot(agent, stage) {
    const api = await ctx.loader.import('@deepseek-ai/dsh-agent-presets')
    const mount = api.standingMountFor(agent.ctx), backend = raw(ctx.agentPresets.serviceFor(agent, 'compaction'))
    const rows = mount ? [...mount.tree.entries()] : []
    const relevant = rows.filter(row => /compaction|command-compact|dsh-context-management/.test(row.options.name ?? ''))
    const providers = mount ? Object.getOwnPropertySymbols(ctx.reflect.store).map(key => ctx.reflect.store[key])
      .filter(impl => impl?.name === 'compaction' && within(impl.fiber, mount.fiber)) : []
    const commands = ctx.commands.list(agent).map(command => command.name)
    const result = { stage, sessionId: agent.session.id, preset: mount?.presetId ?? null, backend: backend?.constructor.name ?? null,
      backendUid: backend?.ctx.fiber.uid ?? null, providerCount: providers.length,
      basicActive: relevant.filter(row => row.options.name === '@deepseek-ai/dsh-compaction-basic' && !row.disabled && row.fiber?.uid != null).length,
      arcActive: relevant.filter(row => row.options.name === 'cordis:dsh-context-management' && !row.disabled && row.fiber?.uid != null).length,
      compactConsumers: relevant.filter(row => row.options.name === '@deepseek-ai/dsh-command-compact').map(row => ({ enabled: !row.disabled, boundToResolvedBackend: !!backend && raw(row.fiber?.ctx.get('compaction')) === backend })),
      prunerAvailable: !!ctx.agentPresets.serviceFor(agent, 'toolResultPruner'), leakedServices: mount ? api.leakedServices(ctx, mount.fiber) : [],
      commands: { compact: commands.filter(name => name === 'compact').length, context: commands.filter(name => name === 'context').length },
      generation: agent.session.surface.replaceGeneration,
      rows: relevant.map(row => ({ id: row.options.id, name: row.options.name, disabled: row.disabled, uid: row.fiber?.uid ?? null })),
    }
    log({ kind: 'snapshot', ...result })
    writeFileSync(join(config.output, `${agent.session.id}.events.json`), JSON.stringify(agent.session.snapshotEvents()), { mode: 0o600 })
    return result
  }
  ctx.commands.register({ name: 'reliability', description: 'Owned synthetic reliability observer', handler: async invocation => {
    const { agent } = invocation
    if (!owned(agent)) return { kind: 'error', text: 'Not an owned experiment session' }
    if (invocation.rawInput.trim() === 'seed') {
      // Fixture data, not a model evaluation result. Only the real native
      // command or engine under test performs the subsequent replacement.
      const turn = Math.max(0, ...agent.session.snapshotEvents().filter(event => event.type === 'turn/start').map(event => event.data.turn)) + 1
      agent.session.append('turn/start', { turn })
      agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic reliability history. Exact marker RELIABILITY_91543.' }] }), { surfaceOp: 'append' })
      for (let step = 1; step <= 18; step++) {
        agent.session.append('step/start', { turn, step })
        agent.session.append('assistant/message', { turn, step, message: createAssistantMessage({ source: { provider: 'fixture', model: 'synthetic' }, content: [{ type: 'text', text: `Recorded fact ${step}: RELIABILITY_91543. ` + 'Historical synthetic observation; preserve original evidence. '.repeat(40) }] }) }, { surfaceOp: 'append' })
        agent.session.append('step/end', { turn, step })
      }
      agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      await ctx.sessions.flush(agent.session)
    }
    return { kind: 'success', text: JSON.stringify(await snapshot(agent, invocation.rawInput.trim())) }
  } })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (owned(agent)) await snapshot(agent, 'after-pre-step')
    return decision
  })
  ctx.on('llm/stream', async function* (request, next) {
    const session = ctx.sessions.get(request.sessionId)
    if (!session?.header.cwd?.includes('dsh-context-reliability-web-')) throw new Error('Unexpected model request outside owned reliability sessions')
    if (request.provider !== 'opencode-go-muse' || request.model !== 'muse-spark-1.3-contributor' || request.reasoningEffort !== 'minimal') throw new Error('Model route/effort mismatch')
    const startedAt = Date.now()
    log({ kind: 'stream-start', sessionId: session.id, provider: request.provider, model: request.model, effort: request.reasoningEffort, purpose: request.purpose ?? 'agent', startedAt, tools: request.tools?.map(tool => tool.name) ?? [] })
    try { for await (const chunk of next()) { if (chunk.type === 'usage') log({ kind: 'usage', sessionId: session.id, startedAt, usage: chunk.usage }); yield chunk } }
    finally { log({ kind: 'stream-end', sessionId: session.id, startedAt, elapsedMs: Date.now() - startedAt }) }
  })
  ctx.tools?.guard?.(exec => owned(exec.agent) ? 'This reliability smoke uses native commands and no model tools.' : undefined)
}
