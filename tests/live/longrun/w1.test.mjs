// W1 tests: deterministic corpus, sealed oracle, strict scorer and bounded tools.
//
// Run: node --test tests/live/longrun/w1.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALLOWED_ENDPOINTS,
  CATEGORIES,
  FORBIDDEN_PAGE_SUBSTRINGS,
  LONG_TAIL_REQUIRED_COUNT,
  MAX_PAGE_CODE_POINTS,
  MIN_PAGE_CODE_POINTS,
  MIN_INDEPENDENT_RECORD_FRACTION,
  PAGES_PER_EPISODE,
  QUESTION_COUNT,
  QUESTIONS_PER_CATEGORY_PER_QUARTILE,
  QUESTIONS_PER_QUARTILE,
  REQUIRED_LATEST_USER_COUNT,
  SENTINEL_EPISODES,
  episodeBrief,
  episodeCountForEndpoint,
  episodeWorkItem,
  fixtureManifest,
  generateCorpus,
  generateOracle,
  independentRecordFraction,
  materialCounts,
  oracleShapeProblems,
  pageSafetyIssues,
  pageText,
  pageTokens,
  probeInstructions,
  sentinelQuestions,
} from './fixture.mjs'
import { AnswerFormatError, parseAnswerObject, parseStrictJson, referenceAnswer, scoreFinalProbe } from './scoring.mjs'
import { EXPERIMENT_TOOLS, HISTORY_TOOLS, apply as applyFixtureTools, inject } from './fixture-tools.mjs'

const SEED = 91601
const SALT = 'w1-test-hidden-salt'
const CORPUS = generateCorpus({ seed: SEED, salt: SALT, episodes: 48 })
const ORACLES = new Map(ALLOWED_ENDPOINTS.map(endpoint => [endpoint, generateOracle({ corpus: CORPUS, endpoint })]))
const ENDPOINT_24 = ORACLES.get(24)

test('determinism: same seed and salt reproduce an identical corpus hash', () => {
  const again = generateCorpus({ seed: SEED, salt: SALT, episodes: 24 })
  const first = generateCorpus({ seed: SEED, salt: SALT, episodes: 24 })
  assert.equal(again.hash, first.hash)
  assert.deepEqual(again.pageHashes, first.pageHashes)
  assert.deepEqual(again.pages, first.pages)
  const otherSalt = generateCorpus({ seed: SEED, salt: `${SALT}-different`, episodes: 24 })
  assert.notEqual(otherSalt.hash, first.hash)
  const otherSeed = generateCorpus({ seed: SEED + 1, salt: SALT, episodes: 24 })
  assert.notEqual(otherSeed.hash, first.hash)
  assert.equal(fixtureManifest(first).seed, SEED)
  assert.equal(JSON.stringify(fixtureManifest(first)).includes('latestValue'), false)
})

test('the promised corpus is a prefix of longer endpoints', () => {
  const base = generateCorpus({ seed: SEED, salt: SALT, episodes: 24 })
  assert.deepEqual(CORPUS.pages.slice(0, base.pages.length), base.pages)
  assert.deepEqual(CORPUS.workItems.slice(0, 24), base.workItems)
  assert.deepEqual(CORPUS.state.entities.slice(0, 48).map(entity => entity.entityId), base.state.entities.map(entity => entity.entityId))
})

test('page geometry: 12 pages per episode, 6200..7800 code points, data-only records', () => {
  assert.equal(CORPUS.pages.length, CORPUS.episodes * PAGES_PER_EPISODE)
  const lengths = CORPUS.pageStats.map(stat => stat.codePoints)
  assert.equal(Math.max(...lengths) <= MAX_PAGE_CODE_POINTS, true)
  assert.equal(Math.min(...lengths) >= MIN_PAGE_CODE_POINTS, true)
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length
  assert.ok(mean > 6900 && mean < 7300, `mean page length ${mean}`)
  for (const [index, text] of CORPUS.pages.entries()) {
    const page = index + 1
    assert.deepEqual(pageSafetyIssues(text), [], `page ${page} safety`)
    for (const marker of ['trace=', 'checksum=', 'latency=', 'state=', 'previous=']) {
      assert.ok(text.includes(marker), `page ${page} lacks ${marker}`)
    }
    assert.ok(text.includes('api '), `page ${page} lacks an api fragment`)
    assert.ok(/[\u4e00-\u9fff]/.test(text), `page ${page} lacks Chinese text`)
    assert.ok(independentRecordFraction(text) >= MIN_INDEPENDENT_RECORD_FRACTION, `page ${page} independent record fraction`)
    assert.equal(text, pageText(CORPUS, page))
  }
  assert.throws(() => pageText(CORPUS, 0), /outside/)
  assert.throws(() => pageText(CORPUS, CORPUS.pages.length + 1), /outside/)
  for (const forbidden of FORBIDDEN_PAGE_SUBSTRINGS) {
    assert.equal(CORPUS.pages.some(text => text.toLowerCase().includes(forbidden)), false, forbidden)
  }
})

test('pageTokens replicates the pinned single-text-block estimator', () => {
  const tokens = pageTokens(CORPUS)
  assert.equal(tokens.length, CORPUS.pages.length)
  for (const [index, text] of CORPUS.pages.entries()) {
    assert.equal(tokens[index], Math.ceil(Array.from(text).length / 4) + 4)
  }
})

test('episode briefs and work items are bounded and answer-free', () => {
  for (const episode of [1, 6, 12, 24, 48]) {
    const brief = episodeBrief(CORPUS, episode)
    assert.ok(brief.includes(`episode ${episode} of ${CORPUS.episodes}`))
    assert.ok(brief.includes(`E_${episode}_COMPLETE`))
    const item = episodeWorkItem(CORPUS, episode)
    assert.equal(item.episode, episode)
    assert.ok(item.deliverable.length > 0)
    assert.equal(item.files.length, 3)
  }
  assert.throws(() => episodeBrief(CORPUS, 0), /outside/)
  assert.throws(() => episodeCountForEndpoint(25), /precommitted endpoints/)
})

test('oracle minimum counts for a 24-episode corpus', () => {
  const counts = materialCounts(CORPUS, 24)
  assert.ok(counts.stateEntities >= 48, JSON.stringify(counts))
  assert.ok(counts.entitiesWithTwoUpdates >= 16)
  assert.ok(counts.revocationRestorationEntities >= 8)
  assert.ok(counts.similarIdPairs >= 12)
  assert.ok(counts.timelineDependencyRelations >= 24)
  assert.ok(counts.crossSixEpisodeRelations >= 8)
  assert.ok(counts.threeWayFanIn >= 4)
  assert.ok(counts.mutuallyExclusiveGroups >= 4)
  assert.ok(counts.exactHistoryTargets >= 48)
  assert.ok(counts.earliestQuartileExactTargets >= 12)
  assert.ok(counts.multiSourceExactTargets >= 12)
  assert.ok(counts.existenceAmbiguityGroups >= 24)
  assert.ok(counts.syntheticActions >= 24)
})

test('near-miss identifiers differ by exactly one hex digit and are unique', () => {
  const realIds = new Set(CORPUS.state.entities.map(entity => entity.entityId))
  const nearMissIds = new Set()
  for (const pair of CORPUS.state.nearMissPairs) {
    assert.equal(pair.nearMissId.length, pair.authoritativeEntityId.length)
    const differences = [...pair.authoritativeEntityId].filter((char, index) => char !== pair.nearMissId[index]).length
    assert.equal(differences, 1, `${pair.nearMissId} vs ${pair.authoritativeEntityId}`)
    assert.equal(realIds.has(pair.nearMissId), false)
    assert.equal(nearMissIds.has(pair.nearMissId), false)
    nearMissIds.add(pair.nearMissId)
    assert.equal(/^ENT-[0-9a-f]{12}$/.test(pair.nearMissId), true)
  }
  assert.equal(CORPUS.state.nearMissPairs.length, 12)
})

test('existence negatives are genuinely absent and echoes are not authoritative', () => {
  const joined = CORPUS.pages.join('\n')
  const lines = joined.split('\n')
  const families = new Set()
  for (const group of CORPUS.existence) {
    families.add(group.kind)
    if (group.kind === 'same_short_id') continue
    if (group.kind === 'summary_echo') {
      assert.ok(joined.includes(group.queryValue))
      for (const line of lines) {
        if (line.includes(group.queryValue)) assert.ok(line.includes('authority=echo'))
      }
      continue
    }
    assert.equal(joined.includes(group.queryValue), false, group.queryValue)
  }
  assert.deepEqual([...families].sort(), ['absent', 'near_miss', 'same_short_id', 'summary_echo'])
  const collisions = CORPUS.state.shortIdCollisions
  assert.equal(collisions.length, 6)
  for (const collision of collisions) {
    assert.notEqual(collision.authoritativeEntityId, collision.aliasEntityId)
    assert.equal(CORPUS.state.entities.find(entity => entity.entityId === collision.aliasEntityId).shortId, collision.shortId)
  }
})

test('quartile assignment holds at every endpoint', () => {
  for (const endpoint of ALLOWED_ENDPOINTS) {
    const oracle = ORACLES.get(endpoint)
    assert.equal(oracle.questionCount, QUESTION_COUNT)
    assert.equal(oracleShapeProblems(oracle).length, 0, oracleShapeProblems(oracle).join('; '))
    const totalPages = endpoint * PAGES_PER_EPISODE
    const perQuartile = [0, 0, 0, 0]
    const perBucketCategory = new Map()
    for (const question of oracle.questions) {
      const expected = Math.floor(((question.sourcePosition.finalSourcePage - 1) * 4) / totalPages)
      assert.equal(question.quartile, expected, `${question.queryId}`)
      assert.ok(question.sourcePosition.finalSourcePage <= totalPages)
      perQuartile[question.quartile] += 1
      const key = `${question.quartile}:${question.category}`
      perBucketCategory.set(key, (perBucketCategory.get(key) ?? 0) + 1)
    }
    for (const count of perQuartile) assert.equal(count, QUESTIONS_PER_QUARTILE)
    for (let bucket = 0; bucket < 4; bucket += 1) {
      for (const category of CATEGORIES) {
        assert.equal(perBucketCategory.get(`${bucket}:${category}`), QUESTIONS_PER_CATEGORY_PER_QUARTILE)
      }
    }
    assert.equal(oracle.batches.length, 12)
    assert.ok(oracle.batches.every(batch => batch.length === 8))
    assert.ok(new Set(oracle.batches.flat()).size === QUESTION_COUNT)
    assert.deepEqual(oracle.batches[0].concat(oracle.batches[1]).slice(0, LONG_TAIL_REQUIRED_COUNT), oracle.longTailRequiredIds)
    assert.equal(oracle.requiredLatestUserIds.length, REQUIRED_LATEST_USER_COUNT)
    assert.equal(oracle.longTailRequiredIds.length, LONG_TAIL_REQUIRED_COUNT)
    assert.equal(oracle.actionPlan.length, endpoint)
  }
})

test('question prompts expose only public fields and never the expected answer', () => {
  for (const question of ENDPOINT_24.questions) {
    assert.deepEqual(question.promptVisibleFields.includes('recordId'), false)
    for (const hidden of ['oracle', 'expected', 'evidence', 'sourcePosition', 'sourcePages']) {
      assert.equal(question.promptVisibleFields.includes(hidden), false, `${question.queryId} exposes ${hidden}`)
    }
    const expected = question.oracle.expected
    for (const value of Object.values(expected)) {
      if (typeof value === 'string') assert.equal(question.question.includes(value), false, `${question.queryId} leaks its answer`)
    }
    if (Array.isArray(expected.order)) {
      for (const id of expected.order) assert.equal(question.question.includes(id), false, `${question.queryId} leaks ${id}`)
    }
    assert.ok(question.question.includes(question.queryId))
  }
})

test('state questions cover the required latest-user subtypes', () => {
  const expected = {
    latest_user_correction: 8,
    revocation_restoration: 8,
    ordinary_state: 8,
  }
  const actual = {}
  for (const question of ENDPOINT_24.questions.filter(question => question.category === 'state')) {
    actual[question.subtype] = (actual[question.subtype] ?? 0) + 1
  }
  assert.deepEqual(actual, expected)
  const required = ENDPOINT_24.questions.filter(question => question.requiredLatestUser)
  assert.equal(required.length, REQUIRED_LATEST_USER_COUNT)
  assert.ok(required.every(question => question.category === 'state'))
  assert.ok(required.every(question => ['latest_user_correction', 'revocation_restoration'].includes(question.subtype)))
})

test('every endpoint covers all existence and state subtypes', () => {
  for (const endpoint of ALLOWED_ENDPOINTS) {
    const oracle = ORACLES.get(endpoint)
    const existence = new Set(oracle.questions.filter(question => question.category === 'source_existence_ambiguity').map(question => question.subtype))
    assert.deepEqual([...existence].sort(), ['absent', 'near_miss', 'same_short_id', 'summary_echo'], `endpoint ${endpoint}`)
    const state = {}
    for (const question of oracle.questions.filter(question => question.category === 'state')) state[question.subtype] = (state[question.subtype] ?? 0) + 1
    assert.deepEqual(state, { latest_user_correction: 8, revocation_restoration: 8, ordinary_state: 8 }, `endpoint ${endpoint}`)
  }
})

test('long-tail evidence islands are disjoint from every other question', () => {
  const longTail = ENDPOINT_24.questions.filter(question => question.longTailRequired)
  assert.equal(longTail.length, 12)
  assert.deepEqual(longTail.map(question => question.category).sort(), [...Array(6).fill('exact'), ...Array(6).fill('source_existence_ambiguity')].sort())
  const islandPages = []
  for (const question of longTail) {
    assert.equal(question.quartile, 0)
    for (const page of question.evidence.sourcePages) islandPages.push(page)
  }
  assert.equal(new Set(islandPages).size, islandPages.length, 'long-tail questions must use disjoint pages')
  const islandSet = new Set(islandPages)
  for (const question of ENDPOINT_24.questions.filter(question => !question.longTailRequired)) {
    for (const page of question.evidence.sourcePages) {
      assert.equal(islandSet.has(page), false, `${question.queryId} reuses island page ${page}`)
    }
  }
  // Island entities/records must not be reused by any final question.
  const finalRecordIds = new Set(ENDPOINT_24.questions.filter(question => !question.longTailRequired).flatMap(question => question.evidence.recordIds))
  for (const question of longTail) {
    for (const id of question.evidence.recordIds) assert.equal(finalRecordIds.has(id), false)
  }
})

test('sentinel questions are disjoint from the final probe at every endpoint', () => {
  assert.deepEqual([...SENTINEL_EPISODES], [6, 12, 18])
  const finalPages = new Set()
  const finalRecordIds = new Set()
  const finalEntities = new Set()
  for (const endpoint of ALLOWED_ENDPOINTS) {
    for (const question of ORACLES.get(endpoint).questions) {
      for (const page of question.evidence.sourcePages) finalPages.add(page)
      for (const id of question.evidence.recordIds) finalRecordIds.add(id)
    }
  }
  for (const { entityId } of CORPUS.state.entities) finalEntities.add(entityId)
  for (const episode of SENTINEL_EPISODES) {
    const questions = sentinelQuestions(CORPUS, episode)
    assert.equal(questions.length, 4)
    assert.deepEqual(questions.map(question => question.queryId), [`S${episode}-Q1`, `S${episode}-Q2`, `S${episode}-Q3`, `S${episode}-Q4`])
    for (const question of questions) {
      for (const page of question.evidence.sourcePages) assert.equal(finalPages.has(page), false, `sentinel page ${page} reused`)
      for (const id of question.evidence.recordIds) {
        assert.equal(finalRecordIds.has(id), false)
        assert.equal(finalEntities.has(id), false)
      }
      assert.equal(/\b(oracle|expected)\b/i.test(question.question), false)
    }
  }
  assert.deepEqual(sentinelQuestions(CORPUS, 7), [])
  // The driver passes the sealed oracle; sentinels travel with it too.
  assert.deepEqual(sentinelQuestions(ENDPOINT_24, 12), sentinelQuestions(CORPUS, 12))
  assert.equal(CORPUS.sentinelPages.length, SENTINEL_EPISODES.length * 4)
  for (const page of CORPUS.sentinelPages) assert.equal(finalPages.has(page), false)
})

test('probe instructions describe the flat queryId-keyed object', () => {
  const text = probeInstructions(ENDPOINT_24)
  assert.ok(text.includes('queryId'))
  assert.ok(!text.includes('"answers"'))
})

test('scorer golden: the reference answer scores 96/96', () => {
  const score = scoreFinalProbe({ answerText: JSON.stringify(referenceAnswer(ENDPOINT_24)), oracle: ENDPOINT_24 })
  assert.equal(score.status, 'SCORED')
  assert.equal(score.total, QUESTION_COUNT)
  assert.equal(score.formatFailure, false)
  assert.equal(score.qualityPassed, true)
  assert.equal(score.longTailPassed, true)
  assert.equal(score.longTailProbeCleanPassed, true)
  assert.equal(score.requiredLatestUser.correct, REQUIRED_LATEST_USER_COUNT)
  assert.ok(score.perQuartile.every(quartile => quartile.correct === QUESTIONS_PER_QUARTILE))
  for (const category of CATEGORIES) assert.equal(score.perCategory[category].correct, score.perCategory[category].total)
})

test('scorer golden: a fenced reference answer is accepted', () => {
  const body = JSON.stringify(referenceAnswer(ENDPOINT_24))
  const score = scoreFinalProbe({ answerText: '```json\n' + body + '\n```', oracle: ENDPOINT_24 })
  assert.equal(score.total, QUESTION_COUNT)
})

test('scorer golden: one wrong answer is one wrong question', () => {
  const answer = referenceAnswer(ENDPOINT_24)
  const target = ENDPOINT_24.questions.find(question => question.category === 'state' && question.subtype === 'ordinary_state')
  answer[target.queryId] = { value: 'not-the-value' }
  const score = scoreFinalProbe({ answerText: JSON.stringify(answer), oracle: ENDPOINT_24 })
  assert.equal(score.status, 'SCORED')
  assert.equal(score.total, QUESTION_COUNT - 1)
  assert.deepEqual(score.wrong, [target.queryId])
  assert.equal(score.qualityPassed, true)
})

test('scorer golden: revocation answers must use the restored value', () => {
  const question = ENDPOINT_24.questions.find(entry => entry.subtype === 'revocation_restoration')
  const entity = CORPUS.state.entities.find(entry => entry.publicLabel === question.targetLabel)
  assert.equal(entity.kind, 'revocation')
  const stale = referenceAnswer(ENDPOINT_24)
  stale[question.queryId] = { value: entity.originalValue }
  const staleScore = scoreFinalProbe({ answerText: JSON.stringify(stale), oracle: ENDPOINT_24 })
  assert.equal(staleScore.perQuestion.find(entry => entry.queryId === question.queryId).correct, false)
  const restored = referenceAnswer(ENDPOINT_24)
  restored[question.queryId] = { value: entity.latestValue }
  assert.equal(scoreFinalProbe({ answerText: JSON.stringify(restored), oracle: ENDPOINT_24 }).perQuestion.find(entry => entry.queryId === question.queryId).correct, true)
})

test('scorer golden: a negative existence question must not be answered as present', () => {
  const question = ENDPOINT_24.questions.find(entry => entry.category === 'source_existence_ambiguity' && entry.subtype === 'near_miss')
  const answer = referenceAnswer(ENDPOINT_24)
  answer[question.queryId] = { present: true, recordId: 'REC-fabricated-near-miss' }
  const score = scoreFinalProbe({ answerText: JSON.stringify(answer), oracle: ENDPOINT_24 })
  assert.equal(score.perQuestion.find(entry => entry.queryId === question.queryId).correct, false)
  assert.equal(score.total, QUESTION_COUNT - 1)
  // A bare null is legal only for an absent existence question.
  const nullAnswer = referenceAnswer(ENDPOINT_24)
  nullAnswer[question.queryId] = null
  assert.equal(scoreFinalProbe({ answerText: JSON.stringify(nullAnswer), oracle: ENDPOINT_24 }).total, QUESTION_COUNT)
})

test('scorer golden: an empty required array is a whole-probe format failure', () => {
  const question = ENDPOINT_24.questions.find(entry => entry.category === 'timeline_dependency')
  const answer = referenceAnswer(ENDPOINT_24)
  answer[question.queryId] = { order: [] }
  const score = scoreFinalProbe({ answerText: JSON.stringify(answer), oracle: ENDPOINT_24 })
  assert.equal(score.status, 'FORMAT_FAILURE')
  assert.equal(score.total, 0)
  assert.equal(score.formatFailure, true)
})

test('scorer golden: missing answers count as wrong without a format failure', () => {
  const answer = referenceAnswer(ENDPOINT_24)
  const [removed] = Object.keys(answer)
  delete answer[removed]
  const score = scoreFinalProbe({ answerText: JSON.stringify(answer), oracle: ENDPOINT_24 })
  assert.equal(score.status, 'SCORED')
  assert.equal(score.total, QUESTION_COUNT - 1)
  assert.deepEqual(score.missing, [removed])
})

test('scorer: unknown fields, unknown ids and duplicate ids are rejected loudly', () => {
  const answer = referenceAnswer(ENDPOINT_24)
  answer[ENDPOINT_24.questions[0].queryId] = { value: ENDPOINT_24.questions[0].oracle.expected.value, extra: 1 }
  const unknownField = scoreFinalProbe({ answerText: JSON.stringify(answer), oracle: ENDPOINT_24 })
  assert.equal(unknownField.status, 'FORMAT_FAILURE')
  assert.match(unknownField.formatDetail, /unknown fields/)

  const unknownId = referenceAnswer(ENDPOINT_24)
  unknownId['N24-Q999'] = { value: 'x' }
  assert.equal(scoreFinalProbe({ answerText: JSON.stringify(unknownId), oracle: ENDPOINT_24 }).formatReason, 'SCHEMA_VIOLATION')

  const duplicate = JSON.stringify(referenceAnswer(ENDPOINT_24)).replace('{', `{"N24-Q001":{"value":"dup"},`)
  const duplicateScore = scoreFinalProbe({ answerText: duplicate, oracle: ENDPOINT_24 })
  assert.equal(duplicateScore.status, 'FORMAT_FAILURE')
  assert.equal(duplicateScore.formatReason, 'DUPLICATE_FIELD')

  const nullRequired = referenceAnswer(ENDPOINT_24)
  const stateQuestion = ENDPOINT_24.questions.find(entry => entry.category === 'state')
  nullRequired[stateQuestion.queryId] = { value: null }
  assert.equal(scoreFinalProbe({ answerText: JSON.stringify(nullRequired), oracle: ENDPOINT_24 }).formatReason, 'SCHEMA_VIOLATION')
})

test('scorer: exposures downgrade probeClean without removing the common score', () => {
  const answer = referenceAnswer(ENDPOINT_24)
  const exposed = ENDPOINT_24.longTailRequiredIds[0]
  const score = scoreFinalProbe({ answerText: JSON.stringify(answer), oracle: ENDPOINT_24, exposures: [exposed] })
  assert.equal(score.total, QUESTION_COUNT)
  assert.equal(score.probeCleanCount, QUESTION_COUNT - 1)
  assert.equal(score.probeCleanLongTailCount, LONG_TAIL_REQUIRED_COUNT - 1)
  assert.equal(score.longTailProbeCleanPassed, false)
  assert.equal(score.perQuestion.find(entry => entry.queryId === exposed).probeClean, false)
})

test('strict parser rejects every frozen format failure', () => {
  assert.deepEqual(parseAnswerObject('{"a":1}').value, { a: 1 })
  assert.equal(parseAnswerObject('{"a":1}').status, 'ok')
  assert.deepEqual(parseAnswerObject('```json\n{"a":1}\n```').value, { a: 1 })
  assert.deepEqual(parseStrictJson('{"a":[1,{"b":"c"}],"d":null}'), { a: [1, { b: 'c' }], d: null })
  const cases = [
    ['', 'EMPTY_ANSWER'],
    ['   ', 'EMPTY_ANSWER'],
    ['[{"a":1}]', 'NOT_AN_OBJECT'],
    ['here is the answer {"a":1}', 'NOT_AN_OBJECT'],
    ['{"a":1} {"b":2}', 'MULTIPLE_CANDIDATES'],
    ['{"a":1} trailing text', 'MULTIPLE_CANDIDATES'],
    ['{"a":1,"a":2}', 'DUPLICATE_FIELD'],
    ['{"a":}', 'MALFORMED_JSON'],
    ['{"a":1', 'MALFORMED_JSON'],
    ['```\n{"a":1}\n```\nnote', 'TEXT_OUTSIDE_FENCE'],
    ['before\n```\n{"a":1}\n```', 'TEXT_OUTSIDE_FENCE'],
    ['```\n{"a":1}\n```\n```\n{"b":2}\n```', 'MULTIPLE_FENCES'],
    ['```\n{"a":1}', 'UNBALANCED_FENCE'],
  ]
  for (const [text, reason] of cases) {
    const view = parseAnswerObject(text)
    assert.equal(view.status, reason, `${JSON.stringify(text)} -> ${view.status}`)
    assert.equal(view.ok, false)
    assert.equal(view.value, null)
    assert.throws(() => parseAnswerObject(text, { throw: true }), error => error instanceof AnswerFormatError && error.reason === reason)
  }
})

test('scorer accepts the pre-parsed batch form used by the driver', () => {
  const parsed = referenceAnswer(ENDPOINT_24)
  const untouched = ENDPOINT_24.questions.find(entry => !ENDPOINT_24.batches[2].includes(entry.queryId))
  const full = scoreFinalProbe({ parsed, oracle: ENDPOINT_24 })
  assert.equal(full.status, 'SCORED')
  assert.equal(full.total, QUESTION_COUNT)
  const batchFailure = scoreFinalProbe({
    parsed,
    oracle: ENDPOINT_24,
    formatFailures: [{ batch: 3, queryIds: ENDPOINT_24.batches[2], reason: 'MALFORMED_JSON' }],
  })
  assert.equal(batchFailure.status, 'FORMAT_FAILURE')
  assert.equal(batchFailure.formatFailure, true)
  assert.equal(batchFailure.total, QUESTION_COUNT - ENDPOINT_24.batches[2].length)
  for (const queryId of ENDPOINT_24.batches[2]) {
    assert.equal(batchFailure.perQuestion.find(entry => entry.queryId === queryId).reason, 'format_failure')
  }
  assert.equal(batchFailure.perQuestion.find(entry => entry.queryId === untouched.queryId).reason, 'correct')
  const unknown = scoreFinalProbe({ parsed: { ...parsed, 'N24-Q999': { value: 'x' } }, oracle: ENDPOINT_24 })
  assert.equal(unknown.formatReason, 'SCHEMA_VIOLATION')
})

test('parseAnswerObject enforces scored fields when given the oracle', () => {
  const answer = referenceAnswer(ENDPOINT_24)
  const question = ENDPOINT_24.questions.find(entry => entry.category === 'timeline_dependency')
  const broken = JSON.parse(JSON.stringify(answer))
  delete broken[question.queryId].order
  assert.equal(parseAnswerObject(JSON.stringify(broken), { oracle: ENDPOINT_24 }).status, 'SCHEMA_VIOLATION')
  assert.throws(
    () => parseAnswerObject(JSON.stringify(broken), { oracle: ENDPOINT_24, throw: true }),
    error => error instanceof AnswerFormatError && error.reason === 'SCHEMA_VIOLATION',
  )
  assert.equal(parseAnswerObject(JSON.stringify(answer), { oracle: ENDPOINT_24 }).status, 'ok')
})

test('oracle schema integrity rejects unknown fields, duplicates and impossible counts', () => {
  assert.deepEqual(oracleShapeProblems(ENDPOINT_24), [])
  const clone = () => JSON.parse(JSON.stringify(ENDPOINT_24))
  const unknown = clone()
  unknown.surprise = true
  assert.ok(oracleShapeProblems(unknown).some(problem => problem.includes('unknown oracle field surprise')))
  const duplicate = clone()
  duplicate.questions[1].queryId = duplicate.questions[0].queryId
  assert.ok(oracleShapeProblems(duplicate).some(problem => problem.includes('duplicate queryId')))
  const brokenQuartile = clone()
  brokenQuartile.questions[0].quartile = 3
  assert.ok(oracleShapeProblems(brokenQuartile).some(problem => problem.includes('quartile')))
  const extraField = clone()
  extraField.questions[0].leaked = 1
  assert.ok(oracleShapeProblems(extraField).some(problem => problem.includes('unknown question field leaked')))
  assert.throws(() => scoreFinalProbe({ answerText: '{}', oracle: unknown }), /ORACLE_INVALID/)
})

test('requiredLatestUser and longTailRequired identifiers follow the frozen pattern', () => {
  assert.deepEqual(ENDPOINT_24.requiredLatestUserIds, [
    'N24-Q001', 'N24-Q002', 'N24-Q003', 'N24-Q004',
    'N24-Q025', 'N24-Q026', 'N24-Q027', 'N24-Q028',
    'N24-Q049', 'N24-Q050', 'N24-Q051', 'N24-Q052',
    'N24-Q073', 'N24-Q074', 'N24-Q075', 'N24-Q076',
  ])
  assert.deepEqual(ENDPOINT_24.longTailRequiredIds, [
    'N24-Q007', 'N24-Q008', 'N24-Q009', 'N24-Q010', 'N24-Q011', 'N24-Q012',
    'N24-Q013', 'N24-Q014', 'N24-Q015', 'N24-Q016', 'N24-Q017', 'N24-Q018',
  ])
  for (const endpoint of ALLOWED_ENDPOINTS) {
    const oracle = ORACLES.get(endpoint)
    assert.deepEqual(oracle.longTailRequiredIds, ENDPOINT_24.longTailRequiredIds.map(id => id.replace('N24-', `N${endpoint}-`)))
    assert.equal(oracle.materials.episodes, endpoint)
  }
})

// ---------------------------------------------------------------------------
// Bounded fixture tools
// ---------------------------------------------------------------------------

function toolHarness() {
  const root = mkdtempSync(join(tmpdir(), 'w1-tools-'))
  const controlRoot = join(root, 'control')
  const cwd = join(root, 'dsh-context-experiment-w1')
  mkdirSync(controlRoot, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const fixturePath = join(root, 'fixture.json')
  writeFileSync(fixturePath, JSON.stringify({ pages: CORPUS.pages.slice(0, 24), actions: CORPUS.actions.slice(0, 12) }))
  for (const [name, text] of Object.entries(CORPUS.codeFixture.files)) writeFileSync(join(cwd, name), text)
  const registered = new Map()
  let guardFn = null
  applyFixtureTools({
    tools: { register: definition => registered.set(definition.name, definition), guard: fn => { guardFn = fn } },
    on: () => {},
  }, { controlRoot, fixturePath, phase: 'work' })
  const sessionId = 'session-w1'
  const agent = { session: { id: sessionId, header: { cwd } } }
  const writeControl = value => writeFileSync(join(controlRoot, `${sessionId}.control.json`), JSON.stringify(value))
  writeControl({ phase: 'work', fixturePath, assignedPages: [1, 2, 3], assignedEpisodes: [1, 2, 3, 4, 5, 6] })
  const exec = (name, callId) => ({ agent, callId, name, signal: { throwIfAborted() {} } })
  return {
    root, controlRoot, cwd, fixturePath, sessionId, agent, registered,
    guard: execValue => guardFn(execValue),
    call: (name, args, callId = 'c1') => registered.get(name).execute(args, exec(name, callId)),
    writeControl,
    logRows: () => readFileSync(join(controlRoot, 'tool-access.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('fixture tools: cordis shape and permission policy', async () => {
  assert.deepEqual(inject, ['tools'])
  const harness = toolHarness()
  try {
    assert.equal(harness.guard({ agent: harness.agent, callId: 'c-shell', name: 'shell' }).includes('permits only'), true)
    assert.equal(harness.guard({ agent: harness.agent, callId: 'c-hist', name: 'arc_status' }), undefined)
    assert.equal(harness.guard({ agent: harness.agent, callId: 'c-read', name: 'experiment_read_page' }), undefined)
    assert.equal(harness.guard({ agent: { session: { id: 'foreign', header: { cwd: '/tmp/other' } } }, callId: 'c-x', name: 'shell' }), undefined)
    const page = await harness.call('experiment_read_page', { page: 1 })
    assert.equal(page.text, CORPUS.pages[0])
    await assert.rejects(harness.call('experiment_read_page', { page: 12 }), /outside the assigned set/)
    const work = await harness.call('experiment_work_file', { file: 'limits.js' })
    assert.ok(work.text.includes('limits'))
    await assert.rejects(harness.call('experiment_write_file', { file: 'protected.txt', text: 'tampered' }), /Invalid source module write/)
    const written = await harness.call('experiment_write_file', { file: 'policy.js', text: 'export function evaluate() { return { allowed: false, charge: 0 }; }\n' })
    assert.ok(written.text.includes('policy.js'))
    const rows = harness.logRows()
    assert.ok(rows.some(row => row.name === 'shell' && row.status === 'DENIED' && row.reason))
    for (const row of rows) {
      for (const field of ['time', 'sessionId', 'callId', 'name', 'status', 'reason']) assert.ok(Object.hasOwn(row, field), JSON.stringify(row))
    }
  } finally {
    harness.cleanup()
  }
})

test('fixture tools: probe phases deny all experiment access and the control file fails closed', async () => {
  const harness = toolHarness()
  try {
    const first = CORPUS.actions[0]
    await harness.call('experiment_apply_operation', { operationId: first.actionId, args: { idempotencyKey: first.idempotencyKey } }, 'c-apply')
    harness.writeControl({ phase: 'probe', fixturePath: harness.fixturePath, assignedPages: [1, 2, 3] })
    assert.ok(harness.guard({ agent: harness.agent, callId: 'c-probe', name: 'experiment_read_page' }).includes('Blind probe'))
    await assert.rejects(harness.call('experiment_read_page', { page: 1 }), /Blind probes/)
    await assert.rejects(harness.call('experiment_write_file', { file: 'policy.js', text: 'x' }), /Blind probes/)
    await assert.rejects(harness.call('experiment_apply_operation', { operationId: first.actionId, args: { idempotencyKey: first.idempotencyKey } }), /Blind probes/)
    // A history tool stays available even during the blind probe.
    assert.equal(harness.guard({ agent: harness.agent, callId: 'c-hist2', name: 'search_context' }), undefined)
    // Unreadable control file fails closed.
    unlinkSync(join(harness.controlRoot, `${harness.sessionId}.control.json`))
    assert.ok(harness.guard({ agent: harness.agent, callId: 'c-closed', name: 'experiment_read_page' }).includes('fail closed'))
    await assert.rejects(harness.call('experiment_read_page', { page: 1 }))
  } finally {
    harness.cleanup()
  }
})

test('fixture tools: operations commit durably and replay without a new effect', async () => {
  const harness = toolHarness()
  try {
    const action = CORPUS.actions[0]
    const first = JSON.parse((await harness.call('experiment_apply_operation', { operationId: action.actionId, args: { idempotencyKey: action.idempotencyKey } }, 'c1')).text)
    assert.equal(first.receipt.operationId, action.actionId)
    assert.equal(first.replayed, undefined)
    const journalPath = join(harness.controlRoot, `${harness.sessionId}.operations.jsonl`)
    const statePath = join(harness.controlRoot, `${harness.sessionId}.operation-state.json`)
    assert.equal(existsSync(journalPath), true)
    assert.equal(existsSync(statePath), true)
    const before = readFileSync(journalPath, 'utf8')
    const stateBefore = readFileSync(statePath, 'utf8')
    const replay = JSON.parse((await harness.call('experiment_apply_operation', { operationId: action.actionId, args: { idempotencyKey: action.idempotencyKey } }, 'c2')).text)
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.receipt, first.receipt)
    assert.equal(readFileSync(journalPath, 'utf8'), before)
    assert.equal(readFileSync(statePath, 'utf8'), stateBefore)
    // Wrong key and unsatisfied preconditions are denied and leave no receipt.
    await assert.rejects(harness.call('experiment_apply_operation', { operationId: action.actionId, args: { idempotencyKey: 'wrong' } }, 'c3'), /Wrong idempotency key/)
    const later = CORPUS.actions[3]
    await assert.rejects(harness.call('experiment_apply_operation', { operationId: later.actionId, args: { idempotencyKey: later.idempotencyKey } }, 'c4'), /Unsatisfied preconditions/)
    await assert.rejects(harness.call('experiment_apply_operation', { operationId: 'ACT-missing', args: { idempotencyKey: 'x' } }, 'c5'), /Unknown workflow operation/)
    assert.equal(readFileSync(journalPath, 'utf8'), before)
  } finally {
    harness.cleanup()
  }
})

// The oracle must ask about things the corpus actually contains.
//
// This is the guard for the defect that made the first executed campaign's
// quality score meaningless: every endpoint question named a `targetLabel`
// (`STATE-…`, `TML-…`, `EXACT-ISL-…`, `EXIST-ISL-…`) and expected verbatim values
// that appeared in NO page, so all 96 questions were unanswerable and both arms
// scored the same degenerate 21/96 by answering "absent" everywhere. A question
// the model cannot reach is not a quality measurement.
test('every sealed oracle question names a target and values the corpus actually contains', async () => {
  const { generateCorpus, generateOracle } = await import('./fixture.mjs')
  const salt = 'a'.repeat(64)
  const episodes = 24
  const corpus = generateCorpus({ seed: 91561, salt, episodes })
  const pages = corpus.pages.join('\n')
  const oracle = generateOracle({ corpus, endpoint: episodes })
  const missing = []
  for (const question of oracle.questions) {
    if (question.targetLabel && !pages.includes(question.targetLabel)) {
      missing.push(`${question.queryId} targetLabel ${question.targetLabel}`)
    }
    for (const value of Object.values(question.oracle.expected ?? {})) {
      for (const scalar of Array.isArray(value) ? value : [value]) {
        // Short scalars (a boolean, "REVOKED", a latency) can legitimately be
        // reconstructed rather than copied; long verbatim values must exist.
        if (typeof scalar === 'string' && scalar.length >= 8 && !pages.includes(scalar)) {
          missing.push(`${question.queryId} expected ${scalar}`)
        }
      }
    }
  }
  assert.deepEqual(missing.slice(0, 10), [], `oracle references content absent from the corpus (${missing.length} problems)`)
})
