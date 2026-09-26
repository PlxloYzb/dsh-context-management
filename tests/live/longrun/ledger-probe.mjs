// Harness probe: does our block ledger index the compaction blocks that the
// NATIVE Basic engine produced in this run?
//
// The Basic arm intentionally does not load our plugin, so the ledger is
// imported from the repository build and its hash is recorded with the result;
// the question is whether our index reads the durable log the host already has,
// not which build is installed.
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Identity of the built ledger implementation: every dist JS file, path-sorted. */
function distManifestHash(entryModule) {
  const directory = resolve(dirname(entryModule))
  const hash = createHash('sha256')
  for (const name of readdirSync(directory).filter(entry => entry.endsWith('.js')).sort()) {
    hash.update(`${name}\0${createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')}\n`)
  }
  return hash.digest('hex')
}

export const inject = ['sessions']

export function apply(ctx, config) {
  const write = value => writeFileSync(config.output, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  let target = null
  let observations = 0
  let maxBlocks = 0
  // Keeps observing rather than stopping at the first block: an early snapshot
  // understates how much the engine has compacted by the end of the session.
  // The interval is cleared on dispose, so no separate "done" flag is needed;
  // an earlier revision referenced one that was never declared and crashed the
  // host at load time.
  let failed = false
  // The patch is written before the session exists, so the probe discovers it.
  ctx.on('session/created', session => {
    if (String(session?.header?.cwd ?? '').includes('dsh-context-experiment-')) target = session
  })
  const attempt = async () => {
    if (failed) return
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
        // The entry re-exports the ledger from a build-hashed chunk, so hashing
        // the entry alone would not identify the implementation. Hash every dist
        // JavaScript file in path order instead.
        ledgerDistManifestSha256: distManifestHash(config.ledgerModule),
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
      if (!failed) { failed = true; write({ error: String(error.message ?? error) }) }
    }
  }
  const entry = value => String(value.blockId).slice(0, 8)
  const timer = setInterval(() => { void attempt() }, 1000)
  ctx.on('dispose', () => clearInterval(timer))
}
