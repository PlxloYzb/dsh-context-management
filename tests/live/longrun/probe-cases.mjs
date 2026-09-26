#!/usr/bin/env node
// Host-backed diagnostic probes for X08 (bounded retrieval and cursors).
//
// These need a REAL session with a real archive, so the harness reopens a
// completed ARC journey rather than inventing one: the archive it searches is the
// one the long run actually built. Each probe asks for one `search_context` call
// and its verbatim JSON result, which is the same shape the backend attestation
// uses — the model is a transport for the tool call, and the assertion is about
// what the TOOL returned, not about what the model concluded.
//
// The contract under test is the one the development contract states: retrieval is
// bounded historical data with explicit incomplete/error states, and never makes an
// ambiguous ID selection or loses a source silently.
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { campaignRoot, readJson, atomicJson } from './context.mjs'
import { launchHost, PINNED_HOST } from './host.mjs'
import { Driver } from './driver.mjs'
import { generateCorpus } from './fixture.mjs'
import { recordCase } from './cases.mjs'

const PROBES = [
  // A literal the archive cannot contain. The tool must NOT claim absence it did
  // not establish: either the scan completed (`absent: true`) or it stopped at the
  // scan budget and handed back a cursor saying so.
  { name: 'missing-id', query: 'ZZZ-NOT-IN-ARCHIVE-9f3c2b', expect: { minHits: 0, maxHits: 0, absenceMustBeEarned: true } },
  // Two distinct records carry this short id (pages 38 and 39). Retrieval must
  // return what it found rather than silently selecting one.
  { name: 'ambiguous-id', query: 'short=d4ba', expect: { minHits: 1, maxHits: null } },
  { name: 'unique-id', query: 'short=2847', expect: { minHits: 1, maxHits: null } },
]

// Attribute each result to the call that asked for it. Scanning the joined
// transcript for "some object with a hits key" attributed all three probes to the
// first one, which made the other two look empty.
export function probeResults(events) {
  const calls = new Map()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.name === 'search_context') {
      let args = {}
      try { args = JSON.parse(event.data.arguments ?? '{}') } catch { args = {} }
      calls.set(event.data.callId, args.query)
    }
  }
  const byQuery = new Map()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const query = calls.get(event.data?.message?.source?.callId)
    if (query === undefined) continue
    let text = ''
    for (const block of event.data.message.content ?? []) {
      if (block.type === 'text') text += block.text
      for (const inner of block.content ?? []) if (inner.type === 'text') text += inner.text
    }
    try { byQuery.set(query, JSON.parse(text)) } catch { byQuery.set(query, null) }
  }
  return byQuery
}

export function judgeProbe(probe, parsed) {
  const problems = []
  if (!parsed) return ['no search result observed for this query']
  const hits = Array.isArray(parsed.hits) ? parsed.hits.length : null
  if (hits === null) problems.push('result carried no hits array')
  else {
    if (hits < probe.expect.minHits) problems.push(`expected at least ${probe.expect.minHits} hits, got ${hits}`)
    if (probe.expect.maxHits !== null && hits > probe.expect.maxHits) problems.push(`expected at most ${probe.expect.maxHits} hits, got ${hits}`)
  }
  if (probe.expect.absenceMustBeEarned) {
    const earned = parsed.absent === true && parsed.scanBudgetReached !== true
    const declaredUnfinished = parsed.absent !== true && parsed.scanBudgetReached === true && typeof parsed.nextCursor === 'string'
    if (!earned && !declaredUnfinished) {
      problems.push(`absence was neither established nor declared unfinished: absent=${JSON.stringify(parsed.absent)} scanBudgetReached=${JSON.stringify(parsed.scanBudgetReached)} nextCursor=${typeof parsed.nextCursor}`)
    }
  }
  return problems
}

// The cursor path has NEVER been walked: across both formal pairs, three searches
// stopped at the scan budget and handed back a nextCursor, and it was resumed zero
// times. A path that is offered but never taken is exactly where a defect hides, so
// this probe walks it — and also walks the two ways it can be misused.
const CURSOR_QUERY = 'short='
const CURSOR_QUERY_OTHER = 'role=user-correction'

export function judgeCursor({ first, resumed, misused, bogus }) {
  const problems = []
  if (!first) problems.push('no first-page result observed')
  else if (typeof first.nextCursor !== 'string' || !first.nextCursor) problems.push('the budget-limited first page returned no cursor to resume')
  if (!resumed) problems.push('no resumed result observed')
  else {
    if (resumed.status !== 'success') problems.push(`resume did not succeed: ${JSON.stringify(resumed.status)}`)
    // A resume that returns the identical page is a loop, not progress.
    if (typeof first?.nextCursor === 'string' && resumed.nextCursor === first.nextCursor) problems.push('the resume returned the same cursor: the scan did not advance')
    const firstSeqs = new Set((first?.hits ?? []).map(hit => hit.seq))
    const repeated = (resumed.hits ?? []).filter(hit => firstSeqs.has(hit.seq)).length
    if (repeated > 0) problems.push(`the resumed page re-served ${repeated} hits already returned by the first page`)
    // A resumed page is either terminal (no cursor, so the scan is exhausted or
    // absence is established) or it hands back the next cursor. `scanBudgetReached`
    // describes the scan budget, not pagination — demanding it here scored a
    // perfectly good next page as a failure.
    const terminal = resumed.nextCursor === null || resumed.nextCursor === undefined
    if (!terminal && typeof resumed.nextCursor !== 'string') problems.push('the resumed page carried neither a next cursor nor a terminal state')
    if (terminal && resumed.absent !== true && resumed.incomplete !== true && resumed.status !== 'success') {
      problems.push('a terminal resumed page must report success with absence established or incomplete declared')
    }
  }
  // A cursor is tied to its query: reusing it for a different one must be refused
  // or answered honestly, never silently answered as if it were the original query.
  if (!misused) problems.push('no cross-query cursor result observed')
  else if (misused.status !== 'error') {
    const sameAsResumed = JSON.stringify(misused.hits ?? null) === JSON.stringify(resumed?.hits ?? undefined)
    if (sameAsResumed && (resumed?.hits ?? []).length > 0) problems.push('a cursor from another query was silently answered with the original query\'s hits')
  }
  if (!bogus) problems.push('no invalid-cursor result observed')
  else if (bogus.status !== 'error' && (bogus.hits ?? []).length > 0) {
    problems.push('an invalid cursor was silently answered with hits')
  }
  return problems
}

export async function runCursorProbes({ campaign, pairId, arm = 'ARC_DEFERRED' }) {
  const { results, evidencePath } = await withHost({ campaign, pairId, arm, label: 'X08-CURSOR' }, async ({ driver }) => {
    const text = [
      'Cursor contract probe. Perform these steps in order and report every raw JSON result.',
      `Step 1: call search_context with {"query":"${CURSOR_QUERY}","limit":5}. Copy its nextCursor value exactly.`,
      `Step 2: call search_context again with {"query":"${CURSOR_QUERY}","limit":5,"cursor":"<the nextCursor from step 1>"}.`,
      `Step 3: call search_context with {"query":"${CURSOR_QUERY_OTHER}","limit":5,"cursor":"<the SAME cursor from step 1>"}.`,
      'Step 4: call search_context with {"query":"' + CURSOR_QUERY + '","limit":5,"cursor":"not-a-real-cursor"}.',
      'Do not summarize. Reply with one JSON object with keys first, resumed, misused, bogus.',
    ].join('\n')
    const turn = await driver.turn({ logicalPromptId: `X08-CURSOR-${Date.now()}`, text, purpose: 'diagnostic', expectedEpisode: 0, turnSeconds: 600 })
    const calls = []
    const pending = new Map()
    for (const event of turn.recent) {
      if (event.type === 'tool/call' && event.data?.name === 'search_context') {
        let args = {}
        try { args = JSON.parse(event.data.arguments ?? '{}') } catch { args = {} }
        pending.set(event.data.callId, args)
      }
      if (event.type === 'tool/result') {
        const args = pending.get(event.data?.message?.source?.callId)
        if (!args) continue
        let body = ''
        for (const block of event.data.message.content ?? []) {
          if (block.type === 'text') body += block.text
          for (const inner of block.content ?? []) if (inner.type === 'text') body += inner.text
        }
        try { calls.push({ args, result: JSON.parse(body) }) } catch { calls.push({ args, result: null }) }
      }
    }
    const first = calls[0]?.result ?? null
    const resumed = calls.find(call => call.args.cursor !== undefined && call.args.query === CURSOR_QUERY && call.args.cursor !== 'not-a-real-cursor')?.result ?? null
    const misused = calls.find(call => call.args.query === CURSOR_QUERY_OTHER)?.result ?? null
    const bogus = calls.find(call => call.args.cursor === 'not-a-real-cursor')?.result ?? null
    const summary = {
      calls: calls.length,
      first: first ? { hits: first.hits?.length ?? null, scanBudgetReached: first.scanBudgetReached ?? null, hasCursor: typeof first.nextCursor === 'string' } : null,
      resumed: resumed ? { hits: resumed.hits?.length ?? null, scanBudgetReached: resumed.scanBudgetReached ?? null, hasCursor: typeof resumed.nextCursor === 'string', status: resumed.status } : null,
      misused: misused ? { hits: misused.hits?.length ?? null, status: misused.status, error: misused.error ?? misused.hint ?? null } : null,
      bogus: bogus ? { hits: bogus.hits?.length ?? null, status: bogus.status, error: bogus.error ?? bogus.hint ?? null } : null,
    }
    return { results: [{ ...summary, problems: judgeCursor({ first, resumed, misused, bogus }) }], evidencePath: null }
  })
  return { results, evidencePath }
}

/**
 * Reopen a completed ARC journey and hand the callback a driver whose host is up
 * and whose session is selected. Every diagnostic probe needs exactly this, and
 * nothing about it should be reinvented per case.
 */
async function withHost({ campaign, pairId, arm = 'ARC_DEFERRED', label }, body) {
  const dir = join(campaignRoot(campaign), pairId, arm)
  const runId = readdirSync(dir).find(name => name.startsWith('main-') || name.startsWith('pilot-'))
  const root = join(dir, runId)
  const progress = await readJson(join(root, 'progress.json'), {})
  const pairSpec = await readJson(join(campaignRoot(campaign), pairId, 'pair.json'), null)
  const planJson = await readJson(join(campaignRoot(campaign), 'plan.json'), null)
  const homeRecord = await readJson(join(root, 'host', 'isolated-home.json'), null)
  if (!progress.sessionId || !homeRecord) throw new Error('The ARC run has no durable session to probe')

  const salt = (await readFile(join(campaignRoot(campaign), 'private', 'hidden-salt'))).toString('hex')
  const corpus = generateCorpus({ seed: pairSpec.seed, salt, episodes: planJson.plan.workload.maximumEpisodes })
  const driver = new Driver({
    plan: planJson.plan, geometry: planJson.geometry, command: { port: pairSpec.ports?.[arm] ?? runId },
    arm, seed: pairSpec.seed, root, runId, route: planJson.plan.environment.model,
    corpus, oracle: null, dshBin: PINNED_HOST, tarball: null, campaign, pairId,
  })
  driver.progress = { ...driver.progress, ...progress }
  driver.home = { ...homeRecord, env: { ...process.env, DSH_HOME: homeRecord.home, COREPACK_ENABLE_AUTO_PIN: '0' } }
  driver.patch = join(root, 'host.patch.yml')
  driver.sessionId = progress.sessionId
  let host = null
  try {
    host = await launchHost({ dshBin: PINNED_HOST, root, profile: homeRecord.profile, patch: driver.patch, port: driver.command.port, env: driver.home.env }, `${runId}-${label}`)
    driver.host = host
    await host.client.call('session/selectModel', { sessionId: driver.sessionId, ...planJson.plan.environment.model })
    return await body({ driver, runId, root })
  } finally {
    if (host) await host.stop().catch(() => {})
  }
}

export async function runRetrievalProbes({ campaign, pairId, arm = 'ARC_DEFERRED' }) {
  const { results, evidencePath } = await withHost({ campaign, pairId, arm, label: 'x08' }, async ({ driver }) => {
    const text = [
      'Retrieval contract probe. For each query below, call search_context exactly once with that query and no other arguments, then report the verbatim JSON result.',
      'Do not summarize, do not answer from memory, and do not call any other tool.',
      ...PROBES.map((probe, index) => `${index + 1}. query "${probe.query}"`),
      'Reply with one JSON object keyed by query containing the raw result of each call.',
    ].join('\n')
    const turn = await driver.turn({ logicalPromptId: `X08-PROBE-${Date.now()}`, text, purpose: 'diagnostic', expectedEpisode: 0, turnSeconds: 600 })
    const byQuery = probeResults(turn.recent)
    const results = []
    for (const probe of PROBES) {
      const parsed = byQuery.get(probe.query) ?? null
      results.push({
        probe: probe.name, query: probe.query,
        hits: parsed?.hits?.length ?? null, absent: parsed?.absent ?? null,
        scanBudgetReached: parsed?.scanBudgetReached ?? null, hasCursor: typeof parsed?.nextCursor === 'string',
        problems: judgeProbe(probe, parsed),
      })
    }
    const evidencePath = join(campaignRoot(campaign), 'cases', 'X08-probes.json')
    await atomicJson(evidencePath, { campaign, pairId, arm, sessionId: driver.sessionId, probes: results, at: new Date().toISOString() })
    return { results, evidencePath }
  })
  return { results, evidencePath }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const campaign = process.argv[2] ?? 'lr3m-v2-formal1'
  const pairId = process.argv[3] ?? 'main-91602'
  const { results, evidencePath } = await runRetrievalProbes({ campaign, pairId })
  // Only the two probes that correspond to DECLARED variants are recorded as
  // variants. The unique-id probe is the control that makes the ambiguous one
  // meaningful (1 hit versus 2), so it belongs in the evidence, not in a slot it
  // would mislabel — mapping it onto `bounded-absence` overwrote that variant's
  // natural evidence with an unrelated measurement.
  const VARIANT_BY_PROBE = { 'missing-id': 'missing-id', 'ambiguous-id': 'ambiguous-id' }
  for (const row of results) {
    const variant = VARIANT_BY_PROBE[row.probe]
    if (!variant) continue
    await recordCase({
      campaign, id: 'X08', variant,
      status: row.problems.length === 0 ? 'PASS' : 'FAIL',
      detail: `query "${row.query}" -> hits ${row.hits}, absent ${row.absent}, scanBudgetReached ${row.scanBudgetReached}, cursor ${row.hasCursor}${row.problems.length ? `; ${row.problems.join('; ')}` : ''}`,
      evidence: evidencePath,
    })
  }
  console.log(JSON.stringify(results, null, 2))
}
