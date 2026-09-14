import { resolveSources } from './archive.ts'
/**
 * M5 — durable region transaction and the log-rebuilt block ledger.
 *
 * Modeled on `dsh-compaction-basic/src/region.ts` (which is package-internal
 * and not exported by the seam): validate the surface range and tool-call/result
 * pairing, take the durable `compaction/start` lock, record `compaction/summary`
 * as the shadow price, land the `user/message` surface replacement carrying the
 * summary under `compactCheckpointSource`, and release the lock with
 * `compaction/end`. The original events stay in the append-only log, so
 * decompress/search/status can rebuild everything from the log.
 * @module dsh-context-management/region
 */

import { SessionSeq } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import type { Session, SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { defaultCountTokens } from 'acp-kernel'
import { extractEventText, extractText } from './messages.ts'

export interface WindowMetadata {
  readonly schemaVersion: 1
  readonly kind: 'window'
  readonly operationId: string
  readonly requestId?: string
  readonly incomingUserId?: string
  readonly trigger: 'model' | 'manual' | 'pressure' | 'context-overflow'
  readonly fromWindowId: string
  readonly toWindowId: string
  readonly generationAfter: number
  readonly parentBlockIds: readonly string[]
  readonly route: { readonly provider: string; readonly model: string }
  readonly seed: { readonly incomplete: boolean; readonly formatVersion: 1; readonly mode?: 'extractive' | 'model-assisted' }
}

/** One durable ARC block as rebuilt from the session log. */
export interface ArcBlockLedgerEntry {
  /** The compaction transaction id (stable block identity). */
  readonly blockId: string
  readonly contextManagement?: WindowMetadata
  readonly summary: string
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
  readonly start: number
  readonly end: number
  /** Compression tier: 1 (message range), 2 (distills tier-1 blocks), 3 (distills tier-2 blocks). Legacy blocks default to 1. */
  readonly tier: 1 | 2 | 3
  /** Compaction ids of the blocks this block distilled (parents). Empty for tier-1 blocks. */
  readonly parentBlockIds: readonly string[]
  /** The acp-kernel block id (`bN`) created for this transaction — absent for legacy blocks (synthesised by order). */
  readonly kernelBlockId?: string
  /** The surface seq of this block's checkpoint summary node (derived from the log; null when the node is gone). */
  readonly summarySeq?: number
  /** The kernel block's raw direct/effective message ids at creation (recorded since the tier feature; absent for legacy). */
  readonly directMessageIds?: readonly string[]
  readonly effectiveMessageIds?: readonly string[]
  /** Whether this model-checkpoint safety appendix was derived from recursively expanded sources. */
  readonly safetyIndexSource?: 'direct' | 'effective'
  /** Unix epoch ms of the compaction/summary event. */
  readonly createdAt: number
}

/** The open turn number, or null when the log ends between turns. */
export function findOpenTurn(events: readonly SessionEvent[]): number | null {
  let open: number | null = null
  for (const event of events) {
    if (event.type === 'turn/start') open = event.data.turn
    else if (event.type === 'turn/end' && event.data.turn === open) open = null
  }
  return open
}

/** Reject a second concurrent compaction for the same session. */
export function assertNoActiveCompaction(events: readonly SessionEvent[]): void {
  let active = false
  for (const event of events) {
    if (event.type === 'compaction/start') active = true
    else if (event.type === 'compaction/end' || event.type === 'session/end-seed') active = false
  }
  if (active) {
    throw new Error('dsh-context-management: another compaction is already active for this session')
  }
}

/**
 * Whether the surface node at `seq` projects to CoreMessage(s) whose ref key
 * is the bare seq — user messages, tool results, and text-only or SINGLE
 * tool-call assistant messages all do. Multi-tool-call assistant messages
 * project to `${seq}#${callId}` ids (projectEvent) and therefore carry NO
 * bare-`${seq}` ref, so compress's byRaw lookup can never resolve them as
 * range edges. resolveSurfaceRange treats such edges as unbalanced and shifts
 * them to the nearest clean cut.
 */
function hasPlainRef(session: Session, seq: number): boolean {
  const event = session.eventAt(SessionSeq(seq))
  if (event === undefined) return false
  switch (event.type) {
    case 'user/message':
    case 'tool/result':
      return extractEventText(event).trim().length > 0
    case 'assistant/message': {
      const content = (event.data as { message?: { content?: unknown } }).message?.content
      const calls = Array.isArray(content)
        ? content.filter(
            (block) => block !== null && typeof block === 'object' && (block as { type?: string }).type === 'tool-call',
          )
        : []
      if (calls.length > 1) return false
      // One tool-call: projectEvent emits a bare-seq CoreMessage unconditionally.
      // Zero: only when the text is non-empty.
      return calls.length === 1 || extractEventText(event).trim().length > 0
    }
    default:
      return false
  }
}

/**
 * A requested range whose EVERY live message was already shadowed by one or
 * more blocks. The compress tool catches this and reports the range as already
 * compressed (with the covering block ids) instead of folding block summary
 * nodes as plain messages or erroring out. Distillation stays an explicit act:
 * target a LIVE checkpoint seq directly to distill (tier 2/3).
 */
export class AlreadyCompressedRangeError extends Error {
  constructor(
    readonly start: number,
    readonly end: number,
    readonly coveringBlockIds: readonly string[],
  ) {
    super(
      `dsh-context-management: seq ${start}..${end} already compressed — `
      + 'no live content remains in that span',
    )
    this.name = 'AlreadyCompressedRangeError'
  }
}

type StaleRangeRecovery =
  | { kind: 'ok'; start: number; end: number }
  | { kind: 'already-compressed'; coveringBlockIds: string[] }
  | { kind: 'unresolvable'; failedEdge: number }

/**
 * Rebuild a requested range whose edges are no longer on the current surface.
 * The dominant cause is staleness: the seqs came from an older nudge table or
 * a previous compress result, and an earlier compression SHADOWED them (they
 * stay in the append-only log, but are gone from the surface). The recovery:
 *
 *  1. An edge that does not exist in the log at all (invented, or from another
 *     session) is unresolvable — there is no way to guess what it meant.
 *  2. The still-LIVE surface nodes inside the requested span, in VALUE order
 *     (the surface can be locally non-monotonic after replacements, so value
 *     order is the only coherent span). If there are none, the whole span was
 *     already compressed → 'already-compressed' with the covering block ids.
 *  3. Otherwise the range snaps to the first..last live PLAIN node in the
 *     span. Block checkpoint nodes are deliberately excluded: distilling a
 *     block on a STALE reference would silently change block structure the
 *     model never intended to touch — distillation requires targeting a live
 *     checkpoint seq directly.
 */
function recoverStaleRange(session: Session, start: number, end: number): StaleRangeRecovery {
  if (session.eventAt(SessionSeq(start)) === undefined || session.eventAt(SessionSeq(end)) === undefined) {
    const failedEdge = session.eventAt(SessionSeq(start)) === undefined ? start : end
    return { kind: 'unresolvable', failedEdge }
  }
  const liveInside = session.surface.nodes
    .filter((seq) => seq >= start && seq <= end)

  const plain = liveInside.filter((seq) => !isCheckpointNode(session.eventAt(SessionSeq(seq))!))
  if (plain.length === 0) {
    const coveringBlockIds = rebuildBlockLedger(session.snapshotEvents())
      .filter((entry) => entry.shadowedSeqs.some((seq) => seq >= start && seq <= end))
      .map((entry) => entry.blockId)
    return { kind: 'already-compressed', coveringBlockIds }
  }
  return { kind: 'ok', start: plain[0]!, end: plain[plain.length - 1]! }
}

export interface ResolvedSurfaceRange {
  readonly start: number
  readonly end: number
  /**
   * True when the requested edges were not on the current surface and were
   * remapped to the still-live content of the requested span (an earlier
   * compression shadowed them). Callers surface this so the model sees what
   * was actually compressed instead of silently shadowing a different span.
   */
  readonly recovered?: boolean
}

/**
 * Validate one inclusive surface span and adjust its edges to a
 * tool-pairing-balanced range whose boundaries carry a bare-seq ref. Reversed
 * ranges throw. An edge that sits inside a tool-call/result pair — or on a
 * multi-tool-call assistant message that has no bare-seq ref — is first nudged
 * inward to the nearest clean cut; if that collapses the range (e.g. the model
 * asked for a SINGLE tool result, which can never be balanced alone), the
 * range EXPANDS outward to the enclosing clean pair instead — a lone tool
 * message is almost always a "consumed output" the model genuinely wants to
 * compress. The returned range is what a caller should actually shadow.
 *
 * Missing edges are NOT an immediate error: the seqs were probably shadowed by
 * an earlier compression (stale nudge table / old compress result). The span
 * is rebuilt from its still-live remainder via recoverStaleRange — a fully
 * shadowed span throws AlreadyCompressedRangeError, a genuinely unknown edge
 * throws the not-in-surface guidance error. The returned range is what a
 * caller should actually shadow.
 */
export function resolveSurfaceRange(
  session: Session,
  start: number,
  end: number,
): ResolvedSurfaceRange {
  const nodes = session.surface.nodes
  let requestedStartIdx = nodes.indexOf(SessionSeq(start))
  let requestedEndIdx = nodes.indexOf(SessionSeq(end))
  let recovered = false
  if (requestedStartIdx < 0 || requestedEndIdx < 0) {
    for (const edge of [start, end]) {
      const event = session.eventAt(SessionSeq(edge))
      if (start === end && event && !('surfaceOp' in event)) throw new Error(`dsh-context-management: seq ${edge} is not a surface node; use message seqs from arc_status`)
    }
    const stale = recoverStaleRange(session, start, end)
    if (stale.kind === 'unresolvable') {
      throw new Error(
        `dsh-context-management: seq ${start}..${end} not in the current surface — `
        + `edge seq ${stale.failedEdge} is not in this session's log. `
        + 'Surface seqs are sparse message nodes (only user/message, assistant/message, '
        + 'tool/result events); consult arc_status for the current surface range',
      )
    }
    if (stale.kind === 'already-compressed') {
      throw new AlreadyCompressedRangeError(start, end, stale.coveringBlockIds)
    }
    start = stale.start
    end = stale.end
    recovered = true
    requestedStartIdx = nodes.indexOf(SessionSeq(start))
    requestedEndIdx = nodes.indexOf(SessionSeq(end))
    if (requestedStartIdx < 0 || requestedEndIdx < 0) {
      // Unreachable in practice (recovery returns live nodes), but never let
      // a negative index reach the balancing passes.
      throw new Error(
        `dsh-context-management: seq ${start}..${end} not in the current surface — `
        + 'consult arc_status for the current surface range',
      )
    }
  }
  if (requestedStartIdx > requestedEndIdx) {
    throw new Error(`dsh-context-management: reversed range ${start}..${end}`)
  }
  // Belt-and-braces: the surface can be locally out of order after surface
  // replacements, so index order alone does not guarantee value order.
  // A boundary must be BOTH tool-pairing-balanced AND carry a bare-seq ref.
  const cleanBefore = (index: number): boolean =>
    toolPairingBalancedBefore(session, nodes[index]!) && hasPlainRef(session, nodes[index]!)
  const cleanAfter = (index: number): boolean =>
    toolPairingBalancedAfter(session, nodes[index]!) && hasPlainRef(session, nodes[index]!)
  let startIdx = requestedStartIdx
  let endIdx = requestedEndIdx
  // First pass: nudge inward to the nearest clean cuts.
  while (startIdx <= endIdx && !cleanBefore(startIdx)) {
    startIdx += 1
  }
  while (endIdx >= startIdx && !cleanAfter(endIdx)) {
    endIdx -= 1
  }
  if (startIdx <= endIdx) {
    return recovered
      ? { start: nodes[startIdx]!, end: nodes[endIdx]!, recovered: true }
      : { start: nodes[startIdx]!, end: nodes[endIdx]! }
  }
  // A recovered span NEVER expands across block checkpoints: the model's
  // requested edges were stale, so growing the span into block territory could
  // fold content it never intended to touch. If the live remainder cannot be
  // balanced by shrinking alone, give up with guidance instead.
  if (recovered) {
    throw new Error(
      `dsh-context-management: no tool-pairing-balanced live remainder around seq ${start}..${end} — `
      + 'narrow the range or consult arc_status for the current surface',
    )
  }
  // Second pass: the inward pass collapsed (a lone tool message) — expand
  // outward from the REQUESTED span to the smallest clean enclosing pair.
  startIdx = requestedStartIdx
  endIdx = requestedEndIdx
  while (startIdx > 0 && !cleanBefore(startIdx)) {
    if (isCheckpointNode(session.eventAt(SessionSeq(nodes[startIdx - 1]!))!)) break
    startIdx -= 1
  }
  while (endIdx < nodes.length - 1 && !cleanAfter(endIdx)) {
    if (isCheckpointNode(session.eventAt(SessionSeq(nodes[endIdx + 1]!))!)) break
    endIdx += 1
  }
  // Value order guard: the surface is locally non-monotonic after replacements
  // (a checkpoint seq inserted ahead of older residual nodes), so index order
  // alone is not enough — never return a span whose end seq is numerically
  // BEFORE its start seq. The caller (nudge / compress) skips such a span.
  if (cleanBefore(startIdx) && cleanAfter(endIdx)) {
    return { start: nodes[startIdx]!, end: nodes[endIdx]! }
  }
  throw new Error(
    `dsh-context-management: no tool-pairing-balanced range around seq ${start}..${end} — `
    + 'narrow the range or consult arc_status for the current surface',
  )
}

/** The surface seqs shadowed by the inclusive positional span. */
export function shadowedSeqsOf(session: Session, start: number, end: number): number[] {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(SessionSeq(start))
  const endIdx = nodes.indexOf(SessionSeq(end))
  return nodes.slice(startIdx, endIdx + 1)
}

export function validateExactRange(session: Session, start: number, end: number, incomingUser?: import('@deepseek-ai/dsh-llm').UserMessage): number[] {
  const nodes = session.surface.nodes
  const first = nodes.indexOf(SessionSeq(start)), last = nodes.indexOf(SessionSeq(end))
  if (first < 0 || last < first) throw new Error('invalid positional range')
  if (incomingUser && (incomingUser.source.kind !== 'user' || session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === incomingUser.id))) throw new Error('invalid-incoming-user-boundary')
  if (!incomingUser && findOpenTurn(session.snapshotEvents()) !== null) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const event = session.eventAt(nodes[i]!)
      if (event?.type === 'user/message' && event.data.source.kind === 'user') {
        if (i >= first && i <= last) {
          throw new Error('protected-current-user: the latest user input cannot be archived')
        }
        break
      }
    }
  }
  if (!toolPairingBalancedBefore(session, SessionSeq(start)) || !toolPairingBalancedAfter(session, SessionSeq(end))) throw new Error('unbalanced range')
  return nodes.slice(first, last + 1)
}

export interface CompactionTransactionInput {
  /** A new real user message accepted by the host pre-step decision, not yet on surface. */
  readonly incomingUser?: import('@deepseek-ai/dsh-llm').UserMessage
  readonly operationId?: string
  readonly contextManagement?: Omit<WindowMetadata, 'operationId'>
  readonly start: number
  readonly end: number
  readonly shadowedSeqs: readonly number[]
  readonly summary: ContentBlock[]
  readonly shadowedTokenCount: number
  readonly provider: string
  readonly model: string
  /**
   * The checkpoint was authored by a model tool call. Its current routed
   * request header outranks the agent's creation-time defaults, which may be
   * stale after a session-level model switch.
   */
  readonly modelAuthored?: boolean
  /** Compression tier of this block (default 1). */
  readonly tier?: 1 | 2 | 3
  /** The acp-kernel block id (`bN`) created by the kernel for this transaction. */
  readonly kernelBlockId?: string
  /** Compaction ids of the blocks distilled into this one. */
  readonly parentBlockIds?: readonly string[]
  /** The kernel block's direct/effective message ids (raw CoreMessage ids) — recorded for faithful rehydration. */
  readonly directMessageIds?: readonly string[]
  readonly effectiveMessageIds?: readonly string[]
  readonly safetyIndexSource?: 'direct' | 'effective'
}

function nonEmptyRoutePart(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Resolve durable checkpoint metadata for a model-authored transaction.
 *
 * The latest request/header is the exact provider/model captured for the
 * current step. Agent options can remain at the host default after
 * session.selectModel, so using them alone misattributes a model-written
 * checkpoint. Local/manual transactions keep their supplied metadata; hosts
 * without a routed header retain the supplied agent-route fallback.
 */
function transactionRoute(session: Session, input: CompactionTransactionInput): {
  provider: string
  model: string
} {
  if (input.modelAuthored !== true) return { provider: input.provider, model: input.model }
  const config = session.requestHeader()?.config
  return {
    provider: nonEmptyRoutePart(config?.provider) ?? input.provider,
    model: nonEmptyRoutePart(config?.model) ?? input.model,
  }
}

interface CompactionLifecycleOptions {
  readonly turn: number | null
  readonly sourceCommandId?: CommandId
}

/**
 * ARC tier extension fields carried on `compaction/summary` events. The
 * upstream dsh-compaction event type does not know them, so reads and writes
 * go through this precise intersection (never `any`).
 */
export interface ArcCompactionSummaryFields {
  readonly contextManagement?: WindowMetadata
  /** Compression tier (1/2/3) — 1 = message range, 2 = distills tier-1, 3 = distills tier-2. */
  readonly tier?: 1 | 2 | 3
  /** The acp-kernel block id (`bN`) created for this transaction. */
  readonly kernelBlockId?: string
  /** Durable compaction ids of the blocks distilled into this one. */
  readonly parentBlockIds?: readonly string[]
  /**
   * The kernel block's direct message ids (raw CoreMessage ids) at creation —
   * recorded so a restarted engine rehydrates the SAME coverage (a tier-2
   * block's coverage is its parents' originals, not the checkpoint node).
   */
  readonly directMessageIds?: readonly string[]
  /** The kernel block's effective message ids (raw CoreMessage ids) at creation. */
  readonly effectiveMessageIds?: readonly string[]
  /** Provenance of the model-checkpoint safety appendix, when present. */
  readonly safetyIndexSource?: 'direct' | 'effective'
}

type CompactionSummaryData = SessionEventMap['compaction/summary']

/** Read a `compaction/summary` event's data including the ARC tier extension fields. */
export function readCompactionSummary(event: SessionEvent): CompactionSummaryData & ArcCompactionSummaryFields {
  return event.data as CompactionSummaryData & ArcCompactionSummaryFields
}

/**
 * Run one durable compression transaction. Throws on invalid state; on success
 * the four events are in the log and the surface has one summary node.
 */
export function runCompactionTransaction(
  session: Session,
  input: CompactionTransactionInput,
): { compactionId: string; seqs: SessionSeq[] } {
  assertNoActiveCompaction(session.snapshotEvents())
  const turn = findOpenTurn(session.snapshotEvents())
  const compactionId = CompactionId(input.operationId ?? randomUUID())
  if (input.operationId && session.snapshotEvents().some(event => event.type === 'compaction/start' && event.data.compactionId === compactionId)) throw new Error('duplicate-operation-id')
  const route = transactionRoute(session, input)
  const seqs: SessionSeq[] = []

  const current = validateExactRange(session, input.start, input.end, input.incomingUser)
  if (!sameSeqs(current, input.shadowedSeqs) || current.length === 0) throw new Error('changed: selected surface span changed')
  if (!toolPairingBalancedBefore(session, SessionSeq(input.start)) || !toolPairingBalancedAfter(session, SessionSeq(input.end))) throw new Error('unbalanced range')
  seqs.push(session.append('compaction/start', { compactionId, turn }).seq)
  try {
  seqs.push(session.append('compaction/summary', {
    compactionId,
    ...(input.contextManagement === undefined ? {} : { contextManagement: { ...input.contextManagement, operationId: compactionId } }),
    summary: input.summary,
    shadowedRange: { start: SessionSeq(input.start), end: SessionSeq(input.end) },
    shadowedSeqs: input.shadowedSeqs.map(SessionSeq),
    shadowedTokenCount: input.shadowedTokenCount,
    provider: route.provider,
    model: route.model,
    tier: input.tier ?? 1,
    ...(input.kernelBlockId === undefined ? {} : { kernelBlockId: input.kernelBlockId }),
    ...(input.parentBlockIds === undefined || input.parentBlockIds.length === 0
      ? {}
      : { parentBlockIds: [...input.parentBlockIds] }),
    ...(input.directMessageIds === undefined ? {} : { directMessageIds: [...input.directMessageIds] }),
    ...(input.effectiveMessageIds === undefined ? {} : { effectiveMessageIds: [...input.effectiveMessageIds] }),
    ...(input.safetyIndexSource === undefined ? {} : { safetyIndexSource: input.safetyIndexSource }),
  } as CompactionSummaryData & ArcCompactionSummaryFields).seq)

  const message = createUserMessage({
    content: input.summary,
    source: compactCheckpointSource(compactionId),
  })
  seqs.push(session.append('user/message', message, {
    surfaceOp: { op: 'replace', start: SessionSeq(input.start), end: SessionSeq(input.end) },
    sourceEventSeqs: [seqs[0]!, seqs[1]!, ...input.shadowedSeqs.map(SessionSeq)],
  }).seq)

  seqs.push(session.append('compaction/end', { compactionId, turn }).seq)
  return { compactionId, seqs }
  } catch (error) {
    try { session.append('compaction/end', { compactionId, turn, error: String(error) }) }
    catch (closeError) { throw new AggregateError([error, closeError], 'recovery-required: transaction closure failed') }
    throw error
  }
}

function sameSeqs(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((seq, index) => seq === right[index])
}

function manualError(stage: 'summary' | 'changed' | 'commit', cause: unknown): ManualCompactionError {
  switch (stage) {
    case 'summary':
      return new ManualCompactionError('summary', 'manual ARC compaction could not produce a smaller checkpoint', { cause })
    case 'changed':
      return new ManualCompactionError('changed', 'the selected history changed during manual ARC compaction', { cause })
    case 'commit':
      return new ManualCompactionError('commit', 'manual ARC compaction did not commit cleanly', { cause })
  }
}

/**
 * Commit one standalone manual transaction under the official idle-operation
 * bracket. The marker opens before local checkpoint construction; the selected
 * span is revalidated before mutation, every failure makes one close attempt,
 * and a successful close is flushed before release.
 */
export async function runManualCompactionTransaction(
  session: Session,
  selection: { readonly start: number; readonly end: number; readonly shadowedSeqs: readonly number[] },
  prepare: () => CompactionTransactionInput,
  signal: AbortSignal,
  sourceCommandId: CommandId | undefined,
  flush: (() => Promise<void>) | undefined,
): Promise<CompactionResult> {
  signal.throwIfAborted()
  try {
    assertNoActiveCompaction(session.snapshotEvents())
  } catch (error) {
    throw new ManualCompactionError('busy', 'manual ARC compaction found an active compaction lock', { cause: error })
  }
  if (findOpenTurn(session.snapshotEvents()) !== null) {
    throw new ManualCompactionError('busy', 'manual ARC compaction requires a session between turns')
  }
  const compactionId = CompactionId(randomUUID())
  const lifecycle: CompactionLifecycleOptions & { readonly compactionId: CompactionId } = {
    compactionId,
    turn: null,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
  }
  const startEvent = session.append('compaction/start', lifecycle)
  let closed = false
  let stage: 'summary' | 'changed' | 'commit' = 'summary'
  try {
    const input = prepare()
    const route = transactionRoute(session, input)
    signal.throwIfAborted()
    const current = shadowedSeqsOf(session, selection.start, selection.end)
    if (!sameSeqs(current, selection.shadowedSeqs)) {
      stage = 'changed'
      throw new Error('selected surface span changed')
    }
    stage = 'commit'
    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      ...(input.contextManagement === undefined ? {} : { contextManagement: { ...input.contextManagement, operationId: compactionId } }),
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      summary: input.summary,
      shadowedRange: { start: SessionSeq(input.start), end: SessionSeq(input.end) },
      shadowedSeqs: input.shadowedSeqs.map(SessionSeq),
      shadowedTokenCount: input.shadowedTokenCount,
      provider: route.provider,
      model: route.model,
      tier: input.tier ?? 1,
      ...(input.kernelBlockId === undefined ? {} : { kernelBlockId: input.kernelBlockId }),
      ...(input.parentBlockIds === undefined || input.parentBlockIds.length === 0
        ? {}
        : { parentBlockIds: [...input.parentBlockIds] }),
      ...(input.directMessageIds === undefined ? {} : { directMessageIds: [...input.directMessageIds] }),
      ...(input.effectiveMessageIds === undefined ? {} : { effectiveMessageIds: [...input.effectiveMessageIds] }),
      ...(input.safetyIndexSource === undefined ? {} : { safetyIndexSource: input.safetyIndexSource }),
    } as CompactionSummaryData & ArcCompactionSummaryFields)
    const message = createUserMessage({
      content: input.summary,
      source: compactCheckpointSource(compactionId, sourceCommandId),
    })
    session.append('user/message', message, {
      surfaceOp: { op: 'replace', start: SessionSeq(input.start), end: SessionSeq(input.end) },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...input.shadowedSeqs.map(SessionSeq)],
    })
    const endEvent = session.append('compaction/end', lifecycle)
    closed = true
    if (flush !== undefined) {
      try {
        await flush()
      } catch (error) {
        throw new ManualCompactionError('persistence', 'manual ARC compaction durability checkpoint failed', { cause: error })
      }
    }
    signal.throwIfAborted()
    return {
      compactionId,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary: input.summary,
      shadowedRange: { start: SessionSeq(input.start), end: SessionSeq(input.end) },
      shadowedSeqs: input.shadowedSeqs.map(SessionSeq),
      shadowedTokenCount: input.shadowedTokenCount,
    }
  } catch (error) {
    if (!closed) {
      try {
        session.append('compaction/end', {
          ...lifecycle,
          error: error instanceof Error ? error.message : String(error),
        })
        closed = true
      } catch (closeError) {
        const failures = [error, closeError]
        if (flush) { try { await flush() } catch (persistenceError) { failures.push(persistenceError) } }
        throw manualError('commit', new AggregateError(failures, 'manual transaction and closure failed'))
      }
    }
    if (flush && !(error instanceof ManualCompactionError && error.code === 'persistence')) {
      try { await flush() }
      catch (persistenceError) { throw new ManualCompactionError('persistence', 'manual failure closure could not be persisted', { cause: new AggregateError([error, persistenceError]) }) }
    }
    signal.throwIfAborted()
    if (error instanceof ManualCompactionError) throw error
    throw manualError(stage, error)
  }
}

/** The seq of a compaction's checkpoint summary node in the log (visible or shadowed). */
function summarySeqOfCompaction(events: readonly SessionEvent[], compactionId: string): number | null {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = (event.data as { source?: { plugin?: string; compactionId?: string } }).source
    if (source?.plugin === 'compact' && source.compactionId === compactionId) return event.seq
  }
  return null
}

/** Normalize a committed summary, retaining legacy diagnostic estimates. */
function ledgerEntry(events: readonly SessionEvent[], event: SessionEvent, summarySeq: number): ArcBlockLedgerEntry {
  const data = readCompactionSummary(event)
    // Blocks written before the token-accounting fix carry shadowedTokenCount
    // 0; backfill from the shadowed originals still in the log so arc_status
    // reports real reclaimed tokens.
    let shadowedTokenCount = data.shadowedTokenCount
    if (shadowedTokenCount === 0) {
      shadowedTokenCount = 0
      for (const seq of data.shadowedSeqs) {
        const original = events[seq]
        if (original !== undefined) shadowedTokenCount += defaultCountTokens(extractEventText(original))
      }
    }
    const tier = data.tier === 2 || data.tier === 3 ? data.tier : 1
    const parentBlockIds: string[] = Array.isArray(data.parentBlockIds) ? [...data.parentBlockIds] : []
    const directMessageIds: string[] | undefined = Array.isArray(data.directMessageIds) ? [...data.directMessageIds] : undefined
    const effectiveMessageIds: string[] | undefined = Array.isArray(data.effectiveMessageIds) ? [...data.effectiveMessageIds] : undefined
    const safetyIndexSource = data.safetyIndexSource === 'effective' || data.safetyIndexSource === 'direct'
      ? data.safetyIndexSource
      : undefined
  return {
      blockId: data.compactionId,
      ...(data.contextManagement === undefined ? {} : { contextManagement: data.contextManagement }),
      summary: extractText(data.summary),
      shadowedSeqs: [...data.shadowedSeqs],
      shadowedTokenCount,
      start: data.shadowedRange.start,
      end: data.shadowedRange.end,
      tier,
      parentBlockIds,
      ...(typeof data.kernelBlockId === 'string' ? { kernelBlockId: data.kernelBlockId } : {}),
      ...(summarySeq === null ? {} : { summarySeq }),
      ...(directMessageIds === undefined ? {} : { directMessageIds }),
      ...(effectiveMessageIds === undefined ? {} : { effectiveMessageIds }),
      ...(safetyIndexSource === undefined ? {} : { safetyIndexSource }),
      createdAt: event.time,
    }
}

/** Shared admission check for ledger and integrity diagnostics. */
export function validCompactionReplacement(summary: SessionEvent, event: SessionEvent): boolean {
  if (summary.type !== 'compaction/summary' || event.type !== 'user/message'
    || typeof event.surfaceOp !== 'object' || event.surfaceOp.op !== 'replace' || summary.seq >= event.seq) return false
  const data = readCompactionSummary(summary)
  const source = event.data.source as { plugin?: string; compactionId?: string }
  if (source.plugin !== 'compact' || source.compactionId !== data.compactionId) return false
  if (data.contextManagement === undefined) return true // legacy ARC protocol
  const sources = new Set(event.sourceEventSeqs ?? [])
  return event.seq === summary.seq + 1 && event.surfaceOp.start === data.shadowedRange.start && event.surfaceOp.end === data.shadowedRange.end
    && sources.has(summary.seq) && data.shadowedSeqs.every(seq => sources.has(SessionSeq(seq)))
}

/** Per-owner append index. New events are consumed once; no source text is cached. */
export class BlockLedgerIndex {
  private offset = 0
  private last: SessionEvent | undefined
  private readonly summaries = new Map<string, SessionEvent>()
  private readonly applied = new Set<string>()
  private entries: ArcBlockLedgerEntry[] = []
  update(events: readonly SessionEvent[]): ArcBlockLedgerEntry[] {
    if (this.offset > events.length || (this.offset > 0 && events[this.offset - 1] !== this.last)) throw new Error('changed: ledger input is not an append-only continuation')
    for (; this.offset < events.length; this.offset++) {
      const event = events[this.offset]!
      if (event.type === 'compaction/summary') {
        const data = readCompactionSummary(event)
        if (!this.summaries.has(data.compactionId)) this.summaries.set(data.compactionId, event)
        continue
      }
      if (event.type !== 'user/message' || typeof event.surfaceOp !== 'object' || event.surfaceOp.op !== 'replace') continue
      const source = event.data.source as { plugin?: string; compactionId?: string }
      if (source.plugin !== 'compact' || !source.compactionId || this.applied.has(source.compactionId)) continue
      const summary = this.summaries.get(source.compactionId)
      if (!summary || !validCompactionReplacement(summary, event)) continue
      this.applied.add(source.compactionId)
      this.entries = [...this.entries, ledgerEntry(events, summary, event.seq)]
    }
    this.last = events[this.offset - 1]
    return this.entries
  }
}

/** Rebuild the block ledger from the durable log (no kernel state needed). */
export function rebuildBlockLedger(events: readonly SessionEvent[]): ArcBlockLedgerEntry[] {
  return new BlockLedgerIndex().update(events)
}

/** Compatibility entry point: the host projection already prices replacements. */
export function compressionAwareProjectedTokens(
  session: Session,
  projectedTokens: number,
  onUnderflow?: (message: string) => void,
): number {
  // DSH 0.1.2-rc.1 folds replacements into projectedTokens already.
  void session
  void onUnderflow
  return projectedTokens
}

/** One self-computed compressible span of the current surface. */
export interface SeqCompressibleRange {
  readonly start: number
  readonly end: number
  readonly count: number
  readonly tokens: number
}

/** Whether a surface user message is a compaction checkpoint node (already compressed). */
function isCheckpointNode(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: { plugin?: string } }).source
  return source?.plugin === 'compact'
}

/**
 * Compute compressible spans directly from the surface — independent of the
 * kernel's ref map, which can drift after surface replacements in long
 * sessions and hide large tool results from the nudge range table. Skips the
 * recent protected tail, the last user message, and compaction checkpoints;
 * edges are then balanced through resolveSurfaceRange. Ranges are ordered by
 * size (largest reclaimed first).
 */
export function buildCompressibleSeqRanges(
  session: Session,
  opts: { preserveRecent?: number; preserveRecentSteps?: number; incomingUser?: import('@deepseek-ai/dsh-llm').UserMessage; includeCheckpoints?: boolean } = {},
): SeqCompressibleRange[] {
  const nodes = session.surface.nodes
  const preserve = opts.preserveRecent ?? 5
  const protectedSeqs = new Set<number>()
  if (opts.preserveRecentSteps !== undefined && opts.preserveRecentSteps > 0) {
    // Step-aligned recency: a fixed node count can split a tool call/result
    // pair at the boundary (the call stays free, the result protected), which
    // makes the pair unshadowable and shrinks every fallback bite — the
    // mechanism behind clustered minimal fallbacks in the 150k iteration.
    // Step boundaries never split pairs, so protect whole trailing steps.
    const events = session.snapshotEvents()
    let boundary = -1
    let steps = 0
    for (let seq = events.length - 1; seq >= 0; seq -= 1) {
      const event = events[seq]
      if (event !== undefined && event.type === 'step/start') {
        steps += 1
        if (steps >= opts.preserveRecentSteps) { boundary = seq; break }
      }
    }
    if (boundary >= 0) {
      for (const seq of nodes) if (seq >= boundary) protectedSeqs.add(seq)
    } else {
      for (const seq of nodes.slice(-preserve)) protectedSeqs.add(seq)
    }
  } else if (preserve > 0) {
    for (const seq of nodes.slice(-preserve)) protectedSeqs.add(seq)
  }
  // The latest on-surface user message is always protected, with or without an
  // incoming admission: an incoming message does NOT make the live surface
  // instruction archivable (the 150k adaptive run died exactly here). Use the
  // seq-correct eventAt lookup — raw snapshotEvents() indexing missed this
  // message on long rebuilt surfaces.
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt(SessionSeq(nodes[index]!))
    if (event?.type === 'user/message' && event.data.source.kind === 'user') {
      protectedSeqs.add(nodes[index]!)
      break
    }
  }
  const raw: SeqCompressibleRange[] = []
  let cur: SeqCompressibleRange | null = null
  const flush = (): void => {
    if (cur !== null) raw.push(cur)
    cur = null
  }
  for (const seq of nodes) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined || protectedSeqs.has(seq) || (!opts.includeCheckpoints && isCheckpointNode(event))) {
      flush()
      continue
    }
    // Surface nodes can be locally out of order after surface replacements in
    // long sessions; a node with a SMALLER seq than the running segment would
    // produce a reversed range (e.g. 110295..106762). Break the segment so
    // ranges always stay start <= end.
    if (!opts.includeCheckpoints && cur !== null && seq < cur.start) {
      flush()
      cur = null
    }
    const tokens = defaultCountTokens(extractEventText(event))
    if (cur === null) {
      cur = { start: seq, end: seq, count: 1, tokens }
    } else {
      cur = { start: cur.start, end: seq, count: cur.count + 1, tokens: cur.tokens + tokens }
    }
  }
  flush()
  const out: SeqCompressibleRange[] = []
  for (const range of raw) {
    try {
      const { start, end } = resolveSurfaceRange(session, range.start, range.end)
      const count = range.count
      out.push({ start, end, count, tokens: range.tokens })
    } catch {
      // Cannot be balanced into a compressible span — skip.
    }
  }
  return out.sort((a, b) => b.tokens - a.tokens)
}

/**
 * A compact human-readable description of the current surface for the model:
 * node count plus the first/last message seqs. Surface seqs are sparse (the
 * event log interleaves non-message events and expanded delta batches), so a
 * model that never saw the nudge range table — e.g. low-pressure sessions
 * where no nudge fires — cannot guess its own seq space. arc_status and the
 * nudge's range table both surface this so compress edges can be located
 * without blind probing.
 */
export function surfaceSummary(session: Session): string {
  const nodes = session.surface.nodes
  if (nodes.length === 0) return 'empty'
  const first = nodes[0]!
  const last = nodes[nodes.length - 1]!
  return `${nodes.length} nodes, seqs ${first}..${last}`
}

/** One block as seen by the tier machinery: durable id ↔ kernel ref (`bN`). */
export interface ArcBlockRegistryEntry {
  /** The durable compaction id. */
  readonly blockId: string
  /** The acp-kernel block ref (`bN`); synthesised by log order for legacy blocks. */
  readonly kernelBlockId: string
  readonly tier: 1 | 2 | 3
  /** The surface seq of this block's checkpoint summary node (null when gone). */
  readonly summarySeq: number | null
  /** True until a LATER block distills this one. Only active blocks are distillable. */
  readonly active: boolean
  readonly parentBlockIds: readonly string[]
}

/**
 * Rebuild the compactionId ↔ kernel-block-ref registry from the durable log.
 * Legacy blocks (pre-tier, no recorded `kernelBlockId`) are synthesised as
 * `b1`, `b2`, … in log order; recorded ids are kept as-is. A block is active
 * until a later block lists it as a parent.
 */
export function blockRegistry(session: Session): ArcBlockRegistryEntry[] {
  const all = rebuildBlockLedger(session.snapshotEvents())
  const ledger = all.filter(entry => entry.contextManagement === undefined)
  const kernelIdOf = new Map<string, string>()
  const raw: ArcBlockRegistryEntry[] = []
  let next = 1
  for (const entry of ledger) {
    let kernelBlockId: string
    if (entry.kernelBlockId !== undefined && /^b\d+$/.test(entry.kernelBlockId)) {
      kernelBlockId = entry.kernelBlockId
      const num = Number(kernelBlockId.slice(1))
      if (Number.isInteger(num)) next = Math.max(next, num + 1)
    } else {
      kernelBlockId = `b${next}`
      next += 1
    }
    kernelIdOf.set(entry.blockId, kernelBlockId)
    raw.push({
      blockId: entry.blockId,
      kernelBlockId,
      tier: entry.tier,
      summarySeq: entry.summarySeq ?? null,
      active: true,
      parentBlockIds: [...entry.parentBlockIds],
    })
  }
  const consumed = new Set<string>()
  for (const entry of all) {
    for (const parent of entry.parentBlockIds) consumed.add(parent)
  }
  return raw.map((entry) => ({
    ...entry,
    active: !consumed.has(entry.blockId),
  }))
}

/**
 * The kernel block ref (`bN`) for a surface seq, when that seq is the
 * checkpoint summary node of a block — the edge the model must use to
 * distill (T2/T3). Active blocks distill; a stale (already-distilled) node
 * still maps to its `bN` so the kernel reports "already compressed" instead
 * of silently folding the summary as a plain message. Returns null for
 * anything else (plain messages, non-checkpoint nodes).
 */
export function blockRefForSummarySeq(session: Session, seq: number): string | null {
  const event = session.snapshotEvents()[seq]
  if (event?.type !== 'user/message') return null
  const source = (event.data as { source?: { plugin?: string; compactionId?: string } }).source
  if (source?.plugin !== 'compact' || source.compactionId === undefined) return null
  const entry = blockRegistry(session).find((r) => r.blockId === source.compactionId)
  if (entry === undefined) return null
  return entry.kernelBlockId
}

/** The durable compaction ids distilled by the given kernel block refs (`bN`). */
export function compactionIdsOfKernelBlocks(session: Session, kernelBlockIds: readonly string[]): string[] {
  if (kernelBlockIds.length === 0) return []
  const byKernel = new Map(blockRegistry(session).map((r) => [r.kernelBlockId, r.blockId]))
  return kernelBlockIds
    .map((id) => byKernel.get(id))
    .filter((id): id is string => id !== undefined)
}

/** The checkpoint summary seq of an ACTIVE kernel block (`bN`), or null. */
export function summarySeqOfKernelBlock(session: Session, kernelBlockId: string): number | null {
  const entry = blockRegistry(session).find((r) => r.kernelBlockId === kernelBlockId)
  return entry?.active ? entry.summarySeq : null
}

/** The durable block whose checkpoint node sits at `seq` (or null). */
function checkpointBlockIdOf(events: readonly SessionEvent[], seq: number): string | null {
  const event = events[seq]
  if (event?.type !== 'user/message') return null
  const source = (event.data as { source?: { plugin?: string; compactionId?: string } }).source
  if (source?.plugin !== 'compact' || source.compactionId === undefined) return null
  return source.compactionId
}

/**
 * The shadowed seqs of a block, recursing into distilled parent blocks: a
 * tier-2 block shadows its parent's checkpoint node, so recovering its
 * originals requires expanding that node into the parent block's own shadowed
 * seqs. Cycle-safe (a block can never be its own ancestor).
 */
export function expandEffectiveSourceSeqs(session: Session, shadowedSeqs: readonly number[]): number[] {
  const sources = resolveSources(session, shadowedSeqs)
  if (sources.incomplete) throw new Error('incomplete-archive: effective source graph is unavailable or corrupt')
  return sources.seqs
}

/** Expand a durable block's direct shadowed nodes to its recursive original sources. */
export function expandShadowedSeqs(session: Session, blockId: string): number[] {
  const root = rebuildBlockLedger(session.snapshotEvents()).find((entry) => entry.blockId === blockId)
  return root === undefined ? [] : expandEffectiveSourceSeqs(session, root.shadowedSeqs)
}
