// Build the matched native-vs-plugin comparison record from retained runs.
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const night = resolve('.test-runtime/nightly-20260915')
const load = async name => {
  const summary = JSON.parse(await readFile(join(night, name, 'summary.json'), 'utf8'))
  let journal = []
  try { journal = (await readFile(join(night, name, 'observed', 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) } catch { /* none */ }
  const byCall = new Map()
  for (const row of journal) {
    if (!row.callId) continue
    const entry = byCall.get(row.callId) ?? { purpose: row.purpose ?? 'agent', elapsedMs: 0, tokens: 0 }
    if (row.purpose) entry.purpose = row.purpose
    if (Number.isFinite(row.elapsedMs)) entry.elapsedMs = row.elapsedMs
    if (Number.isFinite(row.usage?.totalTokens)) entry.tokens = row.usage.totalTokens
    byCall.set(row.callId, entry)
  }
  const calls = [...byCall.values()]
  const sum = (purpose) => calls.filter(c => c.purpose === purpose)
  const total = calls.reduce((n, c) => n + c.elapsedMs, 0)
  const compaction = sum('compaction')
  const tools = new Set(journal.flatMap(row => row.tools ?? []))
  const reading = (summary.phases ?? []).reduce((n, p) => n + p.elapsedMs, 0)
  return {
    name, arm: summary.arm, matchedNative: summary.matchedNative === true,
    geometry: summary.matchedNativeGeometry ?? null,
    completed: summary.completed === true, error: summary.error ?? null,
    elapsedSeconds: summary.elapsedSeconds,
    readingSeconds: Math.round(reading / 1000),
    phases: (summary.phases ?? []).map(p => ({ phase: p.phase, seconds: Math.round(p.elapsedMs / 1000), missing: p.missingPages.length })),
    compactions: (summary.compactions ?? []).length,
    facts: summary.score?.factsCorrect ?? null, corrections: summary.score?.correctionsCorrect ?? null,
    deliverablePassed: summary.score?.deliverablePassed ?? null, verbatim: summary.score2?.verbatimCorrect ?? null,
    qualityPassed: summary.allQualityPassed === true,
    modelCalls: calls.length, modelSeconds: Math.round(total / 1000), modelTokens: calls.reduce((n, c) => n + c.tokens, 0),
    compactionCalls: compaction.length, compactionSeconds: Math.round(compaction.reduce((n, c) => n + c.elapsedMs, 0) / 1000),
    compactionShare: total ? Number((compaction.reduce((n, c) => n + c.elapsedMs, 0) / total).toFixed(3)) : 0,
    historyTools: ['search_context', 'decompress', 'compress', 'arc_status', 'new_context'].filter(t => tools.has(t)),
  }
}

const nativeMatched = [await load('a-matched-f3-91503-24p-r3'), await load('a-matched-f3-91503-24p-r4')]
const nativeDefault = [await load('a-f3-91503-24p-candidate6')]
const plugin = [await load('c10-full-f3-91503-24p'), await load('c-f3-91503-24p-candidate5'), await load('c-f3-91503-24p-candidate6')]
const report = {
  schemaVersion: 1, kind: 'native-basic-vs-plugin-comparison',
  fixture: { family: 'F3', seed: 91503, pages: 24, pressure: 32000, batch: 6, concise: true, hostVersion: '0.1.2-rc.1', route: 'ubuntu-lora/Qwen3.8-27B-NVFP4KV-384K' },
  matchedGeometry: nativeMatched[0].geometry,
  matchedGeometryNote: 'Native Basic threshold 32000 tokens and retain 19555 tokens were derived from the plugin governor (emergency line = pressure; target after turnover = 55% of effective capacity). Ratios are fractions of the 393216 model window. This is a tuned Basic at the plugin operating point, not the shipped 80% default.',
  arms: { nativeMatched, nativeDefault, plugin },
  findings: {
    matchedNativeFinished: `${nativeMatched.filter(r => r.completed).length} of ${nativeMatched.length} matched-native journeys finished`,
    matchedNativeCompactionShare: nativeMatched.map(r => r.compactionShare),
    matchedNativeCompactionSeconds: nativeMatched.map(r => r.compactionSeconds),
    matchedNativeModelSeconds: nativeMatched.map(r => r.modelSeconds),
    pluginFinished: `${plugin.filter(r => r.completed).length} of ${plugin.length} plugin journeys finished`,
    pluginCompactionCalls: plugin.map(r => r.compactionCalls),
    pluginReadingSeconds: plugin.map(r => r.readingSeconds),
    pluginQuality: plugin.map(r => r.qualityPassed),
    nativeRetrievalTools: nativeMatched[0].historyTools,
    pluginRetrievalTools: plugin[0].historyTools,
  },
  classification: 'Two matched-native samples and three plugin full journeys on the same fixture, pressure and host. Single-sample model runs: the timeout asymmetry is large and consistent but is not a statistical claim.',
}
await writeFile(join(night, 'native-vs-plugin-comparison.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify(report.findings, null, 1))
