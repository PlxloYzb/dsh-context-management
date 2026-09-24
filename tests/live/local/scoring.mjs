import { expectedFacts, familyExpectation } from './fixtures.mjs'

export function jsonObjects(text) {
  const objects = [], stack = []
  let quoted = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === '{') stack.push(i)
    if (char === '}' && stack.length) {
      const start = stack.pop()
      try { objects.push({ start, value: JSON.parse(text.slice(start, i + 1)) }) } catch { /* malformed candidates never receive a score */ }
    }
  }
  return objects
}
/**
 * Recover the complete leading pairs of an object the model left unterminated.
 *
 * A reply cut off mid-object used to score zero, because jsonObjects only accepts
 * balanced braces: the values already emitted were correct and simply never
 * counted. This closes the object at each depth-1 comma boundary, longest first,
 * and keeps the first prefix that parses. Values are never invented - only pairs
 * that are fully present and valid survive - so a truncated reply is scored on
 * what it actually said rather than on nothing.
 */
export function salvageObjects(text) {
  const salvaged = []
  let depth = 0, quoted = false, escaped = false
  const starts = []
  const cuts = new Map()
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === '{' || char === '[') {
      if (char === '{') { starts.push(i); cuts.set(i, []) }
      depth += 1
      continue
    }
    if (char === '}' || char === ']') { depth -= 1; continue }
    if (char === ',' && depth === 1 && starts.length) cuts.get(starts[starts.length - 1]).push(i)
  }
  for (const start of starts) {
    const boundaries = cuts.get(start) ?? []
    for (let i = boundaries.length - 1; i >= 0; i -= 1) {
      try { salvaged.push({ start, value: JSON.parse(`${text.slice(start, boundaries[i])}}`) }); break } catch { /* keep shortening */ }
    }
  }
  return salvaged
}
/**
 * Resolve a page-addressed probe answer, accepting `PAGE-<n>` or the bare number.
 *
 * The probes name pages as PAGE-<n>. A reply keyed by the bare page number is
 * answering the same question, and used to score zero purely on the spelling of
 * the key. Presence is tested with hasOwn rather than truthiness so an honest
 * null still reads as "the model said unavailable" and never as a match.
 */
export function pageValue(reply, key) {
  if (reply === null || typeof reply !== 'object') return undefined
  if (Object.hasOwn(reply, key)) return reply[key]
  const bare = /^PAGE-(\d+)$/.exec(key)?.[1]
  return bare !== undefined && Object.hasOwn(reply, bare) ? reply[bare] : undefined
}
export function selectAnswer(text) {
  const keys = Array.from({ length: 24 }, (_, i) => `F${String(i+1).padStart(2,'0')}`)
  const pick = candidates => {
    let best = null, coverage = 0, lastStart = -1
    for (const { start, value } of candidates) {
      if (value === null || typeof value !== 'object') continue
      const facts = value.facts && typeof value.facts === 'object' ? value.facts : value
      const count = keys.filter(key => Object.hasOwn(facts, key)).length
      // Outer structured answers win an equal-coverage tie over their own nested facts object.
      const rank = count * 2 + (value.facts && typeof value.facts === 'object' ? 1 : 0)
      if (count > 0 && (rank > coverage || (rank === coverage && start >= lastStart))) {
        best = value.facts ? value : { facts: value }; coverage = rank; lastStart = start
      }
    }
    return best
  }
  // Well-formed replies are scored exactly as before; salvage only runs when no
  // complete object carried a single recognized key.
  return pick(jsonObjects(text)) ?? pick(salvageObjects(text))
}
export function scoreAnswer(text, fixture, { codeValidation = null, operations = [] } = {}) {
  const answer = selectAnswer(text), expected = expectedFacts(fixture.seed, 3)
  const correct = Object.keys(expected).filter(key => answer?.facts?.[key] === expected[key])
  const correctionIds = ['F03','F06','F09','F12','F15','F18']
  const corrections = correctionIds.filter(key => answer?.facts?.[key] === expected[key])
  const actual = answer?.deliverable, domain = familyExpectation(fixture.family, fixture.seed, 3)
  let deliverablePassed = false, details = {}
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b)
  if (fixture.family === 'F1') deliverablePassed = actual?.missingA === null && actual?.missingB === null
  if (fixture.family === 'F2') { deliverablePassed = codeValidation?.passed === true; details = { codeValidation } }
  if (fixture.family === 'F3') deliverablePassed = actual?.rootCause === domain.rootCause && same(actual?.eventOrder, domain.eventOrder) && actual?.remedy === domain.remedy
  if (fixture.family === 'F4') deliverablePassed = same(operations, domain.applied) && same(actual?.applied, domain.applied) && actual?.release === domain.release
  if (fixture.family === 'F5') {
    const citations = ['F01','F10','F20'].every(key => actual?.citations?.[key] === `PAGE-${fixture.factPages[key]}`)
    deliverablePassed = citations && actual?.missingA === null && actual?.missingB === null
    details = { citationsPassed: citations }
  }
  if (fixture.family === 'F6') deliverablePassed = same(actual?.pending, domain.pending) && actual?.owner === domain.owner && actual?.forbidden === domain.forbidden
  return { scorerVersion: 1, factsCorrect: correct.length, factsTotal: 24, correctFields: correct, correctionsCorrect: corrections.length,
    correctionsTotal: 6, deliverablePassed, passed: correct.length >= 23 && corrections.length === 6 && deliverablePassed, answer, ...details }
}
export function finalQuestion(family) {
  const formats = {
    F1: '{"missingA":null,"missingB":null}',
    F2: '{"codeReady":true}',
    F3: '{"rootCause":"...","eventOrder":["..."],"remedy":"..."}',
    F4: '{"applied":["..."],"release":"..."}',
    F5: '{"citations":{"F01":"PAGE-...","F10":"PAGE-...","F20":"PAGE-..."},"missingA":null,"missingB":null}',
    F6: '{"pending":["..."],"owner":"...","forbidden":"..."}',
  }
  return `Blind historical probe. File/page/code reads, writes, external tools and operations are disabled. Recover the 24 historical facts F01..F24, retaining every latest USER correction over revision-0 historical pages. Use only the active conversation and available installed history search/retrieval. Do not guess: unavailable facts must be null. Return one JSON object with keys "facts" (all F01..F24) and "deliverable". Deliverable shape: ${formats[family]}. No correctness feedback is provided.`
}
