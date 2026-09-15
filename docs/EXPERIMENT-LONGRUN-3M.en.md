# Next-stage experiment protocol: long runs, repeated window turnover, and long-tail history

[中文](EXPERIMENT-LONGRUN-3M.zh-CN.md) · [Machine-readable plan](experiments/muse-longrun-v1.plan.json) · [Previous results](RELIABILITY-HARNESS.en.md)

**Protocol ID: `muse-longrun-v1`, revision 1; design date: 2026-09-15. Status: design complete; no model experiment for this stage has been run; the long-run runner remains to be implemented.**

This document is the execution contract and handoff manual. Its acceptance values are pre-specified targets, not achievements. Commands under `tests/live/longrun/` are new interfaces required below; they must not be treated as tools already present in the repository. See section 14 for existing entry points and gaps.

## 0. Read this page first when taking over

The goal is to verify, after millions of tokens in one logical session, repeated real pressure-driven window turnovers, sequential delivery of several summaries, and re-entry of older summaries into history, that the plugin still cooperates correctly with the Harness and how its quality, waiting, cost, and recovery compare with native Basic.

The following decisions are mandatory:

1. **Two primary arms**: `ARC_DEFERRED` and `BASIC_MATCHED`. The latter uses the unmodified native Basic implementation, with only a test overlay to match trigger/retention thresholds; these are not factory-default parameters. A separate stock-default check, `BASIC_DEFAULT`, must not be conflated with it.
2. **The stricter 3M definition applies**: each primary arm, each formal seed, and each independent long session must have at least **3,000,000 tokens** of verified foreground usage. Two primary arms × two formal seeds therefore require at least **12M foreground tokens**; summaries, pilots, and fault diagnosis are additional. Multiple short sessions, retries, or background summaries cannot be added together to satisfy this requirement.
3. In addition to the token floor, require at least 500,000 host heuristic tokens of distinct new material, at least 12 real ARC window turnovers, at least 6 delivered summaries with distinct sources, and long-tail evidence across at least 6 committed windows. Record insufficient coverage when the actual result misses any requirement.
4. All real foreground and summary calls use **`opencode-go-muse/muse-spark-1.3-contributor`, `minimal`**; the host is fixed at **DSH 0.1.2-rc.1**. Do not enable local Qwen, create a local-model tunnel, or use a newer global dsh.
5. Release only one small paired block for a seed at a time: the two arms run in parallel; foreground work within an arm is serial; each ARC session has at most one background summary. Release the next block only after both arms have reached terminal state and their audit and review are complete. Inspect long sessions episode by episode; do not drop the whole task into an unsupervised run.
6. A pending summary is normal. Turn over first, do independent work first, then wait or retrieve when reaching a dependency on missing history. Failing to have a summary at the instant of turnover is not a failure.
7. Improve **experiment tooling** first in this stage; do not adjust the product in advance to fit the test. Product defects may be fixed, but the failure must be sealed, a new candidate/protocol revision produced, and verification repeated; do not hot-swap code in a formal sample mid-run.
8. This document authorizes design. Once given an execution instruction, the implementing agent proceeds autonomously under the convergence-point rules; each convergence point is agent evidence review and does not require repeated user confirmation. When a stop condition defined here is found, stop the affected run and report it accurately.

## 1. Previous evidence and new questions

The previous round at commit `950353627da25269daf86d63468f49f3c3ba921d` passed 358 checks: same-realm takeover, native `/compact`, install, uninstall, and reinstall. In short Muse samples, the ARC windowed arm made four turnovers, had 24–31 ms boundaries, delivered two summaries, and passed all quality checks; the in-place arm omitted `eventOrder`, did not retrieve in that round, while the original text existed; Basic scored 1/3 on the verbatim probe. None of this proves long-term stability.

This round answers:

- After repeated turnovers, do the index, summaries, latest user revisions, and current work still each have the right source?
- Once old summaries are compressed again and history grows, can retrieval reach the actual original text and distinguish an old value, the latest effective value, and “not found”?
- Is a summary traceable from pending to ready to host append to later archival, without cross-session leakage or duplicate delivery?
- When independent work remains after turnover, is waiting naturally hidden; when old history is actually required, does the system wait or retrieve correctly?
- After long operation, cancellation, restart, and supervisor failure, do Harness transactions, tool pairing, commands, and service ownership remain correct?
- Compared with native Basic, where are the benefits and costs? “Better recall but more expensive,” “correct structure but model omission,” and “insufficient coverage” are allowed results; no winner is assumed.

## 2. Units, tokens, and completion

### 2.1 Do not conflate six counts

| Field | Definition | Use |
| --- | --- | --- |
| `foregroundVerifiedTokens` | Input + output normalized from real usage for completed foreground requests used for normal work in this main session; excludes sentinel/final-probe requests, explicit failed/cancelled/retry attempts, and independent diagnostic forks | **3M hard floor** |
| `allReportedTokens` | Verifiable usage of all real calls, including foreground, summaries, failures, cancellations, and retries | Lower bound on actual consumption |
| `unknownUsageCalls` | Dispatched calls whose usage is missing or unexplained | Cannot be counted as zero cost |
| `reservedExposureTokens` | Conservative potential usage estimated for unknown calls | Operational-risk observation; **cannot satisfy 3M** |
| `uniqueExposedSourceTokens` | Distinct source pages present in at least one real model request, counted once per page with host `heuristicTokens` over original text | **≥500,000 new-material coverage gate** |
| `currentProjectedTokens` | Pressure projected for the request the host is about to send | Threshold decisions; never subtract the archive ledger |

3M is decimal 3,000,000. Re-sending history is real foreground usage but not new material. Cached input already included in input is not added again; cached read/write and reasoning/output detail are accounted separately and their components must not be double counted. Confirm whether usage chunks are cumulative or incremental from actual adapter semantics and controlled unit tests; normally use the final cumulative value of one stream, not a sum of chunks.

Each `logicalRequestId / streamId / attemptId` can contribute once only. When adapter-internal HTTP retries cannot be identified, mark the field unknown and do not invent an attempt; an exact cost claim is then prohibited. Known foreground usage reaching 3M proves a lower bound; unknown usage remains and blocks a complete billing conclusion. Empty calls, re-reading pages, meaningless summaries, or disabling cache merely to reach the floor are prohibited.

Normal-work requests must satisfy the 3M gate before final probe. Actual sentinel and final-probe usage still counts in `allReportedTokens` and is listed separately as `probeReportedTokens`; test questions must not turn an under-target work trajectory into a passing one.

### 2.2 Experimental units

- **episode**: a small phase comprising 12 pages of new material plus its work and updates; reading may use multiple model steps, but the session remains connected.
- **run**: the complete long run for one arm × one seed × one newly created session; a prearranged same-session restart remains part of that run.
- **pair**: the two primary runs with the same seed, material, and task schedule.
- **campaign**: P0/P1, two formal pairs, independent specialized cases, and final audit; do not total their consumption and claim each run passed.

For each formal run, record `executionCompleted`, `tokenFloorMet`, `coveragePassed`, `integrityPassed`, `qualityPassed`, and `latencyTargetMet` separately; do not use only one success Boolean. If a product error terminates a run early, do not continue spending just to reach 3M; retain `tokenFloorMet=false`.

## 3. Frozen environment and preflight

Repository root: `/Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-context-management`.

| Item | Requirement |
| --- | --- |
| Host | `$REPO/.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh`; set `EXPERIMENT_DSH_BIN`, and child processes must also explicitly receive dshBin |
| Node | The design observed v23.8.0; record actual Node/OS/CPU/memory at execution, pass prepack first, and do not change these within a pair |
| Candidate baseline | Git `9503536`; tarball SHA-256 `cfab61d84d5fedd8a0eaa4627cf054778a77fc7152436eb251467b3abc7f1127` |
| Complete dist | 34 files; sorted manifest SHA-256 `799151fdada17114c8c818431cddee7705bc882c4d044719d07439db6023e96b`; each entry is `relativePath + NUL + sha256 + newline`, sorted by path byte order |
| Model | provider=`opencode-go-muse`, model=`muse-spark-1.3-contributor`; verify actual and effective effort=`minimal` for every llm/stream |
| Capacity | Most recent route resolution gives C=1,048,576; verify again with host `resolveModelInfo` before execution; a change requires a revision, not silent reuse |
| Connection | Reuse the configured provider in `~/.dsh/settings.yaml`; do not copy plaintext endpoint/key into public reports or hard-code another route |
| Private settings | Follow `writePrivateSettings`; a Basic summary request may omit effort, so private provider default reasoning must also be minimal; disable session-title-llm |
| Isolation | Each run has distinct DSH_HOME, profile, synthetic cwd, port, and log directory; private settings are 0600, directories 0700; set `COREPACK_ENABLE_AUTO_PIN=0` |
| Existing profiles | Retain `ctx-v012-smoke-c` and `ctx-v012-mini-native`; copy their synthetic configuration into dedicated formal long-run profiles, without modifying/deleting existing profiles or daily web/headless |
| Ports | Basic main pair 3341, ARC 3342, specialized cases 3343; monitoring uses local files or 127.0.0.1 only and exposes no service externally |

In the new DSH_HOME, create `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` bundles in the real manner used by `tests/reliability/package-lifecycle.mjs`. Add this plugin bundle only to the ARC profile; do not install/load it in the Basic profile. Use standard for all presets; test ptc/cordis/minimal separately for compatibility.

At each launch, restart, and end, record actual PID/start time, executable realpath, host package version/hash, complete dist manifest, profile manifest/patch hash, settings hashes before/after, hashes of four shipped preset files, provider capabilities, actual tool list, service backend, and isolate evidence. Retain credential-bearing private files only as permission-restricted copies or hashes; export a public whitelist.

Installation must use a content-hashed tarball filename and verify the complete installed dist. In the previous round, `plugin add` retained an old bridge after a same-path same-version tarball was overwritten; comparing only dist/index.js cannot detect this. Do not take package-manager “Already up to date” as proof that artifacts are identical.

## 4. Experimental arms and budget geometry

### 4.1 Main comparison: native Basic at equal pressure

Set main pressure to **T=64,000**, balancing repeated turnover against the default background-summary input limit. This is an intentionally chosen logical pressure, not Muse physical capacity.

```text
C = 1,048,576 (confirm by measurement before execution)
R = 8,192   actual output ceiling for main requests
S = 4,096   safety margin
E = ceil(64,000 / 0.90) = 71,112
W = E + R + S = 83,400
ARC preparation line = E × 0.60 = 42,667.2
ARC nudge line = floor(E × 0.75) = 53,334
ARC emergency line = floor(E × 0.90) = 64,000
ARC target retained pressure = E × 0.55 = 39,111.6 (target, not a hard guarantee)
Basic thresholdRatio = 64,000 / C; verify floor(C × ratio) = 64,000
Basic retainRatio = 39,111.6 / C; verify retainTokens = 39,111
```

Floating-point calibration may make only the smallest increment adjustment needed to correct `floor`; record input ratios and host-resolved values. The rounded retention difference is <1 token. Protected recent steps may make actual retention higher than target; observe it rather than rewriting it. If Basic default modelPolicies override experiment parameters, handle and record that explicitly in the private test overlay; do not inspect only top-level config.

The `ARC_DEFERRED` bridge `config` payload is below; it is not a complete DSH patch. The actual wrapper must reuse the `compaction-context-management-bridge` / `dsh-context-management/bridge` entry in `cordis.patch.yml`:

```yaml
adaptiveGovernor:
  enabled: true
  strategy: windowed
  windowBudgetTokens: 83400
  maxOutputTokens: 8192
  safetyMarginTokens: 4096
  nudgeAtEffectiveCapacityPct: 0.75
  emergencyAtEffectiveCapacityPct: 0.90
  targetAfterTurnoverPct: 0.55
  emergencyFallback: true
archive:
  seedMaxTokens: 4096
  retrievalDefaultMaxTokens: 2048
  retrievalMaxTokens: 4096
backgroundSummary:
  provider: opencode-go-muse
  model: muse-spark-1.3-contributor
  reasoningEffort: minimal
  allowSameProvider: true
  delivery: deferred
  prepareAtEffectiveCapacityPct: 0.60
  maxInputBytes: 262144
  maxSummaryBytes: 4096
  maxOutputTokens: 2048
  timeoutMs: 60000
```

These are existing configuration names. In particular, `archive.*Tokens` currently constrains UTF-8 serialized **bytes** in several places; do not describe 4096 as a measured 4096 model tokens. Also record actual bytes and heuristic estimates.

`BASIC_MATCHED`: `auto=true`, the thresholdRatio/retainRatio above, and summary `maxTokens=8192`; retain the native implementation and system prompt. Main-request R=8192, equal to ARC. Do not install ARC retrieval tools for Basic or have the supervisor read old logs on its behalf. Basic itself retains append-only original logs; the difference is what capabilities the model can use, not a claim that Basic has no original text.

Both arms retain the same native pruner (8192/4096/1024 character thresholds/head/tail), model, ordinary task tools, page-read batch size, materials, user updates, work code, and checkpoints. The strategies’ own tools, prompts, counts, and contents of summary-route calls differ; report them explicitly and do not claim that only one algorithmic variable changed.

### 4.2 Status of other conditions

| Condition | Status and execution rule |
| --- | --- |
| `BASIC_DEFAULT` | Required small authenticity check: stock Basic auto, thresholdRatio=0.8, retainRatio=0.16, summary maxTokens=8192. Main-task length may never trigger it; do not treat zero compactions as a matched-threshold comparison. To formally compare default user experience, preregister a separate same-material `ARC_DEFERRED`/`BASIC_DEFAULT` pair with each run ≥3M; retain insufficient stock-compaction coverage |
| `ARC_NO_BACKGROUND` | Optional formal ablation for attributing waiting/quality/cost, paired with ARC_DEFERRED and still ≥3M per run; do not use a short diagnostic to claim a quality benefit from background summaries |
| `ARC_IN_PLACE` | Diagnostic for in-place forgetting/missed retrieval, reusing the previous failure mode; not the primary comparison and does not need every mechanism diagnostic expanded to 3M |
| Larger logical windows or Muse physical limit | Independent extension. T=128k or native 80% may prevent preparation under default maxInputBytes; record that limit first and do not secretly enlarge summary input. Confirm real physical overflow separately; do not substitute logical pressure |

The required formal scope of this revision is two primary pairs: four ≥3M runs. Additional formal arms are not in the automatic execution queue. Short diagnostics cover mechanisms only and do not complete a “≥3M formal group.”

## 5. Long-run workload: generative specification

### 5.1 Scale and content

The base journey is **24 episodes × 12 pages = 288 pages**. Each page targets 7000 Unicode code points, maximum 7800, below the main-experiment pruner threshold. Body content uses mixed Chinese/English paths, logs, API/workflow fragments, and random records. At least 60% of each page must be distinct records/constraints/data; repeated sentences or one padding string cannot create length. Every entity value, trace, checksum, and version derives from hidden salt + seed.

Before freezing, call host `heuristicTokens` for real measurement. The base journey must reach 500,000 estimated tokens of distinct source text; otherwise, after P1 increase the fixed base-page count for all formal runs and revise the manifest, without secretly adding noise to one arm. Page count is initial geometry; 500k is the measured gate. The old F3 estimate of about 504k for 288×7000 characters is only the basis for choosing the start.

Generate one committed corpus of up to 48 episodes; after the base, each **6 episodes** is a scheduled expansion block. Seal hashes of all materials and each possible final-endpoint probe list before the first formal call.

### 5.2 Fixed episode structure

| Location | Content and execution |
| --- | --- |
| Start | The user supplies the episode work goal, current priority, and applicable update; historical pages cannot impersonate the user role |
| Pages 1–3 | Two sourced entity facts, one precise path/value, one log event and its predecessor; authoritative content and suspected clues are explicitly distinguished |
| Pages 4–6 | A new component version, dependency on an older episode, old material corresponding to one user revision; at least one similar-ID/near-miss distractor |
| Pages 7–9 | A state operation executable only after three prerequisites, a small code interface/migration note, one unapproved alternative |
| Pages 10–12 | Independent trace/checksum, a dispersed final item of event order, conflicting record with explicit effective/revoked semantics; do not summarize earlier answers |
| Work step | Produce the episode’s small deliverable or state that a dependency remains unmet; read at most 6 pages/step, with strictly validated operation log |
| End | Brief `E_<n>_COMPLETE`; do not require a master answer table for the experiment. Native plugin maintenance remains available; if the model additionally recaps, retain original text and record long-tail re-exposure |

The 24 episodes interleave state evolution, troubleshooting timeline, workflow/code maintenance, and need for old evidence rather than becoming several unrelated short sessions. Each six episodes forms a productive work package: two pure reading/troubleshooting phases, one correction phase, one three-file code-change phase, one dependency-operation phase, and one merge-verification phase. Fixture filenames and allowed imports/writes are fixed; the final historical blind-test phase disables work-file reads.

### 5.3 Core oracle

- **48 state entities**: at least 16 have two updates, 8 have revocation/restoration, and 12 groups have similar IDs. A correction is an explicit new user instruction; the latest effective version is determined by effective ordering and authority, not by the last ordinary historical text.
- **24 timeline/dependency relations**: at least 8 span ≥6 episodes, with 4 three-way fan-ins and 4 mutually exclusive option sets; final output is a complete ordered array. Specifically reproduce “facts correct but eventOrder empty.”
- **48 exact historical targets**: checksums, verbatim short phrases, paths, and units; at least 12 are in the first quarter and at least 12 require assembly from different old sources. Different sources may contain identical text but have different sourcePage/recordId.
- **24 existence/ambiguity sets**: completely absent, one-character near-miss, same short ID for different entities, and echoes existing only in a model summary. Absence is defined against the specified bounded original-source set.
- **24 real synthetic actions**: fixed idempotency key, prerequisites, and final state; no repeated effect or premature execution. Failure feedback cannot reveal hidden answers. Work files may hold the task’s code state but may not become general historical memo files.

These counts are minima for the base 24 episodes. Each expansion episode adds at least 2 state entities, 1 dependency, 2 exact targets, 1 existence/ambiguity candidate, and 1 action; it cannot add only padding pages. For every possible endpoint `N ∈ {24,30,36,42,48}`, seal 96 questions and their source distribution. The newest quarter after expansion must contain genuinely new targets. Each bucket of 6 state questions fixes 2 latest-user corrections, 2 revocation/restoration, and 2 ordinary states; the first two form the fixed 16-question `requiredLatestUser` subset at every endpoint, all of which must be correct. IDs use `N{N}-Q{001..096}`. The oracle stores category, required flag, correct answer, and rationale per question; do not reduce the denominator after execution.

The summary-pollution main experiment supplies only genuine conflicting, stale, and non-authoritative source material, then audits model-produced summaries offline. Do not directly tamper with ARC summaries to fabricate a natural failure. Artificial erroneous summaries belong in a separate controlled-fault case.

### 5.4 Synchronized expansion and stopping

Both arms use the same episode sequence but advance continuously and checkpoint independently; **do not synchronize after every episode**. Only at a common candidate endpoint N=24/30/36/42/48, when deciding whether both arms must expand, does the faster arm wait at an external barrier after a completed turn. Do not send the model “wait.” Per-episode barriers would artificially give background summaries extra preparation time and contaminate observations of naturally hidden waiting.

Record endpoint barriers separately as `schedulerBarrierMs`, including jobs becoming ready/delivered during the barrier and their later consumption. These remain valid strategy outputs but cannot count as waiting hidden by actual task work. Natural-wait metrics primarily use work segments before endpoint barriers; disclose this scheduling condition for final common-endpoint quality.

After the base 24 episodes, if normal verified foreground usage of either run is below 3M or the shared corpus misses the new-material gate, execute another 6 episodes from the preregistered list for the whole pair; the other arm reads the same material even if it already reached 3M. Maximum is 48 episodes. This deterministic rule selects final probe endpoint; model score does not. If still insufficient at 48, mark `COVERAGE_INCOMPLETE`; do not re-read or use summaries to fill the count.

**Do not extend or change questions merely because quality is low, summaries were unused, or window count is undesirable.** These are formal outcomes; specialized diagnostics explain them. If even basic multi-window geometry is not reached in pilot, adjust and freeze it before formal execution. If either arm has an unrecoverable error, do not dispatch a new episode for the pair; process already-dispatched calls under cancellation/settlement protocol and retain both states.

## 6. Multiple summaries and long-tail probes

### 6.1 Real definition of multi-window/multi-summary

Counts must come from `compaction/summary` metadata, shared-transaction completion, and durable handoff receipt. Record threshold check, prune, in-place fallback, window commit, summary dispatch/ready/offered/delivered/unavailable separately. A `new_context` acceptance or ready state alone is not a completed window/delivery.

Targets for every formal ARC run:

- ≥12 real window commits, of which ≥8 are pressure-path triggered; manual commands cannot make up the number.
- ≥6 persisted delivered summaries: unique operationId, pairwise-distinct sourceHash; in dispatch order, each source set contains at least one original event seq not covered by prior counted summary; distributed over at least 6 delivery-window generations; background remains at most one job at a time.
- At least 2 delivered summaries later enter archive again. Their receipt seq must be in the source set of a subsequently committed archive block. The source graph contains at least one replayable path with 3 different historical-processing nodes, for example later archive → earlier archive/replacement → delivered-summary receipt → original event. Metadata virtual edges and repeated traversal of one node do not count as depth. Every edge has actual source seq or persistent receipt evidence. No requirement keeps every summary in the active window together.
- The 12 pre-specified final blind long-tail targets have an original source at least 6 real window commits before ARC final-probe start. Record original distance and subsequent re-exposure. Both arms use the same targets; report Basic’s native compaction distance separately and do not draw easier questions for it.
- Count pending across a window, ready before a window, unused prefetch, over-budget, replacement by a newer operation, cancellation, and restart interruption separately. Natural main work need not exhibit every timing; section 11 covers missing items, and those cases do not become natural adoption rate.

### 6.2 Separate common blind questions from ARC-specific mechanisms

Both arms receive **identical questions and public targetId/entity identifiers** and are scored against the same correct answers, including verbatim and existence questions. Wording must not expose oracle sourcePage, correct recordId, or existence; only a question intrinsically asking for the checksum of a given page may give page number, and it must not also count in the source-identification denominator. Freeze `promptVisibleFields` and `scoredFields` per question and verify that secret fields never enter a request. Do not change history questions Basic cannot answer to N/A because it has no retrieval tool; only plugin-internal mechanisms such as cursor, blockId, and handoff receipt are N/A for Basic.

Every run has **96 questions**, 24 in each of four source-position buckets: earliest quarter, early-middle, late-middle, and latest quarter of base/expanded final endpoint N. Each bucket has 6 state/correction, 6 exact-verbatim, 6 source/existence/ambiguity, and 6 timeline/dependency questions; code and action delivery are also checked. Post-stratify by original-page pairing, actual window distance `{0,1–2,3–5,≥6}`, distinct-new-material distance, and lastExposure. Do not redraw questions based on whether an arm’s summary contains the answer.

Assign buckets by original page number `floor((sourcePage-1)*4/(N*12))`; at N=30/42, do not round episodes and treat them as page quartiles. Long-tail absence questions use a preregistered bounded original-source set wholly in the earliest bucket. Source age is the final source event in that set, rather than an invented event for an absent answer.

Split the 96 questions into **12 batches of 8**, with no overlapping fields and no answer/correctness feedback. E6/E12/E18 may each contain one disjoint 4-question sentinel; it is part of that trajectory and its facts cannot re-enter the final 96. Log every retrieval result/model recap that causes re-exposure; do not treat post-test as an independent unaffected sample.

To prevent earlier probes from helping later long-tail questions, predesignate at each endpoint the 6 exact questions and 6 source/existence questions from the earliest source bucket as `longTailRequiredIds`. Put them in the first two final batches with disjoint source pages, entities, and answer-evidence sets. If sentinel, earlier-probe request/retrieval/answer re-exposes the same evidence, mark that question `probeClean=false`. Retain it in the shared 96 score, but do not claim it as a long-tail sample free of prior-test help. All 12 designated questions must be probeClean or the long-tail coverage gate is insufficient; do not replace questions afterwards.

Naturally generated/delivered product summaries and voluntary work recaps are strategy capability, not automatically probe contamination, and their benefit must not be blocked. Separately report `summaryContainsAnswer / rawContainsAnswer / neither` in the active window before final probe. If the strictly non-re-exposed original-retrieval subset is insufficient, report no coverage; do not call “the summary successfully retained the answer” a failure. This differs from leakage by the probe itself.

Final probes on the main trajectory use natural task wording and permit the model to wait, retrieve, or answer directly. A probe explicitly requiring `await_context` is guided mechanism coverage only. Current `await_context` takes no parameters; no `operationId`/`timeout` argument exists. Link operation ownership through return value and observer; do not design a fictitious tool call.

### 6.3 Prevent answer and history detours

Keep oracle, hidden salt, scorer, and final probe-selection table in the driver private directory; model cwd contains synthetic work code only. Main-task tools use a server-side allowlist. Deny all shell/general-file/network/delegation entry points by default; prompts alone are inadequate. Page reads access only the currently allocated page number. During probe phase page, code, and action tools are closed, with identical restrictions for both arms. Installed context tools retain native capability; do not block `await_context` or force retrieval.

Final answers require one explicit JSON object. Retain missing fields, empty arrays, null, and invalid JSON as failures; the scorer must not combine preferred values from multiple objects. One fenced complete JSON is allowed; nonempty explanation outside the fence or multiple candidate JSON values is `FORMAT_FAILURE`. Freeze exact parsing rules with golden tests.

Every page must be shown fully in provider request objects; “the tool reports read” is insufficient. On missing page exposure, the supervisor cannot secretly send a compensating answer or change original scoring. Record denied detours as `deniedAttempt`; only successful unauthorized access or secret entering a request is `INVALID_LEAKAGE`. A rejected model call is a task-following issue, not equivalent to failed protection.

## 7. Metrics, acceptance, and judgment

### 7.1 Hard integrity gates: any violation blocks candidate acceptance

| ID | Assertion | Evidence |
| --- | --- | --- |
| I01 | Actual host/route/effort/candidate match; no additional title-model stream | Every request and launch identity |
| I02 | Current user input is protected at the relevant decision; tool call/result pairing is not split | Replay events before/after every replacement; final surface alone is insufficient |
| I03 | seq is monotonically appended and original history is not rewritten; adjacent summary/replacement and shared transaction link correctly | Complete observer snapshot/JSONL; RPC is auxiliary only and cannot fill numbers to hide a gap |
| I04 | Paginated original-text restoration is byte-identical to source text actually exposed; cursor is bounded, with no loop or silent omission | Final offline audit of all archived blocks; parent-source deduplication retains seq identity |
| I05 | Delivered is unique; sourceHash and session/route/window relation are correct; ready≠delivered; append does not add generation | Operation ledger + durable receipt + visibility in next actual request |
| I06 | No cross-session content/cursor reuse, oracle access, or stealth user-prompt append | Tool access, request objects, supervisor-operation log |
| I07 | ARC replaces original Basic in same realm and native command consumers are correct; Basic control has no ARC; minimal/third-party are not mistakenly taken over | Previous contract regressions + launch/recovery snapshots in this round |
| I08 | Cancellation/dispose creates no new orphan request; restart does not lose durable prefix or duplicate action | Owner/launch/lease, events, and idempotent action receipts |

### 7.2 Quality gates (judged per formal run)

- At least 87 of final 96 questions correct (≥90%); each source-position bucket ≥20/24; fixed 16-question `requiredLatestUser` subset 16/16.
- At least 10/12 (≥80%) of the 12 common `longTailRequiredIds` correct. ARC’s separate coverage condition of original sources across ≥6 windows and probeClean is verified independently; high overall score cannot offset inadequate coverage.
- Ordered dependencies, mutually exclusive choices, protected files, and final action states all match oracle; zero repeated action effect and zero premature execution.
- Missing required array or `eventOrder=[]` when oracle is nonempty fails the final deliverable even if every other fact is correct.
- Explicit bounded-absence questions cannot invent existence, and explicit latest-user constraints cannot be overwritten by old summaries; list each error separately.
- Use strictly equal denominator for common Basic and ARC questions. Retain Basic when it fails the quality gate; do not remove questions because “native has no tool.” Do not require both arms to pass before reporting ARC reliability facts.

Two formal pairs provide mechanism coverage and pairwise difference only; they cannot statistically prove general superiority or noninferiority. Report each question type, each distance bucket, and aggregate difference by seed. Ninety-six correlated questions are not 96 independent long tasks: do not perform pseudoreplicated significance testing. Do not claim equivalence from bootstrap degradation intervals with two seeds. A population-effect claim needs a separately preregistered sample-size/power plan.

### 7.2a Coverage and aggregate-status calculation

Shared coverage is `commonCoveragePassed = tokenFloorMet && uniqueExposedSourceTokens>=500000 && allAssignedPagesFullyExposed && finalProbeCount==96 && plannedRestartVerified`. ARC additionally requires `windowCommits>=12 && pressureWindowCommits>=8 && distinctDeliveredSourceCount>=6 && deliveryGenerationCount>=6 && rearchivedDeliveredReceiptCount>=2 && maxVerifiedSourceProcessingDepth>=3 && oldWindowLongTailCount==12 && probeCleanLongTailCount==12`; ARC `coveragePassed` is their conjunction with shared coverage. Basic requires shared coverage, at least 12 native automatic compactions, and the same 12 probeClean questions; summary hierarchy and ARC window/receipt mechanisms are `NOT_APPLICABLE`.

No unknown may be treated as true. `integrityPassed` requires evidence for every applicable I01–I08 assertion and no violation; missing evidence is null/`INVALID_EVIDENCE`, while observed violation is false/`FAILED_PRODUCT`. `qualityPassed` uses the fixed denominators above and counts missing answers wrong. `latencyTargetMet` evaluates only ARC’s pre-specified target; retain Basic measurements and mark that target N/A. `reliabilityAccepted = executionCompleted && coveragePassed && integrityPassed && qualityPassed`; list performance target separately and never hide reliability failure with low latency. Failed Basic does not negate ARC passing on its own, but comparative conclusions must show both.

An incomplete/under-covered run is still a result that must be sealed; it cannot pass candidate acceptance. All 18 specialized cases require a traceable status. If a critical integrity mechanism is `NOT_EXERCISED`, the report must say it remains unverified and cannot claim comprehensive pass.

### 7.3 Waiting and latency

Record monotonic time and UTC within the same host launch; do not subtract monotonic clocks across processes/restarts:

```text
t_prepare -> t_window_enter -> t_window_commit -> t_ready -> t_delivered
                    \-> next independent foreground work request
t_dependency_enter ------------------------------> t_dependency_release
```

Ready may occur before or after a window. `t_delivered` is time the host has appended and confirmed, not network-completion time. Record whether the next model request actually contains the handoff, distinguishing “delivered but unconsumed because task ended.”

- `boundaryMs`: complete pressure-path pre-step duration from entry to return; split prune/seed/transaction/flush, and do not report only index-build time.
- `commitMs`: complete shared replacement-transaction duration. `nextForegroundDispatchMs`: boundary entry to next main-request dispatch, retaining scheduling cost.
- `dependencyWaitMs`: waiting for actual `await_context` or actual required historical dependency; zero with no dependency, without assuming “turnover needs summary.”
- `overlapMs`: foreground/background host-stream lifecycle intersection for the same session; not proof of GPU concurrency and not equivalent to all hidden wait.
- Account fully for Basic native-summary wait; ARC background summaries, unconsumed summaries, and interrupted requests also count.

Pre-specified performance target: ARC boundary p95≤1000 ms and max≤5000 ms. Each run has at least 12 real windows, reports raw sample count, and uses the `ceil(0.95*n)` item after sorting for p95. Failure is `LATENCY_TARGET_MISSED`; diagnose disk/observer/archive size, without conflating it with data loss. Do not compare directly with the prior round’s 24–31 ms at different scale.

End-to-end report separately includes user wall clock, model-call time, scheduler barrier, human/supervisor pause, and recovery time. Concurrent arms can contend for provider resources. This main experiment reports per-seed time/token raw values and paired deltas only; it has no “faster/cheaper than Basic” pass gate and does not infer currency cost from token counts. A causal performance claim requires separate preregistered AB/BA-interleaved performance blocks that retain all costs.

### 7.4 Resources and long-run growth

Every 5 seconds sample RSS, CPU, event-loop lag, and disk growth for host/driver/supervisor. At every turnover record archive blocks, summary receipts, jobs, listeners, and temporary-file counts. Finally observe at least early/middle/late archive sizes.

Also perform a no-model dose test: create/destroy 20 sessions over fixed-size corpus. After explicit GC, median retained-heap increase across rounds 2–5 versus 17–20 must be ≤`max(32MiB,baseline20%)`, with job/listener counts back at baseline. Growth means investigation required; do not call RSS caused by retaining more real history a leak directly. Construct legal combinations of scale `{1k,10k,50k}` events × `{1,10,50}` effective windows. Report cold 5+ and warm 20+ read/retrieval p50/p95/max and cancellation response separately. Synthetic scale does not count toward 3M or real multi-window gates.

## 8. Execution phases and convergence points

| Phase | Content | Condition for next step |
| --- | --- | --- |
| P0 tooling and controlled tests | Implement section-14 interfaces; regression/real-host no-model contract; unit tests for counting/scoring/lease/recovery/fault injection | All integrity/supervision foundation gates pass; no credential leak |
| P1 one calibration pair | seed91561, equal short prefix for both arms; target 0.2–0.8M per arm, at least 2 Basic compactions, 2 ARC turnovers, and one real summary delivery | Calibrate actual page length/pressure/usage, effective effort, and global concurrency capacity; if inadequate, stop and repair geometry/tooling, do not mark 3M complete |
| G1 freeze | Freeze formal corpus, endpoint probes, oracle commitment, candidate, and all tool/config/scorer hashes | Write `review.json`: evidence read, issues, decision, next pair ID |
| P2 first formal pair | seed91601; two runs follow 24+6 expansion rule and each is ≥3M; one logical session throughout | All terminal states; separate integrity/quality scoring; offline audit and diagnosis complete |
| G2 review | Lifecycle fixes create a new candidate; retain model-quality failures and continue second seed when no integrity block | No silent cherry-picking of successful seed; do not mix new-candidate and old results as one group |
| P3 second formal pair | seed91602; reverse primary-arm startup order, leave all other design unchanged | As P2; include all four runs, including failure/insufficiency |
| P4 specialized coverage | Trigger section-11 cases in small steps according to uncovered dimension; at most one real fault at a time, other offline branches in parallel | Required cases have evidence terminal state; retain uncovered items explicitly |
| G3 convergence | Complete manifest/ledger/scoring/byte audit, bilingual report, and public sanitized data | State pass, failure, and inadequate coverage per dimension; do not call everything green |

At **completed and flushed turn E12** of each formal run, schedule one real host restart. Use the same episode for both arms and record PID/durable prefix before and after. This is pre-specified recovery. If ARC has a pending summary, it may be recorded interrupted and recovery may retrieve; do not pretend an old network request resumes. The full journey keeps the same session ID. If restart requires a new session, mark original run failed/incomplete only.

Supervisor crash, transaction-gap SIGKILL, malicious/timeout summary, and similar faults do not stack onto the formal natural quality path; run them in independent specialized cases or source-snapshot forks. A fork cannot impersonate another independent seed, and inherited usage cannot satisfy 3M again.

## 9. Full-run supervision: guaranteed by process, not chat window

### 9.1 Three owners

- **driver**: submits only manifest user tasks and operation controls and owns prompt-idempotency log; it does not plan the next seed itself.
- **supervisor**: an independent process reads events/requests/pressure/resources, maintains state machine, alerts, and lease, and stops or recovers under predeclared policy; it does not inject “continue/summarize/try again” into session.
- **coding agent**: checks every convergence point and exception, explains issues, reviews evidence, chooses the allowed next block, and remains responsible until campaign explicitly terminates. Merely starting a background process and saying “still running” is not completion.

Use explicit minimum sufficient delegation configuration: static inventory/mechanical checks luna/high; runner/supervisor/documentation terra/medium; complex protocol or transaction review astra/xhigh; the main agent handles overall design and heavy issues. Execution and scoring agents are separate; scoring does not use another LLM judge.

### 9.2 State machine

```text
PLANNED -> PREFLIGHT -> READY -> RUNNING -> CHECKPOINT -> RUNNING
RUNNING -> WAIT_DEPENDENCY -> RUNNING
RUNNING -> PROVIDER_BACKOFF -> RUNNING / INFRA_INTERRUPTED
RUNNING -> RECOVERING -> RUNNING / FAILED_PRODUCT / INVALID_EVIDENCE
any active state -> STOP_REQUESTED -> DRAINING -> STOPPED
work complete -> AUDITING -> REVIEW_REQUIRED -> SEALED
```

Background-job state is a table orthogonal to run state, supporting at least pending/ready/delivering/delivered/unavailable/interrupted/unused. A run must not enter blocked state merely because a job is pending. `WAIT_DEPENDENCY` requires a real tool/call, operation ownership, and corresponding evidence that waiting ended; retrieval may satisfy the dependency first, without forcing a wait for summary.

### 9.3 Heartbeats, deadlines, and escalation

| Item | Initially frozen value | Behavior |
| --- | --- | --- |
| driver heartbeat / supervisor poll | 5s / 5s | Write small JSON, not whole-history rewrites; update heartbeat even when fields are unchanged |
| Human-readable status | 30s | Emit episode, token lower bound, new pages, window/summary count, current wait, recent progress; do not flood full original text |
| Agent update | meaningful progress/problem within ≤60s | If only background operation is possible, report persistent supervisor location and how terminal state is read; chat is not monitoring |
| supervisor loss | alert at 15s, lease expiry at 30s | Driver refuses new prompts; in-flight calls reach own deadline, safe boundary stops; recovery must reacquire lease |
| host ready | 60s | On failure clean owned process and mark launch infrastructure error |
| foreground/Basic summary | first-content soft alert 90s, soft alert after 120s with no content; 420s hard limit per stream | Activity does not extend indefinitely; cancel only at real deadline, not early because no new session event appeared |
| ARC summary | product `timeoutMs=60000`; diagnose if no terminal state at 65s | Normal timeout becomes unavailable/fallback through product; do not cancel independent foreground merely because it timed out |
| await_context | current job remaining deadline +5s as normal wait ceiling, maximum 65s | Exceeding it triggers lifecycle investigation, not extra minutes requiring summary success |
| one turn | 1800s | On exceedance cancel and confirm receipt first; submit no compensating new prompt |
| one run | 6h work time + at most 30min recorded recovery/finalization | Operational duration, not token-cost ceiling; sample is explicitly incomplete at expiry |
| SIGTERM→SIGKILL | 10s | Only for owned process whose PID/start time/launchId/profile are verified |
| disk | free <5GiB pauses new stage; <2GiB stops new requests | Do not delete old failures to free space; seal and diagnose first |
| host RSS | 2GiB soft alert; 4GiB sustained 30s requests stop | Record hardware capacity; revise before formal work if P1 is unsuitable, not by relaxing one arm midstream |

On local macOS, use `caffeinate -i` owned by this task PID and clean it at end; record system sleep/clock jumps. Do not interpret monotonic/wall-clock differences during sleep as model stall. Record provider/transport errors when cloud request retries happen rather than blaming plugin; damaged history after recovery remains an independent integrity failure.

Retry policy: observe adapter-native retries; supervisor must not add an unexplained second retry layer. A pure provider request confirmed undispatched or safely retryable has at most 3 attempts, backoff 5s then 15s, honoring Retry-After up to 60s; all attempts count as consumption. Do not blindly resend a dispatched prompt with ambiguous outcome; reconcile under section 10. Route/effort/artifact errors, auth failure, and data-integrity failure never retry automatically.

Summary request purpose must link to its job. Do not retain old `promptControlled()` categorization that cancels the whole session for “any incomplete request.” `incomplete-stream` is an observation only and cannot independently distinguish user cancellation, network failure, process exit, or product exception.

## 10. Checkpoints, restart, and idempotence

Before dispatching every prompt, persist `logicalPromptId + requestId + contentHash + expectedEpisode + beforeSeq + dispatchState=planned`; call host with this requestId, then record ack. After driver crash, inspect host events/queue/completed turn before deciding whether it was received; do not resend merely because local ack is absent. If undecidable, terminal state is `AMBIGUOUS_DISPATCH` and the run stops; do not pretend exactly-once.

Update checkpoint at episode end, each compaction/summary receipt, and before/after fault injection. Checkpoint is a view; append-only `supervisor-events.jsonl` and raw host events are facts. Record last complete-record offset/hash, use atomic rename, and define flush/fsync boundaries.

```json
{
  "schemaVersion": 1,
  "runId": "<immutable-id>", "arm": "ARC_DEFERRED", "seed": 91601,
  "state": "CHECKPOINT", "episode": 12,
  "host": {"pid": 123, "launchId": "<uuid>", "startIdentity": "<verified>", "port": 3342},
  "session": {"id": "<id>", "lastObservedSeq": 900, "lastDurableSeq": 890, "prefixHash": "<sha256>"},
  "lastPrompt": {"logicalPromptId": "E12", "requestId": "<uuid>", "dispatchState": "completed"},
  "usage": {"foregroundVerifiedTokens": 1600000, "allReportedTokens": 1750000, "unknownUsageCalls": 1},
  "coverage": {"uniqueSourceTokens": 252000, "windows": 7, "deliveredSummaries": 3},
  "lease": {"owner": "<supervisor-id>", "expiresAt": "<UTC>"},
  "nextAction": "planned-host-restart", "timelineTailHash": "<sha256>"
}
```

Example numbers are neither thresholds nor actual results. Restart verification requires old PID actually exited, new PID differs, same session ID, confirmed durable prefix equal event-by-event/byte-by-byte, consistent queue/action receipts, re-resolution of original route, and service realm/tools with neither duplication nor omission. An observed but unflushed final event cannot be called durable. Crash may lose unconfirmed tail but must report it; it may not alter confirmed prefix.

Durable receipts from synthetic action tools provide in-progress-operation idempotence; an in-memory Set is inadequate. A simulated side-effect action atomically commits state and idempotency key before returning; same-key retry returns original receipt without effect. Read-only tools may resume/retry but must be logged.

Supervisor restart first reattaches to existing host and does not automatically kill/rebuild. Lock file includes PID, start time, run/launchId. An old lock cannot simply be deleted, nor can a daily dsh be killed by vague process name. If ownership cannot be proved, stop this execution and report.

## 11. Specialized coverage matrix

These are required case types, not a batch task list. Start with offline/controlled component cases, then add a short sample at boundaries requiring real model/Web; at most one fault at a time. Every row status is `PASS / FAIL / NOT_EXERCISED / NOT_APPLICABLE / INVALID_EVIDENCE` and points to specific evidence.

| ID | Trigger and steps | Acceptance, level, and control |
| --- | --- | --- |
| X01 | T−1/T/T+1, fixed R, pruner relieves/does not relieve pressure, large result + Unicode | Real host-component measurement; crossing T need not window every time. Primary arms use same pruner; large result separate, with no silent truncation of primary corpus |
| X02 | One real summary is pending at window, then execute work depending only on current input | Independent task completes without wait; job may deliver later. Real Muse; if no pending occurs, mark uncovered and use controlled-delay case |
| X03 | Old-fact dependency occurs immediately / 2 steps / 5 steps after turnover | Record wait/retrieval/direct answer separately. Guided subcase explicitly calls parameterless await_context, then delivers on next pre-step; natural subcase does not name tool |
| X04 | Test layer delays a completed real Muse summary-stream packet by 0/5/20s without changing body | Mark injected delay; it is neither provider latency nor natural sample. Verify wait does not exceed necessary remaining time and does not fail because it missed window |
| X05 | Multiple summary sources overlap/old revision; user correction while pending; then another turnover | Latest user wins; source/route/session valid; no cross-window error, duplicate delivery, or summary echo treated as original fact |
| X06 | No summary/input over limit/output over bytes/empty result/timeout/cancel/budget rejection | Controlled real Harness; explicit status/fallback; independent work continues. Cloud failures not naturally seen cannot count as natural coverage |
| X07 | Tool pairing incomplete, user steer, queued input, new input after model new_context accepted | New window commits only at safe pre-step, protecting current user/input and pairing; new event not overwritten by old summary |
| X08 | Missing/ambiguous ID, cross-session/cross-block/restart cursor, scan cap, zero hits and absent | Session-local/bounded, explicit incomplete, cursor terminates; Basic internal cursor mechanism N/A, shared answer questions still score |
| X09 | Old summary re-archived, nested sources, same text different seq, image/attachment references | Full recoverable text bytes and reference identity; missing attachment explicitly unavailable. If genuine multimodal understanding is unverified on current route, list uncovered and invent no image contents |
| X10 | Real native/ARC `/compact`, busy/cancel, `/context` status/turnover, ptc/cordis/minimal | Native command ownership, maintenance exclusion, service realm, tool presentation; PTC executes at least one registered context tool through run_code, not only READY smoke |
| X11 | Existing agent enablement, repeated start/stop, late Basic load, external Include reload/rollback, new config, no backend | Rerun 15 reliability regressions; use private profile for actual Web switching. Do not modify shipped preset files |
| X12 | Cancel turn while pending, cancel after summary complete before append, dispose after delivery | Pending work has owner; no late cross-session append; cancellation≠product failure, missing terminal/orphan request is the problem |
| X13 | Restart at flushed boundary, restart while real pending, SIGKILL transaction commit/flush gap | First is real Web; exact gap uses controlled host child process. Interrupted notification, recoverable original text, no repeated action; do not claim old network stream revived |
| X14 | Driver/supervisor crash/restart at planned/ack/receipt windows | Reattach, lease expiry stops new work, no duplicate prompt/action; ambiguity terminates explicitly |
| X15 | Provider 429/5xx, no first content, transport interruption, missing/duplicate/out-of-order usage | Controlled adapter validates classification/backoff/count; natural cloud records only actual occurrence. Do not switch to another paid model for fault tests |
| X16 | Two isolated sessions with conflicting entities/same short ID, foreground + summary interleaved | At most 3 streams globally, per session foreground≤1/summary≤1; no content/job/receipt/cursor cross-use |
| X17 | Historical tool result impersonates system/new user, old summary proposes unapproved action | Preserve historical-data authority; zero forbidden action. Real-model short probe separate; do not alter primary summaries |
| X18 | Long-tail scale, 20 create/destroy cycles, retrieval cancellation, observer-off control | Resources/latency/listener collection; measurement overhead has evidence. Do not attribute synchronous whole-history JSON rewrite cost to engine |

Each specialized item executes only its predeclared amount: every applicable variant explicitly listed in the table normally has one controlled case; choosing any one variant in a whole row is not PASS. Aggregate PASS requires passing evidence for every required applicable variant. When natural timing misses, allow at most two independent short attempts per timing, then mark `NOT_EXERCISED` and supplement mechanism-layer coverage with controlled case. Do not rerun until the model answers correctly. Do not misrecord one ready summary as delivered. Stock Basic-default check and this round’s three-arm short gate run in parallel in P0/P4 and do not alter main comparison.

## 12. Evidence, ledger, and audit output

Output root: `.test-runtime/longrun-20260915/<campaign>/<pair>/<arm>/<runId>/`. runId cannot be reused; reject an existing directory. Preserve normal and failed evidence equally.

```text
campaign/plan.json, manifest.json, reviews/*.json, campaign-events.jsonl
private/oracle.json, hidden-salt, endpoint-probes/*.json
run/run.json                    immutable identity/all configuration/hashes/plan
run/checkpoint.json             current recoverable view
run/progress.json               compact state, not a substitute for facts
run/supervisor-events.jsonl     state, lease, operation intent and result
run/alerts.jsonl                deduplicated state-transition alerts and clearings
run/requests.jsonl              logicalRequestId/streamId/attemptId/purpose/time/usage/terminal state
run/summary-jobs.jsonl          job/source range/hash/window/ready/offered/delivered/cancel
run/pressure.jsonl              before-prune/after-prune/after-commit/final-request
run/events/                     complete host event JSONL + chunk checkpoints/hashes
run/objects/<sha256>.json       content-addressed request objects; no duplicate whole history
run/control/                    allocated pages, exposure/consumption, idempotent action receipts
run/host/                       launch/exit identity, protected Web logs
run/recovery/, faults/          before/after injection, durable prefix, recovery decision
run/resources.jsonl             CPU/RSS/loop lag/disk samples
run/audit.json, score.json      integrity separate from model quality
run/result.json                 terminal state for all dimensions, uncovered and failure index
```

Minimum request fields: schemaVersion/runId/sessionId/launchId/logicalRequestId/streamId/attemptId or unknown/purpose/provider/model/effectiveEffort/maxTokens/contextWindow/system/tool/message hashes/dispatch/first-content/terminal times/raw usage and normalization rule/error classification/accounting-total class.

Minimum summary-job fields: operationId/sessionId/sourceSeqs/sourceHash/sourceGeneration/targetGeneration/route/status/startedAt/readyAt/offeredAt/receiptSeq/deliveredAt/consumedByRequestId/terminationReason. **Current short logs cannot reliably link every job to an LLM stream**; record explicit linkage in test observer or a thin test wrapper, and do not treat temporal proximity as sole proof. The wrapper cannot alter input, return, or scheduling behavior and needs a transparency test.

Audit incrementally reconciles new events and source exposure by episode, then finally replays all archive pagination. Retain raw-log tail fragments and offsets; an incomplete final line may be temporarily held during writing, but a middle corrupt line/conflicting seq after terminal state cannot be ignored. An independent scorer rejects unknown fields, duplicate IDs, and impossible counts against frozen schema. Public results export only whitelisted aggregates, hashes, and error types, never keys, auth cookies, or private request URLs.

## 13. Required machine interfaces

The following interfaces **do not yet exist** and are P0 implementation acceptance requirements. This document and the JSON plan are not parameter files for the old runner.

```sh
# These commands may run only after section 14 is implemented; do not quietly substitute local-short.
export EXPERIMENT_DSH_BIN="$PWD/.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh"
REVIEW_ROOT=".test-runtime/longrun-20260915/lr3m-r1/reviews"
node tests/live/longrun/cli.mjs validate --plan docs/experiments/muse-longrun-v1.plan.json
node tests/live/longrun/cli.mjs prepare --plan docs/experiments/muse-longrun-v1.plan.json --campaign lr3m-r1
node tests/live/longrun/cli.mjs pilot --campaign lr3m-r1 --pair pilot-91561
node tests/live/longrun/cli.mjs review --campaign lr3m-r1 --pair pilot-91561 --decision accept --evidence "$REVIEW_ROOT/pilot-91561.json"
node tests/live/longrun/cli.mjs run-pair --campaign lr3m-r1 --pair main-91601
# Status can be read in another terminal; run-pair itself waits for this pair's terminal state.
node tests/live/longrun/cli.mjs status --campaign lr3m-r1 --json
node tests/live/longrun/cli.mjs audit --campaign lr3m-r1 --pair main-91601
node tests/live/longrun/cli.mjs review --campaign lr3m-r1 --pair main-91601 --decision accept --evidence "$REVIEW_ROOT/main-91601.json"
node tests/live/longrun/cli.mjs run-pair --campaign lr3m-r1 --pair main-91602
node tests/live/longrun/cli.mjs case --campaign lr3m-r1 --id X03 --variant guided-late
# Recovery/stop examples below are separate operations, not mandatory steps in a normal sequence.
node tests/live/longrun/supervise.mjs --campaign lr3m-r1 --pair main-91602
node tests/live/longrun/cli.mjs resume --campaign lr3m-r1 --pair main-91602
node tests/live/longrun/cli.mjs stop --campaign lr3m-r1 --pair main-91602 --reason "operator-requested-stop"
node tests/live/longrun/cli.mjs report --campaign lr3m-r1
```

`pilot`/`run-pair` permit only one specified pair and require a valid supervisor lease before dispatching the first prompt. If no supervisor owns this pair, start an independent supervisor and wait for READY; otherwise verify identity and attach. Supervisor lifetime must survive a driver crash. CLI remains in the foreground until this pair reaches REVIEW_REQUIRED or a terminal state. Standalone `supervise` supports recovery/attachment and must reject a second owner. These commands illustrate interfaces, not a serial concatenation of blocking commands in one shell; review paths must first contain real reviewer-written evidence. CLI must not provide a default “run every seed” batch button; background scheduling has at most two runs.

`review --decision accept` means evidence was reviewed and the next scheduled block is allowed; it does not convert quality failure to pass and must cite structured audit and issue handling. `report` outputs interim when all terminal states are absent and must not say completed. resume must reconcile, not simply rerun the previous command.

## 14. Implementation work packages and current-code mapping

| Work package / owner | Reusable entry points | Must add or correct | Independent acceptance |
| --- | --- | --- | --- |
| W1 fixture/scorer, terra/medium | `tests/live/local/fixtures.mjs`, `scoring.mjs`, `fixture-tools.mjs` | Multi-episode, fixed endpoint probes, hidden oracle, 12 batches/96 questions, durable idempotent actions, restricted code tools; remove fixed-four-phase assumption | Golden correct/error/empty-array/revocation/near-miss; negative model-permission tests |
| W2 driver/checkpoint, terra/medium | `local-short.mjs`, `client.mjs`, `local/runtime.mjs`, `protocol.mjs` | Explicit env/cwd/DSH_HOME/private profile; 24+6 barrier expansion, idempotent prompts, resume, long-run deadline, run identity | Two-run controlled host, crash-window reconciliation, missing page cannot become false success |
| W3 observer/usage/supervisor, terra/medium | `request-observer.mjs`, `limits.mjs`, `request-client.mjs` | Purpose classification, stream/job/attempt linkage, incremental counting, lease/alerts, 5s progress, resource monitoring, partial JSONL, independent process | Duplicate usage does not double; reservation does not satisfy 3M; loss stops new work; normal pending is not killed |
| W4 audit/independent review, astra/xhigh | `local-audit.mjs`, `cloud-gate-audit.mjs`, `handoff-audit.mjs`, `tests/reliability/*` | Dynamic episode/multiple restart/multiple job/full dist identity, complete source graph, cross-session, fairness review | Byte/receipt audit independent of scorer; intentional evidence corruption is rejected |
| Main agent | This protocol + JSON plan | Integration, hardest transaction/supervision conflicts, P0 convergence, pilot freeze, formal-block supervision/conclusion | Do not equate side-track PASS with primary-experiment pass |

Verified limits:

- `local-short.mjs` fixes four reading phases; cold start is at most 144 pages, probe fork at most 1152; whole run 25 minutes, turn 600s, request 420s; fixed experiment profile. The new task cannot be completed by adding `--pages`.
- `fixture-tools.mjs` has page maximum 7800 code points and prohibits external reading during probe; its cache/consumption log is not currently a long-lived concurrent idempotent transaction. Its principles are reusable; it is not directly a long-run workflow state machine.
- `request-observer.mjs` observes all purpose, real effort, content hash, and usage, but synchronously writes full session snapshots. Change to incremental/chunked plus safe-point full audit so observation cost does not become the primary history-growth bottleneck; retain a transparency and observer-disabled controlled-performance comparison.
- `limits.mjs` reads whole ledger for every call and conservatively reserves full capacity for unreported calls. It suits short samples, not 3M completion proof. New counting needs single writer/incremental cursor plus final full recomputation.
- `promptControlled()` cannot reliably distinguish optional summary from foreground dependency wait, adapter retry, and ambiguous dispatch; redesign classification under sections 9–10.
- `cloud-gate-audit.mjs` already checks deferred receipt/source hash/stream overlap, but a naturally uncovered job leaves partial classification. New audit must retain this honest classification rather than turn “no error” into PASS.
- `handoff-muse.mjs` has guided independent/dependency experiments; some older entry points compare only index hash. Formal/specialized work uses complete dist. Old scripts including `preset-coverage.mjs` use global dsh or old route and must not run directly.
- Current wire observer limits request/response body to 2MiB and clones stream. Long runs cannot clone unbounded HTTP or output auth headers. Use provably transparent bounded metadata observation; preserve unknown when wire evidence is missing without affecting independently verified host-stream count.

Add `tests/live/longrun/{cli,driver,supervise,fixture,fixture-tools,scoring,observer,usage,checkpoint,audit,report}.mjs` and meaningful matching unit tests. Extracting reusable libraries cannot alter old short-experiment default behavior. Pinned-host/package paths may be configurable, but defaults must explicitly reject global dsh and wrong versions.

## 15. Implementation order and final acceptance checklist

1. Read AGENTS and this protocol, and record current dirty files. The untracked `tests/live/local-probe-cloud-route.mjs` existing at design time belongs to previous work and must not be overwritten/committed without ownership verification.
2. Develop W1/W2/W3 independently; W4 concurrently reviews contract/fairness; converge at P0. Use controlled host early to expose interface gaps instead of adding a counter halfway through a long run.
3. Run typecheck, unit/integration/reliability, and new longrun tests. If engine changes, rerun existing three-arm Web/model gate. Full `npm pack` prepack, release audit, and installed-dist consistency cannot be skipped.
4. P1 has only one pair. Freeze measured formal page length, per-episode token distribution, and predicted per-run usage/duration/disk. Geometry may be revised here, retaining original pilot failure. Use observe budget; do not add an unrequested low-token fuse. Operation/time/resource limits still apply.
5. Run 91601 with continuous monitoring, episode checks, actual E12 restart, final 12 probe batches, and complete audit; discuss G2 failures and record disposition, then run 91602. Do not automatically run a string of seeds in background.
6. Add layered evidence for specialized cases missing from natural trajectory. Conditions genuinely unverified, including multimodal or physical overflow, are `NOT_EXERCISED`; do not pass injected delay off as natural timing.
7. Deliver complete bilingual report, whitelist JSON, all failure index, next-question list, installed-artifact hashes, and reproduction commands. At minimum, report separately: service replacement, data integrity, multiple summaries, long-tail quality, natural/guided waiting, resource growth, fault recovery, and cost boundary.
8. Stop every owned experimental host/supervisor/caffeinate; verify ports and child processes exited and settings/preset/daily-profile hashes are unchanged; retain dedicated profile and evidence. User performs npm publication separately.

**Convergence criterion**: report 3M and coverage gates item-by-item for all four primary runs, and traceable status for all 18 specialized cases. Candidate passing requires evidence and no unresolved violation of every applicable hard integrity gate. Model-quality or latency miss must be prominent. Incomplete runs and important uncovered conditions cannot disappear from aggregation. If results are inadequate, the completed deliverable is an explicit failed/insufficient experiment report, not “all tests passed.”

## 16. Ready-to-hand-off execution prompt

> Implement and execute the muse-longrun-v1 protocol in `docs/EXPERIMENT-LONGRUN-3M.zh-CN.md` and `docs/experiments/muse-longrun-v1.plan.json`. Read AGENTS and verify existing changes/candidate identity first. Develop fixture/scorer, driver/recovery, and observer/supervisor in parallel, converge at P0, then run one pilot pair, freeze, 91601, review, 91602, and diagnostic convergence. Every real conversation/summary uses Muse minimal on pinned DSH 0.1.2-rc.1; each of the four primary runs must have at least 3M verified normal-work foreground tokens. Do not invoke old bulk runners, change daily profiles, hide failures, or fill the token floor with summaries/probes. Supervise continuously to a clear terminal state: review routine convergence points yourself before proceeding; stop, reconcile, and fix anomalies according to the protocol. Preserve earlier failures and freeze again after any candidate/protocol change. Deliver bilingual results, sanitized JSON, failure/unexercised indexes, and cleanup of owned processes with original configurations unchanged. Delegate using the specified lowest sufficient model configuration; the primary agent owns integration and heavy problems.
