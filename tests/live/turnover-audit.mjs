// Offline audit of stopped real-host boundary runs, including complete archive
// pagination. Never turns an unobserved/failed condition into a passing score.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { ArchiveReader, resolveSources, eventTextParts } from '../../src/archive.ts'

const root = resolve(process.argv[2] ?? '')
assert.ok(root.startsWith(resolve('.test-runtime/turnover-muse-20260915') + '/'))
const report = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'))
assert.ok(report.finishedAt && report.completed, 'Audit requires a completed stopped sample')
// session/page is a UI page: archived spans may be collapsed. The observer
// preserves the full contiguous event log; compare every returned UI event.
const rows = JSON.parse(await readFile(join(root, `${report.sessionId}.events.json`), 'utf8'))
const webRows = JSON.parse(await readFile(join(root, 'final-events.json'), 'utf8'))
for (const event of webRows) assert.deepEqual(event, rows[event.seq])
const session = Session.create(report.sessionId, rows), reader = new ArchiveReader(), ledger = reader.ledger(session)
assert.equal(ledger.length, 1, 'The fixed-boundary sample must perform exactly one replacement')
assert.equal(ledger[0].contextManagement.seed.mode, report.boundary.summaryStatus === 'ready' ? 'model-assisted' : 'extractive')
assert.ok(report.boundary.appendOnly && report.boundary.originalToolBytesVerified)
assert.ok(report.currentInputLogged)
const current = rows.find(event => event.type === 'user/message' && event.data.id === report.boundary.incomingUserId)
assert.ok(current && !ledger[0].shadowedSeqs.includes(current.seq))
assert.ok(toolPairingBalancedBefore(session, session.surface.nodes[0]))
assert.ok(toolPairingBalancedAfter(session, session.surface.nodes.at(-1)))
let restoredBytes = 0, pages = 0
for (const block of ledger) {
  const sources = resolveSources(session, block.shadowedSeqs, ledger)
  assert.equal(sources.incomplete, false)
  const expected = new Map(), actual = new Map()
  for (const seq of sources.seqs) for (const part of eventTextParts(session.eventAt(seq)).texts) expected.set(`${seq}:${JSON.stringify(part.path)}`, part.text)
  let cursor
  do {
    const page = reader.decompress(session, { blockId: block.blockId, maxTokens: 4096, ...(cursor ? { cursor } : {}) })
    assert.equal(page.status, 'success'); assert.equal(page.incomplete, false)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096)
    for (const part of page.segments) {
      const key = `${part.seq}:${JSON.stringify(part.textBlockPath)}`
      if (!expected.has(key) && part.text === '') continue
      const before = actual.get(key) ?? ''
      assert.equal(part.offset, before.length)
      actual.set(key, before + part.text); restoredBytes += Buffer.byteLength(part.text)
    }
    cursor = page.nextCursor
    assert.ok(++pages < 2000, 'Archive cursor must terminate')
  } while (cursor)
  assert.deepEqual(actual, expected)
}
const streams = (await readFile(join(root, 'streams.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
const calls = new Map()
for (const row of streams) {
  const call = calls.get(row.id) ?? {}
  Object.assign(call, row)
  if (row.phase === 'start') call.start = row.time
  if (row.phase === 'first') call.first = row.time
  if (['finish', 'incomplete'].includes(row.phase)) call.end = row.time
  calls.set(row.id, call)
}
const local = [...calls.values()].filter(call => call.provider === report.mainRoute.provider).sort((a, b) => a.start - b.start)
for (let i = 1; i < local.length; i++) assert.ok(local[i].start >= local[i - 1].end, 'Local route requests must be serial')
const cloud = [...calls.values()].filter(call => call.purpose === 'compaction')
const orchestration = (await readFile(join(root, 'orchestration.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
if (report.fault === 'late') {
  const boundary = orchestration.find(row => row.phase === 'boundary')
  const late = orchestration.find(row => row.phase === 'summary-settled' && row.state === 'late')
  assert.ok(boundary && late && late.time >= boundary.time, 'Late delivery must settle only after fallback commitment')
  assert.equal(report.boundary.summaryStatus, 'pending')
  assert.equal(ledger[0].contextManagement.seed.mode, 'extractive')
}
const snapshot = JSON.parse(await readFile(join(root, 'snapshot.json'), 'utf8'))
const afterSnapshot = rows.filter(event => event.seq > snapshot.throughSeq && ledger[0].shadowedSeqs.includes(event.seq) && ['assistant/message', 'tool/result'].includes(event.type))
const archivedAfterSnapshotBytes = afterSnapshot.reduce((sum, event) => sum + eventTextParts(event).texts.reduce((n, part) => n + Buffer.byteLength(part.text), 0), 0)
const accesses = orchestration.filter(row => row.phase === 'tool')
const successfulRetrievalCalls = accesses.filter(row => row.allowed && ['search_context', 'decompress'].includes(row.name)).length
const deniedToolAttempts = accesses.filter(row => !row.allowed).map(row => row.name)
const foreground = local[0]
const overlapMs = cloud.reduce((sum, call) => sum + Math.max(0, Math.min(call.end, foreground.end) - Math.max(call.start, foreground.start)), 0)
const output = { name: report.name, archiveBytesVerified: true, currentInputProtected: true, toolPairsBalanced: true, appendOnly: true, localRequestsSerial: true, observedEvents: rows.length, webPageEvents: webRows.length, webPageIsFullLog: rows.length === webRows.length, restoredBytes, archivePages: pages, generation: ledger[0].contextManagement.generationAfter, seedMode: ledger[0].contextManagement.seed.mode, overlapMs, successfulRetrievalCalls, deniedToolAttempts,
  snapshotGap: { archivedMessagesAfterSnapshot: afterSnapshot.length, archivedAfterSnapshotBytes, includedInSummaryRequest: false, limitation: 'Foreground output after the frozen snapshot is archived at the forced boundary. This pilot does not test preservation of new facts learned in that suffix; production scheduling must retain or separately index it.' },
  calls: [...calls.values()].map(call => ({ provider: call.provider, purpose: call.purpose, start: call.start, end: call.end ?? null, firstContent: call.first ?? null, elapsedMs: call.end ? call.end - call.start : null, usage: call.usage ?? null, reason: call.reason ?? null })) }
await writeFile(join(root, 'audit.json'), JSON.stringify(output, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ ...output, calls: output.calls.length }))
