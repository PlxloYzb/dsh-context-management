// Turnover orchestration audit: for every window turnover in retained runs,
// report the trigger, whether a model handoff was used or the seed was
// extractive, whether the seed was truncated/incomplete, how many steps elapsed
// between the last nudge and the commit, and the assembly byte budget used.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { observedEvents } from './local/observed-events.mjs'

const night = resolve('.test-runtime/nightly-20260915')
const dirs = (await readdir(night, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)
const turnovers = []
for (const dir of dirs) {
  let meta
  try { meta = JSON.parse(await readFile(join(night, dir, 'summary.json'), 'utf8')) } catch { continue }
  if (!meta.sessionId) continue
  let events
  try { events = await observedEvents(join(night, dir, 'observed'), meta.sessionId) } catch { continue }
  // Index nudges and step boundaries so a turnover can be placed in its turn.
  const nudges = new Set()
  for (const event of events) {
    const text = JSON.stringify(event.data ?? {})
    if (event.type === 'user/message' && /compressible ranges|context maintenance|ARC/i.test(text)) nudges.add(event.seq)
  }
  let step = 0
  const stepAt = new Map()
  for (const event of events) {
    if (event.type === 'step/start') step += 1
    stepAt.set(event.seq, step)
  }
  // Fork runs inherit their parent's turnovers; only score the events this run
  // actually produced.
  const ownFrom = meta.fork?.throughSeq ?? -1
  const newContextCalls = events.filter(e => e.type === 'tool/call' && e.data?.name === 'new_context')
  const handoffBytes = newContextCalls.reduce((n, e) => {
    try { return n + Buffer.byteLength(String(JSON.parse(e.data.arguments ?? '{}').handoff ?? '')) } catch { return n }
  }, 0)
  for (const event of events) {
    if (event.type !== 'compaction/summary') continue
    if (event.seq <= ownFrom) continue
    const cm = event.data?.contextManagement
    if (cm === undefined) continue // in-place block, not a window turnover
    const summarySeqs = new Set(events.filter(e => e.type === 'compaction/summary').map(e => e.seq))
    const replacement = events.find(e => e.type === 'user/message' && e.data?.source?.compactionId === (cm.operationId ?? event.data?.compactionId))
    const seedBytes = replacement ? Buffer.byteLength(JSON.stringify(replacement.data?.message?.content ?? replacement.data?.content ?? '')) : null
    const lastNudge = [...nudges].filter(seq => seq < event.seq).pop() ?? null
    turnovers.push({
      run: dir, candidate: (meta.candidateHash ?? '').slice(0, 8),
      seq: event.seq, step: stepAt.get(event.seq) ?? null,
      generationAfter: cm.generationAfter ?? null, trigger: cm.trigger ?? null,
      seedMode: cm.seed?.mode ?? null, seedIncomplete: cm.seed?.incomplete ?? null,
      stepsSinceNudge: lastNudge === null ? null : (stepAt.get(event.seq) ?? 0) - (stepAt.get(lastNudge) ?? 0),
      replacementBytes: seedBytes, summarySeqsKnown: summarySeqs.size > 0,
      strategy: meta.arm,
    })
  }
}
const perRun = []
for (const dir of dirs) {
  const rows = turnovers.filter(t => t.run === dir)
  if (!rows.length) continue
  let meta = null
  try { meta = JSON.parse(await readFile(join(night, dir, 'summary.json'), 'utf8')) } catch { /* ignore */ }
  let events = []
  try { events = await observedEvents(join(night, dir, 'observed'), meta.sessionId) } catch { /* ignore */ }
  const ownFrom = meta?.fork?.throughSeq ?? -1
  const own = events.filter(e => e.type === 'tool/call' && e.data?.name === 'new_context' && e.seq > ownFrom)
  perRun.push({
    run: dir, arm: meta?.arm ?? null, turnoverPrep: meta?.turnoverPrep ?? null,
    newTurnovers: rows.length,
    modelAssisted: rows.filter(t => t.seedMode === 'model-assisted').length,
    extractive: rows.filter(t => t.seedMode === 'extractive').length,
    incompleteSeeds: rows.filter(t => t.seedIncomplete === true).length,
    newContextCalls: own.filter(e => e.seq > ownFrom).length,
    handoffBytes: own.reduce((n, e) => { try { return n + Buffer.byteLength(String(JSON.parse(e.data.arguments ?? '{}').handoff ?? '')) } catch { return n } }, 0),
  })
}
const windowed = turnovers.filter(t => t.strategy !== 'B_IN_PLACE')
const byMode = {}
for (const t of windowed) byMode[`${t.trigger}/${t.seedMode}`] = (byMode[`${t.trigger}/${t.seedMode}`] ?? 0) + 1
const report = {
  schemaVersion: 1, kind: 'offline-turnover-orchestration-audit',
  windowTurnovers: windowed.length,
  inPlaceBlocks: turnovers.length - windowed.length,
  byTriggerAndSeedMode: byMode,
  extractiveShare: windowed.length ? Number((windowed.filter(t => t.seedMode === 'extractive').length / windowed.length).toFixed(3)) : 0,
  incompleteSeeds: windowed.filter(t => t.seedIncomplete === true).length,
  withNudgeBefore: windowed.filter(t => t.stepsSinceNudge !== null).length,
  stepsSinceNudge: windowed.filter(t => t.stepsSinceNudge !== null).map(t => t.stepsSinceNudge).sort((a, b) => a - b),
  rows: windowed,
  perRun,
}
await writeFile(join(night, 'turnover-orchestration-audit.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({
  windowTurnovers: report.windowTurnovers, inPlaceBlocks: report.inPlaceBlocks,
  byTriggerAndSeedMode: report.byTriggerAndSeedMode, extractiveShare: report.extractiveShare,
  incompleteSeeds: report.incompleteSeeds, withNudgeBefore: report.withNudgeBefore,
  stepsSinceNudge: report.stepsSinceNudge,
}))
for (const row of report.perRun) console.log(JSON.stringify(row))
