# dsh-context-management v0.1.0 设计契合度审查报告

审查日期：2026-09-08。对象：本仓库 `main@89fe675` 源码线（与 npm 公开发布 0.1.0 同源；两轮对抗测试已证明发布产物与源码行为一致，SHA-256 81640a34…）。

审查问题（用户指定）：**它的设计是否符合 dsh 插件的设计哲学，并且契合当前版本（DSH 0.1.2-rc.1）的 dsh？有无任何可改空间？** 本报告与 `TEST-REPORT.md` / `TEST-REPORT-2.md`（两轮对抗测试，F-01…F-20）互补：测试报告回答"行为对不对"，本报告回答"设计对不对、契不契"，并把行为缺陷映射到设计根因。**本次零产品代码改动**，仅新增本报告文件；`npm run typecheck` 复跑通过，基线与两轮报告一致。

## 0. 总结论

1. **核心协议层高度契合，可作为 0.1.x 稳定基线保留。** CompactionEngine seam 三接口、compaction 四事件协议、surface replace 唯一变更通道、token 记账三量分离（直接读投影 / nodes.tokens 路由价 / heuristicTokens shadow 价）、"model-visible means logged"（nudge 经 pre-step 注入并由宿主全量入日志）、bundle 发布形态、检索历史数据边界——逐项与官方文档及 0.1.2-rc.1 宿主真实类型核对通过（§3）。
2. **偏离集中在失败路径、生命周期与配置加载期语义，不在正常路径。** 共识别 5 项设计级偏离（D1–D5）与一组次要点（D6）。其中 D2（bridge 就绪屏障无降级分支）、D3（配置校验未前移到加载期）、D4（进程内强引用驻留）、D5（请求路径裸抛硬错）分别是测试报告 F-12、F-01/F-11/F-12、F-06/F-14、F-13/F-10 的设计根因。
3. **"运行时 bridge 接管 preset"是本插件最大的结构性权衡（D1）**：它由公开 API 组成、可逆、零文件写入，动机正当，但不是官方文档记载的组合模式；官方等价路径是"复制 preset 改行"。插件文档对此诚实申报。建议双轨：保留 bridge，同时把静态组合路径升为受支持的备选。
4. **与 0.1.2-rc.1 的契合度良好**：未发现私有路径 import；所有宿主 API 经包公开 exports 核实。两个"半内部"依赖点（cordis `symbols`、`internal/service` 事件）已列出风险与替代（§5）。peer 精确锁定 rc 版本是可辩护但需要显式管理的生态权衡。

## 1. 审查方法与证据等级

| 证据源 | 用途 |
|---|---|
| 官方插件文档（develop/basic 四页、framework 三页、practice、reference 架构/compaction/token-meter/session/session-projection/invariants/publish） | 提炼设计哲学判据（§2），URL 见附录 |
| 本地 `node_modules/@deepseek-ai/*`（0.1.2-rc.1 真实安装） | API 公开性与行为事实源（.d.ts 与编译产物逐点核验） |
| 本仓库全部 `src/`（约 6.3K 行）与 docs/ | 设计与实现对照 |
| 参考仓库 `dsh-arc-context` 0.2.0-beta.15（只读） | 同源模式的演进对照（bridge 失败语义、agent/request 行为） |
| `dsh-compaction-basic` 编译产物 | 官方后端同构性对照（监听器安装模式、compactRegion 守卫） |
| `npm run typecheck` | 基线自证 |

自我对抗记录见 §6：本轮推翻或修正了 8 项初步判断，未验证项如实列出。

## 2. dsh 插件设计哲学（判据提炼，均出自官方文档）

- **P1 组合模型**：dsh 建于 Cordis，"plugins contribute services, typed events, and reversible effects to a shared context… no privileged core"。能力按 Service Definition / Provider / Consumer 三分，Provider 通过 `cordis.yml` 交换；"The complete capability is its seam."
- **P2 生命周期与失败隔离**：插件拥有独立 Fiber（PENDING→LOADING→ACTIVE/FAILED→…）；`apply` 抛错只使该插件 FAILED，不拖垮宿主；经 `ctx` 的注册在卸载时自动撤销；异步清理需自行串行化。HMR 靠注册自清理实现热替换。
- **P3 配置哲学**："No hardcoded tunables"（两个部署可能不同的值必须是 config 字段）+" **Fail loudly**"——自包含约束应放进 schema，坏配置在**加载期**以可行动错误失败，而不是运行期第一个 prompt。
- **P4 事件模型**：durable `session/event`（重放事实）与 live `agent/*`（协调控制）分离；瀑布事件（`agent/pre-step`、`agent/request`…）监听者必须保留下游 decision 字段（除非有意替换）。
- **P5 会话事实源**：Session 是 append-only 事件日志，"Model-visible means logged" 由运行时不变量强制；表面唯一合法变更通道是 `user/message` 的 `surfaceOp replace`。
- **P6 compaction seam**：`ctx.compaction`（`compactIfNeeded`/`compactNow`/`compactRegion`）、四事件锁协议（start→summary→replace→end）、ManualCompactionError 分类码、后端停用 Basic 后必须自己接手 `toolResultPruner` 与 pressure/overflow 两个宿主边界；seam 本身不拥有计价——`ctx.tokenMeter` 管估价与重放。
- **P7 发布形态**：`dsh.bundle.patch` 指向 cordis.patch.yml；层序 bundle→profile→home→`--patch`；行级整份覆盖；`dsh plugin add/remove` 维护 profile。
- **P8 工程规范**：typed error（HarnessError 稳定 code）、不变量只断言事件流/数据、strict TS。

## 3. 契合面逐项核验（通过项）

| # | 判据 | 结论与代码证据 |
|---|---|---|
| C1 | P6 seam | `ArcCompactionEngine extends CompactionEngine`，三抽象方法齐全且签名与 `dsh-compaction/lib/types/index.d.ts:75-132` 逐条一致（src/index.ts:706-827）；`ManualCompactionError` 分类（busy/cancelled/changed/summary/commit/persistence）在 compactNow 完整使用 |
| C2 | P6 事件协议 | 只用官方 `compaction/start→summary→user/message(replace)→end`，不新增表面事件类型；replacement 用 `compactCheckpointSource` + `sourceEventSeqs`（src/region.ts:437-488）；扩展元数据 `contextManagement` 版本化（schemaVersion:1）且读取时校验（archive-health.ts:4-17） |
| C3 | P6 记账 | `inputPressure` 直接读宿主投影、仅在 usage 基线有效且 header 未变时采用，否则用 meter 保守值，`logRevision` 防陈旧（src/host-budget.ts:10-23）；shadow 价用 `heuristicTokens`（src/fallback.ts:337），符合官方 shadow-price 协议；旧公式兼容函数已是恒等（region.ts:710-720），无二次扣减 |
| C4 | P5 模型可见性 | nudge 经 `agent/pre-step` decision.messages 注入；宿主 agent-loop 对 decision.messages 逐条 `append('user/message')`（dsh-agent-loop/lib/index.js:559），满足"model-visible means logged"；换窗后过滤旧 arc-nudge 注入属合法的表面缩减（index.ts:511-512） |
| C5 | P6 边界接手 | 停 Basic 后自装 `agent/pre-step`（pressure）与 `agent/request-error`（overflow，要求 replacement generation 前进+压力实际下降，取消优先）（index.ts:496-527），并调用 `toolResultPruner.pruneSession`（index.ts:737-751）——与 dsh-compaction-basic 的监听器安装模式同构（其 lib/index.js:782,796,799,804） |
| C6 | P4 瀑布契约 | pre-step 返回保留 decision 全字段并按需置 `startsRequestSeries:true`（index.ts:511-512），符合"preserve downstream messages and startsRequestSeries unless replacement is intentional" |
| C7 | P1/P7 发布形态 | `package.json` 的 `dsh.bundle.patch`、单行 insert 的 `cordis.patch.yml`、README 安装/卸载命令、profile 层覆盖说明（整份 config 覆盖而非深合并）均与官方 publish 文档一致；宿主包全部 external，acp-kernel 唯一 runtime 依赖精确锁 0.0.24 |
| C8 | P6 隔离域 | engine 经 builtin 行插入 preset 的 `compaction` isolate 域（standard preset 的 `isolate: {compaction, toolResultPruner}` 已核实），同域唯一 provider；`assertActiveBackend` 防止与更近后端形成静心混合（index.ts:364-371） |
| C9 | 工具/命令/提示官方注册面 | `defineTool` + `output.schema.additionalProperties:false`（tools.ts:77-89）；`ctx.commands.register`（commands.ts）；`systemPrompt.section({name, order:150})`（index.ts:605-628） |
| C10 | compactRegion 守卫 | 要求 open turn 与 Basic 完全一致（本插件 index.ts:816-818 vs dsh-compaction-basic lib/index.js:430 "no open turn — automatic compaction events must be enclosed in a turn"）——**非偏离**（此项经对照避免了一次误报） |
| C11 | 检索边界 | 游标 HMAC+服务端表+session/scope/指纹四重校验、重启失效（archive.ts:137-158）；历史数据边界头、incomplete/missing 明示（archive.ts:61,191,214） |

## 4. 偏离与可改空间

### D1 ［结构性权衡］运行时 bridge 接管 preset，而非官方组合路径

- **现象**：bundle patch 只插入 bridge 行；bridge 在每次 `agent/created` 时定位 standing preset mount，用 Include patch + `fiber.update` 两阶段在隔离域内换掉 Basic（bridge.ts:167-211）。
- **官方事实**：publish 文档明确 patch 只能按 id 覆盖**静态组合行**，"no preset mechanism is described"；preset 是运行时动态挂载。官方给用户的定制路径是**复制 preset 文件改行**（standard preset 注释自述，如 subagent provider 的启用方式）。DSH_INTEGRATION.md §1 也诚实声明"自动扫描任意 preset 并通过 bridge 接管不是官方对本插件的兼容保证"。
- **评价**：所有组成件均为公开 API（`standingMountFor` 是 dsh-agent-presets 公开导出 mount.d.ts:71；`loader.builtins` 是 cordis-plugin-loader 公开类型 index.d.ts:60；Include patch/fiber.update 是 Include 插件正式机制；`composedPreset`/`serviceForAgent` 在服务接口上，index.d.ts:241/44）。效果（零文件写入、可逆、卸载/重启回 Basic）确实达成。**动机正当但模式非官方**，代价是：对宿主内部布局（preset 行 id、组结构）的脆弱依赖 + 失败语义要自己造（见 D2）+ 每个新宿主版本需重新实测。
- **可改空间**：(a) 把"静态组合"升为受支持的第二路径——文档化"复制 standard preset、将 compaction-basic 行换成 dsh-context-management 引擎行"的官方做法，作为 bridge 不可用/不被信任时的降级方案；(b) 在 README/DSH_INTEGRATION 中给出两条路径的取舍说明；(c) 跟踪上游是否出现官方后端选择面，出现则迁移。

### D2 ［设计缺陷，F-12 根因］readiness barrier 没有失败降级分支

- **现象与根因**：bridge 为保证"首个 prompt 前接管完成"注册了 per-agent 屏障（bridge.ts:313-331）。`pending` 一旦 reject（如引擎构造抛错、fiber.update 失败），`system-prompt/assemble` 屏障对 `failed` **永久 rethrow**（:321），`agent/pre-step` 屏障 `await pending` 直接抛（:328）——而此时 takeoverMount 已回滚、Basic 已恢复服务。一个 prompts 模板 typo 因此毒化该 mount 的全部后续会话。
- **哲学冲突**：直接违反自家 SPEC §6"preset 不识别/冲突 → 保留现后端继续工作"；也违反 P2（插件失败应隔离在自身 Fiber，FAILED 不外溢）。
- **对照证据**：参考仓库 dsh-arc-context 0.2.0-beta.15 的同源 bridge 在失败路径是"回滚 + `logger.error` + 继续"（其 src/bridge.ts ~322 行）；DSH_INTEGRATION §4 批评其 fire-and-forget 不能证明首请求已接管——**这个批评是对的，barrier 是应加的；缺的只是失败分支**。即 F-12 是本仓库引入 barrier 时的新增回归，不是继承缺陷。
- **可改空间**：失败分支改为"响亮告警（含修复指引）+ 放行 next()（Basic 在位）"；屏障只对"仍在进行中"等待，对"已失败"降级。同时把每 agent 两个屏障监听改为 agent 生命周期自清理（见 D4）。

### D3 ［设计缺陷，F-01/F-11/F-12 入口］配置校验未前移到加载期

- **现象与根因**：官方 P3 要求坏配置在**加载期**以可行动错误失败。现状：schema 对 `prompts`/`coreOverrides` 用 `Schema.any()`（index.ts:269,273）；交叉校验（0<target<nudge<emergency、B≤0）虽然存在但发生在**引擎构造**（governor.ts:86-107、174-180，经 bridge 的 fiber.update 间接触发）；依赖真实容量/固定信封的校验（F-11 的 windowBudgetTokens=8192）则推迟到第一个 prompt 运行期。SPEC §5 承诺"B<=0…配置失败"未兑现为加载期失败。
- **可改空间**（分层）：
  1. schema 层：能静态判定的先收进来——数值型 maxOutputTokens + windowBudgetTokens 时 B≤0 可静态判定；比例排序可静态判定；`prompts` 改为逐槽 `Schema.string()`（或 union string/null）+ 保留占位符校验。
  2. bridge `apply()` 层：在任何 mount 补丁前先 `resolvePrompts`/`resolveAdaptiveGovernor`/`resolveArchiveConfig` —— 让坏配置在 bridge fiber 加载期失败（FAILED 隔离、web 存活、错误可行动），而不是在 fiber.update 深处爆开。
  3. 运行期残留项（auto 输出预留、真实路由容量、固定信封下限）：无法加载期判定，应在**首次 assemble** 时以类型化错误失败并给出最小可行预算文档（与 D5 联动）。
  4. 补 `seedMaxTokens ≤ 有效输入预算` 的交叉校验（F-11 第二半）：静态可判定的部分进 schema/apply。

### D4 ［设计缺陷，F-06/F-14 根因］进程内强引用驻留违背 effect 可逆语义

- **根因（代码证据）**：
  - `ArcStateStore.states`：按 `session.id` 的强 Map，无终结钩子（state.ts:100-123）；engine 已监听 `agent/disposed` 却只 cancel pending（index.ts:495）。
  - `lastNudgeTurn`：字符串键强 Map，每触发过 nudge 的会话留一条（index.ts:342）。
  - bridge `disposers` 数组：每 agent 压入 2 个闭包（屏障监听的注销函数，捕获 agent/pending），仅 bridge 卸载时清（bridge.ts:288,319,327）——钉住 Agent 与 Session 对象。
- **哲学冲突**：P2 的可逆 effect 模型假设插件注册随生命周期回收；跨请求存活的插件侧状态应有宿主生命周期挂钩。对照：Reader/WindowController 用 WeakMap keyed by Session（正确范式）。
- **可改空间**：(a) `agent/disposed`（或 `session/disposed`）时 `store.delete` + `lastNudgeTurn.delete`；(b) 屏障监听改挂 agent 自身 effect，bridge 不持有 per-agent 数组；(c) **中期**：评估把 ledger/kernel-state/identity 这类"log-derived 每会话 fold"迁到官方 `ctx.sessionProjections`——纯同步 fold、注册即 effect、卸载自动移除、带持久化缓存与 UI wire 能力（session-projection 参考页）。注意 `ProjectionDefinition` 要求纯同步 `apply(state,event)`，kernel 的 `processTurn` 是推进式、不完全匹配，可先迁 ledger/identity/status 这类纯派生部分。

### D5 ［设计缺陷，F-13/F-10 根因］请求路径裸抛硬错，未用宿主类型化失败体系

- **现象与根因**：governor 在 `agent/request` 组装后超预算直接 `throw new Error('context-budget-exhausted: …')`（index.ts:472,478），pre-step 的 `checkRemainingBudget` 同样裸抛（index.ts:661）；`new_context` 工具的 `accept()` 路径可抛裸异常（window-controller.ts:134-144 经 identity/assertReady），违反自家 SPEC §4"机器字段区分 success/error 与诊断码"。宿主**有**正解：`HarnessError` 携带稳定 code（dsh-llm/lib/types/error.d.ts:7-18，如 CONTEXT_WINDOW_EXCEEDED canonical code），且 `agent/request-error` 瀑布本就是溢出恢复的官方通道。裸 Error 落到 turn/end 只剩 UNKNOWN。
- **对照**：dsh-arc-context 同位置**只改写 maxTokens 不抛错**，pressure 失败 try/catch 后"continuing the step"（其 index.ts:418-424、pre-step 处）。本仓库的硬边界是自主加严——加严本身可辩护（不让注定失败的请求出门），但 F-13 证明 in-place 临界超支时它把"模型正在合作自救"变成死局，与 SPEC §6 行 1"no-op+说明不可缩减单元"冲突。
- **可改空间**：(a) in-place 策略下临界超支改 no-op + 模型可见说明（nudge/工具结果），把硬失败留给真正不可恢复的情形；(b) 保留的硬边界一律用类型化错误（稳定 code），使宿主/用户可路由；(c) `new_context` 等工具入口把裸异常收敛为 `{status:'error', code}` 返回（F-10）；(d) `parseSeq` 的 `-0`/十六进制接受面收紧（F-15，tools.ts:139-146）。

### D6 次要点（按影响排序）

1. **误导性遗留符号**：`compressionAwareProjectedTokens` 已是恒等兼容函数，但 nudge.ts:44-58 的文档注释仍称"ARC subtracts the durable ledger's shadowed-token claims"——会误导后续维护者重新引入被 REVIEW F02 否定的旧公式。建议删函数或改注释。
2. `arc_status` 的 `version: '0.1.0'` 硬编码（index.ts:665），下个版本必然漂移；应构建期注入。
3. `internal/service` 重试注册模式（index.ts:550,570,625）vs 官方 `inject` 惯例：有 cold-start 竞态的现实理由（注释详实），但 `internal/service` 是 cordis 内部事件名；可评估 `static inject` 或至少在文档标注该依赖的稳定性风险。
4. compress 参数的 `arguments` 容忍形与 `content` 非 required（tools.ts:98-136）是为真实模型兼容的刻意放宽（注释充分），但与 SPEC §4"拒绝未知字段"存在张力——应在 SPEC 记录为有意例外。
5. peer 依赖对 0.1.2-rc.1 **精确锁定**（package.json:68-82）：与"诚实支持矩阵"价值观一致且 publish 文档无版本指导，但宿主每次 rc 演进都会使安装失败；建议建立"宿主升级差分测试→显式放宽"流程而非被动等待报错。
6. `engines: node >=22.12` 窄于常见宿主（arc-context 为 >=20）；若非实测必需可放宽。
7. 可选增强：向 `ctx.invariants` 注册本包不变量（如"换窗后账本可由日志重建、代际链完整"），符合 P8 且提升诊断力（invariants 参考页允许第三方以确切包名注册）。

## 5. "契合当前版本 0.1.2-rc.1"专项核验

- **API 公开性**：全部宿主交互经包公开 exports——`CompactionEngine/ManualCompactionError/compactCheckpointSource/toolPairing*`（dsh-compaction）、`SessionSeq/surfaceOp/EpochHeader/headerEquals/requestContext/requestHeader`（dsh-session）、`tokenMeter.measure/estimateMessage`、`sessionProjections.snapshot`、`defineTool`（dsh-tools）、`CommandDefinition`（dsh-commands）、`systemPrompt.section/assemble`、`renderPrompt`（dsh-system-prompt）、`agentPresets: standingMountFor/composedPreset/serviceForAgent`、`loader.builtins`、Include patch 语义。无深路径/lib 内部 import。
- **两个半内部点**：(1) cordis `symbols`（bridge.ts:34,268 用于取服务 original facade）——是包导出的防碰撞符号表，属"导出但语义内部"；(2) `internal/service` 事件（冷启动重试）。二者均为低风险但非文档化承诺，宿主升级时应纳入差分清单。
- **宿主行为契合**：pre-step 后宿主才把已领取输入写日志（agent-loop 实现核实，SPEC 实施补充与之精确对齐）；`request/context` 路由容量经 `projectedContextWindow` 匹配 provider/model 后才采信（index.ts:373-377）；对 `dsh-session-projection` 只读消费（contextPressure），未注册自定义 projection（见 D4(c) 机会）。
- **rc 演进风险**：bridge 依赖 preset 行 id/组结构（`compaction`/`compaction-basic` 行名守卫能挡住大部分漂移并回 no-basic-row）；`preset-compat.ts` 静态审计已具备但只在 CLI 使用——可在 bridge 接管前先跑同构检查再决定 patch（与 D2 降级配合）。

## 6. 自我对抗记录（推翻/修正的初步结论）

1. **初判"nudge 路径二次扣减违反 SPEC/ARCHITECTURE"** → 读 `compressionAwareProjectedTokens` 实现为恒等（region.ts:710-720），行为正确；降级为 D6.1 注释过时问题。教训：nudge.ts 头注释与实现矛盾，以实现+探针证据为准。
2. **初判"bridge 使用私有 API"** → 逐个核验 `standingMountFor`/`builtins`/`composedPreset`/`serviceForAgent` 均为公开导出；修正为"公开件组合出非官方模式"（D1），仅 `symbols`/`internal/service` 为半内部点。
3. **初判"F-12 模式继承自 arc-context"** → 对照 0.2.0-beta.15：参考仓库恰是"回滚+日志+继续"的降级语义；F-12 是本仓库新增 readiness barrier 时缺失失败分支的**自有回归**（DSH_INTEGRATION §4 对 fire-and-forget 的批评成立，实现只做了一半）。
4. **初判"nudge 注入可能违反 model-visible-logged 不变量"** → 读 agent-loop 编译产物 :559，decision.messages 被全量 `append('user/message')`；符合。
5. **初判"F-13 是宿主行为"** → 定位到 index.ts:470-478 插件自身的 agent/request 裸抛；且对照证明 arc-context 无此路径，属本仓库独有加严。
6. **初判"compactRegion 要求 open turn 是 seam 偏离"** → dsh-compaction-basic 同样守卫（lib/index.js:430）；**非偏离**，撤回。
7. **初判"peer 精确锁定不符生态惯例"** → publish 文档无版本指导；DSH_INTEGRATION 有明确理由（不虚报支持面）；修正为"可辩护权衡+需显式升级流程"（D6.5）。
8. **对"SPEC §5 fail-fast 完全可实现"的修正**：B≤0 的一部分依赖运行期容量/真实信封，无法全部加载期判定；正确目标是"能静态判定的进 schema/apply，其余在首次 assemble 以类型化错误失败"（D3 分层）。

**未能在本轮验证（如实申报）**：HMR 实际卸载/重载路径（文档称 profile 默认 live patch reload；两轮测试亦未驱动）；code/cordis preset 与 standard 并存时的逐 mount 组合行为（preset-compat 静态可判，动态未测）；bridge 屏障与宿主 cancel 的时序竞态（D2 修复时应补测）；1M 物理溢出路径（承两轮报告 NOT EXERCISED）。

## 7. 迭代映射建议（设计项 D × 测试项 F 合并视图）

| 优先级 | 迭代项 | 吸收 |
|---|---|---|
| P2 | **D3** 配置 fail-fast 前移（schema 收紧 + bridge apply 期校验 + 首次 assemble 类型化失败） | F-01、F-11、F-12（入口半） |
| P2 | **D2** bridge 失败降级（告警+放行，Basic 在位）+ 屏障监听生命周期化 | F-12（语义半）、F-14（bridge 半） |
| P2 | **D5** in-place 临界超支 no-op 化 + 全部硬错类型化 + 工具入口机器码 | F-13、F-10、F-15 |
| P3 | **D4** 会话终结清理（store/lastNudgeTurn/disposers） | F-06、F-14（store 半） |
| P3 | **D1(b)** 静态组合文档路径；preset-compat 前置 | —（结构性风险缓释） |
| P3 | F-02/F-03/F-04（search 截断信号、archiveHealth 口径、new_context 反馈）按测试报告排期 | — |
| P4 | D6 全部 + 两轮报告 P4 项 | F-05…F-09、F-16…F-20 |
| 中期 | D4(c) 评估 sessionProjections 迁移；D6.7 invariants 注册 | — |

## 附录 A：证据索引

- 官方文档：`/en/develop/basic/`（插件基础、tool、config、publish）、`/en/develop/framework/`（生命周期、events、service）、`/en/develop/practice/`（能力三分角）、`/en/reference/`（架构）、`/en/reference/subsystems/compaction|token-meter|session|session-projection|invariants`、`/en/reference/agent-lifecycle`。
- 本仓库：src/index.ts、src/bridge.ts、src/config.ts、src/state.ts、src/governor.ts、src/window-controller.ts、src/nudge.ts、src/tools.ts、src/region.ts、src/archive.ts、src/archive-health.ts、src/host-budget.ts、src/prompts.ts、src/fallback.ts、src/preset-compat.ts、cordis.patch.yml、package.json、docs/SPEC.md、docs/ARCHITECTURE.md、docs/DSH_INTEGRATION.md、docs/REVIEW.md。
- 宿主事实源（node_modules，0.1.2-rc.1）：dsh-compaction/lib/types/index.d.ts、dsh-compaction-basic/lib/index.js、dsh-agent-loop/lib/index.js（:559、preStep/turn）、dsh-agent-presets/lib/types/{index,mount}.d.ts 与 presets/standard/agent.cordis.yml、cordis-plugin-loader/lib/types/index.d.ts（:60）、cordis/lib/index.js（symbols）、dsh-llm/lib/types/error.d.ts、dsh-session（SessionSeq/surfaceOp 契约）。
- 参考仓库（只读）：dsh-arc-context@0.2.0-beta.15 src/bridge.ts（失败降级）、src/index.ts:418-424（agent/request 仅改写 maxTokens）。
