# dsh-context-management

**English** · [简体中文](https://github.com/PlxloYzb/dsh-context-management/blob/main/README.md)

Context management for DSH. Replaces native Basic compaction across presets in the target profile with context windows, reversible compression, and historical retrieval. Long journeys degrade gracefully near the pressure line, with **adaptive fidelity**: answer directly from summaries when they suffice, and let the model descend into the lossless archive on demand for exact values or verbatim text. Targets the **DSH 0.1.7 prerelease series** (local `0.1.7-rc.1`, desktop `0.1.7-rc.2`) and requires **Node.js ≥ 22.12**. Presets without native compaction, such as `minimal`, remain unchanged.

## Install

CLI profiles:

```sh
dsh plugin --profile web add dsh-context-management
```

The desktop application (DeepSeek Harness.app) manages its `desktop` profile exclusively and rejects the CLI, so install the same package from **Settings → Plugins** inside the app.

> **Just published and it will not install?** pnpm 11 ships a supply-chain "minimum release age" gate (the app logs it as *supply-chain policies*): a bare package name resolves `latest` but **skips a version published too recently** and falls back to an older one, so you can end up with a long-outdated version that the host then rejects on peer mismatch. **Pin the version explicitly** — an exact version is not subject to the gate:
>
> ```sh
> dsh plugin --profile web add dsh-context-management@0.9.12
> ```
>
> In the desktop app, put `dsh-context-management@0.9.12` in the package-name field. Or wait until the release is older than the gate, after which the bare name resolves correctly.

## Uninstall

```sh
dsh plugin --profile web remove dsh-context-management
```

On the desktop, remove it from **Settings → Plugins** as well.

[Overview: features, advantages, history](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/OVERVIEW.en.md) · [Design](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/DESIGN.en.md) · [Test data](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/TESTING.en.md) · [Optional background summaries and experiments](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/ITERATION-MUSE-ENGINE.en.md) · [150k iteration log](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/ITERATION-150K.en.md) · [Long-run experiment: conclusions and open items](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/EXPERIMENT-LONGRUN-3M-STATUS.en.md) · [Releases](https://github.com/PlxloYzb/dsh-context-management/releases) · [npm](https://www.npmjs.com/package/dsh-context-management) · [MIT / Attribution](NOTICE.md)
