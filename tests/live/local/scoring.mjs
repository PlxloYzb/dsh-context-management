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
export function selectAnswer(text) {
  const keys = Array.from({ length: 24 }, (_, i) => `F${String(i+1).padStart(2,'0')}`)
  let best = null, coverage = 0, lastStart = -1
  for (const { start, value } of jsonObjects(text)) {
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
