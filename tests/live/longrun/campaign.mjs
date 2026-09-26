// Campaign scaffolding: plan sealing, oracle sealing, endpoint probe sealing,
// candidate packing and the pair/review ledger.
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { campaignRoot, atomicJson, readJson, ensurePrivateDirectory, listRuns } from './context.mjs'
import { loadPlan, deriveGeometry, sha256 } from './plan.mjs'
import { distManifest, distManifestHash, canonicalDistEntries, pinnedHostIdentity } from './host.mjs'

export async function prepareCampaign({ campaign, planPath }) {
  const { plan, geometry, planHash } = await loadPlan(planPath ?? 'docs/experiments/muse-longrun-v1.plan.json')
  const root = campaignRoot(campaign)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await ensurePrivateDirectory(join(root, 'private'))
  await ensurePrivateDirectory(join(root, 'reviews'))
  await ensurePrivateDirectory(join(root, 'private', 'endpoint-probes'))
  await ensurePrivateDirectory(join(root, 'private', 'corpora'))
  await ensurePrivateDirectory(join(root, 'private', 'sentinels'))
  await atomicJson(join(root, 'plan.json'), { planPath, planHash, plan, geometry, sealedAt: new Date().toISOString() })

  const { generateCorpus, generateOracle, fixtureManifest, pageTokens, sentinelQuestions, oracleAnswerabilityProblems } = await import('./fixture.mjs')
  const saltPath = join(root, 'private', 'hidden-salt')
  let salt
  if (existsSync(saltPath)) {
    salt = await readFile(saltPath)
  } else {
    const { randomBytes } = await import('node:crypto')
    salt = randomBytes(32)
    await writeFile(saltPath, salt, { mode: 0o600 })
  }
  const maximum = plan.workload.maximumEpisodes
  const saltHex = salt.toString('hex')
  // EVERY seed the plan runs, not just the pilot seed. Sealing one oracle set from
  // the pilot seed and then running a formal pair on its own seed is what made the
  // first campaign's quality score meaningless: 0 of 96 question labels matched the
  // corpus the model actually read.
  const seeds = [...new Set([plan.schedule.pilot.seed, ...plan.schedule.formalPairs.map(pair => pair.seed)])]
  const probeIndex = {}
  for (const seed of seeds) {
    const corpus = generateCorpus({ seed, salt: saltHex, episodes: maximum })
    const manifest = fixtureManifest(corpus)
    const heuristic = pageTokens(corpus)
    corpus.pageHeuristicTokens = heuristic
    const corpusPath = join(root, 'private', 'corpora', `seed-${seed}.json`)
    if (!existsSync(corpusPath)) await atomicJson(corpusPath, { ...manifest, pageHeuristicTokens: heuristic, seed })
    if (seed === plan.schedule.pilot.seed) await atomicJson(join(root, 'private', 'corpus.json'), { ...manifest, pageHeuristicTokens: heuristic })
    for (const episode of plan.probes.sentinelEpisodes) {
      const sentinel = sentinelQuestions(corpus, episode)
      await atomicJson(join(root, 'private', 'sentinels', `seed-${seed}`, `E${episode}.json`), { episode, seed, questions: sentinel })
      // The pilot seed keeps the legacy flat names so the first campaign's record
      // stays readable; every seed gets its own directory.
      if (seed === plan.schedule.pilot.seed) await atomicJson(join(root, 'private', `sentinel-E${episode}.json`), { episode, questions: sentinel })
    }
    for (const endpoint of plan.probes.endpoints) {
      const oracle = generateOracle({ corpus, endpoint: endpoint.endpointEpisodes })
      // Seal only an oracle the corpus can actually answer. An unanswerable oracle
      // turns the quality gate into a measurement of nothing, which is precisely how
      // the first executed campaign produced a meaningless 21/96 on both arms.
      const unanswerable = oracleAnswerabilityProblems(corpus, oracle)
      if (unanswerable.length > 0) {
        throw new Error(`ORACLE_UNANSWERABLE at seed ${seed} endpoint ${endpoint.endpointEpisodes} (${unanswerable.length} problems): ${unanswerable.slice(0, 5).join('; ')}`)
      }
      await atomicJson(join(root, 'private', 'endpoint-probes', `seed-${seed}`, `N${endpoint.endpointEpisodes}.json`), oracle)
      if (seed === plan.schedule.pilot.seed) await atomicJson(join(root, 'private', 'endpoint-probes', `N${endpoint.endpointEpisodes}.json`), oracle)
      probeIndex[`seed-${seed}/N${endpoint.endpointEpisodes}`] = { questionCount: oracle.questions.length, oracleHash: sha256(JSON.stringify(oracle)) }
    }
  }
  const dist = await distManifest('dist')
  const candidate = {
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean),
    dist: { files: dist.length, sha256: distManifestHash(dist), entries: dist },
    builtAt: new Date().toISOString(),
  }
  await atomicJson(join(root, 'candidate.json'), candidate)
  // The campaign manifest describes the PILOT corpus, which is the one the pilot
  // pair reads; every seed now has its own sealed record under `private/corpora/`.
  const pilotCorpus = generateCorpus({ seed: plan.schedule.pilot.seed, salt: saltHex, episodes: maximum })
  const pilotManifest = fixtureManifest(pilotCorpus)
  const pilotHeuristic = pageTokens(pilotCorpus)
  const manifestJson = {
    campaign, createdAt: new Date().toISOString(), planHash,
    corpusHash: pilotManifest.hash, corpusEpisodes: maximum,
    totalSourceHeuristicTokens: pilotHeuristic.reduce((sum, value) => sum + value, 0),
    baseSourceHeuristicTokens: pilotHeuristic.slice(0, plan.workload.baseEpisodes * plan.workload.pagesPerEpisode).reduce((sum, value) => sum + value, 0),
    probeIndex, candidateDistSha256: candidate.dist.sha256, candidateDistFiles: candidate.dist.files,
  }
  await atomicJson(join(root, 'manifest.json'), manifestJson)
  return { root, plan, geometry, planHash, manifest: manifestJson, corpus: pilotCorpus, candidate }
}

export async function sealPair({ campaign, pairId, plan, pilot = false }) {
  const root = campaignRoot(campaign)
  const pairRoot = join(root, pairId)
  const precommit = plan.schedule.formalPairs.find(row => row.pairId === pairId)
    ?? (plan.schedule.pilot.pairId === pairId ? { pairId, seed: plan.schedule.pilot.seed, startOrder: ['ARC_DEFERRED', 'BASIC_MATCHED'], pilot: true } : null)
  if (!precommit) throw new Error(`Pair ${pairId} is not precommitted in the frozen plan`)
  await mkdir(pairRoot, { recursive: true, mode: 0o700 })
  // A pair occupies the two precommitted primary ports exactly once.
  const base = plan.environment.defaultPorts
  const uniquePorts = new Set([base.BASIC_MATCHED, base.ARC_DEFERRED])
  if (uniquePorts.size !== 2) throw new Error('Primary ports must be distinct')
  await atomicJson(join(pairRoot, 'pair.json'), { ...precommit, ports: { BASIC_MATCHED: base.BASIC_MATCHED, ARC_DEFERRED: base.ARC_DEFERRED }, sealedAt: new Date().toISOString(), planHash: sha256(await readFile(join(root, 'plan.json'))) })
  return { pairRoot, precommit }
}

export async function pairStatus({ campaign, pairId }) {
  const root = campaignRoot(campaign)
  const pairRoot = join(root, pairId)
  if (!existsSync(pairRoot)) return { campaign, pairId, state: 'UNKNOWN', runs: [] }
  const lease = await readJson(join(pairRoot, 'supervisor.json'), null)
  const runs = await listRuns(campaign, pairId)
  const rows = []
  for (const run of runs) {
    const progress = await readJson(join(run.root, 'progress.json'), {})
    rows.push({ arm: run.arm, runId: run.runId, state: progress.state ?? 'PLANNED', episode: progress.episode ?? 0, terminalReason: progress.terminalReason ?? null, usage: progress.usage ?? null, coverage: progress.coverage ?? null })
  }
  const reviewPath = join(root, 'reviews', `${pairId}.json`)
  const review = await readJson(reviewPath, null)
  const terminal = rows.length === 2 && rows.every(row => ['SEALED', 'STOPPED', 'REVIEW_REQUIRED'].includes(row.state) || row.terminalReason)
  return { campaign, pairId, state: review ? 'REVIEWED' : terminal ? 'REVIEW_REQUIRED' : rows.some(row => row.state === 'RUNNING') ? 'RUNNING' : 'PLANNED', supervisor: lease, runs: rows, review }
}

export async function writeReview({ campaign, pairId, decision, evidence, reviewer }) {
  const root = campaignRoot(campaign)
  if (!['accept', 'reject', 'revise'].includes(decision)) throw new Error('Review decision must be accept, reject or revise')
  if (!evidence?.path) throw new Error('Review requires a structured evidence path')
  const body = { campaign, pairId, decision, evidence, reviewer, decidedAt: new Date().toISOString(), note: 'review accepts the evidence and permits the next precommitted block; it never converts a quality failure into a pass' }
  await atomicJson(join(root, 'reviews', `${pairId}.json`), body)
  return body
}

export async function campaignStatus({ campaign }) {
  const root = campaignRoot(campaign)
  const manifest = await readJson(join(root, 'manifest.json'), null)
  if (!manifest) return { campaign, state: 'UNPREPARED' }
  const pairs = await readdir(root).then(entries => entries.filter(entry => /^(pilot|main)-/.test(entry)))
  return { campaign, state: 'PREPARED', manifest, pairs: await Promise.all(pairs.map(pairId => pairStatus({ campaign, pairId }))) }
}

export async function sealCandidateTarball({ campaign, output }) {
  const root = campaignRoot(campaign)
  const target = output ?? join(resolve('.test-runtime/longrun-20260915'), 'artifacts')
  await mkdir(target, { recursive: true, mode: 0o700 })
  const out = execFileSync('npm', ['pack', '--pack-destination', target], { encoding: 'utf8', cwd: resolve('.'), env: { ...process.env, COREPACK_ENABLE_AUTO_PIN: '0' }, timeout: 300000 })
  const name = out.trim().split('\n').at(-1)
  const path = join(target, name)
  const bytes = await readFile(path)
  const digest = sha256(bytes)
  const renamed = join(target, `${digest}.tgz`)
  if (renamed !== path) {
    await writeFile(renamed, bytes, { mode: 0o600 })
  }
  await atomicJson(join(root, 'candidate-tarball.json'), { name, path: renamed, sha256: digest, bytes: bytes.length, packedAt: new Date().toISOString() })
  return { path: renamed, sha256: digest, bytes: bytes.length, name }
}
