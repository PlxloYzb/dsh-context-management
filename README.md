# dsh-context-management

DSH 的可回溯上下文管理插件，面向 **DSH 0.1.2-rc.1 / Node.js >=22.12**。通过运行时 bridge 在官方 preset 的 compaction 域内接替 Basic，默认使用 windowed 策略；原始会话事件留在宿主日志里，可按档案检索和分页读取。

版本 **0.1.0**。完整验收结果与适用范围见仓库中的 `docs/RELEASE.md`，测试标准见 `docs/TESTING.md`。

## 安装与卸载

在已配置模型的 DSH profile 中安装本地包。开发验收请使用独立 profile。

```sh
dsh plugin --profile ctx-v010-test add /absolute/path/dsh-context-management-0.1.0.tgz
dsh --profile ctx-v010-test --host 127.0.0.1 --port 3098 --no-open
# 停止测试 Web 后卸载并重启：
dsh plugin --profile ctx-v010-test remove dsh-context-management
```

安装通过 bundle 自动插入 bridge，不需要修改官方 preset 文件。卸载后重启恢复 Basic；已写入的 checkpoint 和会话日志仍保留。旧版 `dsh-arc-context` 或手工修改过的 preset 需要先迁移，不能让两个后端争用同一域。非官方 compaction 后端或无法识别的 preset 会报告冲突或不支持。

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

`strategy: in-place` 保留选择性 ARC 压缩；`enabled: false` 关闭自动预算改写和自动归档。检索页默认 2048、最多 4096，使用保守字节预算包含包装开销。cursor 绑定会话和档案，追加事件后可续页；每会话最多保留 256 个游标，进程重启或游标淘汰后需重新发起读取。search 返回原始位置，可用 sourceSeq/textBlockPath/offset 直接读取命中正文。只在当前任务需要时续页。附件只检查引用可用性，不承诺恢复已删除的文件。

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
