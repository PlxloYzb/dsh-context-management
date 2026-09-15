# Switch Windows First, Deliver Later, Wait Only When Needed

[中文](ITERATION-DEFERRED-HANDOFF.zh-CN.md) · [Sanitized data](data/turnover-deferred-handoff-2026-09-15.json) · [Test index](TESTING.en.md)

This follows the [two-stage Muse work](ITERATION-MUSE-CLOUD.en.md). The previous iteration treated a summary that did not arrive before a window switch as late and cancelled it. That could evaluate immediate seed adoption, but not hidden waiting. This iteration uses a different success condition: advance the window promptly, let foreground work use retained context, then deliver the summary before it is needed or wait only for the remaining time at the dependency point.

## Design and pre-committed protocol

- Foreground and background both use `opencode-go-muse/muse-spark-1.3-contributor` at `minimal`, pinned to DSH `0.1.2-rc.1`. Each item is one short sample; the next item is chosen after review. Cost is accounting only, while request, turn, and whole-run timeouts remain in force.
- The background job freezes a bounded historical snapshot bound to the session, source sequence range, hash, and route. The shared transaction still commits a deterministic index immediately; when pressure permits, it replaces only the old snapshot and retains later raw content.
- A summary may continue across this engine's window switch. Completion updates job state only. At a later pre-step that would occur anyway, the harness appends a historical handoff; it is counted as delivered only after the host persists its receipt. A handoff is neither a second replacement nor additional compaction shadow pricing.
- `await_context` waits only for a crossed job in the current session and returns status. The body is appended at the next safe boundary. Independent work may continue, and original-history retrieval remains available for historical dependencies. Waiting does not hold the window-transaction lock.
- The window transaction persists a pending source, covering restart after the switch is durable but before its notice is appended. Cancellation, timeout, stale source, and budget exhaustion become explicit unavailable states. A failed delivery notice cannot be overwritten by a later job before host acknowledgement.
- Summary text has an independent default limit of 4096 UTF-8 bytes. Append still checks host token headroom; it no longer competes with the deterministic index for the same roughly 0.5 KiB tail allowance. Historical text cannot override newer user instructions, and exact evidence still requires original-history retrieval.

```yaml
backgroundSummary:
  provider: opencode-go-muse
  model: muse-spark-1.3-contributor
  reasoningEffort: minimal
  allowSameProvider: true
  delivery: deferred
  maxSummaryBytes: 4096
```

Background operation remains explicitly configured; `allowSameProvider` defaults to false. With background enabled, `delivery` defaults to deferred; `delivery: seed` preserves the previous iteration's immediate-adoption mode for comparison. Without background configuration, `await_context` is not registered. This iteration does not change daily defaults.

## Two real cloud mechanism paths

The final short fixture has 18 pages of synthetic history, a 44k logical window, a 25% preparation line, and a current-task tool result below the host's 8192-character trimming threshold. The runner never calls turnover directly or writes a summary; ordinary tool output triggers the real governor. Both samples use seed 91541 and run once.

| Sample | Window-switch pre-step | Commit to next foreground request | Summary stream | Wait at dependency | Quality / retrieval |
| --- | ---: | ---: | ---: | ---: | --- |
| independent-v5 | 17 ms | 14 ms | 9.18 s | 0 | Current-data verification 1/1; no retrieval |
| dependent | 20 ms | 15 ms | 7.76 s | 1.91 s | Historical fields 3/3; no retrieval |

For the independent task, the summary became ready about 3.32 seconds after the window committed, while foreground work was already verifying current data. It was appended at the next boundary about 6.49 seconds after the switch; there was no `await_context` call. For the dependent task, the summary became ready about 4.70 seconds after the switch. The model reached the historical dependency point partway through, waited for the remaining roughly 1.90 seconds, then received the body and answered all three fields correctly.

Actual foreground requests were also inspected in the dependent sample: request 2, after turnover, contained none of the owner, rollback or gate values; request 3, after waiting, contained all three.

Both samples observed pending → ready → delivered for one job, one real window, and one summary append. Source-hash checks, current-input protection, tool pairing, and byte-for-byte archive pagination passed. Foreground requests remained serial, with at most one background stream and two total streams. Completing the final answer did not wake an extra model request merely to deliver a summary.

`pre-step` is the interval between host hooks and includes transaction and persistence-related work. “Next request” is the start of the host stream, not a server first token or evidence of underlying GPU parallelism. The `await_context` tool-call-to-result interval includes small tool overhead; its owned promise wait was 1904 ms. These two single samples demonstrate mechanism paths, not a general latency, quality, or cost advantage. The dependent probe explicitly requires the waiting tool, so it does not yet show that a model independently selects the correct wait point in a natural task.

## Retained failures and field-driven fixes

| Sample | Original result | Explanation and handling |
| --- | --- | --- |
| independent, initial | Failed; zero model requests | The two test observers used different experiment-directory prefixes, so the host rejected the request. Fixture ownership validation was corrected. |
| independent-v2 | Task 1/1; no window switch | The host spilled the large tool result, leaving the 64k window below its pressure line. This is not a mechanism success. |
| independent-v3 | Task 1/1; no window switch | At 48k, the native pruner trimmed the tool result, then old fallback logic made one extra in-place archive operation. This is not a deferred success. |
| independent-v4 | Window switched; turn errored | Handoff admission accessed an undeclared injected token meter and was rejected by the real Cordis scope. The code now uses the existing `ctx.get` interface. |

The test-evidence reader was also corrected. Host RPC history is a filtered view and may contain sequence gaps; the audit now uses the observer's complete session snapshot and requires contiguous sequence numbers from zero. It retains the RPC view without filling or renumbering events.

v3 also exposed an existing engine issue: the pruner reduced pressure from 45394 to 35996, below the 37670 emergency line; after returning `pruner-relieved-pressure`, the window path still performed an in-place archive operation. Pressure is now remeasured and that processing stops. High-pressure, overflow, and no-safe-prefix recovery paths remain. This fix does not reclassify v3 as successful and does not revive a summary cancelled by an unrelated replacement. Triggering the window with a result below the native trim threshold is an explicit geometry condition of the new fixture; the host pruner was not disabled.

## Real Web three-arm study, regressions, and package

All arms used F3 / 91542 / 24 pages / 32k pressure / six-page batches. Native Basic had matched trigger and retention thresholds. The windowed arm used the default 60% preparation line and a real process restart. Every foreground and summary request used Muse minimal; costs were observed without a token spending ceiling.

| Arm | Compactions / windows | Strict tool gate | Facts · corrections · verbatim | Total seconds | Requests | Reported tokens |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| Native Basic | 1 | Pass | 24/24 · 6/6 · **1/3** | 103 | 20 | 561386 |
| In-place | 3 | Pass | 24/24 · 6/6 · 3/3 | 64 | 17 | 463351 |
| Windowed + deferred | 4 | Pass | 24/24 · 6/6 · 3/3 | 92 | 29 | 751372 |

All arms read all 24 pages, passed deliverable checks and recovered archive bytes exactly. Native failed the verbatim gate, so the three-arm gate is not universally green. Native compaction occupied its pre-step for 13.34 seconds; in-place boundaries took 18–26 ms and window boundaries 20–32 ms. Overall times include different model-call and retrieval counts; these single samples do not establish a general speed ranking.

All four windows used deterministic seeds, with two separate durable handoff appends: one job crossed the window while pending and was delivered later; another was ready beforehand and appended at the switch boundary. One crossed job was interrupted by the real restart, followed by an explicit unavailable/interrupted recovery notice. Another ready job still had its source in the current window and was not consumed; its cost remains counted. Deferred delivery therefore needs receipt metrics, not just the old model-assisted-seed fraction.

Foreground streams remained serial, with one background stream and two total streams at peak, and 45.39 seconds of accumulated foreground/background stream-lifecycle overlap. The Web sample made no await_context calls. Receipt source hashes, unchanged generation at append, deduplication and the recovery notice passed audit. Autonomous waiting in a natural task remains unexercised; the separate explicit-dependency probe covers the waiting path. The interrupted summary was not silently regenerated after restart.

Successful mechanism samples used runtime-entry SHA-256 `e105896b9d2bf49b0b7ea7a2c31366d448bfb2c0e85cdaa5876382e240f45ecd`. The small pruner-relief fix followed; all three Web arms used final entry `7ae69d6ec21c69d36c3157d5ab82d48ea6fb2417294816caf3cc1f5e5e24993f`. The successful mechanism samples did not invoke pruning. They are explicitly recorded as different candidates. Final regressions cover all added paths.

The complete `npm pack --pack-destination artifacts` prepack passed: **187 unit + 133 integration + 22 experiment-tool checks = 342 tests**, plus type checking and build. Integration coverage includes scoped Cordis service access, independent work/waiting/model-requested windows, delivery-budget notices, cancellation, timeout, duplicate delivery, JSONL restart for all three triggers, and post-pruning pressure branches.

Release audit passed for 42 files. acp-kernel remains exactly pinned; there are no absolute host imports or undeclared runtime imports. Package `artifacts/dsh-context-management-0.1.1.tgz` SHA-256 is `f5cb71db70806a1c0c9a5f6b3073fbe0353693e65ac2e2f2d62ca7fb02f44a45`. It was installed only into ctx-v012-smoke-c, with all 34 dist files verified. The installed package hash matches the prepack artifact. Nothing was published to npm.

The global settings hash is unchanged from the start; settings were neither restored nor rewritten and daily web/headless profiles were untouched. No Qwen calls or local tunnel keepalive were used. All three Web runs released their lock; experimental processes stopped and ports 3311/3324 have no listener. Both experiment profiles remain.

This iteration did not pair the final windowed candidate with background disabled for a quality/cost comparison. Delivery and hidden waiting have mechanism evidence, but general quality or financial gains are not established. One interrupted Web stream reported zero usage; unconsumed summaries remain counted. Reported tokens are not a complete bill.

## Reproduction and evidence limits

```sh
# Start one item at a time; choose the next only after completion and review.
node tests/live/handoff-muse.mjs --name=reproduce-independent --task=independent --background=true --seed=91541
node --import tsx tests/live/handoff-audit.mjs .test-runtime/handoff-muse-20260915/reproduce-independent
# Use --task=dependent for the dependency path; retain Muse minimal.
node tests/live/local-short.mjs --name=reproduce-web --route=muse --arm=C400_WINDOWED --family=F3 --seed=91542 --pages=24 --pressure=32000 --batch=6 --concise=true --restart=true --background=true --prepare=0.6 --cost-control=observe
```

Raw mechanism evidence is kept in ignored `.test-runtime/handoff-muse-20260915/`; Web evidence is in `.test-runtime/nightly-20260915/`. All failures remain retained. Public data is generated from a fixed run allowlist and explicit field allowlist; it does not copy request bodies, authentication data, absolute paths, or session identifiers. Missing or zero usage does not mean a call was free.
