// Isolated-test instrumentation. Does not alter candidate behavior or write preset files.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { symbols } from '@deepseek-ai/cordis'

export const inject = ['agentPresets', 'tokenMeter', 'sessionProjections']

export function apply(ctx, config) {
  const output = config.output
  mkdirSync(output, { recursive: true })
  const owned = new Set(), basicMounts = new Map()
  ctx.on('agent/created', ({ agent }) => {
    // Only synthetic benchmark sessions in their own temporary workspace.
    if (!String(agent.session.header.cwd ?? '').includes('dsh-context-corpus-')) return
    owned.add(agent.session.id)
    if (config.arm !== 'A') return
    const service = ctx.agentPresets.serviceFor(agent, 'compaction')
    const basic = service?.[symbols.original] ?? service
    if (basic?.constructor.name !== 'BasicCompactionEngine') throw new Error('Basic control arm has a foreign backend')
    const fiber = basic.ctx.fiber
    let update = basicMounts.get(fiber)
    if (!update) {
      update = fiber.update({ ...fiber.config, auto: true, thresholdRatio: 0.018432, retainTokens: 4096, maxTokens: 8192, compactionRetries: 1 }, true)
      basicMounts.set(fiber, update)
    }
    agent.ctx.on('agent/pre-step', async (_payload, next) => { await update; return next() })
    agent.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), maxTokens: 8192 }))
  })
  ctx.on('agent/pre-step', async ({ agent, step, turn }, next) => {
    const decision = await next()
    if (owned.has(agent.session.id) || String(agent.session.header.cwd ?? '').includes('dsh-context-corpus-')) {
      const backend = ctx.agentPresets.serviceFor(agent, 'compaction')
      const measurement = ctx.tokenMeter.measure(agent.session)
      appendFileSync(join(output, `${agent.session.id}.pressure.jsonl`), JSON.stringify({
        time: new Date().toISOString(), seq: agent.session.seq, turn, step,
        backend: backend?.constructor.name, effectiveConfig: backend?.config?.thresholdRatio === undefined ? null : backend.config,
        heuristicInput: measurement.totalTokens, baseline: measurement.baseline.kind,
        contextPressure: ctx.sessionProjections.snapshot(agent.session).values.contextPressure,
        replaceGeneration: agent.session.surface.replaceGeneration,
      }) + '\n')
    }
    return decision
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end' && (owned.has(session.id) || String(session.header.cwd ?? '').includes('dsh-context-corpus-'))) {
      writeFileSync(join(output, `${session.id}.events.json`), JSON.stringify(session.snapshotEvents()))
    }
  })
}
