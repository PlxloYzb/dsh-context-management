# dsh-context-management v0.1.0 文档入口

本目录是2026-09-07审阅后重新制定的开发与验收基线，目标是新的 **dsh-context-management 0.1.0**，可靠替换DSH原生Basic compact。当前交付的是文档、源码核验与宿主实测，**不是已完成的插件**。

建议先读 [答卷 REVIEW.md](REVIEW.md)，再按下列顺序实施。

| 文档 | 回答的问题 |
|---|---|
| [SPEC.md](SPEC.md) | 产品做什么、默认行为、工具契约、预算和失败语义 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Codex/ARC/DSH怎样结合，换窗、日志、恢复如何实现 |
| [DSH_INTEGRATION.md](DSH_INTEGRATION.md) | 官方接口、同域替换、pruner、首请求、卸载与打包 |
| [TESTING.md](TESTING.md) | 怎样证明可靠，硬门、故障测试、真实Web与模型对照 |
| [PLAN.md](PLAN.md) | 按依赖顺序怎样开发到可用0.1.0 |
| [VALIDATION.md](VALIDATION.md) | 本次实际运行了什么、结果和限制 |
| [SOURCES.md](SOURCES.md) | 官方链接、源码定位、版本与hash |
| [archive/README.md](archive/README.md) | 原草案保留说明；不作当前规范 |

阅读约定：“已验证”须有源码或结果证据；“设计/待实现”是后续实现契约；“待验证”不得写为已支持。用户本次需求优先，旧草案不再包含有效的不可重议决定。

当前最重要的实现前提：新宿主projectedTokens已扣压缩量，不能再次扣全账本；shadow定价用heuristicTokens；new_context需在安全边界消费；保存summary不等于已成功换窗；检索恢复必须有预算。


0.1.1 补丁的修复映射、最终验收与保留失败见 [RELEASE-0.1.1.md](RELEASE-0.1.1.md)。原 [RELEASE.md](RELEASE.md) 保留 0.1.0 发布记录。

- [0.1.1 目标 profile 原生上下文管理覆盖](PROFILE-COVERAGE-0.1.1.md)
