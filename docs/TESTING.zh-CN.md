# 测试数据与复现

[English](TESTING.en.md) · [返回首页](../README.md) · [完整汇总 JSON](data/results-0.1.1.json) · [27 个模型样本 CSV](data/model-samples-0.1.1.csv)

最新验证见[可靠性与 Harness 接管报告](RELIABILITY-HARNESS.zh-CN.md)。下一阶段的[长程 3M 实验执行协议](EXPERIMENT-LONGRUN-3M.zh-CN.md)与[机器计划](experiments/muse-longrun-v1.plan.json)已完成设计，尚未执行；其中包含多窗、多摘要、长尾历史、原生 Basic 对照和全过程监督要求。

400k 实验已于 2026-09-12 收束，见[终局报告](EXPERIMENT-REPORT.zh-CN.md)；后续修复见[150k 迭代](ITERATION-150K.zh-CN.md)与[夜间快速迭代](ITERATION-NIGHTLY.zh-CN.md)、[第二轮](ITERATION-NIGHTLY-2.zh-CN.md)、[第三轮](ITERATION-NIGHTLY-3.zh-CN.md)、[第四轮（对抗性自查与原生对照）](ITERATION-NIGHTLY-4.zh-CN.md)、[第五轮（换窗统筹与串行实验设计）](ITERATION-NIGHTLY-5.zh-CN.md)、[Muse 双路验证](ITERATION-MUSE.zh-CN.md)、[引擎实现](ITERATION-MUSE-ENGINE.zh-CN.md)、[双 Muse minimal 云端验证](ITERATION-MUSE-CLOUD.zh-CN.md)、[跨窗异步交付与按需等待](ITERATION-DEFERRED-HANDOFF.zh-CN.md)。本页下方数据与模型命令保留为 0.1.1 发布时的历史证据，不代表最新候选重跑结果。

测试日期：**2026-09-08**。插件版本 **0.1.1**，宿主 **DSH 0.1.2-rc.1**。以下区分本次发布检查与此前的模型、预设及规模测试，避免把历史数据说成本次重跑。

## 自动化与真实宿主

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 单元回归 | 184/184 | 预算、事务、工具配对、归档、窗口及取消等 |
| 真实宿主集成 | 50/50 | 安装的 DSH 模块及 agent loop；包括受控错误注入 |
| 类型检查与构建 | 通过 | TypeScript strict、ESM、声明文件 |
| 包名安装与卸载 | 通过 | 隔离 `DSH_HOME` 下执行 README 中的两条原始命令，验证 Web 原生命令和卸载恢复 |
| 预设生命周期 | 24/24 | 8 种预设，每种首次请求、重启、卸载各一次；历史候选包 |

包名测试使用本地回环 registry 提供候选包，其余依赖由公共 npm 提供，不使用模型凭据。它验证完整包名安装流程；不是对公共 npm 下载可用性的替代。公共 npm 的 0.1.1 tarball 已另行下载并核对，与此前通过安装检查的归档逐字节一致。各归档 SHA-256 和本次检查记录见 [发布检查 JSON](data/release-checks-0.1.1.json)。

预设覆盖 `standard`、`ptc`、`cordis`、`minimal`，以及重命名、嵌套、首次请求前切换、启动后加入的四类自定义预设。除 `minimal` 以外的七种预设含有 Basic，由插件接管，卸载后恢复 Basic；`minimal` 始终没有压缩后端。

## 模型对照实验

实际路由为 **opencode-go / glm-5.3-flash**。三个固定种子 `1701 / 2903 / 4307`，每种运行 3 次，每组 9 次，共 27 次。每个任务有 12 个精确事实、8 页合成遥测和 2 项后续更正。要求模型从会话或归档中恢复事实，不允许重新读取工作区文件；允许历史搜索和原文取回，因此这是任务级召回测试，不是模型无工具记忆测试。

| 策略 | 完成运行 | 重启前精确召回 | 重启后精确召回 | 重启后保留两项更正 | 原文完整取回 |
| --- | --- | --- | --- | --- | --- |
| A：宿主 Basic | 9/9 | 108/108 | 108/108 | 9/9 | 9/9 |
| B：插件 in-place | 9/9 | 108/108 | **98/108** | **4/9** | 9/9 |
| C：插件 windowed（默认） | 9/9 | 108/108 | 108/108 | 9/9 | 9/9 |

C 组每次至少产生 3 次实际换窗。B 组完成了流程，但并未通过所有质量指标；原文可取回与模型答对是两件事。更早的候选失败记录保留在 Git 历史中，不纳入这张明确指定候选批次的 27 样本表。汇总 JSON 保留每个样本的配置、成绩、时间、语料哈希和原始报告出处。

B/C 使用 32,768 token 的逻辑窗口配置、8,192 的输出预留、4,096 的安全余量。A 使用宿主阈值机制（测试阈值比例 0.018432、保留 4,096），预算机制不相同。JSON 中包含模型用量总和及缺失字段计数，**不据此主张成本更低或更快**。27 个固定合成样本不能推导通用准确率、统计显著性或其他模型表现。

## 历史规模测试

Apple M4 Pro（14 个逻辑 CPU、24 GiB 内存），macOS Darwin 25.4.0，Node.js 22.23.1，512 MiB 堆上限；单次种子 `7331`。

| 项目 | 测量值 |
| --- | --- |
| 事件 / 归档 / 窗口 | 100,001 / 1,100 / 100 |
| 冷加载 | 440.12 ms |
| 搜索 p95 / 最大耗时 | 17.10 / 22.67 ms |
| RSS / 已用堆 | 289.61 / 114.90 MiB |
| 预先取消的调用 | 0.146 ms |

取消数据测量的是已取消信号，不是长时间同步扫描中途被抢占。这是单机合成规模测试，不是生产吞吐承诺。

## 证据版本与边界

模型候选包 SHA-256 以 `cf655cc8` 开头，预设矩阵候选包以 `fa96ed73` 开头。两者间仅 bridge 和文档等文件变化，历史文件逐字节比较确认引擎与依赖未变；bridge 独立完成 24 项生命周期检查。此后的清理仅调整源代码注释、测试脚本与文档。本次 GitHub 准备没有改变运行时逻辑，也没有重跑 27 次模型调用。完整哈希及原始报告的提交、路径、SHA-256 在 JSON 中。

真实供应商物理上下文溢出 **未触发验证**；受控 loop 溢出测试不能替代它。其他宿主版本、模型、HMR、无限层级嵌套不在这些数据的覆盖范围。历史检查还记录了：静态配置无效会阻止宿主启动；pre-step 失败时，宿主不保证把已认领但尚未记入日志的输入自动重新排队。

## 复现

基础检查不调用模型：

```sh
npm ci
npm run check
npm run test:release
npm run test:install
npm run test:performance
```

`test:install` 需要已安装的 DSH 0.1.2-rc.1、网络及包管理器；它自行创建并清理隔离 profile。原始输出写入被 Git 忽略的 `.test-runtime/`。

完整三组实验需要自行配置测试用 DSH 环境中的模型路由和凭据，并会产生模型调用费用。脚本创建独立命名的 profile，不改日常 profile 默认值；使用测试专用的 `DSH_HOME`，不要把认证配置或原始 Web 日志上传到仓库：

```sh
node tests/live/gates.mjs rerun-001
```

语料和评分逻辑在 [fixture.mjs](../tests/live/fixture.mjs)，模型流程在 [run.mjs](../tests/live/run.mjs)。生成的新报告代表新实验，可能与这里的历史结果不同。

- [Muse background engine / 后台摘要引擎](ITERATION-MUSE-ENGINE.zh-CN.md)
