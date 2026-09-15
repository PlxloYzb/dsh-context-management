# 可靠性：Basic 替代与 Harness 配合

[English](RELIABILITY-HARNESS.en.md) · 2026-09-15 · DSH 0.1.2-rc.1

## 结论与含义

在本轮覆盖的宿主与预设上，插件接管的是 **Basic 原有的服务位置**。原 Basic fiber 被释放，四类自动监听器撤销，ARC 使用同一个隔离 realm 的服务符号。原生 `/compact` 消费者解析到同一 ARC 对象，原生工具结果 pruner 继续存在；无需修改这些消费者或 preset 文件。

因此，“把 Basic 拔下来”在运行时已经成立。宿主依赖目录中的 Basic 包仍保留，供未启用插件的 profile、其他预设和卸载恢复使用。服务替换不要求删除这个宿主依赖。

本轮发现并修复了首次成功接管之外的生命周期缺口；这不是所有环境都已可靠的证明。

## 并行工作与集合点

先并行开展三个独立分支：真实组件替代契约、Harness 生命周期/接口审计、私有 profile 的 CLI 安装卸载。主分支同时建立安装后 Web 验证。第一集合点保留失败并修复；第二集合点将完整 dist 文件哈希绑定到最终安装包，复测各分支。模型实验以两个短臂并行开始，检查结果后再运行共享插件 profile 的第三臂。

| 验证线 | 实际验证内容 | 证据层级 |
| --- | --- | --- |
| 替代契约 | 真实发布的 Basic、Cordis、Loader、Include、AgentRegistry、AgentPresets；同符号替代、监听器释放、嵌套 Include、改名/占用 ID、切换/启停/重载、外部补丁保留 | 自动回归；组件字节与 pinned host 对照 |
| Harness | 真实 AgentLoop/CommandRuntime 的安全边界、维护互斥、工具配对、取消/销毁、steer/队列、预算、overflow/pruner、JSONL 重启与 fork | 既有集成回归；不把重叠子集重复相加 |
| 包生命周期 | 安装 ARC → 卸载并重启 Basic → 再装 ARC；bundle 只在目标 profile 启用；其他 profile 与 preset 哈希不变 | 实际 pinned DSH CLI + Web；全局 `llm/stream` 为 0 |
| Web 原生入口 | standard/ptc/cordis 单一 ARC、零活跃 Basic、零根层服务泄漏；minimal 无压缩；原生 `/compact` 写入真实 summary；空会话切换后立即可用；进程重启 | 8 个状态检查 + 5 次真实 Muse minimal 会话请求 |
| 三臂模型门 | Basic、ARC 原地、ARC 换窗/后台摘要；实际压力、工具调用、事实/纠正/逐字探针、重启与原文归档审计 | 同一短夹具的真实 Web/model 样本；不是统计性胜负比较 |

## 被失败驱动的修复

1. **晚启用漏掉已有 Agent**：启用时通过宿主 AgentRegistry 枚举已有会话，复用同一接入逻辑。反复启停同一 Agent 不累积监听器。
2. **把首次结果缓存成永久结论**：仅对进行中的操作去重；后续边界核验当前实际 backend。首次没有 Basic、后来才加载，或先接管再由外部重载回 Basic，均能重新接管。
3. **保留错误处置的边界**：已确认恢复的 Basic 对象继续服务，避免每次请求重试失败切换；无法确认回滚的相同 backend 持续返回 `CONTEXT_BACKEND_UNAVAILABLE`，不能第二次请求就误放行。
4. **回滚读取过期配置**：宿主同路径 Include 更新只改变实际树的 config，`fiber.config` 可能仍旧；跨路径重启后的 registry 树也可能旧。首次接管读取实际提供者的 Include；随后由桥拥有的 Loader 更新观察器在 `next()` 成功后记录已提交配置，回滚移除自己的补丁并保留外部配置。验证包括当前没有 backend、外部更新失败、跨路径后再同路径更新。
5. **静态 YAML 审计误报**：识别行尾注释与常见布尔型内联 isolate 映射，避免把合法实际挂载说成不兼容。该工具仍是文本启发式；复杂 YAML、别名和跨文件关系以运行时树审计为准。

## Harness 仍负责什么

原生 CommandRuntime 负责 `/compact` 的调用、取消与命令回执；ARC 实现原有 `compactNow` 服务接口，并使用宿主维护互斥及共享事务写入。AgentLoop 负责 pre-step 和请求错误边界；ARC 在这些边界处理压力与换窗。TokenMeter、Session 的投影/持久化，以及原生 pruner 继续由宿主提供。历史检索和延后摘要交付由 ARC 提供，并遵守同一生命周期。

Web 冒烟观察到 standard/cordis 的五个上下文工具正常提供，ptc 保留宿主的 `run_code` 工具呈现方式，minimal 不出现上下文工具。这里没有把 ptc 的工具清单检查算成完整 PTC 编程执行验证。

## 最终候选结果

完整 prepack：**188 单元 + 133 集成 + 15 可靠性 + 22 实验工具 = 358 项通过**，类型检查和 42 文件发行审计通过。三个真实模型臂都完成，均通过重启、24 页实际曝光和归档原文字节审计；质量结果分别保留如下。

| 臂 | 压缩次数 | 事实 / 纠正 | 最终交付结构 | 逐字探针 | 请求 / 上报 token | 总耗时 |
| --- | ---: | --- | --- | --- | --- | ---: |
| Basic，匹配触发/保留阈值 | 4 | 24/24、6/6 | 通过 | **1/3** | 22 / 520,911 | 101 s |
| ARC 原地 | 3 | 24/24、6/6 | **失败：eventOrder 为空** | 3/3 | 14 / 378,348 | 71 s |
| ARC 换窗 + 延后摘要 | 4 | 24/24、6/6 | 通过 | 3/3 | 28 / 727,390 | 76 s |

原地臂的离线诊断：PAGE-2 已真实曝光完整事件顺序，归档字节可恢复；facts-probe 轮没有任何工具调用，模型输出了空数组，后续逐字轮才使用检索。因此这是有效的模型输出失败，不能改判通过，也没有证据把它归咎于归档丢失或断言模型记忆丢失。

换窗边界为 **24–31 ms**，实际追加摘要 **2 次**；一项摘要跨窗后就绪，一项换窗前已就绪，追加均不再改变 generation。另有 **1 次重启中断**并产生明确 unavailable 通知。每个会话内前台串行、后台最多 1 条、总计最多 2 条流，前后台宿主流累计重叠 28.112 s。

本次自然任务没有调用 `await_context`，另有一个后台 operation 缺少观测到的 pending-window 回执，审计分类仍为 `partially-covered-with-natural-uncovered-work`，未算成交付。回执结构检查通过并不等于每项预取都已被使用。上报 token 也不等于完整账单，中断流可能缺少 usage。

最终包 SHA-256：`cfab61d84d5fedd8a0eaa4627cf054778a77fc7152436eb251467b3abc7f1127`；34 个 dist 文件的排序清单哈希：`799151fdada17114c8c818431cddee7705bc882c4d044719d07439db6023e96b`。Web、两个插件模型臂和实际安装的完整 dist 一致；Native 记录同候选标识用于配对，但不加载插件。实验 profile 已装上这一构件，未发布 npm。

## 复现与证据

使用 pinned `.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh`。模型全部为 `opencode-go-muse/muse-spark-1.3-contributor`、`minimal`。不要使用全局新版 dsh。模型执行器使用私有 settings 副本；未更改日常 web/headless 默认配置。

```sh
npm run test:reliability
node tests/reliability/package-lifecycle.mjs unique-lifecycle-name
node tests/reliability/web-contract.mjs unique-web-name
# 各臂使用唯一名称；先并行下列两条，再检查结果。
node tests/live/local-short.mjs --name=unique-window --route=muse --arm=C400_WINDOWED --family=F3 --seed=91543 --pages=24 --pressure=32000 --batch=6 --concise=true --restart=true --background=true --prepare=0.6 --cost-control=observe --port=3312
node tests/live/local-short.mjs --name=unique-native --route=muse --arm=A_NATIVE --family=F3 --seed=91543 --pages=24 --pressure=32000 --batch=6 --concise=true --restart=true --matched-native=true --cost-control=observe --port=3311
node tests/live/local-short.mjs --name=unique-inplace --route=muse --arm=B_IN_PLACE --family=F3 --seed=91543 --pages=24 --pressure=32000 --batch=6 --concise=true --restart=true --cost-control=observe --port=3313
```

生命周期脚本创建独立 DSH_HOME；Web/model 使用保留的实验 profile，须先安装与当前完整 dist 一致的构件。运行名不可复用，失败输出保留。原始记录位于 `.test-runtime/reliability-20260915/` 与 `.test-runtime/nightly-20260915/reliability-*-91543/`；公开汇总见 [JSON](data/reliability-harness-2026-09-15.json)。

本轮保留的测试/环境失败包括：Web 观察器最初漏计 ARC 行，修正筛选后复测；同路径同版本 tarball 重装被包管理器视为无需更新，完整 dist 校验在任何模型请求前拦下，改用带内容哈希的构件文件名重新安装。CLI 首次探测引发的 Corepack 自动 packageManager 写入已撤销，执行器关闭自动写入并切到私有工作目录。没有把这些失败覆盖为通过。

## 限制

仅验证 DSH 0.1.2-rc.1 和 Muse minimal 的短合成会话；未覆盖长时间压力运行、所有第三方插件或其他宿主版本。包生命周期中的第三方行是重新导出 Basic 的别名夹具；它证明官方包名守卫不会误接管该行，不能代表所有供应商实现。热启停回归在安全的空闲/请求边界执行，未声称覆盖任意模型流或工具执行中途的包卸载。模型样本每臂一个，并行服务竞争可能影响耗时，不能据此推断一般质量或延迟优势。摘要未在换窗瞬间就绪不算失败；交付以实际后续边界和持久化回执为准。
