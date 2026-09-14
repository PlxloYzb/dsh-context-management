# Short-cycle overnight iteration 2 (2026-09-15, candidate 8)

[简体中文](ITERATION-NIGHTLY-2.zh-CN.md) · [Previous cycle (candidate 7)](ITERATION-NIGHTLY.en.md) · [Next cycle (candidate 9)](ITERATION-NIGHTLY-3.en.md)

## Current result

This cycle continues from candidate 7 and changes exactly one retrieval feedback path: the **ambiguity of an empty zero-hit page**. When a search runs to the end of the archive inside the scan limit without a match, it used to return the same bare empty array as a scan-limited page. It now returns `absent: true`, `inspectedMessages` and an explicit explanation that the literal occurs nowhere in the inspected archived history and the query should be rewritten. Scan-limited empty pages keep candidate 7's cursor-continuation hint, so the two states are no longer conflated. A page resumed from a cursor never claims absence, because the per-page `incomplete` flag describes only its own slice and cannot vouch for earlier pages.

An offline replay of all 162 replayable retained `search_context` calls shows seven such pages now report `absent` (five real historical pages plus two probe queries), while the 16 scan-limited and 139 hit pages keep an identical contract, packing and byte budget; there were zero errors and every empty page stayed within the 1100-byte minimum grant. Three discriminating regressions fail on the old reader and pass after the fix; an incomplete archive, an empty inspection and a cursor-resumed page never claim absence.

A new single-item `--probe=absence` probe (a real source literal plus a one-hex-digit near miss) was added. Candidate 7 and candidate 8 **both pass** it on the same audited boundary, so this 24-page boundary cannot discriminate the two candidates: the probe is retained as a no-regression gate, not as evidence of benefit. On the frozen candidate the three-arm full probe regression passed at 180/425/372 seconds for A/B/C with archive byte audits passing; the same candidate also produced one 850-second C-arm turn timeout, preserved unaltered and diagnosed as model strategy variance. Prepack, package audit, package-name install/remove and installed external consumer types all pass. npm publication has not been performed.

## Execution contract

Baseline `85fed80`; still an unpublished post-0.1.1 repair. Use only the local Qwen3.8-27B-NVFP4KV-384K route (393216 capacity) and pinned DSH 0.1.2-rc.1. Daily profiles, the global host and preset files are unchanged; the two authorized isolated test profiles are reused.

Run one discriminating experiment at a time and inspect its evidence before choosing the next. Ordinary runs have a 25-minute wall limit, a 420-second request limit and a 600-second turn limit; a lock prevents duplicate runs. All trade-offs are recorded in private directories and failures and null results are preserved.

## Goals and boundaries

- Continue removing ambiguous states from the retrieval contract, with every fix driven by a real retained scenario.
- Broaden verification: add a model probe aimed directly at proving absence, and keep its non-discriminating outcome on record.
- Re-run the three-arm regression on the frozen final artifact to confirm no regression.
- Preserve every failure; separate model, harness, plugin and infrastructure causes.

## Round log

| Run | Variable and hypothesis | Result | Next decision |
| --- | --- | --- | --- |
| Offline replay / 162 retained search_context calls | Replay with the new reader; cursor pages excluded because reader HMAC cursors cannot be replayed offline | Seven "ran to the archive end inside the limit" pages now report `absent`; 16 scan-limited and 139 hit pages keep their contract; 0 errors, empty pages 469 bytes | Verify with a real model probe that the model uses the signal |
| A control / C candidate 7 / F3 91503 / 24-page boundary fork | New absence probe: page 10's real `trace=` and a one-hex-digit near miss | Passed in 100 seconds: verbatim 3/3, `presentCorrect`, `absentCorrect`; the near miss was answered null after one search | Repeat the identical condition on candidate 8 |
| B treatment / C candidate 8 / same fixture and boundary | Only the candidate changes; probe and prompts identical | Passed in 164 seconds: verbatim 3/3; the near-miss literal received `absent: true` and the explanation | Both arms pass; this boundary cannot discriminate; demote to a no-regression gate |
| C candidate 8 / F3 91503 / 24-page boundary fork | Replay from candidate 6's audited reading boundary, skipping repeated page reads | Full pass in 276 seconds; byte audit passed | Freeze the source and re-run on the final artifact |
| Final-artifact C, first attempt | Rebuilt and reinstalled after tightening "no absence from a resumed page" | 850-second turn timeout: facts 24/24, corrections 6/6, diagnosis passed, verbatim unscored; the model switched to a generic `checksum=` search across three cursor pages plus a whole-block decompress | Preserve the failure; take one more sample on the same candidate |
| Final-artifact C, retry | Same fixture, boundary and prompts | Full pass in 372 seconds: facts 24/24, corrections 6/6, diagnosis passed, verbatim 3/3; one new windowed compaction | Continue with the in-place arm |
| Final-artifact B | In-place arm | Full pass in 425 seconds: facts 24/24, corrections 6/6, diagnosis passed, verbatim 3/3; two new in-place compactions | Continue with the native reference |
| Final-artifact A native | Retains its default larger window | Full pass in 180 seconds: facts 24/24, corrections 6/6, diagnosis passed, verbatim 3/3; zero compactions | Fixture and prompts reconciled; cycle regression complete |

Raw evidence lives in the ignored `.test-runtime/nightly-20260915/`. Candidate 8 records are `candidate8-cohort-comparability.json` and `candidate8-absence-ab.json`; the offline replay report is `search-feedback-replay.json`.

## Why the two empty pages cannot share one response

Retained runs show two very different empty pages returning one identical bare array:

- In candidate 4's fact probe the model wrote `latency=530ms; checksum=`, then `latency=180ms; checksum=` and `latency=853ms; checksum=`. Each scanned the whole archive inside the limit for zero hits, and each response carried no hint, leaving the model to permute blindly. The real source line is `latency=…; replicas=…; state=…; previous=…; checksum=…`, so no "latency immediately followed by checksum" literal can ever match.
- The failing B in-place arm searched the generic phrases `root cause` and `event order` once each, also with a full-archive zero hit and no hint.

The offline replay found five such historical pages (two in the B in-place arm, three in candidate 4), all returning `hits: [], scanBudgetReached: false, nextCursor: null` with no `hint`; the absence probe's two near-miss queries fall into the same shape, making seven. After the fix the same pages return `absent: true`, `inspectedMessages` and the explanation — for the two candidate 4 pages, 60 archived messages inspected. The response is 469 bytes, well below the 1100-byte minimum retrieval grant.

The guard is deliberately tight: all four of an uncut scan, a cursor at the archive end, an archive not flagged `incomplete`, and at least one inspected message must hold, and **the call must not pass a cursor**. The last condition is a correctness requirement: `incomplete` is computed only over the blocks the current page walked, so a resumed page cannot know whether earlier pages found missing or corrupt sources; only one pass starting at offset zero covers every block. "Cannot scan further", "incomplete archive" and "only saw the tail" therefore can never be misreported as "definitely absent". Hit pages and scan-limited pages keep their fields, packing order and byte budget unchanged.

## Discriminating regressions

New test R10b pins the contract: an empty page that scanned to the end reports `absent`/`inspectedMessages`/the explanation within 1100 bytes; a page with hits carries none of them; a scan-limited empty page keeps its cursor-continuation hint and never claims absence. R10b fails on the pre-fix reader and passes after the fix. New test R10c covers the correctness tightening: a 1.1M-character archive first returns a scan-limited empty page, and the resumed page that then reaches the end with zero hits must **not** claim absence. The R11 source-capacity regression gained the `incomplete` assertion. This cycle passes 187 unit and 77 host integration tests.

## The model probe and its null result

`--probe=absence` asks, on the audited 24-page F3 boundary, for the source page of a real `trace=` literal and of a one-hex-digit near miss, both or null. Both candidates answer correctly under the same fixture and prompts: the real literal resolves to `PAGE-10` and the near miss is reported null.

The A/B is therefore **pass/pass** and cannot show a correctness or retrieval-count benefit from the `absent` signal. The control used 2 retrievals / 25.6 seconds in its verbatim stage and the treatment 3 retrievals / 90.2 seconds; that single-sample difference is confounded by the model's own compaction choice (the treatment created one extra compaction, four archives versus three) and is not evidence of a cost or a benefit. Both probe queries are cursor-less first pages, so the later "no absence from a resumed page" tightening cannot have changed either result; R10c covers that guard. The signal's justification is the offline replay and the contract regressions above: it removes a real ambiguous state that demonstrably triggered wasted probing, and it has been confirmed not to regress anything.

## Three-arm regression (frozen artifact)

| Arm | Strategy | Facts | Corrections | Diagnosis | Verbatim | New compactions | Elapsed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A native | Default 80% larger window | 24/24 | 6/6 | passed | 3/3 | 0 | 180 s |
| B plugin | In place | 24/24 | 6/6 | passed | 3/3 | 2 in place | 425 s |
| C plugin | Windowed 32k | 24/24 | 6/6 | passed | 3/3 | 1 windowed | 372 s |

All three arms share candidate 7's fixture, boundary and two blind questions, and all pass their archive byte audits (A holds 0 archives; B and C added 2 and 1 compactions whose originals are fully recoverable). The same candidate also produced one 850-second C-arm turn timeout (facts 24/24, corrections 6/6, diagnosis passed, verbatim unscored), preserved unaltered: that sample used a generic `checksum=` search with limit 20 across three cursor pages (15 hits, all with `hits > 0`) and then decompressed a whole 2048-token block, instead of the line-anchored `Observation 1.0` query the passing samples used. It issued no cursor-less zero-hit search, so this cycle's change could not affect it; it is diagnosed as model strategy variance.

This is a probe regression forked from candidate 6's audited reading boundaries, not three new full reading journeys, and it is not a statistical efficiency claim.

## Delivery and limitations

Branch `codex/nightly-context-20260915`. The candidate 8 package is retained in the ignored directory `artifacts/nightly-candidate8-20260915/dsh-context-management-0.1.1.tgz` with SHA-256 `6963be6479f2adf92117b0ffa6120322a03ea1e63a4ee8f377e946eebebe64e7`; its 33 build files are byte-identical to the runtime installed in `ctx-v012-smoke-c` (entry `dist/index.js` is `fcc9d398355baf2ddbe94085f3a65f0dda15895ba2aaad6ec4eda64683780256`).

Final checks: 187 unit, 77 host integration and 8 driver tests; strict types, build, prepack, package audit (41 files), package-name install/remove with native command restoration, and installed external consumer types all passed.

Limitations: `absent` only holds for a cursor-less first page whose scan was not cut off in a complete archive, so many queries against the retained 432-page archive will either hit the scan limit or need continuation and receive no `absent`; this cycle did not re-run the full 432-page journey. The new absence probe is pass/pass on the 24-page boundary and is not benefit evidence. The three arms are inherited-boundary probe regressions and native keeps its larger default window, so this is still not a same-physical-window compaction comparison.

## Reproduction commands

```bash
# One local-model experiment at a time; review the result before the next.
export EXPERIMENT_DSH_BIN=$PWD/.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh
npm run test:live:local -- --name=<unique-name> --arm=C400_WINDOWED --family=F3 \
  --seed=91503 --pages=24 --pressure=32000 --batch=6 --concise=true

# Absence probe on an audited reading boundary (skips repeated page reads)
npm run test:live:local -- --name=<unique-name> --arm=C400_WINDOWED --family=F3 \
  --seed=91503 --pages=24 --pressure=32000 --batch=6 --concise=true \
  --probe=absence --fork-from=<audited-reading-run>

# Offline: replay every retained search_context call and check the empty-page contract
node --import tsx tests/live/local-replay-search-feedback.mjs

# Offline: check source exposure and archive bytes
node --import tsx tests/live/local-audit.mjs <private-run-directory>
```
