// Native-basic arm configurator. It mounts the untouched shipped Basic
// compaction engine and matches the frozen threshold/retention geometry. It
// never replaces Basic with the plugin and never installs ARC retrieval tools.
import { symbols } from '@deepseek-ai/cordis'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const inject = ['agentPresets']

export function apply(ctx, config) {
  mkdirSync(config.output, { recursive: true })
  const mounts = new Map()
  ctx.on('agent/created', ({ agent }) => {
    if (!String(agent.session.header.cwd ?? '').includes('dsh-context-experiment-')) return
    const service = ctx.agentPresets.serviceFor(agent, 'compaction')
    const backend = service?.[symbols.original] ?? service
    if (backend?.constructor.name !== 'BasicCompactionEngine') {
      throw new Error(`BASIC_MATCHED resolved ${backend?.constructor.name} instead of the shipped native engine`)
    }
    let settled = mounts.get(backend.ctx.fiber)
    if (!settled) {
      const original = backend.ctx.fiber.config
      settled = backend.ctx.fiber.update({ ...original, auto: true, thresholdRatio: config.compaction.thresholdRatio, retainRatio: config.compaction.retainRatio, maxTokens: config.compaction.maxTokens }, true)
      mounts.set(backend.ctx.fiber, settled)
    }
    agent.ctx.on('agent/pre-step', async (_payload, next) => { await settled; return next() })
    agent.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), maxTokens: config.mainMaxTokens }))
    appendFileSync(join(config.output, 'arm-configuration.jsonl'), JSON.stringify({
      time: new Date().toISOString(), sessionId: agent.session.id, arm: config.arm,
      backend: backend.constructor.name, thresholdRatio: config.compaction.thresholdRatio,
      retainRatio: config.compaction.retainRatio, maxTokens: config.compaction.maxTokens,
      thresholdTokens: Math.floor(1048576 * config.compaction.thresholdRatio),
      retainTokens: Math.floor(1048576 * config.compaction.retainRatio),
    }) + '\n', { mode: 0o600 })
  })
}
