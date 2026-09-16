// Strict, deterministic scoring of the frozen 96-question probe. Scoring never
// consults a second model and never cherry-picks fragments from several objects.
import { join } from 'node:path'
import { runDirectory, readJson, atomicJson } from './context.mjs'

// The scorer module is loaded lazily so the harness stays importable (and its
// non-scoring contracts testable) before the corpus/scorer package is built.
export async function scoreRun({ campaign, pairId, arm, runId }) {
  const { parseAnswerObject, scoreFinalProbe } = await import('./scoring.mjs')
  const root = runDirectory(campaign, pairId, arm, runId)
  const progress = await readJson(join(root, 'progress.json'), {})
  const endpoint = progress.finalEndpoint ?? progress.episode
  const oraclePath = join(runDirectory(campaign, pairId, arm, runId), '..', '..', '..', 'private', 'endpoint-probes', `N${endpoint}.json`)
  const oracle = await readJson(oraclePath, null)
  if (!oracle) throw new Error(`Sealed oracle for endpoint ${endpoint} is unavailable`)
  const answers = await readJson(join(root, 'control', 'probe-answers.json'), [])
  const parsed = parseProbeAnswers(answers, parseAnswerObject)
  const exposures = await readJson(join(root, 'control', 'probe-exposures.json'), {})
  const score = scoreFinalProbe({ parsed: parsed.answers, formatFailures: parsed.formatFailures, oracle, exposures, endpoint })
  score.runId = runId
  score.arm = arm
  score.pairId = pairId
  score.scoredAt = new Date().toISOString()
  await atomicJson(join(root, 'score.json'), score)
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
