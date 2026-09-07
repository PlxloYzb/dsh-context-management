import { Context } from '@deepseek-ai/cordis'
import { defaultCountTokens } from 'acp-kernel'
import type { Session } from '@deepseek-ai/dsh-session'
import { extractEventText } from '../src/messages.ts'

/** Policy-only mock. Real meter/JSONL/loop tests use their actual host services. */
export function testContext(flush: () => Promise<void> = async () => {}): Context {
  const ctx = new Context()
  ctx.provide('sessionPersistence', { testDouble: true } as never)
  ctx.provide('sessions', { flush } as never)
  ctx.provide('tokenMeter', {
    measure(session: Session) {
      const nodes = session.surface.nodes.map(seq => {
        const tokens = defaultCountTokens(extractEventText(session.snapshotEvents()[seq]!))
        return { seq, tokens, heuristicTokens: tokens }
      })
      const surfaceTokens = nodes.reduce((sum, n) => sum + n.tokens, 0)
      const projection = ctx.get('sessionProjections') as { snapshot?(session: Session): {values?: {contextPressure?: {projectedTokens?: number}}} } | undefined
      const projected = projection?.snapshot?.(session)?.values?.contextPressure?.projectedTokens
      return { nodes, surfaceTokens, totalTokens: projected ?? surfaceTokens, logRevision: session.seq, surfaceDeltaTokens: 0, baseline: { kind: projected === undefined ? 'estimated' : 'usage', tokens: surfaceTokens } }
    },
    estimateMessage: (message: unknown) => Math.ceil(JSON.stringify(message).length / 4),
  } as never)
  return ctx
}
