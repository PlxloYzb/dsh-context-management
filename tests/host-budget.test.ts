import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, type EpochHeader } from '@deepseek-ai/dsh-session'
import { inputPressure } from '../src/host-budget.ts'

test('Equivalent assembled headers keep the validated usage projection; changed route or tools use conservative pricing', () => {
  const session = Session.create('equivalent-envelope'), ctx = new Context()
  // DSH 0.1.7 retired `EpochHeader.system`: the system prompt is a system/message
  // event that the host's own projection already prices, so it is no longer a
  // header dimension a proposed request can differ in. Route and tools still are.
  // An empty tool list is omitted rather than stated, which the host enforces.
  const header: EpochHeader = { config: { provider:'synthetic', model:'large', maxTokens:8192 } }
  session.append('request/header', { header })
  const observed: Array<EpochHeader | undefined> = []
  ctx.provide('tokenMeter', { measure: (_session: Session, override?: EpochHeader) => {
    observed.push(override)
    return { logRevision:session.seq, totalTokens:20546, baseline:{kind:'usage'} }
  } } as never)
  ctx.provide('sessionProjections', { snapshot: () => ({values:{contextPressure:{projectedTokens:18547}}}) } as never)
  assert.deepEqual(inputPressure(ctx,session,structuredClone(header)),inputPressure(ctx,session))
  assert.equal(inputPressure(ctx,session,structuredClone(header))?.projectedTokens,18547)
  assert.equal(observed[0],undefined)
  assert.equal(inputPressure(ctx,session,{...header,config:{...header.config,model:'small'}})?.projectedTokens,20546)
  assert.equal(inputPressure(ctx,session,{...header,tools:[{name:'new_tool',description:'New tool',parameters:{type:'object',properties:{}}}]})?.source,'meter-conservative')
})

// X01 T-1/T/T+1: an envelope that exactly fits must be allowed.
//
// `assertEnvelopeFits` refuses an envelope larger than the budget. The boundary was
// never bracketed, so an off-by-one here would refuse a route that fits exactly —
// the failure mode is a spurious CONTEXT_ENVELOPE_TOO_LARGE, not a crash, which is
// why it can hide.
test('host-budget: the envelope boundary is exact at T-1/T/T+1', async () => {
  const { assertEnvelopeFits } = await import('../src/host-budget.ts')
  const budget = 4096
  // Exactly at the budget fits.
  assert.doesNotThrow(() => assertEnvelopeFits({ envelopeTokens: budget }, budget))
  // One below fits.
  assert.doesNotThrow(() => assertEnvelopeFits({ envelopeTokens: budget - 1 }, budget))
  // One above is refused, by name.
  assert.throws(() => assertEnvelopeFits({ envelopeTokens: budget + 1 }, budget), /context-envelope-too-large/)
  // No envelope measurement at all is not an envelope problem.
  assert.doesNotThrow(() => assertEnvelopeFits(null, budget))
  assert.doesNotThrow(() => assertEnvelopeFits({}, budget))
})

// X15 malformed usage: a bad host projection must degrade to conservative pricing,
// never be trusted.
//
// The long campaign recorded `unknownUsageCalls: 0` for its whole duration, so this
// branch was never fed. It matters because the projection feeds the pressure gate:
// a NaN or negative `projectedTokens` compares false against every threshold, so
// trusting one would silently stop compaction from ever firing while the context
// kept growing. The plugin must refuse the reading and price conservatively instead.
test('host-budget: a malformed projection degrades to conservative pricing', () => {
  const build = (projectedTokens: unknown, baseline: { kind: string } = { kind: 'usage' }) => {
    const session = Session.create('malformed'), ctx = new Context()
    ctx.provide('tokenMeter', { measure: () => ({ logRevision: session.seq, totalTokens: 20546, surfaceTokens: 2046, baseline }) } as never)
    ctx.provide('sessionProjections', { snapshot: () => ({ values: { contextPressure: { projectedTokens } } }) } as never)
    return { session, ctx }
  }
  for (const bad of [NaN, Infinity, -Infinity, -1, '18547', null, undefined, {}]) {
    const { session, ctx } = build(bad)
    const pressure = inputPressure(ctx, session)
    assert.equal(pressure?.source, 'meter-conservative', `${String(bad)} must not be trusted as a projection`)
    assert.equal(pressure?.projectedTokens, 20546, 'conservative pricing uses the meter total')
  }
  // A well-formed projection is still used, so the guard is not refusing everything.
  const { session, ctx } = build(18547)
  assert.equal(inputPressure(ctx, session)?.source, 'host-projection')
  assert.equal(inputPressure(ctx, session)?.projectedTokens, 18547)

  // A stale measurement is not a usable reading at all.
  const stale = Session.create('stale'), staleCtx = new Context()
  staleCtx.provide('tokenMeter', { measure: () => ({ logRevision: stale.seq + 1, totalTokens: 1, surfaceTokens: 0, baseline: { kind: 'usage' } }) } as never)
  assert.throws(() => inputPressure(staleCtx, stale), /stale/)

  // Without a usage baseline the envelope is total minus surface, clamped at zero.
  const over = Session.create('over'), overCtx = new Context()
  overCtx.provide('tokenMeter', { measure: () => ({ logRevision: over.seq, totalTokens: 100, surfaceTokens: 400, baseline: { kind: 'estimate' } }) } as never)
  assert.equal(inputPressure(overCtx, over)?.envelopeTokens, 0, 'a negative envelope is clamped, never passed through')
})
