# 夜间快速迭代 5（2026-09-15，换窗统筹与串行模型下的实验设计）

[English](ITERATION-NIGHTLY-5.en.md) · [上一轮（候选 10）](ITERATION-NIGHTLY-4.zh-CN.md)

## 结论先说

三个问题的实测答案：

1. **统筹**：换窗本身没有模型参与，是一次**模型无关的确定性替换**；因此不存在"一边换窗一边并行做摘要"的两条腿——只有一条腿。留档证据显示，94 次窗口替换**全部**是 `trigger=pressure, seed=extractive`，模型在所有留档运行里 **一次都没有调用过 `new_context({handoff})`**（`compress` 调用 26 次）。也就是说"模型写 handoff"这条路径从未被使用。
2. **速度**：替换链路（`frozenPrefix` + 用户历史索引 + 精确记录索引 + 共享事务 + 落盘）实测中位 **36 ms / 184 ms / 1479 ms**（200 / 2000 / 20000 条消息）。索引装配本身只有约 10 ms（20k 时 16.4 + 3.1 + 3.0 ms），大日志的余量来自事务与日志 flush。相对原生 Basic 每次摘要 **68–186 秒**的独立 LLM 调用，快 2–3 个数量级。
3. **上下文长度**：替换后新窗口 = 一个 4096 字节的抽取式索引（最近 24 条用户历史摘要 + 工具结果里的精确结构化记录）+ **完整保留的近期步骤**（`frozenPrefix` 保护最新用户输入与最近工具配对，不进入被替换前缀）。实测 4 次换窗后仍能逐字答对，说明"索引 + 保留近期 + 可逆检索"这条组合是成立的。

## 我尝试的优化与它被证伪的过程

按"换窗前请求模型写 handoff"的思路，我在普通档 nudge 里加了一行：

> Turnover prep: this window is replaced automatically at the emergency line. Before then, call `new_context({handoff})` once with goals, constraints, verified facts and next actions — the handoff is merged into the replacement seed. Without it the seed is extractive and thinner.

**实验（同一构件、提示覆盖做 A/B）**：F3 / 91503 / 24 页 / 32k 压力，全程真实读取。

| 臂 | nudge 含准备行 | `new_context` 调用 | 模型协助换窗 | 抽取式换窗 | 读页耗时 | 总耗时 | 质量 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 控制 | 否 | 0 | 0 | 4 | 116 秒 | 560 秒 | 24/24、6/6、逐字 3/3 ✅ |
| 处理 | 是 | 0 | 0 | 4 | 230 秒 | 496 秒 | 24/24、6/6、逐字 3/3 ✅ |

处理臂的 nudge 事件经核对**确实包含**该提示（`ARC 82% ... Turnover prep: ...`），模型仍然没有调用 `new_context`；两臂都保持 4/4 抽取式，质量都满分。**该提示没有可测量的收益，已撤销，不进入产品**。控制/处理耗时差异来自模型自身波动，不能归因于提示。

这一否证给出的设计结论是：**在本地串行模型上，不能把换窗质量寄托在模型"最后一刻自愿写 handoff"上。** nudge 触发在 82%（应急线 90%），每轮最多一次，留给模型的窗口本来就很小。

## 三种方案的代价对比

| 方案 | 换窗关键路径 | 种子质量 | 实测证据 |
| --- | --- | --- | --- |
| 确定性抽取（当前） | 36–184 ms（200–2k 消息） | 4096 字节索引，78% 标记 `incomplete` | 本页延迟基准；6 次窗口替换的种子文本 |
| 模型在环内写 handoff | 0 额外调用 | 取决于模型配合 | **0/4 采纳**，跨全部留档 0 次 `new_context` |
| 换窗时另起一次模型摘要 | +68–186 秒/次 | 更丰富但不可逆 | 原生匹配臂：占模型时间 87% / 91%，两次都未完成 |

串行模型下"并行摘要"在物理上不存在：要么占用同一轮的输出（在环内写），要么排进关键路径（另起调用）。上面的数据说明：**保持确定性快换**是目前唯一被证据支持的方案。

## 串行模型下如何验证（协议）

并发无法测量，所以实验必须测量**关键路径**而不是重叠度：

1. **臂**：(a) 仅确定性种子；(b) 确定性种子 + 换窗时一次独立摘要调用；(c) 确定性种子 + 在**第一次** nudge（而非临门一脚）就请求 handoff，并允许跨多轮重试。
2. **固定**：同夹具、同压力、同边界、同探针；一次只跑一个；串行模型下把"秒数 + token 数"直接当成本。
3. **采纳度**：统计 `new_context` 调用数与 `model-assisted` 换窗占比（`tests/live/local-audit-turnover.mjs`）。
4. **连续性探针**：换窗后各问一次"换窗前建立的事实"——一次只靠种子可答，一次只有原文可答——分别计分并记录检索次数。
5. **成本**：每个换窗的读页秒数、模型秒数、token 数。
6. **判据**：报告"每多花一秒关键路径换来的连续性增益"，而不是任何并发指标。

## 交付与限制

本轮**没有产品改动**：被证伪的提示已撤销，重建后的构件与候选 10 逐字节相同（入口 `8840d4c7…`，包 `359f7432…`）。新增只在测试工具层：`tests/live/local-audit-turnover.mjs`（换窗统筹审计）、`tests/live/local-bench-turnover-latency.mjs`（换窗延迟基准）；记录为 `.test-runtime/nightly-20260915/turnover-orchestration-design.json`、`turnover-orchestration-audit.json`、`turnover-latency.json`。

限制：延迟基准的 20k 消息是合成上界，且包含日志 flush（宿主持久化成本，不是插件索引成本）；换窗延迟的相位拆分没有把 flush 单独隔离；A/B 是单样本，质量两臂都满分因此无法区分；模型只测了本地 Qwen3.8-27B。

## 复现命令

```bash
# 换窗统筹审计：触发方式、种子模式、模型是否准备 handoff
node --import tsx tests/live/local-audit-turnover.mjs

# 换窗延迟：确定性替换的端到端耗时
node --import tsx tests/live/local-bench-turnover-latency.mjs

# 串行模型下的换窗准备 A/B（同构件，提示覆盖）
npm run test:live:local -- --name=<unique> --arm=C400_WINDOWED --family=F3 \
  --seed=91503 --pages=24 --pressure=32000 --batch=6 --concise=true
```
