// Observe the installed engine; this plugin never requests or commits a turnover.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { symbols } from '@deepseek-ai/cordis'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
export const inject = ['llm', 'sessions', 'agentPresets', 'tools', 'tokenMeter']
export function apply(ctx, config) {
  const data = JSON.parse(readFileSync(config.fixturePath, 'utf8')), states = new Map()
  const owned = session => session?.header.cwd?.includes('dsh-context-experiment-turnover-')
  const phase = () => JSON.parse(readFileSync(join(config.output, 'phase.json'), 'utf8')).phase
  const save = (name, value) => writeFileSync(join(config.output, name), JSON.stringify(value, null, 2), { mode: 0o600 })
  const log = row => appendFileSync(join(config.output, 'engine.jsonl'), JSON.stringify({ time: Date.now(), ...row }) + '\n', { mode: 0o600 })
  const backendFor = agent => { const backend = ctx.agentPresets.serviceFor(agent, 'compaction'); return backend?.[symbols.original] ?? backend }
  const held = new Map()
  if (config.fault === 'late') ctx.on('llm/stream', async function* (request, next) {
    for await (const chunk of next()) {
      if (request.purpose === 'compaction' && chunk.type === 'finish' && owned(ctx.sessions.get(request.sessionId))) {
        log({ phase: 'fault-network-finish', sessionId: request.sessionId, reason: chunk.reason.kind })
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 65000); timer.unref()
          held.set(request.sessionId, () => { clearTimeout(timer); resolve() })
        })
        log({ phase: 'fault-delivery-released', sessionId: request.sessionId })
      }
      yield chunk
    }
  })
  ctx.effect(() => () => { for (const release of held.values()) release(); held.clear() })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (!owned(context.agent?.session) || phase() === 'retrieval') return assembly
    return { ...assembly, tools: assembly.tools.filter(tool => tool.name === 'arc_status') }
  })
  ctx.tools.guard(exec => {
    if (!owned(exec.agent?.session)) return
    const allowed = phase() === 'retrieval' && ['search_context', 'decompress', 'arc_status'].includes(exec.name)
    log({ phase: 'tool', name: exec.name, allowed, sessionId: exec.agent.session.id })
    if (!allowed) return 'This phase permits no tools; answer UNKNOWN for missing facts.'
  })
  ctx.on('session/created', session => {
    if (!owned(session)) return
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic release review. Preserve release decisions and their original evidence. Later user corrections supersede the initial record.' }] }), { surfaceOp: 'append' })
    for (let i = 0; i < data.pages.length; i++) {
      const step = i + 1, id = `synthetic-page-${step}`
      session.append('step/start', { turn: 1, step })
      session.append('assistant/message', { turn: 1, step, message: createAssistantMessage({ source: { provider: 'fixture', model: 'synthetic' }, content: [{ type: 'tool-call', id, name: 'experiment_read_page', arguments: JSON.stringify({ page: step }) }] }) }, { surfaceOp: 'append' })
      session.append('tool/result', { turn: 1, step, message: { id: `result-${id}`, role: 'user', source: { kind: 'tool', callId: id }, content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text: data.pages[i] }] }] } }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step })
    }
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    states.set(session.id, {})
    log({ phase: 'fixture', sessionId: session.id, fixtureHash: data.hash, pages: data.pages.length })
  })
  ctx.on('agent/created', ({ agent }) => {
    if (!owned(agent.session)) return
    states.get(agent.session.id).agent = agent
    agent.ctx.on('agent/request', async (_payload, next) => {
      const result = await next(), backend = backendFor(agent)
      log({ phase: 'request', stage: phase(), configured: backend.backgroundSummary ?? null, summary: backend.summaries.status(agent.session), surfaceNodes: agent.session.surface.nodes.length })
      return result
    })
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const start = performance.now(), before = agent.session.surface.replaceGeneration
      const decision = await next()
      const backend = backendFor(agent)
      log({ phase: 'pre-step', stage: phase(), elapsedMs: performance.now() - start, before, after: agent.session.surface.replaceGeneration, summary: backend?.summaries?.status(agent.session) })
      return decision
    })
  })
  ctx.on('session/event', async (session, event) => {
    if (!owned(session)) return
    if (event.type === 'compaction/end') { held.get(session.id)?.(); held.delete(session.id) }
    if (event.type === 'compaction/summary') save('boundary-metadata.json', { seq: event.seq, data: event.data })
    if (event.type !== 'turn/end' || !states.get(session.id)?.agent) return
    const agent = states.get(session.id).agent, status = await backendFor(agent).contextStatus(agent)
    save(`${phase()}-status.json`, status)
    if (phase() === 'foreground') {
      const pressure = status.budget.pressure.projectedTokens, limit = status.budget.effectiveInputLimit
      const needed = Math.max(0, Math.ceil(limit * 0.94 - pressure))
      const unit = 'Synthetic pressure padding: no new decision or instruction.\n'
      const estimate = n => ctx.tokenMeter.estimateMessage(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: unit.repeat(n) }] }))
      let lo = 0, hi = 10000
      while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (estimate(mid) < needed) lo = mid + 1; else hi = mid }
      save('padding.json', { text: unit.repeat(lo), tokens: estimate(lo), pressure, limit, needed })
    }
    save(`${phase()}-events.json`, session.snapshotEvents())
  })
}
