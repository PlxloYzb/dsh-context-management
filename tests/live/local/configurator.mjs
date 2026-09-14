// Explicit arm configuration, separate from the request observer.
import { symbols } from '@deepseek-ai/cordis'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
export const inject = ['agentPresets']
export function apply(ctx, config) {
  mkdirSync(config.output, { recursive: true })
  const mounts = new Map()
  ctx.on('agent/created', ({ agent }) => {
    if (!String(agent.session.header.cwd ?? '').includes('dsh-context-experiment-')) return
    if (config.arm !== 'C400_WINDOWED') {
      const service = ctx.agentPresets.serviceFor(agent, 'compaction')
      const backend = service?.[symbols.original] ?? service
      if (backend?.constructor.name !== 'BasicCompactionEngine') throw new Error('Native experiment arm resolved a foreign compaction backend')
      let settled = mounts.get(backend.ctx.fiber)
      if (!settled) {
        const original = backend.ctx.fiber.config
        const { retainTokens: _retention, ...base } = original
        settled = backend.ctx.fiber.update({ ...base, auto: true, thresholdRatio: config.arm === 'A_NATIVE' ? 0.8 : config.basicRatio,
          retainRatio: 0.16, maxTokens: 8192 }, true)
        mounts.set(backend.ctx.fiber, settled)
      }
      agent.ctx.on('agent/pre-step', async (_payload, next) => { await settled; return next() })
    }
    agent.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), maxTokens: config.mainMaxTokens }))
    appendFileSync(join(config.output, 'configuration-events.jsonl'), JSON.stringify({ time: new Date().toISOString(), sessionId: agent.session.id,
      arm: config.arm, mainMaxTokens: config.mainMaxTokens, basicRatio: config.arm === 'A_NATIVE' ? 0.8 : config.basicRatio ?? null }) + '\n')
  })
}
