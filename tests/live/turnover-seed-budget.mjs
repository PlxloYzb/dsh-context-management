// Offline real-controller capacity stress using a retained real Muse handoff.
// This is separate from the one-user controlled fixture, where space is ample.
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { WindowController, resolveArchiveConfig } from '../../src/window-controller.ts'
import { host, newSession, newInput } from '../integration/runtime.ts'
import { appendUser, appendToolCall, appendToolResult } from '../helpers.ts'
const root = resolve('.test-runtime/turnover-muse-20260915')
const sample = JSON.parse(await readFile(resolve(root, 'paired-b-91511/boundary.json'), 'utf8'))
const data = JSON.parse(await readFile(resolve(root, 'paired-b-91511/fixture.json'), 'utf8'))
const rows = [], h = await host()
try {
  for (const users of [1, 12, 24, 48]) for (const variant of ['real-compact', 'synthetic-1300-char-stress']) {
    const handoff = variant === 'real-compact' ? sample.summaryText : 'Synthetic handoff padding; '.repeat(50).slice(0, 1300 - sample.summaryText.length) + sample.summaryText
    const session = newSession(h.ctx, `seed-budget-${users}-${variant}`)
    for (let turn = 1; turn <= users; turn++) {
      session.append('turn/start', { turn })
      appendUser(session, `Historical requirement ${turn}: ${'Synthetic product constraint remains active. '.repeat(40)}`)
      session.append('step/start', { turn, step: 1 })
      appendToolCall(session, 'Read synthetic budget filler.', `call-${turn}`, turn, 1)
      appendToolResult(session, JSON.stringify(Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`record_${turn}_${i}`, `archive-value-${turn}-${i}-${'x'.repeat(55)}`]))) + '\n' + 'filler '.repeat(2000), `call-${turn}`, turn, 1)
      session.append('step/end', { turn, step: 1 }); session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    newInput(session, 'Protect the current user; continue after turnover.', users + 1)
    const controller = new WindowController(), started = performance.now()
    const result = await controller.turnover({ session, ctx: h.ctx, options: {} }, 'pressure', new AbortController().signal, resolveArchiveConfig(), () => h.ctx.sessions.flush(session), { requestId: `budget-${users}`, generation: 0, turn: users + 1, handoff })
    if (!result) throw new Error('Expected budget stress replacement')
    const seed = result.summary.map(block => block.text ?? '').join('\n')
    rows.push({ variant, historicalUsers: users, handoffChars: handoff.length, seedBytes: Buffer.byteLength(seed), elapsedMs: performance.now() - started, handoffFieldsRetained: Object.fromEntries(Object.entries(data.expected).filter(([key]) => key !== 'verbatim').map(([key, value]) => [key, seed.includes(value)])), truncationNotice: seed.includes('[Handoff truncated;'), handoffRejected: controller.status(session).lastOperation?.handoffRejected ?? null })
  }
} finally { await h.close() }
await writeFile(process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'seed-budget-stress.json'), JSON.stringify({ kind: 'offline-real-controller-with-retained-Muse-handoff', rows }, null, 2), { mode: 0o600 })
console.log(JSON.stringify(rows, null, 2))
