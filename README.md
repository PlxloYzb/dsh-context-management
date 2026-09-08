# dsh-context-management

DSH 的可回溯上下文管理插件，面向 **DSH 0.1.2-rc.1 / Node.js >=22.12**。安装到目标 profile 后，通过运行时 bridge 在该 profile 各 preset 的 compaction 域内接替原生 Basic，默认使用 windowed 策略；原始会话事件留在宿主日志里，可按档案检索和分页读取。

版本 **0.1.1**。完整验收结果与适用范围见仓库中的 `docs/RELEASE-0.1.1.md`，测试标准见 `docs/TESTING.md`。

## 安装与卸载

在已配置模型的 DSH profile 中安装本地包。开发验收请使用独立 profile。

```sh
dsh plugin --profile ctx-v011-test add /absolute/path/dsh-context-management-0.1.1.tgz
dsh --profile ctx-v011-test --host 127.0.0.1 --port 3098 --no-open
# 停止测试 Web 后卸载并重启：
dsh plugin --profile ctx-v011-test remove dsh-context-management
```

安装通过 bundle 自动插入 bridge，不需要逐个配置 preset，也不修改 preset 文件。`dsh plugin --profile <目标名称> add <npm 包名或本地 tgz>` 同时完成包安装与该 profile 的 bundle 启用；单独运行 `npm install` 只安装依赖，不代表 DSH 已启用 bundle。0.1.1 当前交付本地 tarball，npm 发布是独立步骤。

接管按实际运行的 Basic 包名、所在 Include 和服务域定位，支持 official standard/ptc/cordis，以及改过行 ID、嵌套 group/Include 的自定义 preset；空会话切换 preset 后的首请求也会等待接管。新增 preset 在首次使用时自动纳入。profile 内的同一 preset 共用一个后端，状态按会话隔离。

DSH 0.1.2-rc.1 的 minimal 原本没有 compaction：不会自动压缩，也没有原生 `/compact`；窗口超限时由请求错误结束。它没有可替换的后端，本插件不自动为它新增压缩能力。第三方后端也不会当作 Basic 替换。

卸载后重启恢复 Basic；已写入的 checkpoint 和会话日志仍保留。旧版 `dsh-arc-context` 或手工修改过的 preset 需要先迁移，不能让两个后端争用同一域。非官方 compaction 后端或无法识别的 preset 会报告冲突或不支持。

## 使用

- `new_context({handoff})`：模型提交换窗意图；宿主在后续安全 pre-step 提交。`accepted` 表示已登记，状态中的 generation 增加才表示换窗成功。
- `compress`：选择当前 surface 的范围生成可回溯 ARC 档案。窗口档案与 ARC 层级分别记账。
- `search_context` / `decompress`：检索原始来源、分页恢复文本。返回内容标明历史数据边界；缺失来源、附件或截断会说明不完整。
- `arc_status`、`/context status`：查看实际后端、窗口代际、预算、归档完整性和最近操作。
- `/context new`：空闲时手动换窗；`/compact` 使用宿主 maintenance 语义创建本地可回溯 checkpoint。
- `/context search`、`/context decompress` 和 `/arc` 迁移别名可用于人工恢复。Web 中先从指令候选选择 `context`，再在参数框填写 `status`、`new` 等子命令。

换窗保护最新用户输入并保持工具调用/结果配对。每个安全边界最多换一窗。若保留部分仍超过安全预算，请缩短当前输入或提高逻辑窗口；插件会停止继续请求。未达到 55% 目标但仍有安全余量时，状态标记退化原因。落盘失败会要求恢复，避免继续使用未持久化的上下文。

## 配置

默认启用 windowed 自动策略，nudge 为有效输入预算的 75%，emergency 为 90%，换窗目标为 55%。输出自动预留 `min(32768, floor(C/4))`，显式输出意图保留；C 同时受实际路由容量和可选逻辑窗口约束，安全余量默认 4096。实际输入预算为 `min(实际容量, 逻辑窗口) - 输出预留 - 安全余量`。

例如在 profile patch 中覆盖已安装 bridge 的整份 config：

```yaml
- id: compaction-context-management-bridge
  config:
    adaptiveGovernor:
      enabled: true
      strategy: windowed
      windowBudgetTokens: 32768
      maxOutputTokens: 8192
      safetyMarginTokens: 4096
      nudgeAtEffectiveCapacityPct: 0.75
      emergencyAtEffectiveCapacityPct: 0.90
      targetAfterTurnoverPct: 0.55
      emergencyFallback: true
    archive:
      seedMaxTokens: 4096
      retrievalDefaultMaxTokens: 2048
      retrievalMaxTokens: 4096
```

`strategy: in-place` 保留选择性 ARC 压缩；`enabled: false` 关闭自动预算改写和自动归档。检索页默认 2048、最多 4096，使用保守字节预算包含包装开销。cursor 绑定会话和档案，追加事件后可续页；每会话最多按最近使用顺序保留 256 个游标，进程重启或游标淘汰后需重新发起读取。search 返回原始位置，可用 sourceSeq/textBlockPath/offset 直接读取命中正文。只在当前任务需要时续页。附件只检查引用可用性，不承诺恢复已删除的文件。

## 开发

```sh
npm ci
npm run check
npm run test:live -- --help
npm run test:performance
npm run test:release
npm pack
```

`check` 包括严格类型检查、单元测试、真实宿主存储集成及构建。真实 Web 测试另外需要指定路由 `opencode-go/glm-5.3-flash` 可用。发布矩阵要求三臂 27 个独立样本，不能以单次 smoke 代替。公共 npm 发布不包含在本地构建流程中。

源码复用和许可证见 [SOURCE_REUSE.md](SOURCE_REUSE.md)、[NOTICE.md](NOTICE.md) 和 [LICENSE](LICENSE)。

## 0.1.1 诊断与边界

静态无效配置会由宿主在启动时拒绝，并给出修复原因；修正或移除配置后重新启动。配置在接管 Basic 前校验：有效输入预算必须为正，seed 和检索上限不能超过它，提示模板必须有效。接管失败且确认 Basic 已恢复时，当前及后续请求可以继续，启动日志记录 `CONTEXT_TAKEOVER_FALLBACK`；不能确认恢复时以 `CONTEXT_BACKEND_UNAVAILABLE` 阻止请求。

`CONTEXT_ENVELOPE_TOO_LARGE` 表示系统提示和工具定义已超过预算，需要增加逻辑窗口或减少提示及工具。`CONTEXT_BUDGET_EXHAUSTED` 表示保留输入无法安全缩减；可提高预算、缩短输入，或为长任务使用默认 windowed。in-place 支持合并旧 checkpoint，但仍执行硬预算限制。宿主在 pre-step 前领取输入；该阶段异常不保证尚未写入日志的输入自动重发，修正配置后应检查日志并重新提交缺失输入。

`new_context` 无可归档前缀时，下一请求收到一次包含 requestId 的 `no-safe-range` 结果。空白 handoff 使用本地提取；seed 的 `mode` 说明提取方式，`incomplete` 表示实际截断或来源缺失。工具失败返回带 `status`、`code` 的 JSON，必要时附带 `message` 或 `recovery`；取消仍沿用宿主取消流程。模型摘要超过 24,000 字符会在提交前拒绝，不能通过高级 kernel 配置放大后静默截断。

search 会分页返回同一文本里的每个命中，采用 JavaScript 小写转换，未提供完整 Unicode case folding 或规范化。offset 为原文 UTF-16 位置。EOF 返回空 segments 和 `endOfText: true`。游标过期、重启或失效后按错误中的恢复说明重新搜索/读取。附件与嵌套历史遍历有固定上限，触限会说明不完整；不承诺无限深度恢复。
