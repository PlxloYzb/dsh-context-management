# Reliability: Basic Replacement and Harness Cooperation

[中文](RELIABILITY-HARNESS.zh-CN.md) · 2026-09-15 · DSH 0.1.2-rc.1

## Conclusion and implications

For the hosts and presets covered in this round, the plugin takes over **Basic's original service location**. The original Basic fiber is disposed, its four automatic listener types are withdrawn, and ARC uses the service symbol in the same isolated realm. Native `/compact` consumers resolve the same ARC object, while the native tool-result pruner remains available; neither these consumers nor preset files need modification.

Therefore, “pulling out Basic” is already true at runtime. The Basic package remains in the host dependency directory for profiles without the plugin, other presets, and uninstall recovery. Replacing the service does not require deleting that host dependency.

This round identified and fixed lifecycle gaps beyond the first successful takeover; it does not prove reliability in every environment.

## Parallel work and convergence points

Three independent tracks ran first in parallel: the real component replacement contract, the Harness lifecycle/interface audit, and CLI install/uninstall in a private profile. The main track concurrently established post-install Web verification. The first convergence point retained failures and fixed them; the second bound full dist file hashes to the final installed package and retested every track. Model experiments began with two short arms in parallel; after reviewing their results, the third arm sharing the plugin profile ran.

| Verification track | What was actually verified | Evidence level |
| --- | --- | --- |
| Replacement contract | Released Basic, Cordis, Loader, Include, AgentRegistry, AgentPresets; same-symbol replacement, listener disposal, nested Includes, renamed/occupied IDs, switching/start-stop/reload, and preservation of external patches | Automated regressions; component-byte comparison with the pinned host |
| Harness | Safe boundaries, maintenance exclusion, tool pairing, cancellation/disposal, steer/queue, budgets, overflow/pruner, JSONL restart and fork with real AgentLoop/CommandRuntime | Existing integration regressions; overlapping subsets are not counted twice |
| Package lifecycle | Install ARC → uninstall and restart Basic → reinstall ARC; the bundle is enabled only in the target profile; hashes for other profiles and presets remain unchanged | Actual pinned DSH CLI + Web; global `llm/stream` is 0 |
| Native Web entry points | A single ARC in standard/ptc/cordis, zero active Basic, zero root-level service leakage; no compaction in minimal; native `/compact` writes a real summary; immediately usable after empty-session switching; process restart | 8 state checks + 5 real Muse minimal session requests |
| Three-arm model gate | Basic, ARC in-place, ARC windowed/background summary; actual pressure, tool calls, fact/correction/verbatim probes, restart, and original-text archive audit | Real Web/model samples using the same short fixture; not a statistical winner/loser comparison |

## Failure-driven fixes

1. **Late enablement missed existing Agents**: when enabled, enumerate existing sessions through the host AgentRegistry and reuse the same attachment path. Repeated start/stop for the same Agent does not accumulate listeners.
2. **Caching the first outcome as a permanent conclusion**: deduplicate only in-progress operations; later boundaries verify the current actual backend. It can take over again when Basic was absent initially and loaded later, or when it was taken over and then externally reloaded back to Basic.
3. **Preserving the error-handling boundary**: a confirmed recovered Basic object continues serving, avoiding a failed switch retry on every request; when rollback to the same backend cannot be confirmed, `CONTEXT_BACKEND_UNAVAILABLE` continues to be returned rather than incorrectly allowing the second request through.
4. **Rollback read stale configuration**: a host Include update at the same path changes only the actual tree config, while `fiber.config` may remain old; a registry tree after a cross-path restart may also be old. The first takeover reads the actual provider's Include; afterwards, the bridge-owned Loader update observer records committed configuration after `next()` succeeds. Rollback removes its own patches and preserves external configuration. Verification includes no current backend, failed external update, and a same-path update after a cross-path transition.
5. **Static YAML audit false positives**: recognize trailing comments and common boolean inline isolate mappings, avoiding a claim that valid actual mounts are incompatible. The tool remains a text heuristic; complex YAML, aliases, and cross-file relationships are decided by runtime tree auditing.

## What the Harness still owns

Native CommandRuntime owns `/compact` invocation, cancellation, and command receipts; ARC implements the existing `compactNow` service interface and uses host maintenance exclusion and shared transaction writes. AgentLoop owns pre-step and request-error boundaries; ARC handles pressure and turnover at those boundaries. TokenMeter, Session projection/persistence, and the native pruner remain host-provided. Historical retrieval and deferred-summary delivery are provided by ARC and follow the same lifecycle.

Web smoke checks observed that standard/cordis provide the five context tools normally, ptc retains the host presentation of the `run_code` tool, and minimal does not expose context tools. The PTC tool-catalog check is not counted as full PTC programming-execution verification.

## Final candidate results

Full prepack passed: **188 unit + 133 integration + 15 reliability + 22 experiment-tool checks = 358 tests**, plus type checking and the 42-file release audit. All three real model arms completed and passed restart, actual exposure of all 24 pages, and archive-byte verification. Quality outcomes remain separate:

| Arm | Compactions | Facts / corrections | Final deliverable | Verbatim probe | Requests / reported tokens | Elapsed |
| --- | ---: | --- | --- | --- | --- | ---: |
| Basic, matched trigger/retention | 4 | 24/24, 6/6 | Pass | **1/3** | 22 / 520,911 | 101 s |
| ARC in-place | 3 | 24/24, 6/6 | **Fail: empty eventOrder** | 3/3 | 14 / 378,348 | 71 s |
| ARC windowed + deferred summary | 4 | 24/24, 6/6 | Pass | 3/3 | 28 / 727,390 | 76 s |

Offline diagnosis of the in-place failure: PAGE-2 exposed the complete event order and archive bytes remain recoverable. The facts-probe turn made no tool calls and returned an empty array; retrieval was used only in the later verbatim turn. This is a valid model-output failure, not grounds to change the score. The record does not establish archive loss or model memory loss.

Window boundaries took **24–31 ms**, with **two actual summary appends**: one summary became ready after crossing a window, and one before its window. Neither append changed generation. **One restart interruption** produced an explicit unavailable notification. Within the session, foreground calls stayed serial, with at most one summary and two total streams; accumulated host-stream overlap was 28.112 seconds.

This natural task did not call `await_context`. Another background operation had no observed pending-window receipt, leaving the audit classification at `partially-covered-with-natural-uncovered-work`; it was not counted as delivered. Passing receipt-structure checks does not mean every prefetch was consumed. Reported tokens are not a complete bill; an interrupted stream may omit usage.

Final package SHA-256: `cfab61d84d5fedd8a0eaa4627cf054778a77fc7152436eb251467b3abc7f1127`. Sorted manifest hash of all 34 dist files: `799151fdada17114c8c818431cddee7705bc882c4d044719d07439db6023e96b`. Web, both plugin model arms, and the installed package have identical complete dist contents. Native records the same candidate identifier for pairing but does not load the plugin. The experimental profile has this build installed; nothing was published to npm.

## Reproduction and evidence

Use pinned `.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh`. All models are `opencode-go-muse/muse-spark-1.3-contributor` with `minimal` reasoning. Do not use a newer global dsh. The model runner uses a private settings copy; daily web/headless default configuration was not changed.

```sh
npm run test:reliability
node tests/reliability/package-lifecycle.mjs unique-lifecycle-name
node tests/reliability/web-contract.mjs unique-web-name
# Use unique names for each arm; run the following two in parallel first, then inspect the results.
node tests/live/local-short.mjs --name=unique-window --route=muse --arm=C400_WINDOWED --family=F3 --seed=91543 --pages=24 --pressure=32000 --batch=6 --concise=true --restart=true --background=true --prepare=0.6 --cost-control=observe --port=3312
node tests/live/local-short.mjs --name=unique-native --route=muse --arm=A_NATIVE --family=F3 --seed=91543 --pages=24 --pressure=32000 --batch=6 --concise=true --restart=true --matched-native=true --cost-control=observe --port=3311
node tests/live/local-short.mjs --name=unique-inplace --route=muse --arm=B_IN_PLACE --family=F3 --seed=91543 --pages=24 --pressure=32000 --batch=6 --concise=true --restart=true --cost-control=observe --port=3313
```

The lifecycle script creates an isolated DSH_HOME; Web/model runs use retained experimental profiles and require a build whose complete dist matches the currently installed build. Run names cannot be reused and failed output is retained. Raw records are under `.test-runtime/reliability-20260915/` and `.test-runtime/nightly-20260915/reliability-*-91543/`; the public summary is [JSON](data/reliability-harness-2026-09-15.json).

Retained test/environment failures include: the Web observer initially omitted ARC rows, then was retested after its filter was corrected; reinstalling a same-path, same-version tarball was considered unnecessary by the package manager, so complete-dist verification stopped it before any model request, and it was reinstalled with a content-hashed artifact filename. The Corepack automatic `packageManager` write caused by the initial CLI probe was reverted; the runner disables automatic writes and uses a private working directory. These failures were not overwritten as passes.

## Limitations

Only DSH 0.1.2-rc.1 and short synthetic Muse minimal sessions were verified; long-running pressure workloads, all third-party plugins, and other host versions were not covered. The third-party row in the package-lifecycle test is an alias fixture that re-exports Basic; it proves that the official package-name guard does not take over that row, and cannot represent all vendor implementations. Hot start/stop regressions run at safe idle/request boundaries and do not claim coverage for package uninstall in the middle of arbitrary model streams or tool execution. Each model arm has one sample; concurrent service contention can affect elapsed time, so no general quality or latency advantage can be inferred. A summary not being ready at the instant of turnover is not a failure; delivery is determined by the actual subsequent boundary and durable receipt.
