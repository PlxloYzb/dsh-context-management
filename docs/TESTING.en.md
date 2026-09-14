# Test data and reproduction

[简体中文](TESTING.zh-CN.md) · [Home](../README.en.md) · [Results JSON](data/results-0.1.1.json) · [27 model samples CSV](data/model-samples-0.1.1.csv)

The 400k experiment closed on 2026-09-12; see the [close-out report](EXPERIMENT-REPORT.en.md), subsequent [150k iteration](ITERATION-150K.en.md), [overnight iteration](ITERATION-NIGHTLY.en.md), [second](ITERATION-NIGHTLY-2.en.md) and [third](ITERATION-NIGHTLY-3.en.md) overnight iterations. Data and model commands below remain historical 0.1.1 release evidence, not reruns of the latest candidate.

Measured on **2026-09-08**, with plugin **0.1.1** and **DSH 0.1.2-rc.1**. Current release checks are distinguished from historical model, preset, and scale measurements below.

## Automated and host checks

| Check | Result | Scope |
| --- | --- | --- |
| Unit regression | 184/184 | Budgets, transactions, tool pairing, archives, windows, cancellation |
| Real host integration | 50/50 | Installed DSH modules and agent loop, including controlled failure injection |
| Typecheck and build | Passed | Strict TypeScript, ESM, declarations |
| Package-name install/remove | Passed | Both exact README commands in isolated `DSH_HOME`; native Web commands and uninstall restoration |
| Preset lifecycle | 24/24 | Eight presets × first request, restart, uninstall; historical candidate |

The package-name test serves the candidate from a loopback registry and obtains other dependencies from public npm. It uses no model credentials. This tests the complete package-name flow, not public npm availability. The public npm 0.1.1 tarball was separately downloaded and matched byte-for-byte against the previously tested archive. Archive SHA-256 values and current checks are recorded in [release checks JSON](data/release-checks-0.1.1.json).

Preset coverage includes `standard`, `ptc`, `cordis`, `minimal`, and four custom cases: renamed, nested, switched before first request, and added after startup. The seven presets containing Basic use the plugin while installed and return to Basic after removal. `minimal` has no compaction backend throughout.

## Model comparison

Verified route: **opencode-go / glm-5.3-flash**. Three fixed seeds (`1701`, `2903`, `4307`), each run three times per arm: nine runs per arm, 27 total. Each task contains 12 exact facts, eight synthetic telemetry pages, and two later corrections. Recall permits conversation history and archive tools, but prohibits rereading workspace files. This measures task-level recall with retrieval, not unaided model memory.

| Strategy | Completed runs | Exact recall before restart | Exact recall after restart | Both corrections after restart | Complete source recovery |
| --- | --- | --- | --- | --- | --- |
| A: host Basic | 9/9 | 108/108 | 108/108 | 9/9 | 9/9 |
| B: plugin in-place | 9/9 | 108/108 | **98/108** | **4/9** | 9/9 |
| C: plugin windowed (default) | 9/9 | 108/108 | 108/108 | 9/9 | 9/9 |

Every C run produced at least three actual window replacements. B completed the journey but did not pass every quality metric: recoverable sources do not guarantee correct model answers. Earlier candidate failures remain in Git history and are outside this explicitly selected 27-sample cohort. The JSON includes individual configurations, scores, timestamps, corpus hashes, and source-report provenance.

B/C configure a 32,768-token logical window, 8,192-token output reserve, and 4,096-token safety margin. A uses the host threshold mechanism (test ratio 0.018432, retention 4,096), so budgets are not equivalent. Usage totals and missing-field counts are available in JSON; **no lower-cost or speed claim is made**. These 27 fixed synthetic samples establish neither general accuracy nor statistical significance or performance on other models.

## Historical scale measurement

Apple M4 Pro, 14 logical CPUs, 24 GiB RAM; macOS Darwin 25.4.0; Node.js 22.23.1; 512 MiB heap limit. One run, seed `7331`.

| Metric | Measurement |
| --- | --- |
| Events / archives / windows | 100,001 / 1,100 / 100 |
| Cold load | 440.12 ms |
| Search p95 / maximum | 17.10 / 22.67 ms |
| RSS / used heap | 289.61 / 114.90 MiB |
| Pre-aborted call | 0.146 ms |

Cancellation measures an already-aborted signal, not interruption during a long synchronous scan. These are single-machine synthetic measurements, not production throughput guarantees.

## Provenance and limits

The model candidate tarball SHA-256 begins `cf655cc8`; the preset-matrix candidate begins `fa96ed73`. Changes between them were limited to the bridge and documentation-related files. Historical byte comparisons confirmed identical engine files and dependencies; the bridge was separately tested across 24 lifecycle cases. Subsequent cleanup changed source comments, test scripts, and documentation. GitHub preparation changes no runtime logic and does not rerun the 27 model calls. JSON records full hashes and source-report commits, paths, and SHA-256 values.

Real provider physical context overflow was **NOT EXERCISED**. Controlled loop overflow coverage is not a substitute. Other host versions, models, HMR, and unlimited nesting are outside these measurements. Historical checks also record that invalid static configuration prevents host startup, and pre-step failure does not guarantee automatic requeue of input already claimed but not yet logged by the host.

## Reproduce

Checks without model calls:

```sh
npm ci
npm run check
npm run test:release
npm run test:install
npm run test:performance
```

`test:install` requires installed DSH 0.1.2-rc.1, network access, and its package manager. It creates and cleans up an isolated profile. Raw outputs go to Git-ignored `.test-runtime/`.

The complete cohort requires a test DSH environment with the named model route and credentials, and incurs model usage charges. The script creates uniquely named profiles without changing daily profile defaults. Use a test-only `DSH_HOME`; do not upload authentication configuration or raw Web logs:

```sh
node tests/live/gates.mjs rerun-001
```

See [fixture.mjs](../tests/live/fixture.mjs) for corpus/scoring and [run.mjs](../tests/live/run.mjs) for the model journey. New reports describe a new experiment and may differ from the historical results here.
