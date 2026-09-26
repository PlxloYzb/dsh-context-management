# Overview: features, advantages, and history

[简体中文](OVERVIEW.zh-CN.md) · [Home](../README.en.md) · [Design](DESIGN.en.md) · [Test data](TESTING.en.md) · [Changelog](../CHANGELOG.md)

One page on what dsh-context-management is, what it does, which advantages the
evidence supports, and which it does not.

## The problem it solves

Context only grows in a long task. The native approach replaces old history with
one summary, and **the originals are gone**: a path, identifier or verbatim value
the summary dropped can never be recovered, while the model's usable window is a
hard ceiling.

This plugin separates "the current working context" from "history that can be
looked up":

- the current window stays bounded (window turnover / in-place compression /
  bounded overshoot, three levels of degradation);
- original history stays in the session's append-only event log, **undeleted**;
- the model can search it and page the originals back within a budget, and treats
  what it recovers as historical data rather than as new instructions.

## Features

### Model-facing tools

| Tool | Purpose |
| --- | --- |
| `new_context` | Submits only the turnover **intent**; the change happens at the next safe pre-step, protecting the current user input and tool call/result pairing |
| `compress` | Replaces one or more consumed surface ranges with a dense summary the model writes; batched, disjoint ranges |
| `decompress` | Reads one block's originals back by blockId (plus cursor); it does **not** unshadow the range |
| `search_context` | **Literal substring** search over the current session's history, returning hits and a cursor |
| `arc_status` | Current pressure, durable blocks, compressible ranges, the surface seq space |
| `await_context` | Waits for the background summary only when the next action truly needs missing history; independent work continues. Not registered unless the background summary is configured |

### Engine capabilities

- **Two strategies**: `windowed` (default: advance to a new window as pressure
  rises, carrying a continuity summary) and `in-place` (fold old content inside
  the current window).
- **Three-level degradation chain**: turnover → in-place reversible fallback
  (extractive, **no summarizer model call**) → bounded overshoot (recorded as
  `overshoot-within-physical-limit` and admitted, instead of failing).
- **Separate soft and hard pressure lines**: the effective input line and the
  physical input line are distinct, which removes the "budget cliff".
- **Adaptive fidelity**: answer directly when the summary suffices; descend into
  the lossless layer on the model's own judgement when exact values or verbatim
  text are needed.
- **Bounded retrieval**: scan volume, return volume and pagination cursors all
  have limits; each turn has a hard retrieval cap (convergence guaranteed in the
  engine); incomplete and error states are explicit.
- **Optional background summary**: once configured, the old window prepares a
  summary bound to a source hash; the default `delivery: deferred` commits the
  deterministic index first, and the host appends the summary at a later pre-step.
  It is **not a second window replacement**, and no extra request is made after the
  final answer merely to deliver a summary.
- **Takes over native Basic**: installing enables the bundle in the target
  profile, and the bridge replaces native Basic **in its existing service
  position**. `/compact` runs through the taken-over engine; `/arc` and `/context`
  report status.
- **Stays in its lane**: official `minimal` has no native compaction and stays
  untouched; third-party compaction backends stay untouched; host preset files are
  **never edited**; after uninstall the host restores its own Basic.

### Configuration surface (excerpt)

```yaml
adaptiveGovernor:
  strategy: windowed          # or in-place
  windowBudgetTokens: 203531
  maxOutputTokens: auto       # auto preserves explicit output intent, else 32K; a number is a hard cap
  safetyMarginTokens: 4096
  nudgeAtEffectiveCapacityPct: 0.75
  emergencyAtEffectiveCapacityPct: 0.9
  emergencyFallback: true
archive:
  seedMaxTokens: 4096
  retrievalDefaultMaxTokens: 2048
  retrievalMaxTokens: 4096
backgroundSummary:            # absent means disabled
  provider: opencode-go-muse
  model: muse-spark-1.3-contributor
  reasoningEffort: minimal
  allowSameProvider: false    # same-provider concurrency requires an explicit true
  delivery: deferred          # or seed, for comparison
  prepareAtEffectiveCapacityPct: 0.6
  maxInputBytes: 262144
```

Plus `autoTools` / `autoCommand` / `autoNudge`, protection and threshold knobs
such as `protectedRecentMessages` and `minCompressChars`, and prompt templates
that can be replaced wholesale.

## Advantages the evidence supports

### 1. Lossless reversibility — structural, and native cannot do it

**The strongest single piece of evidence (0.8.6, identical conditions: seed 91501, 144 pages, F3, batch 12, muse route):**

| Arm | PAGE-11 | PAGE-46 | PAGE-89 | Score | Compactions |
| --- | --- | --- | --- | --- | --- |
| **B_IN_PLACE (plugin)** | `ae3790159a` | `6da15bef1b` | `0972779886` | **3/3** | 3 |
| **A_NATIVE (native Basic)** | `null` | `null` | `null` | **0/3** | 9 |

Both arms were `strictPassed`, facts 24/24, corrections 6/6, `deliverablePassed: true` —
**native preserves the authoritative facts too**. The verbatim probe asks for
**exact historical literals that were already compacted away**: native cannot
restore them, and the plugin's three checksums match byte for byte. The native
arm's 0/3 was checked for false negatives item by item — it is a well-formed
object with exactly the right keys, so the model understood the question and
honestly reported the values as unavailable.

**The conclusion is exactly this narrow: the plugin's gain is not in "preserving
authoritative facts" (native manages that) but in "exact history stays
retrievable".**

The 150k iteration's final comparison (same task, same scoring, one local Qwen
journey) is the second body of evidence for the same conclusion:

| Arm | Configuration | P1 facts/corrections | P2 verbatim checksums | tokens |
| --- | --- | --- | --- | --- |
| A native default | Basic @ 314,573 | 24/24 + 6/6 | **0/3** (no retrieval) | 8.99M |
| B native calibrated | Basic @ 150,000 | 24/24 + 6/6 | **0/3** | 6.05M |
| **C plugin (fixed)** | windowed W=203,531 | **24/24 + 6/6** | **3/3** (7 retrievals) | **5.9M** |

Note this is **single-journey engineering evidence, not statistical confirmation**.

### 2. Factual recall does not regress

27 fixed synthetic samples (3 seeds × 3 runs × 3 arms, `opencode-go/glm-5.3-flash`):

| Strategy | Completed | Recall before restart | Recall after restart | Both corrections after restart | Verbatim retrieval |
| --- | --- | --- | --- | --- | --- |
| A host Basic | 9/9 | 108/108 | 108/108 | 9/9 | 9/9 |
| B plugin in-place | 9/9 | 108/108 | **98/108** | **4/9** | 9/9 |
| **C plugin windowed (default)** | 9/9 | 108/108 | 108/108 | 9/9 | 9/9 |

The default `windowed` matches native; `in-place` is clearly worse after a
restart — which is why `windowed` is the default and `in-place` is kept only as an
option. **No claim of lower cost or higher speed follows from this.**

### 3. Bounded at scale

Apple M4 Pro, 512 MiB heap cap, one synthetic scale seed:

| Metric | Measured |
| --- | --- |
| events / archives / windows | 100,001 / 1,100 / 100 |
| cold load | 440.12 ms |
| search p95 / max | 17.10 / 22.67 ms |
| RSS / used heap | 289.61 / 114.90 MiB |

### 4. Engineering reliability (current state, reproducible)

| Gate | Result |
| --- | --- |
| typecheck (strict / ESM) | 0 errors |
| unit | 189/189 |
| real-host integration | 172/172 |
| reliability (Basic replacement contract) | 8/8 |
| live local unit | 36/36 |
| cross-host gate `npm run test:host` (rc.2) | all five green |

Host end-to-end (real cloud model, `B_IN_PLACE / F3 / 144 pages / pressure 90000 / batch 12`):

| Host | Result | Takeover evidence |
| --- | --- | --- |
| 0.1.7-rc.1 (local) | `strictPassed`, facts 24/24, corrections 6/6, verbatim 3/3, 23 calls / 115s | all 6 summaries `adaptive-governor-extractive-v1` with the ARC banner, 0 summarizer calls |
| 0.1.7-rc.2 (the desktop application's own host) | `strictPassed`, facts 24/24, corrections 6/6, verbatim 3/3, 26 calls / 102s | same |

Install and uninstall: both hosts install through `dsh plugin add` (34 dist files
verified by sha256 individually), and after removal dependencies are back to `{}`,
`node_modules` is empty, the composed tree mentions the plugin zero times, and
`compaction-basic` is intact.

## Advantages that are NOT proven

This section matters more than the previous one.

- **The 400k experiment (a 180-case preregistered queue) produced no confirmed
  conclusion.** The official close-out says 28 of the C arm's 35 real attempts
  died on "retained input exceeds the effective budget with no safe reducible
  region" (17.1% strict completion on the real-denominator basis, against A 70.0%
  and B 69.7%). Every preregistered confirmation threshold was unevaluable — 82 of
  the 180 cases were infrastructure failures. **"Non-inferior / better / cheaper /
  faster" all fail.**
- **Cost and speed have never been claimed.** The time ratio C/B = 0.52 is
  explicitly annotated as uninterpretable as an efficiency advantage (C's
  "faster" comes from failing early).
- **A real provider's physical overflow was never triggered**; controlled loop
  overflow tests are not a substitute.
- **The 3M long-run experiment is designed but not executed** (protocol and machine
  plan are ready).
- Other host versions, models, HMR and unbounded nesting are outside the coverage
  of the existing data.

These boundaries are written down in the [400k close-out](EXPERIMENT-REPORT.en.md)
and [test data](TESTING.en.md); none of it is hidden.

## History

96 commits, 45 versions. Grouped by what actually changed:

| Phase | Versions | What happened |
| --- | --- | --- |
| Start | 0.1.0 → 0.1.1 | First release: reversible compression, automatic turnover, historical retrieval, manual commands; then automatic takeover of native Basic across every preset in the target profile (custom row names, nesting, preset switching) |
| **Failure and the big fix** | **0.2.0** | One large release after the 400k close-out: the gate that kept background preparation from ever starting in an installed layout, the Basic takeover lifecycle boundary, background summaries defaulted to `delivery: deferred` with a new `await_context`, and the new `allowSameProvider`. The honest cloud verdict for short paging tasks was **0/4 adoptions** |
| Retrieval index | 0.3.0 → 0.6.1 | 3-gram block filtering; fixed a Unicode case-folding defect that reported existing originals as absent; the index was re-keyed by unique original event and built incrementally (first index over a sealed archive fell from 74.26M characters to ~2.68M unique originals); per-session cache of 64 indexes with eviction/disposal/rebuild; a new `index: false` pure-scan fallback switch; three cursor cases filled in |
| Accounting | 0.7.0 | Contract §7 work accounting: cold, hot and paged retrieval costs and hits reported separately |
| Pressure-fix loop | 0.7.1 → 0.9.6 | Pressure-floor calibration (and a correction of the too-strong "the floor is one number" claim); fixed in-place emergency fallback repeating without bound inside one turn, and "progress every time but never converging"; added the missing per-turn cap on the windowed arm; fixed three scoring false negatives that graded correct answers as zero; 0.9.0 found and fixed an error in the emergency fallback's own "progress" criterion; 0.9.5's three-arm gate reached **18/18 on both plugin arms** |
| **The decisive comparison** | **0.8.6** | Native arm and plugin arm run under identical conditions: **native compaction destroys exact history, the plugin restores it intact** — the verbatim probe scored 0/3 native, 3/3 plugin |
| Settling accounts | 0.9.7 → 0.9.9 | Actually measured the index bound the design doc had marked "not measured"; ran the four gates outside `check`; traced the root cause of "dist drift" (a version-string and docs difference alone changes the artifact) |
| Port | 0.9.10 / 0.9.11 | Both engine fixes re-verified; ported to DSH 0.1.7-rc.1 (source kind, surfaceOp, system/message, preset registry and other breaking changes); verified end-to-end on a real host |
| **This round** | **0.9.12** | Peers widened to `^0.1.7-rc.1` (the exact rc.1 pin made rc.2 **install but refuse to load**); a cross-host regression gate; three defect classes fixed — the protected system head, the compaction bracket, and fixture realism; both rc.1 and rc.2 pass end-to-end |

The turning point on that curve is the 150k iteration's v11 close (local Qwen,
proportionally scaled, 432 pages ≈756k tokens): P1 24/24 + 6/6, P2 3/3, 5.9M
tokens, with regression tests behind all eight defect classes.


## The one-line trade

**It does not promise to be faster, cheaper, or smarter than native compaction.**
What it promises is: originals are never lost, they can be fetched on demand, the
current window stays bounded, the degradation path is explicit, installing takes
over, and uninstalling leaves nothing behind — and after being **proven unable to
sustain 2M-token journeys**, those structural defects were fixed one by one with
regression tests left behind.
