# Muse two-route turnover protocol (2026-09-15)

[中文](TURNOVER-MUSE-PROTOCOL.zh-CN.md)

The product has deterministic turnover and voluntary main-model handoffs, but no background summarizer. This experiment tests local Qwen foreground work with an independent Muse summarizer. The scheduler remains test-only under `tests/live/turnover/`.

Use pinned DSH 0.1.2-rc.1, the existing isolated native/plugin profiles, synthetic data, and the installed candidate. Record source/build/settings hashes. Raw output stays under ignored `.test-runtime/`; daily profiles and preset files remain unchanged.

## Prespecified experiment

1. Verify both routes through real rc.1 Web sessions. Run three paired foreground/summary requests. Calculate overlap from actual `llm/stream` start, first-content and terminal timestamps. Client concurrency alone does not prove server inference concurrency.
2. Compare A deterministic seed, B Muse started and awaited at the boundary, C Muse started early and consumed only if ready. C falls back immediately and cancels unfinished work. Use three fixture seeds in ABC/BCA/CAB order; keep the local model serial.
3. Inject identical synthetic paired tool history through host events. This isolates the boundary mechanism; it is not autonomous long-task ingestion. Foreground work and continuity probes use the real model. Force the same safe pre-step boundary through the installed engine's shared transaction; do not count controller injection as voluntary model adoption.
4. Eighteen pages (initial estimate ~90 KB; actual source including separators: 79,252 bytes) contain an extractable structured fact, five narrative decisions, and a verbatim marker explicitly excluded from the summary. Test visible-context-only continuity, then historical retrieval. Current user corrections must override old summaries. The second probe inherits the first; they are not independent samples.
5. Bind summaries to session, generation, source-prefix hash/cursor and main route. Cap summaries at 1400 characters, generation at 2048 tokens, timeout at 60 seconds. Measure seed retention, boundary wait, transaction time, tool calls and reported usage. Missing usage stays missing.
6. Test late/error/oversized/stale/cancel/dispose behavior in the state machine, plus feasible real-host fallback cases. Late results must never append to a committed window.

## Decision rules

Muse must work in rc.1; at least one pair must finish with overlapping real stream intervals. That is not proof of GPU concurrency. C must never await summary completion at turnover. Check current input, tool pairing, append-only durability and archive recovery. Preserve every failure.

Compare seed-answerable facts, final accuracy and retrieval cost against A, including regressions. Recommend further product work only if benefit is visible at bounded critical-path cost. Three samples are a pilot, not statistical significance, provider concurrency capacity or 400k long-run evidence. No npm publication or default/preset changes.

## Calibration amendment before the matched cohort

The first A calibration failed: Qwen's default low reasoning exhausted the 2048-token output cap on the tool-free diagnostic, without an answer. Freeze `reasoningEffort=off` for all formal arms; retain the same output cap and exclude that calibration from paired results.

rc.1 `session/selectModel` also saves the global default. Profile isolation alone is insufficient. Formal runs point the settings provider at a private per-run copy and disable automatic title generation to keep local requests serial. Record and restore the initial preflight's default-setting side effect rather than claiming it never happened.

A second A calibration completed but attempted five denied historical tool calls. Hide retrieval schemas in the formal diagnostic. The empty tool array was rejected by local vLLM (HTTP 400; retained separately). Keep only the status schema and deny its execution, supplying no extra facts. Separate all three calibration attempts; the matched cohort begins with `paired-a-91511`.

Add an autonomous-reading gate with Muse as the main model: native Basic at matched thresholds, in-place compaction, and windowed turnover, using F3/91503/24 pages/32000 pressure/batches of 6/concise phase replies. These exercise existing product paths and are distinct from the experimental scheduler's A/B/C arms.
