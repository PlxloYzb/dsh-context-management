# dsh-context-management 开发计划(PLAN)

- **配套文档**:[SPEC.md](./SPEC.md)(规格与验收依据;本文步骤全部映射到 SPEC 条目)
- **基线**:源仓库 `dsh-arc-context` @ `82fc3004d10c445f82aa97a93ad2a88a3a8794cd`(v0.2.0-beta.15,只读参考,迁移后不再改动)
- **工作目录**:本仓库 `/Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-context-management`(一切开发在此进行)
- **依赖线决策**:D7 升 0.1.2-rc.1;**历史证据决策**:D8 保留旧名

## 阶段总览

| 阶段 | 内容 | 完成门 | 产出 commit |
|---|---|---|---|
| P0 | 迁移落地 + git 初始化 | 新仓库可 `npm install` | C1 |
| P1 | 包级改名清扫 + 依赖线升级 | check/audit 全绿 | C2、C3 |
| P2 | 换窗功能 | check 全绿 + 新测试全过 | C4 |
| P3 | 门面与多语言文档 | 文档一致性复核 | C5 |
| P4 | 发布准备 | 版本就绪,所有者步骤交接 | C6 |

---

## Phase 0 — 迁移落地(→ SPEC §1/§3)

1. 复核包名:`npm view dsh-context-management`(应 404/空;发布前 Phase 4 再复核一次)。
2. 复制源仓库(关键:**不带 `--delete`**,保留本目录已写好的 `docs/SPEC.md`、`docs/PLAN.md`;排除 `.git/`——新仓库全新历史):
   ```bash
   rsync -a \
     --exclude node_modules --exclude dist --exclude .git \
     /Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-arc-context/ \
     /Users/bruceplxl/Workspace/dsh-plugin-dev/dsh-context-management/
   rm package-lock.json   # 由 npm install 重新生成
   ```
3. `git init`;`.gitignore` 确认(随源带来,node_modules/dist 应已覆盖);首 commit:
   - message:`(feat) migrate dsh-arc-context -> dsh-context-management`
   - body 写明:迁移自 `PlxloYzb/dsh-arc-context` @ `82fc300`,原包名弃用计划,规格见 `docs/SPEC.md`。
   - **注意**:首 commit 是纯迁移(内容与源 HEAD 逐字节一致,除删除的 lock 与新增的 docs),不含任何改名——保证 diff 可审、可 bisect。

**完成门**:`git status` 干净;`ls` 结构完整;`npm install` 成功(lock 重新生成)。

## Phase 1 — 包级改名 + 依赖线(→ SPEC §3/§4)

### C2:改名清扫(顺序自内向外,先代码后门面)

按 SPEC §3.1 表格逐类执行,要点与易漏项:

1. **package.json**:name / description / bin(`dsh-arc-presets`→`dsh-ctx-presets`)/ repository·homepage·bugs / keywords。exports 路径 `./bridge` 不变(npm 子路径,不含包名)。
2. **cordis.patch.yml**:patch id、name、头注释(三承诺保留:`adaptiveGovernor` 配置结构不动,P2 只扩语义不改键)。
3. **src/ 15 文件 54 处**:`@module` docstring(13 文件)、错误前缀、`BUILTIN_KEY`/`BUILTIN_ROW_NAME`/bridge 导出名/`Symbol.for(...)`/systemPrompt section 名/`resolvedBackend`/preset-cli 文案。**保留项**见 SPEC §3.3(`ARC_ROW_ID`、fallback 溯源串、`ArcContextEngine`)。
4. **tests/ 4 文件 15 处**:governor.test L71/83、mount-probe.test L128-155、bridge.test、preset-compat.test 的断言随实现同步。
5. **research 活代码**:`bench/gate-completion-messy.mjs` L44 错误前缀匹配器。**历史证据一律不动**(SPEC §3.2)。
6. **docs/ 7 文件 + 16 个 README + AGENTS/CONTRIBUTING/LICENSE/NOTICE/RELEASE_CHECKLIST/ROADMAP + .github/bug.yml**:
   - RELEASE_CHECKLIST 顺手修滞后项:`acp_status`→`arc_status`(L19/24)、版本引用更新;
   - README 本阶段先做"字符串级"改名(标题/命令/仓库名),**形态级重写留给 P3**;
   - AGENTS.md 的模块图、提交规范引用、release 流程中的包名同步。
7. **双名识别**:`preset-compat.ts` `ARC_NAME` 正则改双名(旧+新),audit 报告区分新旧引用;preset-compat.test 补旧名 fixture 用例。
8. **CHANGELOG**:只在顶部追加 `0.3.0-beta.1` 条目(更名 + 迁移 + 依赖线 + 换窗预告)。

**改名自查门**:
```bash
grep -rn "dsh-arc-context" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git . \
  | grep -v CHANGELOG.md | grep -v '^docs/SPEC.md' | grep -v '^docs/PLAN.md' \
  | grep -v '^research/results/' | grep -v '^research/reports/' \
  | grep -v '^research/profiles/' | grep -v '^research/fixtures/' \
  | grep -v verify-public-evidence.mjs
# 期望:零输出(即仅剩 SPEC §3.2 允许的历史记录)
```

### C3:依赖线升级(独立 commit,便于回退审查;→ SPEC §4.5)

1. devDependencies:分包整体升 0.1.2-rc.1 线——`@deepseek-ai/cordis` 4.0.2、`cordis-plugin-loader` 1.0.3、`@deepseek-ai/dsh-*` 0.1.2-rc.1;`acp-kernel` 精确 pin 不动。
2. peerDependencies:`@deepseek-ai/*` 分包 → `^0.1.0-rc.7 || ^0.1.2-rc.1`;cordis/loader/schemastery 维持。
3. `npm install`(重生成 lock);跑 `npm run check`。
4. **重点盯防**(bridge.test.ts 用真实 Loader/Include/Group,即新线集成验证):
   - `loader.builtins` 注册语义(loader 1.0.2→1.0.3);
   - Include patches 两阶段顺序更新(include 1.0.7);
   - 若出现 API 漂移:优先 additive 适配,不做行为改写;无法吸收则停下向所有者报告。
5. AGENTS.md 依赖线纪律段更新为 0.1.2-rc.1 线(含"不混线"表述的迁移)。
6. 本机实测(可选但推荐):`dsh plugin --profile web add` 指向本地 tarball(`npm pack` 产物),确认 0.1.2-rc.1 宿主安装无 unmet peer 警告、takeover 生效(官方 publish 文档确认 tarball 为免授权安装路径,SPEC §8.3)。

**P1 完成门**:`npm run check` 全绿 + `npm run presets:audit` 通过 + 改名自查门零输出 + 既有 bridge/state 兼容测试全过(验收标准 2/3/4 的静态部分)。

## Phase 2 — 换窗功能(→ SPEC §5)

文件级任务分解(依赖顺序,自底向上):

| 步 | 文件 | 任务 | SPEC |
|---|---|---|---|
| 1 | `src/region.ts` | `ArcCompactionSummaryFields` + `window` 可选字段;`ArcBlockLedgerEntry` 同步;`rebuildBlockLedger` 透传;新增 `runWindowFreezeTransaction`(失败补偿 + flush 语义仿 `runManualCompactionTransaction`;`shadowedTokenCount` 走 host token meter) | §5.2 |
| 2 | `src/state.ts` | `ArcStateStore` per-session 窗口记录;hydration 分支从日志派生 generation/档案页 | §5.6 |
| 3 | `src/fallback.ts` | 抽取式摘要机制导出复用(现 `buildEmergencyFallbackSummary` 一族),供档案页摘要与 handoff 消毒调用;不改既有冷存行为 | §5.3.3 |
| 4 | `src/config.ts` + `src/governor.ts` | `AdaptiveGovernorConfig.strategy?: 'in-place' \| 'windowed'`,缺省 `in-place`;schema 校验(非法值 fail-fast) | §5.5 |
| 5 | `src/tools.ts` | `new_context` 定义 + handler(守卫/摘要/落账/新窗种子/输出报告);`arc_status` windowed 小节;注册条件 = enabled && windowed | §5.3 |
| 6 | `src/prompts.ts` | `ToolPrompts` 加键、`TOOLS_ALLOWED` 加 `new_context`、`DEFAULT_PROMPTS` 工具描述 + nudge 窗口变体模板;构造期占位符校验 | §5.5 |
| 7 | `src/commands.ts` | `/arc new-context` 分支(raw 前缀匹配)+ `newContextText`;空闲括号执行 | §5.4 |
| 8 | `src/index.ts` | env 组装扩展;`compactIfNeeded` windowed 分支(先冻结、失败回退 `runEmergencyFallback`) | §5.5 |
| 9 | `src/window.ts` | 不动(容量探测,与换窗无关;防混淆已确认) | — |
| 10 | `cordis.patch.yml` | **不加新键**(默认 in-place 的安装即现行为);README/docs 展示 opt-in 写法留给 P3 | §5.5 |

**设计对齐注记**(源自 Codex 勘察,SPEC §8.2;实现时对照):

- windowed nudge 的去重域以窗为界(换窗后提醒标志重置),文案含"取代此前容量提示"声明句——对齐 Codex C5/C6;
- 冻结后压力回落依赖 shadow 计价(`compressionAwareProjectedTokens`),语义对应 Codex 每窗 prefill 基线(C1/C3),列入下方测试 T10;
- `handoff` 四要素(环境/约定/推理链/未决问题)与 Codex WorldState section 化活状态同源(C6),但**不**引入完整 WorldState 机制;
- 窗口族系(首窗/上一窗/当前窗)从日志派生,不落盘——与 Codex 在检查点存 id 三元组的做法不同,append-only 日志天然保序(C1)。

**测试**(新增 `tests/windowing.test.ts`,沿用 node:test + `fakeAgent`/`makeEnv` 模式;扩展 state/governor/adversarial):

- T1 append-only:冻结前后 events 前缀逐字节一致;失败路径(守卫拒绝/中途异常)后事件序列合法(end 补齐或无写入)。
- T2/T3/T4 可搜/逐字还原/回灌:长会话 → 换窗 → `search_context` 以旧窗独有词命中档案页;`decompress` 输出与被冻结原文拼接逐字节一致并带边界头。
- T5 默认回归:未配置 strategy 时工具面恰为四工具;压缩/nudge/emergency 路径与现行为一致(既有测试不改动即背书,另加显式默认值断言)。
- T6 安全区:windowed 下低于 0.75 零触发。
- T7 emergency 兜底:windowed + ≥0.90 → 冻结事务落账;构造冻结失败 → 回退 in-place 冷存。
- T8 旧会话:含旧账本(legacy 0 值)会话重建/检索/还原;带 `window` 字段日志在忽略该字段的重建路径下不炸。
- T9 重启:冻结后新 store 从日志恢复 generation 与档案页。
- T10 压力回落:冻结后 `compressionAwareProjectedTokens` 显著下降(shadow 计价生效),对应 Codex 每窗 prefill 基线语义(SPEC §8.2-C3);换窗后 nudge 提醒标志已随新窗重置(每窗一次性,SPEC §8.2-C5)。
- 对抗:伪造 window 字段、handoff 注毒。

**P2 完成门**:`npm run check` 全绿;SPEC §5.7 九条不变式各有对应测试。

## Phase 3 — 门面与"替换 Basic"表述(→ SPEC §1/§6)

1. **README.md(中文主文件)先行**:
   - 标题+首句:包名 + "Replaces Basic compact with windowed, reversible context"(ARC 降为技术章节名,SPEC D1/D4);
   - 保留 Basic 对比表(质量 4 倍、输入 −47.6% 等),新增换窗形态小节:冻结/开新窗/可搜/可逐字还原/整段回灌,并写明与"纯笔记+检索"方案的区别(原件可还原);
   - 安装:更新 `dsh plugin add dsh-context-management`;保留"preset 逐字节不变、卸载零残留"承诺;安装成功提示文案:"compaction-basic 已由 Context Management 接管,卸载即还原";
   - 换窗 opt-in 配置示例:**必须整块重述** `adaptiveGovernor` 全部键 + `strategy: windowed`(官方 patch 语义为行级整值替换、不深合并,只写 strategy 会清掉其余键,SPEC §8.3)+ 默认 in-place 说明;
   - 安装/排障验证步骤:`dsh --profile <name> --dump-config` 检查层叠后配置(官方文档确认的手段,SPEC §8.3);
   - 对比素材引用 SPEC §8.2:与 Codex 的两层差异——vs `RetainedContext`(有界提炼事实、逐出不可复原 vs ARC 全原件可逆)与 vs `history-notes`(纯笔记形态 vs 档案页原件可还原);
   - 版本表述:跟随 dsh 官方 0.1.2-rc.1。
2. **README.en.md(英文权威版)** 同步;其余 14 语言在 本 phase 内完成(以英文版为源,逐节对照)。
3. **AGENTS.md**:模块图加 windowing 语义、依赖线更新(P1 已做部分)、命名规则(包名 vs ARC 标识)。
4. **ROADMAP.md / RELEASE_CHECKLIST.md**:新名称、新形态、0.3.0-beta.1 发布段。
5. **docs/**:INSTALL.md(安装命令、依赖线表述)、PRESET_INTEGRATION.md、adaptive-governor 文档补 strategy 说明。

**P3 完成门**:16 个 README 首句/安装段/换窗小节齐备;`grep -n "dsh-arc-presets"` 全仓零残留;改名自查门保持零输出。

## Phase 4 — 发布准备(部分步骤需所有者执行)

| 步 | 执行者 | 内容 |
|---|---|---|
| 版本号 | 开发 | `npm version 0.3.0-beta.1`(minor 递进:更名+换窗新能力) |
| 发布前复核 | 开发 | `npm view dsh-context-management` 仍空;`npm pack --dry-run` 产物核对(files 字段含 cordis.patch.yml) |
| npm publish | **所有者** | `npm publish --tag beta` |
| 旧包弃用 | **所有者** | `npm deprecate dsh-arc-context@"*" "Renamed to dsh-context-management"` |
| GitHub 改名 | **所有者** | 仓库 → `PlxloYzb/dsh-context-management`,topics 补 `dsh-plugin`、`deepseek-harness` |
| release | 开发 | `release v0.3.0-beta.1` PR(遵循 AGENTS.md 发布流程) |

## 提交序列

| # | message | 内容 |
|---|---|---|
| C1 | `(feat) migrate dsh-arc-context -> dsh-context-management` | 纯迁移 + 本 docs(SPEC/PLAN)+ 新 git 历史 |
| C2 | `(feat) adopt dsh-context-management package identity` | P1 改名清扫 + CHANGELOG 追加 |
| C3 | `(feat) track dsh 0.1.2-rc.1 dependency line` | dev 线升级 + peer 放宽 + AGENTS 线纪律 |
| C4 | `(feat) windowed context: freeze working set into searchable archive pages` | P2 全部 |
| C5 | `docs: rename facade + windowed mode documentation` | P3 全部 |
| C6 | `(feat) release 0.3.0-beta.1` | 版本号 + 发布核对清单 |

## 风险登记册

| 风险 | 等级 | 缓解 |
|---|---|---|
| 0.1.2-rc.1 线 API 漂移(loader/include/cordis) | 中 | 四个公开面已在本机核实仍在;bridge.test 真挂载测试全量重跑;漂移优先 additive 适配,无法吸收即停并上报 |
| research:verify 门对改名的敏感性 | 低 | 已核实其断言对象是历史 JSON(SPEC §3.2),脚本不改;若门红,先判断是历史断言还是泄漏扫描,再定位 |
| 冻结绕过 acp-kernel 导致状态不一致 | 中 | 档案页不产生 kernel block 是有意设计;T9 重启恢复 + state.test 扩展兜底;实现时盯 `rebuildKernelBlocks` 对无 kernelBlockId 条目的路径 |
| 模型滥用 `new_context`(反复冻结) | 中 | "不缩减即拒绝"守卫(SPEC §5.3.2)+ nudge 文案约束;首 beta 观察 |
| 多范围冻结语义(平衡边界拆分) | 低 | SPEC 留了实现自由度(最大范围 vs 全区间),以测试定案;无论哪种,T1-T4 不变式不放松 |
| 16 语言 README 同步成本 | 低 | 英文权威先行,关键节(首句/安装/换窗)逐节对照,数据表直接复用 |
| npm 包名被抢注 | 低 | P0 与 P4 双重复核 |
| 旧手改 preset 用户升级断链 | 中 | preset-compat 双名识别(SPEC §3.4)+ CHANGELOG/README 升级指引 |
| 桥接依赖的四个公开面属非官方文档化 API(develop 文档无 compaction 专页,SPEC §8.3),dsh 0.1.x 后续升级仍可能漂移 | 中 | 依赖线升级即全量重跑 bridge 集成测试(C3);README 明示"非官方文档化集成面,随 dsh 0.1.x 线实测验证" |

## 与验收标准的映射

- 标准 1(改名 grep)← P1 改名自查门 + D8 例外清单
- 标准 2(check/audit 绿)← P1/P2/P3 完成门
- 标准 3(安装/接管/还原)← C3 新线集成测试 + 本机 tarball 实测 + 既有 bridge.test
- 标准 4(旧会话可读)← SPEC §4 勘察结论 + T8
- 标准 5(windowed 六项行为)← T1-T4、T7
- 标准 6(默认一致/静默)← T5、T6
