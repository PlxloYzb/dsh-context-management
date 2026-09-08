# dsh-context-management v0.1.0 产品规格

状态：**0.1.0 代码与本地发行包已完成，G1–G7 验收通过；已于 2026-09-07 公开发布到 npm**。制定日期：2026-09-07。已验证事实见 [REVIEW.md](REVIEW.md) 和 [VALIDATION.md](VALIDATION.md)，实施顺序见 [PLAN.md](PLAN.md)。旧草案保存在 archive，不再约束本项目。

## 1. 产品目标

交付新的 DSH 插件包 **`dsh-context-management`，首个可用正式版本 `0.1.0`**。在 standard agent preset 的 compaction 隔离域中替换原生 Basic 后端，实现模型主动整理、宿主可靠换窗、历史可追溯、有界检索与恢复、重启后继续工作。

ARC 是可复用的压缩与检索内核，Codex 是设计与工程实践来源。本项目有独立版本和交付标准，不继承旧 ARC 的发布计划，也不把其旧实验数据作为新产品效果。

首发支持矩阵：DSH `0.1.2-rc.1`、本地 Web、standard preset、`opencode-go/glm-5.3-flash`。这个宿主版本含 rc 后缀，是用户指定并已核实的基线，不等于上游已经宣布稳定。其他宿主、模型、preset 与子代理模式需另有证据才声明支持。旧 ARC 账本读取是兼容目标；不承诺旧 ARC 能理解新换窗元数据。

| ID | 必须交付的能力 | 验收门 |
|---|---|---|
| R01 | 预构建 tarball、安装、同域接管、卸载、重启回到 Basic | G1/G6 |
| R02 | `compactIfNeeded`、`compactNow`、`compactRegion` 完整 seam | G2 |
| R03 | 模型摘要压缩、stale seq 恢复、tier 来源追踪 | G2/G3 |
| R04 | `new_context` 请求与安全边界换窗，取消、重复调用有明确语义 | G3/G4 |
| R05 | 单次正确记账、输出预留、自动兜底、无进展停止 | G2/G4 |
| R06 | 原始事件保留、版本化档案、崩溃恢复、会话隔离 | G3/G5 |
| R07 | 有界检索与恢复、历史数据边界、Unicode/附件限制 | G3/G5 |
| R08 | 真实 DSH Web + 指定 GLM 模型验证 | G6 |
| R09 | 状态与故障诊断、可复算证据、安装文档 | G6/G7 |

验收门定义见 [TESTING.md](TESTING.md)。文档、离线测试、真实模型测试不能相互替代。

## 2. 作者设计决定

这些是本次为新产品制定的方案，不追认为用户以前已经拍板的要求。改动必须同步规格、实现、测试与决策记录。

| 项目 | v0.1.0 决定 |
|---|---|
| 默认策略 | bundle 默认 `windowed` 且 governor 开启；中等压力允许 ARC 压缩，高压力由宿主换窗 |
| 兼容策略 | 显式 `in-place` 可选，仍用新宿主正确记账与有界检索；不要求复制旧 bug |
| 自动兜底 | 本地有界抽取，不额外调用 LLM；模型忽略工具时宿主仍负责容量 |
| 工具面 | 保留 compress、decompress、search_context、arc_status；windowed 模式增加 new_context，不同时暴露同义工具 |
| 命令面 | `/context` 的 status/new/search/decompress；`/arc` 可作迁移别名；原生 `/compact` 走新后端 |
| 持久化 | DSH 会话日志为事实源，扩展元数据版本化，内存索引可重建 |
| 复用 | ARC 选择性移植并修正；Codex 移植状态机、分层与测试思想，不依赖其实验服务 |

非目标：不移植 Codex 认证/计费/服务端或 Rust runtime；不建独立向量数据库；不做任意跨会话检索；不修改 DSH 安装文件或原版 preset；不删除会话历史；不自动废弃旧 npm 包；不把 16 语言 README 当首发门。可恢复不等于模型永远记得，有限上下文也不等于无限磁盘。

## 3. 用户可感知的行为

正常使用时不反复插入容量提醒。接近预算时，模型看到当前窗口、剩余空间和可操作范围，可以 compress，也可以 new_context 提交交接记录。在下一次模型请求前，宿主把安全的旧工作集换成有界 checkpoint。文件、目录、终端、后台任务及当前目标不因换窗重置。

新窗口保留宿主当前系统指令与工具、最新用户请求原文、必要的配对尾部、交接记录和档案定位信息。不承诺“除了 checkpoint 空无一物”：工具协议和最新用户约束不能为了清空而丢失。

历史检索返回带来源的小片段。decompress 将选择的文本作为当前工具结果带回模型，不重新执行历史工具，也不恢复旧消息的指令权限。

## 4. 模型工具契约

对象 schema 拒绝未知字段；数字范围明确；外部 seq/blockId/cursor 均需会话内校验。结果可由 DSH TextOutput 承载，机器字段至少区分 success/accepted/no-op/error 与诊断码，不能仅靠自然语言判断成功。

| 工具 | 输入 | 结果与边界 |
|---|---|---|
| compress | ARC `content: [{startSeq,endSeq,summary}]` | 独立范围顺序提交，分别报告成功/跳过/失败；工具的自动边界恢复不能改变官方 compactRegion 的精确范围语义 |
| new_context | `{handoff?: string}`；最多 8000 Unicode code points | 返回 accepted、requestId、当前 generation，**不返回已换窗成功**；下一安全 pre-step 提交。同 generation 重复请求沿用首次 requestId 与 handoff |
| search_context | `{query, limit?, cursor?}`；query 1–256 code points，limit 默认 5、范围 1–20 | blockId、generation、来源 seq、匹配片段、nextCursor、incomplete；有输出和扫描预算，排序确定 |
| decompress | `{blockId, cursor?, maxTokens?}`；默认 2048、上限 4096 | ID 必须完整或前缀唯一；多匹配报 ambiguous-block；输出分页、来源、原文长度、缺失项与 nextCursor |
| arc_status | `{}` | package/version、实际 backend、策略、generation、预算值及来源、pending、最后操作、档案完整性；不无界列出所有档案 |

handoff 建议含目标、用户限制、已完成事实、待办、文件/测试引用。不要求存储模型隐藏推理过程。缺省时使用本地抽取记录和最新用户请求提供恢复线索。超长入参拒绝；checkpoint 因预算截断时必须标记 incomplete 及来源。

“逐字”限定为已持久化 text block 的文本内容：顺序、空白和 Unicode 原样保留；分页拼接后相等。包装头、seq 标签和摘要不参加原文相等比较。事件结构保留与附件可用性是独立契约，见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 5. 预算和配置

下面是已实现的配置接口。schema 与 bundle 的默认值由构建及集成测试核对。

```yaml
- insert:
    - id: compaction-context-management-bridge
      name: dsh-context-management/bridge
      config:
        adaptiveGovernor:
          enabled: true
          strategy: windowed
          maxOutputTokens: auto
          safetyMarginTokens: 4096
          nudgeAtEffectiveCapacityPct: 0.75
          emergencyAtEffectiveCapacityPct: 0.90
          targetAfterTurnoverPct: 0.55
          emergencyFallback: true
        archive:
          seedMaxTokens: 4096
          retrievalDefaultMaxTokens: 2048
          retrievalMaxTokens: 4096
```

测试可增设 `adaptiveGovernor.windowBudgetTokens: 32768` 与 `maxOutputTokens: 8192`。前者只缩小插件逻辑预算，不覆盖 request/context 中真实模型容量，不宣称已在模型物理上限测试。

设 C 为路由容量与可选逻辑预算的较小值，R 为输出预留，S 为安全余量，B=C−R−S 为输入预算，P 为当前输入压力，U=P/B。B<=0，或不满足 `0<target<nudge<emergency<1` 时配置失败。seed/恢复预算不得大于有效输入预算。

- auto 仅在没有明确用户输出意图时取不超过 32768、floor(C/4) 和已知 provider 输出上限的值。显式输出意图保留并提前触发；数字配置是用户设置的硬上限。通过 agent/request 改写，不能修改 frozen stream 参数。
- 此宿主的 contextPressure.projectedTokens 已包含压缩差量，直接读取，**不能再减全账本 shadowedTokenCount**。路由或 envelope 变化后不能沿用未经校验的旧样本。记账细则见架构 §3。
- U<0.75 不发容量 nudge、不自动归档；预算读取、pending 和恢复检查仍可运行。“静默”不等于零监听器。
- 0.75<=U<0.90 每 generation 最多一次 nudge；范围来自当前 surface。
- U>=0.90 自动换窗，目标 U<=0.55；达不到时有界降级或明确停止，不能反复归档直到耗尽资源。
- context-overflow 只认宿主规范化错误。每个失败请求链最多一次插件恢复重试，且要求 replacement generation 前进及压力实际减少；取消优先。
- 恢复输出取 `min(工具上限, B−P−S_restore)`，S_restore 至少 1024 token 用于包装和下一请求增量；不足时只返回小型错误与定位信息，不能整档案输出后再等压缩救场。
- enabled:false 关闭自动 nudge/归档与输出改写，保留手动压缩和检索；new_context 仅 enabled 且 windowed 时注册。手动 `/context new` 不受自动开关限制，但仍须全部安全守卫。

## 6. 失败语义

| 情形 | 必须行为 |
|---|---|
| 无安全前缀、最新用户消息独自超窗 | no-safe-range/no-op，保留日志、说明不可缩减单元，不循环重试 |
| pending 后取消/卸载/轮次结束 | 未提交则取消 pending，不推进 generation，不凭内存遗留状态执行 |
| 手动命令遇运行中 agent | busy，不绕过 runMaintenance |
| 准备后选中范围改变 | changed，闭合失败尝试，不写旧范围 replacement |
| 换窗准备失败且尚未 replacement | 最多一次 ARC 本地安全前缀兜底，重新测量与选范围 |
| replacement 已写而 end/flush 失败 | 恢复/持久化不确定，不能重复兜底；见架构失败矩阵 |
| preset 不识别、第三方后端或作用域冲突 | 保留现后端，显示 unsupported/conflict，不宣称接管 |
| 档案缺失/循环/损坏、未知 schema | incomplete/unsupported-schema，保留证据，不伪造原文 |
| 历史内容含指令 | 按历史数据处理，不授权、不执行历史工具 |

## 7. 发布定义

[测试矩阵](TESTING.md) 硬门全部通过并形成新版验收报告后，才可交付 `dsh-context-management-0.1.0.tgz`。内部候选可以用 prerelease，但最终版本必须为 0.1.0。npm 发布、旧包弃用和远端仓库改名不属于本次交付。实际结果见 [RELEASE.md](RELEASE.md)。


## 实施补充（2026-09-07）

宿主在 pre-step 返回后才把已领取的用户输入写入日志，因此已领取的新用户消息可作为虚拟末端边界；插件不代替宿主追加它。该边界只接受尚未入日志的真实用户消息 ID，提交元数据记录该 ID，集成测试确认原消息最终只出现一次。

本地 window seed 先保留原始用户消息的有界引用，再保留原始工具来源中的有界结构化标量记录（例如 JSON 配置值），最后按需要回退到本地摘录索引。模型提供的 handoff 仍受相同总预算限制。所有摘录都是历史数据；最新用户要求仍有优先级。截断、未被索引的自然语言和附件不声称完整语义保存，可从档案恢复。

检索使用 reader/session 所有的有界游标缓存（每会话最多 256 个，reader 重启或游标被淘汰后重新开始读取）。游标不携带原文。search 返回原始 sourceSeq、textBlockPath 和 UTF-16 标量边界 offset；decompress 可直接从命中位置开始，续页只传 cursor。每页按完整 JSON 的 UTF-8 字节数保守计量，包含元数据和游标，避免转义文本突破上限。游标是可选的进一步证据入口，不能据此要求模型读完整个档案。


## 0.1.1 行为细化（对应两轮测试与设计评审）

配置中静态可判定的预算、archive 上限和模板在 bridge apply/engine 构造前验证。真实路由及 assembled 信封在请求前校验，宿主 estimated measurement 的 `totalTokens - surfaceTokens` 仅用于辨别不可缩减信封；usage 锚点下不据此推断固定信封。不改变 host projectedTokens，也不扣减档案账本。

接管失败必须先验证回滚后后端与原 Basic 原型一致，方可继续请求并告警；失败 Promise 不再永久阻塞已确认回退的 mount。回滚失败或后端不明仍阻断。每 agent 屏障监听随 agent/disposed 移除，session 派生缓存使用 WeakMap<Session, …>，取消等待不取消其他 agent 共享的 mount 更新。

DSH 0.1.2-rc.1 的外层 loop 仅序列化 LlmError.failure。插件错误继承该公开 HarnessError 子类；安装环境可能存在第二个 external 模块实例，因此 runtime 错误经宿主公开 Loader.import 解析同一模块域的 LlmError，保留 Web/turn-end 机器码。使用 CONTEXT_* 或工具专用代码，不伪装为 CONTEXT_WINDOW_EXCEEDED，不自动触发 provider 重试。pre-step/request 构建失败不属于 agent/request-error；后者仍只处理 provider 物理溢出。宿主 pre-step 前已 claim 的输入若尚未写日志，异常不保证重排队；修复配置后须检查并重提缺失输入。

in-place 的“无法安全压缩则 no-op”仅描述压缩事务不写事件，不代表允许下一次超预算请求。允许合并满足配对、最新用户保护和净收益条件的旧 checkpoint，并记录父档案以恢复原始来源。无安全缩减且请求超 B 时以 CONTEXT_BUDGET_EXHAUSTED 停止。

accepted new_context 最终 no-op 时，下一 admitted request 记录一次包含 requestId 的插件消息；空白 handoff 等价于未提供。seed.mode 和 seed.incomplete 分别表达提取方式与实际信息截断/缺失。多次搜索可访问同一文本全部命中；游标最近使用更新 LRU，失效需重新读取。EOF 空页同样计入包装预算。归档 health 与账本共用相邻 replacement 校验。摘要超 24K 字符在 kernel/持久化前拒绝，不截断已承诺正文。

此补丁保留运行时 bridge 与准确 peer 版本范围。静态 preset 复制方案、sessionProjections 迁移、invariants 注册属于后续架构工作，未宣称新增支持。


### 0.1.1 目标 profile 接管范围补充

安装并启用 bundle 到指定 profile 后，该 profile 内所有 preset 的原生 Basic compaction 都是接管目标，按实际运行的包名与服务域定位，不再依赖固定 preset 名、行 ID 或 group ID。含嵌套 group/Include 的自定义 preset、新增后首次使用的 preset，以及空会话切换后的 preset 均适用。接管自动 pressure、原生 context-overflow 恢复和使用同一后端的 `/compact`；原生 pruner 保留并由新后端按既定策略调用。

以 DSH 0.1.2-rc.1 为准，minimal 不加载 compaction；Web 组合也停用 host-plane Basic。因此 minimal 没有原生后端可替换，保持其两工具与固定提示行为，不能把这一场景报告成 ARC active。第三方后端不属于原生 Basic 接管目标。启用范围由 profile 的 bundle 决定，单纯 npm 下载包不代表该 profile 已启用插件；使用 `dsh plugin --profile <name> add <package-or-tarball>` 完成安装与启用。
