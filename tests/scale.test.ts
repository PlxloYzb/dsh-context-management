import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { buildCompressibleSeqRanges, rebuildBlockLedger } from '../src/region.ts'
import { appendUser, appendAssistant } from './helpers.ts'

// X18 scale guard: the region and ledger passes must not be quadratic.
//
// Measured on the plugin's own algorithms, not through a host: 1k/10k/50k events cost
// roughly 1.3/5.3/19.1ms. A quadratic scan would be invisible at the 288-page scale the
// live campaign reached and fatal at 50k events, so the guard asserts the SHAPE of the
// growth rather than an absolute time — absolute times vary by machine, the ratio does
// not. The bound is deliberately loose: it catches a complexity regression, not a slow
// machine.
function build(events: number): Session {
  const session = Session.create(`scale-${events}`)
  let turn = 1
  while (session.seq < events) {
    session.append('turn/start', { turn })
    for (let step = 1; step <= 8 && session.seq < events; step++) {
      session.append('step/start', { turn, step })
      appendUser(session, `Historical record ${turn}.${step}: owner=港口负责人-${turn} value-${turn}-${step} state=active.`)
      appendAssistant(session, `Acknowledged record ${turn}.${step}.`, turn, step)
      session.append('step/end', { turn, step })
    }
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    turn++
  }
  return session
}

function passMs(session: Session): number {
  const started = process.hrtime.bigint()
  buildCompressibleSeqRanges(session)
  rebuildBlockLedger(session.snapshotEvents())
  return Number(process.hrtime.bigint() - started) / 1e6
}

test('X18: the region and ledger passes stay sub-quadratic as the session grows', () => {
  const small = build(1000)
  const large = build(10000)
  passMs(small) // warm the JIT so the ratio is not measuring compilation
  const smallMs = Math.max(passMs(small), 0.05)
  const largeMs = passMs(large)
  const ratio = largeMs / smallMs
  // 10x the events: linear would be ~10x, quadratic ~100x.
  assert.ok(ratio < 30, `10x the events cost ${ratio.toFixed(1)}x the time (${smallMs.toFixed(2)}ms -> ${largeMs.toFixed(2)}ms): that is the shape of a quadratic scan`)
  assert.ok(largeMs < 2000, `10k events took ${largeMs.toFixed(0)}ms`)
})
