# DSH 集成、安装与卸载契约

状态：设计与安装基线核验。新插件尚不存在，下面涉及新包的命令须在产物构建后执行。本次已实际运行的命令见 [VALIDATION.md](VALIDATION.md)。

## 1. 官方依据与边界

插件入口、依赖声明与 effect 生命周期遵循 [第一个插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)；包的 bundle manifest 与安装遵循 [打包与安装](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)。旧文档遗漏了官方参考层，当前存在 [Compaction 专页](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/compaction)，不能再把整个压缩接口写成“未文档化”。

官方支持的是 CompactionEngine seam、事件协议与 Cordis 组合机制；**自动扫描任意 preset 并通过 bridge 接管不是官方对本插件的兼容保证**，须在每个支持的宿主线实测。当前声明目标限定 standard。

## 2. 包形态

```json
{
  "name": "dsh-context-management",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./bridge": { "types": "./dist/bridge.d.ts", "import": "./dist/bridge.js" }
  },
  "files": ["dist", "cordis.patch.yml", "README.md", "LICENSE", "NOTICE.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

这是最小 manifest 设计片段，不是可直接发布的完整 package.json；scripts、依赖和 engines 由 P0 的真实构建矩阵补全。acp-kernel 源基线为精确版本 0.0.24，默认保持，升级另设差分测试；构建可沿用 ARC tsup 内联策略。宿主 @deepseek-ai/* 必须 external，不能把第二套 Cordis/Service 打进 bundle 造成身份冲突。

首发 peer 先精确限定测试过的 0.1.2-rc.1 线；不要同时宣布 rc.7/rc.8 可用。cordis/loader/include/group/schemastery 版本见 [source-manifest.json](evidence/source-manifest.json)，实际 schemastery 是3.18.2，不是旧计划的3.18.1。依赖清单需按最终 import 补齐，无 blanket peer 放宽。

保留被复制源码的许可证与署名。ARC 的 MIT 与 Codex 快照的 Apache-2.0 不因改名消失；直接复制的代码/文本应记录来源、版本/hash、改动和 NOTICE。优先重新实现思想，避免整仓复制不相关产品代码。

## 3. CompactionEngine 的三个消费入口

| 接口 | 本插件行为 | 必须兼容的宿主语义 |
|---|---|---|
| compactIfNeeded(agent, trigger, signal) | 统一 governor，返回成功 CompactionResult 或 null | pressure 与 context-overflow 区分；signal 优先；无安全范围返回 null |
| compactNow(agent, signal, sourceCommandId?) | 本地有界压缩，用于原生 /compact | runMaintenance、turn:null、命令关联、选择稳定性、错误分类、flush |
| compactRegion(start,end,agent,signal?) | 精确安全范围的局部可逆压缩 | inclusive surface 位置跨度；不能自动改成别的范围而仍宣称精确执行 |

模型 compress 接受 stale seq/单个工具结果的友好恢复，是**工具层**策略；不覆盖 compactRegion 的契约。/compact 表示显式压缩；/context new 表示窗口边界，不能仅让两者输出同一句成功提示而掩盖语义差异。

新 engine 自己注册自动 pre-step 和 request-error 路径，不依赖已停用的 Basic 帮它驱动。所有入口进入同一 single-flight/transaction 逻辑，避免模型压缩、自动兜底和手动命令同时写入。

## 4. Preset bridge：两阶段接管，有就绪屏障

本地 ARC bridge 可参考的接口：loader.builtins、standingMountFor、Include 配置 patches、fiber.update、AgentPresets.serviceFor。实施时只从包的公开 exports 引用；审阅探针读取 lib/types 私有文件不构成插件运行时许可。

接管步骤：

1. 解析 agent 的 standing mount，确认官方 Basic 行的 ID **与包名**，定位其 compaction isolate 域；没有目标/第三方后端时返回明确 unsupported。
2. 持有 mount 操作队列与生命周期标记；把 engine 注册进 effect-owned builtin 键，保留旧值，禁止覆盖其他 owner。
3. 第一阶段仅停用 Basic，await reconcile 完成；第二阶段插入新 engine，await 完成。复用 Include 正式 patch 机制，保持原 config 对象 identity，不编辑 preset 文件。
4. 在实际 agent resolver 中验证同域唯一 provider 确实是新 engine，记录 active；不能只检查全局类名或成功注册某个 symbol。
5. 首个 prompt 必须等待接管结果。ARC 目前的 agent/created 回调启动 fire-and-forget import/patch，不足以证明首请求一定已经接管。实现需要 tracked promise + readiness barrier，并以实际 hook 顺序测试证明有效。

回滚先停新 engine，再恢复 Basic，所有有依赖的清理在**同一个异步 disposer 中串行 await**。不能假设 Cordis 的逆序调用意味着异步清理逐个完成；[官方生命周期文档](https://deepseek-harness.github.io/deepseek-harness/develop/framework/)明确区分二者。dispose 先设置 closing 状态、停止接受新 mount、等待已有 patch 任务，再回滚 owned 变更；异步导入完成后也须重检 closing。

不把别人的后续 config 写入还原为旧快照。仅撤销本插件的 patch/builtin；同 mount 重复创建、更新、异常、卸载均幂等。部分失败后恢复 Basic，并报告 failure；如果恢复也失败，阻止该 agent 继续请求并显示具体原因。

## 5. Pruner 的保留不是只保留行

原版 Basic 在条件满足时调用 toolResultPruner，再重测量。新 engine 停掉 Basic 后必须明确接手该行为：在 pressure/overflow 的有界 pass 中调用可选 pruner，检查 replacement generation、重测 P，再决定是否仍需归档。不能仅保留 YAML 中 pruner 行，却再也没有消费方调用它。

pruner 原件留在日志，replacement 通过 sourceEventSeqs 指回原始 tool/result；新档案检索要能沿此关系还原被剪去的中段。该链与 ARC/window parent 都必须纳入 resolver。pruner 已推进 surface 而随后归档失败，不允许当作“零进展”无限重试；取消仍优先。

## 6. 本地开发与产物验证

当前 host 启动命令已核实：

```sh
dsh --version
dsh web --host 127.0.0.1 --port 3097 --no-open
```

初期用绝对路径 overlay 指向构建的 bridge，防止模块路径从 profile 目录错误解析。以下为构建后示例：

```yaml
- insert:
    - id: compaction-context-management-bridge
      name: /absolute/path/to/dsh-context-management/dist/bridge.js
      config:
        # 使用 SPEC 中完整配置，不能只贴 strategy 一个键。
        adaptiveGovernor:
          enabled: true
          strategy: windowed
          maxOutputTokens: 8192
          windowBudgetTokens: 32768
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

已有 bridge 行的用户配置覆盖应使用 `- id: compaction-context-management-bridge` 加完整 config，**不能再次 insert 同一行**。层顺序为 bundle → profile → home → 命令行 overlay，整行 config 替换而非深合并；只写 strategy 会让其他原有配置退回缺省或丢失。[官方安装说明](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)

产物门必须使用独立测试 profile，避免把未验证的插件加入日常 Web。profile 文件位于 DSH_HOME/profiles/<name>，按本机 Web 的官方 bundle 列表创建测试 profile；credentials 继续由宿主管理，不把 key 复制进插件 YAML。

```sh
npm ci
npm run check
npm pack
dsh plugin --profile ctx-v010-test add /absolute/path/dsh-context-management-0.1.0.tgz
dsh --profile ctx-v010-test --dump-config
dsh --profile ctx-v010-test --host 127.0.0.1 --port 3098 --no-open
```

上述 npm scripts/profile 需 P0 创建后才存在。dump-config 只证明静态组合层，不能证明每个 agent 的运行时 bridge 成功；必须另记录实际 service ownership。输出可能含配置敏感值，公开报告使用 allowlist 脱敏。

## 7. 卸载与兼容说明

```sh
dsh plugin --profile ctx-v010-test remove dsh-context-management
```

检查 package/profile 层移除、所有 effect 释放、原 preset hash 不变、同域 Basic 恢复；重启后再验证。手工 --patch overlay 必须停止使用，不能因为移除了 npm dependency 仍留下绝对路径 bridge。

“卸载零残留”不是正确承诺：会话里的合法 checkpoint/档案事件必须保留。保证的是本插件的运行注册与配置层可撤销，preset 原件不变；已写会话历史不会被删除。卸载后没有新插件的检索工具，旧 checkpoint 仍是宿主认识的 compaction 消息。

旧 ARC 用户可导入会话读取；新包不自动替换用户的旧手改 preset、不同时挂两个后端、不自动 deprecate 原包。兼容工具若识别旧包名，要明确提示迁移状态，不能写“旧名全仓零残留”的测试去删除必要的许可证和兼容逻辑。
