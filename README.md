# dsh-context-management

[English](https://github.com/PlxloYzb/dsh-context-management/blob/main/README.en.md) · **简体中文**

DSH 上下文管理插件，自动接管目标 profile 中各 preset 的原生 Basic 压缩，支持上下文换窗、可逆压缩和历史检索。适配 **DSH 0.1.2-rc.1**，需要 **Node.js ≥ 22.12**。没有原生压缩的 preset（如 `minimal`）保持原样。

## 安装

```sh
dsh plugin --profile web add dsh-context-management
```

## 卸载

```sh
dsh plugin --profile web remove dsh-context-management
```

[设计思路](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/DESIGN.zh-CN.md) · [测试数据](https://github.com/PlxloYzb/dsh-context-management/blob/main/docs/TESTING.zh-CN.md) · [版本发布](https://github.com/PlxloYzb/dsh-context-management/releases) · [npm](https://www.npmjs.com/package/dsh-context-management) · [MIT / 来源声明](NOTICE.md)
