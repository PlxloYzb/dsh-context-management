#!/usr/bin/env node
// X18 scale: the plugin's own passes over sessions of 1k / 10k / 50k events.
//
// This is deliberately NOT a host-integration measurement. A host session's content
// enters through model turns, so driving 50k events through a real host would need a
// model call per event; what is measured here is the plugin's own algorithms over a
// session of that size, in process. That is where scale defects live — a quadratic
// scan in the region/ledger passes is invisible at 288 pages and fatal at 50k events —
// and it is the part a dose harness can honestly cover. Host-level cost at scale
// remains unmeasured and is reported as such.
import { Session } from '@deepseek-ai/dsh-session'
import { buildCompressibleSeqRanges, rebuildBlockLedger, protectedSystemHead } from '../../../src/region.ts'
import { sourceHash } from '../../../src/background-summary.ts'
import { appendUser, appendAssistant } from '../../helpers.ts'

function buildSession(events) {
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

function timed(fn) {
  const before = process.memoryUsage().heapUsed
  const started = process.hrtime.bigint()
  const value = fn()
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  return { ms, heapDelta: process.memoryUsage().heapUsed - before, value }
}

export function measureScale({ events }) {
  global.gc?.()
  const build = timed(() => buildSession(events))
  const session = build.value
  const ranges = timed(() => buildCompressibleSeqRanges(session))
  const ledger = timed(() => rebuildBlockLedger(session.snapshotEvents()))
  const seqs = [...session.surface.nodes].slice(0, 64)
  const hash = timed(() => sourceHash(session, seqs))
  const head = timed(() => protectedSystemHead(session))
  return {
    events, actualSeq: session.seq,
    buildMs: build.ms,
    rangesMs: ranges.ms, ranges: ranges.value.length,
    ledgerMs: ledger.ms, ledgerBlocks: ledger.value.length,
    hashMs: hash.ms, hash: hash.value.slice(0, 12),
    headMs: head.ms, headSeq: head.value ?? null,
    totalPassMs: ranges.ms + ledger.ms + hash.ms + head.ms,
  }
}

/**
 * Twenty real session lifecycles, dropped between rounds.
 *
 * The previous implementation of this variant allocated Maps in the RECORDER's
 * process and sampled its own heap, so it measured nothing about the plugin. This
 * builds and drops twenty genuine plugin sessions instead.
 */
export function measureCreateDispose({ sessions = 20, events = 1000 }) {
  global.gc?.()
  const heap = []
  for (let round = 1; round <= sessions; round++) {
    let session = buildSession(events)
    rebuildBlockLedger(session.snapshotEvents())
    buildCompressibleSeqRanges(session)
    session = null
    if (round <= 5 || round > sessions - 4) { global.gc?.(); heap.push({ round, heapUsed: process.memoryUsage().heapUsed }) }
  }
  const baseline = heap.filter(row => row.round <= 5).map(row => row.heapUsed).sort((a, b) => a - b)[2]
  const final = heap.filter(row => row.round > sessions - 4).map(row => row.heapUsed).sort((a, b) => a - b)[2]
  const growth = final - baseline
  const allowed = Math.max(48 * 1024 * 1024, baseline * 0.25)
  return { sessions, events, baseline, final, growth, allowed, passed: growth <= allowed, sample: heap }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const rows = []
  for (const events of [1000, 10000, 50000]) rows.push(measureScale({ events }))
  console.log(JSON.stringify({ scale: rows, createDispose: measureCreateDispose({}) }, null, 2))
}
