# 0.1.1：目标 profile 的原生上下文管理接管

用户确认的目标是：安装到指定 profile 后，自动接管其中所有 preset 已有的原生上下文管理，包括原生 `/compact`。不需要逐个编辑 preset。

## 已核实的 minimal 行为

本机 DSH **0.1.2-rc.1** 的 `minimal/agent.cordis.yml` 明确没有 compaction，只提供持久 shell 与 `str_replace_editor`，使用完整固定提示。`dsh-web-app/cordis.patch.yml` 同时停用了 base 层的 `compaction-basic`、`command-compact` 和 pruner，因此 minimal 在 Web 中也不会从宿主继承 Basic。

宿主 AgentLoop 根据当前 session surface 派生请求；自动压力压缩与 `CONTEXT_WINDOW_EXCEEDED` 后的压缩重试由 Basic 后端注册，而不是 loop 自带。没有恢复处理器时，超限错误结束请求；这里没有隐藏的自动滑窗。token meter 的测量与压力展示不等于压缩能力。实际 Web 验证 minimal 后端为 null、工具只有 bash/str_replace_editor、没有 compact 命令，安装、重启和卸载三个阶段均如此。未人为撑爆真实 provider 的物理窗口。

这也与[官方 Compaction 文档](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/compaction)的可选能力定义一致。按“接管已有原生上下文管理”的要求，本次保留 minimal 原行为，没有擅自新增后端。

## 接管与安装行为

- 原生 Basic 的自动 pressure、context-overflow 恢复及 `/compact` 都转入本插件后端；保留原有 pruner 服务，由新后端调用。
- 按实际 Basic provider 的 Loader entry、parent group 和 Include namespace 定位。支持改行 ID、嵌套 group/Include；新增 ARC 行避开已有 ID。
- 同 profile 的每个 preset 独立接管；同 preset 共享后端而会话状态隔离。新 preset 首次使用、空会话切换、切换后直接执行原生命令均触发接管。模型请求还会等待当前 mount 并重新组装工具。
- 不修改 preset 文件。卸载并重启恢复原始 Basic；第三方后端不会被当作原生 Basic 替换。

安装到目标 profile：

```sh
dsh plugin --profile <目标profile> add /absolute/path/dsh-context-management-0.1.1.tgz
```

DSH 的此命令完成 npm 包安装和 profile bundle 启用。单独 `npm install` 只安装依赖，无法表达应启用到哪个 profile。0.1.1 当前是本地交付，公共 npm 发布尚未执行。

## 最终包验证

包 SHA-256：`fa96ed73af548487f9b151b8b8b4a59079c035768410e6b72fb955e6c1004c68`。使用隔离 profile `ctx-v011-preset-final`；没有修改日常 profile。真实模型路由为 `opencode-go/glm-5.3-flash`。

| preset/场景 | 安装后 | 重启后 | 卸载后 |
|---|---|---|---|
| standard | ARC | ARC | Basic |
| ptc（工具由 run_code 暴露） | ARC | ARC | Basic |
| cordis | ARC | ARC | Basic |
| minimal | 无后端 | 无后端 | 无后端 |
| 改名 Basic 行和 group | ARC | ARC | Basic |
| 嵌套 group | ARC | ARC | Basic |
| minimal 空会话切换到新的自定义 preset | ARC | ARC | Basic |
| 启动后新增自定义 preset | ARC | ARC | Basic |

全部 **24 项**通过；其中六个 preset 的首请求并发执行。每个 ARC 场景也执行了原生 context status 与 compact。切换后的 status 在第6个事件完成，第15个事件才发出首次模型请求。所有测试 preset 的文件哈希保持不变。嵌套 Include、ARC ID 冲突、回滚、共享接管与监听清理由真实 Loader 回归覆盖。

- [最终 Web 矩阵](evidence/v011/live/preset-coverage-fa96ed73af54.json)
- [安装文件校验](evidence/v011/install/ctx-v011-preset-final-fa96ed73af54.json)
- [最终包失败路径：6项通过](evidence/v011/live/patch-smoke.json)
- [引擎逐文件身份与复用范围](evidence/v011/release/profile-engine-identity.json)
- [发布清单](../artifacts/release-manifest-0.1.1.json)

正常 npm pack/prepack 通过严格类型检查、184项单元测试、50项宿主集成测试及构建。此次修改限于 bridge、其声明与文档；压缩/换窗/检索/事务引擎和依赖与原27样本模型候选逐字相同，因此保留原长程模型、恢复、性能和 UI 引擎证据，未将其伪称为在新包上重新运行。新 bridge 的安装、并发 preset、首请求、命令、重启、卸载和失败回退均在最终包上重新验证。

保留了两次测试夹具错误：新建测试 profile 默认只有 base，缺少 Web bundle；以及错误要求 ptc 直接暴露 arc_status 而忽略 run_code 工具呈现。修正后重跑完整矩阵；较早的24项成功候选也保留。没有挑选模型样本替代失败结果。HMR、第三方后端替换和其他宿主版本不在本次声明范围。
