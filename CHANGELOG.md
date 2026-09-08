# Changelog

## 0.1.1

- Profile-wide native Basic takeover: discover actual row IDs, group and Include ownership; handle preset changes before the first request, including presets added after startup. Presets with no compaction (official minimal) remain without one.


- Validate budget geometry, archive limits and prompt templates before taking over Basic; distinguish an oversized fixed request envelope from retained-input exhaustion.
- Allow requests after a verified Basic rollback; bound agent listener ownership and bind cached state to Session instances.
- Report deferred no-op window requests once to the model; normalize empty handoffs and report actual seed incompleteness.
- Enumerate every search occurrence, share archive adjacency validation, maintain cursor LRU and return explicit EOF pages.
- Fold eligible old in-place checkpoints while retaining original archive sources; enforce summary limits before commit and return structured tool errors.
- Keep patch release evidence separate from 0.1.0 and derive runtime/report versions from the package manifest.

## 0.1.0

- 新建独立的 `dsh-context-management` 包，适配 DSH 0.1.2-rc.1。
- 通过运行时 bridge 接替官方 preset 的 Basic compaction；卸载并重启后恢复原后端。
- 默认按有效输入预算换窗。模型 `new_context` 登记意图，在后续安全边界提交；保留最新用户输入和工具配对。
- 原始事件留在宿主会话日志，窗口与 ARC 档案分开记账；支持跨父档案检索、精确文本分页、重启恢复和会话隔离。
- checkpoint 同时保留原始用户摘录、结构化来源记录和有界交接摘要，避免反复转述覆盖原件。
- 提供 `/context` 状态、手动换窗、搜索和恢复命令，以及 `/arc` 迁移别名。
- 加入事务故障、强杀重放、真实宿主、Web 模型旅程、规模与安装卸载验收。

本地发行状态与限制见 [docs/RELEASE.md](docs/RELEASE.md)。公开 npm 发布已于 2026-09-07 完成,旧包废弃尚未执行。
