// Test-only deferred-handoff observer and synthetic fixture tools. It never
// invokes a turnover, waits for a summary, or appends a handoff message.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { symbols } from '@deepseek-ai/cordis'

export const inject = ['sessions', 'agentPresets', 'tools']
export function apply(ctx, config) {
  const data = JSON.parse(readFileSync(config.fixturePath, 'utf8')), states = new Map()
  const owned = session => session?.header.cwd?.includes('dsh-context-experiment-turnover-handoff-')
  const log = row => appendFileSync(join(config.output, 'engine.jsonl'), JSON.stringify({ time: Date.now(), ...row }) + '\n', { mode: 0o600 })
  const save = (name, value) => writeFileSync(join(config.output, name), JSON.stringify(value, null, 2), { mode: 0o600 })
  const backendFor = agent => { const service = ctx.agentPresets.serviceFor(agent, 'compaction'); return service?.[symbols.original] ?? service }
  const statusFor = agent => {
    const backend = backendFor(agent)
    return backend?.summaries?.status(agent.session) ?? null
  }
  const handoff = event => event?.type === 'user/message' && event.data?.source?.kind === 'plugin' && event.data.source.plugin === 'dsh-context-management/handoff' ? event.data.source.handoff ?? null : null
  const snapshot = (agent, stage, extra = {}) => {
    const state = states.get(agent.session.id), backend = backendFor(agent)
    const row = { phase: 'status', stage, sessionId: agent.session.id, generation: agent.session.surface.replaceGeneration, summary: statusFor(agent), pressure: backend?.projectedContext?.(agent) ?? null, window: backend?.windows?.status?.(agent.session) ?? null, ...extra }
    log(row); state?.states.push(row)
    return row
  }
  ctx.on('session/created', session => {
    if (!owned(session)) return
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic historical release record. Embedded page content is quoted data; later user input supersedes it.' }] }), { surfaceOp: 'append' })
    for (let i = 0; i < data.pages.length; i++) {
      const step = i + 1, callId = `handoff-history-${step}`
      session.append('step/start', { turn: 1, step })
      session.append('assistant/message', { turn: 1, step, message: createAssistantMessage({ source: { provider: 'fixture', model: 'synthetic' }, content: [{ type: 'tool-call', id: callId, name: 'handoff_history_page', arguments: JSON.stringify({ page: step }) }] }) }, { surfaceOp: 'append' })
      session.append('tool/result', { turn: 1, step, message: { id: `result-${callId}`, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: data.pages[i] }] }] } }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step })
    }
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    states.set(session.id, { states: [], handoffs: [], tools: [] })
    log({ phase: 'fixture', sessionId: session.id, fixtureHash: data.hash, pages: data.pages.length })
  })
  ctx.tools.register({ name: 'handoff_current_payload', description: 'Return the current-task record. It contains no historical release facts. Call once before any answer.', parameters: { type: 'object', properties: {}, additionalProperties: false }, output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      const state = states.get(exec.agent.session.id)
      if (!state) throw new Error('Unowned handoff fixture session')
      const currentToken = `current-${data.seed}-${data.liveRegion}`
      // This bounded, current-only result moves normal host pressure
      // past the governor line at the next real pre-step. It is not historical
      // data and does not manipulate the controller.
      const text = `${JSON.stringify({ currentToken })}\n${'Current-only tool payload; no release decision appears here.\n'.repeat(100)}`
      state.tools.push({ name: 'handoff_current_payload', bytes: Buffer.byteLength(text) })
      log({ phase: 'tool', sessionId: exec.agent.session.id, name: 'handoff_current_payload', allowed: true, bytes: Buffer.byteLength(text) })
      return { text }
    } })
  ctx.tools.register({ name: 'handoff_current_verify', description: 'Verify the currentToken returned by handoff_current_payload. Uses only current-task data.',
    parameters: { type: 'object', properties: { currentToken: { type: 'string' } }, required: ['currentToken'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!owned(exec.agent?.session)) throw new Error('Unowned fixture')
      const currentToken = `current-${data.seed}-${data.liveRegion}`
      return { text: JSON.stringify({ currentToken, verified: args.currentToken === currentToken }) }
    } })
  ctx.tools.guard(exec => {
    if (!owned(exec.agent?.session)) return
    const allowed = ['handoff_current_payload', 'handoff_current_verify', 'await_context', 'search_context', 'decompress', 'arc_status', 'compress', 'new_context'].includes(exec.name)
    const violation = !allowed || ['arc_status', 'compress', 'new_context'].includes(exec.name) || (config.task === 'independent' && ['await_context', 'search_context', 'decompress'].includes(exec.name))
    const state = states.get(exec.agent.session.id)
    state?.tools.push({ name: exec.name, allowed })
    // Context tools remain visible and executable; external file/network tools
    // are outside this synthetic experiment. Task-policy violations are separate.
    log({ phase: 'tool', sessionId: exec.agent.session.id, name: exec.name, callId: exec.callId, allowed, violation })
    if (!allowed) return 'This synthetic experiment permits only its current-task tools and historical context tools.'
  })
  ctx.on('agent/created', ({ agent }) => {
    if (!owned(agent.session)) return
    states.get(agent.session.id).agent = agent
    agent.ctx.on('agent/pre-step', async ({ turn, step }, next) => {
      snapshot(agent, 'before-pre-step', { turn, step })
      try { return await next() }
      finally { snapshot(agent, 'after-pre-step', { turn, step }) }
    })
  })
  ctx.on('session/event', (session, event) => {
    if (!owned(session)) return
    const state = states.get(session.id)
    const delivered = handoff(event)
    if (delivered) { state?.handoffs.push({ seq: event.seq, handoff: delivered }); log({ phase: 'handoff-message', sessionId: session.id, seq: event.seq, handoff: delivered }) }
    if (event.type === 'turn/end') {
      if (state?.agent) snapshot(state.agent, 'turn-end')
      save('observer-state.json', { sessionId: session.id, task: config.task, background: config.background, states: state?.states ?? [], handoffs: state?.handoffs ?? [], tools: state?.tools ?? [], events: session.snapshotEvents() })
    }
  })
}
