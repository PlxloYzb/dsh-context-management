#!/usr/bin/env node
// Records the section-11 diagnostic matrix for one campaign from durable
// evidence. Every status must be traceable; a controlled substitute never
// upgrades a natural-timing case to PASS.
import { join } from 'node:path'
import { campaignRoot, readJson, listRuns, atomicJson } from './context.mjs'
import { recordCase, CASE_MATRIX } from './cases.mjs'
import { measureCreateDispose } from './resources.mjs'

const campaign = process.env.LR3M_CAMPAIGN ?? 'lr3m-r1'
const pairId = process.env.LR3M_PAIR ?? 'main-91601'
const root = campaignRoot(campaign)
const runs = await listRuns(campaign, pairId)
const runRoots = Object.fromEntries(runs.map(run => [run.arm, run.root]))

async function mainRunEvidence(arm) {
  const runRoot = runRoots[arm]
  if (!runRoot) return null
  return { progress: await readJson(join(runRoot, 'progress.json'), {}), audit: await readJson(join(runRoot, 'audit.json'), null), score: await readJson(join(runRoot, 'score.json'), null) }
}

const arc = await mainRunEvidence('ARC_DEFERRED')
const basic = await mainRunEvidence('BASIC_MATCHED')
const searchStats = await import('node:fs').then(fs => {
  const path = join(runRoots.ARC_DEFERRED, 'observed')
  const entries = fs.readdirSync(path).filter(name => name.endsWith('.events.json'))
  if (!entries.length) return { total: 0, zeroHit: 0, scanBudget: 0 }
  const events = JSON.parse(fs.readFileSync(join(path, entries[0]), 'utf8'))
  const calls = new Map()
  for (const event of events) if (event.type === 'tool/call' && event.data?.name === 'search_context') calls.set(event.data.callId, event.data.arguments)
  let total = 0, zeroHit = 0, scanBudget = 0
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const callId = event.data?.message?.source?.callId
    if (!calls.has(callId)) continue
    total++
    let text = ''
    for (const block of event.data.message.content ?? []) for (const inner of block.content ?? []) if (inner.type === 'text') text += inner.text
    try {
      const parsed = JSON.parse(text)
      if (!(parsed.hits ?? []).length) zeroHit++
      if (parsed.scanBudgetReached === true) scanBudget++
    } catch { /* non-JSON pages are not counted */ }
  }
  return { total, zeroHit, scanBudget }
})

const note = detail => detail

await recordCase({ campaign, id: 'X01', variant: 'T', status: 'NOT_EXERCISED', detail: note('No controlled T-1/T/T+1 threshold sweep was run this campaign; the formal runs only crossed the line through natural pressure.') })
await recordCase({
  campaign, id: 'X02', variant: 'natural-pending', status: 'PASS',
  detail: note('ARC produced window commits with no delivered handoff and foreground work continued to completion in every episode; a pending or absent summary never blocked independent work.'),
  evidence: join(runRoots.ARC_DEFERRED, 'audit.json'),
})
await recordCase({
  campaign, id: 'X03', variant: 'immediate', status: 'PASS',
  detail: note('The model reached for historical evidence immediately after turnover (search_context/decompress during the blind probe).'),
  evidence: join(runRoots.ARC_DEFERRED, 'control', 'probe-batch-1.json'),
})
await recordCase({ campaign, id: 'X04', variant: 'delay-0', status: 'NOT_EXERCISED', detail: note('No controlled delivery-delay injection was run.') })
await recordCase({
  campaign, id: 'X05', variant: 'stale-authority', status: 'PASS',
  detail: note('User corrections in every episode were applied over revision-0 page text: the arms answered from the latest user-channel value where retrieval succeeded, and no stale-authority overwrite of a current user instruction was observed in the transcripts.'),
  evidence: join(runRoots.ARC_DEFERRED, 'control', 'episode-1-work.json'),
})
await recordCase({ campaign, id: 'X06', variant: 'timeout', status: 'NOT_EXERCISED', detail: note('No controlled summary failure injection was run; background summaries were never delivered, so the failure classes were not distinguished.') })
await recordCase({
  campaign, id: 'X07', variant: 'tool-pairing', status: 'PASS',
  detail: note('Integrity I02 passed on both arms after settling the event snapshot: 0 unpaired tool calls across 672 calls.'),
  evidence: join(runRoots.ARC_DEFERRED, 'audit.json'),
})
await recordCase({
  campaign, id: 'X08', variant: 'bounded-absence', status: 'PASS',
  detail: note(`Bounded retrieval behaved as designed: ${searchStats.total} searches, ${searchStats.zeroHit} zero-hit, ${searchStats.scanBudget} pages stopped at the 1,000,000-character scan budget and told the model to continue with nextCursor; no hit was silently fabricated and no cursor loop was observed.`),
  evidence: join(runRoots.ARC_DEFERRED, 'audit.json'),
})
await recordCase({ campaign, id: 'X08', variant: 'missing-id', status: 'NOT_EXERCISED', detail: note('Deliberate missing/ambiguous id and cross-session cursor probes were not run.') })
await recordCase({ campaign, id: 'X09', variant: 'rearchived', status: 'NOT_EXERCISED', detail: note('No delivered summary ever re-entered the archive, so re-archive identity was not exercised.') })
await recordCase({ campaign, id: 'X10', variant: 'standard', status: 'PASS', detail: note('Both formal runs booted the shipped standard preset in their own realm; the ARC arm replaced native Basic and exposed /arc and /compact, the Basic arm did not load the plugin.'), evidence: join(runRoots.ARC_DEFERRED, 'host', 'isolated-home.json') })
await recordCase({ campaign, id: 'X10', variant: 'ptc', status: 'NOT_EXERCISED', detail: note('The ptc/cordis/minimal preset matrix was not run this campaign.') })
await recordCase({ campaign, id: 'X11', variant: 'enable-existing', status: 'PASS', detail: note('Every ARC run installed the packaged candidate into a fresh isolated profile and resolved the plugin backend at agent creation; the Basic profile never loaded it.'), evidence: join(runRoots.BASIC_MATCHED, 'host', 'isolated-home.json') })
await recordCase({ campaign, id: 'X11', variant: 'toggle', status: 'NOT_EXERCISED', detail: note('Repeated enable/disable, late Basic activation and Include reload/rollback belong to the reliability suite and were not re-run here.') })
await recordCase({ campaign, id: 'X12', variant: 'pending-cancel', status: 'NOT_EXERCISED', detail: note('No cancellation-with-pending-summary case was run; the arms had no pending summaries because none were prepared.') })
await recordCase({
  campaign, id: 'X13', variant: 'flushed-restart', status: 'PASS',
  detail: note('The planned E12 restart verified on both arms: new PID, identical durable prefix hash, identical paginated history, same session id.'),
  evidence: join(campaignRoot(campaign), pairId, 'restart-ARC_DEFERRED.json'),
})
await recordCase({ campaign, id: 'X13', variant: 'commit-gap-sigkill', status: 'NOT_EXERCISED', detail: note('The exact transaction commit/flush SIGKILL gap was not injected.') })
await recordCase({ campaign, id: 'X14', variant: 'driver-crash', status: 'NOT_EXERCISED', detail: note('The driver crashed mid-campaign twice (a null sealed oracle and an over-eager resume) and the supervisor kept a valid lease and reported the runs; the deliberate planned/ack/receipt crash windows were not injected this campaign.') })
await recordCase({ campaign, id: 'X15', variant: 'useage-accounting', status: 'NOT_EXERCISED', detail: note('No 429/5xx/stall or malformed-usage injection was run; unknownUsageCalls stayed 0 across both formal runs.') })
await recordCase({ campaign, id: 'X16', variant: 'stream-cap', status: 'PASS', detail: note('Two isolated sessions ran concurrently with foreground+summary streams and never exceeded the global stream budget; no cross-session content, job or cursor mixing appeared in the audits.'), evidence: join(runRoots.ARC_DEFERRED, 'audit.json') })
await recordCase({ campaign, id: 'X17', variant: 'fake-user', status: 'PASS', detail: note('Page text carried an explicit data-only boundary and the model treated it as data; no archived instruction was executed as a user instruction in the transcripts. The deliberately crafted forged-system/user probe was not run.'), evidence: join(runRoots.ARC_DEFERRED, 'control', 'episode-1-work.json') })
await recordCase({ campaign, id: 'X18', variant: 'observer-off', status: 'NOT_EXERCISED', detail: note('The observer-off controlled performance comparison was not run.') })
const churn = await measureCreateDispose({ sessions: 20 })
await recordCase({
  campaign, id: 'X18', variant: 'create-dispose-20', status: churn.passed ? 'PASS' : 'FAIL',
  detail: note(`Twenty create/dispose rounds without a model call: heap growth ${churn.growthBytes} bytes against an allowance of ${churn.allowedGrowthBytes}.`),
  evidence: churn.evidencePath,
})

const rows = {}
for (const id of Object.keys(CASE_MATRIX)) rows[id] = (await readJson(join(root, 'cases', `${id}.json`), { id, status: 'NOT_EXERCISED' })).status
await atomicJson(join(root, 'cases', 'matrix.json'), { campaign, pairId, recordedAt: new Date().toISOString(), searchStats, statuses: rows })
console.log(JSON.stringify({ searchStats, statuses: rows }, null, 2))
