// Frozen strict parser and final-probe scorer for the muse-longrun-v1 protocol.
//
// The final probe returns ONE flat JSON object keyed by queryId:
//   { "<queryId>": { <scored field>: <value>, ... }, ... }
// There is no `answers` wrapper. Exactly one complete JSON object is accepted,
// optionally inside a single fenced block. Any structural violation is a
// FORMAT_FAILURE with score 0 for the whole probe: the scorer never awards
// partial credit from a fragment and never cherry-picks between candidates.
import {
  CATEGORIES,
  LONG_TAIL_REQUIRED_COUNT,
  QUESTION_COUNT,
  QUESTIONS_PER_QUARTILE,
  REQUIRED_LATEST_USER_COUNT,
  oracleShapeProblems,
} from './fixture.mjs'

export const SCORER_VERSION = 1
export const QUALITY_MIN_CORRECT = 87
export const QUALITY_MIN_PER_QUARTILE = 20
export const LONG_TAIL_MIN_CORRECT = 10

export class AnswerFormatError extends Error {
  constructor(reason, detail = '') {
    super(`${reason}${detail ? `: ${detail}` : ''}`)
    this.name = 'AnswerFormatError'
    this.reason = reason
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// Strict JSON object parser (duplicate keys are rejected, not silently merged)
// ---------------------------------------------------------------------------

export function parseStrictJson(text) {
  if (typeof text !== 'string') throw new AnswerFormatError('NOT_A_STRING')
  let index = 0
  const fail = (reason, detail) => { throw new AnswerFormatError(reason, detail) }
  const skipWhitespace = () => { while (index < text.length && /\s/.test(text[index])) index += 1 }

  function parseValue() {
    skipWhitespace()
    const char = text[index]
    if (char === '{') return parseObject()
    if (char === '[') return parseArray()
    if (char === '"') return parseString()
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber()
    if (text.startsWith('true', index)) { index += 4; return true }
    if (text.startsWith('false', index)) { index += 5; return false }
    if (text.startsWith('null', index)) { index += 4; return null }
    return fail('MALFORMED_JSON', `unexpected character at offset ${index}`)
  }

  function parseObject() {
    index += 1
    const object = {}
    const seen = new Set()
    skipWhitespace()
    if (text[index] === '}') { index += 1; return object }
    for (;;) {
      skipWhitespace()
      if (text[index] !== '"') return fail('MALFORMED_JSON', `object key must be a string at offset ${index}`)
      const key = parseString()
      if (seen.has(key)) return fail('DUPLICATE_FIELD', key)
      seen.add(key)
      skipWhitespace()
      if (text[index] !== ':') return fail('MALFORMED_JSON', `missing colon after ${key}`)
      index += 1
      object[key] = parseValue()
      skipWhitespace()
      if (text[index] === ',') { index += 1; continue }
      if (text[index] === '}') { index += 1; return object }
      return fail('MALFORMED_JSON', `expected , or } at offset ${index}`)
    }
  }

  function parseArray() {
    index += 1
    const array = []
    skipWhitespace()
    if (text[index] === ']') { index += 1; return array }
    for (;;) {
      array.push(parseValue())
      skipWhitespace()
      if (text[index] === ',') { index += 1; continue }
      if (text[index] === ']') { index += 1; return array }
      return fail('MALFORMED_JSON', `expected , or ] at offset ${index}`)
    }
  }

  function parseString() {
    index += 1
    let out = ''
    for (;;) {
      if (index >= text.length) return fail('MALFORMED_JSON', 'unterminated string')
      const char = text[index]
      if (char === '"') { index += 1; return out }
      if (char === '\\') {
        index += 1
        const escape = text[index]
        if (escape === 'u') {
          const code = text.slice(index + 1, index + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(code)) return fail('MALFORMED_JSON', 'invalid unicode escape')
          out += String.fromCharCode(parseInt(code, 16))
          index += 5
          continue
        }
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
        if (!Object.hasOwn(map, escape)) return fail('MALFORMED_JSON', `invalid escape \\${escape}`)
        out += map[escape]
        index += 1
        continue
      }
      out += char
      index += 1
    }
  }

  function parseNumber() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index))
    if (!match) return fail('MALFORMED_JSON', `invalid number at offset ${index}`)
    index += match[0].length
    return Number(match[0])
  }

  const value = parseValue()
  skipWhitespace()
  if (index !== text.length) throw new AnswerFormatError('MULTIPLE_CANDIDATES', text.slice(index, index + 40))
  return value
}

// Exactly one JSON object, optionally inside one fenced block. Non-empty text
// outside the fence and multiple candidate objects are format failures. When an
// oracle is supplied the scored-field rules (missing field, null where a value
// is required, empty required array, unknown field or id) are enforced too.
// Returns the frozen parser view `{ status, ok, value, reason, detail }` without
// throwing; pass `{ throw: true }` for the throwing variant.
export function parseAnswerObject(text, options = {}) {
  try {
    const value = parseAnswerObjectStrict(text, options)
    return { status: 'ok', ok: true, value, reason: null, detail: null }
  } catch (error) {
    if (!(error instanceof AnswerFormatError)) throw error
    if (options.throw === true) throw error
    return { status: error.reason, ok: false, value: null, reason: error.reason, detail: error.detail ?? '' }
  }
}

export function parseAnswerObjectStrict(text, options = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) throw new AnswerFormatError('EMPTY_ANSWER')
  const fences = []
  let cursor = text.indexOf('```')
  while (cursor !== -1) { fences.push(cursor); cursor = text.indexOf('```', cursor + 3) }
  let payload = text
  if (fences.length === 1) throw new AnswerFormatError('UNBALANCED_FENCE')
  if (fences.length > 2) throw new AnswerFormatError('MULTIPLE_FENCES', `${fences.length} markers`)
  if (fences.length === 2) {
    const [open, close] = fences
    if (close < open) throw new AnswerFormatError('UNBALANCED_FENCE')
    const before = text.slice(0, open)
    if (before.trim().length > 0) throw new AnswerFormatError('TEXT_OUTSIDE_FENCE', before.trim().slice(0, 60))
    const headerEnd = text.indexOf('\n', open)
    if (headerEnd === -1 || headerEnd > close) throw new AnswerFormatError('UNBALANCED_FENCE')
    const after = text.slice(close + 3)
    const newline = after.indexOf('\n')
    const remainder = newline === -1 ? '' : after.slice(newline + 1)
    if (remainder.trim().length > 0) throw new AnswerFormatError('TEXT_OUTSIDE_FENCE', remainder.trim().slice(0, 60))
    payload = text.slice(headerEnd + 1, close)
  }
  if (payload.trim()[0] !== '{') throw new AnswerFormatError('NOT_AN_OBJECT')
  const value = parseStrictJson(payload)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AnswerFormatError('NOT_AN_OBJECT')
  if (options.oracle) {
    const { problems } = validateAnswerAgainstOracle(value, options.oracle)
    if (problems.length > 0) throw new AnswerFormatError('SCHEMA_VIOLATION', problems.slice(0, 20).join('; '))
  }
  return value
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function normalizeExposures(exposures) {
  const exposed = new Set()
  if (!exposures) return exposed
  if (exposures instanceof Set || Array.isArray(exposures)) {
    for (const id of exposures) exposed.add(String(id))
    return exposed
  }
  if (typeof exposures === 'object') {
    if (Array.isArray(exposures.exposed)) { for (const id of exposures.exposed) exposed.add(String(id)); return exposed }
    for (const [id, clean] of Object.entries(exposures)) if (clean === false) exposed.add(id)
  }
  return exposed
}

const deepEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right)

const absentAnswerAllowed = question =>
  question.category === 'source_existence_ambiguity' &&
  question.oracle?.expected?.present === false &&
  question.oracle?.expected?.recordId === null

// Structural validation over the whole probe, before any question is scored.
// Returns the normalised per-question answers plus every violation found.
export function validateAnswerAgainstOracle(answer, oracle) {
  const byId = new Map(oracle.questions.map(question => [question.queryId, question]))
  const problems = []
  const normalized = new Map()
  for (const [queryId, value] of Object.entries(answer)) {
    const question = byId.get(queryId)
    if (!question) { problems.push(`unknown queryId ${queryId}`); continue }
    if (value === null) {
      if (!absentAnswerAllowed(question)) { problems.push(`null answer for ${queryId}`); continue }
      normalized.set(queryId, { present: false, recordId: null })
      continue
    }
    if (typeof value !== 'object' || Array.isArray(value)) { problems.push(`answer for ${queryId} is not an object`); continue }
    const extra = Object.keys(value).filter(field => !question.scoredFields.includes(field))
    if (extra.length > 0) problems.push(`unknown fields ${extra.join(',')} in ${queryId}`)
    const missingFields = question.scoredFields.filter(field => !Object.hasOwn(value, field))
    if (missingFields.length > 0) problems.push(`missing scored fields ${missingFields.join(',')} in ${queryId}`)
    // `present: false` with `recordId: null` is the shape the question itself
    // offers for "I could not find it". That is a WRONG answer, not a malformed
    // one, and calling it a schema violation zeroed all 96 questions for both
    // arms because three ambiguity questions were answered absent — it destroyed
    // the quality signal entirely. A null that IS malformed is one that claims
    // presence without an identifier.
    const declaresAbsent = value['present'] === false
    for (const field of question.scoredFields) {
      if (!Object.hasOwn(value, field)) continue
      const actual = value[field]
      const expected = question.oracle.expected[field]
      if (actual === null && expected !== null && !(field === 'recordId' && declaresAbsent)) problems.push(`null where a value is required: ${queryId}.${field}`)
      if (Array.isArray(actual) && Array.isArray(expected) && expected.length > 0 && actual.length === 0) {
        problems.push(`empty required array: ${queryId}.${field}`)
      }
    }
    normalized.set(queryId, value)
  }
  return { problems, normalized }
}

function formatFailure(reason, detail, oracle, exposed) {
  const questions = oracle.questions ?? []
  const perQuestion = questions.map(question => ({
    queryId: question.queryId,
    category: question.category,
    quartile: question.quartile,
    requiredLatestUser: Boolean(question.requiredLatestUser),
    longTailRequired: Boolean(question.longTailRequired),
    probeClean: !exposed.has(question.queryId),
    correct: false,
    expected: question.oracle?.expected ?? null,
    actual: null,
    reason: 'format_failure',
  }))
  return {
    scorerVersion: SCORER_VERSION,
    status: 'FORMAT_FAILURE',
    formatFailure: true,
    formatReason: reason,
    formatDetail: detail,
    formatFailures: [],
    endpoint: oracle.endpoint ?? null,
    questionCount: oracle.questionCount ?? questions.length,
    total: 0,
    fraction: 0,
    perCategory: emptyCategorySummary(questions),
    perQuartile: emptyQuartileSummary(questions),
    requiredLatestUser: { correct: 0, total: REQUIRED_LATEST_USER_COUNT, ids: [...(oracle.requiredLatestUserIds ?? [])] },
    longTailRequired: { correct: 0, total: LONG_TAIL_REQUIRED_COUNT, ids: [...(oracle.longTailRequiredIds ?? [])], probeCleanCount: 0 },
    probeCleanCount: perQuestion.filter(entry => entry.probeClean).length,
    probeCleanLongTailCount: 0,
    wrong: questions.map(question => question.queryId),
    missing: [],
    qualityPassed: false,
    longTailPassed: false,
    longTailProbeCleanPassed: false,
    perQuestion,
  }
}

function emptyCategorySummary(questions) {
  const summary = {}
  for (const category of CATEGORIES) {
    const relevant = questions.filter(question => question.category === category)
    summary[category] = { correct: 0, total: relevant.length }
  }
  return summary
}

function emptyQuartileSummary(questions) {
  return [0, 1, 2, 3].map(quartile => {
    const relevant = questions.filter(question => question.quartile === quartile)
    const categories = {}
    for (const category of CATEGORIES) {
      categories[category] = { correct: 0, total: relevant.filter(question => question.category === category).length }
    }
    return { quartile, correct: 0, total: relevant.length || QUESTIONS_PER_QUARTILE, categories }
  })
}

// Two accepted call shapes, both frozen:
//   scoreFinalProbe({ answerText, oracle, exposures })
//     one answer object for the whole probe; any format or schema violation is a
//     FORMAT_FAILURE with score 0 for the whole probe.
//   scoreFinalProbe({ parsed, formatFailures, oracle, exposures })
//     pre-parsed per-batch answers (the driver sends 12 batches); each batch that
//     violated the format contributes FORMAT_FAILURE for its own questions only.
export function scoreFinalProbe({ answerText, parsed, formatFailures, oracle, exposures } = {}) {
  if (!oracle || typeof oracle !== 'object') throw new Error('scoreFinalProbe requires a sealed oracle')
  const shapeProblems = oracleShapeProblems(oracle)
  if (shapeProblems.length > 0) throw new Error(`ORACLE_INVALID: ${shapeProblems.join('; ')}`)
  const exposed = normalizeExposures(exposures)
  const questions = oracle.questions

  let normalized
  let problems
  if (parsed !== undefined) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('scoreFinalProbe parsed answers must be an object')
    const validated = validateAnswerAgainstOracle(parsed, oracle)
    normalized = validated.normalized
    problems = validated.problems
  } else {
    const view = parseAnswerObject(answerText)
    if (!view.ok) return formatFailure(view.status, view.detail, oracle, exposed)
    const validated = validateAnswerAgainstOracle(view.value, oracle)
    normalized = validated.normalized
    problems = validated.problems
  }
  if (problems.length > 0) return formatFailure('SCHEMA_VIOLATION', problems.slice(0, 20).join('; '), oracle, exposed)

  const batchFailures = new Map()
  for (const failure of formatFailures ?? []) {
    for (const queryId of failure?.queryIds ?? []) batchFailures.set(queryId, failure.reason ?? 'FORMAT_FAILURE')
  }

  const perQuestion = []
  const perCategory = {}
  for (const category of CATEGORIES) perCategory[category] = { correct: 0, total: 0 }
  const perQuartile = [0, 1, 2, 3].map(quartile => ({
    quartile, correct: 0, total: 0,
    categories: Object.fromEntries(CATEGORIES.map(category => [category, { correct: 0, total: 0 }])),
  }))
  let requiredLatestUserCorrect = 0
  let longTailCorrect = 0
  let probeCleanCount = 0
  let probeCleanLongTailCount = 0
  const wrong = []
  const missing = []

  for (const question of questions) {
    const probeClean = !exposed.has(question.queryId)
    if (probeClean) probeCleanCount += 1
    const actual = normalized.get(question.queryId)
    perCategory[question.category].total += 1
    perQuartile[question.quartile].total += 1
    perQuartile[question.quartile].categories[question.category].total += 1
    let correct = false
    let reason
    if (batchFailures.has(question.queryId)) {
      reason = 'format_failure'
      wrong.push(question.queryId)
    } else if (actual === undefined) {
      reason = 'missing'
      missing.push(question.queryId)
      wrong.push(question.queryId)
    } else {
      correct = question.scoredFields.every(field => deepEqual(actual[field], question.oracle.expected[field]))
      reason = correct ? 'correct' : 'wrong'
      if (!correct) wrong.push(question.queryId)
    }
    if (correct) {
      perCategory[question.category].correct += 1
      perQuartile[question.quartile].correct += 1
      perQuartile[question.quartile].categories[question.category].correct += 1
      if (question.requiredLatestUser) requiredLatestUserCorrect += 1
      if (question.longTailRequired) {
        longTailCorrect += 1
        if (probeClean) probeCleanLongTailCount += 1
      }
    }
    perQuestion.push({
      queryId: question.queryId,
      category: question.category,
      quartile: question.quartile,
      requiredLatestUser: Boolean(question.requiredLatestUser),
      longTailRequired: Boolean(question.longTailRequired),
      probeClean,
      correct,
      expected: question.oracle.expected,
      actual: actual ?? null,
      reason,
    })
  }

  const total = perQuestion.filter(entry => entry.correct).length
  const hasBatchFailures = batchFailures.size > 0
  const qualityPassed = total >= QUALITY_MIN_CORRECT &&
    perQuartile.every(quartile => quartile.correct >= QUALITY_MIN_PER_QUARTILE) &&
    requiredLatestUserCorrect === REQUIRED_LATEST_USER_COUNT
  return {
    scorerVersion: SCORER_VERSION,
    status: hasBatchFailures ? 'FORMAT_FAILURE' : 'SCORED',
    formatFailure: hasBatchFailures,
    formatReason: hasBatchFailures ? 'BATCH_FORMAT_FAILURE' : null,
    formatDetail: hasBatchFailures ? [...batchFailures.entries()].map(([id, why]) => `${id}:${why}`).join('; ') : null,
    formatFailures: (formatFailures ?? []).map(failure => ({ ...failure })),
    endpoint: oracle.endpoint ?? null,
    questionCount: questions.length,
    total,
    fraction: total / questions.length,
    perCategory,
    perQuartile,
    requiredLatestUser: { correct: requiredLatestUserCorrect, total: REQUIRED_LATEST_USER_COUNT, ids: [...oracle.requiredLatestUserIds] },
    longTailRequired: { correct: longTailCorrect, total: LONG_TAIL_REQUIRED_COUNT, ids: [...oracle.longTailRequiredIds], probeCleanCount: probeCleanLongTailCount },
    probeCleanCount,
    probeCleanLongTailCount,
    wrong,
    missing,
    qualityPassed,
    longTailPassed: longTailCorrect >= LONG_TAIL_MIN_CORRECT,
    longTailProbeCleanPassed: probeCleanLongTailCount === LONG_TAIL_REQUIRED_COUNT,
    perQuestion,
  }
}

// Build the canonical correct answer object for a sealed oracle. Used by golden
// tests and by independent audits; never shown to a model.
export function referenceAnswer(oracle) {
  const answer = {}
  for (const question of oracle.questions) {
    const entry = {}
    for (const field of question.scoredFields) entry[field] = question.oracle.expected[field]
    answer[question.queryId] = entry
  }
  return answer
}

export { QUESTION_COUNT }
