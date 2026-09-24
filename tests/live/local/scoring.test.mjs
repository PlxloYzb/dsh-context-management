import test from 'node:test'
import assert from 'node:assert/strict'
import { jsonObjects, salvageObjects, selectAnswer, pageValue, findAnswer } from './scoring.mjs'

/**
 * Answer extraction for the live probes.
 *
 * Three real runs in this repository scored zero for reasons that had nothing to
 * do with the model's answer: a reply keyed by the bare page number instead of
 * PAGE-<n>, and a reply truncated mid-object. Those shapes are used here as the
 * fixtures, because a synthetic case would not have caught either.
 */

// The verbatim probe's shape: PAGE-<n> keys, checksum values.
const VERBATIM_TRUTH = { 'PAGE-11': 'ae3790159a', 'PAGE-46': '6da15bef1b', 'PAGE-89': '0972779886' }

test('S1: a complete object is extracted exactly as before', () => {
  const text = 'Here it is:\n{"F01": "/srv/x/config.yaml", "F02": "value-abc"}\ndone'
  const answer = selectAnswer(text)
  assert.equal(answer.facts.F01, '/srv/x/config.yaml')
  assert.equal(answer.facts.F02, 'value-abc')
  assert.equal(jsonObjects(text).length, 1)
})

test('S2: a reply truncated mid-object still scores the values it did emit', () => {
  // Verbatim shape of run A-4307-3: 106 characters, cut off inside the object
  // with tool-call markup trailing, which previously parsed to nothing.
  const text = '```json\n{\n  "F01": "/srv/project-7b43468e/config.yaml",\n  "F02": "value-6abcf32c",</arg_value></tool_call>'
  assert.equal(jsonObjects(text).length, 0, 'a truncated object is not a complete object')
  const answer = selectAnswer(text)
  assert.equal(answer?.facts?.F01, '/srv/project-7b43468e/config.yaml')
  assert.equal(answer?.facts?.F02, 'value-6abcf32c')
  assert.equal(Object.hasOwn(answer.facts, 'F03'), false, 'no value may be invented')
})

test('S3: salvage keeps only pairs that are fully present and valid', () => {
  const salvaged = salvageObjects('{"A": "one", "B": "two", "C": ')
  assert.deepEqual(salvaged.map(x => x.value), [{ A: 'one', B: 'two' }])
  assert.deepEqual(salvageObjects('no object here'), [])
  assert.deepEqual(salvageObjects('{"A": '), [], 'a single unterminated pair yields nothing')
})

test('S4: nested objects are not mistaken for top-level pairs', () => {
  const text = '{"facts": {"F01": "a", "F02": "b"}, "extra": 1'
  const answer = selectAnswer(text)
  assert.equal(answer?.facts?.F01, 'a')
  assert.equal(answer?.facts?.F02, 'b')
})

test('S5: a reply with no answer at all still scores nothing', () => {
  assert.equal(selectAnswer('I could not recover those values.'), null)
  assert.equal(selectAnswer(''), null)
  assert.equal(selectAnswer('{ broken'), null)
})

// The verbatim probe's own key resolution.
const verbatimScore = (reply) => Object.keys(VERBATIM_TRUTH).filter(k => pageValue(reply, k) === VERBATIM_TRUTH[k]).length

test('S6: bare page-number keys resolve to the PAGE-<n> the probe asked for', () => {
  // Verbatim shape of run longidx1, which scored 0/3 while being byte-exact.
  const bare = { '11': 'ae3790159a', '46': '6da15bef1b', '89': '0972779886' }
  assert.equal(verbatimScore(bare), 3, 'bare keys answer the same question')
  assert.equal(verbatimScore(VERBATIM_TRUTH), 3, 'prefixed keys still work')
})

test('S7: an honest null is present but never a match', () => {
  // Verbatim shape of the native arm, which correctly reported unavailability.
  const unavailable = { 'PAGE-11': null, 'PAGE-46': null, 'PAGE-89': null }
  assert.equal(pageValue(unavailable, 'PAGE-11'), null, 'null is a stated answer, not a missing key')
  assert.equal(verbatimScore(unavailable), 0, 'reporting unavailable must not score')
  assert.equal(pageValue({ '11': null }, 'PAGE-11'), null, 'bare null resolves the same way')
})

test('S8: a wrong value is still wrong, whichever key form it uses', () => {
  assert.equal(verbatimScore({ '11': 'deadbeef00', '46': 'deadbeef00', '89': 'deadbeef00' }), 0)
  assert.equal(pageValue(null, 'PAGE-11'), undefined)
  assert.equal(pageValue(undefined, 'PAGE-11'), undefined)
})

// Both probes read one object out of a reply through findAnswer.
test('S9: findAnswer prefers a complete object and falls back only when none matches', () => {
  const wants = o => o && Object.hasOwn(o, 'literals')
  const complete = '{"literals": {"a": "b"}}'
  assert.deepEqual(findAnswer(complete, wants), { literals: { a: 'b' } })
  // A complete object that does not satisfy the predicate must not block salvage.
  const mixed = '{"other": 1}\n{"literals": {"a": "b"},'
  assert.deepEqual(findAnswer(mixed, wants), { literals: { a: 'b' } })
  assert.equal(findAnswer('nothing useful', wants), undefined)
})

test('S10: a truncated probe reply no longer reads as a missing answer', () => {
  // The absence probe's shape, cut off inside the object. The inner literals
  // object is complete, so the complete-object path does return something - just
  // not the object the probe asked for, which is why the fallback is what saves it.
  const truncated = '{"literals": {"trace=abc": "PAGE-63", "trace=def": null},</arg_value>'
  const wants = o => o?.literals
  assert.equal(jsonObjects(truncated).map(x => x.value).findLast(wants), undefined,
    'the complete-object path alone cannot satisfy the probe')
  const lit = findAnswer(truncated, wants)?.literals
  assert.equal(lit?.['trace=abc'], 'PAGE-63')
  assert.equal(lit?.['trace=def'], null, 'a stated null survives as null')
})
