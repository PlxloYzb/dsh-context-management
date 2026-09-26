// Strict, deterministic scoring of the frozen 96-question probe. Scoring never
// consults a second model and never cherry-picks fragments from several objects.
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { runDirectory, readJson, atomicJson, campaignRoot } from './context.mjs'

/**
 * The probe oracle for this run's endpoint, derived from the run's OWN corpus.
 *
 * The campaign-wide `private/endpoint-probes/N<endpoint>.json` is generated once,
 * from the PILOT seed. A formal pair runs a different seed, so grading a 91601
 * journey against it produced 0 of 96 matching question labels, made every
 * question unanswerable, and turned the quality gate into the baseline of
 * answering "absent" everywhere. Deriving from the sealed salt plus the run's own
 * seed cannot drift, and the corpus is still hash-verified against its sealed
 * record so nothing about the run's behaviour can influence the questions.
 */
async function deriveOracle({ campaign, root, endpoint }) {
  const { generateCorpus, generateOracle, fixtureManifest } = await import('./fixture.mjs')
  const run = await readJson(join(root, 'run.json'), {})
  const seed = run.seed
  if (seed === undefined) throw new Error('ORACLE_SEED_UNAVAILABLE: run record carries no seed')
  const rootDir = campaignRoot(campaign)
  const salt = (await readFile(join(rootDir, 'private', 'hidden-salt'))).toString('hex')
  const sealedCorpus = await readJson(join(rootDir, 'private', 'corpora', `seed-${seed}.json`), null)
  if (!sealedCorpus) throw new Error(`SEALED_CORPUS_UNAVAILABLE: seed ${seed}`)
  const corpus = generateCorpus({ seed, salt, episodes: sealedCorpus.episodes })
  const manifest = fixtureManifest(corpus)
  if (manifest.hash !== sealedCorpus.hash) throw new Error(`SEALED_CORPUS_CHANGED: seed ${seed}`)
  // The oracle stays pristine: the scorer validates its shape and rejects unknown
  // fields. Provenance is reported beside it.
  const oracle = generateOracle({ corpus, endpoint })
  return { oracle, provenance: { oracleSource: 'derived-from-run-corpus', corpusHash: manifest.hash, seed } }
}

// The scorer module is loaded lazily so the harness stays importable (and its
// non-scoring contracts testable) before the corpus/scorer package is built.
export async function scoreRun({ campaign, pairId, arm, runId, answersFile = 'probe-answers.json', scoreFile = 'score.json' }) {
  const { parseAnswerObject, scoreFinalProbe } = await import('./scoring.mjs')
  const root = runDirectory(campaign, pairId, arm, runId)
  const progress = await readJson(join(root, 'progress.json'), {})
  const endpoint = progress.finalEndpoint ?? progress.episode
  const { oracle, provenance } = await deriveOracle({ campaign, root, endpoint })
  const answers = await readJson(join(root, 'control', answersFile), [])
  const parsed = parseProbeAnswers(answers, parseAnswerObject)
  const exposures = await readJson(join(root, 'control', 'probe-exposures.json'), {})
  const score = scoreFinalProbe({ parsed: parsed.answers, formatFailures: parsed.formatFailures, oracle, exposures, endpoint })
  score.oracleProvenance = provenance
  score.runId = runId
  score.arm = arm
  score.pairId = pairId
  score.scoredAt = new Date().toISOString()
  await atomicJson(join(root, scoreFile), score)
  return score
}

// Each batch must be exactly one JSON object keyed by queryId (optionally inside
// one fenced block). A batch that violates the frozen format contributes
// FORMAT_FAILURE for its own questions and never partial credit.
export function parseProbeAnswers(batches, parseAnswerObject = defaultParser) {
  const answers = {}
  const formatFailures = []
  for (const batch of batches ?? []) {
    const view = parseAnswerObject(batch.text ?? '')
    if (view.status !== 'ok' || !view.value || typeof view.value !== 'object' || Array.isArray(view.value)) {
      formatFailures.push({ batch: batch.batch, queryIds: batch.queryIds ?? [], reason: view.status === 'ok' ? 'not-an-object' : view.status })
      continue
    }
    const expected = new Set(batch.queryIds ?? [])
    for (const [queryId, value] of Object.entries(view.value)) {
      if (expected.size > 0 && !expected.has(queryId)) {
        formatFailures.push({ batch: batch.batch, queryIds: [queryId], reason: 'queryId-not-assigned-to-batch' })
        continue
      }
      if (Object.hasOwn(answers, queryId)) {
        formatFailures.push({ batch: batch.batch, queryIds: [queryId], reason: 'duplicate-queryId' })
        continue
      }
      answers[queryId] = value
    }
  }
  return { answers, formatFailures }
}

function defaultParser(text) {
  const trimmed = String(text ?? '').trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)
  const body = fenced ? fenced[1].trim() : trimmed
  const outside = fenced ? trimmed.replace(fenced[0], '').trim() : ''
  if (outside.length > 0) return { status: 'text-outside-fence' }
  try { return { status: 'ok', value: JSON.parse(body) } } catch { return { status: 'malformed-json' } }
}
