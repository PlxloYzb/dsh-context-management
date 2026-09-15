import test from 'node:test'
import assert from 'node:assert/strict'
import { retrievalOutcomes } from '../turnover/retrieval-outcomes.mjs'

const call = (id, name) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id, name, arguments: '{}' }] } } })
const result = (id, value, isError = false) => ({ type: 'tool/result', data: { message: { source: { kind: 'tool', callId: id }, content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError }] } } })

test('retrieval outcomes require durable successful tool results', () => {
  const events = [
    call('search-ok', 'search_context'), result('search-ok', { status: 'success', hits: [] }),
    call('decompress-limit', 'decompress'), result('decompress-limit', { status: 'error', code: 'retrieval-allowance-exhausted' }),
    call('search-denied', 'search_context'), result('search-denied', 'Error: This phase permits no tools; answer UNKNOWN for missing facts.', true),
    call('search-missing', 'search_context'),
    call('unrelated', 'arc_status'), result('unrelated', { status: 'success' }),
  ]
  assert.deepEqual(retrievalOutcomes(events), {
    attempts: 4,
    successes: 1,
    failures: 2,
    missingResults: 1,
    statusCounts: { success: 1, error: 1, 'invalid-result': 1, 'missing-result': 1 },
  })
})
