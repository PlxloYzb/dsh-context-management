# dsh-context-management

**English** · [简体中文](https://github.com/PlxloYzb/dsh-context-management/blob/main/README.md)

Context management for DSH. Replaces native Basic compaction across presets in the target profile with context windows, reversible compression, and historical retrieval. Long journeys degrade gracefully near the pressure line, with **adaptive fidelity**: answer directly from summaries when they suffice, and let the model descend into the lossless archive on demand for exact values or verbatim text. Targets the **DSH 0.1.7 prerelease series** (local `0.1.7-rc.1`, desktop `0.1.7-rc.2`) and requires **Node.js ≥ 22.12**. Presets without native compaction, such as `minimal`, remain unchanged.

## Install

CLI profiles:

```sh
dsh plugin --profile web add dsh-context-management
```

The desktop application (DeepSeek Harness.app) manages its `desktop` profile exclusively and rejects the CLI, so install the same package from **Settings → Plugins** inside the app.

## Uninstall

```sh
dsh plugin --profile web remove dsh-context-management
```

On the desktop, remove it from **Settings → Plugins** as well.

[Design](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/DESIGN.en.md) · [Test data](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/TESTING.en.md) · [Optional background summaries and experiments](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/ITERATION-MUSE-ENGINE.en.md) · [150k iteration log](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/ITERATION-150K.en.md) · [Releases](https://github.com/PlxloYzb/dsh-context-management/releases) · [npm](https://www.npmjs.com/package/dsh-context-management) · [MIT / Attribution](NOTICE.md)
