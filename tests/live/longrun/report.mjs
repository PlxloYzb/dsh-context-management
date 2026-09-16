// Final and interim reporting. Public output is an allowlisted aggregate: no
// credentials, no private URLs, no oracle answers.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { campaignRoot, readJson, atomicJson, listRuns } from './context.mjs'

const CASES = ['X01','X02','X03','X04','X05','X06','X07','X08','X09','X10','X11','X12','X13','X14','X15','X16','X17','X18']

export async function collectCampaign({ campaign }) {
  const notExecutedPairs = await readNotExecutedPairs(campaign)
  const root = campaignRoot(campaign)
  const manifest = await readJson(join(root, 'manifest.json'), null)
  const planJson = await readJson(join(root, 'plan.json'), null)
  if (!manifest || !planJson) return { root, prepared: false }
  const { readdir } = await import('node:fs/promises')
  // Only sealed pair directories; operational logs share the name prefix.
  const pairs = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && /^(pilot|main)-/.test(entry.name))
    .map(entry => entry.name)
    .filter(name => existsSync(join(root, name, 'pair.json')))
  const runs = []
  for (const pairId of pairs) {
    const pairRuns = await listRuns(campaign, pairId)
    const review = await readJson(join(root, 'reviews', `${pairId}.json`), null)
    for (const run of pairRuns) {
      const audit = await readJson(join(run.root, 'audit.json'), null)
      const score = await readJson(join(run.root, 'score.json'), null)
      const progress = await readJson(join(run.root, 'progress.json'), {})
      const result = await readJson(join(run.root, 'result.json'), null)
      runs.push({ pairId, arm: run.arm, runId: run.runId, progress, audit, score, result, run: run.run })
    }
  }
  const cases = {}
  for (const id of CASES) {
    cases[id] = await readJson(join(root, 'cases', `${id}.json`), { id, status: 'NOT_EXERCISED', detail: 'no diagnostic evidence recorded' })
  }
  const retrieval = runs.filter(run => run.audit?.retrieval).map(run => ({ pairId: run.pairId, arm: run.arm, ...run.audit.retrieval }))
  const scale = {
    note: 'Cumulative foreground tokens measure repeated re-sends across a growing conversation; they are NOT the size of the archived material.',
    rawCallConsumptionTokens: runs.filter(run => !String(run.pairId).startsWith('pilot-')).reduce((sum, run) => sum + (run.audit?.usage?.foregroundVerifiedTokens ?? 0), 0),
    uniqueExposedSourceTokens: Math.max(0, ...runs.filter(run => !String(run.pairId).startsWith('pilot-')).map(run => run.audit?.usage?.uniqueExposedSourceTokens ?? 0)),
    sealedCorpusHeuristicTokens: manifest.baseSourceHeuristicTokens,
    sealedCorpusAllEpisodesTokens: manifest.totalSourceHeuristicTokens,
  }
  const attribution = [
    {
      claim: 'ARC delivered zero background summaries',
      status: 'ROOT CAUSE CONFIRMED AT RUNTIME',
      leadingHypothesis: {
        id: 'agent-loop-request-identity',
        detail: 'The background-summary entry point requires isAgentLoopRequest(request). That predicate is backed by a module-internal WeakSet in @deepseek-ai/dsh-llm. The host and the installed plugin resolve dsh-llm from different real paths, so the plugin holds a second copy with an empty WeakSet.',
        evidenceLevel: 'confirmed at runtime: a probe file placed beside the installed plugin inside the profile pnpm store, resolving @deepseek-ai/dsh-llm exactly as the product plugin does, reported isAgentLoopRequest === false on a real agent-loop request in a live pinned host (host and plugin real paths differ)',
        source: 'src/index.ts background-summary gate; .test-runtime/longrun-review-20260916-identity-runtime.json',
        scope: 'The split is confirmed for the isolated-profile install path used by this experiment; whether every deployment layout resolves one shared instance is untested.',
      },
      superseded: 'The earlier report attributed the gap to the model preferring compress over new_context. Source review shows pressure-driven turnover can carry a prepared background summary and explicit new_context is not a prerequisite; both ARC runs had 21 pressure turnovers. That explanation is withdrawn and replaced by the runtime-confirmed gate failure above.',
    },
  ]
  const corrections = [
    { field: 'coverage gate', firstReport: 'Basic coverage FAILED on both runs', corrected: 'The coverage predicate compared a numeric finalProbeCount against true, so it could never pass. Basic actually PASSES coverage once the predicate compares each field with its required value.', impact: 'Basic coverage verdict reversed for main-91601 and main-91602' },
    { field: 'retrieval volume', firstReport: '44 searches, 32 zero-hit, 31 scan-capped', corrected: 'Those were main-91601 only. Across both formal ARC runs: 131 searches, 102 zero-hit, 93 scan-capped, 84 zero-hit pages that stopped at the scan budget, and 0 uses of the offered nextCursor continuation.', impact: 'retrieval cost under-reported by ~3x' },
    { field: 'scale', firstReport: 'described the archive as ~15M tokens', corrected: '15M is cumulative foreground call consumption from re-sending a growing conversation. Unique exposed source material is ~0.5M heuristic tokens; the sealed corpus is 1.02M across all 48 episodes.', impact: 'two different scales were conflated when explaining retrieval cost' },
    { field: 'I07', firstReport: 'PASS', corrected: 'The check returned PASS unconditionally without verifying the realm claim. It now requires durable evidence of the resolved backend and reports INVALID_EVIDENCE when that evidence is missing.', impact: 'integrity claim for I07 was unsupported' },
    { field: 'I04', firstReport: 'PASS once a recovery record existed', corrected: 'A recovery record explains why the bound was exceeded but cannot restore the boundedness claim. Explained violations are now INVALID_EVIDENCE marked as a harness defect.', impact: 'main-91601 ARC integrity is INVALID_EVIDENCE, not PASS' },
  ]
  return { root, prepared: true, manifest, plan: planJson.plan, geometry: planJson.geometry, pairs, runs, cases, notExecutedPairs, retrieval, scale, attribution, corrections }
}

// A pre-registered formal block with no sealed pair directory is recorded as a
// coverage gap with a machine-readable reason, never as a silent omission.
async function readNotExecutedPairs(campaign) {
  const root = campaignRoot(campaign)
  const plan = await readJson(join(root, 'plan.json'), null)
  if (!plan) return []
  const recorded = await readJson(join(root, 'not-executed.json'), [])
  const pairs = await readJson(join(root, 'pairs-executed.json'), null)
  let executed
  if (pairs) executed = new Set(pairs.pairIds)
  else {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    executed = new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name))
  }
  return plan.plan.schedule.formalPairs
    .filter(row => !executed.has(row.pairId))
    .map(row => ({
      pairId: row.pairId,
      seed: row.seed,
      reason: recorded.find(entry => entry.pairId === row.pairId)?.reason
        ?? 'Pre-registered formal block not executed in this campaign; the recorded coverage is incomplete for this seed.',
    }))
}

function dimensionRow(run) {
  const usage = run.audit?.usage ?? {}
  const coverage = run.audit?.coverage ?? {}
  const quality = run.score ?? null
  // result.json is the single per-run terminal record; it is authoritative when
  // present and the audit/score pair is the fallback while a run is settling.
  const result = run.result ?? null
  return {
    pairId: run.pairId,
    arm: run.arm,
    runId: run.runId,
    executionCompleted: result ? result.executionCompleted : run.progress?.terminalReason === 'COMPLETED',
    terminalReason: result?.terminalReason ?? run.progress?.terminalReason ?? null,
    tokenFloorMet: result ? result.tokenFloorMet : (usage.foregroundVerifiedTokens ?? 0) >= 3000000,
    foregroundVerifiedTokens: usage.foregroundVerifiedTokens ?? 0,
    allReportedTokens: usage.allReportedTokens ?? 0,
    unknownUsageCalls: usage.unknownUsageCalls ?? 0,
    uniqueExposedSourceTokens: coverage.commonCoverage?.uniqueSourceFloorMet === undefined ? 0 : (run.progress?.coverage?.uniqueSourceTokens ?? 0),
    coveragePassed: result ? result.coveragePassed : coverage.passed === true,
    integrityPassed: result ? result.integrityPassed === true : run.audit?.integrityPassed === true,
    qualityPassed: result ? result.qualityPassed === true : (quality?.qualityPassed ?? quality?.passed) === true,
    coverageGaps: result?.coverageGaps ?? [],
    latencyTargetMet: run.progress?.latencyTargetMet ?? null,
    reliabilityAccepted: run.audit?.integrityPassed === true && coverage.passed === true && quality?.passed === true && run.progress?.terminalReason === 'COMPLETED',
    evidenceBytes: run.audit?.evidenceBytes ?? 0,
  }
}

export function publicSummary(collected) {
  const rows = collected.runs.map(dimensionRow)
  const caseStatuses = Object.fromEntries(CASES.map(id => [id, collected.cases[id]?.status ?? 'NOT_EXERCISED']))
  const caseCoverage = Object.fromEntries(CASES.map(id => [id, {
    status: collected.cases[id]?.status ?? 'NOT_EXERCISED',
    variantsPassed: collected.cases[id]?.coveredVariants ?? 0,
    variantsDeclared: collected.cases[id]?.declaredVariants ?? 0,
  }]))
  // Completion is judged on the four precommitted formal runs only; a
  // calibration prefix is not one of them and never blocks FINAL.
  const formalRows = rows.filter(row => !String(row.pairId).startsWith('pilot-'))
  const allTerminal = formalRows.length === 4 && formalRows.every(row => row.terminalReason !== null)
  return {
    schemaVersion: 1,
    campaign: collected.root.split('/').at(-1),
    reportState: allTerminal ? 'COMPLETED' : 'INTERIM',
    planHash: collected.plan ? (collected.manifest?.planHash ?? null) : null,
    protocol: { id: 'muse-longrun-v1', revision: 1 },
    candidate: collected.manifest ? { distSha256: collected.manifest.candidateDistSha256, distFiles: collected.manifest.candidateDistFiles } : null,
    corpus: collected.manifest ? { hash: collected.manifest.corpusHash, totalSourceHeuristicTokens: collected.manifest.totalSourceHeuristicTokens } : null,
    pairs: collected.pairs,
    runs: rows,
    diagnostics: caseStatuses,
    diagnosticCoverage: caseCoverage,
    diagnosticsFullyPassed: Object.values(caseStatuses).filter(status => status === 'PASS').length,
    diagnosticsWithEvidence: Object.values(caseStatuses).filter(status => status === 'PASS' || status === 'PARTIAL' || status === 'FAIL').length,
    diagnosticsTotal: CASES.length,
    unexercisedCases: CASES.filter(id => caseStatuses[id] === 'NOT_EXERCISED'),
    notExecutedPairs: collected.notExecutedPairs ?? [],
    partlyExercisedCases: CASES.filter(id => caseStatuses[id] === 'PARTIAL'),
    // Retrieval behaviour and scale are reported for the ARC arm explicitly,
    // because the first report under-counted the searches (one run only) and
    // conflated cumulative call consumption with unique archived material.
    retrieval: collected.retrieval ?? null,
    scale: collected.scale ?? null,
    attribution: collected.attribution ?? [],
    corrections: collected.corrections ?? [],
    formalRunCount: formalRows.length,
    formalRunsTerminal: formalRows.filter(row => row.terminalReason !== null).length,
    claimLimits: [
      'Two formal seeds support descriptive paired differences only; no universal superiority or equivalence claim.',
      'Latency and token figures are raw observations, not currency claims.',
      'A quality or coverage failure is preserved as reported, never converted to a pass.',
    ],
  }
}

export async function writeReport({ campaign }) {
  const collected = await collectCampaign({ campaign })
  const summary = publicSummary(collected)
  const root = collected.root
  await mkdir(join(root, 'public'), { recursive: true, mode: 0o700 })
  await atomicJson(join(root, 'public', 'summary.json'), summary)
  await writeMarkdown({ root, summary, lang: 'zh-CN' })
  await writeMarkdown({ root, summary, lang: 'en' })
  return { collected, summary }
}

function fmt(value, digits = 0) {
  if (value === null || value === undefined) return 'n/a'
  return typeof value === 'number' ? value.toLocaleString('en-US', { maximumFractionDigits: digits }) : String(value)
}

async function writeMarkdown({ root, summary, lang }) {
  const zh = lang === 'zh-CN'
  const title = zh ? `# muse-longrun-v1 结果报告（${summary.reportState}）` : `# muse-longrun-v1 result report (${summary.reportState})`
  const lines = [title, '']
  lines.push(zh
    ? '本报告由 `tests/live/longrun/report.mjs` 从封存证据生成。所有维度分别报告，不合并为单一成功布尔值。'
    : 'Generated by `tests/live/longrun/report.mjs` from sealed evidence. Dimensions are reported separately and are never merged into one success boolean.')
  lines.push('')
  lines.push(zh ? '## 逐 run 维度' : '## Per-run dimensions')
  lines.push('')
  lines.push(zh
    ? '| pair | arm | runId | 前台已核实 token | 3M 门 | 覆盖门 | 完整性门 | 质量门 | 终态 |'
    : '| pair | arm | runId | foreground verified tokens | 3M floor | coverage | integrity | quality | terminal |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const run of summary.runs) {
    lines.push(`| ${run.pairId} | ${run.arm} | ${run.runId} | ${fmt(run.foregroundVerifiedTokens)} | ${run.tokenFloorMet ? 'PASS' : 'FAIL'} | ${run.coveragePassed ? 'PASS' : 'FAIL'} | ${run.integrityPassed ? 'PASS' : 'FAIL'} | ${run.qualityPassed ? 'PASS' : 'FAIL'} | ${run.terminalReason ?? 'n/a'} |`)
  }
  lines.push('')
  lines.push(zh ? '## 专项覆盖（X01–X18）' : '## Diagnostic coverage (X01–X18)')
  lines.push('')
  for (const [id, status] of Object.entries(summary.diagnostics)) {
    const coverage = summary.diagnosticCoverage[id]
    lines.push(`- ${id}: ${status}（${coverage.variantsPassed}/${coverage.variantsDeclared}${zh ? ' 变体通过' : ' variants passed'}）`)
  }
  lines.push('')
  if (summary.notExecutedPairs?.length) {
    lines.push(zh ? '## 未执行的预注册块' : '## Pre-registered blocks not executed')
    lines.push('')
    for (const row of summary.notExecutedPairs) lines.push(`- ${row.pairId} (seed ${row.seed}): ${row.reason}`)
    lines.push('')
    lines.push(zh
      ? '未执行的预注册块是覆盖不足，不是通过。本报告不因此减少任何已记录门限的分母，也不宣称已完成全部四条主 run。'
      : 'A pre-registered block that was not executed is incomplete coverage, not a pass. No recorded denominator is reduced, and this report does not claim all four main runs were completed.')
    lines.push('')
  }
  if (summary.corrections?.length) {
    lines.push(zh ? '## 对第一版报告的更正' : '## Corrections to the first report')
    lines.push('')
    lines.push(zh ? '| 字段 | 第一版 | 更正后 | 影响 |' : '| field | first report | corrected | impact |')
    lines.push('| --- | --- | --- | --- |')
    for (const row of summary.corrections) lines.push(`| ${row.field} | ${row.firstReport} | ${row.corrected} | ${row.impact} |`)
    lines.push('')
  }
  if (summary.attribution?.length) {
    lines.push(zh ? '## 归因状态' : '## Attribution status')
    lines.push('')
    for (const row of summary.attribution) {
      lines.push(`- **${row.claim}** — ${row.status}`)
      lines.push(`  - ${zh ? '首要假设' : 'leading hypothesis'}: ${row.leadingHypothesis.detail}`)
      lines.push(`  - ${zh ? '证据等级' : 'evidence level'}: ${row.leadingHypothesis.evidenceLevel}`)
      lines.push(`  - ${zh ? '已撤回的旧解释' : 'withdrawn explanation'}: ${row.superseded}`)
    }
    lines.push('')
  }
  if (summary.retrieval?.length) {
    lines.push(zh ? '## 检索行为（ARC 臂，逐 run）' : '## Retrieval behaviour (ARC arm, per run)')
    lines.push('')
    lines.push(zh ? '| pair | 搜索 | 零命中 | 触及扫描上限 | 零命中且触顶 | 命中 | 使用游标续扫 |' : '| pair | searches | zero-hit | scan-capped | zero-hit & capped | hits | cursor resumes |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const row of summary.retrieval) lines.push(`| ${row.pairId} | ${row.searches} | ${row.zeroHit} | ${row.scanBudgetReached} | ${row.zeroHitScanCapped} | ${row.hits} | ${row.cursorResumes} |`)
    lines.push('')
    lines.push(zh
      ? '零命中且触及扫描上限的页面是"未测"而不是"不存在"；本实验中没有一次使用工具返回的 nextCursor 续扫。'
      : 'A zero-hit page that stopped at the scan budget is untested, not absent; the offered nextCursor continuation was never used in this experiment.')
    lines.push('')
  }
  if (summary.scale) {
    lines.push(zh ? '## 规模口径' : '## Scale')
    lines.push('')
    lines.push(`- ${zh ? '累计前台调用消耗' : 'cumulative foreground call consumption'}: ${summary.scale.rawCallConsumptionTokens.toLocaleString('en-US')} tokens`)
    lines.push(`- ${zh ? '独立暴露源材料' : 'unique exposed source material'}: ${summary.scale.uniqueExposedSourceTokens.toLocaleString('en-US')} heuristic tokens`)
    lines.push(`- ${zh ? '封存语料（基础 24 episodes）' : 'sealed corpus (base 24 episodes)'}: ${summary.scale.sealedCorpusHeuristicTokens.toLocaleString('en-US')} heuristic tokens`)
    lines.push(`- ${summary.scale.note}`)
    lines.push('')
  }
  lines.push(zh ? '## 方法学与操作史' : '## Method and operational history')
  lines.push('')
  const ops = [
    zh
      ? 'P2 的 24 个 episode 在两个臂上全部完成并落盘（ARC 21 次 window commit，Basic 62 次原生压缩），随后驱动在最终探针前因一个工具缺陷（封存 oracle 未载入）报错终止。'
      : 'P2 completed all 24 episodes on both arms with durable evidence (ARC 21 window commits, Basic 62 native compactions); the driver then failed before the final probe on a harness defect (the sealed oracle was not loaded).',
    zh
      ? '恢复方式：从持久化 dispatch journal 判定最新完成 episode，只重放最终探针的 12 个批次；已有的 episode 与重启证据未被重跑。首次恢复尝试错误地向端点之后推进了 episode，该次越界读取已在 I04 中显式归因，未作隐瞒。'
      : 'Recovery: the last completed episode was derived from the durable dispatch journal and only the 12 final-probe batches were re-driven; no episode or restart evidence was re-run. One earlier resume attempt wrongly advanced past the endpoint; those out-of-window reads are explicitly attributed in I04 rather than hidden.',
    zh
      ? 'E12 计划内重启已在两臂验证：PID 改变、durable 前缀与分页历史哈希一致、session id 不变。'
      : 'The planned E12 restart verified on both arms: new PID, identical durable-prefix and paginated-history hashes, unchanged session id.',
    zh
      ? '两臂的自然行为都选择显式 compress 而不是 new_context/handoff 路径，因此没有任何交付回执，ARC 的 ≥6 份已交付摘要覆盖门未满足。'
      : 'Both arms chose explicit compress over the new_context/handoff path naturally, so no delivery receipts exist and ARC’s >=6 delivered-summary coverage gate is unmet.',
  ]
  for (const line of ops) lines.push(`- ${line}`)
  lines.push('')
  lines.push(zh ? '## 结论限制' : '## Claim limits')
  lines.push('')
  for (const limit of summary.claimLimits) lines.push(`- ${limit}`)
  lines.push('')
  const path = join(root, 'public', zh ? 'REPORT.zh-CN.md' : 'REPORT.en.md')
  await writeFile(path, lines.join('\n'), { mode: 0o600 })
  return path
}
