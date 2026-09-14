// Offline replay of every retained local-model search_context call against the
// current reader. No provider calls. It proves the exhaustive-empty feedback
// changes only pages that genuinely established absence and never turns a
// recorded empty page into an error, while hit and scan-limited pages keep
// their previous contract.
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { ArchiveReader } from '../../src/archive.ts'
import { observedEvents } from './local/observed-events.mjs'

const night = resolve('.test-runtime/nightly-20260915')
const output = resolve(process.argv[2] ?? join(night, 'search-feedback-replay.json'))
const dirs = (await readdir(night, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)

const report = { schemaVersion: 1, kind: 'offline-search-feedback-replay', runs: [], totals: {} }
let emptyPages = 0, absentPages = 0, scanLimitedPages = 0, hitPages = 0, errors = 0, cursorPages = 0

function resultText(event) {
  return (event.data?.message?.content ?? [])
    .filter(part => part?.type === 'tool-result')
    .flatMap(part => (part.content ?? []).filter(item => item?.type === 'text').map(item => item.text))
    .join('')
}

for (const dir of dirs) {
  const root = join(night, dir)
  let summary
  try { summary = JSON.parse(await readFile(join(root, 'summary.json'), 'utf8')) } catch { continue }
  if (!summary.finishedAt || !summary.sessionId) continue
  let events
  try { events = await observedEvents(join(root, 'observed'), summary.sessionId) } catch { continue }
  const calls = new Map()
  const pairs = []
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, { seq: event.seq, ...event.data })
    else if (event.type === 'tool/result') {
      for (const part of event.data?.message?.content ?? []) {
        if (part?.type !== 'tool-result') continue
        const call = calls.get(part.toolCallId)
        if (call?.name === 'search_context') pairs.push({ call, observed: resultText(event) })
      }
    }
  }
  const rows = []
  for (const { call, observed } of pairs) {
    let args
    try { args = JSON.parse(call.arguments) } catch { continue }
    let before
    try { before = JSON.parse(observed) } catch { continue }
    // Cursors are authenticated by a per-reader random secret, so a cursor page
    // cannot be replayed by a fresh offline reader. Continuation pages are also
    // outside this change: only a page that itself reaches the archive end can
    // establish absence. Record the skip instead of pretending to cover it.
    if (args.cursor !== undefined || before.status !== 'success') { cursorPages += 1; continue }
    // Replay the state the reader actually saw: the event log truncated through
    // the issuing call, before its own result is recorded.
    const session = Session.create(`${dir}-${call.seq}`, events.slice(0, call.seq + 1))
    const reader = new ArchiveReader()
    // Empty-page answers never depend on a larger grant, so 1100 (the enforced
    // minimum) reproduces them exactly and is their worst case. Hit packing
    // does depend on the grant the runner happened not to record, so hit pages
    // replay at the maximum grant; only their contract is compared, not packing.
    const emptyBefore = (before.hits?.length ?? 0) === 0
    const grant = emptyBefore ? 1100 : 4096
    const after = reader.search(session, { query: args.query, ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.cursor === undefined ? {} : { cursor: args.cursor }) }, grant)
    const bytes = Buffer.byteLength(JSON.stringify(after))
    const entry = {
      query: args.query, limit: args.limit ?? null, cursor: args.cursor ?? null,
      before: { hits: before.hits?.length ?? null, scanBudgetReached: before.scanBudgetReached ?? null, nextCursor: before.nextCursor ?? null, incomplete: before.incomplete ?? null, hint: before.hint ?? null },
      after: after.status === 'success'
        ? { hits: after.hits?.length ?? null, scanBudgetReached: after.scanBudgetReached ?? null, nextCursor: after.nextCursor ?? null, incomplete: after.incomplete ?? null, absent: after.absent ?? null, inspectedMessages: after.inspectedMessages ?? null, hint: after.hint ?? null, bytes }
        : { status: after.status, code: after.code ?? null, bytes },
    }
    if (after.status !== 'success') { errors += 1; rows.push(entry); continue }
    const empty = emptyBefore
    if (empty) {
      emptyPages += 1
      if (before.scanBudgetReached === true) {
        scanLimitedPages += 1
        // Scan-limited pages keep the continuation contract and never claim absence.
        assert.equal(after.absent, undefined, `${dir}: scan-limited page must not claim absence`)
        assert.match(after.hint ?? '', /nextCursor/)
        assert.equal(after.nextCursor !== null, true)
      } else if (before.nextCursor === null && before.incomplete === false) {
        // The one page shape the fix targets: a full-archive scan inside the
        // limit, which used to return a bare, ambiguous empty array.
        absentPages += 1
        assert.equal(after.absent, true, `${dir}: exhaustive empty page must report absence`)
        assert.ok(after.inspectedMessages > 0)
        assert.match(after.hint ?? '', /end of the archive/)
        assert.ok(bytes <= 1100, `${dir}: absence explanation must fit the minimum grant`)
      } else {
        assert.equal(after.absent, undefined, `${dir}: empty but unproven page must not claim absence`)
      }
    } else {
      hitPages += 1
      assert.equal(after.absent, undefined, `${dir}: a page with hits must not claim absence`)
      assert.ok((after.hits?.length ?? 0) > 0)
    }
    rows.push(entry)
  }
  if (rows.length) report.runs.push({ run: dir, candidateHash: summary.candidateHash ?? null, calls: rows })
}

report.totals = { replayedCalls: emptyPages + hitPages, cursorPagesSkipped: cursorPages, emptyPages, absentPages, scanLimitedPages, hitPages, errors }
report.readerArchiveSourceHash = (await import('node:crypto')).createHash('sha256').update(await readFile(new URL('../../src/archive.ts', import.meta.url))).digest('hex')
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify(report.totals))
if (errors) process.exitCode = 1
