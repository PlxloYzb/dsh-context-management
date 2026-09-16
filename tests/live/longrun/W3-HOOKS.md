# Observation hooks available to W3

Notes from reading the frozen 0.1.2-rc.1 host and `dsh-context-management` 0.1.1.
They exist so the observer can associate a summary job with a real LLM stream
*explicitly* instead of by time proximity.

## Host event surface (`ctx.on('session/event', (session, event) => ...)`)

- `compaction/start`, `compaction/summary`, `compaction/end` are the native
  compaction lifecycle events.
- A committed ARC window appears as `compaction/summary` whose
  `event.data.contextManagement` carries the `WindowMetadata`:
  `{ schemaVersion: 1, kind: 'window', trigger, fromWindowId, toWindowId,
  generationAfter, parentBlockIds, operationId, windowGeneration, provider,
  model, requestId, ... }` and, when a handoff is carried, `pendingHandoff`.
  `src/window-controller.ts` builds it; `src/region.ts` reads it back.
- `compaction/summary.data.compactionId` is the operation identity used by
  `validWindowMetadata` and by `rebuildBlockLedger`.

## Request surface (`ctx.on('llm/stream', async function* (request, next) {...})`)

- `request.sessionId`, `request.purpose`, `request.provider`, `request.model`,
  `request.maxTokens`, `request.reasoningEffort` are available before dispatch.
- Usage arrives as `chunk.type === 'usage'`; a `finish` chunk carries
  `chunk.reason` and the adapter's replay state.
- `ctx.llm.resolveModelInfo(provider, model)` returns the route's
  `context.contextWindow` and reasoning default, which is what verifies the
  frozen capacity and effective effort.

## Association rule the observer must satisfy

A summary job row may only claim a `streamId` when one of these is true:

1. the plugin's own handoff/prepare path emitted an event carrying the same
   `operationId` **and** the observer saw the corresponding `llm/stream` with a
   summary purpose, or
2. a durable receipt written after the stream names both the operation and the
   stream, or
3. the product's own metadata (`contextManagement.requestId` / `operationId`)
   matches the request that was in flight for that job.

Time proximity, message similarity and "the only stream running" are **not**
acceptable evidence and must be recorded as `associationEvidence: 'unresolved'`
with the job left in `unknown` state rather than guessed.

## Counters the audit reads

- window commits: `session/event` rows with
  `type === 'compaction/summary'` and `data.contextManagement.kind === 'window'`
- pressure-triggered commits: the same rows with a pressure/nudge
  `trigger`
- delivered summaries: `summary-jobs.jsonl` rows with `status === 'delivered'`,
  deduplicated by `operationId`
