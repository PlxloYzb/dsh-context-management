# dsh-context-management 0.1.1

本补丁针对 TEST-REPORT.md、TEST-REPORT-2.md、DESIGN-REVIEW.md，保留默认 windowed、可逆档案与共享 append-only 事务。目标宿主仍为 DSH 0.1.2-rc.1，acp-kernel 固定为 0.0.24。0.1.0 报告和包保持原样；0.1.1 证据单独写入 `docs/evidence/v011`。

## 评审项处理

| 项目 | 0.1.1 处理与验证 |
|---|---|
| F-01/F-11、D3 | 加载前验证 B>0、seed/retrieval≤B、模板与静态窗口；实际路由再次校验。系统提示/工具单独超预算返回 CONTEXT_ENVELOPE_TOO_LARGE。配置回归与真实 AgentLoop 验证零 provider 调用。 |
| F-02 | 每次命中按一个 Unicode code point 前进，包含同块重复/重叠命中；回归逐页验证 50 个精确 offset。 |
| F-03 | health 与账本共用相邻 summary/replacement 判断；损坏相邻关系两者都报告异常。 |
| F-04 | 下一安全 pre-step 将 no-op 结果记录一次并交给模型，保留 requestId；真实并行工具循环验证 pairing。 |
| F-05 | seed.mode 独立表示提取方式，incomplete 依据实际来源/截断诊断。 |
| F-06/F-14、D4 | session 对象弱缓存；agent/disposed 清理两个 readiness 监听；20-agent churn 和同 ID 重载测试。未迁移为宿主 projection。 |
| F-07 | >24K 模型摘要在提交前拒绝；advanced override 回归验证日志不变。 |
| F-08/F-09 | 不存在的档案优先返回 block-not-found；单个非 surface 元数据 seq 不误报已压缩。 |
| F-10/F-15、D5 | 统一结构化工具错误，损坏 window generation 返回 corrupt-metadata；严格十进制 safe integer，拒绝 -0/hex/exponent。 |
| F-12、D2 | 配置失败不进入接管；接管失败确认 Basic 回滚才放行并告警；未知后端仍阻断。真实 mount 故障注入覆盖首个/后续 agent、回滚失败、取消等待。 |
| F-13 | 支持将满足保护约束的旧 in-place checkpoint 再压缩，保留原始档案来源；8 个累计 checkpoint 回归通过。仍保留 B 硬限制，无安全缩减时明确停止。 |
| F-16 | 文档限定 JavaScript 小写匹配及 UTF-16 offset；未增加 Unicode full case folding。 |
| F-17 | 游标从 FIFO 改为 LRU，失效错误给出重启读取指引。保持有界状态，不增加无限淘汰墓碑。 |
| F-18/F-19 | EOF 返回空 segments/endOfText，计入响应预算；嵌套恢复仍有显式遍历上限与 incomplete，不承诺无限深度。 |
| F-20 | 空/空白 handoff 与未提供完全一致，回归比较 seed 正文。原报告的“用户预算从60%降到45%”不是实际根因；原代码空串绕过本地 nullish fallback 才造成内容差异。 |
| D1/D6 | 保留 bridge，修正定价注释，runtime/report 版本取 manifest，SIGKILL 测试不再覆盖已发布证据。静态 preset 安装备选、projection/invariants 重构与扩大宿主支持面暂不加入补丁。 |

## 最终验收

G1–G7 全部通过，详见 [最终门槛报告](evidence/v011/release/final-gates.json)。本地包：[dsh-context-management-0.1.1.tgz](../artifacts/dsh-context-management-0.1.1.tgz)，265,405 字节（以 manifest 为准），SHA-256：`fa96ed73af548487f9b151b8b8b4a59079c035768410e6b72fb955e6c1004c68`。[独立发布清单](../artifacts/release-manifest-0.1.1.json) 保留 0.1.0 清单。

| 检查 | 实际结果 |
|---|---|
| 最终 npm pack/prepack | 严格类型、184项单元测试、50项真实宿主集成及构建通过；40个分发文件 |
| 全新 npm ci/check | 181单元、48集成通过；随后新增的2项集成回归也由最终prepack运行通过 |
| Web 故障路径 | 无效模板启动拒绝；修正后两次请求正常；ARC 初始化失败后首个/后续请求均为 Basic；固定信封超预算保留专用机器码，0次provider请求 |
| 安装、重启、卸载 | 最终tarball覆盖同 profile 的7个原生 Basic preset，首请求/重启ARC、卸载Basic；minimal始终无后端；全部preset文件哈希不变 |
| UI | native new/search/decompress/compact/status、重启代际保持、旧cursor失效和重新读取通过 |
| 恢复与规模 | SIGKILL恢复通过；10万事件、1,100档案、100窗口，512MiB限制通过；冷重放约440ms，search p95约17.1ms |
| 真实容量旅程 | 同一路由，无人工逻辑窗口，8页阅读与12/12回忆通过；实际物理overflow未触发 |

三臂最终清单：[A Basic](evidence/v011/live/cohort-A-candidate1.json)、[B in-place](evidence/v011/live/cohort-B-candidate2.json)、[C windowed](evidence/v011/live/cohort-C-candidate2.json)。每臂3个固定seed×3个独立会话，实际路由均为 `opencode-go/glm-5.3-flash`。A是本次重新测得的基线；修复错误类身份后，B/C使用更新候选完整重跑。首轮 B/C 与全部诊断失败保留，未筛选样本。

| 策略 | 完整流程 | 盲答 | 重启回忆 | 原文恢复/配对 |
|---|---:|---:|---:|---:|
| A Basic | 9/9 | 108/108 | 108/108 | 9/9 |
| B in-place | 9/9 | 108/108 | 98/108 | 9/9 |
| C windowed | 9/9 | 108/108 | 108/108 | 9/9 |

默认windowed每会话至少3次实际换窗，9/9保留全部更正。in-place本组已无预算硬停，但5个重启回答遗漏更正，完整更正保持为4/9；来源可恢复不等于模型回答全部正确。首轮in-place盲答94/108、重启92/108也保留。此补丁不把in-place宣称为与windowed质量等价。

最终模型候选hash为 `cf655cc8c081970fab0749a812c53d7839523451c62288f6877767336128371c`。随后按用户明确的目标 profile 范围增补 bridge 的动态定位、preset 切换和原生命令触发；压缩/换窗/检索/事务引擎、其类型和依赖逐字一致。最终 tarball 另通过 24 项多 preset Web 生命周期、6 项失败路径和消费者类型检查。此次 bridge 增补未重新执行 27 样本长程模型矩阵或 UI 浏览器旅程；复用范围和逐文件差异见 [接管层增补身份比对](evidence/v011/release/profile-engine-identity.json)。对应 [文件身份比对](evidence/v011/release/runtime-identity.json)、[性能数据](evidence/v011/performance/scale-7331.json)、[聚合质量结果](evidence/v011/release/cohort-gates.json)。

## 适用范围

in-place 对无可缩减保留输入仍可能安全停止，默认 windowed 用于长任务。宿主已 claim 但尚未落日志的输入在 pre-step 异常后不保证自动重发。物理 provider 溢出须区分受控错误注入与实际容量触发；后者在实际触发前保持 NOT EXERCISED。Node/DSH peer 支持面不扩大，公共 npm 发布是独立动作。


## 失败路径与安装身份补充

静态模板错误现由宿主 loader 在 Web 启动前拒绝，带 CONTEXT_INVALID_CONFIG。修正配置后首个及后续请求恢复。它与“已启动进程中接管失败后恢复 Basic”是两个不同阶段；真实 Web 故障注入已验证 ARC 初始化失败时两次请求都使用 Basic，并输出 CONTEXT_TAKEOVER_FALLBACK。

首轮安装包诊断发现 pnpm profile 与宿主载入不同的外部 dsh-llm 模块实例；本地 loop 通过的 LlmError 子类在 Web 中仍被 instanceof 判为 UNKNOWN。修复通过公开 Loader.import('@deepseek-ai/dsh-llm') 解析宿主模块来构造 runtime 错误，不使用安装绝对路径或 Node 内部 loader。新安装包已验证 CONTEXT_ENVELOPE_TOO_LARGE 写入 turn/end，provider 请求数为0。详见 [Web 失败路径](evidence/v011/live/patch-smoke.json)。前两次诊断失败证据保留，包含一次错误的“无效配置仍应启动 Web”测试预期以及真正的错误类身份问题。

本地最终文件为 `artifacts/dsh-context-management-0.1.1.tgz`；npm pack 正常 prepack 执行了全部检查，40个分发文件。NodeNext 消费者类型检查、全新 npm ci/check、SIGKILL 恢复和安装/卸载生命周期通过。npm audit 的原始非零退出保留：1项 low 级开发依赖问题，无 moderate/high/critical，未为规避报告而放宽宿主精确依赖。


目标 profile 全原生 Basic 接管及 minimal 调查结论见 [PROFILE-COVERAGE-0.1.1.md](PROFILE-COVERAGE-0.1.1.md)。
