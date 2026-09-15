import { createHash } from 'node:crypto'
export function fixture(seed) {
  const value = key => createHash('sha256').update(`${seed}:${key}`).digest('hex').slice(0, 10)
  const expected = Object.fromEntries(['seedFact', 'owner', 'rollback', 'region', 'gate', 'nextAction', 'verbatim'].map(key => [key, `${key}-${value(key)}`]))
  const facts = [
    `The owner of the release is ${expected.owner}.`,
    `The rollback marker must be ${expected.rollback}.`,
    `The chosen region is ${expected.region}.`,
    `The gate for promotion is ${expected.gate}.`,
    `The nextAction after approval is ${expected.nextAction}.`,
    `Verbatim archive record, deliberately omitted from handoffs: ${expected.verbatim}.`,
  ]
  const pages = Array.from({ length: 18 }, (_, page) => {
    const filler = Array.from({ length: 35 }, (_, line) => `Telemetry page ${page + 1} row ${line}: synthetic worker observed a routine cache hit; audit event ${value(`${page}:${line}`)}; no release decision changed.`)
    if (page === 0) filler.splice(1, 0, JSON.stringify({ seedFact: expected.seedFact }))
    if (page % 3 === 1) filler.splice(17, 0, facts[Math.floor(page / 3)])
    return filler.join('\n')
  })
  return { seed, pages, expected, liveRegion: `current-${value('live')}`, hash: createHash('sha256').update(pages.join('\n')).digest('hex') }
}
export const foreground = 'Continue the synthetic cache review. Produce exactly 12 numbered lines, each containing one concrete check and its rationale. Do not restate archived release facts. Do not call tools. This foreground work is the same for all experiment arms.'
export function probe(data, retrieval) {
  return `Current user correction: region is now ${data.liveRegion}; this overrides the archived region. Return one JSON object with string fields seedFact, owner, rollback, region, gate, nextAction, verbatim. The first six are the current release decisions. verbatim is the literal marker in the Verbatim archive record. ${retrieval ? 'Use search_context and decompress to recover any missing historical facts, then answer. Search distinctive labels, not hashes guessed from memory. No external tools.' : 'Diagnostic seed-only probe: do not call tools. Use only the visible context. Use the string UNKNOWN for anything missing; do not guess.'}`
}
export function score(text, data) {
  const objects = text.match(/\{[^{}]*\}/g) ?? []
  let answer = {}
  for (const object of objects) { try { answer = JSON.parse(object) } catch { /* Count malformed output as failure. */ } }
  const expected = { ...data.expected, region: data.liveRegion }
  const fields = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, answer[key] === value]))
  return { fields, correct: Object.values(fields).filter(Boolean).length, total: Object.keys(fields).length, answer }
}
