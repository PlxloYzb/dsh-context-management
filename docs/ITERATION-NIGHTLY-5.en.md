# Short-cycle overnight iteration 5 (2026-09-15, turnover orchestration and serial-model experiment design)

[简体中文](ITERATION-NIGHTLY-5.zh-CN.md) · [Previous cycle (candidate 10)](ITERATION-NIGHTLY-4.en.md)

## The answer first

Measured answers to the three questions:

1. **Orchestration.** The turnover itself has no model in it: it is a **model-free deterministic replacement**. So there is no "switch on one leg, parallel summary on the other" — there is only one leg. Retained evidence shows every one of 94 window turnovers was `trigger=pressure, seed=extractive`, and across every retained run the model has **never once called `new_context({handoff})`** (it called `compress` 26 times). The model-written handoff path is simply unused.
2. **Speed.** The full replacement chain (`frozenPrefix` + user-history index + exact-record index + shared transaction + durable flush) measures a **36 ms / 184 ms / 1479 ms** median at 200 / 2,000 / 20,000 messages. Index assembly alone is about 10 ms (16.4 + 3.1 + 3.0 ms at 20k); the large-log remainder is the transaction and log flush. Against native Basic's **68–186 s** per separate summary LLM call, that is two to three orders of magnitude faster.
3. **Carried context.** The new window is a 4,096-byte extractive index (the last 24 user-history excerpts plus exact structured records from tool results) and **all recent steps are kept**, because `frozenPrefix` protects the latest user input and recent tool pairs from the replaced prefix. Four turnovers still answered verbatim correctly, so the combination of index + retained recent steps + reversible retrieval holds up.

## The optimisation I tried, and how it was falsified

Following the "ask the model for a handoff before the window is replaced" idea, I added this line to the normal nudge:

> Turnover prep: this window is replaced automatically at the emergency line. Before then, call `new_context({handoff})` once with goals, constraints, verified facts and next actions — the handoff is merged into the replacement seed. Without it the seed is extractive and thinner.

**Experiment (same binary, prompt-override A/B)**: F3 / 91503 / 24 pages / 32k pressure, full real reading journeys.

| Arm | Nudge carries the prep line | `new_context` calls | Model-assisted turnovers | Extractive turnovers | Reading | Total | Quality |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Control | no | 0 | 0 | 4 | 116 s | 560 s | 24/24, 6/6, verbatim 3/3 ✅ |
| Treatment | yes | 0 | 0 | 4 | 230 s | 496 s | 24/24, 6/6, verbatim 3/3 ✅ |

The treatment nudge event verifiably **did contain** the request (`ARC 82% ... Turnover prep: ...`) and the model still never called `new_context`; both arms stayed 4/4 extractive with full quality. **The line had no measurable benefit and was reverted; it is not shipped.** The control/treatment timing difference is model noise and is not attributable to the line.

The design conclusion this falsification forces: **on a local serial model you cannot make turnover quality depend on the model volunteering a handoff at the last moment.** The nudge fires at 82% against a 90% emergency line, at most once per turn, so the window for preparation is inherently tiny.

## Cost of the three options

| Option | Turnover critical path | Seed quality | Measured evidence |
| --- | --- | --- | --- |
| Deterministic extraction (current) | 36–184 ms (200–2k messages) | 4,096-byte index, 78% flagged `incomplete` | latency benchmark; seed text of six turnovers |
| Model writes a handoff in-band | 0 extra calls | depends on model compliance | **0/4 adoption**, 0 `new_context` calls anywhere |
| Separate model summary at turnover | +68–186 s each | richer but irreversible | matched native arm: 87% / 91% of model time, both journeys unfinished |

On a serial model a "parallel summary" does not physically exist: it either spends the same turn's output (in-band) or lands on the critical path (separate call). The data says **keeping the deterministic fast switch is the only option current evidence supports**.

## How to validate this on a serial model (protocol)

Concurrency cannot be measured, so the experiment must measure the **critical path** rather than overlap:

1. **Arms**: (a) deterministic seed only; (b) seed plus one separate summary call at turnover; (c) seed plus a handoff request issued at the **first** nudge (not at the last moment), retried across turns.
2. **Hold fixed**: same fixture, pressure, boundary and probes; one experiment at a time; on a serial model, seconds and tokens are the cost metric directly.
3. **Adoption**: count `new_context` calls and the `model-assisted` turnover share (`tests/live/local-audit-turnover.mjs`).
4. **Continuity probe**: after a turnover ask for a fact established before it, twice — once answerable from the seed, once only from an original — score both and record retrieval counts.
5. **Cost**: reading seconds, model seconds and tokens per turnover.
6. **Criterion**: report "continuity gained per added critical-path second", never a concurrency metric.

## Delivery and limitations

This cycle makes **no product change**: the falsified line was reverted and the rebuilt artifact is byte-identical to candidate 10 (entry `8840d4c7…`, tarball `359f7432…`). Everything added is test tooling: `tests/live/local-audit-turnover.mjs` (orchestration audit) and `tests/live/local-bench-turnover-latency.mjs` (turnover latency benchmark); records live in `.test-runtime/nightly-20260915/turnover-orchestration-design.json`, `turnover-orchestration-audit.json` and `turnover-latency.json`.

Limitations: the 20k-message latency point is a synthetic upper bound and includes the log flush (a host durability cost, not the plugin's index cost); the phase split does not isolate that flush; the A/B is a single sample per arm and both scored full quality, so it cannot discriminate quality; only the local Qwen3.8-27B was tested.

## Reproduction commands

```bash
# Turnover orchestration audit: trigger, seed mode, whether a handoff was prepared
node --import tsx tests/live/local-audit-turnover.mjs

# Turnover latency: end-to-end cost of the deterministic replacement
node --import tsx tests/live/local-bench-turnover-latency.mjs

# Serial-model turnover-prep A/B (same binary, prompt override)
npm run test:live:local -- --name=<unique> --arm=C400_WINDOWED --family=F3 \
  --seed=91503 --pages=24 --pressure=32000 --batch=6 --concise=true
```
