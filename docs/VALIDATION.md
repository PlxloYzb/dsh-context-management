# 本次实际验证记录

时间：2026-09-07（结果JSON用UTC，本机时区Pacific/Port_Moresby）。范围：文档审阅、已安装DSH接口与模型连通性。**没有安装或实现新插件，因此本文件不是v0.1.0插件验收报告。**

## 1. 环境事实

- `dsh --version`：0.1.2-rc.1。
- CLI：/Users/bruceplxl/.local/bin/dsh，指向本地npm安装包。
- `dsh web --help`确认host、port、no-open参数。
- ARC：0.2.0-beta.15 / 82fc3004d10c445f82aa97a93ad2a88a3a8794cd。Codex无git元数据，关键文件使用hash固定。
- 新项目开始只有docs；没有代码、依赖、测试脚本或git仓库。此次只向docs写入文档、探针与结果；两个参考仓库保持只读。

## 2. 真实Web与GLM测试：PASS

实际启动：

```sh
dsh web --host 127.0.0.1 --port 3097 --no-open
```

测试过程：通过根URL启动token换取签名Cookie（303），认证后Web根页面返回200/HTML；经同一Web的RPC创建standard会话，selectModel指定opencode-go/glm-5.3-flash，提交不调用工具的固定smoke消息；分页读事件，检查request/header、request/context、assistant/message与turn/end。

| 证据 | sessionId | 实际结果 |
|---|---|---|
| [首个会话核验](evidence/web-smoke.json) | session-82b44820-dced-4acd-a6ad-940ec51d8628 | 预期文本返回、路由一致、turn完成 |
| [完整新鲜运行](evidence/web-smoke-fresh.json) | session-ddfcaf2f-a0bd-4d86-b799-605850cbd3cb | 从create到完成的最终脚本一次跑通；约7.2秒 |

两个会话均返回 `DSH-CONTEXT-MANAGEMENT-SMOKE-OK`，请求实际路由是opencode-go/glm-5.3-flash，没有备用模型。新鲜运行assistant usage为inputTokens=10748、outputTokens=72、totalTokens=10820。首次样本另有cacheReadTokens，保留原始独立桶，不把total再与cache重复相加。

request/context在这两次调用中报告contextWindow=1000000。这个值是本机适配器当时报告的容量，不能推导此模型所有provider都相同，也没有进行100万token物理容量压力测试。

没有浏览器点击/UI视觉检查；验证覆盖Web服务器及浏览器同源API通路。发布门仍要求完整UI旅程。

### 实测中发现的协议差异

| 旧假设 | 本机结果/修正 |
|---|---|
| localhost可直接POST API | 未认证401；先用启动URL换Cookie |
| `/api/session.create` | 认证后404；用`/api/session/create` |
| payload直接是业务对象 | 必须`payload: {args: {request: ...}}` |
| list参数名同create | list用args._request；以生成描述符为准 |
| prompt无requestId | 新schema要求requestId |
| session.history可拿所有事件 | 新接口session/page；address、throughSeq、可选beforeSeq/maxMessages；返回records |
| throughSeq任取很大值 | 必须<=实际cursor，从目标Session的projections.asOfSeq取得 |
| provider/model在header事件顶层 | 实际在data.header.config；request/context另存路由与容量 |

旧路径失败证据保存在 [web-smoke-legacy-transport-failure.json](evidence/web-smoke-legacy-transport-failure.json)。调试期间还遇到了args/requestId/page参数校验失败；它们是驱动迁移错误，不能记为GLM模型失败。另有一个create成功但未发出prompt的准备会话。

### 可复跑脚本

[web-smoke.mjs](scripts/web-smoke.mjs) 不读取或输出模型密钥，使用已运行Web的宿主凭据。用启动器打印的当前URL作为进程环境输入，脚本只保存无认证参数的origin，不保存token/Cookie。请在仓库根运行：

```sh
DSH_WEB_LAUNCH_URL='<本次启动器显示的本地完整URL>' \
DSH_SMOKE_OUTPUT='docs/evidence/web-smoke-new-run.json' \
node docs/scripts/web-smoke.mjs
```

每次选择新的输出文件。默认路径带运行时间标识。DSH_SMOKE_SESSION_ID可仅复查本次创建的会话而不发新prompt；它是诊断模式，不算新鲜运行。正式驱动还需覆盖完整分页、list分页、stream、超时取消与插件行为，本脚本只用于短会话smoke。

## 3. 安装宿主投影探针：PASS

```sh
node docs/scripts/projection-probe.mjs
```

[projection-probe.mjs](scripts/projection-probe.mjs) 导入本机安装包的真实纯投影函数；使用合成事件，不发模型请求、不写Session。默认安装路径可以用DSH_PACKAGE_ROOT覆盖。这种内部文件import只用于研究验证，禁止复制为插件运行依赖。

[结果](evidence/projection-probe.json)：输入P=10000、shadowedTokenCount=3000、checkpoint=84；宿主P'=7084。套旧ARC公式变4084，低估3000。插入一个非surface事件于summary与replacement之间，claim失效，投影保留10000；因此生产提交必须保证相邻写入。

该实验固定“此宿主已经扣减”与“相邻价格协议”的行为，不等于已测试全部图片定价、多轮归档、崩溃恢复或ARC新移植版本。

## 4. 已完成与待完成状态

| 项目 | 状态 |
|---|---|
| 原草案审阅与保留 | 完成 |
| 官方文档、两个源码参考库、安装宿主核验 | 完成，范围见SOURCES |
| Web启动、认证、指定模型实际请求 | PASS，两次成功会话 |
| 新宿主重复扣减/相邻claim探针 | PASS |
| 新插件build/单元/集成测试 | NOT IMPLEMENTED |
| bridge接管、第一请求、卸载/HMR实测 | NOT RUN |
| 插件持久化/连续换窗/检索/重启 | NOT RUN |
| 三臂模型效果对照、真实物理overflow | NOT RUN |
| UI交互和新tarball安装卸载 | NOT RUN |

本次测试Web在核验完成后已停止，测试会话仍保留在本机DSH中便于追溯。没有安装新插件、改变日常profile依赖或修改模型配置文件。

## 5. 文档自身检查：PASS

`node docs/scripts/check-docs.mjs` 检查当前文档导航、代码围栏、32个参考/原草案文件hash、三个结果PASS标志和三个脚本语法。结果见 [doc-check.json](evidence/doc-check.json)。原样保存的旧SPEC/PLAN不参与当前导航检查，其历史相对链接仍属于旧草案。

该检查只验证文档产物一致性，不编译或测试新插件。它不会替代TESTING中的G1–G7。
