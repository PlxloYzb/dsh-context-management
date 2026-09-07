# dsh-context-management 规格说明(SPEC)

- **版本**:0.3.0-beta.1(首个以新包名发布的版本)
- **迁移源**:`dsh-arc-context` v0.2.0-beta.15,源仓库 HEAD `82fc3004d10c445f82aa97a93ad2a88a3a8794cd`(仓库 `/Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-arc-context`,迁移后仅作只读参考)
- **文档地位**:本文定义本仓库本轮开发的"做什么 / 不做什么 / 怎么验收"。执行步骤见 [PLAN.md](./PLAN.md)。代码迁移完成后,随仓库带来的 `AGENTS.md` 仍是最高开发规范(编码约定、提交规范、依赖线纪律);本文与其冲突时,以"已拍板决策"(§2)为准并记录到 AGENTS.md。
- **写作时间**:2026-09-07,先于代码迁移完成(用户要求)。

---

## 1. 项目定位

本项目是 DeepSeek Harness(DSH)的上下文治理插件,由 `dsh-arc-context` 包级更名而来。内核标识 **ARC(Adaptive Reversible Context)** 保持不变:可逆压缩 + append-only 会话账本 + `search_context` 检索 + `decompress` 逐字还原。通过 Preset Bridge 在 standard preset 的 compaction 隔离域内**替换官方 Basic compact 行**,preset 文件本身逐字节不变。

对外一句话表述(README 首句、npm description 的语义基准):

> **Replaces Basic compact with windowed, reversible context.**

0.3.0 的新能力是**换窗(windowed context)**:接近容量时不再把当前窗持续压厚,而是把当前工作集冻结为一页档案写入账本、开启干净的新工作集;档案页可搜索、可逐字还原、可整段回灌原文。这是与"纯模型笔记 + 检索"(Astra 形态)的本质区别:原件永远可从账本逐字还原。

## 2. 已拍板决策(不可重议)

| # | 决策 |
|---|---|
| D1 | 新包名 `dsh-context-management`;内核与代码标识继续叫 ARC(`ArcEngine` 类名、`compress`/`decompress`/`search_context` 工具名、`arc_status`、`/arc` 命令本轮全部不改名) |
| D2 | 禁止使用 `dsh-window-controller` / `dsh-window-controler` 等名字 |
| D3 | 换窗不做纯 Astra 形态:档案页必须落本地可逆账本,能搜、能逐字还原、能整段回灌原文 |
| D4 | 对外表述必须写清"替换官方 Basic compact" |
| D5 | 持久化兼容红线:磁盘持久化 key 与数据格式不变,已有会话账本/状态必须继续可读 |
| D6 | 首个 beta 默认策略 `in-place`(现行为),`windowed` 为 opt-in;本轮不翻默认 |
| D7 | 依赖线整体升到 dsh 0.1.2-rc.1(dev 线 + peer 放宽),2026-09-07 由仓库所有者确认 |
| D8 | research 历史证据保留旧名 `dsh-arc-context`(实验记录不可改写),2026-09-07 由仓库所有者确认 |

## 3. 命名规格

### 3.1 必须改为新包名的(包级身份)

勘察基线:源仓库全仓 `dsh-arc-context` 共 **71 文件 229 处**(不含 node_modules/dist/.git)。逐类如下:

| 类别 | 位置 | 变更 |
|---|---|---|
| npm 包名 | `package.json` name | → `dsh-context-management` |
| description | `package.json` | 改写,必须含 "replaces Basic compact" 语义(建议:"Adaptive Reversible Context (ARC) for DeepSeek Harness — replaces the stock Basic compact with model-authored reversible compression and windowed, searchable context turnover") |
| bin | `package.json` + `src/preset-cli.ts` + `src/bridge.ts`(L312/317)+ `src/index.ts`(L342)+ 全部文档 | `dsh-arc-presets` → `dsh-ctx-presets` |
| 仓库元数据 | `package.json` repository/homepage/bugs | → `https://github.com/PlxloYzb/dsh-context-management`(以所有者实际改名为准) |
| keywords | `package.json` | 确认含 `dsh-plugin`、`deepseek-harness`、`context-management` |
| patch 条目 | `cordis.patch.yml` | `id: compaction-arc-bridge` → `compaction-context-management-bridge`;`name: 'dsh-arc-context/bridge'` → `'dsh-context-management/bridge'`;头注释同步改写(保留"替换 compaction-basic 行、preset 逐字节不变、卸载零残留"三承诺) |
| Loader builtin 键 | `src/bridge.ts` L38 | `BUILTIN_KEY = 'dsh-arc-context'` → `'dsh-context-management'` |
| 引擎行名 | `src/bridge.ts` L40 | `BUILTIN_ROW_NAME = 'cordis:dsh-arc-context'` → `'cordis:dsh-context-management'` |
| bridge 导出名 | `src/bridge.ts` L248 | `name = 'dsh-arc-context-bridge'` → `'dsh-context-management-bridge'` |
| backend brand | `src/index.ts` L70 | `Symbol.for('dsh-arc-context.backend')` → `Symbol.for('dsh-context-management.backend')` |
| systemPrompt section | `src/index.ts` L537/549 | section name → `'dsh-context-management'` |
| arc_status 输出 | `src/index.ts` L329 | `resolvedBackend` → `'dsh-context-management'` |
| 模块 docstring | 13 个 src 文件 | `@module dsh-arc-context/...` → `@module dsh-context-management/...` |
| 错误前缀 | src 全部 `dsh-arc-context: ...` 错误消息 | → `dsh-context-management: ...` |
| 测试断言 | `tests/governor.test.ts` L71/83、`tests/mount-probe.test.ts` L128-155 等 4 文件 15 处 | 随实现同步 |
| bench 匹配器 | `research/bench/gate-completion-messy.mjs` L44 | 随错误前缀同步(活代码) |
| 审计文案 | `src/preset-cli.ts` L55 | 随包名同步 |
| 门面文档 | 16 个 README、AGENTS.md、CONTRIBUTING.md、LICENSE、NOTICE.md、RELEASE_CHECKLIST.md、ROADMAP.md、docs/ 7 文件、`.github/ISSUE_TEMPLATE/bug.yml` | 随包名同步 |

### 3.2 必须保持原样的(历史记录,D8)

- `CHANGELOG.md` 历史条目不改写,只追加新版本条目说明改名与迁移。
- `research/results/*.json` 历史实验证据(约 45 处旧名):实验跑在旧包名下,属历史记录。
- `research/reports/FINAL_RESEARCH_REPORT.md`、`research/profiles/`、`research/fixtures/` 等历史实验产物。
- `research/scripts/verify-public-evidence.mjs` 的证据钉(如 L46 `resolvedCompactionBackend, 'dsh-arc-context'`、L49 rc.7 preset SHA-256):断言对象是历史结果 JSON,不是当前代码,**不需要也不得修改**。

### 3.3 保留的 ARC 标识与兼容串

| 项 | 位置 | 理由 |
|---|---|---|
| `ARC_ROW_ID = 'compaction-arc'` | `src/bridge.ts` L46 | preset 组合行 id,非包名;保持 diff 最小 |
| `provider: 'local'` / `model: 'arc-local-extractive-v1'`、`'adaptive-governor-extractive-v1'` | `src/fallback.ts` L383-384/433-434 | 已落盘的溯源串;无代码匹配依赖,保留保证旧事件语义连续 |
| `ArcContextEngine` 别名 | `src/index.ts` L706-707 | 已导出的源兼容别名 |
| ARC 工具名 `/arc` 命令、`arc_status` | tools/commands | D1 |
| 事件词汇 `compaction/start|summary|end`、`user/message` + `surfaceOp`、`source.plugin === 'compact'` | region.ts | D5 红线,详见 §4 |

### 3.4 双名识别(向后兼容)

`src/preset-compat.ts` 的 `ARC_NAME` 正则当前只识别 preset YAML 中 `name: 'dsh-arc-context'` 的组合行。改为**同时识别旧名与新名**,保证按旧文档手改过 preset 的用户 `presets:audit` 仍判 PASS;audit 报告区分"旧名引用(建议升级)"与"新名引用"。

## 4. 兼容性规格(红线,D5)

1. **账本 = DSH 会话事件日志本身**,无独立存储文件。全部持久化经 `session.append`(`region.ts` 是唯一调用点),事件类型与字段名属于官方 `@deepseek-ai/dsh-session` 词汇表,不因包名而变。
2. 检查点消息 source 走官方 `compactCheckpointSource()`,回读匹配 `source.plugin === 'compact'`(`region.ts` L569/656)——与包名无关。**已勘察确认:持久化数据中没有任何 key 依赖包名。** 旧会话在新包下完整可读,无需数据迁移。
3. ARC 扩展字段(`tier`/`kernelBlockId`/`parentBlockIds`/`directMessageIds`/`effectiveMessageIds`/`safetyIndexSource`)经 `ArcCompactionSummaryFields` 精确交叉类型读写;0.3.0 新增字段遵循同一模式且全部可选(§5.2),旧版本读新日志忽略未知字段、新版本读旧日志字段缺省。
4. `shadowedTokenCount` 的 legacy 0 值回补逻辑(`rebuildBlockLedger`)必须继续工作。
5. 依赖范围(D7):`@deepseek-ai/*` 分包 peer 放宽为 `^0.1.0-rc.7 || ^0.1.2-rc.1`(semver 预发布规则下单一 `^` 范围无法同时覆盖 rc.7/rc.8 与 0.1.2-rc.1);`@deepseek-ai/cordis ^4.0.1`、`cordis-plugin-loader ^1.0.2`、`schemastery ^3.18.1` 维持不变(4.0.2/1.0.3 均满足)。devDependencies 整体升到 0.1.2-rc.1 线(cordis 4.0.2 / loader 1.0.3 / include 1.0.7 / group 1.0.2);`acp-kernel` 维持精确 pin。AGENTS.md 依赖线纪律随之更新为 0.1.2-rc.1 线。
6. 桥接依赖的四个公开面(`ctx.loader.builtins`、`Include.Config.patches`、`agent/created`、`standingMountFor`)已在本机 dsh 0.1.2-rc.1 逐一核实仍在;standard preset 的 `compaction-basic` 行与仓库 fixture 逐字一致(0.1.2-rc.1 仅给 `tool-result-pruner` 行新增了 config,不影响任何守卫)。升级后由 bridge 集成测试(真实 Loader 挂载)在新线上全量重跑背书。

## 5. 换窗功能规格(0.3.0 核心新能力)

### 5.1 概念模型

- **工作集(working set)**:当前 surface 上可见的消息集合,即模型正在其中工作的上下文窗。
- **档案页(archive page)**:一次换窗冻结产生的账本块。它冻结了被换出工作集的全部原文引用(`shadowedSeqs`)+ 一份本地抽取式索引(`summary`),是账本上一等公民的块:`search_context` 可命中、`decompress` 可逐字还原、整块 decompress 即整段回灌。
- **窗口世代(window generation)**:会话内单调递增的整数,每次冻结 +1;`windowId` 为每次冻结的 UUID。重启后从日志重放派生,确定性恢复。窗口族系(首窗/上一窗/当前窗)可由日志顺序派生,不单独落盘(与 Codex `AutoCompactWindowIds` 的对照见 §8.2)。

### 5.2 数据模型扩展(region.ts)

在 `ArcCompactionSummaryFields`(现 region.ts L370-387)增加一个可选字段:

```ts
/** Window-turnover extension: present only on archive-page freezes. */
readonly window?: {
  readonly windowId: string        // randomUUID per freeze
  readonly generation: number      // 1-based, session 内单调递增
  readonly frozenAt: number        // epoch ms
}
```

- `ArcBlockLedgerEntry` 同步增加可选 `window` 字段;`rebuildBlockLedger`(L575-617)派生时透传。
- **不新增 SessionEvent 类型**(词汇表归 `@deepseek-ai/dsh-session` 管)。档案页事务沿用四事件序列:`compaction/start` → `compaction/summary`(携带 `window` 字段)→ `user/message`(checkpoint,`surfaceOp: {op:'replace'}` 覆盖被冻结区间)→ `compaction/end`;append-only 语义与并发锁(`assertNoActiveCompaction`)完全复用。
- 档案页 **tier = 1、无 kernelBlockId**(不经 acp-kernel `applyCompression`,冻结不是压缩);`decompress` 经 `shadowedSeqs` 现有路径逐字展开,`search_context` 的 haystack(summary + 被冻结原文拼接)自动覆盖。
- 新增 `runWindowFreezeTransaction`(仿 `runManualCompactionTransaction` region.ts L463-562 的失败补偿与 flush 语义),作为换窗唯一的落账入口。

### 5.3 `new_context` 工具(tools.ts)

**注册条件**:仅当 `adaptiveGovernor.enabled === true && adaptiveGovernor.strategy === 'windowed'` 时注册进模型工具面。默认(`in-place`)与 governor 关闭时**工具面与 v0.2.0-beta.15 完全一致**(四工具),这是验收标准 6 的组成部分。

**签名**:

```ts
new_context({ handoff?: string })
```

- `handoff`(可选,≤ 2000 字符):模型写给新窗的简短交接注——环境事实、约定、进行中的推理链、未决问题。缺省时新窗种子只含窗口边界标记与本地抽取式索引的头部要点。

**行为规格**(按序):

1. **范围解析**:冻结剩余活动 surface 全区间(实现用现有 `shadowedSeqsOf` 收集全部可遮蔽 seq;具体取 `buildCompressibleSeqRanges(session, {preserveRecent: 0})` 的最大范围还是全区间并集,以实现期测试定,规格只要求"剩余工作集被完整冻结、新窗除 checkpoint 外干净")。
2. **守卫**:无 open turn 时报错;空范围 / 无可遮蔽 seq 时报错;**冻结后不减少上下文时拒绝**(与手动压缩 `runLocalCompactionRegion` 的"not larger than its checkpoint"守卫同款)——这同时防止模型滥用 `new_context` 反复冻结。
3. **档案页摘要**:本地抽取式,复用 fallback 的 `buildEmergencyFallbackSummary` 机制(24K 字符上限、head/tail 预览、KEY=VALUE/DECISION 结构化行、archived-instruction 消毒),无 LLM 调用。`handoff` 经同样消毒后并入摘要尾部。
4. **落账**:`runWindowFreezeTransaction` 单事务完成(§5.2);`shadowedTokenCount` 必须按 host token meter 计价(AGENTS.md 硬规则)。
5. **新窗种子**:checkpoint 消息内容 = 窗口边界标记(含 generation 与指引:"旧窗内容已存档,用 search_context 检索、decompress 还原")+ `handoff`/抽取式要点。
6. **输出**:面向模型的文本报告(frozen N events, ~T tokens archived, window #G opened…),风格与 compress 的输出报告一致。

**检索与回灌语义**(验收标准 5):

- `search_context(term)` 命中档案页的被冻结原文或摘要时,返回该块,并标注档案页身份(带 `windowId`/generation);`decompress(blockId)` 对档案页返回被冻结原文的逐字拼接,冠以现有 `ARCHIVED_CONTEXT_DATA_BOUNDARY` 边界头;整块 decompress 即"整段回灌原文"。
- `arc_status` 在 windowed 模式追加窗口小节:当前 generation、档案页数、累计冻结 token。

### 5.4 `/arc new-context` 命令(commands.ts)

任何策略下均可用的用户手动触发入口(等同 `/arc compress` 的 opt-in 语义,不改变模型工具面):raw 前缀匹配新增 `new-context` 分支;空闲期执行(沿用 `runMaintenance` 空闲括号模式);description 与 `/arc` 帮助文案同步。

### 5.5 治理集成(governor.ts / index.ts / cordis.patch.yml)

**配置**(挂在 `adaptiveGovernor` 下,结构其余字段不动):

```ts
strategy?: 'in-place' | 'windowed'   // 缺省 'in-place'(D6)
```

cordis.patch.yml 的 `adaptiveGovernor` 块**本轮不新增该键**(保持默认 in-place 的安装即现行为);README/docs 展示 opt-in 写法。

**nudge 路径(0.75)**:windowed 模式下 nudge 文案换为窗口变体——告知接近容量,建议调用 `new_context` 换窗(旧窗可搜、可还原),而非继续 compress 压厚。nudge 注入机制、`emergencyOverride` 语义不变;**去重域以窗为界**:换窗开启新窗后,提醒与兜底提示的"一次性标志"随新窗重置(对齐 Codex `AutoCompactWindow` 的 per-window claim 语义,见 §8.2-C5),窗口变体文案包含"本提示取代此前所有容量提示"的替换声明句式(对齐 Codex `ContextWindowGuidance` 的 REPLACEMENT_NOTICE 句式,见 §8.2-C6)。prompts.ts 新增对应模板键(进入 `TOOLS_ALLOWED` 校验集与 `DEFAULT_PROMPTS`,构造期 fail-fast 校验占位符)。

**emergency 路径(0.90)**:决策漏斗在 `compactIfNeeded`(index.ts L604-632)。阈值判定(`shouldRunEmergencyFallback`)之后、执行之前:

- `strategy === 'windowed'`:先尝试**本地冻结换窗**(无 LLM,§5.3 步骤 1-5);成功即返回。
- 冻结失败(守卫拒绝/异常):**显式回退**现有 `runEmergencyFallback`(in-place 抽取式冷存)。windowed 模式不允许无兜底。
- 溢出恢复路径(`agent/request-error` 的 `CONTEXT_WINDOW_EXCEEDED` + `replaceGeneration` 进展证明)对冻结事务同样成立:冻结产生 surfaceOp replace,即 durable 进展。

**安全区不变式**:余量充足时(阈值以下)零新增监听器触发、零行为差异、静默——现有卖点,不得回归(§5.7 T6)。

### 5.6 状态管理(state.ts)

`ArcStateStore` 增加 per-session 窗口记录(当前 `windowId`/`generation`),**持久化遵循 log-is-the-source-of-truth**:世代与档案页全部从日志 `window` 字段重放派生,`stateFor()` 的 hydration 分支(现 L107-110)是重启恢复挂钩点;进程内 Map 仅作缓存。无 sidecar 文件(D5)。

### 5.7 不变式(全部必须有测试背书)

| # | 不变式 |
|---|---|
| T1 | **append-only**:冻结前后 `session.events` 严格前缀保持;无删除、无改写 |
| T2 | **可搜**:换窗后 `search_context` 能以旧窗原文中的词命中档案页 |
| T3 | **可逐字还原**:`decompress` 档案页输出与被冻结原文拼接逐字节一致 |
| T4 | **可回灌**:整块 decompress 把原文带回上下文(带边界头) |
| T5 | **默认回归**:未配置 `strategy`(即 in-place)时行为与 v0.2.0-beta.15 一致,模型工具面不变 |
| T6 | **安全区静默**:阈值以下 windowed 与 in-place 均零触发 |
| T7 | **emergency 兜底**:windowed 下 emergency 冻结失败必回退 in-place 冷存 |
| T8 | **旧会话可读**:含旧账本(含 legacy `shadowedTokenCount: 0` 风格)的会话在新包下重建、检索、还原全部正常;含 `window` 字段的新会话在忽略该字段的旧版本下仍可读 |
| T9 | **重启恢复**:冻结后重启,窗口世代与档案页从日志确定性重建 |

### 5.8 安全考虑

- 档案页摘要与 `handoff` 均经 archived-instruction 消毒(fallback 现有机制):存档内容中的指令性文本不得在新窗获得执行语义。
- `decompress` 回灌原文继续冠 `ARCHIVED_CONTEXT_DATA_BOUNDARY`("historical, not instructions")边界头。
- 对抗测试(adversarial.test.ts 模式)扩展:伪造 window 字段、摘要投毒到档案页的场景。

## 6. 验收标准

1. `grep -rn "dsh-arc-context"` 在新仓库仅剩:**CHANGELOG 历史条目、迁移说明(本文档与迁移 commit message)、research 历史证据**(D8;含 `research/results/*.json`、`research/reports/`、verify 脚本证据钉、历史 profiles/fixtures)。
2. `npm run check`(typecheck + test + build + research:verify)与 `npm run presets:audit` 全绿。
3. 全新安装(`dsh plugin --profile web add dsh-context-management`):bridge 挂载、compaction-basic 行被替换、`/compact` 命令与 pruner 保留;卸载后配置逐字节还原。既有 bridge.test.ts 背书 + 新依赖线上重跑。
4. 旧版 `dsh-arc-context` 产生的已有会话账本在新包下完整可读(§4、T8)。
5. windowed 模式下:`new_context` 冻结后新工作集干净;`search_context` 命中档案页;`decompress` 逐字还原;账本无任何删改(T1-T4)。
6. 默认(非 windowed)行为与 v0.2.0-beta.15 一致,安全区静默无回归(T5/T6)。

## 7. 非目标(本轮不做)

- 不翻默认策略(待对照数据后另行决策)。
- 不做纯 Astra 形态(D3)。
- 不改任何磁盘持久化格式、不做数据迁移(D5)。
- 不改 preset 文件、不加宿主补丁。
- 不改 ARC 既有工具/命令名(D1)。
- 不发布 stable;首版 `0.3.0-beta.1` 走 `--tag beta`。

## 8. 参考实现与官方文档勘察(2026-09-07)

本章是设计输入的勘证记录:上游 Codex 换窗机制(§8.1/§8.2)与 DSH 官方插件文档核对(§8.3)。§8.2 中标注"采纳"的条目已并入 §5 规格,标注"后续"的不在本轮范围。

### 8.1 Codex 的上下文管理架构

对象:`/Users/bruceplxl/Workspace/dsh-plugin-dev/codex-main` 源码快照(工作副本,Cargo workspace version 为占位 0.0.0,以文件路径为准),经 codegraph 索引勘察。

模块地图:

| 模块 | 职责 |
|---|---|
| `codex-rs/core/src/context_manager/`(history.rs / updates.rs / normalize.rs) | 会话历史所有者(`ContextManager`);`replace_history` / `replace_annotated_history` 以 `HistoryReplacement::{Compaction, Reset}` 整体替换历史 |
| `codex-rs/core/src/context/`(50+ 文件) | "contextual fragments":类型化模型可见片段(`ContextualUserFragment` trait:role / `content_kind`(`<feature>.<name>` 分类)/ markers / body);压缩摘要、token 提醒、容量指引等都是 fragment |
| `codex-rs/core/src/context/world_state/` | 跨压缩携带的"活状态":按稳定 section ID 组织,`WorldStateSection::render_diff(previous)` 只注入差量,带替换/撤销声明与 legacy fragment 匹配 |
| `codex-rs/core/src/state/auto_compact_window.rs` | 窗口世代状态机(详见 C1) |
| `codex-rs/core/src/session/context_window.rs` | 双口径容量记账(详见 C3) |
| `codex-rs/core/src/session/token_budget.rs` + `TokenBudgetConfig` | 预算提醒配置,可由模型元数据下发默认值(详见 C4) |
| `codex-rs/history/src/retained_context.rs` | 跨压缩保留的有界事实(详见 C7) |
| `codex-rs/core/src/compact.rs` | 压缩任务:pre/post compact hook(可中止)、analytics、trigger=Manual/Auto |
| `codex-rs/ext/history-notes/` | 模型笔记扩展,即 Astra 式"纯笔记"形态(详见 C9) |

九个机制要点:

- **C1 窗口世代状态机**:`AutoCompactWindow { window_number, ids: {first, previous, current: Uuidv7}, prefill_input_tokens, new_context_window_requested, token_budget_reminder_delivered, auto_compact_fallback_delivered }`。`advance()` = number+1、previous←current、新 Uuidv7、重置全部一次性标志;`restore()` 从 rollout 恢复;窗口 id 三元组持久化在每个压缩检查点(`CompactedItem`)里。
- **C2 模型主动请求换窗**:`request_new_context_window()` 经会话 API 暴露,宿主循环 `take_new_context_window_request()` 消费后 `start_new_context_window()`(advance + 清 prefill 基线)。相关测试名揭示语义:"token_budget_auto_compact_fallback_uses_buffer_until_new_context"、"token_budget_mid_turn_auto_compaction_resets_before_active_follow_up"(turn 中途自动压缩)。
- **C3 双口径容量记账**:`ContextWindowTokenStatus { active_context_tokens(全量), auto_compact_scope_tokens(scope=Total 或 BodyAfterPrefix=当前窗增量,基线=每窗 prefill,ServerObserved 优先于 Estimated), auto_compact_scope_limit, full_context_window_limit(= context_window × effective_context_window_percent%,独立硬顶), base_window_tokens_remaining(两口径取 min), fallback buffer }`;`token_limit_reached` = scope ≥ limit+buffer 或触硬顶。`auto_compact_token_limit` 缺省从 context_window 的 **90%** 派生并 clamp;fallback buffer 仅在配置了 fallback prompt 时预留。
- **C4 模型自带的预算默认值**:`ModelInfo.model_messages.token_budget`(后端 `/models` 端点下发)可携带 reminder_threshold_tokens、reminder_message_template、guidance_message、auto_compact_fallback_prompt(≤2000 字节)、auto_compact_fallback_buffer_tokens;`resolve_token_budget` 合并用户配置与模型默认并校验。
- **C5 每窗一次性提醒**:`claim_token_budget_reminder` / `claim_auto_compact_fallback`(claim 即置位,advance 重置)——容量提醒与兜底提示每窗最多各一次。
- **C6 世界状态差量注入**:`WorldStateSection`(稳定 ID、可持久化 snapshot、`render_diff`、legacy/retained fragment 匹配)。压缩时 `replace_compacted_history` 将 world_state_baseline 置为**全量**快照(`WorldStateItem::full`)——新窗起全量重放;历史中的 contextual user messages(`is_contextual_user_message_content`)被过滤、由活状态重新渲染。容量指引的替换声明句式:`"This context-window guidance replaces all previously provided context-window guidance."` + 对应撤销声明。
- **C7 跨压缩保留事实**:`RetainedContext`——宿主专有、模型不可见的有界快照(VerifiedAnswer、RetainedUserMessage 用户限制),随压缩检查点持久化;"Facts live until their instruction boundary is rolled back; compaction does not expire them";按 acceptance order 排序,超限(条数/字节)逐出并置 `incomplete` 标志(诚实的不完整性标记)。
- **C8 压缩实现形态**:压缩是一个特殊 turn(`run_compact_task_inner`,带 trigger/reason/phase,pre/post hook 可中止);新 `TurnItem::ContextCompaction`("contextCompaction")替代 legacy `ResponseItem::Compaction`;远端压缩 v2 走服务端 compact 端点并逐尝试追踪;检查点记录 `compaction_model_hash`,模型切换后用于检测陈旧摘要。
- **C9 模型笔记扩展**:`HistoryNotesExtension`(`ext/history-notes`)同时实现 `ContextContributor` 与 `ToolContributor`,由 `TokenBudgetConfig.use_history_notes_extension` 门控;测试名表明其用途是 context window hints 的 notes backend——即"模型维护笔记、笔记作为上下文贡献回来"的 Astra 式形态。

### 8.2 对 ARC 0.3.0 设计的映射

| Codex 机制 | ARC 0.3.0 对应 | 关系与结论 |
|---|---|---|
| C1 窗口世代 | `window { windowId, generation }`,族系由日志顺序派生(§5.1) | **采纳(同构)**。Codex 需在检查点存 id 三元组,因为其历史可整体替换;ARC 的 append-only 日志天然保序,族系派生即可,不落盘 |
| C2 模型请求换窗 | `new_context` 工具(§5.3) | **同向验证**。差异:Codex 置标志、宿主异步消费;ARC 是同步工具事务、即时 durable 落账——更强(可搜、可还原) |
| C3 双口径记账 | governor `effectiveInputLimit`(= window − outputReserve − safetyMargin)+ 0.75/0.90(§5.5) | **形状一致**(scope 内提醒 + 硬顶强制)。ARC 以 `compressionAwareProjectedTokens`(shadow 计价)达到 Codex BodyAfterPrefix 的同效:冻结即 shadow,压力自然回落。Codex 缺省 auto-compact 阈值 90% 与 ARC emergency 0.90 数值巧合,可作 README 参照 |
| C4 模型下发默认值 | `config.prompts` 可覆盖模板 + ARC 默认文案 | **模式对齐**;模型下发预算默认值列为后续方向(不在本轮) |
| C5 每窗一次性提醒 | windowed nudge 去重域以窗为界(§5.5 已并入) | **采纳** |
| C6 世界状态差量 | `handoff` 短注 + 抽取式要点作新窗种子(§5.3) | **轻量对齐**。不引入完整 WorldState 机制(超出本轮);handoff 四要素(环境/约定/推理链/未决问题)与 Codex section 化活状态同源;替换声明句式已并入 nudge 规格 |
| C7 保留事实 | ARC tier-1 账本本身 | **根本差异(护城河)**:Codex 只保留有界提炼事实,逐出后不可复原(仅置 incomplete 标志);ARC 保留全部原件、可搜、可逐字还原、永不逐出。README 对比小节的核心素材 |
| C8 压缩形态 | compress 内联工具 + 本地四事件事务 | 形态不同(内联 vs 独立 turn/远端端点);trigger 分类对应(Manual/Auto ↔ 手动/pressure/overflow);`compaction_model_hash` 式陈旧检测列为后续方向 |
| C9 模型笔记 | 明确不做(D3) | Codex `history-notes` 即"纯笔记"形态;ARC 档案页与其本质区别 = 原件可逆。README 换窗小节引用此对比 |

### 8.3 DSH 官方插件文档核对(develop/basic + develop/basic/publish)

- **机制确认**:`dsh.bundle` manifest(`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`)、`dsh plugin --profile <name> add/remove` 语义、bundle 层栈、卸载移除依赖与层——与本插件 bridge 设计的前提全部吻合,无矛盾。
- **层叠语义(新确认,影响文档)**:组合层应用顺序 = bundle patch(按 `dsh.profile.bundles` 列表序)→ profile `cordis.patch.yml` → home 级 patch → `--patch` overlay;**后层按行 id 胜出,且 patch 替换目标行的整个 config 值,不做深度合并**。推论:用户在自己的 profile patch 里覆盖本插件 bridge 行开启 windowed 时,必须**整块重述** `adaptiveGovernor` 配置(只写 `strategy` 会清掉其余键)——README opt-in 示例与 INSTALL 必须按此写(已列入 PLAN P3)。
- **验证手段(新确认)**:`dsh --profile <name> --dump-config` 导出层叠后配置,适合安装验证与故障排查——纳入 README/INSTALL 验证步骤。
- **安装渠道(新确认)**:git 直装需 `prepare` 脚本 + pnpm `allowBuilds` 授权;npm 发布 / tarball 的预构建路径无授权坎——印证 P4 走 npm publish;beta 内测可用 `dsh plugin add <tarball>` 本地分发(PLAN P1 本机实测即此路径)。
- **文档空白**:官方 develop 文档目前**没有** compaction/上下文治理扩展点专页;本插件桥接依赖的四个公开面(loader.builtins / Include patches / agent-created / standingMountFor)属于 loader/agent 层 API——继续按 `docs/PRESET_INTEGRATION.md` 自行文档化,并在 README 标注"非官方文档化集成面,已随 dsh 0.1.x 线实测验证"。
