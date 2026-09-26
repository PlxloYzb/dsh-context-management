# dsh-context-management

[English](https://github.com/PlxloYzb/dsh-context-management/blob/main/README.en.md) · **简体中文**

DSH 上下文管理插件，自动接管目标 profile 中各 preset 的原生 Basic 压缩，支持上下文换窗、可逆压缩和历史检索。长旅程在压力线附近优雅降级（换窗 → 就地回退 → 有限超出），并提供**自适应保真**：摘要足够时直答，需要精确值或逐字原文时模型自主下探无损归档。适配 **DSH 0.1.7 预发布系列**（本地 `0.1.7-rc.1`、桌面 `0.1.7-rc.2`），需要 **Node.js ≥ 22.12**。没有原生压缩的 preset（如 `minimal`）保持原样。

## 安装

CLI profile：

```sh
dsh plugin --profile web add dsh-context-management
```

桌面端应用（DeepSeek Harness.app）的 `desktop` profile 由应用独占管理，CLI 会拒绝写入；请在应用内 **设置 → 插件** 安装同一个包。

## 卸载

```sh
dsh plugin --profile web remove dsh-context-management
```

桌面端同样在 **设置 → 插件** 中卸载。

[总览：功能、优越性与历史](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/OVERVIEW.zh-CN.md) · [设计思路](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/DESIGN.zh-CN.md) · [测试数据](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/TESTING.zh-CN.md) · [可选后台摘要与实验](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/ITERATION-MUSE-ENGINE.zh-CN.md) · [150k 迭代日志](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/ITERATION-150K.zh-CN.md) · [长程实验：结论与未决清单](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/EXPERIMENT-LONGRUN-3M-STATUS.zh-CN.md) · [版本发布](https://github.com/PlxloYzb/dsh-context-management/releases) · [npm](https://www.npmjs.com/package/dsh-context-management) · [MIT / 来源声明](NOTICE.md)
