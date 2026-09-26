# Long-run pressure experiment: execution result (muse-longrun-v2)

[Protocol design](EXPERIMENT-LONGRUN-3M.en.md) · [v1 machine plan](experiments/muse-longrun-v1.plan.json) · [v2 machine plan](experiments/muse-longrun-v2.plan.json) · [Home](../README.en.md) · [中文（规范版本）](EXPERIMENT-LONGRUN-3M-RESULT.zh-CN.md)

This page records the **first real execution** of `muse-longrun-v2`. The design
document remains the specification; this page reports only what actually ran, and
separates "established" from "failed" from "not exercised". The Chinese page is
the normative one.

**This execution found no new product defect. It found and fixed thirteen defects in the experiment tooling itself, six of which make a long campaign impossible to finish or its evidence unusable.** Where the run reached, the product behaved correctly: 24 episodes per run, 23 real turnovers, 23 delivered background summaries, one real restart, and **8/8 hard integrity gates passing**. The quality gate reported 21/96 on both arms, but that result is **invalid** (the oracle and corpus id spaces disagree).

## Final result

Both primary runs completed all 24 episodes, the real restart, the 12-batch
96-question final probe, and the independent audit.

| Metric | ARC_DEFERRED | BASIC_MATCHED (matched native Basic control) |
| --- | --- | --- |
| Foreground verified tokens | **10,668,743** | 17,377,940 |
| All reported tokens | 13,850,017 | 22,740,129 |
| Unique source tokens | **508,585** (gate ≥500,000) | 508,585 |
| Hard integrity gates I01–I08 | **8/8 PASS** | **8/8 PASS** |
| Common coverage gates (3M / 500k / all pages / 96 questions / restart) | 5/5 PASS | 5/5 PASS |
| ARC-specific coverage gates | **4 not reached** (below) | not applicable |
| Real turnovers / native compactions | 23 turnovers | 68 compactions |
| 96-question quality | **21/96 — INVALID evidence** (oracle and corpus id spaces disagree, below) | same 21/96 — invalid evidence |
| By category | state 0/24, exact 0/24, ambiguity 21/24, timeline 0/24 | identical |
| `executionCompleted` | true | true |

**Three points:**

1. **The product passed every hard integrity gate.** The 23-turnover window chain,
   the delivery receipts and consumption of 23 summaries, the protected system
   head, tool pairing, cross-session isolation and the backend attestation all
   show no violation. This is the strongest positive result of the execution.
2. **The quality gate result is INVALID, not failed.** Only 21 of 96 questions were
   correct, all in the source-existence/ambiguity category, and the two arms are
   identical. Checking question by question showed this is **not a model or product
   problem**: every oracle question names a `targetLabel` (`STATE-…`, `TML-…`,
   `EXACT-ISL-…`, `EXIST-ISL-…`) and expects verbatim values that appear in **no page
   of the corpus** — none of those identifiers is anywhere in the 576 pages the model
   read. The model behaved correctly: it searched `search_context` for the literal
   the question gave it, the plugin **honestly** reported `absent: true` (all 33
   searches were genuinely absent, not a retrieval defect), and it answered empty or
   declared the value absent. The 21 "correct" answers are the ambiguity questions
   whose right answer is absence — that is the baseline of a degenerate
   "answer absent everywhere" strategy. This page therefore **does not report 21/96
   as a product-quality result**; it is invalid evidence.

   A permanent invariant test now exists (`w1.test.mjs`, "every sealed oracle question
   names a target and values the corpus actually contains"). It **currently fails and
   pinpoints 57 problems**: the `publicLabel` of all 24 state questions is never
   rendered into a page, the `groupId` of all 24 existence questions likewise, and 9
   expected verbatim values are absent from the corpus. Repairing the fixture's id
   spaces is the first task of the next round.
3. **Four ARC-specific coverage gates were not reached**:
   `rearchivedDeliveredReceiptCount`, `maxVerifiedSourceProcessingDepth`,
   `oldWindowLongTailCount` and `probeCleanLongTailCount` are all 0. They are
   exactly "an old summary compressed again (tier 2/3)" and "long-tail retrieval
   across more than six windows" — **neither pressure condition occurred on this
   trajectory**. The Basic arm passes its coverage gates because those four do not
   apply to it.

**Cost observation (not an efficiency claim)**: on the same 24-episode journey ARC
used 61% of the native Basic foreground tokens (10.67M vs 17.38M) at the same
quality score. That is consistent with the historical conclusion — it does not
license a "faster/cheaper" claim, only a record of this run's usage.

## Why a v2 exists

v1 froze the host at `0.1.2-rc.1`. The product has moved to the 0.1.7 prerelease
series, whose host differs in three ways (shipped presets moved into the web-app
bundle as `<id>.patch.yml`; a profile must state `packageManager`; a pin may hold
only a `dsh` symlink), and whose irreducible per-request baseline is larger, so the
pressure geometry has to be re-derived rather than inherited. `muse-longrun-v2` is
the same protocol, same 96-question oracle, same 18 diagnostics, with the host and
geometry changed and eight pressure conditions (S1–S8) declared explicitly —
**designed to expose defects, not to demonstrate success**.

The geometry was measured, not guessed. The floor was bisected at 144 pages / F3 /
batch 12:

| Pressure | Result |
| --- | --- |
| 45000 | `CONTEXT_BUDGET_EXHAUSTED`, retained 58619 > physical 54096, nothing archived yet |
| 60000 | `CONTEXT_BUDGET_EXHAUSTED`, retained 84675 > physical 70763, 1 in-place fallback |
| 90000 | passed: `strictPassed`, facts 24/24, verbatim 3/3, 6 compactions |

**80000** was chosen: just above the floor, so each journey has to survive many
real turnovers rather than one or two.

## Eight defects the experiment tooling exposed and fixed

The first three make a campaign impossible to complete.

| # | Defect | Consequence | Fix |
| --- | --- | --- | --- |
| 1 | `ledger-probe.mjs` referenced an undeclared `done` | the Basic arm's host died at load (`ReferenceError: done is not defined`) and the arm failed as `fetch failed` | removed the vestigial guard; the hard-coded chunk name became a whole-dist manifest hash |
| 2 | the pair orchestrator never stopped its supervisor | the supervisor runs with piped stdio and never exits, so after a pair settled the CLI **never exited**, holding its lease and ports; three abandoned orchestrators were still up 30–40 minutes later | `releaseSupervisor`, with a test that fails when the SIGTERM is removed |
| 3 | the provider was never registered | on 0.1.7 the `settings` bundle entry is disabled without a `profileContext`, which only the Electron app supplies, so a CLI-launched profile read no settings and every run died with `no adapter registered for provider "opencode-go-muse"` | inline the `llm-pi-ai` section from the same private settings into the arm patch; only `apiKeyEnv` names travel, never key material |
| 4 | only `settings.yaml` was read | the host renames it to `settings.yaml.imported` on first boot, so every later run failed PREFLIGHT with ENOENT | tolerate the file the host left behind |
| 5 | preset location hard-coded to the 0.1.2 layout | `No shipped preset definitions found for host 0.1.7-rc.1` | locate per layout; the bundle copy is hashed as evidence but not copied, because a copy is not the file the host reads |
| 6 | the observer required `kind: 'plugin'` | 0.1.7 removed that generic source kind, so **no receipt row was ever written** and integrity gate I05 reported a delivered summary with no receipt | accept `context-management` (the kind the plugin declares on 0.1.7), keeping the 0.1.2 spelling |
| 7 | hard-coded pin, profile without `packageManager` | could not target 0.1.7; and corepack resolved a pnpm that ships only `pnpm.mjs`, so the plugin install failed | one resolver, and `packageManager` stated only where the host needs it |
| 8 | backend evidence left to chance | I07 must prove the active backend from evidence, but the model may never call `arc_status`, so the gate could only refuse | one bounded backend-attestation turn at the start |
| 9 | the retry path was unusable | `plan()` threw for any existing id, so **every retryable failure became a fatal `PROMPT_ALREADY_PLANNED`**: one 420s request timeout ended the Basic arm at 14.3M tokens | only a `failed` previous attempt may be re-planned; ambiguity stays sticky; regression test added |
| 10 | request ceiling too tight | the 420s cap sits inside the measured server long tail (the 150k iteration recorded 356–624s) | raised to the turn ceiling (600s) so a slow tail is retried instead of fatal |
| 11 | terminal state never written | `finalize` set only `terminalReason`, so a failed run read as RUNNING forever — and, with the next item, parked its peer at a barrier | `finalize` now writes a terminal state |
| 12 | barrier waited forever on a terminal peer | a terminal peer never reaches the endpoint, yet the wait spun for the 6-hour work deadline | the barrier detects a terminal peer, records "unpaired" and stops waiting |
| 13 | a resumed run lost its identity and its port | the resumed Driver carried no `campaign`/`pairId`, so the final probe could not find the sealed oracle; a SIGTERM'd orchestrator leaked its host and the port stayed bound (`loopback Web launch URL unavailable`) | identity is passed and falls back to the run record; the run's own recorded hosts are reclaimed before launching, and stale terminal fields are cleared |

Three more defects on the audit side turned correct behaviour into an apparent
product failure, and are fixed too:

| # | Defect | Consequence | Fix |
| --- | --- | --- | --- |
| 14 | I05 counted ledger rows, not operations | a `termination` row repeats `status: 'delivered'` with no `receiptSeq`, so three operations were reported as `duplicateOperation: 3, missingReceipt: 3` | count `receipt` rows only, merged by operationId; a duplicate now means two receipts for one operation |
| 15 | I07 read only nested tool-result text | 0.1.7 tool results are flat `{type:'text',text}` blocks, so the text came out empty and a valid `arc_status` result was never evidence | read both the flat and the nested shapes |
| 16 | full page exposure compared cumulative to per-episode | `assignedPages` is per-episode and `exposedPages` cumulative, so a complete 288-page journey read as incomplete | compare against the assignment BOUND; I04 independently rejects out-of-bound reads |
| 17 | an absent answer was graded a format violation | the model's `{"present": false, "recordId": null}` — the shape the question itself offers for "not found" — was a `SCHEMA_VIOLATION` that **zeroed all 96 questions**, on both arms, destroying the quality signal | `present:false` with `recordId:null` is now a WRONG answer, not a format violation; only claiming presence without an identifier is malformed |

**Item 6 is worth singling out**: it first looked like a product defect — "a
delivered summary marked delivered without a durable receipt" is exactly the
protocol's central delivery contract. Line-by-line checking of the job ledger
showed the observer was using the 0.1.2 source predicate. **No product violation.**
That is the value of separating "product" from "tooling" before reporting.

## Product side: what is established

- **Window chain is correct**: 23 window blocks, 22 carrying `parentBlockIds`
  lineage, and the `windowIdentity` generation chain is contiguous (0 → 23).
- **The delivery contract holds**: 23 delivered, all source hashes distinct, each
  with an integer `receiptSeq`, each actually consumed by a later foreground
  request (23 `consumed`, 0 `unconsumed`). **No duplicate delivery, no missing
  receipt.**
- **The protected system head was never rewritten**: exactly one `system/message`
  for the whole journey, consistent with 0.1.7's rule that node 0 may only be
  rewritten by a `system/message` over exactly that node.
- **Restart recovery**: the real restart after episode 12 is `verified: true`, with
  identical hashes, no replayed prompt and no duplicated replacement.
- **Tool pairing**: 371/371, zero dangling.
- **Backend attestation**: `arc_status` returned
  `{"backend":{"status":"active","resolvedBackend":"dsh-context-management"}}`.

## Failed / not exercised — none of these may be read as passing

- **S2 "old summaries re-compacted (tier 2/3)" did not occur**: all 23 summaries
  are `tier` 1, the tier 2/3 count is 0, and in-place emergency fallback fired 0
  times. At this geometry a window advance shadows the old seed outright, so a
  *live* summary node was never compressed again.
- **`decompress` was never called** and `search_context` only twice — the long-tail
  retrieval capability was **not actually stressed** on this trajectory.
- **A real provider's physical overflow was never triggered**; controlled loop
  overflow tests are not a substitute.
- **Mid-turn steering was not injected**: queued input (194 `agent/inbox/spliced`)
  happened naturally, but steering during a running turn was not constructed.
- **The model called `ask_user_question` once**: that tool should not be present in
  an experiment session. It did not break this trajectory, but it is a gap in the
  tool-surface narrowing.
- **The final 96-question score, the 12 probe batches and the 18 diagnostics** are
  reported by the ledger at the end of this page; anything not executed is recorded
  as NOT_EXERCISED, never as passing.

## The real cost and geometry constraint

Measured in the 2-episode pilot: ARC costs about 582k foreground tokens per
episode and Basic about 672k; 12 pages yield about 21,159 unique source tokens.
Therefore:

- the 3M floor is satisfied after about **6 episodes**;
- the 500k unique-source coverage gate needs **24 episodes** (the protocol's
  minimum formal endpoint).

The two gates are satisfied at different episode counts, so a formal run must
overshoot the token floor by design (this run: 24 episodes ≈ 10.7M). At the
measured cost, v1's four primary runs would need roughly **64M** foreground tokens,
so v2 reduces the formal scope to **one pair (two runs)** and records that
reduction in the plan rather than hiding it.

## Reproduction

```sh
# Requires a configured Muse route and an isolated HOME
ISO="$PWD/.test-runtime/isolated-home"
export HOME="$ISO" DSH_HOME="$ISO/.dsh" EXPERIMENT_HOST_PIN=dsh-0.1.7-rc.1

node tests/live/longrun/cli.mjs validate --plan docs/experiments/muse-longrun-v2.plan.json
node tests/live/longrun/cli.mjs prepare  --plan docs/experiments/muse-longrun-v2.plan.json --campaign <id>
node tests/live/longrun/cli.mjs pilot    --campaign <id> --pair pilot-91561 --episodes 2
node tests/live/longrun/cli.mjs run-pair --campaign <id> --pair main-91601
node tests/live/longrun/cli.mjs status   --campaign <id>
```

Raw evidence lives under the git-ignored
`.test-runtime/longrun-20260915/<campaign>/`: per-request observation, usage and
job ledgers, pressure trace, and the independent audit.
