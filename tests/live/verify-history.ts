import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { ArchiveReader, resolveSources, eventTextParts } from '../../src/archive.ts'
import { archiveHealth } from '../../src/archive-health.ts'

const reportPath = process.argv[2]
if (!reportPath) throw new Error('Pass one live evidence JSON path')
const report = JSON.parse(await readFile(reportPath, 'utf8'))
const events = JSON.parse(await readFile(`.test-runtime/observed/${report.sessionId}.events.json`, 'utf8'))
const session = Session.create(SessionId(report.sessionId), events)
const reader = new ArchiveReader(), ledger = reader.ledger(session)
const facts = { archiveCount: ledger.length, recoveredTextSources: 0, recoveredTextBytes: 0, pages: 0, pairingBalanced: false, sourceTextComplete: false, cursorScopeChecks: 0, requestPairingChecked: 0, integrity: archiveHealth(session.snapshotEvents()) }
for (const block of ledger) {
  const sources = resolveSources(session, block.shadowedSeqs, ledger)
  assert.equal(sources.incomplete, false, `incomplete sources for ${block.blockId}`)
  const expected = new Map<string, string>()
  for (const seq of sources.seqs) for (const part of eventTextParts(session.eventAt(seq as never)!).texts) expected.set(`${seq}:${part.path.join('.')}`, part.text)
  const actual = new Map<string, string>()
  let cursor: string | undefined
  for (let count = 0; count < 100000; count++) {
    const page = reader.decompress(session, { blockId: block.blockId, cursor, maxTokens: 4096 }) as { status: string; incomplete: boolean; segments: { seq: number; textBlockPath: number[]; offset: number; text: string }[]; nextCursor: string | null }
    assert.equal(page.status, 'success')
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096)
    for (const segment of page.segments) {
      const key = `${segment.seq}:${segment.textBlockPath.join('.')}`
      // No-text message markers do not create a fictitious text block.
      if (!expected.has(key)) { assert.equal(segment.text, ''); continue }
      assert.equal(segment.offset, (actual.get(key) ?? '').length)
      actual.set(key, (actual.get(key) ?? '') + segment.text)
    }
    facts.pages++
    if (page.nextCursor && facts.cursorScopeChecks === 0) {
      const foreign = Session.create(SessionId(`${session.id}-foreign`), events)
      assert.match(JSON.stringify(reader.decompress(foreign, { blockId: block.blockId, cursor: page.nextCursor })), /invalid-cursor/)
      assert.match(JSON.stringify(new ArchiveReader().decompress(session, { blockId: block.blockId, cursor: page.nextCursor })), /invalid-cursor/)
      const other = ledger.find(candidate => candidate.blockId !== block.blockId)
      if (other) assert.match(JSON.stringify(reader.decompress(session, { blockId: other.blockId, cursor: page.nextCursor })), /invalid-cursor/)
      const empty = Session.create(SessionId(`${session.id}-empty`), [])
      assert.match(JSON.stringify(reader.decompress(empty, { blockId: block.blockId })), /block-not-found/)
      facts.cursorScopeChecks = other ? 4 : 3
    }
    if (!page.nextCursor) break
    assert.notEqual(cursor, page.nextCursor)
    cursor = page.nextCursor
    if (count === 99999) throw new Error('archive pagination did not terminate')
  }
  assert.deepEqual(actual, expected, `exact source text recovery for ${block.blockId}`)
  facts.recoveredTextSources += expected.size
  for (const text of expected.values()) facts.recoveredTextBytes += Buffer.byteLength(text)
}
for (const event of events) if (event.type === 'request/header') {
  const prefix = Session.create(SessionId(`${session.id}-request-${event.seq}`), events.slice(0, event.seq + 1))
  if (prefix.surface.nodes.length) assert.equal(toolPairingBalancedAfter(prefix, prefix.surface.nodes.at(-1)!), true, `provider request seq ${event.seq} is paired`)
  facts.requestPairingChecked++
}
facts.pairingBalanced = toolPairingBalancedAfter(session, session.surface.nodes.at(-1)!)
facts.sourceTextComplete = true
report.sourceVerification = facts
report.incomplete = [...new Set(report.incomplete)]
if (facts.integrity.incomplete) report.failures.push('archive-integrity-incomplete')
assert.equal(facts.pairingBalanced, true)
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ sessionId: session.id, ...facts }))
