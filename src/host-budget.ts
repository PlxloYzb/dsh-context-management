import type { Context } from '@deepseek-ai/cordis'
import { headerEquals, type Session, type EpochHeader } from '@deepseek-ai/dsh-session'
import { ContextManagementError } from './errors.ts'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'

export interface Meter {
  measure(session: Session, header?: EpochHeader): TokenMeasurement
}
export interface InputPressure { envelopeTokens?: number; projectedTokens: number; source: 'host-projection' | 'meter-conservative'; logRevision: number }
/** A display projection is safe only while the meter validates its usage envelope. */
export function inputPressure(ctx: Context, session: Session, header?: EpochHeader): InputPressure | null {
  const meter = ctx.get('tokenMeter') as Meter | undefined
  if (!meter) return null
  const previous = session.requestHeader()
  const changedHeader = header && (!previous || !headerEquals(header, previous)) ? header : undefined
  const measurement = meter.measure(session, changedHeader)
  if (measurement.logRevision !== session.seq) throw new Error('changed: token measurement is stale')
  const projections = ctx.get('sessionProjections') as { snapshot?(session: Session): { values?: { contextPressure?: { projectedTokens?: number } } } } | undefined
  const projected = projections?.snapshot?.(session)?.values?.contextPressure?.projectedTokens
  if (measurement.baseline.kind === 'usage' && changedHeader === undefined && typeof projected === 'number' && Number.isFinite(projected) && projected >= 0) {
    return { projectedTokens: projected, source: 'host-projection', logRevision: measurement.logRevision }
  }
  return { ...(measurement.baseline.kind !== 'usage' ? { envelopeTokens: Math.max(0, measurement.totalTokens - measurement.surfaceTokens) } : {}), projectedTokens: measurement.totalTokens, source: 'meter-conservative', logRevision: measurement.logRevision }
}

/** The host's estimated header price is separate from retained message pressure. */
export function assertEnvelopeFits(input: Pick<InputPressure, 'envelopeTokens'> | null, budget: number): void {
  if (input?.envelopeTokens !== undefined && input.envelopeTokens > budget) {
    throw new ContextManagementError('CONTEXT_ENVELOPE_TOO_LARGE', `context-envelope-too-large: system prompt and tools need ${input.envelopeTokens} tokens; input budget is ${budget}. Increase windowBudgetTokens or reduce enabled tools and system prompts; history compaction cannot make this envelope fit.`)
  }
}
