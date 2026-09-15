# Muse background summaries: engine implementation and validation

This follows the [prototype experiment](ITERATION-MUSE.en.md). Snapshot boundaries, byte budgets and job ownership now live in the engine. All follow-up Muse calls use `minimal`; the host remains pinned to DSH `0.1.2-rc.1`.

## Behavior and configuration

Deterministic turnover remains the default. Additional model calls require explicit plugin/bridge configuration:

```yaml
backgroundSummary:
  provider: opencode-go-muse
  model: muse-spark-1.3-contributor
  reasoningEffort: minimal
  prepareAtEffectiveCapacityPct: 0.6
  maxInputBytes: 262144
  maxOutputTokens: 2048
  timeoutMs: 60000
```

A windowed emergency governor is required, with preparation before its emergency line. The host supplies the configured model route. Identical providers are skipped. Different provider names do not establish physical independence; this experiment uses local Qwen and the separate Muse service.

- Preparation starts at the real AgentLoop LLM stream, after the final route and logged request header/context are available. rc.1 Web selection neither updates `agent.options` nor necessarily respects earlier request waterfall values.
- At most one attempt per session, surface replacement generation and foreground route. The source is a bounded, complete, tool-balanced historical prefix. A prefix containing only the previous seed causes no extra call.
- Provenance and deterministic indices are assembled first. The model receives the actual remaining UTF-8 byte allowance. Empty, incomplete or oversized responses are rejected whole. Oversized manual `new_context` handoffs also fall back whole, with explicit `byte-budget` metadata/status, rather than silently truncating their ending.
- Only a safe pre-step can commit. Completion callbacks never edit history. Consumption checks session, generation, current/pending route, contiguous prefix, source hash and bytes. Only the covered prefix is replaced; newer messages remain verbatim.
- Pending, failed, timed-out, cancelled, stale or insufficiently useful work causes immediate deterministic fallback. Relief must reach below the normal pressure line. The 55% post-turnover target remains a soft preference. Cancellation/disposal abort requests and discard late output.

`arc_status.backgroundSummary` exposes job status and allowance. Assisted-window metadata records source end/hash and summary provider/model/effort. Existing ledgers remain readable; the shared transaction, host shadow pricing and bounded archive retrieval retain their contracts.

## Measurement

`tests/live/background-muse.mjs` drives the installed engine through the rc.1 Web API. Its observer preloads synthetic history, guards probe tools and records events; it never commits a turnover or injects a handoff. Foreground Qwen uses `off` and a 2048-token output cap; Muse explicitly uses `minimal`. Matched mechanism runs use a 64k logical window, a 25% preparation line and a 4096-byte seed. A separate smoke run uses 50k and the default 60% line. Host-priced synthetic pressure is added after foreground work to trigger the real governor. This verifies scheduling, not general benefit on autonomous long tasks.

A separate fresh marker is introduced after the snapshot. Raw retention and answer accuracy are scored separately. Full event logs verify current-input protection, tool pairing, append-only transactions, source hashes, complete byte-identical archive pagination and serial local requests. Boundary timing covers the observed pre-step, including checks and persistence; it is not directly interchangeable with the prototype's isolated transaction timing.

The three model gates retain F3/91503, 24 pages, 32k pressure, six-page batches and the same concise prompts. Native Basic uses matched thresholds. Ordinary Muse requests explicitly select minimal; its private experimental provider default is also `reasoning: minimal` because Basic omits effort on auxiliary calls. The observer verifies the effective effort.

## Preserved failures and fixes

- Several startup calibrations produced no sidecar and were stopped with logs retained. Missing initial request headers and Web selection differing from `agent.options` exposed incorrect scheduling assumptions. The final implementation starts at the real stream; an AgentLoop regression covers a default model different from the actual request.
- The first real overlapping stream still rejected a ready summary under a strict 55% cutoff: seed 2/7, retrieval 7/7, and fresh work archived. This complete failing sample is retained. A regression now requires fresh work to survive above the soft target when safely below normal pressure.
- The timeout fault exposed a diagnostic bug: a replacement event overwrote an existing `timeout` with `superseded`. Cancellation now changes only pending/ready jobs, preserving terminal reasons. Regressions and the subsequent live late-delivery run verify the fix; the original timeout record is unchanged.
- The user explicitly requested no restoration of global settings. Each run uses a private settings copy, disables automatic title calls and checks the global hash. Daily profiles are untouched.

## Engine measurements

All eight completed samples are shown. A uses a deterministic seed; C enables the independent Muse summary. Scores require exact matches for seven historical fields. Raw retention separately checks whether the assistant message produced after the snapshot remains on the active surface. Historical retrieval is disabled for the seed probe and enabled for the next probe.

| Sample / probe version | Seed only | Retrieval allowed | Fresh raw message retained | Boundary ms | Successful retrieval calls |
| --- | --- | --- | --- | ---: | ---: |
| A / 91521 / v1 | 2/7 | 7/7 | No | 9.59 | 6 |
| C / 91521 / v1 | 6/7 | 7/7 | Yes | 20.64 | 2 |
| C / 91522 / v1 | 5/7 | 6/7 | Yes | 10.59 | 2 |
| A / 91522 / v2 | 2/7 | 7/7 | No | 10.46 | 5 |
| C / 91522 / v2 | 6/7 | 7/7 | Yes | 10.51 | 7 |
| C / 91523 / v2, 50k / 60% | 7/7 | 7/7 | Yes | 10.60 | 0 |
| C / 91524 / v2, 500 ms timeout | 1/7 | 7/7 | No, deterministic fallback | 10.55 | 9 |
| C / 91525 / v2, held delivery | 2/7 | 7/7 | No, deterministic fallback | 11.15 | 28 |

The v1 / 91522 failure added `after approval` to the original `nextAction` identifier. The exact scorer still records failure; the source fact was not found missing. Probe v2 explicitly requests bare original identifiers and repeats the matched A/C comparison without changing old scores. All samples correctly answered the separate fresh marker. A's user index can carry that marker even after the assistant message is archived, so a correct marker answer does not prove raw retention.

All four ready C samples used a `model-assisted` seed and archived only the covered snapshot prefix. Their first Muse calls took **4.08–9.87 seconds**, overlapping the local Qwen stream without adding a boundary wait. The 50k / 60% run made one Muse call. Each ready 25% run made another preparation call in the next generation; the data includes these costs, not just consumed summaries.

The real 500 ms timeout and held-delivery fault each committed one deterministic replacement immediately. The latter holds the finish chunk of a completed real Muse response for 32.209 seconds until after commitment, then releases it. There was no late write or second replacement. Its stream duration includes the artificial hold and is excluded from model-speed claims. Retrieval remains necessary after fallback: the late sample needed 28 successful calls, so a fast boundary does not establish low total task cost.

Every completed sample passed current-input protection, tool pairing, append-only transaction, full byte-identical archive pagination and serial Qwen audits. All four assisted source hashes matched. Seeds ranged from 1432 to 1771 bytes. No completion callback directly edited the session.

## Byte budgets and regression checks

With 1 / 12 / 24 / 48 historical user messages, the compact real handoff retained all six fields, producing 3398–3663-byte seeds. A padded 1300-character handoff was rejected whole in all four cases with `byte-budget`, producing 3897–3961-byte deterministic seeds. Those seeds did not retain the six handoff-tail fields; their original evidence remained retrievable. This fixes silent truncation and misleading assisted labels, not the finite capacity of the seed.

Final `npm pack` prepack checks passed: **187 unit + 105 host integration + 15 local-runner tests, 307 total**, plus strict TypeScript and build. New regressions cover actual AgentLoop route overrides, ready consumption across turns, fresh suffix retention, real UTF-8 allowance, stale/timeout/cancel/dispose/late states, same-provider refusal and the soft target.

## Muse minimal three-arm model gates

This cohort uses Muse as the foreground model with background summaries disabled. It tests ordinary turnover, in-place compaction and matched native Basic on the new build, separately from the Qwen/Muse mechanism cohort. Native and initial windowed failures remain; windowed was repeated once with the same configuration.

| Arm | Seconds | Facts | Corrections | Verbatim | Compactions/windows | Strict gate | Calls / reported tokens |
| --- | ---: | --- | --- | --- | ---: | --- | ---: |
| Native Basic | 102 | 23/24 | 6/6 | 1/3 | 3 | Fail | 24 / 550289 |
| Plugin in-place | 49 | 24/24 | 6/6 | 3/3 | 3 | Pass | 16 / 436600 |
| Plugin windowed, first | 66 | 24/24 | 6/6 | 3/3 | 3 | Fail | 18 / 476363 |
| Plugin windowed, same-config repeat | 75 | 24/24 | 6/6 | 3/3 | 4 | Pass | 24 / 657681 |

Both strict failures included six initial `experiment_read_page({})` calls. The actual request schema required an integer `page`. The first stream had only 12 argument-delta characters and the recorded calls were six `{}` objects; guards rejected them before the model retried with valid page numbers. Native also had answer errors. The repeat had 60 initial argument-delta characters and no denied calls. This locates the issue in tool-call output before any compaction; normalized stream logs cannot distinguish server generation from host-adapter behavior. Guards remain strict, missing page numbers are not fabricated, and the cohort is not reported as universally passing.

All four runs exposed all 24 pages and passed byte-level archive audits. Both windowed runs passed a real process restart. Voluntary `new_context` and `compress` calls remained zero; all seven windows used pressure / extractive seeds. A stronger Muse model is therefore not evidence that voluntary handoff preparation will happen.

## Conclusion and reproduction

The retained implementation **prepares a bounded summary early through independent Muse minimal, consumes only a ready and valid snapshot at the boundary, and preserves newer raw work; otherwise it falls back immediately.** It remains disabled by default and is not enabled in daily profiles. These small synthetic samples support better seed continuity and a non-blocking boundary. They do not establish lower total latency or cost: v2 C made seven retrieval calls against matched A's five. Two concurrent Muse jobs, autonomous very long tasks, physical GPU concurrency and other models were not validated.

[Sanitized data](data/turnover-muse-engine-2026-09-15.json) includes candidate hashes, call durations/tokens, faults and failed calibrations. Raw evidence remains under ignored `.test-runtime/turnover-muse-20260915/` and `.test-runtime/nightly-20260915/muse-min-*`. First-stage runs with unspecified Muse effort remain separate.

```sh
export EXPERIMENT_DSH_BIN="$PWD/.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh"
# Complete prepack before installing, only into the experiment profile.
npm pack --pack-destination artifacts
node tests/live/install-candidate.mjs ctx-v012-smoke-c
node tests/live/background-muse.mjs --name=engine-reproduce-c --arm=C --seed=91522
node --import tsx tests/live/background-audit.mjs .test-runtime/turnover-muse-20260915/engine-reproduce-c
node tests/live/local-short.mjs --name=muse-min-reproduce --route=muse --arm=C400_WINDOWED --family=F3 --seed=91503 --pages=24 --pressure=32000 --batch=6 --concise=true --restart=true
node --import tsx tests/live/local-audit.mjs .test-runtime/nightly-20260915/muse-min-reproduce
```

Use a new run name each time. `--arm=A` selects the mechanism control; `--window=50000 --prepare=0.6` checks the default preparation line; `--fault=timeout` / `--fault=late` exercise fallback. Other gate arms are `A_NATIVE` / `B_IN_PLACE`. Run samples sequentially; local Qwen is serial.
