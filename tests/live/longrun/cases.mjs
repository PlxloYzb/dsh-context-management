// Section-11 diagnostic coverage matrix. Every case keeps a traceable status in
// the campaign; natural-timing cases are never upgraded to PASS by a controlled
// substitute.
import { join } from 'node:path'
import { campaignRoot, readJson, atomicJson } from './context.mjs'

export const CASE_MATRIX = {
  X01: { title: 'Threshold/pruner/Unicode', variants: ['T-1', 'T', 'T+1', 'large-result-unicode'] },
  X02: { title: 'Pending summary and independent work', variants: ['natural-pending', 'controlled-delay'] },
  X03: { title: 'Immediate/delayed history dependency', variants: ['immediate', 'two-step', 'five-step', 'guided-empty-await', 'guided-late'] },
  X04: { title: 'Controlled delivery delay', variants: ['delay-0', 'delay-5', 'delay-20'] },
  X05: { title: 'Overlapping sources and revision authority', variants: ['overlap-pending-correction', 'stale-authority'] },
  X06: { title: 'Summary limits/failure/fallback', variants: ['no-summary', 'input-limit', 'output-limit', 'empty', 'timeout', 'cancel', 'budget'] },
  X07: { title: 'Safe pre-step and current input', variants: ['tool-pairing', 'steer', 'queued-input', 'accepted-then-input'] },
  X08: { title: 'Bounded retrieval and cursors', variants: ['missing-id', 'ambiguous-id', 'cross-block', 'restart-cursor', 'bounded-absence'] },
  X09: { title: 'Archive source graph and attachments', variants: ['rearchived', 'nested-sources', 'same-bytes-distinct-seq', 'attachment-reference'] },
  X10: { title: 'Native commands and presets', variants: ['compact', 'context', 'busy', 'cancel', 'standard', 'ptc', 'cordis', 'minimal'] },
  X11: { title: 'Replacement lifecycle', variants: ['enable-existing', 'toggle', 'late-basic', 'include-reload', 'config-change', 'no-backend'] },
  X12: { title: 'Cancellation and disposal', variants: ['pending-cancel', 'ready-before-append', 'delivered-before-dispose'] },
  X13: { title: 'Host restart and transaction crash', variants: ['flushed-restart', 'pending-restart', 'commit-gap-sigkill'] },
  X14: { title: 'Driver/supervisor crash recovery', variants: ['driver-crash', 'supervisor-crash', 'receipt-window-crash'] },
  X15: { title: 'Provider failure and usage accounting', variants: ['429', '5xx', 'no-first-content', 'transport-loss', 'usage-missing', 'usage-duplicate', 'usage-reordered'] },
  X16: { title: 'Two-session isolation', variants: ['conflicting-ids', 'stream-cap'] },
  X17: { title: 'Untrusted history instructions', variants: ['fake-system', 'fake-user', 'unapproved-summary-action'] },
  X18: { title: 'Scale/resources/observer overhead', variants: ['create-dispose-20', 'retrieval-cancel', 'observer-off', 'scale-1k-1w', 'scale-10k-10w', 'scale-50k-50w'] },
}

export async function caseRoot(campaign, id) {
  return join(campaignRoot(campaign), 'cases', id)
}

export async function recordCase({ campaign, id, variant, status, detail, evidence }) {
  if (!CASE_MATRIX[id]) throw new Error(`Unknown diagnostic case ${id}`)
  // An undeclared variant silently corrupts the matrix: it is not one of the
  // precommitted variants, so aggregating over declared variants would ignore it
  // while the ledger looked complete. (A typo'd `useage-accounting` was recorded
  // this way.)
  if (variant !== 'default' && !CASE_MATRIX[id].variants.includes(variant)) {
    throw new Error(`Variant ${variant} is not precommitted for ${id} (declared: ${CASE_MATRIX[id].variants.join(', ')})`)
  }
  if (!['PASS', 'PARTIAL', 'FAIL', 'NOT_EXERCISED', 'NOT_APPLICABLE', 'INVALID_EVIDENCE'].includes(status)) throw new Error(`Unknown case status ${status}`)
  const path = join(campaignRoot(campaign), 'cases', `${id}.json`)
  const previous = await readJson(path, { id, title: CASE_MATRIX[id].title, variants: {} })
  previous.variants = { ...previous.variants, [variant]: { status, detail: detail ?? null, evidence: evidence ?? null, recordedAt: new Date().toISOString() } }
  // Aggregate over the variants actually recorded, plus the number of declared
  // variants still missing. A case is PASS only when every declared required
  // variant is PASS; a partial exercise is PARTIAL, never a bare NOT_EXERCISED
  // that would hide the evidence that does exist.
  const required = CASE_MATRIX[id].variants
  const rows = required.map(name => previous.variants[name]?.status ?? null)
  const recorded = rows.filter(row => row !== null)
  previous.coveredVariants = recorded.filter(row => row === 'PASS').length
  previous.declaredVariants = required.length
  // "Nothing was exercised" must not read as PARTIAL. Recording every declared
  // variant as NOT_EXERCISED is exactly what an unexercised case looks like, and
  // reporting PARTIAL there would claim coverage that does not exist — the same
  // overclaim as marking a harness measurement a plugin PASS.
  const unexercised = new Set(['NOT_EXERCISED', 'NOT_APPLICABLE'])
  previous.status = rows.every(row => row === 'PASS') ? 'PASS'
    : recorded.some(row => row === 'FAIL') ? 'FAIL'
      : recorded.some(row => row === 'INVALID_EVIDENCE') ? 'INVALID_EVIDENCE'
        : recorded.length === 0 || recorded.every(row => unexercised.has(row))
          ? (recorded.every(row => row === 'NOT_APPLICABLE') && recorded.length > 0 ? 'NOT_APPLICABLE' : 'NOT_EXERCISED')
          : 'PARTIAL'
  previous.updatedAt = new Date().toISOString()
  if (!previous.ledger) previous.ledger = []
  previous.ledger.push({ variant, status, recordedAt: previous.updatedAt, evidence: evidence ?? null })
  await atomicJson(path, previous)
  return previous
}

// Only cases with a real controlled implementation run from the CLI. Everything
// else is recorded as NOT_EXERCISED with the precondition that is missing, so
// the matrix never silently overclaims.
export async function runDiagnosticCase({ campaign, id, variant, dshBin }) {
  if (!CASE_MATRIX[id]) throw new Error(`Unknown diagnostic case ${id}`)
  if (!CASE_MATRIX[id].variants.includes(variant) && variant !== 'default') {
    throw new Error(`Variant ${variant} is not precommitted for ${id}`)
  }
  const runner = IMPLEMENTED[id]
  if (!runner) {
    return recordCase({
      campaign, id, variant,
      status: 'NOT_EXERCISED',
      detail: 'No controlled implementation is wired for this case yet; the precondition has not been exercised.',
    })
  }
  return runner({ campaign, id, variant, dshBin })
}

// X14 driver/supervisor crash recovery and X18 offline create/dispose are
// implementable without a model turn and are wired here.
const IMPLEMENTED = {
  async X18({ campaign, id, variant }) {
    if (variant !== 'create-dispose-20' && variant !== 'default') {
      return recordCase({ campaign, id, variant, status: 'NOT_EXERCISED', detail: 'scale variants require the no-model dose harness' })
    }
    const { measureCreateDispose } = await import('./resources.mjs')
    const result = await measureCreateDispose({ sessions: 20 })
    return recordCase({
      campaign, id, variant: variant === 'default' ? 'create-dispose-20' : variant,
      status: result.passed ? 'PASS' : 'FAIL',
      detail: result,
      evidence: result.evidencePath,
    })
  },
  async X14({ campaign, id, variant }) {
    if (variant !== 'driver-crash') {
      return recordCase({ campaign, id, variant, status: 'NOT_EXERCISED', detail: 'only the driver-crash window has a controlled implementation' })
    }
    const { measureLeaseRecovery } = await import('./resources.mjs')
    const result = await measureLeaseRecovery({ campaign })
    return recordCase({ campaign, id, variant, status: result.passed ? 'PASS' : 'FAIL', detail: result, evidence: result.evidencePath })
  },
}
