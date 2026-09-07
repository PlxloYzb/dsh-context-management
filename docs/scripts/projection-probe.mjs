// Research probe of the installed host's pure fold; internal file import is
// deliberate evidence collection, NOT an allowed plugin runtime dependency.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const host = process.env.DSH_PACKAGE_ROOT ?? '/Users/bruceplxl/.local/lib/node_modules/@deepseek-ai/dsh'
const deps = `${host}/node_modules/@deepseek-ai`
const { contextPressureProjectionDefinition: projection } = await import(pathToFileURL(`${deps}/dsh-token-meter/lib/types/usage-projection.js`))
const { createUserMessage } = await import(pathToFileURL(`${deps}/dsh-llm/lib/index.js`))
const { foldSurfaceProjection } = await import(pathToFileURL(`${deps}/dsh-token-meter/lib/types/surface-projection.js`))
const baseline = { pressureTokens: 10000, surfaceTokens: 5000, sampledSurfaceTokens: 5000, contextWindow: 1000000 }
const summary = { seq: 20, time: 1, type: 'compaction/summary', data: { shadowedRange: { start: 1, end: 10 }, shadowedTokenCount: 3000 } }
const replacement = { seq: 21, time: 2, type: 'user/message', data: createUserMessage({ content: 'Small checkpoint', source: { kind: 'plugin', plugin: 'compact' } }), surfaceOp: { op: 'replace', start: 1, end: 10 } }
const armed = projection.apply(baseline, summary)
const after = projection.apply(armed, replacement)
const beforeTokens = projection.wire.view(baseline).projectedTokens
const afterTokens = projection.wire.view(after).projectedTokens
const replacementTokens = foldSurfaceProjection(undefined, { ...replacement, surfaceOp: 'append' }).deltaTokens
assert.equal(afterTokens, beforeTokens - 3000 + replacementTokens)
const oldArcAdjusted = Math.max(0, afterTokens - 3000)
assert.notEqual(oldArcAdjusted, afterTokens)
const interrupted = projection.apply(armed, { seq: 21, time: 2, type: 'compaction/end', data: {} })
const afterInterleaved = projection.apply(interrupted, { ...replacement, seq: 22 })
assert.equal(projection.wire.view(afterInterleaved).projectedTokens, beforeTokens)
const report = {
  observedAt: new Date().toISOString(), hostVersion: '0.1.2-rc.1', projectionStateVersion: projection.stateVersion,
  fixture: 'Synthetic valid-shaped events, pure installed host projection; no provider request and no session writes.',
  beforeTokens, shadowedTokenCount: 3000, replacementTokens, hostAfterTokens: afterTokens,
  oldArcFormulaAfterTokens: oldArcAdjusted, doubleSubtractionUnderestimate: afterTokens - oldArcAdjusted,
  interleavedEventAfterTokens: projection.wire.view(afterInterleaved).projectedTokens,
  conclusions: ['Use host projectedTokens directly on this host.', 'summary and replacement must remain synchronously adjacent; an intervening event expires the shadow-price claim.'],
  passed: true,
}
await writeFile(resolve('docs/evidence/projection-probe.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
