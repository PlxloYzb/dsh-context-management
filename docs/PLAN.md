# v0.1.0 实施计划

配套 [SPEC.md](SPEC.md)。**已完成源码、本地发行包及 G1–G7 验收，结果见 [RELEASE.md](RELEASE.md)。** 下列标记按实际证据更新；宿主历史 smoke 不代替新插件验收。

## P0：先证明集成前提 → G1

- [x] 本仓库建立 TypeScript strict/ESM 项目与新项目 AGENTS；ARC/Codex 只读参考，保留现有 docs 与证据。
- [x] 按 source-manifest 钉住 DSH 0.1.2-rc.1 依赖与 lock；peer 首发只声明实测线，不先放宽到未经测试的历史版本。
- [x] 新建 Web RPC driver：启动认证、slash endpoint、payload.args、requestId、cursor 与分页；本次 smoke 仅作协议样例。
- [x] 真实 Loader/Include 证明停 Basic → 挂 engine → 实际 resolver 校验 → 回滚；覆盖 session/create 后立即 prompt。
- [x] 真实文件持久化/重开验证扩展元数据保留，不能只用 TypeScript 类型断言。
- [x] 固化 projectedTokens 无二次扣减与 heuristicTokens 定价测试。

退出条件：以上均通过。若必须改 DSH 安装文件才成立，先修订集成方案，不能直接宣布兼容。

## P1：选择性移植 ARC，修正宿主差异 → G2

采用显式文件清单复制候选 src/tests、LICENSE/NOTICE，并记录来源。不全仓 rsync 覆盖 docs，不删除 lock 后顺带升级所有依赖。旧研究结果保留其版本和路由标签。

| 工作包 | 候选源 | 必须改造 |
|---|---|---|
| Host adapter | index/governor/window/fallback | 投影、heuristicTokens、路由失效、取消、overflow 重试 |
| Range engine | region/messages | surface 位置序、工具配对、最新请求保护、pruner 来源 |
| ARC adapter | state/config/tools | 不将 window 档案合成为 kernel block，热/冷一致 |
| Ledger | region | summary 与 checkpoint 关联、孤儿状态、版本和循环校验 |
| Seam | index/commands | 三接口、maintenance、错误分类、flush、自有自动 hooks |

退出条件：算法及真实宿主集成测试通过；生产代码没有硬编码安装路径或私有 import；持久写入集中在事务服务。

## P2：安全换窗与任务延续 → G3/G4/G5

- [x] window-controller、handoff、budget-policy 与宿主 glue 分离。
- [x] new_context 登记 pending，下一 pre-step 在工具配对闭合后提交。
- [x] 最新用户 fence、checkpoint lineage 与最大安全前缀有确定算法。
- [x] generation、windowId、operationId 与扩展 schema；重启、fork 身份测试。
- [x] 同步相邻写 summary + replacement；end/flush 分阶段故障注入。
- [x] checkpoint 的目标/约束/进展/下一步及来源有预算，截断标 incomplete。
- [x] 每窗提醒、换窗目标、无进展停止、单次 overflow 重试。

退出条件：换窗、故障恢复、安全测试全过；模型说“已换窗”不算证据，必须检查实际 replacement 和后续请求。

## P3：有界检索与恢复 → G3/G5

- [x] 同一来源解析器处理 raw、ARC tier、window parent 与 pruner 原件引用。
- [x] ID 歧义、query 校验、cursor/session 归属与预算限制。
- [x] 增量内存索引；不每 pre-step 拼接全日志；冷建可取消。
- [x] 文本分页拼接精确相等；附件与 spill 缺失显式返回。
- [x] /context、迁移别名、帮助、状态与错误码。

P2/P3 可交错，但自动换窗长会话必须在检索恢复已就绪后验收。

## P4：必须真实 Web 验证 → G6

按 [TESTING.md](TESTING.md) 执行原生 Basic、新插件 in-place、默认 windowed 三组同机同模型对照。先用逻辑窗口 32768 做控制路径测试，再以实际容量完成代表性长会话。

- [x] 连续至少两次换窗，盲查早期独有事实，保留最新用户更正。
- [x] 忽略 nudge、工具结果增长、大块恢复、取消、重启、双会话隔离。
- [x] 从 tarball 安装；首请求已使用新后端。
- [x] 记录请求实际 provider/model；不 fallback 到其他模型，连接失败如实记录。
- [x] 物理 overflow 与逻辑阈值触发分列；未观察 provider 硬溢出就不宣称该项真实通过。
- [x] Web UI 命令、状态和恢复操作检查；RPC 不代替 UI 交付检查。

退出条件：硬门全绿、指标可复算。修复后重跑受影响门与必要对照，不以旧 ARC 基准替代。

## P5：收敛到可用 0.1.0 → G7

- [x] 中文安装/升级/卸载/配置/故障文档与代码一致；英文概览可同步，16 语言不是首发门。
- [x] npm ci、typecheck、test、build、pack 与定义好的 integration/live gate。
- [x] tarball 包含运行产物、声明、patch、README、许可；排除 .codegraph、私密日志与密钥。
- [x] 隔离 profile 安装真实产物、完成最小旅程、卸载、重启，记录 resolver 与 preset hash。
- [x] 版本 0.1.0，依赖/源码复用清单与 NOTICE 完整，新 changelog 只描述本产品。
- [x] 最终验收报告关联每个 G 的脚本、commit、路由、时间、输出、失败次数与限制。

退出条件：可交付 dsh-context-management-0.1.0.tgz。公开发布另行处理，不附带旧包 deprecate 或仓库改名。

## 审查顺序与风险关闭

按“骨架/依赖 → 宿主适配 → ARC 移植 → 日志/恢复 → 换窗 → 检索 → Web → 发行”分可审查变更，每份同步行为说明和必要测试，不以固定 commit 数代表完成度。

| 风险 | 关闭证据 |
|---|---|
| 异步接管/卸载竞态 | pending promise 被追踪；disposing 后不再注册；首请求和并发创建测试 |
| 压力低估 | 多轮压缩、usage 刷新、model switch 的新宿主投影对照 |
| 元数据被保存层剥离 | 真实存储 round-trip |
| checkpoint 已生效但 end/flush 失败 | 重放同 surface/generation，不重复换窗 |
| pruner 遮蔽原文 | sourceEventSeqs 回溯或 incomplete |
| window 与 kernel block 混淆 | 显式 kind，热/冷重建相同 |
| 长会话性能或恢复撑爆 | 大日志性能、分页、取消、heap 与输出上限 |

最终产物与实际模型测试为同一 SHA-256；三臂 27 个样本完整保留，C 组首轮及重启后均为 108/108。公开 npm 发布仍为独立事项。
