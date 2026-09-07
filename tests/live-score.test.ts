import test from 'node:test'
import assert from 'node:assert/strict'
import { score } from './live/fixture.mjs'

test('Live scoring selects the complete answer independently of correctness; equal coverage uses the last answer', () => {
  const expected = { A: 'alpha', B: 'beta', C: 'gamma' }
  assert.equal(score('{"A":"alpha","B":"beta","C":"gamma"}\nCorrection citation: {"B":"beta"}', expected).correct, 3)
  assert.equal(score('{"A":"wrong","B":"wrong","C":"wrong"}\nCitation: {"B":"beta"}', expected).correct, 0)
  assert.equal(score('{"A":"alpha","B":"beta","C":"gamma"}\n{"A":"wrong","B":"wrong","C":"wrong"}', expected).correct, 0)
})
