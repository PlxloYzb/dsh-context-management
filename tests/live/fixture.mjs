import { createHash } from 'node:crypto'
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
  const matched = selected === null ? [] : Object.keys(expected).filter(key => selected[key] === expected[key])
  return { scorerVersion:2, correct: matched.length, total: Object.keys(expected).length, matched, values:selected }
}
