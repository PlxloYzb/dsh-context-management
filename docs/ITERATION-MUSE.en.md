# Muse two-route turnover validation (2026-09-15)

This page preserves the first-stage prototype results. See [stage two](ITERATION-MUSE-ENGINE.en.md) for the engine implementation and explicit Muse `minimal` validation.

[中文](ITERATION-MUSE.zh-CN.md) · [Protocol](TURNOVER-MUSE-PROTOCOL.en.md) · [Sanitized data](data/turnover-muse-2026-09-15.json) · [Previous iteration](ITERATION-NIGHTLY-5.en.md)

## Conclusion

**Local Qwen can continue foreground work while Muse prepares a historical summary. The boundary can consume ready work without waiting and retain more historical facts.** This capability exists only in the test prototype. No runtime source or installed engine changed; all live experiments used **DSH 0.1.2-rc.1**.

Nine matched samples and one delayed-delivery fault completed. The results support further implementation of early preparation with immediate deterministic fallback. They do not justify shipping yet: **retain the raw suffix after the summary snapshot and allocate the actual seed byte budget** first.

## Three seeds, three fixed-boundary arms

The main model was local Qwen3.8-27B with explicit reasoning `off` and a 2048-token output cap. The sidecar used `opencode-go-muse/muse-spark-1.3-contributor`. Order: ABC/BCA/CAB. Each seed shared the same 18-page synthetic source (**79,252 bytes including page separators**), foreground task, forced safe boundary and 4096-byte seed cap. The archive also contains host messages and foreground work, so restored byte counts are larger. Paired tool history was preloaded through host events; foreground work, summaries and probes used real models.

Values below are **medians of three samples per arm**. The seven probe fields include a current user correction and a verbatim marker deliberately excluded from summaries.

| Metric | A: deterministic | B: synchronous Muse | C: prefetched Muse |
| --- | ---: | ---: | ---: |
| Total boundary, including transaction/flush | 9.51 ms | 4747.95 ms | 7.40 ms |
| Summary wait / consumption check | 0.28 ms | 4734.78 ms | 0.30 ms |
| Replacement transaction | 8.39 ms | 12.25 ms | 6.39 ms |
| Visible-context probe | 2/7 in all samples | 6/7 in all samples | 6/7 in all samples |
| Retrieval-enabled probe | 7/7 in all samples | 7/7 in all samples | 7/7 in all samples |
| Successful historical calls | 9 (5/9/10) | 10 (11/10/2) | 3 (3/3/2) |
| Retrieval-phase elapsed time | 46.41 s | 71.51 s | 36.81 s |

C boundaries ranged **7.21–9.18 ms**. Their small difference from A is not evidence of a faster deterministic algorithm; the important difference is eliminating B's **4.63–6.35 seconds** of boundary waiting. Actual C cloud streams overlapped local foreground streams by **4.633/5.644/5.347 seconds**, with both completing. Formal local requests were serial and automatic title calls were disabled. Stream overlap does not prove a particular server GPU scheduling policy.

C used fewer historical calls in this pilot, but total-cost improvement is not guaranteed. B's first two samples reverified facts already present in the summary, making 11 and 10 historical calls. C's second retrieval phase took 64.82 seconds. The small sample, generation variability and denied diagnostic tool attempts preclude statistical or general end-to-end performance claims. The data distinguishes successful retrievals from denied attempts.

## Late delivery and safety

One C fault used a real Muse call but withheld delivery in the test layer until after turnover. The boundary observed `pending`, spent **0.41 ms** checking it and **17.53 ms** in the transaction, and immediately used the extractive seed. Delivery then settled as `late`, without a later write; the final ledger still contained exactly one turnover. Visible-context accuracy was 2/7 and retrieval-enabled accuracy 7/7.

All ten completed boundary samples passed append-only checks, current-input protection, balanced tool pairing, full paginated byte recovery and serial local-stream checks. Web `session/page` returns a folded UI page, so the audit uses the observer's complete contiguous event log and validates each UI-returned event against it.

Seven scheduler tests cover single consumption, late delivery, session/generation/source/route mismatch, cancel/dispose, failure/empty/oversized output, timeout, and stream-interval overlap. **Cancel, dispose, service failure and mismatch have unit coverage only; they are not claimed as live cloud fault tests.** Controller-injected model-assisted seeds are not voluntary `new_context` adoption.

## Two constraints for product implementation

### Retain the raw suffix after the snapshot

The fixed-boundary prototype archives foreground output produced after the summary snapshot even though the summary never saw it. The nine probes do not ask about those new facts, so their perfect final scores cannot validate that continuity.

A separate offline real-host transaction test adds a fresh fact after the snapshot. Current whole-prefix turnover removes it from the visible surface. Replacing only the snapshot-covered prefix through the shared transaction retains it verbatim. Both remain append-only with correct generation metadata. This mechanism is **not yet an integrated engine feature and has not passed a complete live model gate**.

Recommended window contents: deterministic index of the old prefix, ready source-bound summary, raw post-snapshot suffix, and current user input. Keep replacement boundaries balanced across tool calls/results. If that does not relieve pressure sufficiently, use deterministic fallback instead of waiting for the cloud.

### Budget actual UTF-8 bytes

The real compact Muse handoff was 185 characters and retained all six fields under index pressure from 1/12/24/48 historical user messages. A separate **synthetic 1300-character stress handoff**, with its facts placed at the end, was truncated at all four sizes and lost all six trailing fields. The originals remained recoverable and truncation was explicit, but a fixed 1400-character summary cap does not guarantee fitting the 4096-byte seed.

Allocate user-index, source-record and retained-suffix budgets first, then give the sidecar the available UTF-8 byte allowance. Check the fields and provenance actually retained after assembly; successful generation alone is insufficient.

## Muse as the main model: existing product gates

Three autonomous-reading Web runs used F3/91503/24 pages/32000 pressure/batches of 6. Native Basic used matched trigger and retention thresholds. These runs did not include the experimental scheduler.

| Arm | Completion | Facts / corrections | Verbatim | Compactions / turnovers |
| --- | ---: | --- | --- | ---: |
| Native Basic | 141 s | 24/24, 6/6 | **1/3** | 4 |
| Plugin in-place | 80 s | 24/24, 6/6 | 3/3 | 3 |
| Plugin windowed | 79 s | 24/24, 6/6 | 3/3 | 4 |

All 24 pages were verified in real requests and all archive byte audits passed. The windowed arm also passed an actual host restart and history-consistency check. None of the three runs voluntarily called `new_context` or `compress`; all four windowed replacements remained extractive. A different model does not automatically create an orchestration mechanism.

## Calibration, environment and delivery

- Preserve three calibration attempts separately: low reasoning exhausted the 2048-token output cap; an off-reasoning diagnostic attempted five denied historical calls; an empty tools array caused local vLLM HTTP 400. None is included in the nine matched samples.
- **The settings incident is closed by user decision:** the initial rc.1 `session/selectModel` calls also saved the global default as Qwen / low. The user explicitly requested no restoration; that setting remains. Subsequent isolated samples and all three Muse gates preserved global settings hashes. Preset files and profile manifests were not edited.
- Runtime hash remains `8840d4c709e01d5cc3b6cce528f220e6f9009d30d7ad3fcc9c9e621f3a2a8a6a`, matching the installed candidate. No npm publication.
- `npm run check` passed: 187 unit, 86 host integration and 15 experiment-tool tests, plus type checking and build.
- Raw output, failures, stream events and runner snapshots remain under ignored `.test-runtime/turnover-muse-20260915/`; autonomous-reading gates are under `.test-runtime/nightly-20260915/muse-*-91503/`. Public data contains selected metrics, not credentials, browser-authentication URLs, settings copies or model text.

This is a fixed-prefix pilot with approximately 79 KB of synthetic source, not a 400k long-run test. Real pressure prediction, very short preparation lead times, integrated suffix retention, cloud concurrency/rate limits and another main-model pairing remain untested. The next candidate should integrate snapshot-scoped replacement, raw suffix retention and dynamic byte budgeting, then run pressure-triggered long-horizon model gates.

## Reproduce

```sh
# Run one sample, inspect it, then choose the next. Names must be unique.
node tests/live/turnover-muse.mjs --arm=C --seed=91511 --name=unique-c
node --import tsx tests/live/turnover-audit.mjs .test-runtime/turnover-muse-20260915/unique-c
node tests/live/turnover-muse.mjs --arm=C --seed=91514 --fault=late --name=unique-late
node --import tsx tests/live/turnover-seed-budget.mjs
node --import tsx tests/live/turnover-suffix.mjs

# Existing product windowed gate with Muse as main model; change arm for controls.
node tests/live/local-short.mjs --name=unique-muse --route=muse \
  --arm=C400_WINDOWED --family=F3 --seed=91503 --pages=24 \
  --pressure=32000 --batch=6 --concise=true --restart=true
```

Runners explicitly use the pinned repository-local rc.1 binary, existing isolated profiles and private settings paths, never the global newer `dsh`. Budget/suffix probes require the retained real Muse handoff. Do not reconstruct reports or calibration classifications without their underlying evidence.
