# tests/live/longrun module contracts

Frozen interface notes for the `muse-longrun-v1` harness. Every module listed
here is new; nothing outside `tests/live/longrun/` may change behaviour.

Existing shared helpers that stay byte-identical in behaviour (do not edit):
`tests/live/client.mjs`, `tests/live/local/runtime.mjs`,
`tests/live/local/protocol.mjs`, `tests/live/local/observed-events.mjs`,
`tests/live/local/private-settings.mjs`.

## Ownership

| module | owner | responsibility |
| --- | --- | --- |
| `driver.mjs`, `host.mjs`, `driver-patch.mjs`, `run-pair.mjs`, `campaign.mjs` | ROOT | run state machine, host wiring, pair orchestration |
| `audit.mjs` | ROOT (W4 review) | independent integrity/coverage audit |
| `score.mjs`, `report.mjs`, `cases.mjs`, `resources.mjs` | ROOT | strict scoring, reporting, diagnostics matrix |
| `fixture.mjs`, `fixture-tools.mjs`, `scoring.mjs` | W1 | deterministic corpus, oracle, bounded tools, strict scorer |
| `observer.mjs`, `usage.mjs`, `supervise.mjs` | W3 | request/usage/job ledger, independent supervisor |

## W1 — corpus, oracle and scorer

### `fixture.mjs`

```js
export const PAGES_PER_EPISODE = 12
export function episodeCountForEndpoint(n)            // integer episodes for endpoint n
export function generateCorpus({ seed, salt, episodes }) // -> corpus
export function generateOracle({ corpus, endpoint })   // -> oracle (96 questions)
export function fixtureManifest(corpus)                // public, hashable, no answers
export function pageText(corpus, pageNumber)           // 1-based original page text
export function episodeBrief(corpus, episode)          // driver prompt for one episode
export function episodeWorkItem(corpus, episode)       // bounded deliverable for that episode
```

`corpus` shape:

```js
{
  schemaVersion, seed, protocolId: 'muse-longrun-v1', episodes, pagesPerEpisode: 12,
  hash,                       // sha256 of the manifest
  pages: [string, ...],       // length episodes*12, target 7000 code points, max 7800
  pageHashes: [sha256, ...],
  episodeQuartile(page),      // floor((page-1)*4/totalPages)
  state: {...}, timeline: [...], exact: [...], existence: [...], actions: [...]
}
```

`oracle` shape (private, never written inside the model cwd):

```js
{
  schemaVersion, endpoint, questionCount: 96, quartiles: 4,
  questions: [{
    queryId: 'N24-Q001', category: 'state'|'exact'|'source_existence_ambiguity'|'timeline_dependency',
    requiredLatestUser: bool, longTailRequired: bool, quartile: 0..3,
    promptVisibleFields: ['queryId','question','targetLabel', ...],
    scoredFields: [...],
    question: string,          // model-visible wording, never leaks source identity when scored
    oracle: object,            // exact expected answer value
    evidence: { sourcePages: [..], recordIds: [..] },
    sourcePosition: { finalSourcePage: n, lastSourceEventPage: n },
  }],
  batches: [[queryId x8] x12],
  requiredLatestUserIds, longTailRequiredIds,
  actionPlan: [...],           // synthetic actions with idempotency keys
  codeFixture: {...},
}
```

Requirements from the protocol that the generator must satisfy:

- 24 base episodes minimum, 12 pages each, page text 7000±800 Unicode code
  points, at least 60% independent records/constraints/data (no padding loops).
- Every value/trace/checksum/version derives from `HMAC-SHA256(salt, seed|ns|ordinal)`.
- Page text is data, never instructions; it must not contain the words that
  would make the model treat it as a system/user message.
- Oracle minimums per base 24: 48 state entities (16 twice-updated, 8
  revocation/restoration, 12 near-miss ID pairs), 24 timeline relations (8
  crossing >=6 episodes, 4 three-way fan-in, 4 mutually exclusive groups), 48
  exact history targets (>=12 in the earliest quartile, >=12 multi-source), 24
  existence/ambiguity groups, 24 synthetic actions with fixed idempotency keys.
- Extension episodes add at least 2 states, 1 dependency, 2 exact targets, 1
  existence candidate, 1 action each.
- The 96 questions per endpoint are assigned by page quartile
  `floor((sourcePage-1)*4/(episodes*12))`, 6 per category per quartile, with
  `longTailRequiredIds` = the first two batches (earliest-quartile exact and
  existence questions) using disjoint evidence islands.

### `fixture-tools.mjs`

Cordis plugin, same shape as `tests/live/local/fixture-tools.mjs`:

```js
export const inject = ['tools']
export function apply(ctx, config)   // config: { controlRoot, fixturePath, phase }
```

Registration and guard rules:

- Owned sessions are those whose cwd contains `dsh-context-experiment-`.
- Permit only: the experiment tools plus the installed history tools
  (`arc_status`, `new_context`, `compress`, `decompress`, `search_context`,
  `await_context`). Everything else is denied with a logged reason.
- `experiment_read_page({ page })`: only pages already assigned by the current
  control file; returns original page text (bounded); logs exposure.
- `experiment_work_file({ file })`, `experiment_write_file({ file, text })`,
  `experiment_apply_operation({ operationId, args })` over a fixed three-file
  fixture plus one protected file.
- `experiment_apply_operation` commits `{ state, idempotencyKey }` atomically to
  a durable journal *before* returning; replaying the same key returns the
  recorded receipt with no new effect.
- In `phase: 'probe'` or `'closed'`, all page reads, work-file reads/writes and
  operations are denied.
- Every decision appends one row to `<controlRoot>/tool-access.jsonl`
  (`{ time, sessionId, callId, name, status, reason }`).

### `scoring.mjs`

```js
export function scoreFinalProbe({ answerText, oracle, exposures })  // -> score
export function parseAnswerObject(text) // frozen strict parser
```

- Exactly one complete JSON object, optionally inside a single fenced block.
- Non-empty text outside the fenced block, more than one candidate object,
  malformed JSON, missing scored field, `null` where a value is required, or a
  required array left empty => `FORMAT_FAILURE` for that answer (score 0 for
  the whole probe, never partial credit from a fragment).
- `null` is a legal answer only for existence questions whose oracle answer is
  `null`.
- Scoring is per question over the frozen denominator (96, 16, 12, 24 per
  quartile). Missing answer counts as wrong.
- `exposures` records which questions had answer-related evidence re-exposed by
  earlier sentinel/probe traffic (`probeClean=false`).

### W1 tests

`node --test tests/live/longrun/w1.test.mjs` must cover: determinism (same salt
=> identical corpus hash), page length bounds, quartile assignment at every
endpoint, oracle minimum counts, near-miss uniqueness, scoring golden cases
(correct, wrong, empty array, revocation, near-miss absence, format failures),
and tool-policy negatives (denied page during probe, denied shell, idempotent
operation replay).

## W3 — observation, usage ledger, supervision

### `observer.mjs`

Cordis plugin. `inject = ['llm','sessions','agentPresets','tokenMeter','sessionProjections']`.

```js
export function apply(ctx, config)
// config: { output, eventRoot, route, mainMaxTokens, expectedContextWindow,
//           usageRoot, jobRoot, purposePolicy, stopFile }
```

- Owned-session check identical to the short harness.
- `llm/stream` interception records one request row per `callId` with:
  `logicalRequestId` (stable per stream), `streamId`, `attemptId` or `'unknown'`,
  purpose classification, provider/model, effective effort, maxTokens, context
  window, system/tools/messages hashes, dispatch/first-content/terminal times,
  raw usage, normalized usage and the accounting class.
- Purpose classification: main foreground work, sentinel probe, final probe,
  background summary, title (must be absent), other. Never reuse
  `promptControlled()` semantics.
- Usage: one row per usage chunk plus a final normalized row; dedupe by
  `(logicalRequestId, streamId, attemptId)`; a repeated cumulative chunk must
  not double count. `usage.mjs` owns the normalization rules and the six
  required totals.
- Never rewrite request bodies, never clone unbounded HTTP bodies, never record
  the private settings contents or credentials.
- Event capture is incremental: append every host event to
  `<eventRoot>/<sessionId>.events.jsonl` and write the full snapshot only at
  checkpoints (turn end, window commit, summary receipt, restart).
- Summary job lifecycle rows go to `<jobRoot>/summary-jobs.jsonl` with the
  explicit field set from protocol section 12. Each row carries an explicit
  `streamId` plus `associationEvidence` describing *how* the job was linked to
  an LLM stream (plugin event, receipt, or product metadata). Time proximity
  alone is never sufficient evidence.

### `usage.mjs`

```js
export function normalizeUsage(rows)   // -> { requests, foregroundVerifiedTokens, allReportedTokens, unknownUsageCalls, reservedExposureTokens }
export function uniqueExposedSourceTokens(pages, heuristicTokens) // Set-based
export function accountingOf(requestRow)  // 'foreground' | 'summary' | 'sentinel' | 'final-probe' | 'failed' | 'cancelled' | 'retry' | 'unknown'
```

Rules: reservations never count toward the 3M floor; unknown usage is preserved
as a list, never treated as zero; probe and sentinel usage is reported
separately; cached/reasoning subtotals are never added twice.

### `supervise.mjs`

Standalone process. CLI: `node tests/live/longrun/supervise.mjs --campaign ID --pair PAIR [--once]`.

- Owns `<campaignRoot>/<pair>/supervisor.json` and a lease file containing PID,
  OS start identity, runId, launchId, profile and binary realpath.
- Polls every 5s: run checkpoints, requests, resources, lease expiry, disk and
  RSS limits. Writes `supervisor-events.jsonl`, `alerts.jsonl` and
  `resources.jsonl` in each run directory it owns.
- Heartbeat every 5s even when nothing changed; human-readable status every 30s.
- Warning at 15s without a driver heartbeat, lease expiry at 30s.
- Never injects prompts; never kills a host it cannot prove it owns.
- Detects >2GiB host RSS for 30s and >4GiB, and pauses/stops per plan limits.
- Provides `status()` returning state for the CLI without contacting the model.

## Evidence layout (protocol section 12)

```
.test-runtime/longrun-20260915/<campaign>/
  plan.json manifest.json reviews/*.json campaign-events.jsonl
  private/oracle.json private/hidden-salt private/endpoint-probes/*.json
  <pair>/<arm>/<runId>/{run,checkpoint,progress,supervisor-events,alerts,requests,summary-jobs,pressure,resources}.jsonl|json
  <pair>/<arm>/<runId>/{events,objects,control,host,recovery,faults}/
```
