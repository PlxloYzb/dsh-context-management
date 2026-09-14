# Short-cycle overnight iteration 3 (2026-09-15, candidate 9)

[简体中文](ITERATION-NIGHTLY-3.zh-CN.md) · [Previous cycle (candidate 8)](ITERATION-NIGHTLY-2.en.md)

## Current result

This cycle changes one retrieval packing detail: **a hit snippet names the record it belongs to**. The snippet used to start exactly 32 code points back, which usually lands mid-line; for a generic value query such as `checksum=` it returned `"state=retrying; previous=delta; checksum=f47f1591b3…"`, giving the model no way to tell which observation matched, so it paid a whole 2048-token block decompress to find out — exactly the scene of candidate 8's first 850-second C-arm turn timeout. A snippet now leads with the containing line's opening text, for example `"Observation 1.0: service=beacon;…state=retrying; previous=delta; checksum=f47f1591b3…"`, while the matched literal and its local context stay inside the same 100-code-point snippet budget.

Offline replay of the retained runs: of 465 hits across 175 hit pages, 264 were mid-line hits whose record name the old 32-code-point window could not reach; after the fix **264 of 264 name their record**. Packing is unchanged: across the 158 calls present in both replays the hit count is identical (336 → 336) and total response bytes grow by 173, with no call returning fewer hits; the match is budgeted first, so a long query shortens the lead and the trailing context instead of truncating the literal.

The prefix only ever spreads a bounded slice: a block without newlines has the block start as its "line opening", so taking the prefix by block size would allocate a block-sized array on every hit. After bounding it, a 400k-character single-line block searches in a 0.15 ms median instead of 1.43 ms, and the model-visible response is byte-identical across 221 cursor-less retained calls and 498 hits, so the model gates below still hold for the final artifact.

On the frozen artifact the three-arm full probe regression passed at 115/509/356 seconds for A/B/C with archive byte audits passing; the same candidate also produced one C-arm sample at 386 seconds with facts 23/24 (it never searched F19 and answered a value present in no page), preserved unaltered. Prepack, package audit, package-name install/remove and installed external consumer types all pass. npm publication has not been performed.

## Execution contract

Baseline `1747178` (candidate 8); still an unpublished post-0.1.1 repair. Use only the local Qwen3.8-27B-NVFP4KV-384K route (393216 capacity) and pinned DSH 0.1.2-rc.1. Daily profiles, the global host and preset files are unchanged; the two authorized isolated test profiles are reused. Run one discriminating experiment at a time with a 25-minute wall limit; a lock prevents duplicate runs.

## Round log

| Run | Variable and hypothesis | Result | Next decision |
| --- | --- | --- | --- |
| Offline analysis / every retained hit | Measure each hit's distance from its line start in the original text | 264 of 465 hits (56.8%) were mid-line, so the old snippet could not name the record | Implement the line-opening prefix |
| Offline replay / 158 common calls | Snippet construction changes; budget does not | Hits 336 → 336, bytes 110931 → 111104, zero calls with fewer hits; 264/264 mid-line hits now name their record | Run a real model gate |
| C candidate 9 / F3 91503 / 24-page boundary fork | Replay from candidate 6's audited reading boundary | 386 seconds and strict pass, but facts 23/24: the model never searched F19 and answered a value absent from every page | Preserve the failure; take another sample on the same candidate |
| C candidate 9, retry | Same fixture, boundary and prompts | Full pass in 356 seconds: facts 24/24, corrections 6/6, diagnosis passed, verbatim 3/3 | Continue with the in-place arm |
| B candidate 9 | In-place arm | Full pass in 509 seconds: facts 24/24, corrections 6/6, diagnosis passed, verbatim 3/3 | Continue with the native reference |
| A native / candidate 9 | Retains its default larger window | Full pass in 115 seconds: facts 24/24, corrections 6/6, diagnosis passed, verbatim 3/3; zero compactions | Cycle regression complete |

Raw evidence lives in the ignored `.test-runtime/nightly-20260915/`; candidate 9 records are `candidate9-cohort-comparability.json`, `snippet-anchor-analysis.json` and `search-feedback-replay-candidate9.json`.

## Why a snippet must name its record

Candidate 8's first C-arm timeout: asked for the checksum on PAGE-1's first observation line, the model instead used the generic query `checksum=` with limit 20, paged three cursors for 15 hits, and then decompressed a whole 2048-token block. Every hit in those three responses looked like:

```
"state=retrying; previous=delta; checksum=f47f1591b3. This is diagnostic context, not a change to aut"
```

The record name `Observation 1.0:` sat outside the lookback window, so the model could not tell which hit was the first observation line and had to decompress. Passing samples instead queried `Observation 1.0` directly, showing that retrieval itself worked and only the hit's record identity was missing.

The fix adds only a prefix at snippet construction: when the containing line starts before the old 32-code-point lookback point, up to 32 code points of that line's opening are placed in front, separated from the local context by `…`; both share the existing 100-code-point cap, so per-hit bytes stay in the same range. The budget is priority-ordered — the matched literal is guaranteed visible first, then the lead and the local context — so a long query shortens the prefix and trailing text rather than cutting the literal. The same hit after the fix:

```
"Observation 1.0: service=beacon;…state=retrying; previous=delta; checksum=f47f1591b3. This is diagno"
```

## Discriminating, packing and allocation regressions

New test R10d builds two long records (the second containing Unicode and a surrogate pair) and asserts that every hit leads with its own record name (`Observation 1.0:`, `Observation 2.0:`), still contains the queried literal and value, and stays within the 100-code-point cap; it then uses a 70-code-point query to assert the **complete literal** survives in the snippet, i.e. the lead and trailing context yield to the match. New test R10e covers a block without newlines: the block start is the line opening, and the prefix must lead with it rather than allocating by block size. Both fail on the pre-fix reader and pass after the fix. This cycle passes 187 unit and 79 host integration tests.

The offline packing comparison uses candidate 8 as its baseline and only the 158 calls present in both replays: hit counts are identical, no call returns fewer hits, and total bytes grow by 173 (about one byte per call), confirming the prefix is almost entirely absorbed by the existing snippet budget. Bounded-prefix equivalence uses the committed candidate 9 (`99f372c`) as its control and compares the model-visible payload call by call: 221 cursor-less calls and 498 hits, zero differences (the cursor string itself is a random reader-local body and is excluded), so the three-arm model gates remain valid for the fixed artifact. A same-machine paired benchmark shows the single-line 400k block search going from a 1.43 ms median to 0.15 ms with identical snippets.

## Three-arm regression (candidate 9)

| Arm | Strategy | Facts | Corrections | Diagnosis | Verbatim | Elapsed |
| --- | --- | --- | --- | --- | --- | --- |
| A native | Default 80% larger window | 24/24 | 6/6 | passed | 3/3 | 115 s |
| B plugin | In place | 24/24 | 6/6 | passed | 3/3 | 509 s |
| C plugin | Windowed 32k | 24/24 | 6/6 | passed | 3/3 | 356 s |

All three arms share candidate 8's fixture, boundary and two blind questions, and all pass their archive byte audits. The retained failure `c9-f3-91503-24p-fork` (386 seconds, facts 23/24): the model **never searched F19** and answered `value-894f040a97`, a literal present in no fixture page. This cycle changes hit text only and has no path that could misread that value; the shape matches candidate 6 C's skipped PAGE-1 lookup, so it is diagnosed as a model retrieval-skip hallucination.

## Delivery and limitations

Branch `codex/nightly-context-20260915`. The candidate 9 package is retained in the ignored directory `artifacts/nightly-candidate9-20260915/dsh-context-management-0.1.1.tgz` with SHA-256 `784b27ebeec7b9f7ecdde242418bf21091af751af8054ced973d5700c5c58bda`; its 33 build files are byte-identical to the runtime installed in `ctx-v012-smoke-c` (entry `dist/index.js` is `f431724fab2755ada4e0d9a7d1bd3d64659abbb681b65446ecc0ad1c7c1cd80c`).

Final checks: 187 unit, 79 host integration and 8 driver tests; strict types, build, prepack, package audit (41 files), package-name install/remove with native command restoration, and installed external consumer types all passed.

Limitations: the prefix covers only the text after the previous newline within the same text block, so for a block without newlines the prefix is the block's own beginning and may not be the true record name; 379 of 465 hits already sit at the 100-code-point cap, so trailing context shrinks accordingly. Locating the line opening adds one bounded backward search per hit, about +0.1–0.3 ms across five queries on the 432-page benchmark, which is negligible against a single model call. The three arms are still inherited-boundary probe regressions and native keeps its larger default window, so this is not a same-physical-window comparison. The model gate is a single sample per arm and is not a statistical claim.

## Reproduction commands

```bash
# One local-model experiment at a time; review the result before the next.
export EXPERIMENT_DSH_BIN=$PWD/.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh
npm run test:live:local -- --name=<unique-name> --arm=C400_WINDOWED --family=F3 \
  --seed=91503 --pages=24 --pressure=32000 --batch=6 --concise=true \
  --fork-from=<audited-reading-run>

# Offline: measure each hit's distance from its line start and the packing delta
node --import tsx tests/live/local-analyze-snippet-anchor.mjs
node --import tsx tests/live/local-replay-search-feedback.mjs <output.json>

# Offline: compare the model-visible payload with a committed revision, and
# measure the single-line block allocation cost
node --import tsx tests/live/local-verify-snippet-equivalence.mjs
node --import tsx tests/live/local-bench-single-line.mjs
node --import tsx tests/live/local-bench-snippet-anchor.mjs
```
