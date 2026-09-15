# 下一阶段实验协议：长程、多次换窗与长尾历史

[English](EXPERIMENT-LONGRUN-3M.en.md) · [机器可读计划](experiments/muse-longrun-v1.plan.json) · [上一轮结果](RELIABILITY-HARNESS.zh-CN.md)

**协议 ID：`muse-longrun-v1`，revision 1；设计日期：2026-09-15。状态：设计完成，未执行本阶段模型实验，长程执行器待实现。**

本文是执行合同和交接手册。文中的验收值是预先规定的目标，不是已取得的成绩。`tests/live/longrun/` 下的命令是下文要求实现的新接口；不能把它们当作仓库中已有的工具。现有入口与缺口见第 14 节。

## 0. 接手 agent 先读这一页

目标：在同一条逻辑会话累计数百万 token、多次真实压力换窗、多份摘要先后交付、旧摘要再次进入历史之后，验证插件是否仍与 Harness 正确配合，以及相对原生 Basic 的质量、等待、成本和恢复表现。

必须遵守的决定：

1. **主实验两臂**：`ARC_DEFERRED` 与 `BASIC_MATCHED`。后者使用未经修改的原生 Basic 实现，仅用测试覆盖层匹配触发/保留阈值；不是出厂默认参数。另列 `BASIC_DEFAULT` 原始默认策略检查，不能混称。
2. **3M 取更严格的口径**：每个主臂、每个正式 seed、每条独立长会话的已核实前台用量至少 **3,000,000 token**。两个主臂 × 两个正式 seed，最低为 **12M 前台 token**，摘要、试跑、故障诊断另计。不能用多个短会话、重试或后台摘要相加充抵。
3. 除 token 下限，还要求独立新材料至少 500,000 宿主 heuristic token、ARC 至少 12 次真实换窗、至少 6 份不同来源摘要已交付，以及跨至少 6 个已提交窗口的长尾证据。实际未达标就记录覆盖不足。
4. 所有真实前台和摘要调用统一为 **`opencode-go-muse/muse-spark-1.3-contributor`，`minimal`**，宿主固定 **DSH 0.1.2-rc.1**。不启用本地 Qwen、不建立本地模型隧道、不使用全局新版 dsh。
5. 一次只放行一个 seed 的小配对块：两臂并行；同一臂前台串行；每条 ARC 会话最多一个后台摘要。两臂全部终态、审计和评审完成，才放行下一块。长会话内部按 episode 检查，不能一次丢入整个任务后无人监督。
6. 摘要 pending 是正常状态。先换窗、先做独立工作、到缺失历史的依赖点再等待或检索。没有在换窗瞬间拿到摘要，不是失败。
7. 本阶段先完善**实验工具**，不预先调整产品来迎合测试。产品缺陷可修，但必须封存失败、生成新候选/协议修订，再验证；不能中途热换正式样本的代码。
8. 本文授权范围是设计。接手执行者收到执行指令后，按集合点规则自主推进；每个集合点是 agent 审阅证据，不要求用户逐次确认。发现本文已定义的停止条件时停止对应运行并如实报告。

## 1. 上一轮证据与本轮新增问题

上一轮提交 `950353627da25269daf86d63468f49f3c3ba921d`：358 项检查通过；同 realm 接管、原生 `/compact`、安装/卸载/重装通过。Muse 短样本中，ARC 换窗臂四次换窗、24–31 ms 边界、两次摘要交付，质量全过；原地臂漏填 `eventOrder`，该轮没有检索，但原文存在；Basic 逐字探针 1/3。这些不能证明长期稳定性。

本轮要回答：

- 多次换窗后，索引、摘要、最新用户修订和当前工作是否仍各有正确来源？
- 旧摘要被再次压缩、历史越来越长后，检索能否抵达真正原文，并区分旧值、最新有效值和“查不到”？
- 摘要从 pending 到 ready、到宿主实际追加、到以后再次归档，是否全程可追踪，且不串会话、不重复交付？
- 换窗后还有独立工作时，等待是否被自然隐藏；真正需要旧历史时，是否正确等待或检索？
- 长期运行、取消、重启、监督器故障后，Harness 事务、工具配对、命令和服务所有权是否仍正确？
- 与原生 Basic 相比，收益和代价分别在哪里？允许“召回更好但更贵”“结构正确但模型漏答”“覆盖不足”，不预设赢家。

## 2. 单位、token 与完成定义

### 2.1 不混淆六个计数

| 字段 | 定义 | 用途 |
| --- | --- | --- |
| `foregroundVerifiedTokens` | 已终结、用于本条主会话正常工作的前台请求，按真实 usage 归一后的输入＋输出；排除sentinel/最终probe、明确失败/取消/重试尝试及独立诊断fork | **3M 硬下限** |
| `allReportedTokens` | 所有真实调用的可核实用量，含前台、摘要、失败、取消和重试 | 实际消耗下界 |
| `unknownUsageCalls` | 已派发但 usage 缺失/不可解释的调用清单 | 不能当作 0 成本 |
| `reservedExposureTokens` | 为未知调用保守估计的潜在用量 | 运维风险观察，**不能充抵 3M** |
| `uniqueExposedSourceTokens` | 在至少一个真实模型请求中出现过的独立源页，按宿主 `heuristicTokens` 对原始文本计数，每页只计一次 | **≥500,000 新材料覆盖门** |
| `currentProjectedTokens` | 当前宿主即将发送请求的投影压力 | 判断阈值；不得减掉归档账本 |

3M 是十进制 3,000,000。重复发送历史属于真实前台用量，但不是新材料。缓存输入若已经包含在 input 中，不再加一次；cached read/write、reasoning/output 明细独立记账，不能把子项重复相加。usage chunk 是累计还是增量，由实际适配器语义和受控单测确认；通常同一 stream 取最终累计值，不能逐 chunk 直接求和。

每个 `logicalRequestId / streamId / attemptId` 只能贡献一次。无法识别适配器内部 HTTP 重试时，把该字段记为 unknown，不臆造 attempt；此时禁止宣称精确费用。已知前台用量达到 3M 可以证明下限；未知用量仍保留并阻止完整账单结论。为强行达标发送空请求、复读页、无意义总结或关闭缓存均禁止。

3M门在最终probe前由工作请求满足；sentinel与最终probe的实际用量仍计入 `allReportedTokens` 并单列 `probeReportedTokens`，不能让测试题本身把未达标的工作轨迹补成达标。

### 2.2 实验单元

- **episode**：一次小阶段，12 页新材料＋该阶段工作与更新；阅读可分多个模型 step，但同一会话不断开。
- **run**：一个 arm × 一个 seed × 一条全新 session 的完整长程；预先安排的同 session 重启仍属于同一个 run。
- **pair**：同 seed、同材料与任务排程的两个主 run。
- **campaign**：P0/P1、两对正式 run、独立专项和最终审计；不得把其全部消耗合计后声称每个 run 达标。

正式 run 的 `executionCompleted`、`tokenFloorMet`、`coveragePassed`、`integrityPassed`、`qualityPassed`、`latencyTargetMet` 分开记录，不能只有一个 success 布尔值。产品错误导致提前终止时，不为了凑 3M 继续花费；该 run 的 `tokenFloorMet=false` 必须保留。

## 3. 冻结环境与预检

仓库根目录：`/Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-context-management`。

| 项目 | 要求 |
| --- | --- |
| 宿主 | `$REPO/.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh`；设置 `EXPERIMENT_DSH_BIN`，子进程也必须显式传 dshBin |
| Node | 本次设计观察为 v23.8.0；执行时记录实际 Node/OS/CPU/内存，先过 prepack，整对不可改变 |
| 候选起点 | Git `9503536`；tarball SHA-256 `cfab61d84d5fedd8a0eaa4627cf054778a77fc7152436eb251467b3abc7f1127` |
| 完整 dist | 34 文件；排序清单 SHA-256 `799151fdada17114c8c818431cddee7705bc882c4d044719d07439db6023e96b`；规范是每条 `relativePath + NUL + sha256 + newline`，路径字节序排序 |
| 模型 | provider=`opencode-go-muse`，model=`muse-spark-1.3-contributor`；每个 llm/stream 验实际和 effective effort=`minimal` |
| 容量 | 最近路由解析 C=1,048,576；执行前用宿主 `resolveModelInfo` 再验；变动需 revision，不能静默沿用 |
| 连接 | 复用 `~/.dsh/settings.yaml` 内已配置 provider；不复制明文 endpoint/key 到公开报告，不硬编码其他路由 |
| 私有设置 | 复用 `writePrivateSettings` 的原则；Basic 的摘要请求可能省略 effort，所以私有 provider 默认 reasoning 也要 minimal；禁用 session-title-llm |
| 隔离 | 每个 run 独立 DSH_HOME、profile、合成 cwd、port、日志目录；私有 settings 0600、目录 0700；`COREPACK_ENABLE_AUTO_PIN=0` |
| 原有 profile | 保留 `ctx-v012-smoke-c`、`ctx-v012-mini-native`；正式长程复制其合成配置到新专用 profile，不修改/删除原 profile 或日常 web/headless |
| ports | 主对 Basic 3341、ARC 3342；专项 3343；监控仅用本地文件或 127.0.0.1，不对外暴露服务 |

新 DSH_HOME 内 profile manifest 按 `tests/reliability/package-lifecycle.mjs` 的真实流程创建 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app` bundles。仅 ARC profile 添加本插件 bundle；Basic profile 不安装/加载它。所有 preset 均选择 standard；ptc/cordis/minimal 另作兼容性专项。

每次启动、重启、结束都记录：实际 PID/启动时间、可执行文件 realpath、host 包版本/哈希、全部 dist 清单、profile manifest/patch 哈希、settings 前后哈希、四个 shipped preset 文件哈希、provider 能力、实际工具清单、服务 backend 和 isolate 证据。私有含凭据文件只留权限受限副本或哈希；公开文件白名单导出。

安装必须使用含内容哈希的 tarball 文件名，并核对安装后完整 dist。上一轮同路径同版本覆盖 tarball 后 `plugin add` 曾保留旧 bridge；单比 dist/index.js 无法发现。不能把依赖管理器“Already up to date”当作构件相同。

## 4. 实验臂与预算几何

### 4.1 主对照：同压力的原生 Basic

主压力设为 **T=64,000**，兼顾多次换窗与默认后台摘要输入限制。它是人工设置的逻辑压力，不是 Muse 物理容量。

```text
C = 1,048,576（执行前实测确认）
R = 8,192   主请求实际输出上限
S = 4,096   安全余量
E = ceil(64,000 / 0.90) = 71,112
W = E + R + S = 83,400
ARC 准备线 = E × 0.60 = 42,667.2
ARC 提示线 = floor(E × 0.75) = 53,334
ARC 应急线 = floor(E × 0.90) = 64,000
ARC 目标保留压力 = E × 0.55 = 39,111.6（目标，不是硬保证）
Basic thresholdRatio = 64,000 / C，校验 floor(C × ratio) = 64,000
Basic retainRatio = 39,111.6 / C，校验 retainTokens = 39,111
```

浮点校准仅允许最小增量修正 floor；记录输入比例和宿主实际解析值。两者保留量取整差 <1 token，实际被保护的近期步骤可能让结果高于目标，应观测而非改写。Basic 默认 modelPolicies 若覆盖实验参数，应在私有测试覆盖层显式处理并记录，不得只看顶层 config。

`ARC_DEFERRED` 的 bridge `config` 载荷如下；它不是完整DSH patch，实际包装应复用 `cordis.patch.yml` 的 `compaction-context-management-bridge` / `dsh-context-management/bridge` 条目：

```yaml
adaptiveGovernor:
  enabled: true
  strategy: windowed
  windowBudgetTokens: 83400
  maxOutputTokens: 8192
  safetyMarginTokens: 4096
  nudgeAtEffectiveCapacityPct: 0.75
  emergencyAtEffectiveCapacityPct: 0.90
  targetAfterTurnoverPct: 0.55
  emergencyFallback: true
archive:
  seedMaxTokens: 4096
  retrievalDefaultMaxTokens: 2048
  retrievalMaxTokens: 4096
backgroundSummary:
  provider: opencode-go-muse
  model: muse-spark-1.3-contributor
  reasoningEffort: minimal
  allowSameProvider: true
  delivery: deferred
  prepareAtEffectiveCapacityPct: 0.60
  maxInputBytes: 262144
  maxSummaryBytes: 4096
  maxOutputTokens: 2048
  timeoutMs: 60000
```

这些是现有配置名。尤其 `archive.*Tokens` 在当前实现中约束多处 UTF-8 序列化**字节**，不能把 4096 宣传成实测 4096 模型 token；另外记录真实字节和 heuristic 估计。

`BASIC_MATCHED`：`auto=true`，上面的 thresholdRatio/retainRatio，摘要 `maxTokens=8192`；保留原生实现及 system prompt。主请求 R=8192，和 ARC 相同。不能给 Basic 安装 ARC 检索工具或让监督器替它读旧日志。Basic 自身保留追加式原始日志；区别在模型能用的能力，不是声称 Basic 没有原文。

两臂保留同一原生 pruner（8192/4096/1024 字符阈值/头/尾），同样的模型、一般任务工具、读页批量、材料、用户更新、工作代码与检查点。策略自身的工具、提示、摘要路由调用数量和内容不同，应明确报告，不声称只改变了一个算法变量。

### 4.2 其他条件的地位

| 条件 | 地位与执行规则 |
| --- | --- |
| `BASIC_DEFAULT` | 必做小型真实性检查：stock Basic auto、thresholdRatio=0.8、retainRatio=0.16、summary maxTokens=8192。主任务长度可能根本不触发它，不把零压缩当作匹配阈值对照。若要正式比较默认用户体验，另预注册一对同材料 `ARC_DEFERRED`/`BASIC_DEFAULT`，两 run 各≥3M；stock 压缩覆盖不足仍须保留 |
| `ARC_NO_BACKGROUND` | 用于归因等待/质量/成本的可选正式消融，与 ARC_DEFERRED 配对，各 run 仍≥3M；不得用短诊断声称质量收益来自后台摘要 |
| `ARC_IN_PLACE` | 原地遗忘/漏检索诊断，复用上一轮失败模式；不是主对照，不必把每个机制诊断扩成 3M |
| 更大逻辑窗口或 Muse 物理极限 | 独立扩展。T=128k 或原生 80% 可能使默认 maxInputBytes 无法准备摘要；先记录这种限制，不能偷偷放大摘要输入。真实物理溢出须单独确认确实触发，不靠逻辑压力代替 |

本 revision 的正式必跑范围是两对主实验，即四条≥3M run。额外正式臂未排入自动执行队列。短诊断仅作为机制覆盖，不计作完成一个“≥3M 正式组”。

## 5. 长程工作负载：可生成的规格

### 5.1 规模与内容

基础旅程 **24 episodes × 12 页 = 288 页**；每页目标 7000 Unicode code points，最大 7800，低于主实验 pruner 阈值。正文使用中英混合路径、日志、API/工作流片段与随机记录；每页至少 60% 是独立记录/约束/数据，不能以同句重复或单一 padding 串撑长度。每个实体值、trace、checksum、版本均由 hidden salt + seed 派生。

冻结前真实调用宿主 `heuristicTokens` 计量，基础旅程必须达到 500,000 独立源文本估计 token；若不能，P1 后整体增加所有正式 run 的固定基础页数并修订清单，不能在一臂里偷偷补噪声。页数是初始几何，500k 是实测门。当前旧 F3 的 288×7000 字符按其简化计数约504k，只是选取起点的依据。

生成最多 48 episodes 的同一承诺语料，基础之后每 **6 episodes** 为一个预定扩展块。全部材料、每个可能最终端点的 probe 清单，在首次正式调用前封存哈希。

### 5.2 每个 episode 的固定结构

| 位置 | 内容与执行 |
| --- | --- |
| 开始 | 用户给出本 episode 的工作目标、当前优先级、适用更新；不能由历史页伪装用户角色 |
| 页1–3 | 两个带来源的实体事实、一个精确路径/数值、一个日志事件及其前驱；权威内容与 suspected 线索显式区分 |
| 页4–6 | 新组件版本、跨旧 episode 的依赖、一次用户修订对应的旧材料；至少一个相似 ID/near-miss 干扰项 |
| 页7–9 | 只能在三项前置满足后执行的状态操作、微型代码接口/迁移说明、一个未获批准的替代方案 |
| 页10–12 | 独立 trace/checksum、分散的事件顺序末项、冲突记录及明确的生效/撤销语义；不汇总前面答案 |
| 工作步骤 | 完成该 episode 的小交付，或明确依赖尚未满足；读取批次最多6页/step，操作日志严格验证 |
| 结束 | 简短 `E_<n>_COMPLETE`；不要求为实验写答案总表。插件原生维护能力保持可用；模型若额外复述，保留原文并记录长尾再曝光 |

24 episodes 将状态演化、排障时间线、工作流/代码维护与旧证据需求交错出现，不划成几个互不相干的短会话。每 6 episodes 构成一个有实际产出的工作包：两个纯阅读/排障阶段、一个更正阶段、一个三文件代码变更阶段、一个依赖操作阶段、一个合并验证阶段。代码 fixture 文件名、允许导入和写入范围固定；最终历史盲测阶段关闭工作文件读取。

### 5.3 核心 oracle

- **48 个状态实体**：至少16个有两次更新，8个有撤销/恢复，12组相似 ID。更正是明确的新用户指令；最新有效版本以生效序和 authority 判定，不根据最后出现的普通历史文本判定。
- **24 条时间线/依赖关系**：至少8条跨≥6 episodes，4个三路 fan-in，4组互斥选项；最终输出完整有序数组。重点复现“事实正确但 eventOrder 为空”的失败。
- **48 个精确历史目标**：checksum、原文短句、路径与单位；至少12个位于第一季度、至少12个需从不同旧源拼接。不同源可以有相同文本，但 sourcePage/recordId 不同。
- **24 组存在性/歧义问题**：包括完全不存在、仅一字符之差、同短 ID 不同实体、仅存在于模型摘要中的回声。不存在必须相对于指定的有界原始来源集合定义。
- **24 个真实合成动作**：固定幂等键、前置条件和最终状态；不允许重复产生效果或提前执行。失败反馈不泄露隐藏答案。工作文件允许保存任务本身的代码状态，不允许建立通用历史备忘文件。

上述数量是基础24 episodes的下限；每个扩展episode继续新增至少2状态实体、1依赖、2精确目标、1存在/歧义候选和1动作，不能只增加填充页。每个可能端点 `N ∈ {24,30,36,42,48}` 分别封存96题及其来源分布；扩展后最近四分之一必须包含真正新增的目标。每桶6个状态题固定为2个最新用户更正、2个撤销/恢复、2个一般状态；前两类合为每端点固定16题的 `requiredLatestUser` 子集，要求全部正确。题ID采用 `N{N}-Q{001..096}`，oracle逐题存放类别、required标记、正确答案和依据，禁止运行后缩小分母。

摘要污染主实验只提供真实的冲突/过期/非权威源材料，再离线审计模型生成摘要。不能直接篡改 ARC 摘要伪造自然失败。人为插入错误摘要另列受控故障专项。

### 5.4 同步扩展与停止

两臂使用相同episode顺序，但各自连续推进、各自做episode检查，**不在每个episode后等另一臂**。只在共同候选端点N=24/30/36/42/48、需要决定是否共同扩展时，快的一臂在已完成turn的外部屏障等待，不向模型发送“等一等”。否则人为停顿会给后台摘要额外准备时间，污染自然隐藏等待的观察。

端点屏障单独计入 `schedulerBarrierMs`；记录在该期间ready/delivered的job及其后续消费。它们仍是合法策略输出，但不得算作被实际任务工作隐藏的等待。主实验中的自然等待指标优先使用端点屏障之前的工作片段；最终共同端点质量明确披露这一调度条件。

基础24 episodes完成后，若任一 run 的正常前台已核实用量仍不足3M，或共同语料的新材料门尚不足，整对从预承诺清单再执行6 episodes；另一臂即使已达3M也一起读相同材料。最多48 episodes。最终 probe 端点由这个确定规则选择，不由模型得分选择。到48仍不足，标 `COVERAGE_INCOMPLETE`，不能复读或靠摘要补数。

**不得仅因质量低、摘要未采用或窗口数量不理想而加长/换题**。这些是正式结果，专项诊断负责解释；若 pilot 连基本多窗几何都没有达到，应在正式开始前调整并冻结。任何一臂发生不可恢复错误，该 pair 不再新派发 episode；已派发调用按取消/结算协议处理，保留双方状态。

## 6. 多摘要和长尾探针

### 6.1 多窗/多摘要的真实定义

计数来源必须是 `compaction/summary` 元数据、共享事务完成及持久化 handoff receipt。分别记录：阈值检查、prune、in-place fallback、window commit、summary dispatch/ready/offered/delivered/unavailable。一次 `new_context` accepted 或一次 ready 状态都不是窗口/交付完成。

每条 ARC 正式 run 的目标：

- ≥12 个真实 window commits，其中≥8个由 pressure 路径触发；不能用手动命令凑数。
- ≥6 个持久化 delivered 摘要：operationId唯一、sourceHash两两不同、按派发顺序每份源集合至少含一个前面计数摘要未覆盖的原始event seq，且分布在至少6个交付窗口generation；后台同时仍最多1个job。
- 至少2份已交付摘要后来又进入归档；其receipt seq必须属于后续已提交archive block的源集合。来源图至少有一条包含3个不同历史处理节点的可重放路径，例如后期archive → 前期archive/replacement → delivered summary receipt → original event；元数据虚拟边和同一节点重复经过不计层数。每条边必须有实际source seq或持久化receipt依据，不要求所有摘要一起留在活动窗口。
- 最终盲测预先指定的12个长尾目标，其原始来源距ARC最终探针开始前≥6次真实window commits；记录原始距离和后续再曝光。两臂仍使用同一组目标，Basic单列其原生压缩距离，不能为它另抽更简单的题。
- pending跨窗、ready先于窗口、未使用预取、超预算、被新操作取代、取消/重启中断分别计数。不要求自然主任务必然出现每个时序；缺项由第11节专项补齐，不能把专项当作自然采用率。

### 6.2 共同盲题与 ARC 专有机制要分开

两臂接收**同样的问题和公开targetId/实体标识**，都按相同正确答案评分，包括逐字与存在性问题。题面不得泄漏oracle中的sourcePage、正确recordId或存在性；只有题意本来就是“给定某页求其checksum”时才可提供页号，且不得再把该题计入来源识别分母。每题冻结 `promptVisibleFields` 与 `scoredFields`，校验秘密字段没有进入请求。Basic没有检索工具，不能把它答不出的历史题改成N/A；只有cursor、blockId、handoff receipt等插件内部机制，对Basic记N/A。

最终每 run **96题**，按四个源位置桶各24题：基础/扩展最终端点 N 的最早四分之一、中前、中后、最近四分之一。每桶含6状态/更正、6精确原文、6来源/存在/歧义、6时间线/依赖题；另外验代码与动作交付。按原始页位置配对，按实际窗口距离 `{0,1–2,3–5,≥6}`、独立新材料距离和 lastExposure 事后分层。不能按某臂摘要是否包含答案重新抽题。

桶按原始页号 `floor((sourcePage-1)*4/(N*12))` 划分，不能在N=30/42时把episode四舍五入当成页四分位。长尾不存在题使用预声明、完全属于早期桶的有界原始来源集合；来源年龄取该集合最后一个源事件，而不是给不存在的答案虚构事件。

96题分成 **12个8题小批**，字段不重叠、不提供参考答案和正确性反馈。中期E6/E12/E18可各放一个不重叠的4题 sentinel，计为该轨迹的一部分；它们及相关事实不得再进入最终96题。每次检索结果/模型复述造成的再曝光都登记，不把后测当作未受前测影响的独立样本。

为防止前面的探针帮助后面的长尾题，每端点提前指定最早源桶的6个精确题＋6个来源/存在题为 `longTailRequiredIds`，放在最终前两批，使用互不重叠的来源页、实体及答案证据集合。若同一证据因sentinel、较早probe的请求/检索/回答而再曝光，该题 `probeClean=false`，共同96题总分仍保留，但不能冒充未经前测帮助的长尾样本。12个指定题须全部probeClean，否则长尾覆盖门不足；不得事后换题补齐。

产品自然生成/交付摘要、工作中主动回顾属于策略能力，不自动算探针污染，也不屏蔽其收益。另按最终探针前活动窗口中的 `summaryContainsAnswer / rawContainsAnswer / neither` 分层报告；严格未再曝光的原文检索子集若不足，只报未覆盖，不把“摘要成功保住答案”判成失败。这与探针自身泄漏是不同问题。

主轨迹上的最终探针使用自然任务措辞，允许模型自主决定等待、检索或直接作答。显式要求 `await_context` 的探针只能列为 guided mechanism。现有 `await_context` 参数为空，不存在 `operationId`/`timeout` 参数；操作归属由返回值和 observer 联结，不能设计虚构的工具调用。

### 6.3 防止答案与历史绕路

oracle、hidden salt、scorer、最终 probe 选取表位于驱动器私有目录，model cwd 内只放合成工作代码。主任务工具采用服务端白名单；所有 shell/通用文件/网络/委派入口默认拒绝，不能仅靠提示约束。读页只能访问当前已分配页号；probe 阶段页、代码、动作工具关闭，两臂的同类限制完全相同。安装的上下文工具保留原能力，不能屏蔽 `await_context` 或强制检索。

最终答案要求一个明确 JSON 对象；缺字段、空数组、null 和非法 JSON 保留为失败，评分器不得从多个对象中择优拼接。允许一个围栏包裹的完整 JSON；围栏外非空说明或多个候选 JSON 标 `FORMAT_FAILURE`，具体解析规则与 golden tests 一起冻结。

每页必须在 provider request objects 中实证完整曝光；“工具报告读过”不足。读漏页时，不由监督器偷偷补发答案或修改原评分。拒绝的绕路尝试记录为 `deniedAttempt`；只有成功越权/秘密进入请求才是 `INVALID_LEAKAGE`。模型调用被拒绝本身是任务遵循问题，不能与防护失效混为一谈。

## 7. 指标、验收与判断

### 7.1 硬完整性门：任何一次违反都阻止该候选通过

| ID | 断言 | 证据 |
| --- | --- | --- |
| I01 | 实际 host/route/effort/候选一致；无额外标题模型流 | 每次请求与启动身份 |
| I02 | 当前用户输入在对应决策时被保护；工具 call/result 配对未拆散 | 每次替换前后事件重放，不能只检查最终 surface |
| I03 | seq 单调追加，原始历史没有改写；相邻 summary/replacement 和 shared transaction 关联正确 | 完整 observer snapshot/JSONL；RPC只作辅助，不补号掩盖 gap |
| I04 | 原文分页还原与真实曝光的源文本逐字节一致，游标有界、无循环或静默漏项 | 所有存档 block 的最终离线审计；父源去重仍保留 seq 身份 |
| I05 | delivered 唯一、sourceHash正确、会话/路由/窗口关系正确；ready≠delivered；append不额外增加 generation | operation 账本＋持久化回执＋下一实际请求可见性 |
| I06 | 无跨会话内容/游标串用，无越权读oracle，无偷偷追加用户提示 | 工具访问、request objects、监督操作日志 |
| I07 | ARC取代原Basic同realm、原生命令消费者正确；Basic对照无ARC；minimal/第三方不误接管 | 上一轮契约回归＋本轮每次启动/恢复快照 |
| I08 | 取消/dispose无新的孤儿请求；重启已确认 durable 前缀不丢、不重复动作 | owner/launch/lease、事件和动作幂等收据 |

### 7.2 质量门（每条正式 run 单独判断）

- 最终96题至少87题正确（≥90%）；每个源位置桶≥20/24；固定16题 `requiredLatestUser` 子集16/16。
- 两臂共同的12题 `longTailRequiredIds` 至少10/12正确（≥80%）；ARC原始来源≥6窗且probeClean的覆盖条件另行核验，不能用总体高分抵消覆盖不足。
- 有序依赖、互斥选择、保护文件、动作最终状态：全部符合 oracle；动作零重复效果、零提前执行。
- 必填数组缺失或 `eventOrder=[]` 且oracle非空：最终交付失败，即使其他事实全对。
- 明确有界不存在题不得伪造存在，明确最新用户约束不得被旧摘要覆盖；各错误单列。
- Basic 与 ARC 共同题严格同分母。若 Basic 未过质量门仍保留，不以“原生没有工具”为由删题；也不要求两臂都通过才能报告 ARC 的可靠性事实。

两对正式样本只用于机制覆盖和逐对差异，不足以统计证明普遍优越或非劣。按 seed 报告每题型、每距离桶和整体差值；96道相关题不是96条独立长任务，不做伪独立显著性检验。不从两个 seed 的 bootstrap 退化区间宣称等价。若要总体效果推断，另预注册样本量/功效方案。

### 7.2a 覆盖与汇总状态的计算

共同覆盖 `commonCoveragePassed = tokenFloorMet && uniqueExposedSourceTokens>=500000 && allAssignedPagesFullyExposed && finalProbeCount==96 && plannedRestartVerified`。ARC另要求 `windowCommits>=12 && pressureWindowCommits>=8 && distinctDeliveredSourceCount>=6 && deliveryGenerationCount>=6 && rearchivedDeliveredReceiptCount>=2 && maxVerifiedSourceProcessingDepth>=3 && oldWindowLongTailCount==12 && probeCleanLongTailCount==12`；全部与共同覆盖相与，才是ARC的 `coveragePassed`。Basic要求共同覆盖、至少12次原生自动压缩、同12题probeClean；摘要层级/ARC窗口与receipt机制标NOT_APPLICABLE。

每项未知均不能当true。`integrityPassed`要求I01–I08适用断言都有证据且无违反；缺证据为null/INVALID_EVIDENCE，实证违反为false/FAILED_PRODUCT。`qualityPassed`按上述固定分母计算，漏答算错。`latencyTargetMet`只评价ARC预定目标，Basic保留实测值、该目标N/A。`reliabilityAccepted = executionCompleted && coveragePassed && integrityPassed && qualityPassed`，性能目标另列，不能以低延迟遮盖可靠性失败；未通过的Basic不否定ARC本身通过，但比较结论须同时呈现。

未完成/覆盖不足仍是必须封存的实验结果；不能当作候选验收通过。专项矩阵要求全部18项都有可追踪状态；关键完整性机制若NOT_EXERCISED，报告必须限定其尚未获得验证，不能宣称全方面通过。

### 7.3 等待和延迟

记录同一 host launch 内的单调时间以及 UTC；跨进程/重启不得直接相减单调时钟：

```text
t_prepare -> t_window_enter -> t_window_commit -> t_ready -> t_delivered
                    \-> 下一前台独立工作请求
t_dependency_enter ------------------------------> t_dependency_release
```

时间顺序允许 ready 在 window 之前或之后。`t_delivered` 是宿主已追加并确认的时间，不能取网络完成时间。记录下一模型请求是否真的含该 handoff，区分“已交付但任务结束未消费”。

- `boundaryMs`：压力路径 pre-step 从进入到返回的完整耗时；另分 prune/seed/事务/flush，不能只报索引构造耗时。
- `commitMs`：共享替换事务完整耗时；`nextForegroundDispatchMs`：边界进入至下一主请求派发，保留调度成本。
- `dependencyWaitMs`：真实调用 await_context 或真实所需历史依赖的等待；没有依赖时为0，不凭主观假设“换窗就需要摘要”。
- `overlapMs`：同一session前台/摘要 host stream生命周期交集；不是GPU并发证明，也不能等同全部隐藏等待。
- Basic 的原生摘要等待作为策略成本完整保留；ARC后台、未消费摘要和中断请求照样记账。

预设性能目标：ARC boundary p95≤1000 ms、max≤5000 ms；各run至少12个真实窗口，报告原始样本数，p95采用排序后第 `ceil(0.95*n)` 项。该目标失败记 `LATENCY_TARGET_MISSED` 并诊断磁盘/observer/归档大小，不混为数据丢失。与上一轮24–31ms不能直接比较不同规模。

端到端同时报告用户墙钟、模型调用时间、调度屏障、人工/监督暂停、恢复时间。两臂并发会竞争供应商资源；本主实验仅报告逐seed的时间/用量原值和配对差值，不设“比Basic更快/更便宜”的通过门，不从token数推出货币费用。若要因果性能主张，用另行预注册、按AB/BA交错的性能块，保留所有成本。

### 7.4 资源与长程增长

每5秒取样 host/driver/supervisor 的 RSS、CPU、事件循环滞后、磁盘增量；每次换窗记archive blocks、summary receipts、jobs、监听器和临时文件计数。最终至少观测前/中/后三个存档规模。

另外做无模型剂量测试：同一固定大小语料创建/销毁20个会话，显式GC后的第2–5轮与第17–20轮 retained heap 中位增量应≤`max(32MiB,基线20%)`，且job/listener计数回到基线。增长则标需调查，不把保留了更多真实历史导致的RSS增长直接叫泄漏。规模 `{1k,10k,50k}` 事件 × `{1,10,50}` 有效窗口按合法组合构造；读取/检索至少冷5次、热20次，p50/p95/max及取消响应分开报告。合成规模不计入3M或真实多窗门。

## 8. 执行阶段与集合点

| 阶段 | 内容 | 下一步条件 |
| --- | --- | --- |
| P0 工具与受控测试 | 实现第14节接口；回归/真实宿主无模型契约；计数/评分/lease/恢复/故障注入单测 | 所有完整性/监督基础门通过；无凭据泄漏 |
| P1 一对校准 | seed91561，两臂同短前缀；目标每臂0.2–0.8M，至少2次Basic压缩、2次ARC换窗和一次真实摘要交付 | 校准实际页长/压力/用量、有效effort、全局并发容量；不足先停下来修几何/工具，不能标已完成3M |
| G1 冻结 | 冻结正式语料、端点probe、oracle承诺、候选、所有工具/配置/评分器哈希 | 写 `review.json`：已读证据、问题、决定、下一pair ID |
| P2 正式第一对 | seed91601，两run按24+6扩展规则，各≥3M；一个逻辑session贯穿 | 全部终态、完整性和质量分开评分、离线审计与诊断完成 |
| G2 审阅 | 生命周期问题修复会产生新candidate；模型质量失败仍保留，可在无完整性阻断时继续第二seed | 不允许静默挑成功seed；新候选不得与旧结果混为同一组 |
| P3 正式第二对 | seed91602；交换主对启动先后，其他设计不变 | 同P2；四个run完整列入结果，包括失败/不足 |
| P4 专项补覆盖 | 第11节案例按未覆盖维度小步触发；一次最多一个真实故障，其余离线支线并行 | 必测案例有证据终态；未覆盖项明确保留 |
| G3 收敛 | 完整manifest/账本/评分/字节审计，双语报告与公开清洗数据 | 给出各维度通过、失败、覆盖不足；不统称全绿 |

每个正式 run 在 **E12已完成turn并flush后** 安排一次真实host重启；两臂同一episode，记录重启前后PID及durable前缀。这是预声明的恢复路径，若ARC有pending摘要，允许将其记为interrupted并恢复检索，不要求假装续接旧网络请求。完整旅程保持同一session ID；若重启必须新建session，只能记原run失败/不完整。

监督器崩溃、事务缝隙SIGKILL、恶意/超时摘要等，不叠加到正式自然质量路径，而在独立专项或源快照fork上进行。fork不能冒充额外独立seed，继承的usage不能再次充抵3M。

## 9. 全程监督：由进程保证，不依赖聊天窗口

### 9.1 三个所有者

- **driver**：只提交清单里的用户任务和操作控制，拥有prompt幂等日志；不自行规划下一seed。
- **supervisor**：独立进程读取事件/请求/压力/资源，维护状态机、报警、lease，按预先声明策略停止或恢复；不向会话注入“继续/总结/再试一次”。
- **coding agent**：检查每个集合点及异常，解释问题、审阅证据、选择允许的下一块，持续负责直到campaign明确终态。不能仅启动后台进程后把“仍在跑”当成完成。

并行委派采用明确最低够用配置：静态盘点/机械核对 luna/high；执行器/监督/文档 terra/medium；复杂协议或事务审查 astra/xhigh；整体设计与重型问题由主agent处理。执行代理与评分代理分工，评分不使用另一个LLM裁判。

### 9.2 状态机

```text
PLANNED -> PREFLIGHT -> READY -> RUNNING -> CHECKPOINT -> RUNNING
RUNNING -> WAIT_DEPENDENCY -> RUNNING
RUNNING -> PROVIDER_BACKOFF -> RUNNING / INFRA_INTERRUPTED
RUNNING -> RECOVERING -> RUNNING / FAILED_PRODUCT / INVALID_EVIDENCE
任一活跃态 -> STOP_REQUESTED -> DRAINING -> STOPPED
工作结束 -> AUDITING -> REVIEW_REQUIRED -> SEALED
```

后台job状态是与run状态正交的表，至少支持 pending/ready/delivering/delivered/unavailable/interrupted/未使用。run不能仅因job pending进入阻塞态。`WAIT_DEPENDENCY` 必须有真实tool/call、operation归属及对应的等待终结证据；可以通过检索先满足依赖，不强迫一定等待摘要。

### 9.3 心跳、期限与升级

| 项目 | 初始冻结值 | 行为 |
| --- | --- | --- |
| driver heartbeat / supervisor poll | 5s / 5s | 写小JSON，不重写整个历史；字段无变化也更新heartbeat |
| 人可读状态 | 30s | 输出episode、token下界、新页、窗口/摘要数、当前等待、最近进展；不刷屏完整原文 |
| agent说明 | ≤60s有实质进展/问题时更新 | 若只能后台运行，报告持久supervisor位置和终态读取方式；不是用聊天代替监控 |
| supervisor失联 | 15s告警，30s lease过期 | driver拒绝新prompt；在途调用允许到自己的期限，安全边界停住；恢复必须重获lease |
| host ready | 60s | 失败清理owned进程，标启动基础设施错误 |
| 前台/Basic摘要 | 首内容90s软告警，连续120s无内容软告警；单stream总420s硬上限 | 活跃不等于可无限延长；只按真正期限取消，不因没有新的session事件提前误杀 |
| ARC摘要 | 产品timeoutMs=60000，65s仍无终态升级诊断 | 正常timeout由产品转unavailable/fallback；不能因它超时直接取消独立前台 |
| await_context | 以当前job剩余deadline＋5s为正常等待上界，最多65s | 超界为生命周期调查；并非另加几分钟“摘要必须成功” |
| 单turn | 1800s | 超限先取消并收据确认，不提交补偿性新提示 |
| 单run | 6h工作时间＋最多30min已记录恢复/收尾 | 运维期限，不是token成本上限；到期样本明确不完整 |
| SIGTERM→SIGKILL | 10s | 只对校验PID/启动时间/launchId/profile的owned进程 |
| 磁盘 | 可用<5GiB暂停新阶段；<2GiB停止新请求 | 不删除旧失败释放空间；先封存和诊断 |
| host RSS | 2GiB软告警；4GiB持续30s请求停止 | 记录硬件能力；P1若不合适须在正式前修订，不中途单臂放宽 |

本地Mac运行时使用本任务PID拥有的 `caffeinate -i`，结束清理；记录系统睡眠/时钟跳跃。不把睡眠期间的单调/墙钟差解释成模型停顿。云端请求发生重试时记录供应商/传输错误，不归咎为插件失败；但恢复后历史损坏仍是独立完整性失败。

重试政策：适配器已有重试必须观测，监督器不得再叠加一层不明重试。确认为未派发或可安全重试的纯provider请求，最多3次attempt，退避5s、15s、尊重Retry-After最多60s；所有尝试计消耗。已派发prompt但结果不明，禁止盲重发；转第10节对账。路由/effort/构件错误、鉴权失败、数据完整性失败不自动重试。

摘要的请求purpose与job必须关联；不能沿用旧 `promptControlled()` 对“任意未完成请求统一取消整个会话”的分类。`incomplete-stream` 仅是观察结果，不能独自区分用户取消、网络失败、进程退出或产品异常。

## 10. 检查点、重启和幂等

每次派发prompt之前持久化 `logicalPromptId + requestId + contentHash + expectedEpisode + beforeSeq + dispatchState=planned`；使用这个requestId调用宿主，随后记录ack。driver崩溃后先读宿主事件/队列/已完成turn，再决定是否已接收；不能仅因本地没ack再发一次。若无法判定，终态为 `AMBIGUOUS_DISPATCH` 并停该run，不假装exactly-once。

在episode末、每个压缩/摘要回执、故障注入前后更新checkpoint。checkpoint是视图，append-only `supervisor-events.jsonl` 和宿主原始事件是事实来源；记录最后完整记录offset/hash，采用原子rename，明确flush/fsync边界。

```json
{
  "schemaVersion": 1,
  "runId": "<immutable-id>", "arm": "ARC_DEFERRED", "seed": 91601,
  "state": "CHECKPOINT", "episode": 12,
  "host": {"pid": 123, "launchId": "<uuid>", "startIdentity": "<verified>", "port": 3342},
  "session": {"id": "<id>", "lastObservedSeq": 900, "lastDurableSeq": 890, "prefixHash": "<sha256>"},
  "lastPrompt": {"logicalPromptId": "E12", "requestId": "<uuid>", "dispatchState": "completed"},
  "usage": {"foregroundVerifiedTokens": 1600000, "allReportedTokens": 1750000, "unknownUsageCalls": 1},
  "coverage": {"uniqueSourceTokens": 252000, "windows": 7, "deliveredSummaries": 3},
  "lease": {"owner": "<supervisor-id>", "expiresAt": "<UTC>"},
  "nextAction": "planned-host-restart", "timelineTailHash": "<sha256>"
}
```

示例数字不是门槛或真实结果。重启验证必须：旧PID确实退出、新PID不同；同session ID；已确认durable前缀逐事件/字节一致；队列与动作收据一致；重新解析原路由；服务域/工具不重不漏。最后观察到但未flush的事件不能冒称已durable；崩溃允许丢失未确认尾部，但要报告，不允许篡改已确认前缀。

进行中操作的幂等由合成操作工具的 durable receipt 保证，不能只用内存Set。模拟有副作用动作应先原子提交状态与幂等键，再返回结果；重复同键返回原receipt、不再产生效果。对只读工具可以恢复重试，但必须记录。

监督器重启优先重新附着现有host，不自动杀重建。锁文件须包含PID、启动时间、run/launchId；发现旧lock不能直接删除，更不能按模糊进程名kill日常dsh。未能证明归属时停止自己的执行并报告。

## 11. 专项覆盖矩阵

这些是必测案例类型，不是批量任务列表。先离线/受控组件，再对需要真实模型或Web的边界补一个短样本；一次最多一个故障。每行status必须是 `PASS / FAIL / NOT_EXERCISED / NOT_APPLICABLE / INVALID_EVIDENCE`，并指向具体证据。

| ID | 触发与步骤 | 验收、层级及对照 |
| --- | --- | --- |
| X01 | T−1/T/T+1，固定R，pruner解除/未解除压力，大结果＋Unicode | 真实宿主组件计量；不强制每次越T都window。主两臂同pruner；大结果单列，不给主语料静默截断 |
| X02 | 一个真实summary在窗口时pending，窗口后先执行只依赖当前输入的任务 | 独立任务不调用等待也可完成；job可稍后交付。真实Muse；若未遇pending，记未覆盖，转受控延迟专项 |
| X03 | 换窗后马上/隔2步/隔5步才出现旧事实依赖 | 分别记录等待/检索/直接答。guided子例显式调用无参数await_context，返回后下一pre-step交付；自然子例不提示工具名 |
| X04 | 真实Muse摘要流完成包被测试层延迟0/5/20s，正文不改 | 标注延迟注入，不能算供应商延迟或自然样本；验证等待不超过所需剩余时间、不会“没赶上窗口即失败” |
| X05 | 多份summary source重叠/旧revision，pending期间用户更正，再做一次换窗 | 最新用户优先；来源/路由/会话有效；无串窗错误、重复交付、把摘要回声当原文事实 |
| X06 | 无summary/超输入上限/输出超字节/空结果/超时/取消/预算拒绝 | 受控真实Harness；明确status和回退；独立工作继续。云端自然未出现的故障不能记作自然覆盖 |
| X07 | tool pairing未完成、用户steer、queued input、模型new_context accepted后又收到新输入 | 新窗口只在安全pre-step提交，current user/input和配对保护；新事件不被旧summary覆盖 |
| X08 | 缺失/歧义ID、跨session/cross-block/重启cursor、扫描上限、零命中与absent | session-local/bounded、incomplete明确、游标终止；Basic内部cursor机制N/A，共同回答题仍计分 |
| X09 | 旧摘要再归档、nested sources、相同文本不同seq、含图片/附件引用 | 全量可恢复文本字节与引用身份；缺附件显式不可用。真正多模态理解若当前路由未验证，列未覆盖，不发明图片内容 |
| X10 | 真实原生/ARC `/compact`，busy/cancel、`/context`状态/换窗、ptc/cordis/minimal | 原生命令归属、维护互斥、服务域、工具呈现；PTC至少执行一次通过run_code调用注册上下文工具，不能只有READY冒烟 |
| X11 | 已有agent启用、反复启停、晚加载Basic、外部Include重载/回滚、新config、无backend | 复跑15项reliability回归；用私有profile补实际Web切换。不得修改shipped preset文件 |
| X12 | pending时取消turn，summary完成后但未append时取消，交付后dispose | pending work有owner；无迟到跨会话追加；取消≠产品失败，无终态/孤儿请求才是问题 |
| X13 | 已flush边界重启、真实pending时重启、事务commit/flush缝隙SIGKILL | 前者真实Web；精确缝隙用受控宿主子进程。interrupted通知、原文可取回、不重复动作；不假称旧网络流复活 |
| X14 | driver/supervisor分别在planned/ack/receipt窗口崩溃重启 | 重新附着、lease过期停新工作、无重复prompt/动作；ambiguous明确终止 |
| X15 | provider 429/5xx、无首内容、传输中断、usage缺失/重复/错序 | 受控适配器验证分类/退避/计数；自然云端仅记录实际发生。不能为故障测试改成其他付费模型 |
| X16 | 两个隔离session含冲突实体/相同短ID，foreground+summary交错 | 全局最多3个stream，每session前台≤1/摘要≤1；没有内容、job、receipt、cursor串用 |
| X17 | 历史工具结果伪装system/新用户、旧摘要提出未获批准动作 | 保持历史数据权限；零禁止动作。真实模型短探针单列，不修改主摘要 |
| X18 | 长尾规模、20次创建销毁、检索取消、observer关闭对照 | 资源/延迟和监听器回收；测量开销有实证。不能把全历史JSON同步重写成本都归到引擎 |

每个专项只做到预声明数量：表中明确列出的适用变体各默认1个受控case，不是整行任选一个就PASS；聚合PASS要求所有必测适用变体都有通过证据。自然时序没命中，每种时序最多2个独立短尝试，随后记NOT_EXERCISED并用可控机制case补“机制层”覆盖。禁止重跑直到模型答对，禁止把某次summary ready误记为delivered。出厂Basic默认检查与本轮三臂短门并行归入P0/P4，不改变主对照。

## 12. 证据、账本与审计输出

输出根：`.test-runtime/longrun-20260915/<campaign>/<pair>/<arm>/<runId>/`。runId不可复用，目录存在即拒绝；正常和失败证据同等保留。

```text
campaign/plan.json, manifest.json, reviews/*.json, campaign-events.jsonl
private/oracle.json, hidden-salt, endpoint-probes/*.json
run/run.json                    不可变身份/全部配置/哈希/计划
run/checkpoint.json             当前可恢复视图
run/progress.json               小型状态，非事实替代品
run/supervisor-events.jsonl     状态、lease、操作意图和结果
run/alerts.jsonl                状态转移式报警与解除，去重
run/requests.jsonl              logicalRequestId/streamId/attemptId/purpose/时间/usage/终态
run/summary-jobs.jsonl          job/源范围/hash/window/ready/offered/delivered/取消
run/pressure.jsonl              before-prune/after-prune/after-commit/final-request
run/events/                    完整宿主事件JSONL＋分块检查点/hash
run/objects/<sha256>.json       请求内容寻址对象，不重复存全历史
run/control/                   分配页、曝光/消费、操作幂等receipts
run/host/                      启动/退出身份、受保护Web日志
run/recovery/, faults/          注入前后、durable前缀、恢复决策
run/resources.jsonl            CPU/RSS/loop lag/disk采样
run/audit.json, score.json      完整性与模型质量分离
run/result.json                全部维度终态、未覆盖和失败索引
```

请求最少字段：schemaVersion/runId/sessionId/launchId/logicalRequestId/streamId/attemptId或unknown/purpose/provider/model/effectiveEffort/maxTokens/contextWindow/系统及工具及消息hash/派发及首内容及终态时间/usage原值与归一规则/异常分类/计入哪类总额。

summary job最少字段：operationId/sessionId/sourceSeqs/sourceHash/sourceGeneration/targetGeneration/route/status/startedAt/readyAt/offeredAt/receiptSeq/deliveredAt/consumedByRequestId/terminationReason。**现有短日志不能可靠把每个job和LLM stream联结**；需在测试observer或测试用薄包装中记录显式关联，不能仅凭“时间很近”当唯一证明。包装不得改输入、返回或调度行为，且要有透明性测试。

审计按episode增量核对新事件和源曝光，最终对所有归档完整分页重放。保留原始日志尾部残片及offset；正在写入时可暂存未完成最后一行，终止后中间坏行/冲突seq不能忽略。独立评分器按冻结schema拒绝未知字段/重复ID/不可能的计数，公开结果只导出白名单聚合、哈希和错误类型，不含密钥、认证cookie或私有请求URL。

## 13. 需要交付的机器接口

以下接口**尚不存在**，是P0实现验收要求。主文档及JSON计划不是旧runner的参数文件。

```sh
# 以下命令需完成第14节实现后才能运行；不得用local-short偷偷替代。
export EXPERIMENT_DSH_BIN="$PWD/.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh"
REVIEW_ROOT=".test-runtime/longrun-20260915/lr3m-r1/reviews"
node tests/live/longrun/cli.mjs validate --plan docs/experiments/muse-longrun-v1.plan.json
node tests/live/longrun/cli.mjs prepare --plan docs/experiments/muse-longrun-v1.plan.json --campaign lr3m-r1
node tests/live/longrun/cli.mjs pilot --campaign lr3m-r1 --pair pilot-91561
node tests/live/longrun/cli.mjs review --campaign lr3m-r1 --pair pilot-91561 --decision accept --evidence "$REVIEW_ROOT/pilot-91561.json"
node tests/live/longrun/cli.mjs run-pair --campaign lr3m-r1 --pair main-91601
# 另一个终端可查看状态；run-pair本身等待本对终态。
node tests/live/longrun/cli.mjs status --campaign lr3m-r1 --json
node tests/live/longrun/cli.mjs audit --campaign lr3m-r1 --pair main-91601
node tests/live/longrun/cli.mjs review --campaign lr3m-r1 --pair main-91601 --decision accept --evidence "$REVIEW_ROOT/main-91601.json"
node tests/live/longrun/cli.mjs run-pair --campaign lr3m-r1 --pair main-91602
node tests/live/longrun/cli.mjs case --campaign lr3m-r1 --id X03 --variant guided-late
# 以下为恢复/停止的独立操作示例，不是正常序列的必做步骤。
node tests/live/longrun/supervise.mjs --campaign lr3m-r1 --pair main-91602
node tests/live/longrun/cli.mjs resume --campaign lr3m-r1 --pair main-91602
node tests/live/longrun/cli.mjs stop --campaign lr3m-r1 --pair main-91602 --reason "operator-requested-stop"
node tests/live/longrun/cli.mjs report --campaign lr3m-r1
```

`pilot`/`run-pair`只允许一个指定pair，要求有效supervisor lease才派发首个prompt；若没有当前pair的监督器，启动独立supervisor并等待READY，否则核验身份后附着。supervisor生命周期不得绑定driver崩溃退出；CLI前台运行至本对REVIEW_REQUIRED或终态。独立 `supervise` 用于恢复/附着，禁止生成第二个owner。上面展示的是接口，不表示在一个shell里把阻塞命令串行拼起来；review路径须先由审阅者写出真实证据。CLI不得提供默认“跑完所有seed”的批量按钮；后台调度最多两个run。

`review --decision accept` 的含义是证据已审阅、允许下一个预定块，不是把质量失败改成通过；必须引用结构化audit和问题处置。`report`在没有所有终态时输出interim，不得写completed。resume必须对账，不能简单重跑上次命令。

## 14. 实现工作包与现有代码映射

| 工作包/所有者 | 复用入口 | 必须新增或修正 | 独立验收 |
| --- | --- | --- | --- |
| W1 fixture/scorer，terra/medium | `tests/live/local/fixtures.mjs`, `scoring.mjs`, `fixture-tools.mjs` | 多episode、固定端点probe、hidden oracle、12批96题、动作durable幂等、受限代码工具；移除固定4阶段假设 | golden正确/错误/空数组/撤销/near-miss；模型权限负向测试 |
| W2 driver/checkpoint，terra/medium | `local-short.mjs`, `client.mjs`, `local/runtime.mjs`, `protocol.mjs` | 显式env/cwd/DSH_HOME/私有profile；24+6屏障扩展、幂等prompt、续跑、长程deadline、run身份 | 双run受控host、crash窗口对账、漏页不补假成功 |
| W3 observer/usage/supervisor，terra/medium | `request-observer.mjs`, `limits.mjs`, `request-client.mjs` | purpose分类、stream/job/attempt关联、递增计数、lease/告警、5s进展、资源监测、partial JSONL、独立进程 | 重复usage不翻倍；reservation不充抵3M；失联停新任务、正常pending不误杀 |
| W4 audit/independent review，astra/xhigh | `local-audit.mjs`, `cloud-gate-audit.mjs`, `handoff-audit.mjs`, `tests/reliability/*` | 动态episode/多次restart/多job/全dist身份、完整源图、跨会话、公平性复核 | 不依赖scorer的字节/receipt审计，故意破坏证据能被拒绝 |
| 主agent | 本协议＋JSON计划 | 集成、最难的事务/监督冲突、P0集合、pilot冻结、正式块监督与结论 | 不把支线PASS直接等同主实验通过 |

已核实限制：

- `local-short.mjs` 固定四阅读阶段；冷启动最多144页，probe fork最多1152页；25分钟整项、600s turn、420s request；固定实验profile。新任务不能靠增加一个`--pages`完成。
- `fixture-tools.mjs` 页最大7800 code points、探针阶段禁止外部读取；缓存/消费日志当前不是长期并发幂等事务。其原则可复用，不能直接当作长程工作流状态机。
- `request-observer.mjs` 能观测所有purpose、真实effort、内容hash和usage；但会同步写完整session快照。需改为增量/分块和安全点全量审计，避免观测成本随历史变成主要瓶颈；保留透明性与关闭observer的受控性能对照。
- `limits.mjs` 每次读全ledger、对未报告请求保守预留完整容量；适合小样本，不是3M完成证明。新计数需单写者/增量cursor与结束时全量复算。
- `promptControlled()` 不能可靠区分可选摘要与前台依赖等待、适配器重试和不明派发；必须按第9–10节重做分类。
- `cloud-gate-audit.mjs` 已有deferred receipt/source hash/stream overlap检查，但自然未覆盖job会留下partial classification；新审计必须保留这种诚实分类，不能改成“只要没报错就PASS”。
- `handoff-muse.mjs` 有guided独立/依赖实验，部分旧入口只比index hash；正式/专项统一全dist。`preset-coverage.mjs` 等旧脚本含全局dsh或旧路由，不直接执行。
- 当前wire observer有限制请求/响应体2MiB且clone流；长程不能无界clone全HTTP或输出认证头。使用可证明透明的有界元数据观测，缺失wire证据时保留unknown，不影响已独立验证的宿主流计数。

建议新增 `tests/live/longrun/{cli,driver,supervise,fixture,fixture-tools,scoring,observer,usage,checkpoint,audit,report}.mjs` 及对应有意义的单测。复用库抽取不得改变旧短实验默认行为。基础pinned-host/package路径可配置，但默认必须明确拒绝全局dsh和错误版本。

## 15. 实施顺序与最终验收清单

1. 读取AGENTS及本协议，记录当前dirty文件。设计时存在的未跟踪 `tests/live/local-probe-cloud-route.mjs` 属前序工作，未经归属核对不得覆盖/提交。
2. W1/W2/W3独立开发；W4并行做契约/公平性审查；在P0集合。尽早用受控host发现接口缺口，不能等长程跑到一半才补计数器。
3. 运行typecheck、单元/集成/reliability与新增longrun测试；如改engine，必须再跑既有三臂Web/model门。`npm pack`完整prepack、release audit及安装dist一致性不可跳过。
4. P1仅一对。根据实测冻结正式页长、每episode token分布、预测每run用量/时长/磁盘；此处可修订几何，必须保留原pilot失败。预算采用observe，不设置未经要求的低token熔断；操作次数/时间/资源仍有期限。
5. 运行91601；持续监控、episode检查、E12真实重启；最终12批probe与完整审计；G2讨论失败并记录处置，再运行91602。禁止后台自动跑一串seed。
6. 对自然轨迹未覆盖的专项分层补证。真正没有验证的条件列NOT_EXERCISED，包括多模态或物理溢出；不靠延时注入冒充自然时序。
7. 交付双语完整报告、白名单JSON、全部失败索引、下一步问题清单、安装构件哈希及复现命令。报告至少分别回答：服务替代、数据完整性、多摘要、长尾质量、自然/指导等待、资源增长、故障恢复、费用边界。
8. 停止所有owned实验host/supervisor/caffeinate，验证端口和子进程退出、settings/preset/daily profile哈希未变；保留专用profile和证据。发布npm由用户另行执行。

**收敛标准**：四条主run逐项报告3M与覆盖门，全部18项专项有可追踪状态；候选通过要求全部适用硬完整性门无未解决违反且有证据。模型质量或延迟未达标必须突出显示。没有完成的run或未覆盖的重要条件不能在汇总里消失。结果不足时完成的应是一份明确失败/不足的实验报告，而不是一句“所有测试通过”。

## 16. 可直接交给执行 agent 的任务文本

> 请实施并执行 `docs/EXPERIMENT-LONGRUN-3M.zh-CN.md` 和 `docs/experiments/muse-longrun-v1.plan.json` 的 muse-longrun-v1 协议。先读AGENTS、核对当前改动和候选身份；并行实现fixture/scorer、driver/recovery、observer/supervisor，在P0集合，再进行单对pilot、冻结、91601、审阅、91602及专项收敛。所有真实会话/摘要统一Muse minimal，固定DSH 0.1.2-rc.1，四条主run每条正常工作前台用量≥3M。不要调用旧大批量runner，不要修改日常profile，不要隐藏失败或用摘要/probe凑token。持续监督到明确终态：常规集合点由你审阅后推进，异常按协议停止、对账和修复；任何候选/协议变化保留先前失败并重新冻结。交付双语结果、清洗JSON、失败与未覆盖索引，清理owned进程并验证原配置不变。委派使用规定的最低够用模型配置，主agent负责整合与重型问题。
