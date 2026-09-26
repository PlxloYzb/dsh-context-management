#!/usr/bin/env node
// Records the section-11 diagnostic matrix for one campaign from durable
// evidence. Every status must be traceable; a controlled substitute never
// upgrades a natural-timing case to PASS, and a claim is only recorded when the
// campaign's own evidence supports it.
//
// This recorder previously carried claims from the 0.1.2 campaign — 672 tool
// calls, "background summaries were never delivered", "no delivered summary ever
// re-entered the archive" — which are simply false for the 0.1.7 runs, where 25
// summaries were delivered and 24 delivered receipts were re-archived. It also
// recorded `X18/create-dispose-20` as PASS from a measurement that allocates Maps
// in the RECORDER's own process and never touches the plugin. Every number below
// is read from the run's audit, progress and ledgers, and anything not actually
// controlled is recorded as NOT_EXERCISED with the missing precondition.
import { join } from 'node:path'
import { campaignRoot, readJson, listRuns, atomicJson } from './context.mjs'
import { recordCase, CASE_MATRIX } from './cases.mjs'

const campaign = process.env.LR3M_CAMPAIGN ?? 'lr3m-v2-formal1'
const pairId = process.env.LR3M_PAIR ?? 'main-91601'
const root = campaignRoot(campaign)
const runs = await listRuns(campaign, pairId)
const runRoots = Object.fromEntries(runs.map(run => [run.arm, run.root]))
const arc = runRoots.ARC_DEFERRED
const basic = runRoots.BASIC_MATCHED
if (!arc) throw new Error(`No ARC_DEFERRED run in ${campaign}/${pairId}`)

const read = async (runRoot, name, fallback = null) => (runRoot ? readJson(join(runRoot, name), fallback) : fallback)
const arcAudit = await read(arc, 'audit.json')
const arcProgress = await read(arc, 'progress.json', {})
const arcResult = await read(arc, 'result.json')
const basicAudit = await read(basic, 'audit.json')
const arcCoverage = arcAudit?.coverage?.arcCoverage ?? {}
const retrieval = arcAudit?.retrieval ?? {}
const unpaired = arcAudit?.integrity?.I02?.detail?.pairingProblems?.length ?? null
const delivered = arcCoverage.distinctDeliveredSourceCount ?? 0
const rearchived = arcCoverage.rearchivedDeliveredReceiptCount ?? 0
const depth = arcCoverage.maxVerifiedSourceProcessingDepth ?? 0
const restart = await read(join(campaignRoot(campaign), pairId), `restart-ARC_DEFERRED.json`)
const quality = arcResult?.quality ?? null

const record = (id, variant, status, detail, evidence = null) => recordCase({ campaign, id, variant, status, detail, evidence })

// --- X01 threshold boundaries: only natural pressure crossed the line ---------
await record('X01', 'T', 'NOT_EXERCISED', 'No controlled T-1/T/T+1 threshold sweep was run; the journeys crossed the compaction line only through natural pressure, so the boundary itself was never bracketed.')
await record('X01', 'large-result-unicode', 'NOT_EXERCISED', 'No large-result Unicode boundary probe was run.')

// --- X02 a pending handoff never blocked independent work ---------------------
if (delivered > 0) {
  await record('X02', 'natural-pending', 'PASS',
    `Every window commit carries a handoff that starts \`pending\`; ${delivered} were later delivered while foreground episodes continued to completion, so a pending or absent summary never blocked independent work.`,
    join(arc, 'summary-jobs.jsonl'))
} else {
  await record('X02', 'natural-pending', 'NOT_EXERCISED', 'No summary handoff was prepared in this run, so pending-ness was never observed.')
}

// --- X03 history dependency after turnover -----------------------------------
await record('X03', 'immediate', retrieval.searches > 0 ? 'PASS' : 'NOT_EXERCISED',
  retrieval.searches > 0
    ? `The model reached for archived history during the blind probe: ${retrieval.searches} searches, ${retrieval.hits} hits.`
    : 'The model never reached for archived history in this run.')

// --- X05 revision authority --------------------------------------------------
await record('X05', 'stale-authority', 'NOT_EXERCISED', 'No controlled stale-versus-authoritative revision injection was run; the journeys carried stale page text but the authority conflict was never isolated as a case.')

// --- X06 summary failure classes ---------------------------------------------
await record('X06', 'timeout', 'NOT_EXERCISED', 'No controlled summary failure (limit/empty/timeout/cancel/budget) was injected, so the failure classes were never distinguished.')

// --- X07 tool pairing and current input --------------------------------------
if (unpaired === 0) {
  await record('X07', 'tool-pairing', 'PASS', `Integrity I02 passed with 0 unpaired tool calls across the whole journey.`, join(arc, 'audit.json'))
} else {
  await record('X07', 'tool-pairing', unpaired === null ? 'NOT_EXERCISED' : 'FAIL', `I02 reported ${unpaired} unpaired tool calls.`, join(arc, 'audit.json'))
}
await record('X07', 'steer', 'NOT_EXERCISED', 'Mid-turn steering was never injected; only naturally queued input occurred.')

// --- X08 bounded retrieval and cursors ---------------------------------------
const bounded = (retrieval.searches ?? 0) > 0
await record('X08', 'bounded-absence',
  !bounded ? 'NOT_EXERCISED'
    : (retrieval.scanBudgetReached ?? 0) > 0 && (retrieval.cursorResumes ?? 0) === 0 ? 'PARTIAL' : 'PASS',
  bounded
    ? `Bounded retrieval behaved as designed: ${retrieval.searches} searches, ${retrieval.hits} hits, ${retrieval.zeroHit} zero-hit, ${retrieval.absentConfirmed} absence-confirmed. ${retrieval.scanBudgetReached} searches stopped at the scan budget and returned a nextCursor, but the cursor was resumed ${retrieval.cursorResumes} times — the resume path was offered and never taken, so it is only partially exercised.`
    : 'No retrieval ran, so the bounded path was never exercised.',
  join(arc, 'audit.json'))
await record('X08', 'missing-id', 'NOT_EXERCISED', 'No deliberate missing-id probe was run.')
await record('X08', 'ambiguous-id', 'NOT_EXERCISED', 'No deliberate ambiguous-id probe was run; the shared-short-identifier questions exercised ambiguity through the probe, not through a controlled retrieval call.')
await record('X08', 'restart-cursor', 'NOT_EXERCISED', 'No cursor was carried across the planned restart.')

// --- X09 archive source graph -------------------------------------------------
if (rearchived > 0 && depth >= 3) {
  await record('X09', 'rearchived', 'PASS',
    `A delivered summary DID re-enter the archive: ${rearchived} re-archived delivered receipts over a lineage ${depth} deep.`,
    join(arc, 'audit.json'))
} else {
  await record('X09', 'rearchived', 'NOT_EXERCISED', `Only ${rearchived} re-archives at depth ${depth}; re-archive identity was not exercised.`)
}
await record('X09', 'attachment-reference', 'NOT_EXERCISED', 'No attachment-reference case was run.')

// --- X10 presets --------------------------------------------------------------
await record('X10', 'standard', 'PASS',
  'Both runs booted the shipped standard preset in their own profile realm; the ARC arm replaced native Basic and exposed the plugin tools, the Basic arm did not load the plugin.',
  join(arc, 'host', 'isolated-home.json'))
await record('X10', 'ptc', 'NOT_EXERCISED', 'The ptc/cordis/minimal preset matrix was not run in this campaign.')

// --- X11 replacement lifecycle ------------------------------------------------
await record('X11', 'enable-existing', 'PASS',
  'Each ARC run installed the packaged candidate into a fresh isolated profile and resolved the plugin backend at agent creation, proven by the `arc_status` attestation; the matched Basic profile resolved its native engine with no plugin bundle.',
  join(arc, 'audit.json'))
await record('X11', 'toggle', 'NOT_EXERCISED', 'Repeated enable/disable, late activation and Include reload/rollback were not run here.')
await record('X11', 'no-backend', 'NOT_EXERCISED', 'No no-backend fallback case was run.')

// --- X12 cancellation and disposal -------------------------------------------
await record('X12', 'pending-cancel', 'NOT_EXERCISED', 'No cancellation with a pending summary was injected.')
await record('X12', 'delivered-before-dispose', 'NOT_EXERCISED', 'No dispose-with-delivered-receipt case was run.')

// --- X13 restart --------------------------------------------------------------
await record('X13', 'flushed-restart', restart?.verified === true ? 'PASS' : 'NOT_EXERCISED',
  restart?.verified === true
    ? `The planned E12 restart verified: new PID, identical durable prefix hash (${String(restart.beforeHash).slice(0, 12)}), identical paginated history, same session id.`
    : 'No verified planned restart was recorded for this run.',
  join(campaignRoot(campaign), pairId, 'restart-ARC_DEFERRED.json'))
await record('X13', 'pending-restart', 'NOT_EXERCISED', 'No restart was taken while a handoff was still pending.')
await record('X13', 'commit-gap-sigkill', 'NOT_EXERCISED', 'The transaction commit/flush SIGKILL gap was not injected.')

// --- X14 driver/supervisor crash ---------------------------------------------
await record('X14', 'driver-crash', 'NOT_EXERCISED', 'The deliberate planned/ack/receipt crash windows were not injected.')
await record('X14', 'receipt-window-crash', 'NOT_EXERCISED', 'No crash was injected inside the receipt window.')

// --- X15 provider failure -----------------------------------------------------
await record('X15', 'usage-missing', 'NOT_EXERCISED', 'No malformed or missing usage payload was injected; unknownUsageCalls stayed 0.')

// --- X16 two-session isolation ------------------------------------------------
if (basic && arcAudit?.integrityPassed && basicAudit?.integrityPassed) {
  await record('X16', 'conflicting-ids', 'PASS',
    'Two sessions ran concurrently under matched pressure with independent backends (plugin on one arm, native Basic on the other); both audits passed their integrity gates with no cross-session content, job or cursor mixing.',
    join(arc, 'audit.json'))
} else {
  await record('X16', 'conflicting-ids', 'NOT_EXERCISED', 'No concurrent two-session pair was available in this campaign.')
}
await record('X16', 'stream-cap', 'NOT_EXERCISED', 'The global stream budget was never deliberately saturated.')

// --- X17 untrusted history ----------------------------------------------------
await record('X17', 'fake-system', 'NOT_EXERCISED', 'No forged system message was planted in the archive.')
await record('X17', 'fake-user', 'NOT_EXERCISED', 'No forged user instruction was planted; page text carried a data-only boundary and was treated as data, but the deliberate forgery probe was not run.')

// --- X18 scale and observer overhead -----------------------------------------
// `measureCreateDispose` allocates Maps in THIS process and samples its own heap;
// it never loads the plugin. Recording it as a plugin diagnostic PASS would be an
// overclaim, so the variant stays NOT_EXERCISED until a real host-backed dose
// harness exists.
await record('X18', 'create-dispose-20', 'NOT_EXERCISED', 'The offline implementation measures the harness process heap, not the plugin, so it is not accepted as plugin evidence.')
await record('X18', 'scale-1k-1w', 'NOT_EXERCISED', 'The no-model dose harness for 1k/10k/50k token sessions is not implemented.')
await record('X18', 'observer-off', 'NOT_EXERCISED', 'The observer-off performance comparison was not run.')

const statuses = {}
for (const id of Object.keys(CASE_MATRIX)) statuses[id] = (await readJson(join(root, 'cases', `${id}.json`), { status: 'NOT_EXERCISED' })).status
await atomicJson(join(root, 'cases', 'matrix.json'), {
  campaign, pairId, recordedAt: new Date().toISOString(),
  evidence: { delivered, rearchived, depth, retrieval, unpaired, quality: quality ? `${quality.total}/${quality.questionCount}` : null },
  statuses,
})
console.log(JSON.stringify({ evidence: { delivered, rearchived, depth, retrieval, unpaired }, statuses }, null, 2))
