#!/usr/bin/env node
// muse-longrun-v1 operator surface. Every command is explicit about the one
// pair or case it acts on; there is deliberately no "run every seed" button.
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { campaignRoot, readJson, atomicJson, listRuns } from './context.mjs'
import { loadPlan } from './plan.mjs'
import { prepareCampaign, sealPair, pairStatus, campaignStatus, writeReview, sealCandidateTarball } from './campaign.mjs'
import { runDiagnosticCase } from './cases.mjs'

const USAGE = `muse-longrun-v1 harness

node tests/live/longrun/cli.mjs validate --plan <path>
node tests/live/longrun/cli.mjs prepare --plan <path> --campaign <id>
node tests/live/longrun/cli.mjs pilot --campaign <id> --pair pilot-91561
node tests/live/longrun/cli.mjs run-pair --campaign <id> --pair main-91601
node tests/live/longrun/cli.mjs status --campaign <id> [--json]
node tests/live/longrun/cli.mjs audit --campaign <id> --pair <pair> [--arm <arm>]
node tests/live/longrun/cli.mjs review --campaign <id> --pair <pair> --decision <accept|reject|revise> --evidence <path>
node tests/live/longrun/cli.mjs case --campaign <id> --id X03 --variant guided-late
node tests/live/longrun/cli.mjs resume --campaign <id> --pair <pair>
node tests/live/longrun/cli.mjs probe --campaign <id> --pair <pair> --endpoint <n>
node tests/live/longrun/cli.mjs stop --campaign <id> --pair <pair> --reason <text>
node tests/live/longrun/cli.mjs report --campaign <id>
`

export function parseArgs(argv) {
  const [command, ...rest] = argv
  const args = {}
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index]
    const inline = /^--([a-z0-9-]+)=(.*)$/.exec(item)
    if (inline) { args[inline[1]] = inline[2]; continue }
    const flag = /^--([a-z0-9-]+)$/.exec(item)
    if (!flag) throw new Error(`Unexpected argument ${item}`)
    const next = rest[index + 1]
    if (next !== undefined && !next.startsWith('--')) { args[flag[1]] = next; index++ }
    else args[flag[1]] = true
  }
  return { command, args }
}

function requireArgs(args, names) {
  for (const name of names) if (!args[name] || args[name] === true) throw new Error(`--${name} is required`)
}

export async function main(argv = process.argv.slice(2)) {
  const { command, args } = parseArgs(argv)
  switch (command) {
    case 'validate': return validateCommand(args)
    case 'corpus': return corpusCommand(args)
    case 'prepare': return prepareCommand(args)
    case 'pilot': return runPairCommand(args, { pilot: true })
    case 'run-pair': return runPairCommand(args, { pilot: false })
    case 'status': return statusCommand(args)
    case 'audit': return auditCommand(args)
    case 'review': return reviewCommand(args)
    case 'case': return caseCommand(args)
    case 'resume': return resumeCommand(args)
    case 'probe': return probeCommand(args)
    case 'stop': return stopCommand(args)
    case 'report': return reportCommand(args)
    case 'help': case undefined: console.log(USAGE); return { ok: true, usage: true }
    default: throw new Error(`Unknown command ${command}\n${USAGE}`)
  }
}

async function validateCommand(args) {
  const planPath = args.plan ?? 'docs/experiments/muse-longrun-v1.plan.json'
  const { plan, geometry, planHash } = await loadPlan(planPath)
  const output = { ok: true, planPath, planHash, protocolId: plan.protocolId, revision: plan.revision, geometry }
  console.log(JSON.stringify(output, null, 2))
  return output
}

async function corpusCommand(args) {
  // Deterministic no-model calibration of the sealed corpus geometry. It uses a
  // throwaway salt; the sealed salt is only read through the ignored private dir.
  const { plan } = await loadPlan(args.plan ?? 'docs/experiments/muse-longrun-v1.plan.json')
  const { generateCorpus, fixtureManifest, generateOracle, oracleShapeProblems, materialCounts } = await import('./fixture.mjs')
  const { randomBytes } = await import('node:crypto')
  const salt = args.salt ?? randomBytes(32).toString('hex')
  const episodes = Number(args.episodes ?? plan.workload.maximumEpisodes)
  const seed = Number(args.seed ?? plan.schedule.pilot.seed)
  const corpus = generateCorpus({ seed, salt, episodes })
  const lengths = corpus.pages.map(page => [...page].length)
  const heuristic = lengths.map(length => Math.ceil(length / 4) + 4)
  const perEndpoint = {}
  for (const endpoint of plan.probes.endpoints) {
    if (endpoint.endpointEpisodes > episodes) continue
    const oracle = generateOracle({ corpus, endpoint: endpoint.endpointEpisodes })
    perEndpoint[`N${endpoint.endpointEpisodes}`] = {
      questions: oracle.questions.length,
      problems: oracleShapeProblems(oracle),
      materials: materialCounts(corpus, endpoint.endpointEpisodes),
    }
  }
  const output = {
    ok: true, seed, episodes, corpusHash: fixtureManifest(corpus).hash,
    pageCodePoints: { min: Math.min(...lengths), max: Math.max(...lengths), mean: Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) },
    heuristicTokens: {
      base: heuristic.slice(0, plan.workload.baseEpisodes * plan.workload.pagesPerEpisode).reduce((a, b) => a + b, 0),
      all: heuristic.reduce((a, b) => a + b, 0),
      materialFloor: plan.workload.minimumUniqueExposedSourceHeuristicTokens,
    },
    perEndpoint,
  }
  console.log(JSON.stringify(output, null, 2))
  return output
}

async function prepareCommand(args) {
  requireArgs(args, ['campaign'])
  const result = await prepareCampaign({ campaign: args.campaign, planPath: args.plan })
  const tarball = await sealCandidateTarball({ campaign: args.campaign })
  console.log(JSON.stringify({ ok: true, campaign: args.campaign, root: result.root, manifest: result.manifest, tarball }, null, 2))
  return result
}

// Distinguishes pilot from formal pairs without ever chaining them.
async function runPairCommand(args, { pilot }) {
  requireArgs(args, ['campaign', 'pair'])
  const planPath = args.plan ?? 'docs/experiments/muse-longrun-v1.plan.json'
  const { plan } = await loadPlan(planPath)
  const expected = plan.schedule.pilot.pairId
  const formal = plan.schedule.formalPairs.map(row => row.pairId)
  if (pilot && args.pair !== expected) throw new Error(`pilot must name ${expected}`)
  if (!pilot && !formal.includes(args.pair)) throw new Error(`run-pair must name one precommitted formal pair (${formal.join(', ')})`)
  const previous = pilot ? [] : formal.slice(0, formal.indexOf(args.pair))
  const root = campaignRoot(args.campaign)
  for (const pairId of previous) {
    const review = await readJson(join(root, 'reviews', `${pairId}.json`), null)
    if (!review || review.decision !== 'accept') throw new Error(`REVIEW_REQUIRED: ${pairId} has no accepted review; refuse to start ${args.pair}`)
  }
  await sealPair({ campaign: args.campaign, pairId: args.pair, plan })
  const dshBin = resolve(process.env.EXPERIMENT_DSH_BIN ?? '.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh')
  if (!existsSync(dshBin)) throw new Error('EXPERIMENT_DSH_BIN is not the pinned 0.1.2-rc.1 host')
  const tarballRecord = await readJson(join(campaignRoot(args.campaign), 'candidate-tarball.json'), null)
  if (!tarballRecord?.path) throw new Error('Candidate tarball is not sealed; run prepare first')
  const { drivePair } = await import('./run-pair.mjs')
  const calibrationEpisodes = args.episodes ? Number(args.episodes) : null
  if (calibrationEpisodes !== null && (!Number.isSafeInteger(calibrationEpisodes) || calibrationEpisodes < 1 || calibrationEpisodes > plan.workload.baseEpisodes)) throw new Error('--episodes must be an integer from 1 through the base episode count')
  if (calibrationEpisodes !== null && !pilot) throw new Error('--episodes is only available for the pre-registered pilot pair')
  const result = await drivePair({ campaign: args.campaign, pairId: args.pair, dshBin, tarball: tarballRecord.path, calibrationEpisodes })
  const status = await pairStatus({ campaign: args.campaign, pairId: args.pair })
  console.log(JSON.stringify({ ok: true, pair: args.pair, result, status }, null, 2))
  return { result, status }
}

async function statusCommand(args) {
  requireArgs(args, ['campaign'])
  const status = args.pair ? await pairStatus({ campaign: args.campaign, pairId: args.pair }) : await campaignStatus({ campaign: args.campaign })
  console.log(JSON.stringify(status, null, 2))
  return status
}

async function auditCommand(args) {
  requireArgs(args, ['campaign', 'pair'])
  const runs = await listRuns(args.campaign, args.pair)
  if (!runs.length) throw new Error('No runs found for that pair')
  const { auditRun } = await import('./audit.mjs')
  const results = []
  for (const run of runs) {
    if (args.arm && run.arm !== args.arm) continue
    results.push(await auditRun({ campaign: args.campaign, pairId: args.pair, arm: run.arm, runId: run.runId }))
  }
  console.log(JSON.stringify(results, null, 2))
  return results
}

async function reviewCommand(args) {
  requireArgs(args, ['campaign', 'pair', 'decision'])
  // A review may cite a freshly built structured evidence file; the decision is
  // still an explicit operator input and never derived from the numbers.
  const { writePairEvidence } = await import('./review.mjs')
  const built = await writePairEvidence({ campaign: args.campaign, pairId: args.pair })
  const evidencePath = args.evidence && args.evidence !== true ? resolve(args.evidence) : built.path
  if (args.evidence && args.evidence !== true && !existsSync(evidencePath)) {
    throw new Error('review --evidence must point at an existing structured evidence file')
  }
  if (!existsSync(evidencePath)) throw new Error('review --evidence must point at existing structured evidence')
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
  const body = await writeReview({ campaign: args.campaign, pairId: args.pair, decision: args.decision, evidence: { path: evidencePath, sha256: (await import('node:crypto')).createHash('sha256').update(JSON.stringify(evidence)).digest('hex') }, reviewer: process.env.USER ?? 'operator' })
  console.log(JSON.stringify(body, null, 2))
  return body
}

async function caseCommand(args) {
  requireArgs(args, ['campaign', 'id'])
  const result = await runDiagnosticCase({ campaign: args.campaign, id: args.id, variant: args.variant ?? 'default', dshBin: resolve(process.env.EXPERIMENT_DSH_BIN ?? '.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh') })
  console.log(JSON.stringify(result, null, 2))
  return result
}

// Operator recovery of the sealed final probe for a journey that already
// completed its endpoint. It never re-runs or extends episodes.
async function probeCommand(args) {
  requireArgs(args, ['campaign', 'pair', 'endpoint'])
  const endpoint = Number(args.endpoint)
  const dshBin = resolve(process.env.EXPERIMENT_DSH_BIN ?? '.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh')
  if (!existsSync(dshBin)) throw new Error('EXPERIMENT_DSH_BIN is not the pinned 0.1.2-rc.1 host')
  const tarballRecord = await readJson(join(campaignRoot(args.campaign), 'candidate-tarball.json'), null)
  const { recoverProbe } = await import('./recover.mjs')
  const result = await recoverProbe({
    campaign: args.campaign, pairId: args.pair, endpoint, dshBin,
    tarball: tarballRecord?.path ?? null, arm: args.arm && args.arm !== true ? args.arm : null,
  })
  console.log(JSON.stringify(result, null, 2))
  return result
}

async function resumeCommand(args) {
  requireArgs(args, ['campaign', 'pair'])
  const status = await pairStatus({ campaign: args.campaign, pairId: args.pair })
  const dshBin = resolve(process.env.EXPERIMENT_DSH_BIN ?? '.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh')
  if (!existsSync(dshBin)) throw new Error('EXPERIMENT_DSH_BIN is not the pinned 0.1.2-rc.1 host')
  const tarballRecord = await readJson(join(campaignRoot(args.campaign), 'candidate-tarball.json'), null)
  if (!tarballRecord?.path) throw new Error('Candidate tarball is not sealed; run prepare first')
  const { resumePair } = await import('./run-pair.mjs')
  const result = await resumePair({ campaign: args.campaign, pairId: args.pair, dshBin, tarball: tarballRecord.path, status })
  console.log(JSON.stringify({ ok: true, pair: args.pair, result }, null, 2))
  return result
}

async function stopCommand(args) {
  requireArgs(args, ['campaign', 'pair', 'reason'])
  const root = campaignRoot(args.campaign)
  const pairRoot = join(root, args.pair)
  await atomicJson(join(pairRoot, 'stop-request.json'), { reason: args.reason, requestedAt: new Date().toISOString(), by: process.env.USER ?? 'operator' })
  console.log(JSON.stringify({ ok: true, pair: args.pair, reason: args.reason }))
  return { ok: true }
}

async function reportCommand(args) {
  requireArgs(args, ['campaign'])
  const { writeReport } = await import('./report.mjs')
  const report = await writeReport({ campaign: args.campaign })
  console.log(JSON.stringify(report.summary, null, 2))
  return report
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(result => { if (result?.ok === false) process.exitCode = 1 }).catch(error => {
    console.error(JSON.stringify({ ok: false, error: String(error.message ?? error) }))
    process.exitCode = 1
  })
}
