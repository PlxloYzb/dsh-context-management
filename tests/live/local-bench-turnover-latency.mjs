// Offline turnover latency: how long does the model-free window replacement take
// end to end, including the durability flush, as the history grows? No provider
// calls, no model in the loop.
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { WindowController, resolveArchiveConfig } from '../../src/window-controller.ts'
import { host, newSession, newInput } from '../integration/runtime.ts'
import { appendUser, appendAssistant } from '../helpers.ts'

const night = resolve('.test-runtime/nightly-20260915')
const sizes = [200, 2_000, 20_000]
const stepsPerTurn = 20
const rounds = 5
const report = { schemaVersion: 1, kind: 'offline-turnover-latency', stepsPerTurn, rounds, samples: [] }

const h = await host()
try {
  for (const size of sizes) {
    const times = [], coldTimes = []
    let seedBytes = null, seedIncomplete = null
    for (let round = 0; round < rounds; round++) {
      const session = newSession(h.ctx, `turnover-latency-${size}-${round}`)
      let produced = 0, turn = 0
      while (produced < size) {
        turn += 1
        session.append('turn/start', { turn })
        appendUser(session, `Task update ${turn}: ${'constraint '.repeat(30)}`)
        for (let step = 1; step <= stepsPerTurn && produced < size; step++) {
          session.append('step/start', { turn, step })
          appendAssistant(session, `FACT_${turn}_${step} = verified-${step}.\r\n${'Synthetic telemetry row: status=ok; requirement unchanged. '.repeat(30)}`, turn, step)
          session.append('step/end', { turn, step })
          produced += 1
        }
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
      newInput(session, 'Current user instruction that must be protected')
      const agent = { session, ctx: h.ctx, options: {} }
      // The live plugin measures pressure every step, so the token meter is warm
      // by turnover time. Measure both: cold shows the one-off fold cost.
      const coldStart = performance.now()
      h.ctx.tokenMeter.measure(session)
      const coldMs = performance.now() - coldStart
      const started = performance.now()
      const result = await new WindowController().turnover(agent, 'pressure', new AbortController().signal, resolveArchiveConfig(), async () => { await h.ctx.sessions.flush(session) })
      times.push(performance.now() - started)
      coldTimes.push(coldMs)
      if (result) {
        const replacement = session.surface.nodes
          .map(seq => session.eventAt(seq))
          .find(event => event?.type === 'user/message' && event.data?.source?.compactionId === result.compactionId)
        const raw = replacement?.data?.message?.content ?? replacement?.data?.content ?? ''
        seedBytes = Buffer.byteLength(JSON.stringify(raw))
        seedIncomplete = session.snapshotEvents()
          .map(event => event.type === 'compaction/summary' && event.data.compactionId === result.compactionId ? event.data.contextManagement?.seed?.incomplete : undefined)
          .find(value => value !== undefined) ?? null
      }
    }
    const sorted = [...times].sort((a, b) => a - b)
    report.samples.push({
      messages: size, medianMs: Number(sorted[Math.floor(rounds / 2)].toFixed(3)),
      minMs: Number(sorted[0].toFixed(3)), maxMs: Number(sorted.at(-1).toFixed(3)),
      raw: times.map(value => Number(value.toFixed(3))),
      coldMeasureMs: Number((coldTimes.reduce((n, v) => n + v, 0) / coldTimes.length).toFixed(3)),
      seedBytes, seedIncomplete,
    })
  }
} finally {
  await h.close()
}
await writeFile(join(night, 'turnover-latency.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify(report.samples.map(s => ({ messages: s.messages, medianMs: s.medianMs, maxMs: s.maxMs, seedBytes: s.seedBytes, incomplete: s.seedIncomplete }))))
