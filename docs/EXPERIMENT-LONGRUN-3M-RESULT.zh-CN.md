# 长程压力实验执行结果（muse-longrun-v2）

[协议设计](EXPERIMENT-LONGRUN-3M.zh-CN.md) · [v1 机器计划](experiments/muse-longrun-v1.plan.json) · [v2 机器计划](experiments/muse-longrun-v2.plan.json) · [返回首页](../README.md)

本页记录 `muse-longrun-v2` 的**首次真实执行**。设计文档仍是规范；本页只报告实际跑出来的东西，并明确区分"已建立""未通过""未覆盖"。

**这次执行没有发现新的产品缺陷；它发现并修掉了 13 个实验工具自身的缺陷，其中 6 个会让长程活动无法完成、或让证据失效。** 产品侧在已执行到的范围内表现正确：两个 run 各 24 个 episode、23 次真实换窗、23 份后台摘要交付、一次真实重启，**硬完整性门 8/8 全过**。质量门两臂同为 21/96，但该结果**无效**（oracle 与语料 id 空间不一致）。

## 最终结果
## 第二个正式配对：结果可复现

协议把这一步命名为 `P3_SECOND_PAIR`，并在 `G2_REVIEW` 上要求先评审第一对。第一对已评审接受（结构化证据 `reviews/main-91601.evidence.json`，criteria 全真），第二对在**同一 campaign、不同种子 91602** 上跑完 24 个 episode。

| | 第一对（种子 91601） | 第二对（种子 91602） |
| --- | --- | --- |
| ARC 前台核实用量 | 10,668,743 | 13,446,795 |
| Basic 前台核实用量 | 17,377,940 | 21,970,909 |
| ARC 独立来源 token | 508,585 | 508,749 |
| **ARC 96 题** | **90/96 ✅** | **91/96 ✅** |
| **Basic 96 题** | **27/96 ❌** | **26/96 ❌** |
| ARC 硬完整性门 | 8/8 | 8/8 |
| ARC 专有覆盖门 | 7/8（长尾 11/12） | **8/8（长尾 12/12）** |
| ARC 换窗 / Basic 压缩 | 23 / 68 | 23 / 102 |

**结论在第二个种子上复现**：ARC 90–91/96 对原生 Basic 26–27/96，差距约 64 题；第二对的 ARC 还首次把**全部 8 项专有覆盖门**跑通（长尾 12/12），这也顺带解决了第一对那一题的保留条件——在**干净会话**里同一类歧义题答对了。

四个主 run 合计约 **6350 万**前台 token（10.67M + 17.38M + 13.45M + 21.97M）。


两个主 run 全部跑完 24 个 episode、真实重启、12 批 96 题最终 probe，并通过独立审计。

| 指标 | ARC_DEFERRED | BASIC_MATCHED（同压力原生 Basic 对照） |
| --- | --- | --- |
| 前台核实用量 | **10,668,743** | 17,377,940 |
| 全部可核实用量 | 13,850,017 | 22,740,129 |
| 独立来源 token | **508,585**（门 ≥500,000） | 508,585 |
| 硬完整性门 I01–I08 | **8/8 PASS** | **8/8 PASS** |
| 公共覆盖门（3M / 500k / 全页 / 96 题 / 重启） | 5/5 PASS | 5/5 PASS |
| ARC 专有覆盖门 | **7/8 通过**；唯一未过是长尾 11/12（见下） | 不适用 |
| 真实换窗 / 原生压缩次数 | 23 次换窗 | 68 次压缩 |
| 96 题质量（重问后） | **90/96，`qualityPassed: true`**（门 87/96） | **27/96，`qualityPassed: false`** |
| 长尾 | `longTailPassed: true`，`probeCleanLongTailCount` **11** | `longTailPassed: false`，5 |
| 分项 | state 0/24、exact 0/24、ambiguity 21/24、timeline 0/24 | 完全相同 |
| `executionCompleted` | true | true |

**三条要点：**

1. **产品通过了全部硬完整性门。** 23 次换窗的窗口链、23 份摘要的交付回执与消费、受保护系统头、工具配对、跨会话隔离、后端自证全部无违反。这是本次执行最扎实的正面结论。
2. **质量门：根因定位、修复、重问，得到第一次有效测量——ARC 90/96 对原生 Basic 27/96。** 第一版 21/96 是无效证据，根因是**封存 oracle 用了 pilot 种子（91561），而正式配对跑的是 91601**：封存 `N24.json` 的 96 个题目标识全部属于 91561 的语料（96/96 命中），与 91601 一个都不匹配（0/96）。模型读过的 576 页里根本没有题面标识，每题都不可答；它按字面量检索、插件**如实**回报 `absent: true`（33 次都是真实缺失），于是答空——21 题"对"只是"一律答不存在"策略的基线。

   修复后 `loadSealedOracle`、`scoreRun`、哨兵题都从**该 run 自己的语料**派生 oracle（盐 + 配对种子，语料清单哈希仍按封存记录校验），并**重问了正确的 96 题**（原答案不可救——它们是回答给错误题目的）。结果：

   | 分项 | ARC_DEFERRED | BASIC_MATCHED |
   | --- | --- | --- |
   | state | **21/24** | 1/24 |
   | exact | **24/24** | 3/24 |
   | source_existence_ambiguity | 21/24 | 21/24 |
   | timeline_dependency | **24/24** | 2/24 |
   | **合计** | **90/96（过门 87/96）** | **27/96** |
   | 长尾 | `longTailPassed: true`，probeClean 长尾 **11** | `false`，5 |

   同一条 24 episode 旅程、同一套题、同一个模型，插件臂答对 90 题、原生 Basic 答对 27 题，而插件臂只用了 **61% 的前台 token**。这是整个实验第一次**有效**的质量测量，也是迄今最强的产品证据。

3. **ARC 的覆盖门：7/8 通过，唯一未过是长尾 11/12。** 上一轮报告"4 项覆盖门未达成、S2/S3 从未发生"是**错的**——那 4 个门读的是 `progress.coverage.<字段> ?? 0`，而**没有任何代码写过这些字段**，所以 ARC 的覆盖门在结构上永远不可能满足，一个真实存在 25 层血统链、24 次再归档的旅程被报成 0。改为从**观测到的块血统**推导后：

   | ARC 覆盖观测 | 实测 | 门 | 结果 |
   | --- | --- | --- | --- |
   | windowCommits | 25 | ≥12 | ✅ |
   | pressureWindowCommits | 25 | ≥8 | ✅ |
   | distinctDeliveredSourceCount | 25 | ≥6 | ✅ |
   | deliveryGenerationCount | 25 | ≥6 | ✅ |
   | rearchivedDeliveredReceiptCount | **24** | ≥2 | ✅ |
   | maxVerifiedSourceProcessingDepth | **25** | ≥3 | ✅ |
   | oldWindowLongTailCount | **19** | ≥12 | ✅ |
   | probeCleanLongTailCount | **11** | ≥12 | ❌ |

   所以 **S2（旧摘要被再次压缩）确实发生了**：每一次换窗都会再归档上一个已交付的块，24 次；血统深度 25 远超要求的 3；六个最近窗口之外仍有 19 个块。**唯一真实的缺口是长尾 12 题里答对 11 题**——差一题（N24-Q015，一个"两个实体共享短标识、判断哪个是权威"的歧义题，插件臂答了"不存在"）。**这一题需带一个保留条件**：重问是在**同一个会话**里进行的，而该会话历史里仍留有第一次（无效）probe 的题目文本；实测模型检索的是 `S371ab`——那是**旧题**里的标识，不在语料中。用真实盐重跑可答性检查确认**两个种子的 96 题全部可答（0 处问题）**，因此这一题的失败可能受历史污染，**不能确证为产品缺陷**；要彻底排除需要一次干净会话的测量。

   同时，可答性检查已**前移到 `prepare`**：封存 oracle 之前逐题校验，任何"题目引用了语料里不存在的内容"都会让 prepare 直接失败（`ORACLE_UNANSWERABLE`）。这条守卫必须放在 prepare，因为真实盐按 campaign 生成，单元测试无法覆盖它。BASIC 臂的覆盖门全过，因为那 8 项对它不适用。

**成本观察（不是效率主张）**：同一条 24 episode 旅程，ARC 的前台用量是原生 Basic 的 61%（10.67M vs 17.38M），而质量分数相同。这与历史结论一致——不能据此声称"更快/更便宜"，只能记录这一次的用量。

## 为什么需要 v2

v1 把宿主冻结在 `0.1.2-rc.1`。产品已移到 0.1.7 预发布系列，而那个宿主的形状变了三处（预设改由 web-app bundle 以 `<id>.patch.yml` 提供；profile 必须显式声明 `packageManager`；pin 可能只持有一个 `dsh` 符号链接），并且每次请求的不可压缩基线更大，压力几何必须重新推导而不是继承。因此新增 `muse-longrun-v2`：同协议、同 96 题 oracle、同 18 项专项，改宿主与几何，并显式声明 8 条压力条件（S1–S8）——**设计目标是暴露缺陷，不是展示成功**。

几何不是猜的：先在 144 页 / F3 / batch 12 上二分压力地板。

| 压力 | 结果 |
| --- | --- |
| 45000 | `CONTEXT_BUDGET_EXHAUSTED`，保留 58619 > 物理 54096，尚无归档 |
| 60000 | `CONTEXT_BUDGET_EXHAUSTED`，保留 84675 > 物理 70763，1 次就地回退 |
| 90000 | 通过：`strictPassed`，facts 24/24，verbatim 3/3，6 次压缩 |

取 **80000**——刚好在地板之上，使每次长程必须扛住大量真实换窗，而不是一两次。

## 实验工具自身暴露并修复的 8 个缺陷

这是本次执行最有价值的产出。前三个会让活动完全无法完成。

| # | 缺陷 | 后果 | 修复 |
| --- | --- | --- | --- |
| 1 | `ledger-probe.mjs` 引用未声明的 `done` | Basic 臂宿主动载即崩（`ReferenceError: done is not defined`），该臂以 `fetch failed` 失败 | 删掉残留判据；同时把硬编码的 chunk 名换成整份 dist 清单哈希 |
| 2 | 配对编排器从不停止自己的监督进程 | 监督进程带管道 stdio 且长期运行，配对结束后编排器**永不退出**，一直占着租约与端口；三个失败尝试留下的编排器 30–40 分钟后仍在运行 | 新增 `releaseSupervisor`，并加一个"撤掉 SIGTERM 就失败"的用例 |
| 3 | provider 从未注册 | 0.1.7 的 `settings` bundle 条目在没有 `profileContext` 时是禁用的（只有 Electron 应用会提供），CLI 启动的 profile 因此读不到 settings，每次都死在 `no adapter registered for provider "opencode-go-muse"` | 从同一份私有 settings 取出 `llm-pi-ai` 段内联进该臂的 patch；只有 `apiKeyEnv` 名称流动，没有密钥 |
| 4 | 只读 `settings.yaml` | 宿主首次启动会把该文件改名为 `settings.yaml.imported`，之后每次运行都在 PREFLIGHT 以 ENOENT 失败 | 容忍宿主留下的那个文件 |
| 5 | 预设定位写死 0.1.2 布局 | `No shipped preset definitions found for host 0.1.7-rc.1` | 按布局查找；bundle 自带的那份只做哈希证据、不再复制（复制出来的并不是宿主实际读的文件） |
| 6 | 观察器要求 `kind: 'plugin'` | 0.1.7 移除了这个通用 source kind，回执行因此**一行都写不出来**，完整性门 I05 报"已交付摘要缺回执" | 接受 `context-management`（插件在 0.1.7 声明的 kind），保留 0.1.2 拼写 |
| 7 | pin 写死、profile 缺 `packageManager` | 无法指向 0.1.7；且 corepack 会解析到只提供 `pnpm.mjs` 的版本，插件安装失败 | 单一解析入口 + 按宿主版本决定是否声明 `packageManager` |
| 8 | 后端证据靠运气 | I07 要求从证据证明生效后端，而模型可能整场都不调用 `arc_status`，门只能拒绝通过 | 开场一次有界的后端自证回合（要求调用一次 `arc_status`），使该门可判定 |
| 9 | 重试路径不可用 | `plan()` 对任何已存在的 id 都抛错，于是**任何一次可重试的失败都变成致命的 `PROMPT_ALREADY_PLANNED`**：一次 420s 请求超时在 1430 万 token 处终结了 Basic 臂 | 只有 `failed` 的上一次尝试可重规划；歧义状态保持粘性；新增判别性用例 |
| 10 | 请求超时太紧 | 420s 上限正好落在实测的服务端长尾（150k 迭代记录 356–624s）内 | 请求上限提到与回合上限一致（600s），一次慢尾变成可重试而不是致命 |
| 11 | 终止状态没写回 | `finalize` 只写 `terminalReason` 不写 `state`，失败的 run 永远显示 RUNNING；配合下一条把对端锁死在屏障上 | `finalize` 明确写入终态 |
| 12 | 对端终态时屏障死等 | 对端已终态就永远不会到达该端点，等待却按 6 小时工作期限空转 | 屏障检测对端终态并记录"未配对"，不再挂起 |
| 13 | 恢复的 run 丢失身份与端口 | 恢复的 Driver 没带 `campaign`/`pairId`，最终 probe 无法定位封存 oracle；被 SIGTERM 的编排器泄漏宿主进程，端口被占导致 `loopback Web launch URL unavailable` | 传入并回退读取 run 记录里的身份；恢复前回收本 run 自己记录在案的宿主进程，并清除陈旧的终态字段 |

审计侧另有 3 个会把正确行为误判为产品缺陷的记账缺陷，一并修掉：

| # | 缺陷 | 后果 | 修复 |
| --- | --- | --- | --- |
| 14 | I05 按行而非按操作计数 | 同一操作的 `termination` 行会重复 `status: 'delivered'` 且无 `receiptSeq`，于是 3 个操作被报成 `duplicateOperation: 3, missingReceipt: 3` | 只统计 `receipt` 行并按 operationId 归并；重复=同一操作有两份回执 |
| 15 | I07 只读嵌套 tool-result 文本 | 0.1.7 的 tool result 是扁平 `{type:'text',text}` 块，文本取成空串，合格的 `arc_status` 结果不被认作证据 | 同时读扁平与嵌套两种形态 |
| 16 | 全页暴露判定拿累计比单集 | `assignedPages` 是单集值、`exposedPages` 是累计值，288 页全读却被判未读完 | 与分配**上界**比较；I04 独立拒绝越界读取 |
| 17 | 缺省答案被当成格式违规 | 模型回答 `{"present": false, "recordId": null}`（题目自己给出的"查不到"形态）被判 `SCHEMA_VIOLATION`，**整批 96 题直接 0 分**——两个臂都是 0/96，质量信号被完全抹掉 | `present:false` 且 `recordId:null` 记为**答错**而非格式违规；只有"声称存在却不给 id"才算畸形 |

**第 6 项特别值得记下**：它一开始看起来像产品缺陷——"已交付的摘要在没有持久回执的情况下被标记为 delivered"，正好命中协议最核心的交付契约。逐行核对回执行后确认是观察器用了 0.1.2 的 source 谓词，**产品侧无违反**。这正是"先分清是产品还是工具"的价值。

## 产品侧：已建立的事实

- **多窗链条正确**：23 份窗口块，22 份带 `parentBlockIds` 父链，`windowIdentity` 的代数链连续（生成 0 → 23）。
- **摘要交付契约成立**：23 份已交付，来源哈希两两不同；每份都有整数 `receiptSeq` 并被后续前台请求实际消费（`consumed` 23 / `unconsumed` 0）。**没有重复交付，没有缺回执。**
- **受保护系统头未被改写**：全程仅 1 个 `system/message`，与 0.1.7 的"节点 0 只能被恰好覆盖它的 system/message 改写"约束一致。
- **重启恢复**：episode 12 后的真实重启 `verified: true`，前后哈希一致、无重复 prompt、无重复替换。
- **工具配对**：371/371，零悬空。
- **后端自证**：`arc_status` 返回 `{"backend":{"status":"active","resolvedBackend":"dsh-context-management"}}`。

## 未通过 / 未覆盖（不得读成通过）

- **S2「旧摘要再次压缩（tier 2/3）」未发生**：23 份摘要 `tier` 全为 1，`tier 2/3` 计数为 0；该几何下窗口推进直接遮蔽旧种子，**从未对活的摘要节点再次压缩**。就地应急回退全程 0 次。
- **`decompress` 未被调用**，`search_context` 仅 2 次——长尾检索能力**在这条轨迹上没有真正被压到**。
- **真实供应商物理溢出未触发**；受控 loop 溢出测试不能替代。
- **中途 steer 未注入**：队列输入（`agent/inbox/spliced` 194 次）是自然发生的，但"回合进行中转向"没有构造。
- **`ask_user_question` 被模型调用 1 次**：该工具本不该出现在实验会话里。它没有破坏这条轨迹，但这是工具面收窄的缺口。
- **最终 96 题评分、12 批 probe、18 项专项**的状态以报告末尾的账本为准；未执行的项按 NOT_EXERCISED 记录，不写成通过。

## 成本与几何的现实约束

实测（2 episode pilot）：ARC 每 episode 约 58 万前台 token，Basic 约 67 万；12 页约 21,159 个独立来源 token。因此：

- 3M 下限约 **6 个 episode** 就满足；
- 500k 独立来源覆盖门需要 **24 个 episode**（协议的最小正式端点）。

两个门在不同 episode 数上满足，正式 run 必然大幅超出 token 下限（本次 24 episode ≈ 10.7M）。v1 计划的四个主 run 按此实测约需 **6400 万**前台 token，故 v2 把正式范围缩减为**一对（两个 run）**并记录在计划里——缩减是明写的，不是隐藏的。

## 复现

```sh
# 需要已配置的 Muse 路由与隔离 HOME
ISO="$PWD/.test-runtime/isolated-home"
export HOME="$ISO" DSH_HOME="$ISO/.dsh" EXPERIMENT_HOST_PIN=dsh-0.1.7-rc.1

node tests/live/longrun/cli.mjs validate --plan docs/experiments/muse-longrun-v2.plan.json
node tests/live/longrun/cli.mjs prepare  --plan docs/experiments/muse-longrun-v2.plan.json --campaign <id>
node tests/live/longrun/cli.mjs pilot    --campaign <id> --pair pilot-91561 --episodes 2
node tests/live/longrun/cli.mjs run-pair --campaign <id> --pair main-91601
node tests/live/longrun/cli.mjs status   --campaign <id>
```

原始证据在被 Git 忽略的 `.test-runtime/longrun-20260915/<campaign>/` 下，含逐请求观测、用量账本、摘要任务账本、压力轨迹与独立审计。

## 专项矩阵（P4_DIAGNOSTICS）

18 个专项（X01–X18）此前**从未启动**：没有任何 campaign 有 `cases/` 目录，配对运行器也从不调用专项运行器。打开之后，从各 run 自己的 audit/progress/账本读数，得到：

| 状态 | 数量 | 说明 |
| --- | --- | --- |
| PARTIAL | 7 | 部分变体有真实证据（X02/X03/X07/X08/X09/X10/X11/X13/X16） |
| NOT_EXERCISED | 11 | 无受控实现，或前置条件从未发生 |
| PASS | **0** | 每个 case 都还有未执行的声明变体，因此没有任何 case 能记 PASS |

几个真实的读数：**X08 有界检索**为 PARTIAL——110 次检索、269 次命中、29 次零命中、26 次确认缺失，其中 **3 次触到扫描预算并返回了 `nextCursor`，而游标被续用 0 次**（续用路径被提供、从未被走）；**X09 再归档**为 PARTIAL——再归档本身已被证明（24 次、血统深 25），但附件与嵌套来源变体未跑；**X07 工具配对**为 PASS 变体（0 悬空）但 `steer` 未注入。

打开这一步同时暴露了三处**会把证据写成不成立的说法**的缺陷：

- 记录器携带的是 **0.1.2 campaign 的数字**（672 次工具调用、"后台摘要从未交付"、"没有任何已交付摘要再次进入归档"）——对这两个 run **全部为假**：25 份摘要已交付、24 份已交付回执被再归档、0 次工具悬空。用昨天的数字断言今天的 run，就是伪造证据。
- `X18/create-dispose-20` 曾以 PASS 记录，而 `measureCreateDispose` 是在**记录器自己的进程**里分配 Map 并采样自身堆——它**从不加载插件**，不能算插件覆盖。现记为 NOT_EXERCISED 并写明理由。
- `recordCase` 接受任意变体名，一个拼错的 `useage-accounting` 被存进了从未声明它的矩阵；且"所有声明变体都是 NOT_EXERCISED"会聚合为 PARTIAL，让一个**完全没碰过的 case 看起来被部分覆盖**。两者都已修正，并加了判别性用例。

专项矩阵仍需一个**真实宿主驱动的剂量装置**；现有的两个"实现"测的是装置，不是插件。

### 第一个真实宿主驱动的专项：X08 检索契约

专项需要**带真实归档的会话**，所以探针重开一个已完成的 ARC 旅程——它检索的归档就是长跑真正建起来的那个——要求模型发三次 `search_context` 调用并回传逐字结果。**模型只是工具调用的传输层，断言针对的是工具返回了什么。**

| 探针 | 查询 | 命中 | 扫描预算 | 游标 |
| --- | --- | --- | --- | --- |
| missing-id | `ZZZ-NOT-IN-ARCHIVE-9f3c2b` | 0 | 触顶 | 有 |
| ambiguous-id | `short=d4ba` | **2** | 触顶 | 有 |
| unique-id（对照） | `short=2847` | 1 | 未触顶 | 无 |

**检索契约两条都成立**：被两个不同记录共用的标识**返回两条命中**而不是静默选一个；归档不可能包含的字面量**没有被宣告为"不存在"**——扫描触到预算上限，工具如实说明并交回 `nextCursor`，而不是声称一个它并未建立的缺失。`missing-id` 与 `ambiguous-id` 因此在真实证据上 PASS，X08 达到 2/5 声明变体（PARTIAL）。

修这个用例本身也踩了两个坑，都值得记下：判定器原本在拼接后的记录里找"某个带 hits 键的对象"，于是三次探针全被归到第一个结果，另外两次看起来是空的；它还把"不可命中的字面量必须 `absent: true`"当成期望，**把工具正确而保守的行为判成了失败**——截断的扫描可以声明自己未完成，完成的扫描才可以声明缺失，而沉默两者都不是。已加判别性用例覆盖这四种情况。

#### 游标路径：第一次被真正走通

这是最值得做的一个探针，因为**游标续用路径从未被走过**——两个正式配对合计有 3 次检索触到扫描预算并交回 `nextCursor`，而它被续用 **0 次**。"提供了却从未被走"正是缺陷最容易藏身的地方。

| 步骤 | 调用 | 结果 |
| --- | --- | --- |
| first | `{"query":"short=","limit":5}` | 5 条命中 + `nextCursor` |
| resumed | `{"query":"short=","limit":5,"cursor":C1}` | **5 条不同的命中**，success |
| misused | `{"query":"role=user-correction","cursor":C1}` | **status error（拒绝）** |
| bogus | `{"query":"short=","cursor":"not-a-real-cursor"}` | **status error（拒绝）** |

四项行为全部正确：续用**前进**而不是循环或重发首页命中；把游标用于**另一个查询**被拒绝，而不是静默按原查询作答；非法游标被拒绝。X08 因此达到 **3/5 声明变体**。

判定器修了两次，两次都是**把正确行为判成失败**：它要求续用页必须带 `scanBudgetReached` 或 `absent`，而下一页合法地两者都不带（`scanBudgetReached` 描述的是扫描预算，不是分页）；它还把"跨查询游标被拒绝"当成问题，而**拒绝正是契约本身**。

#### 跨重启的游标：被显式拒绝，而不是静默为空

游标语义的最后一个分支。在**真实重启**（已按持久前缀校验）之前取一个游标，重启后用它续用。插件**拒绝**了它，并说明原因：

```json
{"status":"error","code":"invalid-cursor",
 "recovery":"Restart the query without cursor. Cursors are session-scoped, bounded, and invalidated by restart or eviction."}
```

这是**符合契约**的结果。被禁止的失败是**静默返回空页**——那与"真的不存在"无法区分；而这里游标被**点名作废**，带机器可读的错误码与恢复指引。`restart-cursor` 因此 PASS，X08 达到 **4/5 声明变体**。

判定器现在由探针与用例共享，且判的是**显式性而非成功**：带原因被拒绝、或带真实命中被接受，都算正确；重启未校验或缺游标则整个探针作废；**不声明缺失的空页**判失败。

#### X01 T-1/T/T+1：压到边界的那一 token

这是矩阵里唯一的**数值边界**专项，也是差一错误最容易藏身的地方：长跑证明了插件在**远超**压力线时正确，却从未坐在那条线上。插件自己拥有的两处精确比较，此前都没有被夹住边界：

| 调用 | 结果 |
| --- | --- |
| `governorCapacity(1000, 预留 800 + 余量 200)` | `CONTEXT_INVALID_CONFIG`（恰好无输入预算 → 拒绝） |
| `governorCapacity(1001, …)` | `effectiveInputLimit === 1`（多一个 token 的窗口 → 恰好可行） |
| `governorCapacity(999, …)` | `CONTEXT_INVALID_CONFIG` |
| `governorCapacity(1_000_000, …)` | `effectiveInputLimit === 999000`（精确算术） |
| `assertEnvelopeFits(4096, 4096)` | **接受**（恰好装下必须允许） |
| `assertEnvelopeFits(4095, 4096)` | 接受 |
| `assertEnvelopeFits(4097, 4096)` | `context-envelope-too-large` |
| `assertEnvelopeFits(null, 4096)` | 接受（没有测量值不算信封问题） |

**两处边界都正确。** 原有的 governor 用例只覆盖了明显不可能的配置，而 `assertEnvelopeFits` 的比较**完全没有单元覆盖**——它的失败形态是"对一条恰好装得下的路由报出 `CONTEXT_ENVELOPE_TOO_LARGE`"，安静到足以长期隐藏。

两个用例都验证过**判别性**：把 `>` 改成 `>=`、把 `<= 0` 改成 `< 0` 即失败。（第一次我用了 `<= 0` → `< 1`，那是**同一个谓词**，什么也没证明。）

`large-result-unicode` 记为 `NOT_APPLICABLE` 而不是通过：多字节计数属于**宿主 token 计量器**，插件只消费 `heuristicTokens`、自己从不估算 token。X01 因此 **3/4 声明变体**。

#### X12：取消早已被验证，缺的是"所有权"的另一半

X12 之所以在未验证清单上，是因为**长跑从未走到它**。但去查真正覆盖它的那道门之后：**待交付期间取消**由确定性集成门覆盖了**七种原因**（late、cancelled、disposed、timeout、oversize、failed、invalid-output），并断言了四件要紧的事——终止原因被记录且**后来的取消无法抹掉**、供应商请求信号被中止、**迟到完成无法追加到会话**（seq 不变）、账本里**恰好剩一个块**。所以这个 case 是**被验证过的，只是在另一道门里**；诚实的记录应该写明是哪一道。

真正缺的是**反方向的所有权边界**。契约说"取消与处置拥有**待处理**工作"，它的推论——**不得销毁已经到达终态的成果**——此前没有用例。已补上：处置会停掉待交付任务并记录原因，而**已消费的回执跨处置保留其状态与操作 id**，因为抹掉它就等于静默丢弃用户已经付过费的成果。该用例有判别性：把 `consumed` 加进 `active()` 即失败。

**X12 是矩阵里第一个达到 PASS 的 case（3/3）。**

#### X15：畸形用量从未被喂过——八种坏读数全部被拒

整个 campaign 的 `unknownUsageCalls` 全程为 **0**，所以这条分支**从未被喂过**。它要紧是因为**投影直接喂给压力门**：`NaN` 与 `-1` 对任何阈值都比较为假，一旦被信任，压缩就**再也不会触发**，而上下文继续增长——**一个不产生任何错误的缺陷**。

插件把八种坏读数全部拒掉：`NaN`、`Infinity`、`-Infinity`、`-1`、数字字符串、`null`、`undefined`、对象——每一种都退化为 `meter-conservative`，按计量器总量定价。同时：

- 一个**格式良好**的投影仍被采用（说明这道守卫不是"一律拒绝"）；
- **过期测量**（`logRevision != session.seq`）按名字抛错；
- **负信封被钳到 0**，不会透传。

两道守卫都有**判别性**：去掉有限性检查、或去掉钳位，用例即失败。

`usage-duplicate` / `usage-reordered` 记为 `NOT_APPLICABLE` 而不是通过：**分块累加是宿主 token 计量器的职责**，插件消费的是一份已完成的 `TokenMeasurement`，自己从不累加增量。四个供应商失败变体保持 `NOT_EXERCISED`——长跑里真实遇到过一次请求超时并由装置重试，但这些类别没有注入过。X15 因此 **1/7**。

#### X09：来源身份是**按序位**的，不是按内容的

再归档路径会把存下的 `hash` 与 `sourceHash(session, seqs)` 比较，用来判断来源是否变了。**如果身份是按内容的**，两个持有**相同字节**的不同来源会哈希相同，于是它们之间真实发生的变化会被读成"未变化"——**陈旧性检测会静默接受一份用错来源构建的摘要**。

实测是**按序位**的：

| 断言 | 结果 |
| --- | --- |
| 相同载荷、不同序位 | 哈希**不同** |
| 同一范围的两种顺序 | 哈希**不同** |
| 同一范围重复计算 | 哈希**稳定** |

用例有**判别性**：把"对事件"改成"对事件的 `data`"（即按内容）即失败。长跑里这种条件被**大量制造**过——24 份已交付回执在 25 层血统上再归档，所以这正是它们实际依赖的不变量。

X09 因此 **2/4**（`rearchived` ✅、`same-bytes-distinct-seq` ✅；`nested-sources`、`attachment-reference` 未构造）。
