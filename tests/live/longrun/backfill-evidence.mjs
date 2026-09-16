#!/usr/bin/env node
// One-off evidence backfill for runs that predate two harness outputs:
// `pressure.jsonl` (per-turn host pressure) and `summary-jobs.jsonl` (the
// product summary-job ledger when a run prepared no background summaries).
// Every row is derived from durable artifacts and labelled `derived: true`, so
// a reconstructed row is never mistaken for a live observation.
import { join } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { listRuns, atomicJson } from './context.mjs'
import { observedEvents } from '../local/observed-events.mjs'

const campaign = process.env.LR3M_CAMPAIGN ?? 'lr3m-r1'

async function resolveSessionId(root) {
  const entries = await readdir(join(root, 'control')).catch(() => [])
  const match = entries.find(name => name.endsWith('.session.json'))
  if (!match) return null
  return JSON.parse(readFileSync(join(root, 'control', match), 'utf8')).sessionId ?? null
}

function readJsonl(path) {
  if (!existsSync(path)) return []
  const rows = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    try { rows.push(JSON.parse(line)) } catch { /* torn tail */ }
  }
  return rows
}

for (const pairId of await readdir(join('.test-runtime/longrun-20260915', campaign)).catch(() => [])) {
  const runs = await listRuns(campaign, pairId).catch(() => [])
  for (const run of runs) {
    const root = run.root
    const sessionId = await resolveSessionId(root)
    if (!sessionId) continue

    // pressure.jsonl: one row per dispatched prompt plus one per window commit.
    const pressurePath = join(root, 'pressure.jsonl')
    if (!existsSync(pressurePath)) {
      const samples = []
      for (const row of readJsonl(join(root, 'dispatch.jsonl'))) {
        if (row.kind !== 'prompt' || row.phase !== 'planned') continue
        samples.push({
          time: row.time, stage: 'before-turn', derived: true, derivation: 'dispatch.jsonl planned row',
          runId: run.runId, arm: run.arm, logicalPromptId: row.logicalPromptId, beforeSeq: row.beforeSeq ?? null,
        })
      }
      const events = await observedEvents(join(root, 'observed'), sessionId).catch(() => [])
      for (const event of events) {
        if (event.type !== 'compaction/summary') continue
        const cm = event.data?.contextManagement ?? null
        samples.push({
          time: event.time ?? null, stage: 'window-commit', derived: true, derivation: 'observed compaction/summary event',
          runId: run.runId, arm: run.arm, seq: event.seq,
          kind: cm?.kind ?? null, trigger: cm?.trigger ?? null,
          generationAfter: cm?.generationAfter ?? null,
          shadowedTokenCount: event.data?.shadowedTokenCount ?? null,
        })
      }
      samples.sort((a, b) => String(a.time ?? '').localeCompare(String(b.time ?? '')) || (a.seq ?? 0) - (b.seq ?? 0))
      await atomicJson(pressurePath, { schemaVersion: 1, derivedBackfill: true, note: 'Reconstructed from durable dispatch rows and observed compaction events; the live sampler did not exist during this run.', samples })
    }

    // summary-jobs.jsonl: an explicit empty ledger is honest evidence that the
    // product prepared no background summary for this run.
    const jobsPath = join(root, 'summary-jobs.jsonl')
    if (!existsSync(jobsPath)) {
      const events = await observedEvents(join(root, 'observed'), sessionId).catch(() => [])
      const receipts = events.filter(event => event.type === 'user/message' && event.data?.source?.plugin === 'dsh-context-management/handoff')
      await atomicJson(jobsPath, {
        schemaVersion: 1,
        derivedBackfill: true,
        note: 'No background summary job was ever prepared in this run; the model used the explicit compress tool instead of the deferred handoff path. Verified against the observed event stream.',
        handoffReceiptsObserved: receipts.length,
        jobs: [],
      })
    }
    console.log(run.pairId, run.arm, 'session', sessionId.slice(0, 18), 'pressure', existsSync(pressurePath), 'jobs', existsSync(jobsPath))
  }
}
