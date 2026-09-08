# dsh-context-management v0.1.0 扩大对抗测试报告（第二轮）

> 归档说明（2026-09-08）：本报告由 `.test-runtime/adversarial2/TEST-REPORT-2.md` 移入 docs/；文中所有 `.test-runtime/adversarial2/…` 证据路径仍以仓库根为基准解析，证据本体未移动（gitignored）。

- 日期：2026-09-08（本机时区 UTC+10）
- 对象：`dsh-context-management@0.1.0`，tarball SHA-256 `81640a34…31b543`（artifacts/ 与 .test-runtime/ 两份及 npm 发布一致），安装在隔离 profile `ctx-v010-test` / `ctx-v010-capacity` / `ctx-v010-inplace` / `ctx-v010-window-final`（本轮临时新增的 `ctx-v010-adv2bad` 已删除）
- 宿主：DSH 0.1.2-rc.1，Node 22.23.1，macOS darwin 25.4.0 arm64
- 模型：全部有效样本实际路由 `opencode-go/glm-5.3-flash`
- 约束遵守：未修改任何产品代码、文档或版本；全部脚本与证据在 gitignored 的 `.test-runtime/adversarial2/`；测试 web 已全部停止，用户常驻 `dsh web`（pid 20424）未受影响；仓库工作树保持 clean（基线 `npm run check` 会重写 `docs/evidence/recovery/sigkill.json` 的 testedAt 时间戳——测试套件固有副作用，已还原并在下方记为观察项 O-01）
- 本轮定位：在第一轮（`docs/TEST-REPORT.md`，发现 F-01…F-10）基础上**扩大范围**：优先闭合第一轮未执行项（fork 继承、in-place live、并发 UI、取消时序、配置失败语义），并扫源码中此前未触达的角落（游标淘汰、Unicode 折叠、深嵌套、seed 预算交叉校验、内存驻留家族、parseSeq 边界）

## 总结论

核心可靠性契约再次经受住攻击（fork 继承 3 种形态全过、8 会话并发零冲突零串扰、轮中取消干净、astral 分页逐字保真、超大来源图有界、注入/隔离延续第一轮结论）。但扩大范围后新增 **3 项 P2**：配置缺口家族比 F-01 更宽（合法配置即可让全新会话首句即死）、构造失败的配置使整个 web 永久不可用且无 Basic 回退（SPEC §6 偏离）、in-place 策略存在临界超支死区（模型即使主动 compress 也可能被拒后 turn 硬错误）。另有 1 项 P3（长驻内存驻留家族）与 6 项 P4。

## 1. 测试执行

1. **基线**：`npm run check` exit 0（typecheck + 172 单元 + 41 宿主集成 + build）。
2. **离线探针**（直接 import `src/`，`node --import tsx`）：`probe-reader.mjs` 33 例（游标淘汰/16KB 边界/Unicode 折叠/astral 分页/预算阈值/深嵌套/超大图/跨 scope/查询长度/偏移边界/命中预算），`probe-tools.mjs` + `probe-tools2.mjs`（compress 校验缺口、parseSeq 边界、配置交叉校验算术、ArcStateStore 驻留、handoff 语义、turnover seed 预算），`probe-r7b/c.mjs`（深嵌套恢复预算边界）。
3. **真实模型旅程**（7 组，全部经 web API 驱动真实 agent loop）：
   - L1 fork 继承（windowed 32K/8192）：8 页 → 盲答 12/12 → fork 于平静边界（含继承块检索、父会话后继、mid-turn fork）
   - L1b 高压点 fork 复现（fork 于 read-8 刚结束、代际 3、压力高位）
   - L2 in-place 对照（32K/8192）：8 页 + 盲答 + 失败轮事件级解剖 + 3 次重试 + 2 次 brick 探测
   - L2b in-place 合作对照（6 页、允许压缩）
   - L3/L4 并发与取消：8 会话并发 × 3 页 + 各自盲答 + 同会话双排队 + 3 次轮中取消（不同延迟）+ 取消后恢复 + RSS 采样
   - L6 非法 prompts 配置（构造失败）→ 回退行为
   - L7 `windowBudgetTokens: 8192`（其余默认、schema 合法、B=2048>0）→ 全新会话首句行为

## 2. 新发现清单（延续第一轮编号 F-11 起）

严重级口径同第一轮：P2=应在下个补丁修复；P3=设计缺陷；P4=低危/卫生。

### F-11 [P2] 配置校验缺口家族扩大：B<固定信封 与 seed>有效输入预算 均不失败（扩展 F-01）
- 证据（live L7 + 离线算术 T10b）：`windowBudgetTokens: 8192`（maxOutputTokens=auto、其余默认）通过 schema 与 `resolveAdaptiveGovernor`（B=8192−2048−4096=2048>0），web 正常启动、建会话、选模型全部成功；但**全新会话第一句**（哪怕 "Reply OK"）即以 `turn/end error: context-budget-exhausted: retained input exceeds the safe input budget`（错误码 **UNKNOWN**）失败——固定信封（系统提示+工具定义等）本身就超过 B。事件显示 0 个 request、0 个 compaction、错误轮的用户消息甚至不入日志（仅 inbox spliced）：没有任何可压缩历史，无路可走。
- 算术（T10b，引擎真实取值路径 `governedMaxTokens(undefined, gov, wb)`）：wb=8192 → B=2048；wb=10240 → B=3584；两者均 **< 默认 seedMaxTokens=4096**，违反 SPEC §5 "seed/恢复预算不得大于有效输入预算"，但 `resolveArchiveConfig` 与 governor 无任何交叉校验。wb≥12288 才恢复 seed≤B。
- 与 F-01 的关系：同一用户症状（"装好了但每句话都报错"、错误码 UNKNOWN、启动/建会话全成功），但触发区间更宽（不只 B≤0），且经由不同守卫（`checkRemainingBudget`/pre-step 而非 `governorCapacity` 构造抛错）。
- 复现：`.test-runtime/adversarial2/patch-wb8192.yml` + profile patch 层；报告 `wb8192-report.json`。

### F-12 [P2] 构造失败的配置使整个 web 永久不可用；承诺的 Basic 回退不可用、无类型化错误、stdout 无告警（SPEC §6 / DSH_INTEGRATION §4 偏离）
- 证据（live L6，`patch-badprompts.yml`：`prompts.nudge.normal: 'BAD {unknownplaceholder} template'`，schema 为 `Schema.any()` 故通过）：engine 构造在 `resolvePrompts` fail-fast 抛错 → loader 行 apply 失败 → `fiber.update` 拒绝 → bridge 走 catch/revert 路径。结果：
  - 该 web 内**同会话第二次 prompt 与全新会话的第一次 prompt 全部失败**，错误为三段链式原始 loader 文本：`failed to apply loader entry compaction (cordis:group): failed to apply loader entry compaction-arc (cordis:dsh-context-management): prompts.nudge.normal contains unknown placeholder …`（重复 3 次），错误码 UNKNOWN；
  - web stdout 仅 1 行（启动 URL），**没有任何接管告警**（bridge 的 `ctx.logger.warn/error` 未落到该 sink 或被吞）；
  - 用户视角：web 看似健康，实际上整个 profile 不可用，且没有任何"回退到 Basic 继续工作"的路径。
- 根因（代码路径）：`src/bridge.ts` 的 readiness barrier（`if (ready) { if (failed) throw failed; … }`）把接管失败转成该 agent 永久的组装失败；每个新 agent/created 又会重试接管并再次失败。即使 revert 恢复了 Basic 行，会话也到不了 Basic。
- 设计张力（如实记录）：硬失败 barrier 防止"用户以为 ARC 在管、实际跑的是 Basic"的静默降级，有其完整性理由；偏离点在于——失败后既没有类型化错误码与可操作的诊断，也没有任何降级可用性，且宿主 stdout 无痕。
- 同族触发面：一切使构造抛错的配置（prompts 未知占位符、archive 预算超出 768..4096、target≥nudge 等）。
- 报告：`badprompts-report.json`、`badprompts2-report.json`。

### F-13 [P2] in-place 策略临界超支死区：turn 硬错误、问题不被回答；模型在边界上主动合作也无法挽救（SPEC §6 行 1 偏离）
- 证据（live L2，windowed 同几何对照第一轮全过）：
  - 8 页读取期间 emergency fuse 正常工作：7 个 ARC 冷存块自动落地（provider=local/adaptive-governor-extractive-v1，无 LLM）、new_context 工具正确不注册（模型答 NO-NEW-CONTEXT-TOOL）、maxTokens 恒 8192；
  - 盲答轮以 `context-budget-exhausted: retained input exceeds the safe input budget`（UNKNOWN）死亡。事件级解剖（`inplace5-failing-turn.json`）：该轮实际运行了 5 个 step——模型自主调用 search_context×3、arc_status、并**最终主动调用 compress**；compress 被拒（无合法可压缩空间：保护带+最新用户），随后 step 边界 pre-step 抛错。**问题没有得到回答**（盲答 0/12）；
  - 死区行为（3 次重试 + 2 次探测）：此后小 prompt 间歇通过（每次再消耗一个 emergency 归档），稍大 prompt 立即失败且 0 request 0 archive——当可压缩空间耗尽时仅剩小 prompt 可过；波动围绕 B 线。
  - 合作对照（L2b，6 页、明确允许压缩）：全程 completed、盲答 8/8、2 个 ARC 块——死区需要增长到边界才触发，边界处模型合作也未必能救（compress 被守卫拒绝）。
- SPEC §6 行 1 对"无可安全前缀/不可缩减"的期望是 **no-safe-range/no-op + 说明不可缩减单元 + 不循环重试**；实际是硬 throw 杀死 turn。windowed 默认策略不受影响（同负载 12/12）。in-place 为显式 opt-in，但这是文档化失败语义的偏离 + 用户问题丢失。
- 报告：`inplace-report.json`、`inplace2/3/4-report.json`、`inplace5-failing-turn.json`、`inplace-coop-report.json`。

### F-14 [P3] 长驻进程内存驻留家族（F-06 之外还有两处）
- `src/bridge.ts` apply()：每个带 standing mount 的 `agent/created` 向进程生命周期的 `disposers` 数组压入 2 个闭包（捕获 `agent`、`pending`、`failed`），仅在 bridge dispose 时清理——**每个创建过的 Agent 对象（及其 Session/日志）被强引用至进程结束**（src/bridge.ts:319-331）。
- `src/state.ts` ArcStateStore：`states = Map<string, CompressionState>` 按 session.id 强持有内核状态，无淘汰、无会话结束钩子（仅换窗/compress 错误时 delete）。合成测量（T7）：300 会话 × 10 块×20KB 摘要 → 驻留 ~9.9MB（≈33KB/会话，真实状态更小但同趋势）。
- 连同 F-06（lastNudgeTurn）构成三处按会话单调增长的驻留。live 方向性佐证：8 会话×4 轮 → web RSS 79MB→385MB（含宿主自身缓存，无法单独归因，仅记录）。

### F-15 [P4] compress 的 seq 解析接受 `-0`，后续在 SessionSeq 校验处以原始异常暴露
- 证据（T6b）：`startSeq: "-0"` → `parseSeq` 返回 -0（`-0 < 0` 为 false 故放行）→ `SessionSeq(-0)` 抛 `SessionSeq must be a non-negative safe integer, got 0`——模型收到的是该原始异常而非 invalid-seq 引导错误（F-10 同族：异常替代机器码）。顺带复核：`'0x4'`、`'1e1'`、`' 12 '`、`'12#call_x'` 均按数值解析进入正常闸门（第一轮观察项维持）。

### F-16 [P4] search_context 的 Unicode 简单大小写折叠存在盲区
- 证据（R4）：仅 `toLowerCase()` 折叠，`ß`↔`ss`、`İ`↔`i`（İ 小写化为 i+组合点）、词尾 `ς`↔`σ` 均搜不到；精确大小写查询可命中，decompress 逐字恢复不受影响。命中时的 offset 与 snippet 代理对安全全部验证通过。

### F-17 [P4] 每会话 256 游标 FIFO 淘汰会打断进行中的分页，且无淘汰信号
- 证据（R1）：先取得合法 nextCursor，再制造 300 个新 scope 后续用旧 cursor → `invalid-cursor`，与伪造游标不可区分。上限本身是 SPEC 实施说明的设计（256/session），缺的是可区分的淘汰提示。

### F-18 [P4] decompress 以 `offset = 文本长度` 定位返回成功加空段落
- 证据（R11）：`segments: [""]`——EOF 寻址返回空页而非类型化的空结果；`offset > length` 正确拒绝（invalid-text-offset）。

### F-19 [P4] 深层嵌套内容的恢复预算退化；宿主写路径自身有深度防护
- 证据（R7/R7c/R13）：文本块嵌套 >~700 层时，路径序列化（每段 textBlockPath）吃掉默认 2048 预算 → `insufficient-headroom`（显式 maxTokens 4096 可恢复至 ~1500 层）；>32 层路径不可经 seek 定位（输入校验上限）。宿主 `createUserMessage`（dsh-llm structuredClone）在 ~3000 层拒绝写入，2500 层以内接受——正常工具结果远浅于此，实际可达性低。

### F-20 [P4] `handoff: ""`（空串）被当作"已提供 handoff"
- 证据（T8）：user 摘录预算从 60% 缩到 45%、证据索引被封到 30%，而空串本身零贡献——严格劣于不传 handoff；无校验区分空与缺省。

## 3. 第一轮未执行项的闭合情况

| 第一轮未执行项 | 本轮结果 |
|---|---|
| fork/子代理继承 | **闭合（正面）**：3 种形态（平静边界/高压边界 read-8 刚结束/轮中 atSeq）全部正常——继承窗口元数据（gen 1..3）、fork 首答 12/12、继承的父块可检索（答出更正值 corr-771-navy）、mid-turn fork 首答正常。第一轮之前的 round-0 历史 fork 失败（`assembled request exceeds the safe input budget`）在发布构建上 3 次复现尝试均未重现，其父会话事件已重建分析（fork 点表面 11 节点、seed+63KB 工具结果、上一窗口在 seq 141）——记为"发布构建上无法复现的历史观察"，归档于 fork-hp-report.json |
| in-place 策略 live 对照 | **闭合**：基本面正常（自动冷存、无 new_context、maxTokens 恒定），但发现 F-13 死区 |
| 多标签并发 UI | **闭合（API 层近似）**：8 会话并发全过（读取轮全 completed、盲答 8×6/6、无 busy 冲突、无串扰）；同会话双排队 prompt 保序完成（QUEUE-A→QUEUE-B）。浏览器层 UI 留待 |
| pre-step 中途取消时序 | **闭合**：3 次轮中取消（1.5s/2.3s/3.1s 延迟）全部 `turn/end aborted`；第 3 次取消落在换窗提交之后——窗口仍持久化、代际推进、无悬挂 pending，取消后下一 prompt 正常（已提交工作保留的取消语义，记录为设计行为而非缺陷） |
| 物理溢出 | **维持 NOT EXERCISED**：唯一已配置路由声明 1M 容量，真实触顶需向付费路由发送 ~1M token，不可行；恢复路径由集成测试（controlled adapter 的 CONTEXT_WINDOW_EXCEEDED 重试）覆盖 |
| HMR 热重载 | **部分**：宿主无公开驱动面；行 apply 失败/回滚由真实 loader 集成测试 + F-12（live）覆盖 |
| 模型路由切换 live | **未执行**：profile 仅配置一个路由，无公开模型列举 API（6 个候选方法均 404），不猜测付费路由 id；离线 B05 已覆盖换路由守卫 |

## 4. 本轮全部经受住的攻击（正面证据）

- **fork 继承与隔离**（见上表）；父会话 fork 后继续使用不受影响。
- **并发**：8 会话并发 + 双排队，零冲突零串扰。
- **取消**：轮中取消干净，含取消与换窗竞态。
- **astral/分页保真**：9000 星体字符以 768 预算分 48 页恢复，拼接逐字相等、无代理孤立字符（R5）。
- **16KB 扫描边界**：跨界 needle 单命中不重复、边界起始命中正确（R2）；regex 元字符按字面量处理（R3）。
- **超大来源图**：30 万伪造引用 11ms 内以 incomplete+missing(前 8) 有界返回，无挂起（R8）。
- **游标安全**：跨 scope（search↔decompress）全拒（R9）；HMAC 延续第一轮结论。
- **查询/参数边界**：query 256/257 code points（含 astral）正确；decompress/search 预算阈值 768/1100 精确（R6/R10）。
- **compress 校验**：空 summary、缺失 summary、<50 字符、>20000 字符全部被 kernel 干净拒绝（T1/T2/T3/T5）——工具描述中的"最少 50 字符"实际有强制；content 非数组以明确错误拒绝且零落地（T4）。
- **宽内容**：2 万文本块的事件搜索 5ms（R7）。
- **路由保真**：全部旅程 maxTokens 恒 8192（数值上限模式）/ 32768（auto，第一轮已证）。

## 5. 自我对抗复核（本轮推翻/降级的怀疑）

1. **"fork 必然触发 budget-exhausted"** → 推翻：3 种形态全部正常；历史 round-0 失败无法在发布构建复现（其错误签名 `assembled request exceeds` 属 agent/request 守卫，与 L7 的 `retained input exceeds`（pre-step 守卫）不同——两个守卫文本相近，已分别定性）。
2. **"in-place 死区是模型不合作造成"** → 部分推翻：边界轮的完整事件链证明模型当时**正在合作**（search×3 → arc_status → 主动 compress），compress 被守卫拒绝后才死；合作对照（6 页）全程正常——死区条件是"增长到边界"，不是"模型态度"。
3. **"L7 的失败至少会尝试压缩"** → 推翻：全新会话零历史，0 compaction 0 request，用户消息都不入日志——失败先于任何可行动作。
4. **"深嵌套可造成插件 DoS"** → 降级：宿主 structuredClone 在 ~3000 层拒绝写入（R13，这本身是此前未记录的宿主防护事实）；≤2500 层内插件处理毫秒级（R7）——降为 F-19 的预算退化观察。
5. **"compress 空 summary 会落地空块"** → 推翻：kernel 强制拒绝（min 50/max 20000），描述与实现一致。
6. **"R7 深嵌套 decompress 失败是 bug"** → 修正定性：默认预算下路径序列化占用页预算（insufficient-headroom），显式 4096 可恢复——归入 F-19。
7. **"F-12 中 revert 没有运行"** → 无法从外部证实/证伪 revert 的内部成败；已按可观测事实表述（整 web 不可用、无告警、无类型化码），根因归因标注到 barrier 代码路径。

## 6. 观察项（不构成缺陷编号）

- **O-01**：从仓库根运行 `npm run check` 会重写 `docs/evidence/recovery/sigkill.json` 的 `testedAt`（tests/integration/crash.test.ts:58-59 固定写该路径）——"只读检查"产出工作树改动，建议 CI 加防护或改写到 .test-runtime。
- **O-02**：错误 turn（F-11 情形）中用户消息不入日志（仅 agent/inbox/spliced）——排障时看不到"用户问了什么"。
- **O-03**：取消与换窗竞态时已提交窗口保留（语义合理， SPEC "cancellation owns pending work" 的边界行为，建议在文档明示）。
- **O-04**：宿主对 >~3000 层嵌套内容在写入即拒绝（structuredClone 栈限制）——非插件行为，记录为环境事实。

## 7. 证据索引（全部在本仓库 `.test-runtime/adversarial2/`，gitignored）

- 离线：`probe-reader.mjs/.out`、`probe-tools.mjs/.out`、`probe-tools2.mjs/.out`、`probe-r7b.mjs`、`probe-r7c.mjs`
- fork：`live-fork.mjs`、`fork-report.json`、`live-fork-hp.mjs`、`fork-hp-report.json`；round-0 历史分析基于 `docs/evidence/live/C-1701-3-1788786769487.json` 与 `.test-runtime/observed/session-d8c58d94-…events.json`
- in-place：`live-inplace.mjs`、`inplace-report.json`、`live-inplace2/3/4/5.mjs`、`inplace2/3/4-report.json`、`inplace5-failing-turn.json`、`live-inplace-coop.mjs`、`inplace-coop-report.json`
- 并发/取消：`live-conc-cancel.mjs`、`conc-cancel-report.json`、`live-models.mjs`
- 配置失败：`patch-badprompts.yml`、`live-badprompts.mjs`、`badprompts-report.json`、`badprompts2-report.json`
- 预算缺口：`patch-wb8192.yml`、`live-wb8192.mjs`、`wb8192-report.json`
- web 日志：`web-fork.log`、`web-inplace.log`、`web-conc.log`、`web-wb8192.log`、`web-badprompts.log`

## 8. 与第一轮的合并视图（供迭代排期）

- **P2**：F-01+F-11（配置 fail-fast 缺口家族：B≤0 / B<信封 / seed>B，统一症状为"启动成功、首句未类型化错误"）；F-12（构造失败配置 → 整 web 不可用、无回退无告警）；F-13（in-place 死区，SPEC §6 行 1 偏离）
- **P3**：F-02、F-03、F-04、F-14（内存驻留家族：lastNudgeTurn + bridge disposers + ArcStateStore）
- **P4**：F-05…F-10、F-15…F-20、O-01…O-04
