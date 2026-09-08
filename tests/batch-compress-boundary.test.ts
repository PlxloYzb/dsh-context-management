/**
 * Batch compression must preserve the protected recent tail. A range that
 * partially intersects it may compress eligible messages; sequential ranges
 * must observe each earlier committed checkpoint.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ArcCompactionEngine } from '../src/index.ts'
import { makeTools, type ToolEnvironment } from '../src/tools.ts'
import type { ToolRunContext } from '../src/tools.ts'
import { buildTextSession } from './helpers.ts'

const SUMMARY = 'Compressed checkpoint: range replaced by this summary; originals recoverable via decompress.'

function setup(limit: number): { compress: ReturnType<typeof makeTools>[number], execFor: (session: unknown) => ToolRunContext } {
  const ctx = new Context()
  const engine = new ArcCompactionEngine(ctx, { modelContextLimit: limit, autoNudge: false })
  const env = {
    kernel: engine.kernel,
    store: engine.store,
    prompts: engine.prompts,
    config: engine.config,
  } as unknown as ToolEnvironment
  const compress = makeTools(env).find((tool) => tool.name === 'compress')!
  const execFor = (session: unknown): ToolRunContext => ({
    callId: 'call-batch-boundary',
    name: 'compress',
    arguments: {},
    signal: new AbortController().signal,
    agent: { session, ctx, options: {} },
  }) as unknown as ToolRunContext
  return { compress, execFor }
}

test('batch and sequential agree at the protected-zone boundary', async () => {
  const { compress, execFor } = setup(32768)
  // 16 messages; the protected zone (last 5) leaves 1..11 compressible.
  const ranges: Array<[number, number]> = [[1, 5], [6, 8], [9, 11]]

  const batchSession = buildTextSession(16)
  const batch = await compress.execute(
    { content: ranges.map(([start, end]) => ({ startSeq: start, endSeq: end, summary: SUMMARY })) },
    execFor(batchSession),
  )
  assert.equal(batch.text.includes('compress failed'), false)
  assert.match(batch.text, /Compressed 3 block\(s\), ~\d+ tokens reclaimed\./)
  assert.equal(
    batchSession.snapshotEvents().filter((event) => event.type === 'compaction/summary').length,
    3,
  )

  let sequentialOk = true
  const seqSession = buildTextSession(16)
  for (const [start, end] of ranges) {
    const single = await compress.execute(
      { content: [{ startSeq: start, endSeq: end, summary: SUMMARY }] },
      execFor(seqSession),
    )
    if (single.text.includes('compress failed')) sequentialOk = false
  }
  assert.equal(sequentialOk, true)
  assert.equal(
    seqSession.snapshotEvents().filter((event) => event.type === 'compaction/summary').length,
    3,
  )
})
