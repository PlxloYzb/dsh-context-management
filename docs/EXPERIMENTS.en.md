# Comprehensive experiment protocol: 400k context management

[中文](EXPERIMENTS.zh-CN.md) · [Design](DESIGN.en.md) · [Historical tests](TESTING.en.md) · [Plan inventory](experiments/plan-v1.json) · [Execution report](EXPERIMENT-REPORT.en.md)

Protocol: `context-400k-v1`; date: 2026-09-09; status: **DESIGNED, NOT RUN; runner extensions required**. This is a preregistration for future testing, not a result or directly executable configuration. All pass criteria below describe future acceptance conditions.

Execution revision r1: the user confirmed the configured `zai-coding-cn` route, correcting the extra `z` before the first generation. Original preflight evidence is retained.

The only permitted live route is **`zai-coding-cn/glm-5.3-flash`**, with provider `zai-coding-cn` and model `glm-5.3-flash`, using the connection already configured in DSH. Verify every main, summary and model-assisted turnover call. No fallback to `opencode-go`, another provider, or another endpoint with the same model name. Controlled adapters are allowed only in explicitly labeled offline fault tests.

## 1. Questions and limits on claims

1. Is the plugin at least as good as native Basic at completing long tasks, retaining corrections, accessing history and recovering sessions?
2. With intervention near the same 400,000-token pressure line, does it improve cost or elapsed time? Is a benefit explained only by earlier intervention?
3. Can the 400k policy operate across multiple windows without repeated ineffective turnover? When does it prune, and when does it actually commit a window?
4. Do transactions, cancellation, crashes and installation/removal preserve host contracts and report incomplete recovery explicitly?

Historical Basic and windowed runs both reached 108/108 recall. Their budgets and provider differ from this protocol; those results neither establish superiority nor qualify as new controls. Valid outcomes include equal quality at greater cost, insufficient evidence, or inability to meet the 400k capacity prerequisite.

Native Basic already preserves an append-only source log. Source preservation alone is not an exclusive benefit. Test the differences in model projection, handoff, access to history and their total overhead. Here **400k means 400,000 decimal tokens**, measured as host-estimated active request input pressure. It is not cumulative session usage, billed input, or 409,600 tokens.

## 2. Environment and preflight gates

Fix one plugin 0.1.1 tarball SHA-256, lockfile, **DSH 0.1.2-rc.1**, and Node version for the primary experiment. Record OS, CPU, memory, actual DSH executable version, relevant host package versions, installed candidate inventory and Git commit/dirty state. A missing commit is null. Never substitute working-tree code for the installed candidate.

If daily DSH has been upgraded, prepare the target host in isolation. Other hosts are separate compatibility strata requiring installation and contract checks; do not pool their data. Matching type declarations do not establish Web/Loader compatibility.

| Gate | Required evidence | If unmet |
| --- | --- | --- |
| Route | DSH resolution plus actual `llm/stream` requests, including nonempty `purpose` calls | BLOCKED; no route substitution |
| Capacity | Resolved `contextWindow=C`, maximum output, capacity source and timestamp | Do not assume 1M; apply section 3 |
| Requests | Actual main output cap R=32,768; summary cap 8,192; same available temperature, top-p and reasoning settings | If unsupported, revise the entire protocol before pilot and recalculate budgets; never change one arm after results |
| Isolation | Test profiles, synthetic workspaces, dedicated ports and process ownership; protected local access to the existing connection | Do not change daily profiles, preset files or user sessions |
| Comparability | Same host system prompt, task prompts, general tools, pruner and request caps; record strategy-specific tools/prompts | Reject hidden overlays that alter an arm |
| Spending/time limits | Pilot estimates of request count, input/cache/output usage and p90 time; completed batch money or token ceiling, concurrency and timeouts | No confirmatory run without limits; writing this protocol makes no model calls |
| Freeze | Hashes of protocol, generator, answers, scorer, configurations, runner and observer; all planned samples persisted in advance | Changes require a new revision/batch; never overwrite failures |

Record unavailable model weight revisions and inference seeds as unavailable. A corpus seed does not make model output deterministic. Interleave arms to reduce time effects. On a detected route capacity/version change, end the current block and report it; do not silently pool across versions.

## 3. What 400k means and arm configurations

The current [governor](../src/governor.ts) computes:

```text
E = min(C, windowBudgetTokens) - R - S
nudge line N = floor(E × 0.75)
emergency pressure line T = floor(E × 0.90)
```

For R=32,768 and S=4,096:

| Logical window setting | E | N | T |
| --- | ---: | ---: | ---: |
| 400,000 | 363,136 | 272,352 | 326,822 |
| 481,309 | 444,445 | 333,333 | 400,000 |

The second row requires **C ≥ 481,309**. A smaller actual route capacity blocks the primary 400k experiment. Offline reliability tests may continue, but a smaller-window experiment is not completion of this protocol. The first row illustrates the formula and is not a primary arm.

Apply this C400 fragment to the existing bridge through an isolated profile overlay, without editing preset files. It is not a new CLI option:

```yaml
adaptiveGovernor:
  enabled: true
  strategy: windowed
  windowBudgetTokens: 481309
  maxOutputTokens: 32768
  safetyMarginTokens: 4096
  nudgeAtEffectiveCapacityPct: 0.75
  emergencyAtEffectiveCapacityPct: 0.90
  targetAfterTurnoverPct: 0.55
  emergencyFallback: true
```

Independently assert actual main `maxTokens=32768`. Numeric `maxOutputTokens` is a ceiling: smaller caller intent can reduce R and change T. `targetAfterTurnoverPct=0.55` is a recorded target, not a guaranteed hard postcondition in the current implementation.

| New arm ID | Backend/configuration | Purpose |
| --- | --- | --- |
| A_NATIVE | Native Basic, `auto=true`, default `thresholdRatio=0.8`, `retainRatio=0.16`, summary `maxTokens=8192`; common main R | Native default pressure policy; approximately 800k when C=1,000,000 |
| B400_BASIC | Same Basic, calibrate `thresholdRatio=400000/C` to exactly 400,000 using its actual rounding; otherwise identical to A | Control for earlier intervention |
| C400_WINDOWED | Candidate plugin with the governor above; archive seed=4,096, default retrieval=2,048, maximum=4,096 | Complete window strategy |

B's default retained tail `floor(0.16×C)` must be below 400,000. Otherwise revise a common retention policy before freezing; do not run an invalid control. If floating-point multiplication floors the Basic threshold to 399,999, calibrate the smallest increment and record the resolved ratio and threshold.

All arms use the same loaded pruner settings: `thresholdChars=8192 / headChars=4096 / tailChars=1024`; verify Unicode counting semantics. Split long material into results below the pruning threshold so it can actually accumulate to 400k. Exercise large results separately.

C/B matches a pressure line, **not every algorithm variable**. C can nudge at 333,333; retrieval tools, retention and summary methods differ. A/C estimates the entire product-policy difference; C/B estimates the strategy difference after approximately matching intervention pressure. Record retained tokens and tool lists. General tools match; native arms cannot use plugin-only historical tools.

### Intervention is not guaranteed turnover precisely at 400k

Checks occur at safe pre-step boundaries. Pruning followed by remeasurement can remove the need for turnover. The model may call `compress` or `new_context` earlier. A large tool result can overshoot; lack of a safe removable region can cause a budget error. The current version has no independent absolute input-turnover switch and does not promise never to exceed 400k.

Record `inputBefore → afterPrune → afterCommit → finalRequestInput`, N/T/R/S, measurement baseline, trigger, commit/defer reason, window ID and seq at each decision. Record compactions for every arm, but count window commits only where they actually exist. Pressure overshoot is `max(0,inputBefore−T)`; final logical request excess is `max(0,finalRequestInput−E)`. Keep deterministic boundary tests separate from live tasks where the model can choose its actions.

## 4. Stages and finite sample sizes

| Stage | Scope | Exit condition |
| --- | --- | --- |
| P0 Contracts | Existing regressions, installed-host controlled integration, offline cases below; no provider calls | No integrity/configuration defects; runner audited |
| P1 Pilot | 6 tasks, one per family, independent pilot seeds ×3 arms ×1 repeat = 18 session journeys | Capacity and actual 400k pressure reachable; all calls use correct route; scoring and limits work; exclude from confirmation |
| P2 Confirmation | 6 families ×5 seeds=30 independent tasks ×2 repeats ×3 arms = **180 session journeys** | Every assigned sample reaches a terminal status; no early success declaration |
| P3 Extensions | Live Web recovery, optional ablations/dose, scale and lifecycle | Separate tables; explicitly list unexercised items |
| P4 Audit | Source replay, request pairing, score/statistics reproduction, installed artifact identity | Traceable evidence including all failures and missing data |

Pilot data may guide runner repairs, variance and spending estimates. Freeze the final execution revision before confirmation. Thirty tasks do not guarantee power. Save a pilot-based simulation for 80% power at a 5-percentage-point quality margin and 10% efficiency effect using paired variance/discordance. If the budget cannot achieve it, the 180-session study can proceed only with a preregistered power limitation. Never enlarge the sample until significant; a larger study requires a new fixed-size protocol first.

Confirmatory seeds: `10000 + 100×familyIndex + variantIndex`, familyIndex=1..6, variantIndex=1..5. Pilot seeds: `90000 + familyIndex`. Repeats: 1 and 2. Randomization seed: 904009. Assign the six A/B/C orders exactly ten times each across the 60 paired blocks using a fixed shuffle. Default live concurrency is one session; arms are interleaved. No historical baseline reuse. Concurrency performance is a separate experiment.

Generate immutable material before execution. Each paired block uses identical content and pacing; never add pages based on an arm's turnover count. Long tasks target approximately **2,000,000 newly introduced estimated input tokens**, excluding repeated historical input, in roughly 20k reading batches made of small tool results. Freeze bytes, pages and hashes after pilot calibration. Report host estimates separately from provider usage. A large file on disk is not proof that its contents were read and sent to the model.

Each family has four long variants and one 80k–150k short variant, checking low-pressure overhead. C is expected to commit at least three windows for each long task. Missing this target is reported as insufficient multi-window coverage with reasons, never silently excluded. Short tasks do not require turnover or enter this coverage denominator. Do not change fixture length after seeing confirmatory results.

## 5. Six task families and full journey

| Family | Inputs/distractors | Deterministic deliverable |
| --- | --- | --- |
| F1 Facts/corrections | Chinese/English paths, IDs, numbers/units, old values, withdrawals and two updates across early/middle/late history | Exact 24-field JSON, including six latest-correction fields |
| F2 Code maintenance | Synthetic repository defects, cross-file dependencies, past decisions and changed requirements | Patch passes hidden functional checks, preserves protected files and latest requirements |
| F3 Diagnosis | Multi-service logs, false leads, cross-page timeline and corrected failed hypotheses | Root cause ID, event order, fix selection and source references against a prepared rubric |
| F4 Structured workflow | Schema/API changes, dependencies, unfinished work, sequential and parallel tool exchanges | Final state/interface validator; no duplicate synthetic side effect |
| F5 Historical retrieval | Same text at different seqs, similar/duplicate IDs, nested archives, old evidence, unanswerable questions | Exact values/source seqs; explicit ambiguity/missing answers |
| F6 Handoff/recovery | Long investigation, new user constraints, unfinished tool batches and goals | Deliverables, pending work and latest constraints survive restart; tools remain paired |

Every task has 24 historical facts, including six correction fields, plus a family validator. Seeds vary values, locations and distractors, rather than padding only with repetitive noise. Distribute locations equally across early/middle/late history, with at least one-third of facts before expected first intervention and one-third requiring cross-segment relationships. Corrections/withdrawals are explicit synthetic user instructions; untrusted historical text has separate provenance.

Fixed journey: create isolated session and select route → introduce task/facts → read batches and perform family work → updates at 25%/55%/80% progress → finish reading → blind Q1 and deliverable → wait for persistence and record final durable seq → stop/restart the actual DSH process → reopen the same session ID → blind Q2 and current constraints → independent source replay and pairing audit.

Neither Q1 nor Q2 includes expected answers or correctness feedback. Label Q2 as restart recovery after Q1, not an independent unprompted memory test. Crash-specific tasks include recovery without prior Q1. Keep scorers and hidden answers outside model-accessible directories and never expose them through tool results, prompts or archive indexes.

During F1/F5 and all historical fact probes, enforce denial of fixture rereads and network answer lookup at the tool-permission layer; a text instruction alone is insufficient. F2 may read working code but not validators/history answers; facts are separate from code-readable information. Plugin historical tools remain available to C, native capabilities to A/B. The independent validator may inspect raw logs but never feeds its findings to the model.

## 6. Reliability and boundary inventory

Each case needs its own status, fixed inputs, steps, assertions, seq/request evidence and failure details. Listed files are reusable starting points, **not a claim of complete existing coverage**. Implement missing tests before execution.

| ID | Action/boundary | Required assertions | Reusable entry |
| --- | --- | --- | --- |
| R01 | Real-host meter snapshots at T−1/T/T+1 with fixed R in P0 | Correct boundary; controlled model does not proactively switch; live near-threshold trajectory separate | `tests/governor.test.ts`, `tests/integration/policy.test.ts` |
| R02 | Small/large output intent, missing capacity, invalid ratios, reserve+margin≥capacity | Correct actual cap/recalculation; explicit errors; do not assume fixed400k | `tests/governor.test.ts`, `tests/config.test.ts` |
| R03 | Equivalent/changed system/tools/route headers; missing cache usage | Validated projection or conservative meter; no double ledger subtraction or fake usage | `tests/host-budget.test.ts` |
| R04 | Large/unprunable/Unicode results; after-prune below/above T | Prune then remeasure; no window needed after relief; check net benefit after snapshot reinjection | `tests/integration/refresh-budget.test.ts` |
| R05 | New input, pending/parallel tool pairs, input after intent | `new_context` accepts intent; safe pre-step commit; current input and pairing protected | `tests/tools.test.ts`, `tests/integration/window.test.ts` |
| R06 | Invalid/duplicate/out-of-order ranges; later invalid batch segment | Original prefix unchanged; successful segments recoverable; localized errors; later work usable | `tests/region.test.ts`, `tests/batch-compress-boundary.test.ts` |
| R07 | Failure at each transaction append/flush boundary; SIGKILL before/after persistence; repeated recovery | Append-only log; adjacent summary/replacement with host heuristicTokens; complete commit or explicit recovery error, no silent partial commit | `tests/seam.test.ts`, `tests/integration/crash.test.ts` |
| R08 | Cancel before commit/during summary/after commit, dispose, restart | Single pending-work owner; no duplicates, unresolved promises or work in another session; document claimed-input boundary | `tests/state.test.ts`, `tests/integration/loop.test.ts` |
| R09 | Pagination interruption, budget1/max/invalid, empty/missing/corrupt source | Bounded output; explicit incomplete/error; page concatenation equals original bytes | `tests/integration/archive.test.ts`, `tests/integration/retrieval-budget.test.ts` |
| R10 | Foreign session, fork, stale restart cursor, cross-block cursor, duplicate ID | Session-local source/cursor; reject invalid/ambiguous selection; no leakage | `tests/adversarial.test.ts`, `tests/live/verify-cohort.mjs` |
| R11 | Nested archives, same text/different seqs, index/cache caps | No silent omission; deduplicate shared sources without collapsing distinct seqs; explicit cap behavior | `tests/state.test.ts`, `tests/integration/archive.test.ts` |
| R12 | Fake system instruction in history/tool result, malicious handoff, fake new user | History remains data; current task preserved; log prohibited attempts using synthetic data only | `tests/adversarial.test.ts`; add live tasks |
| R13 | Image/file refs, missing attachments, restart access, long content | No invented content or meter bypass; source refs and unavailable status traceable | `tests/host-budget.test.ts`; add host/route capability checks |
| R14 | Native Web `/compact`, `/context status/new/search/decompress`, busy/error/no benefit | Correct native argument flow and result/sourceCommandId; count manual maintenance separately from turnover | `tests/integration/commands.test.ts`, `tests/live/ui-evidence.mjs` |
| R15 | Controlled overflow, multiple steps in a turn, next turn, failed retry | Bounded recovery/cancellation; record scope; current plugin overflow fuse resets per turn | `tests/integration/loop.test.ts` |
| R16 | Separate real provider physical-overflow experiment with its own spending cap | Error truly from specified route/capacity; recovered or explicit failure; NOT_EXERCISED if not triggered | `tests/live/physical.mjs`; needs overflow driver extension |
| R17 | standard/ptc/cordis/minimal; renamed/nested/switched-before-first-request/added-later | Replace Basic in its original realm; no-compaction/third-party backends unchanged; native command/pruner work | `tests/live/preset-coverage.mjs`, `tests/bridge.test.ts` |
| R18 | base/headless without agentPresets; repeat install/remove/restart; invalid config | Current bridge does not take over without agentPresets; document limit; restore backends elsewhere, preset hashes unchanged | `tests/release/lifecycle.mjs`, `tests/preset-compat.test.ts` |
| R19 | Package-name install/remove, fresh npm ci/pack, consumer type import | Prepack passes; external host deps, exact acp-kernel pin, no absolute reference imports, matching artifact identity | `tests/release/package-name.mjs`, `tests/release/audit.mjs`, `tests/release/consumer-types.mjs` |
| R20 | 100/1k/10k/100k events;1/10/100 windows; cold/hot queries;1/4/8 sessions | Latency, event-loop delay, heap/RSS/cache by scale; no leaks, unbounded scans or session contamination | `tests/performance/scale.ts`; matrix extension needed |

For R07, kill only exact owned PIDs/profiles, never processes matched by a broad name. In R08 the host may not requeue input already claimed but not yet logged. Report that boundary and recovery action; do not blame the model or count lost input as success.

P3 live Web minimum: independent F6 seeds91001..91003 × {cancel before commit, cancel while awaiting summary, SIGKILL after persistence} ×3 arms =27 recovery journeys. If no summary occurs, that condition is NOT_EXERCISED; a timed sleep does not establish it. Add R12's three injection types ×3 arms=9 journeys and R13's two supported attachment types ×3 arms=6. Audit R14–R19 per case; any necessary model calls for native entry/recovery checks enter the spending inventory. Exact transaction-gap kills belong in controlled host child-process tests, not provider timing guesses.

R20 fixes event/window pairs at 100/1, 1,000/10, 10,000/100 and 100,000/100, each with 1/4/8 concurrent sessions; do not construct impossible event/window combinations. Use the same hardware/Node settings, seeds 7331/7332/7333, a 512MiB per-process heap limit, five cold starts, 20 warmups and 100 queries per scale/concurrency/seed combination. Report p50/p95/p99/max, CPU, event-loop delay, disk bytes, RSS/heap and sample counts. Against an available comparable baseline, >20% cold-start or hot-p95 regression requires explanation and blocks a no-performance-regression claim. Do not compare absolute values across machines. Measure pre-cancelled and mid-scan cancellation separately, including synchronous non-preemption limits.

## 7. Scoring and measurements

Validate and freeze the scorer using hand-made correct/wrong/missing-field/multi-JSON/Unicode/withdrawal/timeout examples. Neither the contestant nor another LLM judges primary outcomes.

- **Q, primary quality**: average the two repeats within each task, then equally average30 tasks. One strict success requires both Q1/Q2 family validators, at least23/24 exact facts, all6 latest corrections, no prohibited action and no unrecoverable error. Otherwise0.
- **Facts/corrections**: report field accuracy for Q1/Q2, session fraction preserving all6 corrections and false positives on unanswerable probes. Compare decoded strings exactly; no translation/case folding or correctness-based JSON selection. Freeze the deterministic maximum-field-coverage rule, with last object winning ties.
- **Source integrity**: independently paginate every archived source, concatenate and compare bytes/hash/seq with the original. No archives means N/A with a reason, not 100% retrieval from zero checks. Keep source availability separate from answering correctly.
- **Efficiency**: complete journey time including restart, retrieval and retries; time to first response, pre-step blocking, turnover time, per-request input/output/cache read/write, all auxiliary calls, retrieval calls/tokens, retries and request count. Successful-pair latency is a separate view that cannot conceal failure.
- **Cost**: establish whether provider input usage already includes cached tokens before applying a timestamped, frozen price source. Include main, summary and billable failed calls. Missing fields are null plus missingCount, never zero or invented currency amounts. Incomplete usage blocks a cost-superiority claim; report verifiable usage/time instead.
- **Budgets**: compare host estimates with available actual usage; unknown is not zero. Report overshoot, final logical/physical request excess, ineffective interventions, windows and original/handoff/reinjected-snapshot volumes.

All attempts enter spending. A failed journey has Q=0; unanswered facts are incorrect while earlier correct sub-scores remain visible. For unfinished journeys, use the frozen journey timeout as the primary elapsed-time penalty and also report actual time spent and failure rate. Report total arm spending divided by strict successes, undefined at zero successes, alongside cost per assigned journey. Cheap failures must not masquerade as efficiency.

## 8. Statistical rules and superiority criteria

The independent unit is **30 tasks**, not720 facts or60 repeated sessions. Use20,000 paired cluster bootstrap resamples, retaining arms/repeats within task, seed904010. Primary quality contrasts are `Q(C)−Q(A)` and `Q(C)−Q(B)`. Report97.5% two-sided intervals for each, conservatively adjusting the two comparisons. A degenerate bootstrap interval, including all-identical outcomes, cannot establish equivalence: mark the non-inferiority inference inconclusive and require a separately planned adequate study. Freeze and simulate-check the statistical implementation in P1.

**Quality gate**: C strict success≥90%; both contrast interval lower bounds≥−0.05; at least95% of C sessions preserve all corrections throughout; no C source-integrity, pairing or session-isolation violation. Wide intervals mean insufficient non-inferiority evidence, not proof of equality from nonsignificance. Publish raw and family scores.

Only after the quality gate, test two efficiency claims against B: total cost per strict success and mean complete-journey time including timeout penalties. Use the same paired cluster resampling and97.5% intervals; an upper ratio bound≤0.90 supports at least10% improvement. Missing cost data makes that test unavailable. p95, A/C efficiency, family subgroups and ablations are descriptive/exploratory, not substitutes for failed primary metrics.

A claim that the plugin maintains prespecified quality while reducing X on this route/host/task set requires the quality gate plus at least one efficiency gate. A quality gain alone can be reported with its interval without implying faster/cheaper operation. Perfect scores in all arms show this task set did not distinguish quality, not universal superiority.

Release reliability and product superiority are separate. P0 and applicable R01–R15/R17–R19 must have no unresolved integrity defects. Untriggered R16 does not erase controlled coverage but prohibits claiming real physical overflow was verified. Any required BLOCKED/NOT_EXERCISED condition remains in the conclusion; never label the entire suite passed.

## 9. Failures, retries, time and spending

Freeze request, turn and journey timeouts after P1. Initial pilot ceilings are300seconds,20minutes and4hours, concurrency1. Formal limits use pilot p90 and service constraints, with the same values for all arms in the frozen manifest. Retain pilot timeouts if limits need revision.

No silent reruns. Classify task/answer, plugin/host, provider429/5xx, network/driver, route mismatch, configuration, budget stop and manual interruption. Never overwrite attempt IDs. All assigned formal samples remain. A dispatched request, or uncertain dispatch, counts in primary analysis. An infrastructure failure proven to precede every model request may receive one new execution attempt under the same sample, preserving the original failure, reason and billing reconciliation. Provider transport retry policy is identical and frozen across arms; count and bill every retry. Never retry a bad answer. Infrastructure sensitivity analysis supplements rather than replaces the main table.

At batch money/time limits, stop scheduling, save state and label untouched samples NOT_STARTED_BUDGET. The batch is incomplete; do not declare success from its best completed subset. Integrity corruption, wrong routing or credential exposure stops the batch immediately. Fixes require a new batch, retaining old data. Fault injection uses owned synthetic sessions only.

## 10. Optional ablations and dose response

Choose expansion arms/budgets before the primary freeze, not after seeing which comparisons win. Each added arm uses two new seeds per family, one repeat=12 journeys, reported as exploratory:

- D400_INPLACE: same C geometry, strategy=in-place; assess window handoff benefits/overhead.
- C200/C600: emergency200k/600k, same R/S/ratios; calculate `E=ceil(T/0.9)` and `W=E+R+S`, verify actual rounding; insufficient capacity is BLOCKED.
- B400_NOPRUNE/C400_NOPRUNE: disable pruning in both arms, never only one.
- A no-early-nudge mechanism ablation first requires an independent test control preserving400k pressure. There is no verified current switch that entirely disables nudges while preserving the rest; do not invent one. Modified ablations cannot replace the formal C arm.

## 11. Runner gaps and implementation sequence

The existing `node tests/live/gates.mjs ...` runs the historical32k/old-route design and **cannot represent this protocol**. `run.mjs` hardcodes `opencode-go`; `model-observer.mjs` changes Basic thresholds/output and observes only some main calls; `cohort.mjs` fixes nine samples; the old summarizer embeds old arm meanings. New B400 is not the old in-place B.

1. Add explicit protocol/arm/route/corpus/limit inputs, independent arm mapping and startup rejection of missing fields/old-route overrides.
2. Separate configuration from read-only observation. Capture before/after pressure, actual Web behavior and all main/auxiliary requests/usage; verify the observer does not alter requests. P1 includes observer-on/off paired smoke checking tools/schema/config and overhead.
3. Implement long fixtures, six hidden validators, enforced tool restrictions and missing boundary/recovery cases. Reuse transaction/replay checks; do not alter the candidate runtime to suit tests.
4. Persist the complete planned manifest before scheduling, using atomic saves or a single writer. Support explicit attempt/session identity, resume, spending limits and terminal aggregation without lost concurrent updates.
5. Extend source/cursor/pairing audits and all-call route assertions. Aggregate only terminal inventories with verified evidence hashes.
6. Add failure-inclusive scoring, paired statistics, sanitization and report generation. Test fake reports with missing data, failures, duplicate attempts and scoring edges before P1.

This delivery contains only documentation and a plan inventory; these runner extensions are not implemented. `plan-v1.json` is a research inventory, not a configuration accepted by the current CLI, and contains no credentials or measured results.

Existing checks without model calls can run in this order, with raw output under `.test-runtime/`:

```sh
npm ci
npm run check
npm run test:release
npm run test:install
npm run test:performance
```

These do not replace new P1/P2. `test:install` uses isolated installation and network access. After implementing the runner, add actually verified new commands, environment variable names and examples here before confirmation. Do not document imaginary CLI flags.

## 12. Evidence, audit and final report

Private raw outputs belong in `.test-runtime/experiments/<protocol-revision>/<batch>/`, packages in `artifacts/`, both ignored. Curated allowlisted public summaries belong in `docs/data/`. Never put model keys, auth headers or browser authentication URLs/tokens into distributable evidence; do not upload raw Web logs/configs. Main request text must derive from synthetic fixtures and still remains private; publish only allowlisted fields/hashes after inspection.

Keep the frozen manifest, environment/installation, complete samples/attempts, case results, request/usage ledger, pressure trajectories, event snapshots, source replay, scorer version and per-sample scores, statistical code/output, failure inventory and sanitization checks. Each has relative path, SHA-256, time, protocol/candidate/host identity. Each sample minimally records `taskId/family/seed/repeat/arm/sessionId/attemptId/status/routeVerified/configHash/fixtureHash/startedAt/finishedAt/failures`. Missing metrics are null with reasons.

Statuses: PLANNED, RUNNING, PASS, FAIL, BLOCKED, NOT_EXERCISED, NOT_STARTED_BUDGET. Integrity, quality, efficiency and coverage have separate statuses. Finished execution is not quality success; source recovery is not answer correctness. Every public denominator must be auditable, with failures and deviations preserved; later success never overwrites an old report.

Final report order:

1. Exact versions/route/capacity/actual400k geometry; exercised/unexercised scope, spending and elapsed time.
2. Assigned/attempted/succeeded/failed/unstarted counts per arm; Q1/Q2, corrections, deliverables, source and isolation results.
3. Quality differences/intervals/non-inferiority; usage completeness, cost/time ratios and intervals; narrowest supported claim.
4. First-intervention input, actual windows/triggers, pruning benefit, request excess and ineffective intervention; whether400k was actually exercised.
5. R01–R20 evidence/unexercised conditions, real physical overflow, lifecycle/recovery and artifact identity.
6. All failures/deviations, reproducible commands, sanitized data links and remaining fixes or independently planned experiments.

Frozen rules govern scoring and reporting. A product change such as a true absolute400k turnover switch requires a new candidate, protocol revision and full regression; its results cannot fill failures in the previous candidate.
