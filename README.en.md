# dsh-context-management

**English** · [简体中文](https://github.com/PlxloYzb/dsh-context-management/blob/main/README.md)

Context management for DSH. Replaces native Basic compaction across presets in the target profile with context windows, reversible compression, and historical retrieval. Targets **DSH 0.1.2-rc.1** and requires **Node.js ≥ 22.12**. Presets without native compaction, such as `minimal`, remain unchanged.

## Install

```sh
dsh plugin --profile web add dsh-context-management
```

## Uninstall

```sh
dsh plugin --profile web remove dsh-context-management
```

[Design](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/DESIGN.en.md) · [Test data](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/TESTING.en.md) · [Releases](https://github.com/PlxloYzb/dsh-context-management/releases) · [npm](https://www.npmjs.com/package/dsh-context-management) · [MIT / Attribution](NOTICE.md)
