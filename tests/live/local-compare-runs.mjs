// Summarise retained local-model runs from their request journals: unique model
// calls, wall time and tokens split by purpose, plus quality and compaction
// counts. No provider calls.
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const night = resolve('.test-runtime/nightly-20260915')
const names = process.argv.slice(2)
if (!names.length) throw new Error('Pass one or more retained run names')
const rows = []
for (const name of names) {
  const root = join(night, name)
  let summary
  try { summary = JSON.parse(await readFile(join(root, 'summary.json'), 'utf8')) } catch { rows.push({ name, error: 'no summary' }); continue }
  let journal = []
  try {
    journal = (await readFile(join(root, 'observed', 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  } catch { /* older runs may lack a journal */ }
  const byCall = new Map()
  for (const row of journal) {
    if (!row.callId) continue
    const entry = byCall.get(row.callId) ?? { purpose: row.purpose ?? 'agent', elapsedMs: 0, tokens: 0 }
    if (row.purpose) entry.purpose = row.purpose
    if (Number.isFinite(row.elapsedMs)) entry.elapsedMs = row.elapsedMs
    const total = row.usage?.totalTokens
    if (Number.isFinite(total)) entry.tokens = total
    byCall.set(row.callId, entry)
  }
  const calls = [...byCall.values()]
  const group = purpose => {
    const selected = calls.filter(call => (purpose === 'agent' ? call.purpose === 'agent' : call.purpose === purpose))
    return { calls: selected.length, seconds: Math.round(selected.reduce((n, c) => n + c.elapsedMs, 0) / 1000), tokens: selected.reduce((n, c) => n + c.tokens, 0) }
  }
  const compaction = calls.filter(call => call.purpose === 'compaction')
  rows.push({
    name, arm: summary.arm, matchedNative: summary.matchedNative === true,
    forked: Boolean(summary.fork), completed: summary.completed === true, error: summary.error ?? null,
    elapsedSeconds: summary.elapsedSeconds ?? null,
    readingPhases: (summary.phases ?? []).map(p => ({ phase: p.phase, seconds: Math.round(p.elapsedMs / 1000), missing: p.missingPages.length })),
    pagesRead: Object.keys(summary.score?.answer ?? {}).length ? undefined : undefined,
    compactions: (summary.compactions ?? []).length,
    facts: summary.score?.factsCorrect ?? null, corrections: summary.score?.correctionsCorrect ?? null,
    deliverablePassed: summary.score?.deliverablePassed ?? null, verbatim: summary.score2?.verbatimCorrect ?? null,
    qualityPassed: summary.allQualityPassed === true,
    model: {
      uniqueCalls: calls.length,
      totalSeconds: Math.round(calls.reduce((n, c) => n + c.elapsedMs, 0) / 1000),
      totalTokens: calls.reduce((n, c) => n + c.tokens, 0),
      agent: group('agent'), compaction: group('compaction'),
      compactionCalls: compaction.length,
      compactionSeconds: Math.round(compaction.reduce((n, c) => n + c.elapsedMs, 0) / 1000),
    },
  })
}
const report = { schemaVersion: 1, kind: 'offline-run-comparison', rows }
await writeFile(join(night, 'run-comparison.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
for (const row of rows) {
  console.log(JSON.stringify({
    name: row.name, arm: row.arm, matched: row.matchedNative, forked: row.forked,
    completed: row.completed, error: row.error, elapsed: row.elapsedSeconds,
    phases: row.readingPhases, compactions: row.compactions,
    facts: row.facts, corrections: row.corrections, verbatim: row.verbatim, quality: row.qualityPassed,
    calls: row.model?.uniqueCalls, modelSeconds: row.model?.totalSeconds, tokens: row.model?.totalTokens,
    compactionCalls: row.model?.compactionCalls, compactionSeconds: row.model?.compactionSeconds,
  }))
}
