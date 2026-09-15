# Short-cycle overnight iteration 4 (2026-09-15, candidate 10: adversarial audit and native comparison)

[简体中文](ITERATION-NIGHTLY-4.zh-CN.md) · [Previous cycle (candidate 9)](ITERATION-NIGHTLY-3.en.md)

## Current result

This cycle does two things: it attacks candidate 9 adversarially, and it puts native Basic on the **same trigger point and the same retention** for a real compaction-algorithm comparison.

The audit found and fixed one real contract defect: the `search_context` description claimed it searched "summaries and original content", but the index only covers archived originals. Candidate 8's `absent: true` turned that from vague into an **authoritative false conclusion** — a phrase written into a checkpoint was reported as genuinely missing. The fix makes the description match the implementation: the index covers archived originals, summaries are not indexed.

The audit also tried "index the checkpoint text too", and **its own retained data falsified the idea**: every added hit was the model's own echo of an original inside the checkpoint (`seq 335 tool/result: …`), and it measurably displaced an independent original hit. That change was reverted and only the description fix remains; ADV6 now locks "checkpoint echoes must not enter the index and must not displace originals".

On the native side, the old `A_NATIVE` arm used the shipped 80% threshold against a 393216 model window and therefore never compacted, so it was never a compaction comparison. New `--matched-native=true` moves Basic's trigger to the plugin's 32000-token emergency line and its retention to the plugin's 19555-token turnover target (ratios 0.08138 / 0.04973 of the 393216 window). With that match, **both native samples failed to finish** (one 600-second turn timeout, one 25-minute wall timeout), and Basic's separate summary LLM calls consumed 890/1026 s and 1368/1500 s of model time. The plugin finished the same fixture in 443 s with 174 s of reading and facts 24/24, corrections 6/6, verbatim 3/3.

## Adversarial audit

| Attack | Result |
| --- | --- |
| Query lengths swept across the snippet budget (1…130 code points) | Pass: for ≤100 code points the queried literal stays fully visible and the snippet never exceeds 100 |
| Line opening built from surrogate pairs (40 emoji) | Pass: the lead starts at its own record and never splits a pair |
| CRLF line endings | Pass: the lead does not start at the previous line ending and still names the record |
| Empty archive | Pass: no `absent` claim (nothing inspected) |
| Nested archives plus an unrelated prior query (ownership dedup) | Pass: a real hit is never hidden and a full scan can still claim absence |
| A phrase that exists only in a checkpoint | **Defect found**: `hits: 0, absent: true`; description corrected, ADV6 locks summaries out of the index |
| A hit in a later block | Pass: a later original is never reported absent |

Seven adversarial regressions (ADV1–ADV7) pass; the failed summary-index experiment is retained only in the private directory, not in the product.

## Matched native Basic comparison

Fixture and pressure: F3 / 91503 / 24 pages / 32k pressure / batches of 6 / `--concise=true`, pinned host 0.1.2-rc.1, local Qwen3.8-27B-NVFP4KV-384K route.

| Arm | Trigger / retention | Pages | Compactions | Separate compaction LLM calls | Compaction time | Model time | Quality |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Native default 80% | 314572 / 62914 tokens | 24, 365 s | 0 | 0 | 0 s | 382 s | 24/24, 6/6, verbatim 3/3, passed |
| Native matched r3 | 32000 / 19555 tokens | 19 then 600 s turn timeout | 5 | 7 | 890 s | 1026 s | unscored |
| Native matched r4 | 32000 / 19555 tokens | 3 phases then 25-minute wall | 7 | 9 | 1368 s | 1500 s | unscored |
| Plugin (this build) | windowed, emergency 32000, turnover target 19555 | **24, 174 s** | 4 | **0** | 0 s | 458 s | 24/24, 6/6, verbatim 3/3, passed |
| Plugin (candidate 5) | same | 24, 142 s | 5 | 0 | 0 s | 712 s | 24/24, 6/6, verbatim 3/3, passed |
| Plugin (candidate 6) | same | 24, 146 s | 4 | 0 | 0 s | 496 s | 24/24, 6/6, verbatim 2/3, not all quality |

Three structural differences:

1. **Where compaction cost lives.** Basic issues separate summarisation LLM calls (68–186 s each) that took 87% / 91% of matched-arm model time; the plugin's summaries are written by the agent in its own turn, so its separate compaction calls are zero.
2. **Reversibility.** The native model had **no historical retrieval tools at all** (no `search_context`/`decompress`/`compress`/`arc_status`/`new_context`); once Basic compacts, originals are out of the model's reach. The plugin's hit snippets and verbatim probe answered correctly after four window turnovers precisely because those tools exist.
3. **Native wins when nothing needs compacting.** The fixture is ~42k tokens against a 393216 window; with the default 80% threshold Basic never compacts and passes in 365 s. The plugin compacted four times only because the experiment forces a 32k working window to exercise the mechanism — that is a test design choice, not a product default.

## Verdict: is it good enough

**Where compaction is actually required, candidate 10 is clearly better than native Basic and is already usable; it is still not lossless and not a statistical superiority.** Concretely:

- Good enough: at the same trigger and retention, the plugin read all 24 pages in 174 s, finished in 443 s and passed facts, corrections and verbatim; both native samples failed to finish. Reversible retrieval answered verbatim correctly after four turnovers.
- Not good enough to over-claim: these are single-sample model runs (native failed twice; the plugin passed quality in two of three, with one 2/3 verbatim); the 32k pressure is artificial; the matched native arm is a tuned Basic, not the shipped default.
- The operative caveat: if a task fits the model's native window, Basic does not compact, is faster and is equally correct — the plugin's value appears only when compaction really happens.

## Delivery and limitations

New test file `tests/integration/experiment-adversarial-retrieval.test.ts` (ADV1–ADV7); new tools `tests/live/local-compare-runs.mjs`, `tests/live/local-native-comparison.mjs`, `tests/live/local-check-summary-gap.mjs`, `tests/live/local-check-summary-visibility.mjs`; records `.test-runtime/nightly-20260915/native-vs-plugin-comparison.json` and `run-comparison.json`.

Limitations: the matched native arm requires `retainRatio < thresholdRatio`, so it keeps the plugin's absolute turnover target rather than Basic's shipped proportion; the local 393216 capacity cannot reproduce larger-window boundaries; every model conclusion is a single sample.

## Reproduction commands

```bash
# Matched native arm (omit the flag or pass false for the shipped 80% default)
npm run test:live:local -- --name=<unique> --arm=A_NATIVE --matched-native=true --family=F3 \
  --seed=91503 --pages=24 --pressure=32000 --batch=6 --concise=true

# Plugin counterpart
npm run test:live:local -- --name=<unique> --arm=C400_WINDOWED --family=F3 \
  --seed=91503 --pages=24 --pressure=32000 --batch=6 --concise=true

# Offline aggregation and comparison
node --import tsx tests/live/local-compare-runs.mjs <run> <run> ...
node --import tsx tests/live/local-native-comparison.mjs
node --import tsx tests/live/local-check-summary-gap.mjs
```
