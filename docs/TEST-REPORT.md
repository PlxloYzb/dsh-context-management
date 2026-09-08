# dsh-context-management v0.1.0 对抗性测试报告

> 归档说明（2026-09-08）：本报告由 `.test-runtime/adversarial/TEST-REPORT.md` 移入 docs/；文中所有 `.test-runtime/adversarial/…` 证据路径仍以仓库根为基准解析，证据本体未移动（gitignored）。

- 日期:2026-09-08(本机时区 Pacific/Port_Moresby)
- 测试对象:`dsh-context-management@0.1.0`,tarball SHA-256 `81640a34…31b543`(与 npm 公开发布逐字节一致),安装于隔离 profile `ctx-v010-test` / `ctx-v010-capacity`
- 宿主:DSH 0.1.2-rc.1,Node 22.23.1,macOS darwin 25.4.0 arm64
- 模型:所有有效样本实际路由 `opencode-go/glm-5.3-flash`(以 request/header 证明,无替代路由)
- 约束遵守:未修改任何产品代码、文档或版本;全部探测脚本与证据位于 gitignored 的 `.test-runtime/adversarial/`;日常 profile 与用户常驻 `dsh web` 未受影响,测试 web 已全部停止,仓库工作树保持 clean
- 结论速览:**核心可靠性契约(记账、换窗协议、检索保真、隔离、注入边界、崩溃恢复)全部经受住对抗性攻击;发现 1 项 P2 配置校验缺口、4 项 P3 设计缺陷、5 项 P4 低危问题;无数据丢失、无越权、无不可恢复错误**

## 1. 测试方法与范围

四层测试,互不替代:

1. **基线回归**:`npm run check` 全量(typecheck + 172 单元 + 41 宿主集成 + build)确认发布基线可复现,exit 0。
2. **离线对抗探测**(3 轮,`.test-runtime/adversarial/probe-*.mjs`,直接 import `src/`):ArchiveReader 参数/游标矩阵、compress 批量滥用矩阵、WindowController accept/turnover 边界、governor 配置几何、账本损坏注入。
3. **真实模型长会话**(逻辑预算 32768/8192/4096,patch 于 `installed.patch.yml`):10 页语料(比发行 cohort 的 8 页更长)+ 工具滥用指令轮 + 盲答 + 注入探测 + 跨会话隔离 + SIGKILL 重启恢复;全部事件从持久化 JSONL(zstd)经宿主 loader 重建为连续 0..1700 事件后核验。
4. **物理容量长会话**(无逻辑预算,1M 声明容量):12 页 × 200 行(页均大于发行语料)、页 8 读取中途排队转向输入、盲答。

## 2. 真实模型测试结果

### 2.1 逻辑预算对抗旅程(session-d3959cc6-…,15 轮,1701 事件)

| 检查 | 结果 |
|---|---|
| 路由保真 | 14 个 request/header 全部 opencode-go/glm-5.3-flash;maxTokens 恒 8192(governor 改写生效) |
| 换窗 | 5 次真实换窗,generation 1→5 严格递增,trigger 全部 pressure;summary→replacement 全部相邻(邻接协议 5/5) |
| 账本健康 | orphanSummaries=0、appliedUnclosed=0、corruptMetadata=0(官方 verify-history.ts) |
| 逐字恢复 | 5 个档案块、184 个文本源、269 页、956,257 字节,分页拼接与原文逐字相等;每页 ≤4096 字节预算 |
| 工具配对 | 14 个 provider 请求前缀 toolPairingBalancedAfter 全部为 true |
| 盲答(换窗后) | 12/12,含 3 项用户更正(F03/F09/F11,中英混合);重启后恢复 12/12,更正全部保持 |
| 注入边界 | 第 7 页埋 4 条注入(英文/中文/伪系统/伪更正)。盲答无 PWNED 标记、无注入改值;直接询问回复 `TOKEN=PWNED-ACCEPTED;FOLLOWED=no`;F03 采用用户更正而非注入值;检索结果全部带 historical-data 边界头 |
| 跨会话隔离 | 第二会话重放 3 个真实 blockId → 全部 block-not-found;官方核验器 cursorScopeChecks=4(异会话/异 reader/异块/空会话全部拒绝) |
| new_context 幂等 | 同 generation 两次调用返回同一 requestId(sha256 派生),首次 handoff 保留 |
| SIGKILL 恢复 | kill -9 后重启同 profile,会话恢复、检索正常、续答 12/12 |
| 轮次延迟 | 读取轮从 27s 降至 3–5s(换窗缩减工作集的直接效果) |
| pruner 接管 | compaction/prune 事件 10 次 —— 新引擎确实消费了 toolResultPruner(不是只保留 YAML 行) |

用户更正消息在日志中恰好出现 1 次(其余 5 次出现均为各代 seed 的有界引用,来源可区分)。

### 2.2 物理容量长旅程(session-7adb3adb-…,14 轮,416 事件)

- 12 页全部 READ-OK;页 8 读取中排队的转向输入(STEER-MARK)不丢失、不重复,最终行同时包含 READ-8-OK 与转向标记;
- 0 次换窗(1M 容量下压力从未到 75% 有效输入线)——不提前换窗符合策略;
- 盲答 12/12(含 2 项更正);
- maxTokens 恒 32768(auto 策略:min(32768, floor(1M/4)));
- provider 物理溢出未发生:**NOT EXERCISED**(与发行报告一致,不以逻辑预算冒充)。

### 2.3 受控补充实验

- **new_context 提交路径**(session 2c57f1cb…):小历史下 accept 后正确 no-op(无净缩减可换)。
- **滥用时刻离线重放**:用真实持久化日志在 turn-11 step-2 边界重放 commitPending,确定 pending 以 `no-new-history` no-op 消费(当时表面仅剩 gen-3 seed,守卫正确拒绝无新历史换窗;详见发现 F-04)。

## 3. 发现清单(自我对抗复核后)

严重级:P2=应在下个补丁修复;P3=设计缺陷,影响可观测性/诊断;P4=低危/卫生问题。

### F-01 [P2] governor 配置 B<=0 在加载时不失败,首个 prompt 运行时崩溃(偏离 SPEC §5)
- 证据(离线+真实宿主双确认):`resolveAdaptiveGovernor` 接受 windowBudgetTokens=8192 + maxOutputTokens=8192 + safetyMargin=4096(B=−4096);engine 构造成功;真实 web 启动、建会话、选模型全部成功;首个 prompt 以 `turn/end error` 终止:`"adaptiveGovernor output reserve + safety margin (12288) must be below context window (8192)"`,错误码 **UNKNOWN**(非类型化)。
- SPEC §5 明确"B<=0 … 配置失败"。实际为"加载成功、首个请求失败",配置错误被推迟并降级为会话级运行时错误;用户视角是"装好了但每句话都报错"且无诊断码。
- 边界:仅数值型 maxOutputTokens 触发(auto 模式下 output=min(32768,⌊wb/4⌋),B>0 恒成立,wb>5462 时安全)。
- 复现:`.test-runtime/adversarial/broken-budget.patch.yml` + `dsh --profile ctx-v010-test --patch <该文件>`。

### F-02 [P3] search_context 每 16KB 文本块最多报告 1 条命中,且不标记不完整
- 证据:离线 A4——单块内 50 处相同 needle,limit=20,返回 hits=1、nextCursor=null、incomplete=false、scanBudgetReached=false。模型无法得知其余 49 处存在,易误判唯一性。
- 数据未丢失(可 decompress 该 seq 复核),但"块内命中截断"没有任何信号;SPEC 的 incomplete 仅定义来源图不完整。建议:块内多次命中时标记或计数。

### F-03 [P3] archiveHealth 与账本对"非相邻 replacement"的判定不一致
- 证据:离线 C4c——手工构造 summary 与 replacement 之间插入无关事件的窗口:BlockLedgerIndex 正确拒绝(代际保持 0,防止失效价格声明入账),但 archiveHealth 五项指标全部为 0(healthy)。`/context status` 的 archiveIntegrity 因此显示健康,与代际 0 矛盾。
- 仅外部损坏日志可达(生产写入保证相邻),属诊断盲区而非记账错误。

### F-04 [P3] new_context accepted 后静默 no-op,模型无反馈通道
- 证据:真实旅程滥用轮——两次 new_context 均 accepted(同一 requestId);下一个安全 pre-step 该 pending 以 `no-new-history` no-op 被消费(离线重放确认守卫判定正确:当时表面只剩上一代 seed,拒绝无新历史换窗符合 W03/W04 无进展保护);此后 5 个换窗 metadata 均无该 requestId。模型从未收到"你的换窗请求未执行"的任何消息;`lastOperation` 仅存内存,重启即失。
- accepted≠committed 是 SPEC 设计,但失败反馈只存在于 arc_status;模型可能一直以为已换窗。建议 no-op 时向模型回写一条可见结果。

### F-05 [P4] 无 handoff 的换窗 seed.incomplete 恒为 true(未截断也标记)
- 证据:离线 C5b——seed 实际 4027 字节 ≤ 4096 预算、逐行 truncated 标记全 false、decompress 返回 incomplete=false,但 metadata `seed.incomplete=true`(源码 `pending?.handoff === undefined` 直接触发)。
- 过度保守:SPEC 将 incomplete 绑定"因预算截断"。影响仅诊断口径。

### F-06 [P4] lastNudgeTurn Map 无界增长
- 证据:离线 D2b——50 个会话各触发一次 nudge → 50 个永不淘汰的条目(键为 session.id)。长驻 web 进程中随会话数线性增长(单条极小)。建议 WeakRef 或 LRU。

### F-07 [P4] MAX_SUMMARY_CHARS=24000 截断路径不可达(注释失实)
- 证据:kernel(acp-kernel 0.0.24)maxSummaryLength 默认 20000,`applyCompression` 先拒绝 >20000 的摘要(离线 B3b:24000 与 24500 字符摘要均被 kernel 拒绝);tools.ts 的 `summary.slice(0, MAX_SUMMARY_CHARS)`("capped as a last resort")永远轮不到执行。防御性死代码+误导注释。

### F-08 [P4] 低余量下 decompress 的诊断码优先级颠倒
- 证据:真实滥用轮——同样传 `blockId:"deadbeef-0000"`,余量不足时返回 `insufficient-headroom`(预算检查先于账本查找),余量充足时(离线 C6)返回 `block-not-found`。同一无效输入的报错随压力漂移,模型排障路径不稳定。

### F-09 [P4] compress 对非表面事件 seq 误报 "already compressed"
- 证据:离线 B6b——传入 compaction/summary 事件 seq(合法存在但从未是表面节点)→ 报 "already compressed — nothing to reclaim; decompress to recover"。建议区分 "not a surface node"。

### F-10 [P4] new_context 损坏元数据路径以异常而非机器码错误返回
- 证据:离线 C4b——已提交但代际跳跃的损坏窗口使 `identity()` 抛错;工具层直接向上抛异常(模型收到的是宿主渲染的异常文本),而非 SPEC §4 要求的 `{status:'error', code}` 机器字段。行为安全(只读降级正确),契约形式不满足。

## 4. 自我对抗复核(已推翻/降级的怀疑)

1. **"pending 被吞是 bug"** → 推翻。用真实持久化日志离线重放证明 no-new-history 判定正确(表面仅剩 seed);这是无进展保护,防止空换窗循环。降级为 F-04 可观测性问题。
2. **"300 字符 query 未被拒绝"** → 推翻为模型行为:glm-5.3-flash 自行缩短到 ~224 字符;离线矩阵已证 257 code points 拒绝(plain 与 astral 均验)。
3. **"跨会话游标可能泄漏"** → 推翻。异会话 blockId → block-not-found;游标带 HMAC+服务端表+session/scope/指纹校验,官方核验器 4 项 scope 检查全拒。
4. **"折叠 window seed 会破坏代际链"** → 推翻。构造 seed+新历史压缩:B9 证 identity 保持、ARC 块 decompress 可回溯窗前原件(64,289 字符,incomplete=false);单折 seed 本身被 5000 字符最小门结构化阻止(seed ≤4096 字节)。
5. **"hex/指数 seq 解析是漏洞"** → 保留为观察项("0x6"/"1e1" 被接受),无安全影响(后续表面校验兜底)。
6. **"物理会话只看到 1 个 request/header,是否路由证明不足"** → 核实为宿主日志行为(头部未变则不重复记录),逻辑预算会话记录 14 个;两会话全部头部均为指定路由,佐以 27/39 条 assistant usage。
7. **"compress 并发安全"** → B7 证 exclusive 单飞锁正确返回 busy。
8. **"手工双 summary 会双计"** → A6 证孤儿 summary 不入账本、decompress block-not-found;archiveHealth 计入 corruptMetadata。

## 5. 未执行项(如实申报)

- provider 物理溢出(1M 容量未触顶):NOT EXERCISED,与发行报告口径一致。
- fork/子代理继承、HMR 热重载、in-place 策略 live 对照、多标签并发 UI、pre-step 中途取消的实时时序:本轮未新增实测(发行证据与集成测试已覆盖部分;未验证部分维持原状)。
- 三臂对照/成本结论:本轮目标为漏洞挖掘,不重复 27 样本对照,不作成本优劣新结论。
- request/context 事件每会话仅 1 条(宿主行为),压力样本量有限;换窗降压证据以"窗口后请求全部通过 + 逐字恢复"间接成立。

## 6. 证据索引(全部在本仓库 .test-runtime/ 下,gitignored)

- 离线探测:`adversarial/probe-archive.mjs`、`probe-compress-window.mjs`、`probe-refine.mjs`、`probe-round3.mjs`(输出见对话记录与各轮 JSON 输出)
- 逻辑预算旅程:`adversarial/live-journey-report.json`、`live-events.json`(page API)、`observed/session-d3959cc6-….events.json`(持久化重建,1701 事件)、`live-verify.json`
- 官方逐字核验输出:verify-history.ts 于两会话的结果(见 §2)
- 物理旅程:`adversarial/physical-long-report.json`、`observed/session-7adb3adb-….events.json`
- pending 重放:`adversarial/replay-pending.mjs`、`replay-prefix.mjs`、`pending-probe-events.json`
- 损坏配置复现:`adversarial/broken-budget.patch.yml`
- 基线:`adv-check-baseline.log`(172+41 全过,exit 0)
