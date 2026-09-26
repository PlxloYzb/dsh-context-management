# 长程压力实验执行结果（muse-longrun-v2）

[协议设计](EXPERIMENT-LONGRUN-3M.zh-CN.md) · [v1 机器计划](experiments/muse-longrun-v1.plan.json) · [v2 机器计划](experiments/muse-longrun-v2.plan.json) · [返回首页](../README.md)

本页记录 `muse-longrun-v2` 的**首次真实执行**。设计文档仍是规范；本页只报告实际跑出来的东西，并明确区分"已建立""未通过""未覆盖"。

**这次执行没有发现新的产品缺陷；它发现并修掉了 13 个实验工具自身的缺陷，其中 6 个会让长程活动无法完成、或让证据失效。** 产品侧在已执行到的范围内表现正确：两个 run 各 24 个 episode、23 次真实换窗、23 份后台摘要交付、一次真实重启，**硬完整性门 8/8 全过**。质量门两臂同为 21/96，但该结果**无效**（oracle 与语料 id 空间不一致）。

## 最终结果

两个主 run 全部跑完 24 个 episode、真实重启、12 批 96 题最终 probe，并通过独立审计。

| 指标 | ARC_DEFERRED | BASIC_MATCHED（同压力原生 Basic 对照） |
| --- | --- | --- |
| 前台核实用量 | **10,668,743** | 17,377,940 |
| 全部可核实用量 | 13,850,017 | 22,740,129 |
| 独立来源 token | **508,585**（门 ≥500,000） | 508,585 |
| 硬完整性门 I01–I08 | **8/8 PASS** | **8/8 PASS** |
| 公共覆盖门（3M / 500k / 全页 / 96 题 / 重启） | 5/5 PASS | 5/5 PASS |
| ARC 专有覆盖门 | **4 项未达成**（见下） | 不适用 |
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

3. **ARC 的覆盖门有 4 项未达成**：`rearchivedDeliveredReceiptCount`、`maxVerifiedSourceProcessingDepth`、`oldWindowLongTailCount`、`probeCleanLongTailCount` 全为 0。它们对应的正是"旧摘要被再次压缩（tier 2/3）"与"跨六个以上窗口的长尾检索"——**这两条压力条件在这条轨迹上没有发生**。BASIC 臂的覆盖门全过，因为那 4 项对它不适用。

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
