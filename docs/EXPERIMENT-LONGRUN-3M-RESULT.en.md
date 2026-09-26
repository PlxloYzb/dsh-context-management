# Long-run pressure experiment: execution result (muse-longrun-v2)

[Protocol design](EXPERIMENT-LONGRUN-3M.en.md) · [v1 machine plan](experiments/muse-longrun-v1.plan.json) · [v2 machine plan](experiments/muse-longrun-v2.plan.json) · [Home](../README.en.md) · [中文（规范版本）](EXPERIMENT-LONGRUN-3M-RESULT.zh-CN.md)

This page records the **first real execution** of `muse-longrun-v2`. The design
document remains the specification; this page reports only what actually ran, and
separates "established" from "failed" from "not exercised". The Chinese page is
the normative one.

**This execution found no new product defect. It found and fixed thirteen defects in the experiment tooling itself, six of which make a long campaign impossible to finish or its evidence unusable.** Where the run reached, the product behaved correctly: 24 episodes per run, 23 real turnovers, 23 delivered background summaries, one real restart, and **8/8 hard integrity gates passing**. The quality gate reported 21/96 on both arms, but that result is **invalid** (the oracle and corpus id spaces disagree).

## Final result
## The second formal pair: the result replicates

The protocol names this step `P3_SECOND_PAIR` and gates it on `G2_REVIEW`. The first
pair was reviewed and accepted (structured evidence at
`reviews/main-91601.evidence.json`, every criterion true), and the second pair ran
24 episodes in the SAME campaign on a different seed, 91602.

| | Pair 1 (seed 91601) | Pair 2 (seed 91602) |
| --- | --- | --- |
| ARC foreground tokens | 10,668,743 | 13,446,795 |
| Basic foreground tokens | 17,377,940 | 21,970,909 |
| ARC unique source tokens | 508,585 | 508,749 |
| **ARC 96 questions** | **90/96 pass** | **91/96 pass** |
| **Basic 96 questions** | **27/96 fail** | **26/96 fail** |
| ARC hard integrity gates | 8/8 | 8/8 |
| ARC-specific coverage gates | 7/8 (long tail 11/12) | **8/8 (long tail 12/12)** |
| ARC turnovers / Basic compactions | 23 / 68 | 23 / 102 |

**The conclusion replicates on a second seed**: ARC 90-91/96 against native Basic
26-27/96, a gap of about 64 questions. The second pair's ARC arm also cleared all
eight ARC-specific coverage gates for the first time (long tail 12/12), which
settles the first pair's caveat — in a clean session it answered the same class of
ambiguity question correctly.

The four primary runs total roughly **63.5M** foreground tokens (10.67M + 17.38M +
13.45M + 21.97M).


Both primary runs completed all 24 episodes, the real restart, the 12-batch
96-question final probe, and the independent audit.

| Metric | ARC_DEFERRED | BASIC_MATCHED (matched native Basic control) |
| --- | --- | --- |
| Foreground verified tokens | **10,668,743** | 17,377,940 |
| All reported tokens | 13,850,017 | 22,740,129 |
| Unique source tokens | **508,585** (gate ≥500,000) | 508,585 |
| Hard integrity gates I01–I08 | **8/8 PASS** | **8/8 PASS** |
| Common coverage gates (3M / 500k / all pages / 96 questions / restart) | 5/5 PASS | 5/5 PASS |
| ARC-specific coverage gates | **7/8 pass**; the only miss is long tail 11/12 (below) | not applicable |
| Real turnovers / native compactions | 23 turnovers | 68 compactions |
| 96-question quality (after re-asking) | **90/96, `qualityPassed: true`** (floor 87/96) | **27/96, `qualityPassed: false`** |
| Long tail | `longTailPassed: true`, `probeCleanLongTailCount` **11** | `longTailPassed: false`, 5 |
| By category | state 0/24, exact 0/24, ambiguity 21/24, timeline 0/24 | identical |
| `executionCompleted` | true | true |

**Three points:**

1. **The product passed every hard integrity gate.** The 23-turnover window chain,
   the delivery receipts and consumption of 23 summaries, the protected system
   head, tool pairing, cross-session isolation and the backend attestation all
   show no violation. This is the strongest positive result of the execution.
2. **The quality gate: root cause found, fixed, re-asked — and the first valid
   measurement is ARC 90/96 against native Basic's 27/96.** The original 21/96 was
   invalid evidence. The cause: **the campaign sealed its oracle from the PILOT seed
   (91561) while the formal pair ran 91601** — all 96 labels in the sealed `N24.json`
   belong to the 91561 corpus (96/96) and none to 91601 (0/96). None of the
   identifiers the questions named was in the 576 pages the model read, so every
   question was unanswerable; the model searched for the literal it was handed, the
   plugin honestly reported `absent: true` (all 33 searches genuine absence), and it
   answered empty. The 21 "correct" answers were only the baseline of answering
   "absent" everywhere.

   `loadSealedOracle`, `scoreRun` and the sentinel probes now derive the oracle from
   **the run's own corpus** (hidden salt plus that pair's seed, corpus manifest still
   hash-verified against its sealed record), and the correct 96 questions were
   **re-asked** — the original answers cannot be salvaged, because they answered the
   wrong questions. Result:

   | Category | ARC_DEFERRED | BASIC_MATCHED |
   | --- | --- | --- |
   | state | **21/24** | 1/24 |
   | exact | **24/24** | 3/24 |
   | source_existence_ambiguity | 21/24 | 21/24 |
   | timeline_dependency | **24/24** | 2/24 |
   | **total** | **90/96 (floor 87/96)** | **27/96** |
   | long tail | `longTailPassed: true`, probeClean long tail **11** | `false`, 5 |

   Same 24-episode journey, same questions, same model: the plugin arm answered 90
   correctly, native Basic answered 27 — and the plugin arm used **61% of the
   foreground tokens**. This is the experiment's first **valid** quality measurement
   and by far its strongest product evidence.

3. **ARC's coverage gates: 7 of 8 pass; the single miss is long tail 11/12.** The
   previous round's "four coverage gates not reached, S2/S3 never happened" was
   **wrong** — those four read `progress.coverage.<field> ?? 0` for fields **no code
   ever wrote**, so the ARC coverage gate was structurally unsatisfiable and a
   journey carrying a 25-deep lineage chain and 24 re-archives was reported as 0.
   Derived from the observed block lineage:

   | ARC coverage observation | Measured | Gate | Result |
   | --- | --- | --- | --- |
   | windowCommits | 25 | ≥12 | pass |
   | pressureWindowCommits | 25 | ≥8 | pass |
   | distinctDeliveredSourceCount | 25 | ≥6 | pass |
   | deliveryGenerationCount | 25 | ≥6 | pass |
   | rearchivedDeliveredReceiptCount | **24** | ≥2 | pass |
   | maxVerifiedSourceProcessingDepth | **25** | ≥3 | pass |
   | oldWindowLongTailCount | **19** | ≥12 | pass |
   | probeCleanLongTailCount | **11** | ≥12 | FAIL |

   So **S2 did happen**: every window turnover re-archives the previously delivered
   block, 24 times over; lineage depth is 25 against a required 3; and 19 blocks
   remain beyond the six most recent windows. **The one real shortfall is 11 of 12
   long-tail questions answered correctly** — one question short (N24-Q015, an
   ambiguity question asking which of two entities sharing a short identifier is
   authoritative; the plugin arm answered "absent"). **That answer carries a
   caveat**: the re-ask ran in the SAME session, whose history still holds the
   invalid first probe's question text — the model was observed searching `S371ab`,
   an identifier from the OLD questions that is not in the corpus. Re-running the
   answerability check with the real salt confirms **all 96 questions are answerable
   for both seeds (0 problems)**, so this one failure may be contaminated by history
   and is not established as a product defect. Ruling it out needs a clean-session
   measurement.

   The answerability check is now also enforced at **prepare** time: sealing fails
   with `ORACLE_UNANSWERABLE` if any question references content the corpus does not
   contain. It has to live in prepare, because the real salt is generated per
   campaign and a unit test cannot exercise it. The Basic arm passes its coverage gates because
   those eight do not apply to it.

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

## The diagnostic matrix (P4_DIAGNOSTICS)

The 18 diagnostics (X01-X18) had never been started: no campaign had a `cases/`
directory and the pair runner never calls the case runner. Reading each run's own
audit, progress and ledgers now gives:

| Status | Count | Meaning |
| --- | --- | --- |
| PARTIAL | 7 | Some variants carry real evidence (X02/X03/X07/X08/X09/X10/X11/X13/X16) |
| NOT_EXERCISED | 11 | No controlled implementation, or the precondition never occurred |
| PASS | **0** | Every case still has unexecuted declared variants, so none can be PASS |

Some real readings: **X08 bounded retrieval** is PARTIAL — 110 searches, 269 hits, 29
zero-hit, 26 absence-confirmed, and **3 searches hit the scan budget and returned a
`nextCursor` that was resumed 0 times** (the resume path was offered and never
taken); **X09 re-archived** is PARTIAL — re-archiving is now proven (24 times over a
lineage 25 deep) but the attachment and nested-source variants are not; **X07 tool
pairing** passes its variant (0 unpaired) while `steer` was never injected.

Starting this step exposed three defects that would have written claims the evidence
does not support:

- the recorder carried numbers from the **0.1.2 campaign** — 672 tool calls,
  "background summaries were never delivered", "no delivered summary ever re-entered
  the archive" — all false for these runs: 25 summaries were delivered, 24 delivered
  receipts were re-archived, 0 tool calls were unpaired. Asserting yesterday's
  numbers against today's runs fabricates evidence.
- `X18/create-dispose-20` was recorded as PASS from `measureCreateDispose`, which
  allocates Maps in the **recorder's own process** and samples its own heap. It never
  loads the plugin, so it cannot be plugin coverage; it is now NOT_EXERCISED with that
  reason.
- `recordCase` accepted any variant name, so a typo'd `useage-accounting` was stored
  against a matrix that never declared it; and recording every declared variant as
  NOT_EXERCISED aggregated to PARTIAL, making an **untouched case look partially
  covered**. Both are fixed, with a regression test.

The matrix still needs a real host-backed dose harness; the two existing
"implementations" exercise the harness, not the plugin.

### The first real host-backed case: X08 retrieval contract

The case needs a session with a real archive, so the probe harness reopens a
completed ARC journey — the archive it searches is the one the long run actually
built — and asks for three `search_context` calls and their verbatim results. The
model is only the transport for the tool call; the assertions are about what the
TOOL returned.

| Probe | Query | Hits | Scan budget | Cursor |
| --- | --- | --- | --- | --- |
| missing-id | `ZZZ-NOT-IN-ARCHIVE-9f3c2b` | 0 | reached | yes |
| ambiguous-id | `short=d4ba` | **2** | reached | yes |
| unique-id (control) | `short=2847` | 1 | not reached | no |

**Both halves of the retrieval contract hold**: an identifier carried by two distinct
records returns BOTH matches instead of silently selecting one, and a literal the
archive cannot contain is **not** declared absent — the scan hit its budget, the tool
said so, and it handed back a `nextCursor` rather than claiming an absence it had not
established. `missing-id` and `ambiguous-id` therefore PASS on real evidence and X08
reaches 2 of 5 declared variants (PARTIAL).

Building the case tripped two defects worth recording: the judge scanned the joined
transcript for "some object with a hits key", so all three probes were attributed to
the first result and the other two looked empty; and it demanded `absent: true` for
the impossible literal, **scoring the tool's correct, conservative behaviour as a
failure** — a truncated scan may declare itself unfinished, a completed scan may
declare absence, and silence is neither. A regression test covers all four.

#### The cursor path, walked for the first time

This was the most valuable remaining probe, because the cursor path had **never been
walked**: across both formal pairs three searches stopped at the scan budget and
handed back a `nextCursor`, and it was resumed **zero** times. A path that is offered
and never taken is exactly where a defect hides.

| Step | Call | Result |
| --- | --- | --- |
| first | `{"query":"short=","limit":5}` | 5 hits + `nextCursor` |
| resumed | `{"query":"short=","limit":5,"cursor":C1}` | **5 different hits**, success |
| misused | `{"query":"role=user-correction","cursor":C1}` | **status error (refused)** |
| bogus | `{"query":"short=","cursor":"not-a-real-cursor"}` | **status error (refused)** |

All four behave correctly: the resume **advances** rather than looping or re-serving
the first page's hits, a cursor reused for a **different query** is refused instead of
being silently answered with the original query's hits, and an invalid cursor is
refused. X08 therefore reaches **3 of 5** declared variants.

The judge had to be fixed twice, both times for scoring correct behaviour as failure:
it demanded `scanBudgetReached` or `absent` on the resumed page, when a next page
legitimately carries neither (`scanBudgetReached` describes the scan budget, not
pagination); and it treated a cross-query cursor that was **refused** as a problem,
when refusing is precisely the contract.

#### A cursor across a restart: refused explicitly, not silently empty

The last branch of the cursor semantics. A cursor was minted before a **real restart**
(verified against the durable prefix) and resumed afterwards. The plugin refuses it,
and says why:

```json
{"status":"error","code":"invalid-cursor",
 "recovery":"Restart the query without cursor. Cursors are session-scoped, bounded, and invalidated by restart or eviction."}
```

That is the contract-compliant outcome. The forbidden failure would be a **silently
empty page**, which is indistinguishable from a genuine absence; instead the cursor is
invalidated by name, with a machine-readable code and a recovery instruction. So
`restart-cursor` PASSes and X08 reaches **4 of 5** declared variants.

The judge is shared by the probe and its test and judges **explicitness rather than
success**: refused-with-a-reason and honoured-with-real-hits are both correct, an
unverified restart or a missing cursor invalidates the probe, and an **empty page that
does not declare absence** fails.

#### X01 T-1/T/T+1: the one token at the boundary

The only numeric-boundary case in the matrix, and where an off-by-one hides: the long
runs proved the plugin correct **far above** the pressure line and never once sat on
it. Two sites are the plugin's own exact comparisons, and neither had its boundary
bracketed:

| Call | Result |
| --- | --- |
| `governorCapacity(1000, reserve 800 + margin 200)` | `CONTEXT_INVALID_CONFIG` (no input budget remains) |
| `governorCapacity(1001, ...)` | `effectiveInputLimit === 1` (one token more of window fits exactly) |
| `governorCapacity(999, ...)` | `CONTEXT_INVALID_CONFIG` |
| `governorCapacity(1_000_000, ...)` | `effectiveInputLimit === 999000` (exact arithmetic) |
| `assertEnvelopeFits(4096, 4096)` | **accepted** (an exact fit must be allowed) |
| `assertEnvelopeFits(4095, 4096)` | accepted |
| `assertEnvelopeFits(4097, 4096)` | `context-envelope-too-large` |
| `assertEnvelopeFits(null, 4096)` | accepted (no measurement is not an envelope problem) |

**Both are correct at the boundary.** The existing governor test covered only the
obviously-impossible setting, and `assertEnvelopeFits` had **no unit coverage of its
comparison at all** — its failure mode is a spurious `CONTEXT_ENVELOPE_TOO_LARGE` on a
route that fits exactly, quiet enough to hide for a long time.

Both tests were verified to **discriminate**: they fail when `>` becomes `>=` and when
`<= 0` becomes `< 0`. The mutation has to be real — flipping `<= 0` to `< 1` is the
same predicate and proved nothing.

`large-result-unicode` is recorded `NOT_APPLICABLE` rather than passed: multi-byte
counting belongs to the **host token meter**, which the plugin consumes as
`heuristicTokens` and never estimates itself. X01 is therefore 3/4.
