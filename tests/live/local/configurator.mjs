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
        // A_NATIVE keeps the shipped 80% default unless the run asks for a
        // matched-ratio fight: then Basic triggers at the same pressure the
        // plugin arms operate at and keeps the same absolute post-turnover
        // budget, so the comparison is compaction-vs-compaction rather than
        // compaction-vs-nothing. Both ratios are fractions of the model window,
        // so the runner derives them from the plugin's own governor config.
        const matched = config.arm === 'A_NATIVE' && config.matchedNative === true
        settled = backend.ctx.fiber.update({ ...base, auto: true,
          thresholdRatio: matched ? config.basicRatio : 0.8,
          retainRatio: matched && config.matchedRetainRatio !== undefined ? config.matchedRetainRatio : 0.16,
          maxTokens: 8192 }, true)
        mounts.set(backend.ctx.fiber, settled)
      }
      agent.ctx.on('agent/pre-step', async (_payload, next) => { await settled; return next() })
    }
    agent.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), maxTokens: config.mainMaxTokens }))
    appendFileSync(join(config.output, 'configuration-events.jsonl'), JSON.stringify({ time: new Date().toISOString(), sessionId: agent.session.id,
      arm: config.arm, mainMaxTokens: config.mainMaxTokens, matchedNative: config.matchedNative === true,
      thresholdRatio: config.arm === 'A_NATIVE' && config.matchedNative !== true ? 0.8 : config.basicRatio ?? null,
      retainRatio: config.arm === 'A_NATIVE' && config.matchedNative === true ? config.matchedRetainRatio ?? 0.16 : 0.16 }) + '\n')
  })
}
