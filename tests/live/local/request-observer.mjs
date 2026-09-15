// Captures real host requests, including auxiliary calls. It never rewrites content/configuration.
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { verifyRequestRoute } from './protocol.mjs'
import { reserveCall, recordUsage } from './limits.mjs'
export const inject = ['llm', 'sessions', 'agentPresets', 'tokenMeter', 'sessionProjections']
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function apply(ctx, config) {
  mkdirSync(config.output, { recursive: true })
  const owned = session => String(session?.header.cwd ?? '').includes('dsh-context-experiment-')
  const objectRoot = join(config.output, 'objects')
  mkdirSync(objectRoot, { recursive: true })
  const objectRef = value => {
    const digest = hash(value)
    const path = join(objectRoot, `${digest}.json`)
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    return digest
  }
  const append = (name, row) => appendFileSync(join(config.output, name), JSON.stringify(row) + '\n', { mode: 0o600 })
  const observedSessions = new Set()
  const snapshot = session => {
    writeFileSync(join(config.output, `${session.id}.events.json`), JSON.stringify(session.snapshotEvents()), { mode: 0o600 })
    observedSessions.add(session.id)
  }
  ctx.on('session/created', session => { if (owned(session)) snapshot(session) })
  const pressure = (agent, stage, extra = {}) => {
    const measurement = ctx.tokenMeter.measure(agent.session)
    const backend = ctx.agentPresets.serviceFor(agent, 'compaction')
    append(`${agent.session.id}.pressure.jsonl`, { time: new Date().toISOString(), stage, seq: agent.session.seq, backend: backend?.constructor.name,
      backgroundSummary: backend?.summaries?.status(agent.session) ?? null,
      effectiveBasicConfig: backend?.config?.thresholdRatio === undefined ? null : backend.config,
      hostEstimatedInput: measurement.totalTokens, baseline: measurement.baseline.kind,
      contextPressure: ctx.sessionProjections.snapshot(agent.session).values.contextPressure,
      replaceGeneration: agent.session.surface.replaceGeneration, ...extra })
  }
  ctx.on('agent/pre-step', async ({ agent, step, turn }, next) => {
    if (!owned(agent.session)) return next()
    pressure(agent, 'before-pre-step', { step, turn })
    try { return await next() }
    finally { pressure(agent, 'after-pre-step', { step, turn }) }
  })
  ctx.on('llm/stream', async function* (request, next) {
    const session = request.sessionId && ctx.sessions.get(request.sessionId)
    if (!owned(session)) throw new Error('Experiment observer refuses unattributed generation in its isolated host')
    const callId = randomUUID(), start = Date.now()
    const info = await ctx.llm.resolveModelInfo(request.provider, request.model)
    const effectiveReasoningEffort = request.reasoningEffort ?? info.reasoning?.defaultEffort ?? null
    if (config.route.reasoningEffort && effectiveReasoningEffort !== config.route.reasoningEffort) throw new Error('Experiment reasoning effort differs from the frozen route')
    const expectedCapacity = config.expectedContextWindow ?? 1000000
    if (info.context?.contextWindow !== expectedCapacity) throw new Error(`EXPERIMENT_CAPACITY_CHANGED: expected ${expectedCapacity}, route reports ${info.context?.contextWindow}`)
    const record = { callId, time: new Date().toISOString(), startedAtMs: start, sessionId: session.id, seq: session.seq, provider: request.provider, model: request.model,
      purpose: request.purpose ?? 'agent', maxTokens: request.maxTokens ?? null, reasoningEffort: request.reasoningEffort ?? null, effectiveReasoningEffort,
      requestHash: hash({ ...request, signal: undefined }), messagesHash: hash(request.messages), systemHash: hash(request.system ?? null),
      toolsHash: hash(request.tools ?? null), tools: request.tools?.map(tool => tool.name) ?? [], messageCount: request.messages.length }
    append('requests.jsonl', { ...record, phase: 'before-route-guard' })
    verifyRequestRoute(request, config.route)
    if (!request.purpose && request.maxTokens !== config.mainMaxTokens) throw new Error('Experiment main request output cap differs from frozen configuration')
    append(`${session.id}.provider-messages.jsonl`, { callId, seq: session.seq, purpose: record.purpose, provider: request.provider, model: request.model,
      maxTokens: request.maxTokens, systemRef: objectRef(request.system ?? null), toolsRef: objectRef(request.tools ?? null), messageRefs: request.messages.map(objectRef) })
    if (config.budgetRoot) reserveCall(config.budgetRoot, callId, { sessionId: session.id, purpose: record.purpose })
    append('requests.jsonl', { callId, phase: 'dispatched', time: new Date().toISOString() })
    let terminal = false, firstContentMs = null
    const outputCharacters = { reasoning: 0, text: 0, arguments: 0 }
    const timing = () => ({ firstContentMs, outputCharacters: { ...outputCharacters } })
    try {
      for await (const chunk of next()) {
        const field = chunk.type === 'reasoning-delta' ? 'reasoning' : chunk.type === 'text-delta' ? 'text' : null
        if (field && typeof chunk.text === 'string') {
          outputCharacters[field] += chunk.text.length
          if (firstContentMs === null) {
            firstContentMs = Date.now() - start
            append('requests.jsonl', { callId, phase: 'first-content', firstContentMs })
          }
        }
        if (chunk.type === 'tool-call-delta' && typeof chunk.argumentsDelta === 'string') {
          outputCharacters.arguments += chunk.argumentsDelta.length
          if (firstContentMs === null) {
            firstContentMs = Date.now() - start
            append('requests.jsonl', { callId, phase: 'first-content', firstContentMs })
          }
        }
        if (chunk.type === 'usage') {
          append('requests.jsonl', { callId, phase: 'usage', usage: chunk.usage })
          if (config.budgetRoot) recordUsage(config.budgetRoot, callId, chunk.usage)
        }
        if (chunk.type === 'finish') {
          terminal = true
          append('requests.jsonl', { callId, phase: 'finish', endedAtMs: Date.now(), elapsedMs: Date.now() - start, reason: chunk.reason, ...timing() })
        }
        yield chunk
      }
    } finally {
      if (!terminal) append('requests.jsonl', { callId, phase: 'incomplete-stream', endedAtMs: Date.now(), elapsedMs: Date.now() - start, ...timing() })
    }
  })
  ctx.on('session/event', (session, event) => {
    if (!owned(session)) return
    append(`${session.id}.events.jsonl`, event)
    if (!observedSessions.has(session.id) || event.type === 'model/selection' || event.type === 'turn/end' || event.type === 'command/done') snapshot(session)
  })
}
