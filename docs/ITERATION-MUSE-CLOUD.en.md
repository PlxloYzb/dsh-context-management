# Dual Muse minimal: incremental cloud validation

[中文](ITERATION-MUSE-CLOUD.zh-CN.md) · [Sanitized data](data/turnover-muse-cloud-2026-09-15.json) · [Test index](TESTING.en.md)

This continues the [previous phase](ITERATION-MUSE-ENGINE.en.md). Both foreground work and background summaries use the same live route, `opencode-go-muse/muse-spark-1.3-contributor`, at `minimal` reasoning, on pinned DSH `0.1.2-rc.1`. Each run is a short sample; the completed evidence is reviewed before choosing the next run. No batch queue was pre-scheduled.

## Protocol fixed in advance

1. Add the explicit concurrent setting `backgroundSummary.allowSameProvider: true`. Its default remains false, so a locally serial service is not treated as concurrent; provider aliases are not used to bypass the check. Snapshot, cancellation, budgeting, and safe transaction rules remain in force.
2. First run one C mechanism sample: 18 pages, a 64k window, and a 25% preparation line. Verify that both live calls are Muse minimal, record foreground and summary stream/content intervals, peak in-flight streams, boundary readiness, source hashes, and archive restoration. Stream overlap does not establish GPU-level parallelism.
3. If requests and transactions are auditable, run the matching A control with background summaries disabled. Then select a second seed, default preparation line, or short fault sample from the evidence. A naturally late summary remains a fallback result; the experiment never waits at the boundary to manufacture adoption. Seed and post-retrieval scores are strict and separate from preservation of new raw text.
4. Engine changes still run the live three-arm Web gate: matched native Basic, plugin in-place compaction, and plugin windowed compaction. Start with F3 / 24 pages / 32k pressure / six-page batches; the windowed arm may enable dual Muse and must perform a real restart. Review each run before proceeding. Add a same-configuration, background-disabled windowed control when needed so summary effects are not confused with compaction strategy.
5. Continue accounting for tokens and request duration. The cloud gate uses `--cost-control=observe`, so it does not stop on a token-cost ceiling; per-request, per-round, and full-run wall-clock limits remain recoverable. Use synthetic sessions, experiment profiles, and private settings. Disable automatic title calls and leave daily defaults untouched.

The key question is whether a summary can finish during short foreground work and, when it cannot, whether the system immediately falls back safely. Answer quality, raw-text retention, strict tool gates, and total cost are reported separately; passing one does not imply the others.

## Outcome and product change

Foreground and summary requests on the same cloud route can overlap in the host. A mechanism sample with enough lead time consumed a model summary and replaced the window in about 10 ms. In real short paginated work, however, both the 60% and 40% preparation lines adopted **0 of 4** summaries: the first three arrived late and the last exceeded the byte budget. Moving to a cloud model or lowering the preparation line does not guarantee orchestration success. This round does not change the default preparation line or add summary waiting to the window-replacement path.

The product change is limited to `backgroundSummary.allowSameProvider`, defaulting to false. An explicit true value permits background work on the same provider; background operation still requires explicit configuration. Users must establish that their route supports concurrency; this flag does not probe server capacity.

```yaml
backgroundSummary:
  provider: opencode-go-muse
  model: muse-spark-1.3-contributor
  reasoningEffort: minimal
  allowSameProvider: true
```

Prepared snapshots, source hashes, cancellation, timeouts, byte budgets, current-input protection, and safe transactions retain the previous phase's behavior. A summary is consumed only when ready at the boundary; otherwise deterministic indexing is used immediately. This setting does not make the foreground AgentLoop issue multiple turns in parallel.

## Mechanism sample: usable with enough preparation

The sample has 18 pages of history, a 64k logical window, a 25% preparation line, and a 4096 **UTF-8-byte** seed limit (the configuration name remains `seedMaxTokens`). Seed 91531 ran C first and A after review. The probe has seven historical fields; retrieval is disabled for the seed answer and then enabled.

| Sample suffix | Background summary | Direct seed answer | After retrieval | Foreground / retrieval seconds | Window replacement ms | Retrieval successes / attempts |
| --- | --- | --- | --- | --- | ---: | ---: |
| `cloud-c-91531` | Ready and consumed | 6/7 | 7/7 | 15.64 / 21.16 | 9.80 | 4 / 4 |
| `cloud-a-91531` | Disabled | 2/7 | 7/7 | 9.14 / 100.46 | 11.04 | 5 / 5 |

The first C summary lasted 10.99 seconds and overlapped the first foreground host-stream lifecycle for 10.99 seconds. Peak in-flight streams was two, with at most one summary; the first-content through last-content intervals overlapped for about 1.52 seconds. This proves that the host did not serialize the foreground path behind the summary. It does not establish the server's GPU scheduling.

C committed a 1577-byte `model-assisted` seed with a matching source hash; the foreground assistant's raw text after the snapshot remained in the active window. A committed a 1432-byte extractive seed and archived the foreground raw text. Both passed current-input protection, tool pairing, append-only transactions, and byte-for-byte archive restoration through pagination. Both final answers contained the fresh marker. Because the marker can come from the user index, marker production and retention of assistant raw text are audited separately.

A's retrieval tail included one slow stream of **88.43 seconds / 198 output tokens**. This is not evidence that C generally improves end-to-end time. It is one paired observation without a significance claim. C also issued a second-generation summary, so its cost accounting includes preparation work that was not consumed.

## Short foreground diagnostic: instruction failure is not summary benefit

The foreground task was changed to “disable tools and return only the fresh marker” to shorten summary availability time. The fixture remained otherwise unchanged, and every next run was selected only after review.

| Sample | Foreground seconds | Strict single-marker instruction | Seed / after retrieval | Retrieval successes / attempts | Interpretation |
| --- | ---: | --- | --- | ---: | --- |
| `cloud-brief-c-91531` | 11.90 | Failed | 7/7 · 7/7 | 8 / 8 | Original run remains failed; a later independent audit confirms raw-text retention |
| `cloud-brief-a-91531` | 6.10 | Passed | 2/7 · 7/7 | 6 / 6 | Deterministic control |
| `cloud-brief-c-repeat-91531` | 18.17 | Failed | 7/7 · 7/7 | 12 / 12 | Repeated observation; failure retained |
| `cloud-brief-c-nocache-91531` | 15.00 | Failed | 7/7 · 7/7 | 8 / 10 | Private settings disabled SDK cache association; the problem remained |

The failed C foregrounds reviewed historical facts instead, and some attempted the prohibited `arc_status` tool. This output lengthens foreground work and repeats historical facts, so its 7/7 seed score is **not** a clean short-work experiment or a benefit attributable only to the summary. `completed` means execution ended; foreground instruction compliance, seed score, and archive safety are recorded independently.

The first failure also exposed a faulty test criterion: the old runner looked for an assistant message containing the fresh marker to locate the raw text that must be protected. If the model omitted the marker, this location was empty and boundary continuity was falsely reported as failed. The runner now selects the final assistant message after the latest real user input, then checks marker production independently. The original failure report and output were not changed. Offline audit retains `originalRunCompleted: false` and confirms that the actual new raw text was not lost.

### HTTP attribution check

One foreground-only diagnostic, `cloud-wire-c-91531`, then ran without seed or retrieval probes. A test-only observer captured live Muse Responses HTTP requests and SSE responses. Raw bodies exist only in ignored, mode-0600 files; authentication headers are not stored.

- All three HTTP requests were Muse minimal and HTTP 200, with distinct response IDs. One summary and two foreground requests were separately paired.
- The foreground HTTP input contained the current single-marker instruction. Its first response selected `arc_status`, which the experiment guard rejected; the next foreground response returned a historical review.
- The host's displayed final text matched the corresponding foreground HTTP response byte-for-byte. No local summary-to-foreground response swap was observed.
- Both request types used the default SDK cache-association key, but an independent no-association sample still failed. The cache-root-cause hypothesis is unsupported, and the default cache setting was not changed.

This localizes the issue to server responses to correctly delivered requests. It cannot distinguish model instruction following, cloud-service implementation, and concurrency effects. One wire diagnostic proves neither causation nor remote compute parallelism. In this existing raw wire run, the wire `time` field is request-start time; concurrency observations therefore use host-stream lifecycles only. The observer was subsequently extended to record a separate `completedAtMs` for future response captures; historical raw wire logs were deliberately left unchanged. No read-only host or SDK change is justified by the available evidence.

## Live Web three-arm gate and windowed controls

All runs use F3 / 91533 / 24 pages / 32k pressure / six-page batches. Native Basic uses matched trigger and retention thresholds. All foreground and compaction requests have effective `minimal` effort. `--cost-control=observe` keeps token accounting while disabling token-ceiling termination; request, round, and full-run wall-clock limits remain.

| Run suffix | Compactions / summary adoption | Strict tool gate | Facts · corrections · verbatim | Total seconds | Requests | Reported tokens |
| --- | --- | --- | --- | ---: | ---: | ---: |
| `cloud-native-91533` | Basic 4 | Pass | 24/24 · 6/6 · **1/3** | 118 | 23 | 530,870 |
| `cloud-inplace-91533` | In-place 3 | Pass | 24/24 · 6/6 · 3/3 | 64 | 19 | 524,646 |
| `cloud-windowed-bg-91533` | Window 4, summary **0/4**, preparation 60% | **Fail** | 24/24 · 6/6 · 3/3 | 85 | 31 | 683,163 |
| `cloud-windowed-early-91533` | Window 4, summary **0/4**, preparation 40% | Pass | 24/24 · 6/6 · 3/3 | 82 | 25 | 578,114 |
| `cloud-windowed-control-91533` | Window 3, background off | **Fail** | 24/24 · 6/6 · 3/3 | 120 | 35 | 872,028 |

All tasks completed and passed the deliverable check; all 24 pages were fully exposed in actual model requests, and archive bytes were verified. All three window runs passed recovery after a real process restart. In-place and the 40% window arm passed every quality gate; native failed verbatim recall, while the 60% and background-off window runs failed the strict tool gate. The three-arm evaluation is therefore not all green.

Both strict tool failures began with six rejected `experiment_read_page({})` calls, followed by correct page arguments and complete reading. Original failures remain recorded. Their occurrence with background work disabled shows that these errors are not specific to dual-route summarization. No model voluntarily called `compress` or `new_context`; automatic policies performed the compactions.

Native Basic blocked pre-step for **10.59–16.30 seconds** per compaction. Plugin in-place intervals were **19–28 ms**, and the three window groups were **20–29 ms**, including the observed host pre-step interval. Both background-enabled runs peaked at two host streams, with cumulative foreground/summary intersections of **18.04 / 19.42 seconds**. Every summary nevertheless terminated as late or oversized; none completed and was consumed.

Tokens are host/adapter-reported usage, including reported cache categories. In each background group, three cancelled streams reported zero usage and one oversized stream reported none. Neither establishes free service, and the table is not a complete billing record. All requests, including unused background work, remain in the raw logs. Small samples, tool errors and cloud stalls affect total time; these timings do not establish a generally faster policy. Background-off windows also scored 3/3 verbatim, so this group shows no additional answer benefit from background summaries.

### Why 40% did not solve the 60% problem

The preparation line controls token pressure, not guaranteed wall-clock lead time. In both groups, the first three snapshot-to-boundary spans covered only about 42–47 events. Summaries reached the safe boundary while pending, were cancelled, and were recorded as late; stream completion is not summary readiness. The final summary exceeded the output budget and was deliberately stopped. In both groups, remaining seed capacity fell from about 1.4 KiB to about 0.5 KiB; lowering the threshold did not alter that outcome.

Usable summary bytes depend on allocation within the same 4096-byte seed for user-history indexes, exact-record indexes, headers, and retained space. Freezing earlier also leaves a longer newer suffix that must remain verbatim. Even a completed summary can replace the old snapshot only if it actually reduces pressure to the permitted line. A completed summary is therefore not automatically usable. This group did not reach the source-benefit decision, so this limitation must not be described as an observed failure.

Neither tuning point produced adoption benefit, so the threshold scan stopped. Follow-up work should validate the scheduling condition of sufficient safe lead time plus sufficient summary bytes before changing snapshot timing or seed allocation; waiting at the boundary cannot make adoption appear successful.

## Evidence scope and reproduction

Raw mechanism data is under `.test-runtime/turnover-muse-20260915/cloud-*`; live gate data is under `.test-runtime/nightly-20260915/cloud-*`. The public summary is produced from an explicit allowlist by `tests/live/cloud-report.mjs`. It does not mix earlier Qwen/Muse phases and includes neither request bodies nor credentials.

Retrieval success means a persisted `tool/result` with `status: success`; attempts, errors, and missing results are reported separately. Two earlier reports mislabeled guard-allowed counts as success counts. This round corrects the bilingual reports and sanitized data without changing original scores or failure records.

```sh
# Run one model command at a time; review its result before choosing the next.
# Each run name must be new.
node tests/live/background-muse.mjs --name=cloud-reproduce-c --main=muse --arm=C --seed=91531
node --import tsx tests/live/background-audit.mjs .test-runtime/turnover-muse-20260915/cloud-reproduce-c

node tests/live/local-short.mjs --name=cloud-reproduce-window --route=muse --arm=C400_WINDOWED --family=F3 --seed=91533 --pages=24 --pressure=32000 --batch=6 --concise=true --restart=true --background=true --prepare=0.6 --cost-control=observe
node --import tsx tests/live/local-audit.mjs .test-runtime/nightly-20260915/cloud-reproduce-window
node --import tsx tests/live/cloud-gate-audit.mjs .test-runtime/nightly-20260915/cloud-reproduce-window
```

Mechanism A uses `--arm=A`; the short instruction uses `--work=brief`; the foreground-only diagnostic uses `--stop-after=foreground --wire=true`; and the private no-cache diagnostic uses `--cache=none`. Web controls select `A_NATIVE --matched-native=true`, `B_IN_PLACE`, or omit `--background=true` from the windowed arm. Each run pins its own host and must not fall back to a newer global DSH.

## Regression, artifact and environment checks

`npm pack --pack-destination artifacts` ran the complete prepack checks: **187 unit + 106 real-host integration + 22 experiment-tool tests = 315 passing checks**, plus typecheck and build. `test:release` passed: 42 distribution files contain no absolute host paths or undeclared runtime imports. Regressions cover same-provider opt-in, its disabled default, one request per generation, and inert late completion after cancellation.

The SHA-256 of `artifacts/dsh-context-management-0.1.1.tgz` is `524069314d5ad3d4864a89ade63b6ed67f55f434d4030f699e3362b687adc037`. It was installed only in `ctx-v012-smoke-c`, with all 34 dist files verified. Both the tested and final `dist/index.js` hash to `6de596def16399609b450e4708ae0da7346c3d8f326653afb75f25f8da07629c`; the final package adds documentation while retaining the tested runtime. Nothing was published to npm.

This cohort made no Qwen requests and started no local tunnel keepalive. Every run retained the global settings hash recorded at the start of this cohort; user settings were neither restored nor rewritten. Daily profiles were untouched. Experiment hosts and locks have exited, with no remaining listeners on 3311/3324. Both experiment profiles and all failed-run evidence remain available.
