import type { Context } from '@deepseek-ai/cordis'
import { headerEquals, type Session, type EpochHeader } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'

export interface Meter {
  measure(session: Session, header?: EpochHeader): TokenMeasurement
}
export interface InputPressure { projectedTokens: number; source: 'host-projection' | 'meter-conservative'; logRevision: number }
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
  return { projectedTokens: measurement.totalTokens, source: 'meter-conservative', logRevision: measurement.logRevision }
}
