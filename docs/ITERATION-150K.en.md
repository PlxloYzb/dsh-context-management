# 150k Local Iteration Log: from "long journeys always die" to adaptive fidelity

[简体中文](ITERATION-150K.zh-CN.md) · [400k experiment report](EXPERIMENT-REPORT.en.md) · [Design](DESIGN.en.md)

Updated 2026-09-15. This log records the fix-iterate loop driven by the 400k close-out findings: small steps, one variable per round, no bulk serial batches. All conclusions come from real model journeys; raw evidence lives in the private `.test-runtime/experiments/context-150k-iter1/`.

## Background and scope

The 400k experiment concluded that the C arm (plugin windowed) failed 28/35 genuine attempts with one structural defect: when retained input crossed the effective budget line there was no degradation path, and the journey terminated. This iteration repaired and validated at a proportional scale (150k pressure line, 432 pages ≈756k tokens, a 5× pressure ratio) on a local Qwen3.8-27B (384K tier, single concurrency, reasoning low).

**Scope statement**: this is engineering iteration evidence (one task, one seed, one journey per arm), not statistical confirmation. Its purpose is eliminating defects one by one and validating mechanisms — not claiming product superiority.

## Iteration scoreboard

| Round | Symptom | Root cause | Fix |
| --- | --- | --- | --- |
| smoke 1a | phase 3 stopped at budget cap | smoke budget calibration error | ledger counts full request inputs |
| smoke 1b | 3 phases alive but 2 batches (24 pages) skipped | mid-turn fallback `preserveRecent=0` shadowed recent tool results, breaking the model's ledger | always preserve recent surface nodes |
| smoke 2 | phase 1 hit turn timeout | server-side long-tail stalls (356–624s) | relaxed driver timeouts + transport retry |
| smoke 3 | **full survival, zero missing pages** | — | degradation chain (budget cliff + soft/hard pressure split) validated |
| 3-arm mini | A/B perfect; C stopped at phase 2 with 9 pages missing | fixed-node recency split tool pairs mid-way → each fallback bite too small → storm | **step-aligned recency** + up to three bites per emergency + a "recent work" anchor |
| v3–v5 | `protected-current-user` killed the turn ×3 | range selector skipped user-message protection under incoming admission + raw-array index drift | unconditional protection + `eventAt` everywhere + constructive belt |
| v5 | admission guard hard line killed the turn | the soft/hard split missed the admission path | same split applied at admission |
| v7 | first 432/432; P2's 18 retrievals all failed | the model regex-ified search + parallel calls starved the retrieval budget | "plain substring" tool wording + three-grant burst pool per step |
| v8 | P1 timed out (an 82-call retrieval campaign) | soft caps ignored by a thorough model | **hard per-turn retrieval allowance of 20** (engine-level convergence) |
| v9 | **P2 3/3 perfect** (5 retrievals); P1 10/24 | window seeds only kept JSON scalars, prose fact lines lost; fallback checkpoints cut chronologically | evidence index gains `identifier = "quoted value"` records + value-ranked eviction |
| v10 | P1 rose to 13/24; P2 regressed to 0/3 (all null) | retrieval budget coupled to the soft line — zeroed at high pressure, starving retrieval exactly when needed | physical-headroom retrieval floor; fallback matcher gains the same shape |
| **v11** | **P1 24/24+6/6 strict pass; P2 3/3; 5.9M tokens** | — | **complete closure** |

## Final comparison (same task, same scoring, local Qwen, serial single journeys)

| Arm | Configuration | P1 facts/corrections | P2 verbatim checksums | tokens |
| --- | --- | --- | --- | --- |
| A native default | Basic @ 314,573 | 24/24 + 6/6 | 0/3 (no retrieval capability) | 8.99M |
| B native calibrated | Basic @ 150,000 | 24/24 + 6/6 | 0/3 | 6.05M |
| **C plugin (fixed)** | windowed W=203,531 | **24/24 + 6/6** | **3/3** (7 retrievals) | **5.9M** |

## Adaptive fidelity: design and validation

Design (operator-proposed): **summary first, model-judged sufficiency** — answer directly when the summary suffices; descend into the lossless layer only when exact values or verbatim text are needed.

Validated shape in v11:
- Summary sufficient (correction tracking): answered directly with zero retrieval, 6/6;
- Verbatim needed: the model judged correctly → bounded retrieval (7 calls) → 3/3 exact recovery — a capability pure-lossy arms (A/B) structurally cannot match;
- Engine-level convergence guaranteed (20 grants per turn, then an explicit "answer now" notice);
- Cost parity with pure lossy (5.9M vs 6.05M): lossless no longer means expensive.

## Fixed defects (each with regression tests, changelog in sync)

1. Budget cliff: effective/physical line split, bounded overshoot recorded as `overshoot-within-physical-limit` (§ W04b/W04c)
2. Mid-turn amnesia: emergency fallbacks never shadow the most recent surface nodes
3. Fallback storms: step-aligned recency + multi-bite + recent-work anchor
4. User-message protection: unconditional selector protection + `eventAt` indexing fix + constructive belt (§ belt-invariant)
5. Admission hard line: same soft/hard split
6. Unbounded retrieval: hard per-turn allowance + substring-semantics wording + burst grant pool
7. Seed fact loss: `identifier = "quoted value"` evidence records + value-ranked eviction (§ seed-fact-records)
8. High-pressure retrieval starvation: physical-headroom retrieval floor

## Remaining variables (non-blocking, iterate on demand)

- Adaptive window-seed budget (seedMaxTokens by task length);
- The same soft/hard pressure split on the native Basic side (host layer) — A/B turn timeouts live in the host, not this plugin;
- Multi-seed/multi-task statistical validation (needs a fresh preregistered protocol);
- Request-level adaptive batching under local single-concurrency long tails.

## Environment and identity

Pinned host DSH 0.1.2-rc.1 (isolated install), route `ubuntu-lora/Qwen3.8-27B-NVFP4KV-384K` (local vLLM, OpenAI-compatible), isolated profile `ctx-v012-*`, content-addressed candidate per round (v11 = `441ba99b…`), full regression 186 unit + 64 integration green. Executor `tests/experiments/qwen-mini-arm.mjs`; fixtures reuse the frozen F1 fact/correction/blind-probe machinery (page count scaled 1152→432).
