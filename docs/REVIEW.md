# 答卷：现有文档是否足够支撑 v0.1.0

审阅日期：2026-09-07。结论：**原有两份文档有工程参考价值，但不足以直接开发和验收用户要求的 dsh-context-management v0.1.0；有数项会导致错误实现的规格，需要重写而非补充措辞。** 本次已完成重新制定文档与关键宿主事实验证。插件本身尚未实现。

## 1. 原文的价值与限制

原 SPEC/PLAN 已覆盖 ARC 模块、preset bridge、可逆日志、换窗设想和分阶段移植，比只有产品愿景更具体。但它的主线是“旧 ARC 改名为0.3.0-beta.1”，包含不可重议的旧决策、旧性能宣传、16语言同步、旧包弃用与仓库改名。这不等同于本次要求的新产品0.1.0。

原件逐字保存在 [archive](archive/README.md)，文件hash进入 [source-manifest.json](evidence/source-manifest.json)。新文档使用事实/设计/待验证三种状态，不将原草案的“已拍板”视为本次用户授权。

## 2. 会阻碍实现的发现

P0表示先修正文档/契约再开发，P1表示首发前必须关闭。这里的优先级针对拟移植方案，不是在宣布旧ARC所有历史宿主都有同一bug。

| ID | 级别 | 原草案问题 | 本次证据与改正 |
|---|---|---|---|
| F01 | P0 | 目标0.3.0-beta.1、包级更名，且“不发布stable” | 用户明确要求新包0.1.0；已重设产品边界与发布门，取消自动弃用旧包 |
| F02 | P0 | 升级宿主后沿用全账本shadow扣减，称与Codex增长预算同效 | DSH新投影已扣减；纯宿主探针10000→7084，旧公式误变4084；直接读新投影 |
| F03 | P0 | 只要求用host token meter，没有区分node价格 | 新宿主nodes.tokens为路由价格，heuristicTokens才是shadow协议价格；ARC fallback当前取tokens，需修正 |
| F04 | P0 | new_context工具内立即冻结全窗，并称比Codex异步消费更强 | Codex handler只提交请求；工具结果尚未落账时不可冻结自己的call；改为pending→safe pre-step |
| F05 | P0 | “完整冻结”“新窗干净”，范围选最大或并集留给实现 | ARC范围函数跳过最新用户与checkpoint；没有等价全窗算法；明确最大安全前缀与最新用户fence |
| F06 | P0 | 四事件称“单事务”，但账本只读summary即可 | ARC rebuildBlockLedger会纳入无replacement的summary；append不是ACID，新增prepared/applied/flush不确定矩阵 |
| F07 | P1 | 档案不进kernel即可复用原state重建 | ARC rebuildKernelBlocks给无kernelBlockId项自动合成bN；新增显式kind和独立重建 |
| F08 | P1 | decompress等于全部原始事件逐字节还原、整窗无界回灌 | 当前工具提取文本并加seq/summary包装，前缀ID取首个命中；限定text保真、ID歧义错误、预算分页 |
| F09 | P1 | search自动覆盖归档原文，没区分父checkpoint/prune | 当前search读direct shadowedSeqs，与decompress的递归来源并不相同；统一有效来源解析 |
| F10 | P1 | 停Basic只需保留pruner行，默认挂载测试足够 | 新Basic会主动调用pruner；新engine必须接手，追踪pruner原文；还要证明首请求接管与dispose竞态 |
| F11 | P1 | “官方没有compaction专页”并粗分公开/私有 | 当前官方reference有compaction专页；seam有文档，bridge模式仍需版本兼容验证 |
| F12 | P0 | Web实测可选，ARC旧driver直接复用 | 本机无认证API返回401；认证后旧点号路径404；新协议为slash+args，已写可运行smoke |
| F13 | P1 | 保留“质量4倍、输入节省47.6%”作新README素材 | 未在新包、此宿主、此GLM重测，不能继承；定义新三臂对照与成本口径 |
| F14 | P1 | 卸载零残留、不变格式与新增字段混写 | effect可撤销不代表删除历史；事件schema扩展也需版本化和真实存储round-trip |
| F15 | P1 | 源仓库AGENTS自动成为新项目最高规范 | 新项目还没有代码或AGENTS；源规则供参考，依赖线等必须重新制定，不覆盖用户本次目标 |

## 3. 关键结论的依据

### F02/F03：新宿主记账不能复制旧兼容补丁

在本机安装包中，contextPressureProjectionDefinition.stateVersion=4，P由provider样本加sample之后的surface差量构成；compaction/summary带的一次性shadow claim由相邻replacement消费。真实纯函数探针证实旧ARC公式会多减3000。此结论不仅来自注释。[探针与结果](evidence/projection-probe.json)

同包TokenSurfaceNode公开类型区分tokens和heuristicTokens。存在图片价格时两者可能不同，持久shadow应使用后者。原稿“用host meter”的要求不足以约束具体字段。相关源文件和hash见 [SOURCES.md](SOURCES.md)。

### F04/F06：可靠性来自安全边界和恢复协议

Codex new_context返回的是换窗请求；主循环在post-sampling边界做换窗。原ARC已有compaction事务封装，可借鉴其选择重校验与关闭/flush处理，但其四次append不构成数据库原子提交。必须根据实际replacement判断surface与generation，不能只看到summary就认为冻结完成。

这也是新设计没有承诺“新窗完全空白”的原因：最新用户请求、配对尾部与宿主当前指令必须继续存在。换窗本质是工作集替换，不是丢弃任务环境。

### F08/F09：可追溯、文本恢复、任务记忆是三件事

日志原件保留可独立核验；文本可精确分页回读；模型能否据此完成任务需要真实模型测试。当前decompress还原文本并非把原事件结构/附件逐字节回放；当前search也不是通用递归档案搜索。新规格分别测试三层，而不以一次字符串命中声称全部可靠。

### F11/F12：官方reference和已安装代码同样重要

当前 [官方compaction参考](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/compaction)已经列出三接口、持久化和工具结果pruner。已安装0.1.2-rc.1的Web Remote协议也与ARC旧research driver不同。本次通过源码核对修正驱动后，使用指定模型得到两个成功真实会话；详情见 [VALIDATION.md](VALIDATION.md)。

## 4. 组合方案的选择

采用“**DSH承载运行与事实日志，ARC承载模型压缩与来源恢复，Codex启发窗口控制和当前任务延续**”的结构。

不直接移植Codex的专有服务：本地快照context_management仍受特性、模型和身份能力门控，无法因拥有Rust源码就保证在GLM上可运行。也不把新包只做成ARC改名：新宿主投影、换窗状态机、递归检索、预算恢复与验收都需要实质改造。

本次作者决定默认windowed，保留显式in-place。这个决定服务于新产品目标；默认windowed必须通过验收才发布，不能以“先默认旧行为”规避主要能力缺失。

## 5. 本次完成了什么，哪些尚未证明

已完成：旧文档审阅和保留、两个参考库的Codegraph探索及定点源码核验、官方最新页面核对、本地DSH版本/依赖核验、真实Web认证与指定模型会话、纯投影差异探针、v0.1.0整套规格与验收计划。

尚未完成：新插件代码、真实bridge迁移、扩展元数据存储round-trip、插件连续换窗、真实provider硬溢出恢复、插件对照实验、UI交付测试、tarball安装/卸载和发布。这些清楚保留为PLAN与TESTING中的必做门，不以文档完成冒充插件完成。

对“文档是否足够细致可用”的最终判断：**原稿不够；本次重写后可作为有明确约束和验证门的开发基线。它不代表设计已被插件实现验证，最先应执行P0而非直接大规模复制代码。**
