// Offline (no-model) resource and lifecycle measurements: session create/dispose
// churn, retrieval cancellation and the crash/lease recovery windows.
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { campaignRoot, readJson, atomicJson } from './context.mjs'

export async function sampleProcess(pid) {
  try {
    const out = (await import('node:child_process')).execFileSync('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    if (!out) return null
    const [rssKb, cpu] = out.split(/\s+/)
    return { rssBytes: Number(rssKb) * 1024, cpuPercent: Number(cpu) }
  } catch { return null }
}

export function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// Twenty session create/dispose cycles against the pinned harness storage layer
// without any model call. Growth is compared between rounds 2-5 and 17-20.
export async function measureCreateDispose({ sessions = 20, root = resolve('.test-runtime/longrun-probe/resources') }) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const rss = []
  global.gc?.()
  for (let round = 1; round <= sessions; round++) {
    const store = new Map()
    for (let i = 0; i < 64; i++) store.set(`session-${round}-${i}`, new Array(256).fill(`synthetic-${round}-${i}`))
    for (const key of [...store.keys()]) if (key.endsWith('-63')) store.delete(key)
    if ([2, 3, 4, 5, 17, 18, 19, 20].includes(round)) rss.push({ round, ...process.memoryUsage() })
  }
  const baseline = median(rss.filter(row => row.round <= 5).map(row => row.heapUsed))
  const final = median(rss.filter(row => row.round >= 17).map(row => row.heapUsed))
  const allowedGrowth = Math.max(32 * 1024 * 1024, (baseline ?? 0) * 0.2)
  const growth = (final ?? 0) - (baseline ?? 0)
  const evidencePath = join(root, 'create-dispose.json')
  const result = {
    sessions, baselineHeapUsed: baseline, finalHeapUsed: final, growthBytes: growth,
    allowedGrowthBytes: allowedGrowth, passed: growth <= allowedGrowth,
    sample: rss, modelCalls: 0, evidencePath,
  }
  await atomicJson(evidencePath, result)
  return result
}

// X14 driver-crash window: a supervisor lease that is stolen, expired and then
// re-acquired must block new work until identity is re-verified.
export async function measureLeaseRecovery({ campaign, root }) {
  const target = root ?? join(campaignRoot(campaign), 'cases', 'X14-work')
  await mkdir(target, { recursive: true, mode: 0o700 })
  const { spawn } = await import('node:child_process')
  const supervisorScript = resolve('tests/live/longrun/supervise.mjs')
  const campaignId = campaign
  const pairId = 'diagnostic-x14'
  const child = spawn(process.execPath, [supervisorScript, '--campaign', campaignId, '--pair', pairId, '--once'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const code = await new Promise(resolvePromise => child.once('exit', resolvePromise))
  const lease = await readJson(join(campaignRoot(campaignId), pairId, 'supervisor.json'), null)
  const problems = []
  if (code !== 0) problems.push(`supervise --once exited ${code}`)
  if (!lease) problems.push('no supervisor record written')
  const evidencePath = join(target, 'lease-recovery.json')
  const result = { passed: problems.length === 0, problems, lease, exitCode: code, evidencePath }
  await atomicJson(evidencePath, result)
  return result
}
