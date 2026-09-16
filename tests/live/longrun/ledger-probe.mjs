// Harness probe: does our block ledger index the compaction blocks that the
// NATIVE Basic engine produced in this run?
//
// The Basic arm intentionally does not load our plugin, so the ledger is
// imported from the repository build and its hash is recorded with the result;
// the question is whether our index reads the durable log the host already has,
// not which build is installed.
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const inject = ['sessions']

export function apply(ctx, config) {
  const write = value => writeFileSync(config.output, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  let target = null
  let observations = 0
  let maxBlocks = 0
  // Keep observing rather than stopping at the first block: an early snapshot
  // understates how much the engine has compacted by the end of the session.
  let settled = false
  // The patch is written before the session exists, so the probe discovers it.
  ctx.on('session/created', session => {
    if (String(session?.header?.cwd ?? '').includes('dsh-context-experiment-')) target = session
  })
  const attempt = async () => {
    if (done) return
    const session = target ?? (config.sessionId ? ctx.sessions.get(config.sessionId) : null)
    if (!session) return
    if (!session.snapshotEvents().some(event => event.type === 'compaction/summary')) return
    try {
      const module = await import(config.ledgerModule)
      const events = session.snapshotEvents()
      const ledger = module.rebuildBlockLedger(events)
      const summaries = events.filter(event => event.type === 'compaction/summary').length
      const replacements = events.filter(event => event.type === 'user/message' && event.surfaceOp?.op === 'replace').length
      observations += 1
      maxBlocks = Math.max(maxBlocks, ledger.length)
      if (ledger.length < maxBlocks) return
      write({
        sessionId: session.id,
        observations,
        maxBlocksObserved: maxBlocks,
        ledgerModule: config.ledgerModule,
        ledgerModuleSha256: createHash('sha256').update(readFileSync(config.ledgerModule)).digest('hex'),
        events: events.length,
        compactionSummaries: summaries,
        replaceSurfaceOps: replacements,
        ledgerBlocks: ledger.length,
        blocksWithArcMetadata: ledger.filter(entry => entry.contextManagement !== undefined).length,
        shadowedSeqTotal: ledger.reduce((sum, entry) => sum + entry.shadowedSeqs.length, 0),
        shadowedTokenTotal: ledger.reduce((sum, entry) => sum + entry.shadowedTokenCount, 0),
        firstBlock: ledger[0] ? { blockId: entry(ledger[0]), tier: ledger[0].tier, shadowedSeqs: ledger[0].shadowedSeqs.slice(0, 4) } : null,
      })
    } catch (error) {
      if (!settled) { settled = true; write({ error: String(error.message ?? error) }) }
    }
  }
  const entry = value => String(value.blockId).slice(0, 8)
  const timer = setInterval(() => { void attempt() }, 1000)
  ctx.on('dispose', () => clearInterval(timer))
}
