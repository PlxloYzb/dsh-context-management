// Offline audit of stopped real-host boundary runs, including complete archive
// pagination. Never turns an unobserved/failed condition into a passing score.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { ArchiveReader, resolveSources, eventTextParts } from '../../src/archive.ts'

const root = resolve(process.argv[2] ?? '')
assert.ok(root.startsWith(resolve('.test-runtime/turnover-muse-20260915') + '/'))
const report = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'))
assert.ok(report.finishedAt && report.completed, 'Audit requires a completed stopped sample')
const rows = JSON.parse(await readFile(join(root, 'final-events.json'), 'utf8'))
const session = Session.create(report.sessionId, rows), reader = new ArchiveReader(), ledger = reader.ledger(session)
assert.equal(ledger.length, 1, 'one pressure replacement expected')
assert.ok(report.appendOnly)
const current = rows.find(event => event.type === 'user/message' && event.data.id === ledger[0].contextManagement.incomingUserId)
assert.ok(current && !ledger[0].shadowedSeqs.includes(current.seq))
assert.ok(toolPairingBalancedBefore(session, session.surface.nodes[0]))
assert.ok(toolPairingBalancedAfter(session, session.surface.nodes.at(-1)))
const metadata = ledger[0].contextManagement
const boundaryEnd = rows.find(e => e.type === 'compaction/end' && e.data.compactionId === ledger[0].blockId)
const atBoundary = Session.create(report.sessionId, rows.slice(0, boundaryEnd.seq + 1))
const freshRawRetained = atBoundary.surface.nodes.includes(report.freshSeq)
if (metadata.seed.prepared) {
  assert.equal(ledger[0].shadowedSeqs.at(-1), metadata.seed.prepared.throughSeq)
  assert.ok(freshRawRetained, 'work after the summary snapshot remains verbatim')
  const sourceEvents = ledger[0].shadowedSeqs.map(seq => session.eventAt(seq))
  assert.equal(createHash('sha256').update(JSON.stringify(sourceEvents)).digest('hex'), metadata.seed.prepared.sourceHash)
}
assert.ok(Buffer.byteLength(ledger[0].summary) <= 4096)
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
const orchestration = (await readFile(join(root, 'engine.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
const accesses = orchestration.filter(row => row.phase === 'tool')
const successfulRetrievalCalls = accesses.filter(row => row.allowed && ['search_context', 'decompress'].includes(row.name)).length
const foreground = local[0]
const overlapMs = cloud.reduce((sum, call) => sum + Math.max(0, Math.min(call.end, foreground.end) - Math.max(call.start, foreground.start)), 0)
assert.ok(cloud.every(call => call.reasoningEffort === 'minimal'))
assert.ok([...calls.values()].every(call => call.purpose !== 'session-title'))
const boundary = orchestration.find(row => row.phase === 'pre-step' && row.after > row.before)
assert.ok(boundary)
let lateDelivery = null
if (report.fault === 'late') {
  const network = orchestration.find(row => row.phase === 'fault-network-finish')
  const delivery = orchestration.find(row => row.phase === 'fault-delivery-released')
  assert.equal(metadata.seed.mode, 'extractive')
  assert.equal(boundary.summary?.status, 'late')
  assert.ok(network && delivery && network.time < boundaryEnd.time && delivery.time >= boundaryEnd.time)
  lateDelivery = { networkFinishedBeforeCommit: true, deliveredAfterCommit: true, noExtraWindow: ledger.length === 1, heldMs: delivery.time - network.time }
}
const output = { name: report.name, lateDelivery, arm: report.arm, fault: report.fault, archiveBytesVerified: true, currentInputProtected: true, toolPairsBalanced: true, appendOnly: true, localRequestsSerial: true, restoredBytes, archivePages: pages, generation: metadata.generationAfter, seedMode: metadata.seed.mode, seedBytes: Buffer.byteLength(ledger[0].summary), summaryRejected: metadata.seed.rejected ?? null, freshRawRetained, sourceHashVerified: !!metadata.seed.prepared, overlapMs, boundaryMs: boundary.elapsedMs, backgroundAtBoundary: boundary.summary, successfulRetrievalCalls, deniedToolAttempts: accesses.filter(row => !row.allowed).map(row => row.name), settingsUnchanged: report.settingsUnchanged,
  calls: [...calls.values()].map(call => ({ provider: call.provider, purpose: call.purpose, reasoningEffort: call.reasoningEffort, start: call.start, end: call.end ?? null, elapsedMs: call.end ? call.end - call.start : null, usage: call.usage ?? null, reason: call.reason ?? null })) }
await writeFile(join(root, 'audit.json'), JSON.stringify(output, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ ...output, calls: output.calls.length }))
