import { readFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
export function budgetState(root) {
  const limits = JSON.parse(readFileSync(join(root, 'limits.json'), 'utf8'))
  const log = join(root, 'usage-ledger.jsonl')
  // D08: with paired-block concurrency three observer processes append concurrently; a torn
  // trailing line read mid-append must not corrupt budget accounting — skip unparseable lines.
  const rows = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean) : []
  const calls = new Map()
  for (const row of rows) {
    const prior = calls.get(row.callId) ?? {}
    calls.set(row.callId, { ...prior, ...row })
  }
  let reservedTokens = 0, reportedTokens = 0
  for (const call of calls.values()) {
    if (Number.isFinite(call.totalTokens)) { reservedTokens += call.totalTokens; reportedTokens += call.totalTokens }
    else reservedTokens += limits.perCallConservativeReserve
  }
  return { limits, reservedTokens, reportedTokens, callCount: calls.size }
}
export function reserveCall(root, callId, details) {
  const state = budgetState(root)
  const overTokenCeiling = state.limits.tokenCeiling !== null && state.reservedTokens + state.limits.perCallConservativeReserve > state.limits.tokenCeiling
  if (Date.now() >= state.limits.stopAtMs || overTokenCeiling) {
    throw new Error('EXPERIMENT_BATCH_LIMIT: no new request is permitted')
  }
  appendFileSync(join(root, 'usage-ledger.jsonl'), JSON.stringify({ callId, phase: 'reserved', ...details }) + '\n', { mode: 0o600 })
}
export function recordUsage(root, callId, usage) {
  const totalTokens = Number.isFinite(usage.totalTokens) ? usage.totalTokens : null
  appendFileSync(join(root, 'usage-ledger.jsonl'), JSON.stringify({ callId, phase: 'usage', totalTokens, usage }) + '\n', { mode: 0o600 })
}
