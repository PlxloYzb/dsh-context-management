# 先换窗、后交付、按需等待

[English](ITERATION-DEFERRED-HANDOFF.en.md) · [脱敏数据](data/turnover-deferred-handoff-2026-09-15.json) · [测试索引](TESTING.zh-CN.md)

承接[双 Muse 阶段](ITERATION-MUSE-CLOUD.zh-CN.md)。上一阶段把“摘要没有赶上换窗”直接计作 late 并取消任务；这只能评价即时种子采用，不能评价隐藏等待。本轮采用新的成功判据：窗口及时推进，前台利用保留上下文继续工作，摘要在实际需要之前交付，或在依赖点等待剩余时间。

## 设计与预先确定的协议

- 前台和后台统一 `opencode-go-muse/muse-spark-1.3-contributor`、`minimal`，固定 DSH `0.1.2-rc.1`。每次只运行一个短样本，审查后决定下一项；成本只记账，仍保留请求、轮次与整项超时。
- 后台冻结有界历史快照，绑定会话、来源序列、哈希、路由。换窗仍通过共享事务立即提交确定性索引；在压力允许时只替换旧快照，保留快照之后的原文。
- 摘要可以跨越本引擎的换窗继续运行。完成回调只更新任务状态；Harness 在后续本来就需要执行的 pre-step 追加历史 handoff，宿主持久化 receipt 后才记 delivered。摘要不是第二次 replacement，也不额外计入压缩 shadow price。
- `await_context` 只等待当前会话跨窗的任务，返回状态；正文由下一次安全边界追加。可以继续独立工作，也可以用原文检索解决历史依赖。等待不持有窗口事务锁。
- pending 来源随窗口事务落盘，覆盖“换窗已持久化、通知未追加即重启”的缺口。取消、超时、来源失效、超预算有明确 unavailable 状态；交付失败通知获得宿主确认前不能被新任务覆盖。
- 摘要正文独立上限默认 4096 UTF-8 字节，追加时仍检查宿主 token 余量；不再与确定性索引争用同一段约 0.5 KiB 的尾部额度。历史内容不能覆盖更新的用户指令，逐字证据仍应检索原文。

```yaml
backgroundSummary:
  provider: opencode-go-muse
  model: muse-spark-1.3-contributor
  reasoningEffort: minimal
  allowSameProvider: true
  delivery: deferred
  maxSummaryBytes: 4096
```

后台功能仍须显式配置；`allowSameProvider` 默认 false。启用后台后 `delivery` 默认 deferred；`delivery: seed` 保留上一阶段的即时采用模式用于对照。未配置后台时不注册 `await_context`。本轮没有修改日常默认配置。

## 两条真实云端机制路径

最终短夹具含 18 页合成历史、44k 逻辑窗口、25% 准备线，以及不足宿主 8192 字符剪裁阈值的当前工具结果。执行器没有直接调用换窗或写入摘要；通过正常工具输出触发正式 governor。两项均为种子 91541，各运行一次。

| 样本 | 换窗 pre-step | 换窗提交到下个前台请求 | 摘要流耗时 | 依赖点等待 | 质量 / 检索 |
| --- | ---: | ---: | ---: | ---: | --- |
| independent-v5 | 17 ms | 14 ms | 9.18 s | 0 | 当前数据校验 1/1；无检索 |
| dependent | 20 ms | 15 ms | 7.76 s | 1.91 s | 历史字段 3/3；无检索 |

独立任务中，窗口提交后摘要又运行约 3.32 秒才 ready，前台已在执行当前数据校验。摘要在换窗后约 6.49 秒的下一边界追加；这段时间没有 `await_context`。依赖任务中，摘要在换窗后约 4.70 秒 ready；模型在中途到达历史依赖点，等待剩余约 1.90 秒，随后获得正文并答对三个字段。

依赖样本的实际请求也逐项核对：换窗后的第二个前台请求不含 owner、rollback、gate 三个值；等待后的第三个请求重新包含全部三个值。

两个样本均观察到同一任务的 pending → ready → delivered、一次真实 window、一次摘要 append，来源哈希、当前输入、工具配对及归档分页逐字节恢复通过。前台请求保持串行，最多一条后台流、两条总流。完成最终答案后没有为了交付摘要再唤起一次模型请求。

`pre-step` 是宿主前后钩子的区间，包含事务与落盘相关工作；“下个请求”是宿主流开始，不等于服务端首 token 或底层 GPU 并行。`await_context` 工具调用到结果的间隔包含少量工具开销，内部 promise 等待为 1904 ms。两个单样本证明机制路径，不证明普遍的延迟、质量或费用优势；依赖探针显式要求调用等待工具，尚未证明模型会在自然任务中自主选择正确等待点。

## 保留失败与由现场驱动的修复

| 样本 | 原结果 | 解释与处理 |
| --- | --- | --- |
| independent（初版） | 失败，零模型请求 | 两个测试 observer 的实验目录前缀不一致，宿主拒绝请求；修正夹具所有权校验。 |
| independent-v2 | 任务 1/1，未换窗 | 宿主把大工具结果 spill 后，64k 窗口未达压力线；不能算机制成功。 |
| independent-v3 | 任务 1/1，未 window 换窗 | 48k 下工具结果被原生 pruner 剪裁，随后旧降级逻辑多做一次原地归档；不算 deferred 成功。 |
| independent-v4 | 已换窗，轮次报错 | handoff admission 直接访问未声明注入的 token meter，被真实 Cordis scope 拒绝；改用已存在的 `ctx.get` 接口。 |

另修正测试证据读取：宿主 RPC history 是过滤视图，可能有 seq 缺口；审计改用 observer 保存的完整 session snapshot，要求从零连续，保留 RPC 视图而不填补或重编号事件。

v3 还发现正式引擎的既有问题：pruner 已把压力从 45394 降到 35996、低于 37670 应急线，窗口返回 `pruner-relieved-pressure` 后仍继续原地归档。现重测压力并结束本次处理；高压、overflow 和无安全前缀仍保留恢复路径。此修复不会把 v3 改判为成功，也不会让被无关 replacement 取消的摘要恢复。用小于原生剪裁阈值的结果触发窗口是新夹具的明确几何条件，没有关闭宿主 pruner。

## 真实 Web 三臂、回归与构件

统一 F3 / 91542 / 24 页 / 32k 压力 / 每批六页；原生 Basic 使用匹配的触发及保留阈值。窗口臂采用默认 60% 准备线和一次真实进程重启。所有真实前台/摘要请求为 Muse minimal，成本只记账。

| 臂 | 压缩 / 换窗次数 | 严格工具门 | 事实 · 修正 · 逐字 | 总秒数 | 请求数 | 报告 token |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| 原生 Basic | 1 | 通过 | 24/24 · 6/6 · **1/3** | 103 | 20 | 561386 |
| 原地压缩 | 3 | 通过 | 24/24 · 6/6 · 3/3 | 64 | 17 | 463351 |
| 窗口 + deferred | 4 | 通过 | 24/24 · 6/6 · 3/3 | 92 | 29 | 751372 |

三臂全部读完 24 页、交付物通过、归档字节恢复通过。原生逐字门失败，不能声称三臂全绿。原生压缩 pre-step 13.34 秒，原地 18–26 ms，窗口 20–32 ms。总耗时包含不同次数的模型调用与检索，不能据单个样本作普遍速度排名。

窗口臂的四次换窗都使用确定性种子，另有两次真实摘要追加：一次 pending 跨窗后交付、一次提前 ready 并在换窗后的同一边界交付。一个已跨窗任务在真实重启时中断，恢复后追加 `unavailable: interrupted`；还有一个 ready 任务的来源尚未离开当前窗口，未消费，保留成本。这些状态分别计量，不能继续只用种子 `model-assisted` 占比判断 deferred。

前台仍串行，后台峰值一条、总流峰值两条，前后台流生命周期累计重叠 45.39 秒；Web 样本没有 `await_context` 调用。receipt 来源哈希、追加时 generation 不变、去重与恢复通知审计均通过。自然任务中自主等待的条件本轮未覆盖；由独立的显式依赖机制探针覆盖工具等待路径。没有重启后重新发出丢失的摘要请求来掩盖中断。

机制成功样本的运行时入口 SHA-256 为 `e105896b9d2bf49b0b7ea7a2c31366d448bfb2c0e85cdaa5876382e240f45ecd`；随后加入 pruner 解除压力的最小修复，三臂使用最终入口 `7ae69d6ec21c69d36c3157d5ab82d48ea6fb2417294816caf3cc1f5e5e24993f`。机制成功样本没有触发 pruner，二者不混写成同一构件。最终回归覆盖全部新增路径。

`npm pack --pack-destination artifacts` 的完整 prepack 通过：**187 单元 + 133 集成 + 22 实验工具 = 342 项**，类型检查和构建通过。集成测试覆盖真实 Cordis scope 的服务访问、独立工作/等待/模型主动换窗、预算拒绝通知、取消、超时、重复交付、三种触发的 JSONL 重启和 pruner 解除压力后的分支。

发行审计通过：42 个文件，acp-kernel 仍精确钉住，没有绝对宿主导入或未声明运行时导入。包 `artifacts/dsh-context-management-0.1.1.tgz` SHA-256：`f5cb71db70806a1c0c9a5f6b3073fbe0353693e65ac2e2f2d62ca7fb02f44a45`。仅安装到 `ctx-v012-smoke-c`，34 个 dist 文件逐个与构件一致；安装包哈希与 prepack 产物一致，未发布 npm。

全局 settings 哈希与开始相同，未恢复或改写用户设置，日常 web/headless 未动。没有 Qwen 请求，没有本地隧道保活。三个 Web 运行已释放锁，实验进程结束，3311/3324 无监听，两个实验 profiles 保留。

本轮没有做同一最终窗口候选关闭后台的质量/成本配对，因此两次摘要交付和等待隐藏有机制证据，但尚不能归因一般性的质量增益或经济收益。Web 有一条中断流报告零 usage；所有未消费摘要也计入观察，报告 token 不等于完整账单。

## 复现与证据边界

```sh
# 每次只启动一项；完成并审查后再选择下一项。
node tests/live/handoff-muse.mjs --name=reproduce-independent --task=independent --background=true --seed=91541
node --import tsx tests/live/handoff-audit.mjs .test-runtime/handoff-muse-20260915/reproduce-independent
# 依赖路径改为 --task=dependent；保持 Muse minimal。
node tests/live/local-short.mjs --name=reproduce-web --route=muse --arm=C400_WINDOWED --family=F3 --seed=91542 --pages=24 --pressure=32000 --batch=6 --concise=true --restart=true --background=true --prepare=0.6 --cost-control=observe
```

原始机制证据在忽略目录 `.test-runtime/handoff-muse-20260915/`，Web 证据在 `.test-runtime/nightly-20260915/`；所有失败保留。公开数据由固定运行名单、显式字段白名单生成，不复制请求正文、认证信息、绝对路径或会话标识。缺失或零 usage 不表示调用免费。
