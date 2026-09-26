# Long-run experiment: conclusions and open items

[Protocol design](EXPERIMENT-LONGRUN-3M.en.md) · [Execution result](EXPERIMENT-LONGRUN-3M-RESULT.en.md) · [Home](../README.en.md)

This page consolidates the `muse-longrun-v2` conclusions: what is **proven**, what is
**not**, and for every unproven item the **specific reason and the condition that would
close it**. The tables are generated from the machine records under `cases/`, not
transcribed by hand.

## 1. What is proven

| Conclusion | Evidence |
| --- | --- |
| Real cloud long journeys run and replicate | 4 primary runs, 24 episodes each, seeds 91601 and 91602 |
| Foreground usage far above the 3M floor | ARC 10,668,743 / 13,446,795; Basic 17,377,940 / 21,970,909 |
| Unique-source coverage above the 500k gate | 508,585 / 508,749 |
| Multi-window, multi-summary | 23-25 real turnovers and 23-25 delivered summaries per arm, all source hashes distinct, 0 duplicates, 0 missing receipts |
| Hard integrity gates | **8/8 PASS on both arms of both pairs** (I01-I08) |
| Common coverage gates | 5/5 (3M / 500k / all 288 pages / 96 questions / planned restart) |
| Quality separates the arms | **ARC 90/96 and 91/96** (clearing the 87/96 floor) against **Basic 27/96 and 26/96** |
| Real restart | the planned restart `verified`, with the durable prefix byte-identical across it |
| No quadratic complexity | the plugin's own passes: 1k/10k/50k events -> 1.3/5.3/19.1ms (50x events, ~15x time) |

## 2. The diagnostic matrix (18 cases / 76 declared variants)

Variants: **35 PASS / 3 NOT_APPLICABLE / 38 NOT_EXERCISED**, 0 FAIL, 0 INVALID_EVIDENCE.

| Case | Subject | Passing | Passing variants | Unexecuted variants |
| --- | --- | --- | --- | --- |
| X01 | Threshold/pruner/Unicode | 3/4 | T-1, T, T+1 | - |
| X02 | Pending summary and independent work | 1/2 | natural-pending | controlled-delay |
| X03 | Immediate/delayed history dependency | 1/5 | immediate | two-step, five-step, guided-empty-await, guided-late |
| X04 | Controlled delivery delay | 3/3 | delay-0, delay-5, delay-20 | - |
| X05 | Overlapping sources and revision authority | 2/2 | overlap-pending-correction, stale-authority | - |
| X06 | Summary limits/failure/fallback | 1/7 | no-summary | input-limit, output-limit, empty, timeout, cancel, budget |
| X07 | Safe pre-step and current input | 1/4 | tool-pairing | steer, queued-input, accepted-then-input |
| X08 | Bounded retrieval and cursors | 4/4 | missing-id, ambiguous-id, cross-block, restart-cursor | - |
| X09 | Archive source graph and attachments | 2/4 | rearchived, same-bytes-distinct-seq | nested-sources, attachment-reference |
| X10 | Native commands and presets | 1/8 | standard | compact, context, busy, cancel, ptc, cordis, minimal |
| X11 | Replacement lifecycle | 1/6 | enable-existing | toggle, late-basic, include-reload, config-change, no-backend |
| X12 | Cancellation and disposal | 3/3 | pending-cancel, ready-before-append, delivered-before-dispose | - |
| X13 | Host restart and transaction crash | 2/3 | flushed-restart, pending-restart | commit-gap-sigkill |
| X14 | Driver/supervisor crash recovery | 2/3 | driver-crash, receipt-window-crash | supervisor-crash |
| X15 | Provider failure and usage accounting | 1/7 | usage-missing | 429, 5xx, no-first-content, transport-loss |
| X16 | Two-session isolation | 1/2 | conflicting-ids | stream-cap |
| X17 | Untrusted history instructions | 2/3 | fake-system, fake-user | unapproved-summary-action |
| X18 | Scale/resources/observer overhead | 4/6 | create-dispose-20, scale-1k-1w, scale-10k-10w, scale-50k-50w | retrieval-cancel, observer-off |

**No case reaches full-variant PASS**; X04, X05 and X12 pass completely.

## 3. Open items by reason

### A. Missing controlled harness (34 variants)

These need a scenario the long run does not produce naturally, and the harness does not
implement it yet. They are **not** evidence of a product defect, and they **must not** be
read as passing.

| Case | Unexecuted variants | What would close it |
| --- | --- | --- |
| X02 | controlled-delay | controlled delivery-delay injection |
| X03 | two-step, five-step, guided-empty-await, guided-late | multi-step and guided history dependency |
| X06 | input-limit, output-limit, empty, timeout, cancel, budget | controlled summary-failure injection (shape already covered by the seven-reason sweep) |
| X07 | steer, queued-input, accepted-then-input | mid-turn steering and queued-input construction |
| X09 | nested-sources, attachment-reference | nested sources and attachment references |
| X10 | compact, context, busy, cancel, ptc, cordis, minimal | native commands and the remaining preset matrix |
| X11 | toggle, late-basic, include-reload, config-change, no-backend | replacement lifecycle and rollback |
| X13 | commit-gap-sigkill | a SIGKILL injected inside the commit/flush gap |
| X14 | supervisor-crash | the supervisor killed mid-lease |
| X16 | stream-cap | saturating the global stream budget |
| X17 | unapproved-summary-action | driving the model to act on archived instruction authority |
| X18 | retrieval-cancel, observer-off | cancelling retrieval at scale, and the observer-off comparison |

### B. Provider failure injection required (4 variants)

X15's `429`, `5xx`, `no-first-content` and `transport-loss` need a fault-injecting
provider. The live campaign hit one real request timeout (which the harness retried), but
none of these classes was injected.

### C. Not the plugin's responsibility (3 variants, recorded NOT_APPLICABLE)

- **X01 `large-result-unicode`**: multi-byte counting belongs to the **host token meter**;
  the plugin consumes `heuristicTokens` and never estimates tokens itself.
- **X15 `usage-duplicate`, `usage-reordered`**: usage-chunk accumulation belongs to the
  **host meter**; the plugin consumes a finished `TokenMeasurement`.

Crediting the plugin with the host's correctness would be a false claim, so these are
recorded as not applicable rather than as passes.

### D. Unmeasured items outside the matrix

- **Host-level cost at scale**: X18 measured only the plugin's **own** passes, in process.
  A host session gains content through model turns, so 50k events through a real host would
  need a model call per event; **host-level cost at scale remains unmeasured**.
- **The 400k close-out numbers** (28/35, 17.1% strict) come from earlier work and were not
  re-run on the 0.1.7 host.
- **The v1 protocol on 0.1.2-rc.1** is superseded by v2 and no longer reproduced.
- **Desktop profile installation**: not done, on your instruction
  (`docs/data/host-install-0.1.7.json` records `desktopProfileInstall.done: false`).

## 4. What is explicitly NOT claimed

- **Not "faster or cheaper"**: ARC used 61-65% of Basic's foreground tokens, but that is a
  **single observation**, not an efficiency conclusion.
- **Not host-level scale safety**: only the plugin's own passes are proven free of
  quadratic behaviour.
- **Not "the 18 diagnostics pass"**: no case passes all its variants.
- **Not that the unexecuted variants pass**: 38 variants are unexecuted and listed above.

## 5. The tooling defects this experiment exposed and fixed one by one

The objective asks that every failure be recorded and iterated on. **No new product
defect was found; the failures were all in the experiment tooling itself** — more than
**30**, in four kinds:

### 1. Made a campaign impossible to finish (6)

| Defect | Consequence |
| --- | --- |
| `ledger-probe.mjs` referenced an undeclared `done` | the Basic arm's host died at load; the arm failed as `fetch failed` |
| the orchestrator never stopped its supervisor | after a pair settled the CLI **never exited**, holding its lease and ports; three abandoned orchestrators were still up 30-40 minutes later |
| the 0.1.7 `settings` entry is disabled without a `profileContext` | the provider was never registered and every run died with `no adapter registered` |
| only `settings.yaml` was read | the host renames it on first boot, so every later PREFLIGHT failed with ENOENT |
| preset location hard-coded to the 0.1.2 layout | `No shipped preset definitions found` |
| the observer required the removed `kind: 'plugin'` | no receipt row could be written and gate I05 falsely reported a product defect |

### 2. Made evidence invalid, or fabricated it (7)

| Defect | Consequence |
| --- | --- |
| the sealed oracle came only from the pilot seed | the formal pair answered questions about **another world**; the quality score was meaningless |
| I05 counted ledger rows, not operations | three operations were reported as 3 duplicates plus 3 missing receipts |
| I07 read only nested tool-result text | 0.1.7 emits flat blocks, so a valid `arc_status` was never evidence |
| full page exposure compared cumulative to per-episode | a complete 288-page journey read as incomplete |
| an absent answer was graded a format violation | all 96 questions zeroed on both arms, destroying the quality signal |
| the recorder carried 0.1.2's numbers | asserting yesterday's numbers against today's runs fabricates evidence |
| the X18 harness measured the recorder's own heap | a harness measurement passed off as plugin coverage |

### 3. Broke recoverability and consistency (8)

The retry path was unusable (any retryable failure became a fatal `PROMPT_ALREADY_PLANNED`;
one 420s timeout ended the Basic arm at 14.3M tokens); the request ceiling sat inside the
server's long tail; `finalize` never wrote a terminal state; the barrier waited six hours
for a terminal peer; a resumed run lost its identity and its port; a SIGTERM'd orchestrator
leaked its host; scoring after auditing produced a self-contradicting coverage verdict; and
the corpus-integrity check **had never verified anything** because of a wrong field name.

### 4. The matrix itself overclaimed coverage (4)

`recordCase` accepted undeclared variants (a typo'd `useage-accounting` was stored);
"everything unexecuted" aggregated to PARTIAL; a control probe was written into a declared
variant slot and overwrote that variant's evidence; and **a delay test that could not fail
for its own reason was written and then deleted**.

**All 30-plus failures were recorded and fixed, and more than 20 carry discriminating
tests** (removing the fix fails them). No new product defect was found in the same batch —
including I05, which first looked like one and was an outdated observer predicate.
