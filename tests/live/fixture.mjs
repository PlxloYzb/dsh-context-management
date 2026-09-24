import { createHash } from 'node:crypto'
import { salvageObjects } from './local/scoring.mjs'
export const seeds = [1701, 2903, 4307]
export function corpus(seed) {
  if (!seeds.includes(seed)) throw new Error('Use a fixed release corpus seed')
  const facts = Object.fromEntries(Array.from({ length: 12 }, (_, i) => {
    const id = `F${String(i + 1).padStart(2, '0')}`
    const tag = createHash('sha256').update(`${seed}:${id}`).digest('hex').slice(0, 8)
    return [id, i === 0 ? `/srv/project-${tag}/config.yaml` : i === 3 ? `发布-${tag}-华东` : i === 7 ? `${seed + 37}ms` : `value-${tag}`]
  }))
  const corrections = { F03: `revised-${seed}-green`, F09: `latest-${seed}-港口` }
  const pages = [1, 2, 3, 4, 5, 6, 7, 8].map(page => {
    const preface = page === 1 ? `Synthetic engineering facts. Preserve the exact values by ID.\n${JSON.stringify(facts, null, 2)}\n` : `Synthetic telemetry page ${page}; no new requirements.\n`
    return preface + Array.from({ length: 150 }, (_, i) => `Telemetry ${page}.${i}: component healthy; request completed; latency stable; replication ready; no action required.\n`).join('')
  })
  return { seed, facts, corrections, pages, hash: createHash('sha256').update(JSON.stringify({ facts, corrections, pages })).digest('hex') }
}
export function score(text, expected) {
  const objects = text.match(/\{[^{}]*\}/gs) ?? []
  let selected = null, coverage = 0
  for (const object of objects.reverse()) {
    try {
      const values = JSON.parse(object)
      const count = Object.keys(expected).filter(key => Object.hasOwn(values, key)).length
      // Select the answer by field coverage, never by whether values are correct.
      // A later small correction citation must not replace a complete answer.
      if (count > coverage) { selected = values; coverage = count }
    } catch { /* prose/code fences may precede the final object */ }
  }
  // A reply cut off mid-object matches no flat-brace regex, so every value it did
  // emit used to be discarded and the run scored zero. Recover the complete
  // leading pairs of an unterminated object rather than reporting nothing.
  if (selected === null) {
    for (const { value } of salvageObjects(text)) {
      const count = Object.keys(expected).filter(key => Object.hasOwn(value, key)).length
      if (count > coverage) { selected = value; coverage = count }
    }
  }
  const matched = selected === null ? [] : Object.keys(expected).filter(key => selected[key] === expected[key])
  return { scorerVersion:3, correct: matched.length, total: Object.keys(expected).length, matched, values:selected }
}
