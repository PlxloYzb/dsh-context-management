# 来源与证据索引

核验日期：2026-09-07。网页是当日可访问版本；本地源码以文件hash为准，不把网页最新分支和安装的rc.1自动当成同一commit。

## 1. 基线

| 对象 | 位置/版本 | 证据边界 |
|---|---|---|
| 新项目 | /Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-context-management | 审阅开始只有docs，没有.git/package.json/src |
| ARC | /Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-arc-context | package 0.2.0-beta.15；HEAD 82fc3004d10c445f82aa97a93ad2a88a3a8794cd；status仅未跟踪.codegraph |
| Codex | /Users/bruceplxl/Workspace/dsh-plugin-dev/codex-main | 没有可用git元数据；不虚构commit，按所查文件SHA-256固定 |
| DSH | /Users/bruceplxl/.local/lib/node_modules/@deepseek-ai/dsh | CLI输出0.1.2-rc.1；实际依赖版本和文件hash见manifest |
| 模型 | opencode-go / glm-5.3-flash | 两个真实Web会话request日志确认；仅该次路由声明contextWindow=1000000 |

完整核验清单：[source-manifest.json](evidence/source-manifest.json)。manifest中的绝对路径是本机定位证据，不应写进插件生产import。

## 2. 官方文档

| 来源 | 本次使用的事实 |
|---|---|
| [第一个插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) | apply/inject、绝对路径开发overlay、Web启动 |
| [打包与安装](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish) | dsh.bundle、profile分层、config整值替换、预构建tarball |
| [生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/) | effect归属、异步清理不能只依赖逆序调用 |
| [服务与依赖](https://deepseek-harness.github.io/deepseek-harness/develop/framework/service) | Service、inject、服务隔离 |
| [架构](https://deepseek-harness.github.io/deepseek-harness/reference/) | 日志为模型输入来源，profile与运行层分工 |
| [Compaction](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/compaction) | 已存在正式seam文档；三接口与持久协议 |
| [Token meter](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/token-meter) | tokens与heuristicTokens职责不同 |
| [Agent生命周期](https://deepseek-harness.github.io/deepseek-harness/reference/agent-lifecycle) | pre-step、请求、工具结果、step/turn边界 |

文档说明与本机行为不一致时，先记录差异，首发以指定宿主实测为门；不能只靠“接口仍存在”推导语义完全兼容。

## 3. Codex 源码地图

先使用codegraph_explore按项目查询，再对未返回的精确路径定点核验。代码图的调用关系用于导航，不当作覆盖率或运行成功证明。

| 来源 | 具体观察 | 采用方式 |
|---|---|---|
| [features/src/lib.rs](/Users/bruceplxl/Workspace/dsh-plugin-dev/codex-main/codex-rs/features/src/lib.rs:1601) | context_management为UnderDevelopment、default false | 标明实验边界 |
| [session/token_budget.rs](/Users/bruceplxl/Workspace/dsh-plugin-dev/codex-main/codex-rs/core/src/session/token_budget.rs:21) | apply_experimental_context有模型/路由/认证条件 | 不假设直接可移植 |
| [new_context_window.rs](/Users/bruceplxl/Workspace/dsh-plugin-dev/codex-main/codex-rs/core/src/tools/handlers/new_context_window.rs:17) | handler只调用request_new_context_window | 请求/执行分离 |
| [session/turn.rs](/Users/bruceplxl/Workspace/dsh-plugin-dev/codex-main/codex-rs/core/src/session/turn.rs:510) | post-sampling判断rollover，run_auto_compact派发 | 主循环安全边界 |
| [compact_token_budget.rs](/Users/bruceplxl/Workspace/dsh-plugin-dev/codex-main/codex-rs/core/src/compact_token_budget.rs:71) | hooks与compaction生命周期包住新窗口 | 统一生命周期，非额外摘要模型 |
| [auto_compact_window.rs](/Users/bruceplxl/Workspace/dsh-plugin-dev/codex-main/codex-rs/core/src/state/auto_compact_window.rs:34) | 窗口ID、generation、prefill和once flags | 可重建窗口状态、去重 |
| [session/context_window.rs](/Users/bruceplxl/Workspace/dsh-plugin-dev/codex-main/codex-rs/core/src/session/context_window.rs:57) | scoped增长预算与full-window cap并列 | 两层预算，不能类比为重复shadow扣减 |
| [context_window_guidance.rs](/Users/bruceplxl/Workspace/dsh-plugin-dev/codex-main/codex-rs/core/src/context/world_state/context_window_guidance.rs:28) | section snapshot/diff与撤销/替换提示 | 当前状态有明确版本与替换语义 |

history-notes目录、ContextManager、RetainedContext本次只作外围定位与概念核对，不宣称完成全仓审计，也不据局部缓存判断Codex整体历史保留能力。

## 4. ARC 源码地图与复用结论

| 来源 | 观察 | 复用决定 |
|---|---|---|
| [region.ts](/Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-arc-context/src/region.ts:463) | manual事务：selection重校验、marker、flush与错误 | 保留方法，补部分提交/恢复 |
| [region.ts ledger](/Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-arc-context/src/region.ts:575) | rebuild按summary建ledger，缺checkpoint仍可有项 | 新reader关联真实replacement |
| [region.ts pressure](/Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-arc-context/src/region.ts:628) | 从projectedTokens减所有账本shadow | 此宿主线不得复用 |
| [state.ts](/Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-arc-context/src/state.ts:25) | 无kernelBlockId会合成bN | window与ARC block分开 |
| [tools.ts decompress](/Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-arc-context/src/tools.ts:514) | ID前缀find、来源文本加包装 | 加歧义校验、分页、预算与保真定义 |
| [tools.ts search](/Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-arc-context/src/tools.ts:545) | 搜direct shadowedSeqs，全文字符串拼接计分 | 统一effective sources与增量索引 |
| [fallback.ts](/Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-arc-context/src/fallback.ts:325) | host meter按node.tokens取shadow价 | 改为新宿主heuristicTokens |
| [bridge.ts](/Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-arc-context/src/bridge.ts:263) | 内置注册、tracked mounts、两阶段patch、异步created处理 | 复用架构，补readiness与dispose同步 |
| [index.ts](/Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-arc-context/src/index.ts:635) | compactNow使用runMaintenance与sessions.flush | 保留官方消费兼容 |
| [driver.mjs](/Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-arc-context/research/bench/driver.mjs:9) | 旧点号RPC、无新认证与args | 需重写协议，不直接拷贝运行 |

ARC的AGENTS包含许多历史经验，适合作为测试来源；其固定rc.8依赖、版本、旧产品发布纪律不自动约束新项目。

## 5. DSH 安装包源码与实验证据

安装依赖根目录：`/Users/bruceplxl/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`。

| 文件 | 支持的结论 |
|---|---|
| [dsh-compaction公开类型](/Users/bruceplxl/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction/lib/types/index.d.ts) | seam、ManualCompactionError、surface位置范围 |
| [dsh-token-meter](/Users/bruceplxl/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js:364) | contextPressure v4、shadow相邻协议 |
| [token节点类型](/Users/bruceplxl/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/types/types.d.ts) | nodes.tokens/heuristicTokens两种价格 |
| [agent-loop](/Users/bruceplxl/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:498) | pre-step先于deriveMessages；request日志在header.config |
| [standard preset](/Users/bruceplxl/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml) | official compaction isolate、Basic、command与pruner布局 |
| [Basic provider](/Users/bruceplxl/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:782) | 自动hooks与pruner调用属于后端行为 |
| [Remote描述符](/Users/bruceplxl/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.remote-client.js) | create/selectModel/prompt/list/page的真实参数与结果 |
| [gateway](/Users/bruceplxl/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js:930) | endpoint为namespace/method、payload只有args |
| [client connection](/Users/bruceplxl/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js:356) | 根启动token换Cookie，API认证 |

可以复算的本次结果：[新鲜Web会话](evidence/web-smoke-fresh.json)、[首个成功会话核验](evidence/web-smoke.json)、[旧协议失败](evidence/web-smoke-legacy-transport-failure.json)、[投影探针](evidence/projection-probe.json)。这些文件均不能作为尚不存在的新插件的验收结果。
