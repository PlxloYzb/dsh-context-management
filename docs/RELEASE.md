# 0.1.0 发行验收

**0.1.0 本地发行产物已完成，G1–G7 均通过约定验收。** 本报告与 [TESTING.md](TESTING.md) 保持同一门槛；真实物理 overflow 未触发，仍标记 NOT EXERCISED。最终结论见 [完整门槛记录](evidence/release/final-gates.json)。

## 实现与本地验证

DSH 0.1.2-rc.1 / Node 22.23.1，严格 TypeScript、ESM；acp-kernel 固定为 0.0.24 并打入构建，宿主依赖只使用公共 exports 并保持 external。两个参考仓库只读。

`npm run check` 包括 typecheck、172 项单元测试、41 项真实宿主集成测试及构建，全部通过。[全新安装报告](evidence/release/fresh-install.json) 在新临时目录执行 npm ci、check 和包清单检查。开发依赖审计另有一项低危 esbuild Windows 开发服务器路径问题；报告保留原始 audit 状态，不将 audit 的非零退出码改写为通过。

集成覆盖真实 Loader/Include 接管、首请求、竞争与回滚，真实存储落盘和 SIGKILL 重放，连续换窗、最新用户边界、工具配对、fork/会话隔离、附件缺失、分页精确拼接、规范化 overflow 与无收益停止。

[规模报告](evidence/performance/scale-7331.json)：Apple M4 Pro、512 MiB heap 上限，100001 个事件、1100 个档案和 100 窗链，24.47 MB 输入；冷建约 439 ms，热检索 p95 约 16.22 ms。取消计时使用已取消信号；同步扫描另有访问与字符上限，不把该结果当作事件循环中途抢占测试。

## 真实模型与 UI

固定路由 `opencode-go/glm-5.3-flash`，以每次 request/header 验证。逻辑控制预算为 32768，输出预留 8192，安全余量 4096，有效输入预算 20480。

三臂均使用 3 个固定语料 seed、每 seed 3 个独立会话。A 为原生 Basic，B 为插件 in-place，C 为默认 windowed。每个候选 cohort 事先登记，失败报告全部保留。最终清单和可复算结果由 [cohort-gates.json](evidence/release/cohort-gates.json) 给出；不能以单个报告的 completed 字段代替质量聚合。

最终三臂结果（每臂 9 个预登记样本）：

| 策略 | 完整旅程 | 盲答事实 | 重启后事实 | 原文/请求配对核验 |
|---|---:|---:|---:|---:|
| A 原生 Basic | 9/9 | 108/108 | 108/108 | 9/9 |
| B in-place | 0/9 | 0/108 | 0/108 | 9/9 |
| C 默认 windowed | 9/9 | 108/108 | 108/108 | 9/9 |

C 组每会话完成 2–8 次实际换窗，初次盲答和重启后均保留全部最新更正，无请求配对破坏和不可恢复错误。6 个自然使用样本由宿主压力触发共 17 次换窗；3 个允许主动调用的样本有 21 次模型请求换窗及 3 次压力换窗。两类分别计数，不合称自主压缩率。全部可用合成文本的分页拼接与原来源逐字相等。B 组 8 个安全预算停止、1 个首轮 240 秒超时；未完成的回答在固定分母中计为 0。每次调用的输入、缓存读写、输出桶及缺失字段计数保留在聚合 JSON 中。

最终清单：[A](evidence/live/cohort-A-final.json)、[B](evidence/live/cohort-B-final9.json)、[C](evidence/live/cohort-C-final8.json)。

Basic 使用其官方 schema 的物理容量阈值，口径与插件逻辑预算不完全相同，因此不作 token 成本优劣结论。B 组预算不足时停止属于失败对照样本，不能从分母删除。原文恢复完整率与模型回答准确率分开计算。

历史候选发现并修复：旧 cursor 过长、恢复页循环、用户更正未进入本地交接索引、新 ARC checkpoint 被误当成没有新历史，以及模型未检索便返回未知。另有样本把正确中文值翻译成英文；即使原文未丢失，也按质量失败处理。重启场景还发现批量 compress 在前段成功、后段触及当前用户时误标恢复错误，已改为逐段提交前校验并返回单段拒绝。还修正了最终请求检查对等价请求头误用保守估算的问题：只在实际 envelope 变化时重新计价，未变化且 usage 基线有效时沿用宿主投影。压缩收益还扣除了移除后会被宿主重新注入的最新技能目录和运行时快照；搜索按原始来源去重，避免跨父档案反复返回同一证据。对应 cohort 与原报告保留在 evidence/live 中，不从最后一轮的成功率推断通用效果。评分脚本曾将完整答案后的两项更正确认误选为答案；修正为按目标字段覆盖数选对象，同覆盖数选最后一个，选择时不比较值是否正确。所有历史样本已统一重算，原分数与变更列表保留在 scoring-revision.json。

[UI 旅程](evidence/live/ui-journey.json) 通过 Codex 内置浏览器操作原生 `/context` 参数框，验证状态、手动换窗、搜索、分页恢复和 `/compact` 无收益错误显示。最终产物还重新打开同一合成会话，通过原生 status、search、decompress 复查持久代际与原文分页；早期命令保留原 seq，不冒充全部在最终候选新执行。RPC 和离线重放另行验证工具与命令协议。

[真实容量报告](evidence/live/physical-capacity.json) 未设置人工逻辑窗口，最终相同 tarball 的同一路由声明容量为 1000000，8 页长会话完成且事实恢复 12/12。没有观察到 provider 物理溢出，状态为 **NOT EXERCISED**；模拟 overflow 通过不替代该项实测。

## 安装卸载与产物

[生命周期报告](evidence/release/lifecycle.json) 从 tarball 装入全新 `ctx-v010-release-*` profile，验证首请求与重启后为 ArcCompactionEngine；卸载后重启为 BasicCompactionEngine，插件工具消失。原会话事件前缀保留，standard/minimal/ptc/cordis 四个 preset 的文件哈希完全相同。一次观察器 patch 格式错误的测试基础设施失败另存报告，修正后完整重跑。

[包清单](evidence/release/package-audit.json) 检查产物、声明、patch、README 和许可，排除私密 Web 日志、模型请求正文、认证信息和测试工作目录。源码尚未创建 git commit，因此证据中的 pluginCommit 为 null；依赖锁、tarball 及安装后所有 dist 文件均有 SHA-256，不伪造提交号。

产物：[dsh-context-management-0.1.0.tgz](../artifacts/dsh-context-management-0.1.0.tgz)，251583 字节。[校验和](../artifacts/SHA256SUMS) 与 [发行清单](../artifacts/release-manifest.json) 一并提供。最终 `npm pack` 再次执行全部 172+41 测试及构建，包哈希与模型测试、安装卸载测试完全一致；30 个 dist 文件逐一比对，见 [产物一致性](evidence/release/runtime-identity.json)。

SHA-256：`81640a3426be8c84bf32497c2464ed4e507d46dec30bca0347951730af31b543`。

公开 npm 发布不在本次范围内。安装和故障处理见 [README](../README.md)。
