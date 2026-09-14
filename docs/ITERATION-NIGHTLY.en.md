# Short-cycle overnight iteration (2026-09-15)

[简体中文](ITERATION-NIGHTLY.zh-CN.md) · [Prior 150k iteration](ITERATION-150K.en.md)

## Current result

Candidate 7 is now under validation: explicit continuation feedback for empty scan-limited search pages, with matching tool guidance. Its 187 unit, 75 host integration, eight driver tests and prepack passed; the retained 432-page original-text component passed 3/3 and short three-arm probe regressions are underway. Candidate 6 remains a stage checkpoint; its complete reading journeys are not reassigned to candidate 7.

The project has reached the sixth nightly post-0.1.1 repair candidate, still targeting pinned host 0.1.2-rc.1. Retrieval indexing, response packing, safe-range guidance, real status output and the emergency checkpoint's actual byte cap are fixed and verified. In-place B completed the task that previously timed out. Final short-cohort A/B passed completely; C passed facts, corrections and diagnosis but scored verbatim 2/3, so the three-arm cohort is not an all-pass result. New F5 citation and F6 restart probes passed completely with original-source/archive audits.

Final prepack passed 187 unit, 74 host integration and eight driver tests. The delivery package's executable code and type declarations match the model candidate: only the changelog, source maps and corresponding chunk filenames/import references changed, with a retained per-file comparison. npm publication has not been performed.

Baseline: `ac9e2a8`, unpublished changes after 0.1.1. Use only the local Qwen3.8-27B-NVFP4KV-384K route (393216 capacity), pinned DSH 0.1.2-rc.1, and the two authorized isolated test profiles. Preserve daily profiles, the global host and preset files.

Run one discriminating experiment at a time and inspect its result before choosing the next. Ordinary runs have a 25-minute wall limit, 420-second request limit and 600-second turn limit. Progress is recorded every 15 seconds; a 30-minute task heartbeat checks for failures and continues iteration. A lock prevents duplicate runs, separate directories retain failures, and shutdown owns the experiment host. A run over 30 minutes requires a recorded, irreplaceable long-journey validation purpose.

Goals: broaden beyond the original F1 seed to diagnosis, citations, corrected state and real restart; run short three-arm Web/model gates and regression/integration/build/package checks on the final candidate; measure retrieval performance and implement evidence-supported fixes; preserve failures and distinguish model, harness, plugin and infrastructure causes.

The local 393216 capacity cannot reproduce a 400k pressure line on the former 1000000-capacity route. Short experiments reduce the working window while retaining compaction/retrieval mechanisms; absolute capacity boundaries need separate controlled host checks. The prior v11 journey took about 88 minutes, so it is unsuitable as the default rapid iteration unit.

| Run | Variable and hypothesis | Result | Next decision |
| --- | --- | --- | --- |
| C baseline / F3 / 91501 / 48 pages | New diagnosis task and seed; 48k pressure, six-page batches | All 48 pages entered real requests; 25-minute timeout during the fact probe, quality unscored; all six archives passed byte verification | Fix misleading range guidance, then repeat the same condition |
| C candidate 1 / same condition | Identical prompts; range protection/guidance and retrieval improvements | All 48 pages read in about 829 seconds; fact probe hit its 600-second limit; 1433 seconds overall; seven archives passed byte verification | Retain failure; distinguish step allowance exhaustion from actual headroom |
| C candidate 2 / F3 boundary fork | Official fork at candidate 1's completed fourth phase; only retrieval error classification changes | Both probes completed in 506 seconds: facts 24/24, corrections 6/6, diagnosis passed, verbatim 3/3; inherited prefix and archive audits passed | The model chose more specific queries and never exercised the new allowance error; improvement cannot be attributed solely to error classification |
| C candidate 3 / F3 / 91503 / 24 pages | Clarified query guidance; 32k pressure, six-page batches and concise phase completion | Deliberately stopped at about 405 seconds after 13 pages: real status omitted the fresh ranges promised by guidance; unscored | Fix the real status callback and interrupted-run evidence reconciliation |
| C candidate 4 / same condition | Add safe ranges to real status; budgets and task configuration unchanged | Complete pass in 901 seconds: facts 24/24, corrections 6/6, diagnosis passed, verbatim 3/3; four windows and byte audit passed | Four caller-selected budgets were still misreported as low headroom during verbatim recovery; fix this feedback first |
| C candidate 5 / F3 / 91503 / 24 pages | Clarify minimum retrieval budget; reading instruction v2 specifies page order and full batches | Complete pass in 697 seconds: facts 24/24, corrections 6/6, diagnosis passed, verbatim 3/3; four windows, one in-place compaction and byte audit passed | Final three-arm cohort shares v2; timing versus candidate 4 is not solely a plugin effect |
| A native / same final fixture | Native Basic at its default 80% threshold; reading instruction v2 | Complete pass in 292 seconds: facts 24/24, corrections 6/6, diagnosis passed, verbatim 3/3; all 24 pages passed exposure audit | Native default threshold did not trigger compaction; continue with the same-fixture in-place arm |
| B in-place / same final fixture | Same 32k pressure and default nudges as C; change only the strategy | Ended at 738 seconds: 600-second fact-probe timeout, unscored; six in-place compactions, zero windows, archive byte audit passed | Repeated retrieval occurred during the probe; preserve failure and assess nudge configuration |
| C quiet / same final fixture | Set only the existing `autoNudge` option to false | Completed in 570 seconds: facts 24/24, corrections 6/6, diagnosis passed; verbatim 0/3, byte audit passed | All three selected the second observation; do not adopt the configuration |
| C default / F6 / 91502 / 24 pages | New state task and seed; real restart before blind probes | Complete pass in 498 seconds: facts 24/24, corrections 6/6, state passed, verbatim 3/3; distinct host processes yielded identical history hashes, archive byte audit passed | Retain candidate 5 restart evidence; first fix the real-cap truncation found in B |
| B candidate 6 / F3 / 91503 / 24 pages | Preserve user amendments and exact records within the actual emergency byte grant | Complete pass in 955 seconds: facts 24/24, corrections 6/6, diagnosis passed, verbatim 3/3; five in-place compactions, zero windows, all summaries within 4096 bytes and original-byte audit passed | Fixture and issued prompts match; continue with candidate 6 windowed arm |
| C candidate 6 / same final fixture | Keep default window strategy and nudges; validate the shared emergency fix | Completed in 482 seconds: facts 24/24, corrections 6/6, diagnosis passed, verbatim 2/3; four windows, no in-place fallback, byte audit passed | PAGE-1 lookup was omitted and its answer had no source match; retain quality failure |
| A candidate 6 control / same fixture | Native Basic default threshold; identical six task prompts | Complete pass in 365 seconds: facts 24/24, corrections 6/6, diagnosis passed, verbatim 3/3; 24-page exposure audit passed, default threshold did not trigger compaction | Final candidate arms share fixture and six prompts; retain C's quality failure |
| C candidate 6 / F5 / 91504 / 32 pages | New citation task; source page IDs differ from fact IDs | Complete pass in 713 seconds: facts 24/24, corrections 6/6, citations 3/3, missing values null, verbatim 3/3; four windows, one in-place fallback and byte audit passed | Facts/citations used 17 history calls; verbatim used three; continue real restart verification |
| C candidate 6 / F6 boundary fork / first attempt | Fork the audited candidate 5 reading boundary and restart | Harness error after six seconds, zero model calls: cold list had no cursor and the manually seeded snapshot missed inter-turn events | Preserve failure; repair the harness before retrying the same validation |
| C candidate 6 / F6 boundary fork / repaired harness | Same plugin candidate; compare complete raw history and real host pages | Complete pass in 430 seconds: facts 24/24, corrections 6/6, state passed, verbatim 3/3; 2,183 raw events and 242 paginated events matched across processes, byte audit passed | Probe-only replay, not a new 24-page reading journey |
| C candidate 6 / legacy F1 / 70101 / 432-page comprehensive probe | Preserve original 150k pressure, 203531 window and 32768 output reserve; skip repeated reading | Exited after 424 seconds: initial request reached its 420-second deadline, quality unscored; byte audit passed | Skip comprehensive fact generation and test three original sources directly |
| C candidate 6 / same-boundary verbatim probe | Ask only PAGE-34, 138, 267; same geometry and deadlines | Exited after 604 seconds: 600-second turn timeout, unscored; seven searches, five empty scan-limited pages and zero continuation calls; byte audit passed | One offline continuation found PAGE-267; repair continuation guidance |
| C candidate 7 / same-boundary verbatim probe | Change only scan continuation feedback/tool guidance, preserving budgets | Completed in 249 seconds, verbatim 3/3; seven history calls, one hint and one cursor continuation; byte audit passed | Same fixture, boundary, geometry and actual question verified; component evidence, not a full facts gate |
| C candidate 7 / F3 / 91503 / 24-page boundary fork | Replay candidate 6's audited reading boundary without repeated page reading | Running | Review facts, corrections, diagnosis and independent verbatim recovery before choosing the next arm |

Raw evidence and recovery state remain private in `.test-runtime/nightly-20260915/`. The baseline driver and per-run snapshots remain in the private run directories; model-test tooling is excluded from the npm package.

Subsequent runs use the tracked single-run driver: `npm run test:live:local -- --name=<unique-name> --arm=C400_WINDOWED --family=F3 --seed=91501 --pages=48 --pressure=48000 --batch=6`. Review the prior result before each run. `--restart=true` adds a real restart; `--concise=true` changes phase prompts and must be recorded as a separate variable. Offline `node --import tsx tests/live/local-audit.mjs <private-run-directory>` checks original source exposure and archive bytes. [Sanitized model records](data/nightly-model-2026-09-15.json) retain the timeout.

`--fork-from=<completed-reading-run>` uses the host's `session/fork` at the completed fourth-phase boundary. The source must be stopped with all pages read; fixture, window and prompt configuration must match. Inherited evidence and new requests remain separate. The audit verifies the inherited event prefix and original-page requests from the parent. These runs are labelled probe-only replays, with inherited pages excluded from the count of new reads.

The subsequent complete three-arm gates use 24 pages, 32k pressure and `--concise=true` to reduce repeated reading and long phase replies. Starting with candidate 5, reading instruction v2 replaces ambiguous "increasing batches" with ascending page order and full batches; all three arms share v2. The 32k setting leaves room for host setup and two protected recent steps. Native retains its default 80%-of-route-capacity threshold; the two plugin arms share 32k pressure. Native is therefore a default-behavior reference, not a same-window compaction-algorithm comparison.

## Offline improvements and model gates

Reusing source lookup tables for immutable ledger revisions reduced median missing-query latency from 17.09 to 5.55 ms on the ordinary 100001-event/1100-archive fixture, and from 230.83 to 152.33 ms on a short-source-text variant. Eight alternating measurements per implementation were taken on the same machine. These are synthetic microbenchmarks, not model-task speedup ratios.

Eight further alternating measurements on the final candidate measured about 14.05 to 4.37 ms on the ordinary fixture and 182.21 to 122.10 ms on the short-source fixture. Both sampling rounds remain available; the first round was not replaced with a favorable selection.

Pricing actual serialized search-hit bytes increased the example 1536-byte response grant from one hit/402 bytes to five hits/1072 bytes. Unicode/escaping, pagination completeness, exact response bounds, ledger updates and session isolation regressions passed; the current 187 unit tests, 74 host integration tests, eight driver tests, typecheck, build and prepack passed. Final candidate 6 is installed in the designated test profile: native A and in-place B passed all quality checks; windowed C scored verbatim 2/3 with the remaining checks passing. Candidate 5's B timeout and candidate 6's C quality failure are both retained. This is not an all-three-arms pass.

[Sanitized performance data](data/nightly-performance-2026-09-15.json). Raw responses and failures remain private.

## F3-driven range guidance fix

During baseline phase two, guidance advertised `seq 5249..5249` as 13 messages and about 19441 tokens. Replay showed pairing adjustment had reduced it to a host-regenerated skill catalog. The model prepared compression, received `no-net-reduction`, then spent further calls recovering. Another replay exposed outward balancing crossing the protected current user.

The final span is now checked again for protected nodes, counts and reclaimable tokens are recomputed, and host-regenerated snapshots share the classification used by actual savings checks. No range nudge is issued when no safe range is available; budget guards remain active. Three discriminating regressions failed before the fix and passed after it. At this stage, **187 unit + 69 host integration tests**, four driver cancellation and stream-observation checks, build and real prepack passed; final counts appear above.

Baseline phase times were about 386/491/349/110 seconds; candidate 1 took about 189/380/98/162 seconds. Neither completed all probes. The tracked `tests/live/local-short.mjs` runs one item at a time, supports real restart, boundary forks and native default plus plugin in-place/windowed arms, and never queues a serial cohort automatically.

## Step allowance versus actual headroom

Candidate 1 issued several parallel fact queries. Its last two exhausted the shared step allowance but received `insufficient-headroom`. The model compressed before retrying even though the next step would replenish that allowance. Candidate 2 returns `retrieval-step-allowance-exhausted` with guidance to retry fewer parallel calls in the next step. Actual low headroom retains its original error, and no budget is enlarged. Regressions distinguish both conditions and verify replenishment. Five driver cancellation, stream-observation and inherited-history cursor checks pass.

Candidate 2's first request delivered content after about 0.54 seconds but took about 212 seconds to generate 2873 output tokens, indicating decode dominated that request. Success also coincided with more selective queries: at the same inherited boundary, the first five `F17` hits contained no target assignment, while `F17 =` returned two without pagination. Candidate 3's tool guidance recommends adding adjacent source punctuation or words when short IDs collide with unrelated hashes or prose. Matching semantics stay unchanged. Microbenchmark samples and model timing are reported separately.

## Real status and interrupted evidence

Candidate 3 called `arc_status` for fresh references, but the real `contextStatus` callback returned JSON without ranges. Existing tests covered only the fallback text implementation used without that callback. Candidate 4 adds the current surface and up to six newest safe ranges to real status, with an explicit empty array when none exist. Two real-path regressions failed before the fix and pass after it, covering references after replacement and protected-only input.

When a sample is interrupted, its last completed-turn snapshot can lag behind the streamed events. The driver and auditor now reconcile both by seq, explicitly rejecting conflicts or gaps. Candidate 3's old snapshot showed zero archives; reconciliation verified three compactions, all 13 read pages entering real requests, and 105381 original archive bytes. It remains deliberately interrupted and unscored. Original logs, intervention reason and both audits are retained.

## Caller-selected retrieval budgets

Candidate 4 passed, but its verbatim probe took about 316 seconds and 19 history-tool calls. Four `decompress` calls selected `maxTokens` of 512 or 300, below the minimum 768 needed for the response envelope, yet received `insufficient-headroom`. The model lowered the allowance further and reconstructed values from search snippets. Candidate 5 returns `requested-budget-too-small`, the minimum and a retry example, and documents the lower bound. No budget is enlarged. All four retained calls now receive the correct classification; retrying with 1024 recovers each exact checksum within that limit.

Candidate installation and package-name validation honor `EXPERIMENT_DSH_BIN`, defaulting to the repository's pinned host rather than global `dsh`. Prepack test-count parsing supports both TAP and Node's text summary format.

Candidate 5's verbatim probe took about 110 seconds and six history-tool calls, versus about 316 seconds and 19 calls in candidate 4. Conversely, candidate 5's fact probe took about 443 seconds versus 204, including extensive optional-compaction reasoning and a repeated compression call. The existing `autoNudge: false` option was subsequently assessed independently, as recorded below. Variation across model runs is not already proof of a nudge-policy benefit.

## Older long-history compatibility

The current reader audited the retained v11 F1/70101 432-page journey offline: all 432 pages had entered real requests, 574 request-object hashes matched, and all 11936207 original bytes in 15 archives were restored through 5116 segments. Public aggregates distinguish the old journey candidate hash from the current reader source hash. This is historical compatibility evidence, with no new model requests; it is not a new 432-page end-to-end run.

The B in-place fact probe issued 30 searches and one decompression. Eleven calls were rejected by the existing 20-grant turn allowance; at least three queries were repeated. Archive bytes remained intact, but the model did not finish within the turn deadline. This arm is unscored, not a retrieval-data-loss finding or a quality pass.

Observed nudge events: default C candidate 5 injected one, while B in-place injected none. B's timeout therefore cannot be attributed to nudges. The quiet C experiment tests only the configuration difference from default C.

The quiet sample did not establish a stable benefit: its fact probe took 234 seconds, but verbatim recovery took 195 seconds and scored 0/3. The model mistook `.1` (the second observation) for the first; returned characters matched the originals. Product `autoNudge` therefore remains true. A single sample cannot establish that disabling nudges caused the ordinal mistake. F6 restores default nudges and checks exact equality of paginated history before and after a real restart.

## The actual emergency-checkpoint byte grant

B exposed mismatched budget layers: a larger value-ranked checkpoint was cut chronologically to 4096 bytes, undoing evidence selection. The recent-work appendix was appended afterward, producing checkpoints around 4.6–4.7 KB. Candidate 6 shares the existing window user-history and exact-record indices, assembles within the real byte grant, and charges only still-visible recent calls to that same grant. The emergency instruction filter remains active.

Real-host regressions at 768/4096 bytes fail on the old implementation and pass after the fix; the initial malformed fixture log is retained too. All new summaries in three offline B-boundary replays fit 4096 bytes. At the critical two-compaction boundary, visible latest facts increased from 10 to 22. This is literal-preservation evidence; the subsequent candidate 6 in-place model run is recorded below.

At the same retained boundary, using the same host meter and 4096-byte configuration, two warmup rounds and eight alternating measurements reduced median full emergency-transaction time from about 18.88 to 6.37 ms. All raw samples remain available. This measures offline transaction CPU cost, not model-task speed or statistical superiority.

Candidate 6 B took 466 seconds and three history calls for facts, then 278 seconds and six calls for verbatim recovery. It completed the task the former B run did not finish. Its 955-second complete journey must not be compared as task speed against the previous 738-second timeout exit.

The local driver exposes only the validated native-default, plugin in-place and windowed arms. The old 400k study's calibrated Basic configuration is not directly ported because its retention ratio does not fit these reduced windows. A missing night-state file is initialized rather than requiring a privately prepared file.

Candidate 6 C returned a PAGE-1 checksum absent from every source page, while looking up only the other two pages. This run never exercised the changed finite-budget fallback, and the shared window-index function bodies were verified identical to the previous implementation. This is not evidence of archive corruption, and candidate 6 must not be described as an all-three-arm pass.

## Cold-session and fork restart observation

The first final-candidate F6 fork exited before model generation. The pinned host's session list does not guarantee a cold projection cursor, and its official fork includes events between the completed turn and the next `turn/start`. The driver now pages from an observed cursor, captures complete snapshots on creation/model selection and audits the actual inherited prefix. It checks only known synthetic inherited probe queue items to avoid submitting duplicates; the host reported this item was already not pending.

A real-host reproduction without model calls preserved all 2,185 raw events across process restart. Two added regressions bring the driver suite to eight passing tests. The model replay verifies both raw events and host-paginated events; a hash of paginated non-chunk events is no longer described as a full raw-event hash. Earlier candidate 5 paginated restart evidence retains its original scope.

An offline citation-seek replay at the F5 boundary searches each specific fact, then reads offset 0 of the same source seq/path to recover its heading. Six bounded calls and 4288 response bytes verify the three citations. This demonstrates a path supported by existing interfaces, not a measured model-task speedup; no response budget or default policy was enlarged.

## Scan limits and genuine absence

The comprehensive legacy probe waited 48.5 seconds for first content and generated 13164 reasoning characters before timing out without an answer. The narrower verbatim probe found the first two sources but kept rewriting the third query and rescanning the same prefix. Five empty pages reported `scanBudgetReached: true` and a continuation cursor; the model used none of those cursors.

At the same boundary offline, the initial query returned no hits, one cursor continuation found PAGE-267, and decompression recovered the complete checksum. Candidate 7 adds a fixed explanation only to empty scan-limited pages: keep query/limit unchanged, continue nextCursor, and do not interpret this page as proof of absence. Nonempty pages retain their existing packing and budgets; scan and retrieval-call limits are unchanged. A late-source regression at the minimum 1100-byte search grant failed before the fix and passes after it.

`--probe=verbatim` is allowed only for audited reading-boundary forks. It skips comprehensive fact generation and scores three original values, reporting `verbatimOnlyPassed` separately. A component pass cannot become `allQualityPassed` or a new end-to-end journey pass.

The candidate 7 replay exercised one new hint followed by one cursor continuation and recovered all three originals. The earlier candidate timed out after 604 seconds without a score; this run completed in 249 seconds. This shows the intended feedback mechanism was used, not a statistical speedup inferred from a timeout versus a complete task. Eight alternating candidate 7 microbenchmark measurements gave 14.15 → 4.63 ms for the ordinary fixture and 179.49 → 121.12 ms for short original text; every sample and earlier round is retained.

Candidate 7 changes retrieval feedback only. Its three-arm regressions reuse each candidate 6 arm's audited completed-reading boundary and issue the same two blind questions on the same fixture. These verify the final reader/model interaction and are explicitly labeled probe regressions; full reading/compaction journeys remain candidate 6 evidence. Each arm is reviewed before the next starts.
