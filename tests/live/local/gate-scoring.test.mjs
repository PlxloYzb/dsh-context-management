import test from 'node:test'
import assert from 'node:assert/strict'
import { score, corpus } from '../fixture.mjs'

/**
 * The three-arm Web gate's scorer.
 *
 * This lives under local/ because `test:live:local:unit` is the only script that
 * runs live unit tests inside `npm run check`, and this scorer had no test at all.
 * It is the scorer the gate actually uses, and it carried the same truncation
 * fault as the local one: a reply cut off mid-object matched no flat-brace regex,
 * so every value it had already emitted was discarded and the sample scored zero.
 */
const fixture = corpus(4307)
const expected = { ...fixture.facts, ...fixture.corrections }

test('G1: a complete object is still scored exactly as before', () => {
  const reply = JSON.stringify({ F01: expected.F01, F02: expected.F02 })
  const result = score(reply, expected)
  assert.equal(result.correct, 2)
  assert.equal(result.values.F01, expected.F01)
})

test('G2: a reply truncated mid-object scores the values it did emit', () => {
  // The raw shape of gate run A-4307-3's restart reply, which scored 0 of 12.
  const reply = '```json\n{\n  "F01": "/srv/project-7b43468e/config.yaml",\n  "F02": "value-6abcf32c",</arg_value></tool_call>'
  const result = score(reply, expected)
  assert.equal(result.values?.F01, expected.F01)
  assert.equal(result.values?.F02, expected.F02)
  assert.equal(result.correct, 2, 'both emitted values are correct for seed 4307')
  assert.equal(Object.hasOwn(result.values, 'F03'), false, 'nothing may be invented')
})

test('G3: an unusable reply still scores nothing', () => {
  assert.equal(score('I could not recover those values.', expected).correct, 0)
  assert.equal(score('', expected).correct, 0)
  assert.equal(score('{ "F01": ', expected).correct, 0, 'one unterminated pair is not an answer')
})

test('G4: coverage selection is unchanged for well-formed replies', () => {
  // A later, smaller object must not replace the complete answer.
  const reply = `${JSON.stringify({ F01: expected.F01, F02: expected.F02, F03: expected.F03 })}\n${JSON.stringify({ F01: expected.F01 })}`
  const result = score(reply, expected)
  assert.equal(result.correct, 3)
})
