// A distinct offline mechanism test: protect work completed while a summary
// was pending. Uses the shared transaction; does not modify product behavior.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WindowController, resolveArchiveConfig } from '../../src/window-controller.ts'
import { runCompactionTransaction } from '../../src/region.ts'
import { resolveShadowedTokenCount } from '../../src/fallback.ts'
import { eventTextParts } from '../../src/archive.ts'
import { host, newSession, newInput } from '../integration/runtime.ts'
import { appendUser, appendAssistant, appendToolCall, appendToolResult } from '../helpers.ts'
const root = resolve('.test-runtime/turnover-muse-20260915')
const handoff = JSON.parse(await readFile(resolve(root, 'paired-b-91511/boundary.json'), 'utf8')).summaryText
const marker = 'fresh-suffix-7e0183', rows = [], h = await host()
try {
  for (const mode of ['whole-frozen-prefix', 'snapshot-prefix-only']) {
    const session = newSession(h.ctx, mode), controller = new WindowController()
    session.append('turn/start', { turn: 1 }); appendUser(session, 'Older synthetic source.')
    session.append('step/start', { turn: 1, step: 1 })
    appendToolCall(session, 'Read older record.', 'older')
    appendToolResult(session, '{"olderRecord":"archived-value"}\n' + 'historical filler '.repeat(3000), 'older')
    session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const prefix = [...session.surface.nodes]
    newInput(session, 'Continue foreground work.', 2)
    session.append('step/start', { turn: 2, step: 1 })
    appendAssistant(session, `During foreground work I verified a new checkpoint marker: ${marker}.`, 2, 1)
    const freshSeq = session.surface.nodes.at(-1)
    session.append('step/end', { turn: 2, step: 1 }); session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    newInput(session, 'Continue at the next boundary, retaining newly verified work.', 3)
    const agent = { session, ctx: h.ctx, options: {} }, before = JSON.stringify(session.snapshotEvents())
    const beforeLength = session.snapshotEvents().length
    const started = performance.now()
    if (mode === 'whole-frozen-prefix') {
      await controller.turnover(agent, 'pressure', new AbortController().signal, resolveArchiveConfig(), () => h.ctx.sessions.flush(session), { requestId: mode, generation: 0, turn: 3, handoff })
    } else {
      const identity = controller.identity(session)
      await controller.exclusive(session, async () => runCompactionTransaction(session, {
        start: prefix[0], end: prefix.at(-1), shadowedSeqs: prefix,
        shadowedTokenCount: resolveShadowedTokenCount(agent, prefix),
        summary: [{ type: 'text', text: 'Historical summary; current instructions and the retained suffix take precedence.\n' + handoff }],
        provider: 'fixture', model: 'synthetic', contextManagement: { schemaVersion: 1, kind: 'window', trigger: 'pressure', fromWindowId: identity.windowId, toWindowId: randomUUID(), generationAfter: 1, parentBlockIds: [], route: { provider: 'fixture', model: 'synthetic' }, seed: { incomplete: true, formatVersion: 1, mode: 'model-assisted' } },
      }), () => h.ctx.sessions.flush(session))
    }
    const visible = session.surface.nodes.map(seq => eventTextParts(session.eventAt(seq)).texts.map(part => part.text).join('\n')).join('\n')
    const row = { mode, transactionMs: performance.now() - started, freshMessageStillOnSurface: session.surface.nodes.includes(freshSeq), freshMarkerVisible: visible.includes(marker), appendOnly: JSON.stringify(session.snapshotEvents().slice(0, beforeLength)) === before, generation: controller.identity(session).generation }
    assert.equal(row.appendOnly, true); assert.equal(row.generation, 1)
    assert.equal(row.freshMarkerVisible, mode === 'snapshot-prefix-only')
    rows.push(row)
  }
} finally { await h.close() }
await writeFile(resolve(root, 'suffix-mechanism.json'), JSON.stringify({ kind: 'offline-shared-transaction-suffix-test', rows }, null, 2), { mode: 0o600 })
console.log(JSON.stringify(rows, null, 2))
