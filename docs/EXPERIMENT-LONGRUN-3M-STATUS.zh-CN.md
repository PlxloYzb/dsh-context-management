# 长程实验：结论与未决清单

[协议设计](EXPERIMENT-LONGRUN-3M.zh-CN.md) · [执行结果](EXPERIMENT-LONGRUN-3M-RESULT.zh-CN.md) · [返回首页](../README.md)

本页是 `muse-longrun-v2` 的**结论汇总**：证明了什么、**没证明什么**、以及每一项没证明的**具体原因和关闭条件**。表格由 `cases/` 里的机器记录生成，不是手抄。

## 一、已证明的结论

| 结论 | 证据 |
| --- | --- |
| 真实云端长旅程跑得通、可复现 | 4 个主 run，各 24 episode，种子 91601 / 91602 两对 |
| 前台用量远超 3M 下限 | ARC 10,668,743 / 13,446,795；Basic 17,377,940 / 21,970,909 |
| 独立来源覆盖过 500k 门 | 508,585 / 508,749 |
| 多窗多摘要 | 每臂 23–25 次真实换窗、23–25 份已交付摘要，来源哈希两两不同，0 重复、0 缺回执 |
| 硬完整性门 | **两臂、两对全部 8/8 PASS**（I01–I08） |
| 公共覆盖门 | 5/5（3M / 500k / 全 288 页 / 96 题 / 计划重启） |
| 质量可区分两臂 | **ARC 90/96 与 91/96**（过 87/96 门）对 **Basic 27/96 与 26/96** |
| 真实重启 | 计划内重启 `verified`，重启前后持久前缀逐字节一致 |
| 无二次复杂度 | 插件自身遍历：1k/10k/50k 事件 → 1.3/5.3/19.1ms（50 倍事件量约 15 倍耗时） |

## 二、专项矩阵（18 项 / 76 个声明变体）

变体合计：**35 PASS / 3 NOT_APPLICABLE / 38 NOT_EXERCISED**，0 FAIL、0 INVALID_EVIDENCE。

| 项 | 主题 | 通过 | 已通过变体 | 未执行变体 |
| --- | --- | --- | --- | --- |
| X01 | Threshold/pruner/Unicode | 3/4 | T-1、T、T+1 | — |
| X02 | Pending summary and independent work | 1/2 | natural-pending | controlled-delay |
| X03 | Immediate/delayed history dependency | 1/5 | immediate | two-step、five-step、guided-empty-await、guided-late |
| X04 | Controlled delivery delay | 3/3 | delay-0、delay-5、delay-20 | — |
| X05 | Overlapping sources and revision authority | 2/2 | overlap-pending-correction、stale-authority | — |
| X06 | Summary limits/failure/fallback | 1/7 | no-summary | input-limit、output-limit、empty、timeout、cancel、budget |
| X07 | Safe pre-step and current input | 1/4 | tool-pairing | steer、queued-input、accepted-then-input |
| X08 | Bounded retrieval and cursors | 4/4 | missing-id、ambiguous-id、cross-block、restart-cursor | — |
| X09 | Archive source graph and attachments | 2/4 | rearchived、same-bytes-distinct-seq | nested-sources、attachment-reference |
| X10 | Native commands and presets | 1/8 | standard | compact、context、busy、cancel、ptc、cordis、minimal |
| X11 | Replacement lifecycle | 1/6 | enable-existing | toggle、late-basic、include-reload、config-change、no-backend |
| X12 | Cancellation and disposal | 3/3 | pending-cancel、ready-before-append、delivered-before-dispose | — |
| X13 | Host restart and transaction crash | 2/3 | flushed-restart、pending-restart | commit-gap-sigkill |
| X14 | Driver/supervisor crash recovery | 2/3 | driver-crash、receipt-window-crash | supervisor-crash |
| X15 | Provider failure and usage accounting | 1/7 | usage-missing | 429、5xx、no-first-content、transport-loss |
| X16 | Two-session isolation | 1/2 | conflicting-ids | stream-cap |
| X17 | Untrusted history instructions | 2/3 | fake-system、fake-user | unapproved-summary-action |
| X18 | Scale/resources/observer overhead | 4/6 | create-dispose-20、scale-1k-1w、scale-10k-10w、scale-50k-50w | retrieval-cancel、observer-off |

**没有任何一项 18 个 case 达到全变体 PASS**；X04、X05、X12 已全通过。

## 三、未决清单（按原因分类）

### A. 缺受控装置（harness 缺口，34 项）

这些变体需要**注入或构造**一个长跑不会自然产生的场景，装置尚未实现。它们**不是**产品缺陷的证据，也**不能**读作通过。

| 项 | 未执行变体 | 关闭条件 |
| --- | --- | --- |
| X02 | controlled-delay | 受控交付延迟注入 |
| X03 | two-step、five-step、guided-empty-await、guided-late | 多步/引导式历史依赖构造 |
| X06 | input-limit、output-limit、empty、timeout、cancel、budget | 摘要失败分类的受控注入（形状已由七原因集成扫描覆盖） |
| X07 | steer、queued-input、accepted-then-input | 回合进行中转向与排队输入的构造 |
| X09 | nested-sources、attachment-reference | 嵌套来源与附件引用构造 |
| X10 | compact、context、busy、cancel、ptc、cordis、minimal | 原生命令与其余预设矩阵 |
| X11 | toggle、late-basic、include-reload、config-change、no-backend | 替换生命周期与回滚 |
| X13 | commit-gap-sigkill | 事务提交/刷盘之间的 SIGKILL 注入 |
| X14 | supervisor-crash | 监督进程租约期内被杀 |
| X16 | stream-cap | 全局流预算饱和 |
| X17 | unapproved-summary-action | 驱动模型尝试归档指令授权的动作 |
| X18 | retrieval-cancel、observer-off | 规模下取消检索、观测器关闭对比 |

### B. 需要供应商故障注入（4 项）

X15 的 `429`、`5xx`、`no-first-content`、`transport-loss`：需要一个**故障注入型 provider**。长跑期间真实遇到过一次请求超时（装置重试成功），但没有注入过这些类别。

### C. 不属于插件职责（3 项，已记 NOT_APPLICABLE）

- **X01 `large-result-unicode`**：多字节计数属于**宿主 token 计量器**，插件只消费 `heuristicTokens`，自己从不估算。
- **X15 `usage-duplicate`、`usage-reordered`**：用量分块累加属于**宿主计量器**，插件消费的是一份已完成的 `TokenMeasurement`。

拿宿主的正确性给插件记功就是虚报，所以它们记为不适用而非通过。

### D. 矩阵之外的未测量项

- **宿主层面的规模开销**：X18 只测了插件**自身**的遍历（进程内）。宿主会话内容经模型回合进入，5 万事件穿过真实宿主需要每事件一次模型调用，因此**宿主级规模开销仍未测量**。
- **400k 收尾数字**（28/35、17.1% strict）来自更早的工作，未在本次 0.1.7 宿主上重跑。
- **v1 协议在 0.1.2-rc.1 上**已被 v2 取代，不再复现。
- **桌面端 profile 安装**：按你的指示暂不进行（`docs/data/host-install-0.1.7.json` 记为 `desktopProfileInstall.done: false`）。

## 四、明确不主张的事

- **不主张"更快/更省"**：ARC 用了 Basic 61–65% 的前台 token，那是**单次观测**，不是效率结论。
- **不主张宿主级规模安全**：只证明了插件自身遍历无二次复杂度。
- **不主张 18 项专项通过**：无一项全变体通过。
- **不主张未执行项已通过**：38 个变体未执行，逐条列在上面。

## 五、这次实验暴露并逐条修掉的**工具链**缺陷

目标要求"记录每一次失败并逐条迭代修复"。产品侧没有发现新缺陷；**失败全部出在实验工具链自己身上**，共 **30 余项**，按性质分四类：

### 1. 让活动完全无法完成的（6 项）

| 缺陷 | 后果 |
| --- | --- |
| `ledger-probe.mjs` 引用未声明的 `done` | Basic 臂宿主动载即崩，该臂以 `fetch failed` 失败 |
| 编排器从不停止自己的监督进程 | 配对结束后 CLI **永不退出**，一直占租约与端口；三个失败尝试的编排器 30–40 分钟后仍在 |
| 0.1.7 的 `settings` 条目在无 `profileContext` 时禁用 | provider 从未注册，每次都死在 `no adapter registered` |
| 只读 `settings.yaml` | 宿主首次启动会改名，之后每次 PREFLIGHT 都 ENOENT |
| 预设定位写死 0.1.2 布局 | `No shipped preset definitions found` |
| 观察器要求已被移除的 `kind: 'plugin'` | 回执行一行都写不出，完整性门 I05 误报产品缺陷 |

### 2. 让证据失效或伪造证据的（7 项）

| 缺陷 | 后果 |
| --- | --- |
| 封存 oracle 只用 pilot 种子 | 正式配对答的是**另一个世界**的题，质量分数完全无效 |
| I05 按行而非按操作计数 | 3 个操作被报成 3 次重复 + 3 次缺回执 |
| I07 只读嵌套 tool-result 文本 | 0.1.7 是扁平块，合格的 `arc_status` 不被认作证据 |
| 全页暴露判定拿累计比单集 | 288 页全读却被判未读完 |
| 缺省答案被判格式违规 | 整批 96 题直接 0 分，两臂质量信号被抹掉 |
| 记录器携带 0.1.2 的数字 | 用昨天的数字断言今天的 run，即伪造证据 |
| `X18` 装置测的是记录器自己的堆 | 把装置测量当成插件覆盖 |

### 3. 破坏可恢复性与一致性的（8 项）

重试路径不可用（任何可重试失败都变成致命的 `PROMPT_ALREADY_PLANNED`，一次 420s 超时在 1430 万 token 处终结 Basic 臂）、请求上限落在服务端长尾内、`finalize` 不写终态、对端终态时屏障死等 6 小时、恢复的 run 丢失身份与端口、被 SIGTERM 的编排器泄漏宿主、先审计后评分导致覆盖结论自相矛盾、语料完整性校验因字段名错误**从未生效**。

### 4. 矩阵自身虚报覆盖的（4 项）

`recordCase` 接受未声明变体（拼错的 `useage-accounting` 被存进矩阵）；"全部未执行"聚合为 PARTIAL；把对照探针写进声明变体槽位，覆盖了该变体原本的证据；**一个不能因自己原因失败的延迟用例被写出后删除**。

**结论：30 余项失败全部记录、逐条修复，其中 20 余项配了判别性用例**（撤掉修复即失败）。产品侧在同一批实验里**未发现新缺陷**——包括最初看起来像产品缺陷的 I05（实为观察器谓词过时）。
