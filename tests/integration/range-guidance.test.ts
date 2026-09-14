import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultCountTokens } from 'acp-kernel'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildCompressibleSeqRanges, shadowedSeqsOf } from '../../src/region.ts'
import { extractEventText } from '../../src/messages.ts'
import { host, newSession } from './runtime.ts'
import { appendUser, appendAssistant, appendMultiToolCall, appendToolResult } from '../helpers.ts'

for (const catalog of [false, true]) {
  test(`range guidance prices the balanced span and rejects regenerated-only spans (catalog=${catalog})`, async t => {
    const h = await host(); t.after(h.close)
    const session = newSession(h.ctx, `guidance-shrink-${catalog}`)
    session.append('turn/start', { turn: 1 }); appendUser(session, 'CURRENT: finish the assigned reading')
    if (catalog) session.append('user/message', createUserMessage({
      source: { kind: 'skill-catalog', form: 'catalog', entries: [], update: true },
      content: [{ type: 'text', text: 'Current skill catalog. '.repeat(500) }],
    }), { surfaceOp: 'append' })
    else appendAssistant(session, 'A small consumed historical note.')
    const prefix = session.surface.nodes.at(-1)!
    session.append('step/start', { turn: 1, step: 1 })
    appendMultiToolCall(session, 'Read two large pages', ['guidance-a', 'guidance-b'])
    appendToolResult(session, 'Large consumed page A. '.repeat(1000), 'guidance-a')
    appendToolResult(session, 'Large protected page B. '.repeat(1000), 'guidance-b')
    session.append('step/end', { turn: 1, step: 1 })
    for (let i = 0; i < 4; i++) appendAssistant(session, 'Recent work remains protected.')
    const ranges = buildCompressibleSeqRanges(session)
    if (catalog) assert.deepEqual(ranges, [], 'The host restores its latest catalog, so it cannot yield savings by itself')
    else assert.deepEqual(ranges, [{ start: prefix, end: prefix, count: 1, tokens: defaultCountTokens(extractEventText(session.eventAt(prefix)!)) }])
  })
}

test('range guidance never expands across the current user while balancing multi-tool calls', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'guidance-expanded-user')
  session.append('turn/start', { turn: 1 }); appendUser(session, 'CURRENT instruction must stay visible')
  const current = session.surface.nodes.at(-1)!
  for (let step = 1; step <= 3; step++) {
    session.append('step/start', { turn: 1, step })
    const ids = [`a-${step}`, `b-${step}`]
    appendMultiToolCall(session, 'Read assigned pages', ids, 1, step)
    for (const id of ids) appendToolResult(session, 'Source page. '.repeat(200), id, 1, step)
    session.append('step/end', { turn: 1, step })
  }
  for (const options of [{}, { preserveRecentSteps: 2 }]) {
    const ranges = buildCompressibleSeqRanges(session, options)
    for (const range of ranges) assert.ok(!shadowedSeqsOf(session, range.start, range.end).includes(current))
    assert.deepEqual(ranges, [], 'No plain reference before the tool calls can be used without crossing protected input')
  }
})
