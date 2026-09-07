import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, type EpochHeader } from '@deepseek-ai/dsh-session'
import { inputPressure } from '../src/host-budget.ts'

test('Equivalent assembled headers keep the validated usage projection; changed route or system uses conservative pricing', () => {
  const session = Session.create('equivalent-envelope'), ctx = new Context()
  const header: EpochHeader = { config: { provider:'synthetic', model:'large', maxTokens:8192 }, system:'Stable system prompt', tools:[] }
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
  assert.equal(inputPressure(ctx,session,{...header,system:'Changed instructions'})?.source,'meter-conservative')
  assert.equal(inputPressure(ctx,session,{...header,config:{...header.config,model:'small'}})?.projectedTokens,20546)
  assert.equal(inputPressure(ctx,session,{...header,tools:[{name:'new_tool',description:'New tool',parameters:{type:'object',properties:{}}}]})?.source,'meter-conservative')
})
