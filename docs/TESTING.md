# v0.1.0 测试与发布验收

**本表保留获批的发布门槛；当前已执行算法、真实宿主集成、故障、规模和多轮真实 Web 候选测试。最终结论以新版发行报告及其 cohort 清单为准。** 历史宿主 smoke 与纯投影探针见 [VALIDATION.md](VALIDATION.md)。每项验收须记录测试版本、输入 fixture、实际输出与失败信息，不能只记“通过”。

## 1. 分层与硬门

| 门 | 覆盖 | 执行方式 | 发布条件 |
|---|---|---|---|
| G1 | 宿主、包与 bridge 前提 | 新依赖线上真实 Loader/Include/Group、存储 round-trip、tarball | 全通过 |
| G2 | 算法、记账、完整 seam | node:test + 安装宿主集成 | 全通过 |
| G3 | 换窗与检索的功能正确性 | 成对工具/消息 fixture + 真实 loop | 全通过 |
| G4 | 自动策略/无进展/overflow | 可控模拟 provider + 真实 Web 逻辑预算 | 全通过；物理 overflow 单列实测状态 |
| G5 | 恢复、安全、隔离、规模 | 故障注入、持久存储重放、对抗与性能 | 全通过 |
| G6 | 用户最小完整旅程与效果 | DSH Web + opencode-go/glm-5.3-flash + UI | 必须实际执行 |
| G7 | 发布产物与文档一致性 | npm ci/check/pack、全新 profile 安装卸载 | 全通过 |

测试不是照抄实现：通过最终 surface、实际 provider 请求、事件前缀、恢复后的语义与工具配对验证外部行为。历史 ARC 测试可移植，但 fixture 必须更新到宿主真实 nested tool-result 结构。

## 2. 确定性测试矩阵

| ID | 场景与刺激 | 必须观察到的结果 |
|---|---|---|
| I01 | official standard；create 后立即 prompt | 首请求之前实际 backend 已 active，Basic 不并存 |
| I02 | 两次 mount、两个 agent、正在接管时 dispose | 单一 owner；无迟到注册；每域回滚正确 |
| I03 | 第三方 compaction、未知 preset、缺 Include | 明确 unsupported/conflict，现 backend 与文件不变 |
| I04 | 接管第二阶段抛错、回滚部分抛错 | 尽力恢复 Basic；错误可见；不可用域不继续请求 |
| I05 | uninstall/HMR + 重启 | 注册清理，preset hash 相同，持久日志保留 |
| B01 | 宿主 projectedTokens 已扣3000 | 不二扣；与本次探针相同10000→7084，不是4084 |
| B02 | 连续压缩、压缩后 provider usage 更新 | 不减历史累计量，不负数钳零掩盖低估 |
| B03 | 有图片的节点 tokens != heuristicTokens | 决策看 route price，shadow 看 heuristic price，fold 与实际一致 |
| B04 | summary 后插入额外事件再 replace | 测试显式失败/检测协议破坏，生产代码禁止此顺序 |
| B05 | 路由从大窗切小窗、显式输出大预留 | 缓存失效，当前容量与R生效，不能继续按大窗请求 |
| B06 | P/B 在0.75、0.90边界；target与reserves非法 | 包含等号边界正确；每窗一次提醒；非法配置fail-fast |
| C01 | compress 多范围、重叠、第三段失败 | 顺序提交；早已成功段保留；结果逐段真实 |
| C02 | 单个工具结果、旧seq、不存在/异会话seq | 工具层安全恢复/唯一覆盖提示；假seq失败 |
| C03 | 官方 compactRegion 的不平衡区间 | 拒绝，不静默扩张；高seq在前的合法surface正常 |
| C04 | /compact idle、busy、输入排队、取消 | maintenance/FIFO/turn:null/sourceCommandId/flush 语义完整 |
| W01 | new_context 与其他工具同批调用 | 当时只accepted；全部结果配对后下一pre-step才换窗 |
| W02 | 同generation两次请求、取消、轮次结束 | 首requestId复用；取消不推进；无意外重启执行 |
| W03 | 工具已消费旧内容、连续3窗 | 每窗checkpoint有出处；旧seed不堆积；最新用户原文仍在 |
| W04 | 长handoff、空前缀、尾部独自超限 | 长参拒绝；无收益不推进；不循环冻结 |
| W05 | 换窗中用户steer/queued输入 | 输入不丢失/不重复，顺序与最新限制保持 |
| L01 | summary无replacement | 不计为已归档/新代际，不降低预算 |
| L02 | 每个append前后、end、flush处注入异常 | 按架构矩阵恢复；applied后不再当未应用fallback |
| L03 | kill后重启，含legacy shadow=0 | 原始前缀与surface可重建；旧显示估价不再次扣新投影 |
| L04 | Window无kernelBlockId，热/冷state对比 | 不合成伪bN；ARC block coverage与代际一致 |
| L05 | 未来schema、丢失seq、父循环、重复operation | 只读降级/incomplete；不虚构数据，不双计代际 |
| R01 | 原件独有词；ARC tier2/3；window套window | 可查到最终来源，不只命中父摘要 |
| R02 | pruner剪掉中段，随后换窗 | 中段独有词可回溯原件；否则如实incomplete |
| R03 | CJK/emoji/CRLF/空白/重复文本分页 | 正文分页拼接精确等于保存的text，不靠模糊包含判断 |
| R04 | 超预算块、ID前缀冲突、伪造cursor | 有界页/明确错误；不随意选首个block或跨会话读取 |
| R05 | 删除附件/spill fixture | 保留事件和缺失说明，不能“完整恢复” |
| S01 | 摘要/检索结果伪装系统指令或新用户请求 | 来源与历史边界保持；无新增权限/自动执行 |
| S02 | 两会话并发、fork继承后继续 | 不串pending、窗口/索引/cursor；fork按宿主可见范围 |
| O01 | fake provider给规范overflow，有一次可缩减前缀 | 至多一次插件恢复重试；必须有generation与P进展 |
| O02 | overflow无前缀、普通429/500、取消 | 不误归档，不无界重试；保留原始失败 |

生成性质测试覆盖任意合法 append/replace/prune 序列：原日志前缀不可变、surface 工具配对闭合、重放确定性、来源展开无重复/环、一次价格只扣一次。失败 seed 进入固定回归 fixture。

## 3. 故障注入与持久化

至少覆盖 start前/start后/summary后/replacement后/end后/flush后，以及进程强杀。在临时真实 DSH storage 中测试，不能只让内存 Session 重建就宣称磁盘安全。记录落盘 prefix 的最后 seq、是否存在完整 checkpoint、generation、锁状态和下一轮行为。

flush 失败后停止下一 provider 请求；恢复时如果磁盘没有 replacement，不能谎称窗口完成；如果有 replacement 但无end，不得重做同一换窗。宿主 recovery/end-seed 边界需用已安装版本实际代码与测试确认。

## 4. 真实 Web 旅程：指定模型，禁止隐式替代

所有有效样本实际路由必须是 **opencode-go / glm-5.3-flash**。selectModel 返回值只是意图；以 request/header.header.config 和 request/context 证明实际调用，另记录 assistant usage 与 turn/end。模型不可用就记失败，不切 scnet/DeepSeek/其他 GLM 来凑通过。

### 两种容量测试分开

- 逻辑预算：实际路由容量原样记录，插件设置windowBudgetTokens=32768、maxOutputTokens=8192、S=4096，B=20480。用足够长的合成真实工具输出触发nudge/emergency，降低开发成本。
- 真实容量：不设置人工逻辑窗口；记录provider声明容量、实际输入、输出上限与触发原因。本次路由报告1000000，仅证明该次请求的声明，不能硬编码为产品常量。

### 最小完整旅程

1. tarball安装测试profile，启动Web，完成认证；创建standard会话后立即选择指定模型与首条prompt，记录实际backend。
2. 种入12条合成工程事实，含路径、数值、CJK和两条后续更正；让模型读取固定fixture文件并产生可控工具结果。
3. 一组允许模型主动new_context；另一组指示专注任务、不提示压缩工具名，测试宿主是否可独立兜底。
4. 同一任务中至少连续两次换窗，第三轮用未在提问中泄露答案的ID查询早期事实；检查search/decompress来源和答案。
5. 请求恢复超过当前余量的档案，证明分页而非溢出；再正常完成任务。
6. 停掉此测试Web并重启、恢复同一Session，检索早期事实、继续修改目标，确认未遗忘最新用户更正。
7. 新建第二Session，尝试相同blockId/cursor，必须无法读到第一Session内容。
8. UI检查/context状态、/compact结果、换窗信息与错误可见性；卸载后重启，确认Basic恢复且preset文件hash不变。

主动指示模型使用工具的样本只证明工具可用；自然/忽略提醒的样本才验证自动策略。不得混在一项“自主压缩率”里。

### 三臂对照与判定

对照A原生Basic，B新包in-place，C默认windowed。相同合成事实、请求顺序、目标任务、路由、输出上限；只有策略差异。Basic阈值按其官方schema配置并记录effective值；若预算口径无法对齐，报告不完全可比，不做成本优劣结论。

开发阶段至少3个固定语料seed，每seed每臂3次独立Session，共27个样本。自动重跑不能悄悄丢弃失败样本。

| 指标 | 记录/门槛 |
|---|---|
| 日志/配对/越权/不可恢复错误 | 候选样本零容忍 |
| 存档正文恢复完整率 | 对所有可用合成text来源100%；与模型回答准确率分开 |
| 核心旅程完成 | C组9/9，均完成两次换窗、检索、重启续跑 |
| 最新更正保持 | C组9/9，不让旧摘要覆盖新要求 |
| 盲答事实准确率 | C组聚合>=90%，且不得低于同语料A组；这是样本门，不宣称统计普遍优越 |
| 代价 | 每次真实调用input/cacheRead/cacheWrite/output独立桶，调用次数、延迟、恢复与归档开销；不预先承诺节省比例 |
| 自动触发 | 记录模型主动与宿主自动次数；忽略nudge样本仍安全前进 |
| overflow | 规范化模拟必须通过；真实物理overflow未发生标NOT EXERCISED，不用逻辑预算冒充 |

未达到质量门时改设计或扩大诊断，不把默认策略悄悄改回in-place仍称windowed产品交付。27个样本是首发最小样本门，不足以宣称通用效果保证。

## 5. 性能、包与证据格式

规模fixture：至少100000事件、1000档案块、100窗链，在隔离子进程512MiB heap下测试。正常无变更pre-step不扫描全文；热检索p95<250ms、冷建<10s、取消响应<1s作为本机首发目标。机器/Node/输入字节数必须报告；未达目标先测瓶颈，不藏到“小数据通过”。

发布前：全新依赖安装、typecheck、单元/集成、build、pack文件清单、tarball安装、第一次请求、卸载、重启。运行时imports不得指向本机参考仓库或宿主内部lib路径。

每份插件验收JSON至少包含：schemaVersion、pluginVersion、pluginCommit、hostVersion、依赖锁hash、fixtureHash、seed/arm、requestedRoute/actualRoute、sessionId、时间、配置hash、输入/输出/缓存桶、窗口前后P/B、operationId/seq、completed、failures、incomplete、未执行项。公开证据只用合成数据，凭据和Cookie不得入库。

已提供 `npm run check`、`npm run test:integration`、`npm run test:live -- --help`、`npm run test:performance` 和 `npm run test:release`。`tests/live/cohort.mjs` 固定登记 9 个样本；`resume-cohort.mjs` 在真实服务器重启后续跑；`verify-history.ts` 对每个档案逐字拼接及每个实际请求检查配对。失败保留原报告和 cohort，修复后的新候选另立 cohort，不能覆盖旧样本。
