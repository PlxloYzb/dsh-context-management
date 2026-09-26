// Real host request/usage/job observer for the muse-longrun-v1 harness.
//
// Cordis plugin. It is strictly passive: it never rewrites a request body, a
// stream chunk or configuration, never reads private settings, and never
// persists credentials or auth headers. It records enough identity to prove
// which logical request, stream and (where available) summary job produced what.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import {
  accountingOf,
  classifyPurpose,
  createUsageLedger,
  normalizeUsageValue,
} from './usage.mjs'

export const inject = ['llm', 'sessions', 'agentPresets', 'tokenMeter', 'sessionProjections']
export const OBSERVER_SCHEMA_VERSION = 1
export const HANDOFF_PLUGIN = 'dsh-context-management/handoff'

const SNAPSHOT_EVENTS = new Set(['turn/end', 'compaction/summary', 'compaction/end', 'session/end-seed', 'model/selection', 'command/done'])

export { accountingOf, classifyPurpose }

export function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')
}

/** Owned-session predicate, identical in behaviour to the short harness by default. */
/**
 * Job statuses that mean the product still owns the preparation. Anything else
 * the product reports (superseded, stale, timeout, oversize, no-net-reduction,
 * invalid-output, ...) is a terminal reason we must record rather than drop.
 */
export const ACTIVE_JOB_STATUSES = Object.freeze(['pending', 'ready', 'delivering'])

/**
 * Decide what terminal event a job-status observation implies.
 *
 * The product cancels a prepared job with a reason that becomes the job status,
 * and a superseding prepare replaces the job outright. Both end a preparation
 * that had already started, so both must leave a durable record; the previous
 * ledger only wrote `started` rows and silently lost the outcome.
 *
 * @param previous - last observation for this session, or null.
 * @param current - current observation, or null when the product reports none.
 * @returns the termination record to append, or null when nothing changed.
 */
export function jobTerminationOf(previous, current) {
  if (!previous || !ACTIVE_JOB_STATUSES.includes(previous.status)) return null
  const sameJob = current !== null && current !== undefined && current.operationId === previous.operationId
  if (sameJob && ACTIVE_JOB_STATUSES.includes(current.status)) return null
  // A different operation replacing an active one, or the job disappearing
  // entirely, both happen when a window-modifying operation supersedes it; the
  // product exposes no reason in that path, so the record says exactly that.
  const terminationReason = sameJob ? current.status : 'cleared-without-terminal-record'
  return { operationId: previous.operationId, lastActiveStatus: previous.status, terminationReason }
}

export function ownedSession(session, marker = 'dsh-context-experiment-') {
  return String(session?.header?.cwd ?? '').includes(marker)
}

/**
 * Whether a source identifies one of our context handoffs.
 *
 * DSH 0.1.7 removed the generic `plugin` source kind: each producer declares its
 * own kind through a `MessageSourceMap` augmentation, and the plugin writes
 * `kind: 'context-management'` with the same `plugin` field. The 0.1.2 spelling
 * (`kind: 'plugin'`) is kept because the harness still supports that pin.
 */
export function isHandoffSource(source) {
  if (!source || source.plugin !== HANDOFF_PLUGIN) return false
  return source.kind === 'context-management' || source.kind === 'plugin'
}

/** Read the ARC handoff receipt carried by a plugin user/message event. */
export function handoffReceipt(event) {
  if (!event || event.type !== 'user/message') return null
  const source = event.data?.source
  if (!isHandoffSource(source)) return null
  return source.handoff ?? null
}

/** Operation ids of handoffs actually present in an assembled request. */
export function handoffOperationIds(messages) {
  const ids = new Set()
  for (const message of messages ?? []) {
    const source = message?.source
    if (isHandoffSource(source) && source.handoff?.operationId) ids.add(source.handoff.operationId)
  }
  return ids
}

function readRunId(output) {
  for (const candidate of [join(output, 'run.json'), join(dirname(output), 'run.json')]) {
    try {
      const value = JSON.parse(readFileSync(candidate, 'utf8'))
      if (value?.runId) return value.runId
    } catch {
      /* try the next location */
    }
  }
  return null
}

function routeString(provider, model) {
  if (!provider && !model) return null
  return `${provider ?? ''}\u0000${model ?? ''}`
}

export function apply(ctx, config = {}) {
  if (!config.output) throw new Error('observer requires config.output')
  const output = resolve(config.output)
  const eventRoot = resolve(config.eventRoot ?? output)
  const usageRoot = resolve(config.usageRoot ?? output)
  const jobRoot = resolve(config.jobRoot ?? output)
  for (const directory of [output, eventRoot, usageRoot, jobRoot]) mkdirSync(directory, { recursive: true })

  const runId = config.runId ?? readRunId(output)
  const route = config.route ?? null
  const purposePolicy = config.purposePolicy ?? {}
  // The long-run host runs in `<runRoot>/model-cwd`, so the driver patch passes
  // `sessionMarker: 'model-cwd'`. The default stays the short-harness marker.
  const sessionMarker = config.sessionMarker ?? 'dsh-context-experiment-'
  const owned = session => ownedSession(session, sessionMarker)
  const ledger = createUsageLedger({
    file: join(usageRoot, 'usage.jsonl'),
    runId,
    semantics: config.usageSemantics ?? 'cumulative',
    perCallConservativeReserve: Number.isFinite(config.perCallConservativeReserve) ? config.perCallConservativeReserve : null,
  })
  const requestsPath = join(output, 'requests.jsonl')
  const jobsPath = join(jobRoot, 'summary-jobs.jsonl')
  const appendRequests = row => appendFileSync(requestsPath, JSON.stringify(row) + '\n', { mode: 0o600 })
  const appendJob = row => appendFileSync(jobsPath, JSON.stringify(row) + '\n', { mode: 0o600 })
  const now = () => new Date().toISOString()

  const agentsBySession = new Map()
  const compactionStreams = new Map() // sessionId -> [{ streamId, provider, model, maxTokens, operationId }]
  const jobStreams = new Map() // operationId -> { streamId, startedAt, readyAt }
  const awaitingConsumption = new Map() // operationId -> { sessionId, deliveredAt, streamId }
  const openCompactions = new Map() // sessionId -> { compactionId, seq, provider, model, maxTokens, shadowedSeqs }
  const retryPending = new Map() // sessionId -> { retry, provider, failure }
  const observedSessions = new Set()
  const jobStatusSeen = new Map() // sessionId -> { operationId, status }
  // Status is polled only at boundaries that can observe a cancellation, so the
  // watcher stays cheap on long transcripts.
  const JOB_STATUS_EVENTS = new Set(['turn/end', 'step/end', 'compaction/summary', 'compaction/end', 'user/message'])

  const snapshot = session => {
    if (typeof session?.snapshotEvents !== 'function') return
    try {
      writeFileSync(join(eventRoot, `${session.id}.events.json`), JSON.stringify(session.snapshotEvents()), { mode: 0o600 })
      observedSessions.add(session.id)
    } catch {
      /* a snapshot is an advisory checkpoint; the JSONL stream is the source of truth */
    }
  }

  // --- summary job association -------------------------------------------------
  // Explicit evidence only. Time proximity is never used: the association comes
  // from the product job object that dispatched this exact stream, a durable
  // compaction/start event, or a durable handoff receipt.
  const productJobStatus = session => {
    const agent = agentsBySession.get(session.id)
    if (!agent) return null
    try {
      const service = ctx.agentPresets?.serviceFor?.(agent, 'compaction')
      const status = service?.summaries?.status?.(session)
      if (status && status.operationId) return { status, kind: 'product-metadata', source: 'agentPresets.serviceFor(agent,"compaction").summaries.status(session)' }
    } catch {
      return null
    }
    return null
  }
  const openCompactionStatus = session => {
    const open = openCompactions.get(session.id)
    if (!open) return null
    return {
      status: { status: 'pending', operationId: open.compactionId, sourceSeqs: open.shadowedSeqs ?? null, sourceHash: null, provider: open.provider ?? null, model: open.model ?? null, maxTokens: open.maxTokens ?? null, startedAt: open.startedAt ?? null },
      kind: 'plugin-event',
      source: `session/event:compaction/start@${open.seq}`,
    }
  }
  const bindReceiptStream = (sessionId, receipt) => {
    const candidates = (compactionStreams.get(sessionId) ?? []).filter(stream => (stream.operationId === undefined || stream.operationId === receipt.operationId))
    const routeMatches = candidates.filter(stream => (!receipt.provider || stream.provider === receipt.provider) && (!receipt.model || stream.model === receipt.model))
    const pool = routeMatches.length === 1 ? routeMatches : candidates.length === 1 ? candidates : []
    if (pool.length !== 1) return null
    const stream = pool[0]
    stream.operationId = receipt.operationId
    jobStreams.set(receipt.operationId, { streamId: stream.streamId, startedAt: null, readyAt: null })
    return stream.streamId
  }
  // Rule 3 of W3-HOOKS: a committed ARC window carries the product's own
  // `contextManagement.operationId`; when it matches an in-flight summary
  // stream's route it is explicit product metadata, never a guess.
  const bindWindowMetadata = (sessionId, data) => {
    const metadata = data?.contextManagement
    const operationId = metadata?.operationId ?? data?.compactionId ?? null
    if (!operationId || jobStreams.has(operationId)) return null
    const candidates = (compactionStreams.get(sessionId) ?? []).filter(stream => !stream.operationId)
    const routeMatches = candidates.filter(stream => (!metadata?.provider || stream.provider === metadata.provider) && (!metadata?.model || stream.model === metadata.model))
    const pool = routeMatches.length === 1 ? routeMatches : candidates.length === 1 ? candidates : []
    if (pool.length !== 1) return null
    const stream = pool[0]
    stream.operationId = operationId
    jobStreams.set(operationId, { streamId: stream.streamId, startedAt: null, readyAt: null })
    return { operationId, streamId: stream.streamId, metadata }
  }

  const progressPath = config.progressPath ?? purposePolicy.progressPath ?? join(dirname(output), 'progress.json')
  let progressCache = { mtimeMs: -1, currentPurpose: null }
  const driverPurpose = () => {
    try {
      const info = statSync(progressPath)
      if (info.mtimeMs !== progressCache.mtimeMs) {
        const value = JSON.parse(readFileSync(progressPath, 'utf8'))
        progressCache = { mtimeMs: info.mtimeMs, currentPurpose: typeof value?.currentPurpose === 'string' && value.currentPurpose ? value.currentPurpose : null }
      }
    } catch {
      return null
    }
    return progressCache.currentPurpose
  }

  // --- event capture -----------------------------------------------------------
  ctx.on('session/created', session => {
    if (owned(session)) snapshot(session)
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent
    if (owned(agent?.session)) agentsBySession.set(agent.session.id, agent)
    if (typeof next === 'function') return next()
    return undefined
  })

  ctx.on('session/event', (session, event) => {
    if (!owned(session) || !event) return
    // Incremental capture: every event is appended; snapshots only at boundaries.
    appendFileSync(join(eventRoot, `${session.id}.events.jsonl`), JSON.stringify(event) + '\n', { mode: 0o600 })
    if (SNAPSHOT_EVENTS.has(event.type)) snapshot(session)

    if (JOB_STATUS_EVENTS.has(event.type)) {
      const seen = jobStatusSeen.get(session.id) ?? null
      let current = null
      try {
        const observed = productJobStatus(session)?.status ?? null
        if (observed?.operationId) current = { operationId: observed.operationId, status: observed.status }
      } catch { current = null }
      const termination = jobTerminationOf(seen, current)
      if (termination) {
        appendJob({
          schemaVersion: OBSERVER_SCHEMA_VERSION,
          runId,
          phase: 'termination',
          time: now(),
          sessionId: session.id,
          operationId: termination.operationId,
          streamId: jobStreams.get(termination.operationId)?.streamId ?? null,
          sourceSeqs: null,
          sourceHash: null,
          sourceGeneration: null,
          targetGeneration: null,
          route: null,
          status: termination.terminationReason,
          startedAt: null,
          readyAt: null,
          offeredAt: null,
          receiptSeq: null,
          deliveredAt: null,
          consumedByRequestId: null,
          terminationReason: termination.terminationReason,
          lastActiveStatus: termination.lastActiveStatus,
          associationEvidence: {
            kind: 'product-metadata',
            source: 'agentPresets.serviceFor(agent,"compaction").summaries.status(session)',
            operationId: termination.operationId,
            matchedFields: ['sessionId', 'operationId'],
          },
        })
      }
      if (current) jobStatusSeen.set(session.id, current)
      else jobStatusSeen.delete(session.id)
    }

    if (event.type === 'llm/retry') {
      retryPending.set(session.id, { retry: event.data?.retry ?? null, provider: event.data?.provider ?? null, failure: event.data?.failure ?? null })
    }
    if (event.type === 'compaction/start') {
      openCompactions.set(session.id, { compactionId: event.data?.compactionId ?? null, seq: event.seq ?? null, provider: null, model: null, maxTokens: null, shadowedSeqs: null, startedAt: now() })
    }
    if (event.type === 'compaction/summary') {
      const open = openCompactions.get(session.id)
      if (open && open.compactionId === event.data?.compactionId) {
        open.provider = event.data?.provider ?? null
        open.model = event.data?.model ?? null
        open.maxTokens = event.data?.maxTokens ?? null
        open.shadowedSeqs = event.data?.shadowedSeqs ?? null
      }
      const bound = bindWindowMetadata(session.id, event.data)
      if (bound) {
        appendJob({
          schemaVersion: OBSERVER_SCHEMA_VERSION,
          runId,
          phase: 'associated',
          time: event.time ?? now(),
          sessionId: session.id,
          operationId: bound.operationId,
          streamId: bound.streamId,
          sourceSeqs: event.data?.shadowedSeqs ?? event.data?.contextManagement?.parentBlockIds ?? null,
          sourceHash: event.data?.contextManagement?.sourceHash ?? null,
          sourceGeneration: event.data?.contextManagement?.fromWindowId ?? null,
          targetGeneration: event.data?.contextManagement?.generationAfter ?? event.data?.contextManagement?.windowGeneration ?? null,
          route: routeString(event.data?.provider ?? bound.metadata?.provider, event.data?.model ?? bound.metadata?.model),
          routeProvider: event.data?.provider ?? bound.metadata?.provider ?? null,
          routeModel: event.data?.model ?? bound.metadata?.model ?? null,
          status: 'committed-window',
          startedAt: null,
          readyAt: null,
          offeredAt: null,
          receiptSeq: event.seq ?? null,
          deliveredAt: null,
          consumedByRequestId: null,
          terminationReason: null,
          associationEvidence: {
            kind: 'product-metadata',
            source: 'session/event:compaction/summary.data.contextManagement.operationId',
            streamId: bound.streamId,
            operationId: bound.operationId,
            matchedFields: ['operationId', 'provider', 'model', 'windowGeneration'],
          },
        })
      }
    }
    if (event.type === 'compaction/end') {
      const open = openCompactions.get(session.id)
      if (open && open.compactionId === event.data?.compactionId) openCompactions.delete(session.id)
    }

    const receipt = handoffReceipt(event)
    if (receipt?.operationId) {
      const known = jobStreams.get(receipt.operationId) ?? null
      const streamId = known?.streamId ?? bindReceiptStream(session.id, receipt)
      const status = receipt.status ?? 'unknown'
      const time = event.time ?? now()
      appendJob({
        schemaVersion: OBSERVER_SCHEMA_VERSION,
        runId,
        phase: 'receipt',
        time,
        sessionId: session.id,
        operationId: receipt.operationId,
        streamId: streamId ?? null,
        sourceSeqs: receipt.sourceSeqs ?? null,
        sourceHash: receipt.sourceHash ?? null,
        sourceGeneration: receipt.sourceGeneration ?? null,
        targetGeneration: receipt.windowGeneration ?? null,
        route: routeString(receipt.provider, receipt.model),
        routeProvider: receipt.provider ?? null,
        routeModel: receipt.model ?? null,
        status,
        startedAt: known?.startedAt ?? null,
        readyAt: known?.readyAt ?? null,
        offeredAt: status === 'pending' ? time : null,
        receiptSeq: event.seq ?? null,
        deliveredAt: status === 'delivered' ? time : null,
        consumedByRequestId: null,
        terminationReason: receipt.reason ?? null,
        associationEvidence: {
          kind: 'receipt',
          receiptSeq: event.seq ?? null,
          eventType: 'user/message',
          sourcePlugin: HANDOFF_PLUGIN,
          streamId: streamId ?? null,
          matchedFields: streamId
            ? ['operationId', 'sourceHash', 'provider', 'model', 'streamId']
            : ['operationId', 'sourceHash'],
        },
      })
      if (status === 'delivered') awaitingConsumption.set(receipt.operationId, { sessionId: session.id, deliveredAt: time, streamId: streamId ?? null, receiptSeq: event.seq ?? null })
    }
    if (handoffReceipt(event)) snapshot(session)
  })

  // --- request observation -----------------------------------------------------
  ctx.on('llm/stream', async function* (request, next) {
    const session = request?.sessionId ? ctx.sessions.get(request.sessionId) : undefined
    if (!owned(session)) throw new Error('Experiment observer refuses unattributed generation in its isolated host')

    const logicalRequestId = randomUUID()
    const streamId = randomUUID()
    const attemptId = request.attemptId ?? 'unknown'
    const callId = `${logicalRequestId}:${attemptId}`
    const startedAtMs = Date.now()
    let info = null
    let modelInfoError = null
    try {
      info = await ctx.llm.resolveModelInfo(request.provider, request.model)
    } catch (error) {
      modelInfoError = String(error?.message ?? error)
    }
    const effectiveEffort = request.reasoningEffort ?? info?.reasoning?.defaultEffort ?? null
    const contextWindow = info?.context?.contextWindow ?? null
    const routeInvariant = {
      ok: true,
      problems: [],
    }
    if (route) {
      if (route.provider !== undefined && request.provider !== route.provider) routeInvariant.problems.push(`provider ${request.provider} != ${route.provider}`)
      if (route.model !== undefined && request.model !== route.model) routeInvariant.problems.push(`model ${request.model} != ${route.model}`)
      if (route.reasoningEffort !== undefined && effectiveEffort !== route.reasoningEffort) routeInvariant.problems.push(`effort ${effectiveEffort} != ${route.reasoningEffort}`)
    }
    if (config.expectedContextWindow !== undefined && contextWindow !== config.expectedContextWindow) routeInvariant.problems.push(`contextWindow ${contextWindow} != ${config.expectedContextWindow}`)
    routeInvariant.ok = routeInvariant.problems.length === 0

    // Purpose: the host's own purpose wins; otherwise the driver's durable
    // `progress.json.currentPurpose` (product metadata) supplies work vs
    // sentinel vs final-probe. Never inferred from timing or message text.
    const rawPurpose = request.purpose ?? null
    const driverCurrentPurpose = rawPurpose === null ? driverPurpose() : null
    const effectivePurpose = rawPurpose ?? driverCurrentPurpose ?? 'agent'
    const purpose = rawPurpose ?? 'agent'
    const purposeSource = rawPurpose !== null ? 'request' : driverCurrentPurpose !== null ? 'driver-progress' : 'default-agent'
    const purposeClass = classifyPurpose(effectivePurpose, purposePolicy)
    let retryObserved = false
    let retryFailure = null
    const pendingRetry = retryPending.get(session.id)
    if (pendingRetry && (!pendingRetry.provider || pendingRetry.provider === request.provider)) {
      retryObserved = true
      retryFailure = pendingRetry.failure
      retryPending.delete(session.id)
    }
    const accountingClass = accountingOf({ purposeClass, retry: retryObserved, failed: false, cancelled: false })
    const stopFilePresent = config.stopFile ? existsSync(config.stopFile) : false

    let jobAssociation = null
    if (request.purpose === 'compaction' || purposeClass === 'background-summary') {
      const found = productJobStatus(session) ?? openCompactionStatus(session)
      if (found) {
        const job = found.status
        const matchedFields = found.kind === 'product-metadata'
          ? ['sessionId', 'purpose', 'operationId', 'sourceHash', 'provider', 'model', 'maxTokens']
          : ['sessionId', 'purpose', 'compaction/start', 'provider', 'model']
        jobAssociation = {
          operationId: job.operationId,
          streamId,
          logicalRequestId,
          sourceSeqs: job.sourceSeqs ?? null,
          sourceHash: job.sourceHash ?? null,
          throughSeq: job.throughSeq ?? null,
          sourceGeneration: job.replaceGeneration ?? job.sourceGeneration ?? null,
          targetGeneration: job.targetGeneration ?? null,
          route: routeString(job.provider ?? request.provider, job.model ?? request.model),
          status: job.status ?? 'pending',
          startedAt: Number.isFinite(job.startedAt) ? new Date(job.startedAt).toISOString() : null,
          readyAt: Number.isFinite(job.readyAt) ? new Date(job.readyAt).toISOString() : null,
          associationEvidence: {
            kind: found.kind,
            source: found.source,
            streamId,
            operationId: job.operationId,
            matchedFields,
          },
        }
        jobStreams.set(job.operationId, { streamId, startedAt: jobAssociation.startedAt, readyAt: jobAssociation.readyAt, provider: request.provider, model: request.model })
        const list = compactionStreams.get(session.id) ?? []
        if (!list.some(entry => entry.streamId === streamId)) list.push({ streamId, provider: request.provider, model: request.model, maxTokens: request.maxTokens ?? null, operationId: job.operationId })
        compactionStreams.set(session.id, list)
        appendJob({
          schemaVersion: OBSERVER_SCHEMA_VERSION,
          runId,
          phase: 'started',
          time: now(),
          sessionId: session.id,
          operationId: jobAssociation.operationId,
          streamId,
          logicalRequestId,
          sourceSeqs: jobAssociation.sourceSeqs,
          sourceHash: jobAssociation.sourceHash,
          throughSeq: jobAssociation.throughSeq,
          sourceGeneration: jobAssociation.sourceGeneration,
          targetGeneration: jobAssociation.targetGeneration,
          route: jobAssociation.route,
          routeProvider: request.provider,
          routeModel: request.model,
          status: jobAssociation.status,
          startedAt: jobAssociation.startedAt,
          readyAt: jobAssociation.readyAt,
          offeredAt: null,
          receiptSeq: null,
          deliveredAt: null,
          consumedByRequestId: null,
          terminationReason: null,
          associationEvidence: jobAssociation.associationEvidence,
        })
      } else {
        const list = compactionStreams.get(session.id) ?? []
        list.push({ streamId, provider: request.provider, model: request.model, maxTokens: request.maxTokens ?? null })
        compactionStreams.set(session.id, list)
        appendJob({
          schemaVersion: OBSERVER_SCHEMA_VERSION,
          runId,
          phase: 'started',
          time: now(),
          sessionId: session.id,
          operationId: null,
          streamId,
          logicalRequestId,
          sourceSeqs: null,
          sourceHash: null,
          throughSeq: null,
          sourceGeneration: null,
          targetGeneration: null,
          route: routeString(request.provider, request.model),
          routeProvider: request.provider,
          routeModel: request.model,
          status: 'unknown',
          startedAt: null,
          readyAt: null,
          offeredAt: null,
          receiptSeq: null,
          deliveredAt: null,
          consumedByRequestId: null,
          terminationReason: null,
          associationEvidence: {
            kind: 'unresolved',
            reason: 'no-product-metadata-and-no-open-compaction-event',
            streamId,
            matchedFields: [],
          },
        })
      }
    }

    const base = {
      schemaVersion: OBSERVER_SCHEMA_VERSION,
      runId,
      callId,
      logicalRequestId,
      streamId,
      attemptId,
      sessionId: session.id,
      seq: session.seq ?? null,
      purpose,
      driverPurpose: driverCurrentPurpose,
      purposeSource,
      purposeClass,
      accountingClass,
      provider: request.provider ?? null,
      model: request.model ?? null,
      effectiveEffort,
      effectiveReasoningEffort: effectiveEffort,
      maxTokens: request.maxTokens ?? null,
      contextWindow,
      systemHash: sha256Json(request.system ?? null),
      toolsHash: sha256Json(request.tools ?? null),
      messagesHash: sha256Json(request.messages ?? null),
      tools: request.tools?.map(tool => tool.name) ?? [],
      messageCount: request.messages?.length ?? 0,
      routeInvariant,
      modelInfoError,
      retryObserved,
      retryFailure: retryFailure ? { code: retryFailure.code ?? null, status: retryFailure.status ?? null } : null,
      stopFilePresent,
      jobAssociation: jobAssociation ? { operationId: jobAssociation.operationId, kind: jobAssociation.associationEvidence.kind, streamId } : null,
      associationEvidence: jobAssociation?.associationEvidence ?? null,
    }
    const ids = { schemaVersion: OBSERVER_SCHEMA_VERSION, runId, callId, logicalRequestId, streamId, attemptId, sessionId: session.id }
    const dispatchedAt = now()
    appendRequests({ ...ids, phase: 'dispatched', time: dispatchedAt, dispatchedAt, dispatchedAtMs: startedAtMs, purpose, purposeClass, purposeSource, accountingClass, provider: base.provider, model: base.model, effectiveEffort, effectiveReasoningEffort: effectiveEffort, maxTokens: base.maxTokens, contextWindow })
    ledger.recordReservation({ ...base, dispatchedAt, dispatchedAtMs: startedAtMs })

    // Content-based consumption proof: a delivered handoff is consumed only
    // when the exact operationId appears in a later assembled foreground request.
    const presentHandoffs = handoffOperationIds(request.messages)
    for (const operationId of presentHandoffs) {
      const pending = awaitingConsumption.get(operationId)
      if (!pending) continue
      awaitingConsumption.delete(operationId)
      appendJob({
        schemaVersion: OBSERVER_SCHEMA_VERSION,
        runId,
        phase: 'consumed',
        time: now(),
        sessionId: session.id,
        operationId,
        streamId: pending.streamId,
        sourceSeqs: null,
        sourceHash: null,
        sourceGeneration: null,
        targetGeneration: null,
        route: routeString(request.provider, request.model),
        status: 'consumed',
        startedAt: null,
        readyAt: null,
        offeredAt: null,
        receiptSeq: pending.receiptSeq ?? null,
        deliveredAt: pending.deliveredAt,
        consumedByRequestId: logicalRequestId,
        consumedByStreamId: streamId,
        terminationReason: null,
        associationEvidence: {
          kind: 'message-content',
          streamId: pending.streamId,
          consumedByStreamId: streamId,
          matchedFields: ['source.plugin', 'source.handoff.operationId', 'logicalRequestId'],
        },
      })
    }
    if (purposeClass === 'main-foreground') {
      for (const [operationId, pending] of [...awaitingConsumption]) {
        if (pending.sessionId !== session.id || presentHandoffs.has(operationId)) continue
        awaitingConsumption.delete(operationId)
        appendJob({
          schemaVersion: OBSERVER_SCHEMA_VERSION,
          runId,
          phase: 'unconsumed',
          time: now(),
          sessionId: session.id,
          operationId,
          streamId: pending.streamId,
          sourceSeqs: null,
          sourceHash: null,
          sourceGeneration: null,
          targetGeneration: null,
          route: routeString(request.provider, request.model),
          status: 'delivered-unconsumed',
          startedAt: null,
          readyAt: null,
          offeredAt: null,
          receiptSeq: pending.receiptSeq ?? null,
          deliveredAt: pending.deliveredAt,
          consumedByRequestId: null,
          consumedByStreamId: streamId,
          terminationReason: 'delivered-not-consumed',
          associationEvidence: {
            kind: 'message-content-absent',
            streamId: pending.streamId,
            examinedByStreamId: streamId,
            matchedFields: ['logicalRequestId', 'request.messages.handoff-absent'],
          },
        })
      }
    }

    let terminal = false
    let firstContentMs = null
    let terminalAt = null
    let terminalReason = null
    let failureMessage = null
    let lastRawUsage = null
    let lastNormalized = { known: false, rule: 'missing-usage', normalized: null }
    let usageChunkCount = 0

    try {
      for await (const chunk of next()) {
        if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta' || chunk.type === 'tool-call-delta') {
          if (firstContentMs === null) {
            firstContentMs = Date.now() - startedAtMs
            appendRequests({ ...ids, phase: 'first-content', time: now(), firstContentMs, firstContentAt: now() })
          }
        }
        if (chunk.type === 'usage') {
          usageChunkCount += 1
          lastRawUsage = chunk.usage ?? null
          lastNormalized = ledger.recordChunk({ ...base, dispatchedAt, dispatchedAtMs: startedAtMs, chunkIndex: usageChunkCount }, chunk.usage ?? null)
          appendRequests({
            ...ids,
            phase: 'usage',
            time: now(),
            chunkIndex: usageChunkCount,
            usageRaw: chunk.usage ?? null,
            usageNormalized: lastNormalized.normalized,
            usageRule: lastNormalized.rule,
            usageKnown: lastNormalized.known,
          })
        }
        if (chunk.type === 'finish') {
          terminal = true
          terminalAt = now()
          terminalReason = chunk.reason?.kind ?? chunk.reason ?? 'unknown'
          appendRequests({ ...ids, phase: 'finish', time: terminalAt, endedAtMs: Date.now(), elapsedMs: Date.now() - startedAtMs, reason: chunk.reason ?? null, firstContentMs, terminalState: 'succeeded' })
        }
        yield chunk
      }
    } catch (error) {
      failureMessage = String(error?.message ?? error)
      appendRequests({ ...ids, phase: 'incomplete-stream', time: now(), endedAtMs: Date.now(), elapsedMs: Date.now() - startedAtMs, error: failureMessage, firstContentMs, terminalState: 'failed' })
      throw error
    } finally {
      if (!terminal && !failureMessage) {
        terminalAt = now()
        appendRequests({ ...ids, phase: 'incomplete-stream', time: terminalAt, endedAtMs: Date.now(), elapsedMs: Date.now() - startedAtMs, firstContentMs, terminalState: 'incomplete' })
      }
      const terminalState = failureMessage ? 'failed' : terminal ? 'succeeded' : 'incomplete'
      const finalAccounting = accountingOf({ purposeClass, retry: retryObserved, failed: failureMessage !== null, cancelled: false, terminalState })
      const finalNormalized = usageChunkCount > 0
        ? normalizeUsageValue(lastRawUsage)
        : { known: false, rule: 'missing-usage', normalized: null }
      ledger.recordNormalized({
        ...base,
        accountingClass: finalAccounting,
        terminalState,
        terminalReason: terminalReason ?? (failureMessage ? 'error' : 'incomplete-stream'),
        dispatchedAt,
        dispatchedAtMs: startedAtMs,
        endedAtMs: Date.now(),
        elapsedMs: Date.now() - startedAtMs,
        firstContentMs,
        usageChunkCount,
      }, finalNormalized)
      appendRequests({
        ...base,
        phase: 'terminal',
        time: terminalAt ?? now(),
        dispatchedAt,
        dispatchedAtMs: startedAtMs,
        firstContentAt: firstContentMs === null ? null : new Date(startedAtMs + firstContentMs).toISOString(),
        firstContentMs,
        endedAtMs: Date.now(),
        elapsedMs: Date.now() - startedAtMs,
        terminalState,
        terminalReason: terminalReason ?? (failureMessage ? 'error' : 'incomplete-stream'),
        usageChunkCount,
        usageRaw: lastRawUsage,
        usageNormalized: finalNormalized.normalized,
        usageRule: finalNormalized.known ? finalNormalized.rule : (finalNormalized.rule ?? 'missing-usage'),
        usageKnown: finalNormalized.known,
        accountingClass: finalAccounting,
        error: failureMessage,
      })
    }
  })

  return {
    writerId: ledger.writerId,
    paths: { output, eventRoot, usageRoot, jobRoot, requestsPath, jobsPath, usagePath: ledger.path },
    close() {
      ledger.close()
    },
  }
}
