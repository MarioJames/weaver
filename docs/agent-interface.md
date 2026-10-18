# ADR：面向 agent 的 Weaver 逻辑接口

> 实现状态更新（2026-10-18）：下文保留完整目标设计，不能把其中旧的“CLI 未实现 / 只有预览”描述当作当前状态。已实现 weaver.v1 共享 handler、Unix CLI/认证 IPC 代码、mock owner/worker 适配层、策略准入/排队、结果验收、上下文轮换及同步快照。真实 agent 接入、外部 owner scoped auth、SQLite/outbox 和生产级进程树控制仍待实现。CLI 的真实 socket 集成因当前环境 EPERM 未验收；最新事实见 [README](../README.md) 与 [VERIFICATION](../VERIFICATION.md)。

状态：目标设计，尚未实现。日期：2026-10-18。本文不安装 CLI、不启动真实 owner/worker、不调用模型 API。命令、工具名、返回值与权限策略均是待实现契约；当前 mock 演示不能证明这些功能可用。

## 1. 决策

采用 **一个版本化领域命令核心、两个薄入口**：先交付本地 `weaver` CLI，再按实际 owner 宿主需要添加 stdio MCP facade。MCP 是可发现的工具入口，CLI 是通用脚本与调试入口；它们不能各自拥有任务数据库、调度器或进程监督器。

```text
owner + cooperation skill
  ├─ weaver CLI ────────────┐
  └─ MCP client → stdio shim ┤
                            ↓ 认证的本地 IPC
                Electron main / ControlPlane
                 CommandHandler + 权限 + DB
                    ├─ OwnerHostAdapter
                    └─ WorkerProviderAdapter
```

公开 skill 只介绍 Weaver 的 owner、worker、task、package、attempt、result、review。**不提及 Herdr，也不暴露 pane/lane/session、底层可执行文件或平台命令。** Herdr 若作为首个 owner 宿主，仅属于私有 adapter 实现与管理员诊断；技术栈迁移不能要求 owner 改写工作流程。

OwnerHostAdapter 与 WorkerProviderAdapter 分开：前者实现用户可见协作 owner 的创建、身份绑定、消息及生命周期观察；后者执行受限工作包。换 owner 宿主不等于换 worker 引擎。这里保留用户需要的 `spawn owner` 产品能力，同时不把讨论功能当成现在运行真实 agent 的许可。

## 2. MCP 与 CLI 的取舍

| 入口 | 优点 | 代价与边界 |
|---|---|---|
| CLI 优先 | 宿主只需安全执行本地程序；容易复现、fixture 测试、人工诊断；独立于 MCP 版本 | 需 skill 说明命令；结构化输入输出必须稳定；不能靠解析彩色表格 |
| stdio MCP | 工具发现、参数 schema、结构化结果适合 owner 调用；不必开放本地 TCP | 需验证宿主支持、SDK/协议版本与配置；宿主启动的是薄桥，不是第二个 Weaver |
| HTTP MCP | 对远端和统一接入可能有用 | 增加网络、Origin、鉴权及生命周期面；单机 v1 不需要 |
| 仅某宿主专有工具 | 快速接上一个后端 | 泄漏底层概念，迁移成本高；不作为公共契约 |

CLI 与 MCP 可以先后实现，不必同时承诺生产可用。若首个真实宿主更适合 MCP，也可交换入口实现顺序，但必须先定共享 schema/handler 与单写者语义。

官方 MCP 当前 `latest` 指向 **2026-07-28**，不能继续假定 2025-11-25 就是最新。stdio 是宿主启动的子进程，以 JSON-RPC 行消息通信；stdout 不能混日志。Weaver 的 shim 应连接已运行 app，而不是把 worker 生命周期绑在这个子进程上。[官方 stdio 规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)

MCP tools 提供 input/output schema 与 structuredContent，但工具 annotation 不是授权机制。使用同一领域返回对象，兼容需要文本结果的宿主时附同一 JSON 的文本表示。[官方 Tools 规范](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

## 3. 单写控制面与连接生命周期

- Electron main 是 v1 唯一单写者，拥有 DB、调度、租约、outbox、worker 进程树和审批决策；renderer、CLI、MCP shim 都是客户端
- CLI 每次连接，MCP shim 可以保持 IPC 连接；连接数量不代表 owner 数量
- app 未运行返回 `APP_NOT_RUNNING`，启动中返回 `APP_STARTING`，正在退出返回 `APP_DRAINING`；不偷偷启动另一个 daemon，不在 CLI 进程内回退执行 worker
- 用户显式打开 app 后，完成数据库恢复与资源核对才开放修改命令；单实例锁防止第二控制面写入
- shim EOF、CLI 退出、RPC 超时只结束该客户端等待。已持久化任务继续按既定策略运行；实际取消必须调用领域取消命令
- app 关闭窗口与真正 Quit 的语义沿用[架构文档](architecture.md)。真正 Quit 必须 drain、停止归属明确的 worker、持久化与核对；不能由 shim 关闭触发整个 app Quit

## 4. 身份、权限与 owner 创建

### 身份

控制面生成不可预测、无 provider 含义的 `ownerId/taskId/packageId/attemptId/operationId/artifactId`。示例中的短 ID 仅为可读占位符。真实实现使用高熵 UUID；ID 不是 bearer 权限。厂商 session ID、PID、pane locator、模型 continuation token 只进入私有 adapter 映射。

认证得到 `principalId + ownerId + grantedScopes + sessionEpoch`；请求体中的 ownerId 只能是目标，不能自行声明调用者。断线重连可维持同一 owner 身份，MCP 请求 ID、连接 ID、provider 会话 ID 都不能代替 ownerId。

### 两种 spawn 绝不混同

| 能力 | spawn owner | spawn worker |
|---|---|---|
| 目的 | 创建可见的协作负责人 | 执行冻结的有界工作包 |
| 对象 | 新 owner 身份与独立可见会话 | package 的一次 attempt |
| 权限 | 单独 `owners:spawn`；显式角色/任务范围/预算 | `workers:spawn`；仅自己负责的包 |
| 完成证据 | 宿主可见性确认 + 新 owner 认证注册 | 有效 final + 输出关闭 + 退出/进程树证据 |
| 禁止推断 | 发出 spawn 不等于 owner 已就绪 | 进程退出不等于结果已验收 |

新 owner 创建流程：授权/能力检查 → 持久化 spawn operation 与预分配 ownerId → adapter 创建可见宿主会话 → 一次性注册凭据绑定预分配身份 → 收到认证注册与可见性证据 → 标记 `ready`。超时进入 `blocked/unknown/failed`，由同一 operation 核对；不能盲目重试创建第二个会话。

新 owner 默认只能使用授予的任务/包能力，不自动继承父 owner 全部权限或 `owners:spawn`。角色、并发上限、总预算、最大协作深度由 app 策略约束。Worker 不可创建 owner/worker、修改授权、验收自己结果或向用户发送消息。Owner 可以拆包、协调、review；执行项目文件变更交给 worker。

`owners.attach` 只配对已有可见会话，`owners.spawn` 才创建新会话。私有 adapter 记录资源归属 `attached/owned`：attached 资源不可由 Weaver 自动关闭；owned 资源也只按显式生命周期策略处理，任务取消不等于关闭 owner。

首个 owner 通过用户可见的配对流程注册；不得信任显示名或从文本复制来的 ownerId。用户需要 spawn owner 功能属于设计要求，不构成任何未限定的真实创建、共享数据或凭据生成授权。首次配对、授权扩大、外部通信与真实执行须遵守届时用户批准及宿主权限。

## 5. 有界 v1 公共能力

所有调用使用 `apiVersion: "weaver.v1"`。下面名称为建议，先稳定语义再生成 CLI/MCP schema。

| 逻辑命令 | CLI | MCP 工具 | 关键语义 |
|---|---|---|---|
| capabilities.get | `weaver capabilities` | `weaver_capabilities` | 当前可用/禁用能力及原因、版本、限制 |
| owners.attach | `weaver owners attach` | `weaver_attach_owner` | 用户批准的已有可见 owner 配对；不新建会话 |
| owners.spawn | `weaver owners spawn` | `weaver_spawn_owner` | 返回 ownerId、operationId；ready 前不可派包 |
| owners.get | `weaver owners get` | `weaver_get_owner` | readiness、授予范围、阻塞原因 |
| tasks.create/get/list | `weaver tasks …` | `weaver_create_task/get_task/list_tasks` | 任务目标、当前 owner、双状态、分页 |
| packages.create | `weaver packages create` | `weaver_create_package` | 冻结 scope、依赖、输入、验收标准 |
| workers.spawn | `weaver workers spawn` | `weaver_spawn_worker` | 已有 ready package 创建 attempt；调度可排队 |
| operations.get | `weaver operations get` | `weaver_get_operation` | 创建/取消等控制操作的可恢复收据 |
| tasks.events | `weaver tasks events` | `weaver_task_events` | 有界分页或有界长轮询；游标续读 |
| attempts.result | `weaver attempts result` | `weaver_get_result` | immutable manifest、执行证据、partial 标记 |
| artifacts.read | `weaver artifacts read` | `weaver_read_artifact` | 受控 ID 读取，字节/范围限额 |
| attempts.cancel | `weaver attempts cancel` | `weaver_cancel_attempt` | 取消意图，后续观察 cleanup |
| results.ack | `weaver results ack` | `weaver_ack_result` | 接收确认；不是验收 |
| reviews.submit | `weaver reviews submit` | `weaver_submit_review` | 对具体 manifest digest 的验收/拒绝 |

`tasks.list/events/result/artifacts` 一律鉴权、过滤与限制返回大小。完整日志/大产物不塞入工具上下文。若后续增加 task 级取消，必须明确对子包的影响；v1 不用模糊 `cancel everything`。

### 等价调用示例（提案，不可直接视为现有命令）

CLI 输入文件避免 shell 拼接与长参数；秘密不写 argv 或输入文件：

```sh
weaver owners spawn --input owner-request.json --json --no-input
weaver workers spawn --input worker-request.json --json --no-input
weaver tasks get --task-id task_example --json
weaver attempts result --attempt-id attempt_example --json
```

`owner-request.json` 的领域请求：

```json
{
  "apiVersion": "weaver.v1",
  "commandId": "cmd_unique_owner_spawn",
  "command": "owners.spawn",
  "args": {
    "taskId": "task_example",
    "role": "collaborating_owner",
    "objective": "审查接口方案并负责兼容性工作包",
    "requestedScopes": ["tasks:read", "packages:write", "workers:spawn", "reviews:submit"],
    "profileId": "profile_review"
  }
}
```

MCP 的 `weaver_spawn_owner` arguments 使用同一 `apiVersion/commandId/args` schema，工具名映射固定 command；不让模型提交任意内部方法名。`profileId` 是由用户配置的逻辑能力配置，不能展开成任意 argv、环境变量或可执行路径。

worker 请求例：`workers.spawn`，`args={"taskId":"task_example","packageId":"package_example","packageRevision":3,"profileId":"profile_implementation"}`。控制面校验冻结输入、scope、依赖、预算、审批与调用者归属；不能只凭一个自由文本 prompt 启动无限制 worker。

创建收据例：

```json
{
  "apiVersion": "weaver.v1",
  "commandId": "cmd_unique_owner_spawn",
  "ok": true,
  "data": {
    "operationId": "operation_example",
    "ownerId": "owner_example",
    "state": "starting",
    "pollAfterMs": 1500
  }
}
```

上述成功仅表示命令已持久接收。错误统一 `{ok:false,error:{code,message,retryable,details}}`，例如 `FORBIDDEN`、`APP_NOT_RUNNING`、`CAPABILITY_UNAVAILABLE`、`REVISION_CONFLICT`、`APPROVAL_REQUIRED`、`IDEMPOTENCY_CONFLICT`。能力不足返回逻辑原因，不能指示 owner 自行操作底层终端绕过。

## 6. 幂等、事件与取消

- 写命令携带 commandId；唯一键为认证 principal + commandId。保存规范化 payload hash 与收据，同键同内容返回原收据，同键不同内容拒绝。不能只靠 MCP JSON-RPC id 去重
- 修改已有聚合要求 expectedRevision；过期请求返回冲突与当前 revision，不默默覆盖。初次创建例不需要已有 revision
- DB 状态、事件、outbox、命令收据同事务提交。IPC 超时后先查询原 operation 或重发同 commandId；不能换 ID 盲目重跑
- 对外部启动的副作用无法用 SQLite 事务实现 exactly-once。保存启动意图与随机实例标记、adapter 查询证据；不确定时阻塞核对，绝不宣称严格 exactly-once
- 事件带 eventId、taskId、seq、type、entityRevision、occurredAt 和有界 payload。cursor 是服务端不透明、鉴权绑定的游标；重复投递去重，过期返回 `CURSOR_EXPIRED` 与 snapshot 路径，不静默漏消息
- 客户端关闭 events 等待只停止观察。领域取消先持久记录再停止归属明确的 worker 树；返回 `cancelling`，确认清理前不能显示 cancelled 或释放冲突租约
- 已终态返回 `already_terminal`；取消与完成由控制面提交顺序裁决。取消不撤回已发生外部副作用，不自动关闭可见 owner 会话
- result 区分 execution、delivery、acceptance；`succeeded ≠ acknowledged ≠ accepted`。manifest 绑定 task/package/attempt、输入版本、artifact hash、退出与验证证据。review 必须引用同一 manifest digest

## 7. MCP 异步任务策略

**v1 不依赖 MCP Tasks 扩展。** 创建工具很快返回持久领域 handle；后续 get/events/result 查询。这样不支持扩展的宿主仍可使用全部基础流程，CLI 与 MCP 也不需要两种任务状态机。

当前官方 Tasks 扩展通过 capability opt-in 返回 task handle、轮询获取终态结果，并支持中途输入及协作式取消；客户端支持并不一致。这是 MCP 调用生命周期，不能直接替代 Weaver 的包、attempt、review 与资源清理状态。[官方 Tasks 概览](https://modelcontextprotocol.io/extensions/tasks/overview)

官方 C# SDK 明确区分新版 Tasks 扩展与 2025-11-25 experimental Tasks，二者 API/协议不兼容。锁定实际验证的 SDK 与协议版本，维护宿主兼容矩阵，不能从示例文档推断某宿主已支持。[官方 SDK 迁移说明](https://csharp.sdk.modelcontextprotocol.io/v2/concepts/tasks/tasks.html)

后续可以把长等待包装为 MCP Task，但 wrapper taskId 与 Weaver taskId/attemptId 分离并保存映射；MCP TTL 只控制包装结果保留，不删除领域审计记录。MCP request cancellation 不隐式取消领域工作；只有清楚定义为实际取消的工具或专门映射才触发 `attempts.cancel`。工具返回 error 与协议传输失败也分开。

## 8. 本地传输安全与 CLI 规则

优先每用户私有目录下 Unix domain socket；Windows 使用仅当前用户 ACL 的 named pipe。检查端点所有者/权限、OS peer identity（可用时）、服务实例 epoch，并使用经授权配对的 owner-scoped 凭据。仅“同一 OS 用户”不能证明拥有某 owner 的权限；普通同用户恶意进程防护也不能被夸大成完整安全隔离。

凭据通过受限 IPC/继承句柄或系统安全存储引用传入 shim，不写进 skill、argv、结果、通用环境 dump 或日志。每条命令按主体、对象与作用域重新授权；短期凭据、撤销及连接 epoch 避免旧桥持续拥有权限。返回的任意 ID 仍需对象级权限检查。

v1 不开放 HTTP；若以后增加，必须验证 Origin、仅本机绑定并实施正确鉴权，不能把 localhost 当认证。官方 HTTP 规范也要求 Origin 校验以防 DNS rebinding。[官方 HTTP 安全要求](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)

CLI 采用 `--json` 稳定单对象输出，事件模式显式 `--jsonl`；stdout 仅机器结果，stderr 为诊断，禁止 ANSI/进度混入 JSON。`--no-input` 遇审批返回结构化阻塞而非挂起或默认 yes。建议退出码：0 命令已成功处理，2 输入错误，3 不可连接，4 未授权/待批准，5 revision/幂等冲突，1 其他失败；业务 attempt 失败仍可由成功的查询返回。明确 receipt 成功不是任务完成。这些是 Weaver 约定，参考 CLI 的 JSON、stdout/stderr、exit code 通用实践。[Command Line Interface Guidelines](https://clig.dev/)

## 9. 分阶段实现与验收

1. **契约阶段**：冻结 v1 schema、权限矩阵、fixture、错误码及版本协商。更新公开 skill 去除所有底层宿主知识；全文件检查不能只改标题
2. **单入口阶段**：实现 app 内 handler + 认证 IPC + CLI，先连 mock。验证重复请求、断线、过期 revision、跨 owner 越权、限额和 app 未运行；CLI 不能写 DB
3. **Owner 阶段**：实现一个 OwnerHostAdapter；先已有 owner 配对，再实现显式 spawn owner。可见性、注册、重连、创建不确定状态和不可用回退都通过本地验收后才开启
4. **Worker 阶段**：一个经用户授权的真实 provider 验证进程树、权限、取消、结果证据；第二 adapter 以相同 conformance suite 证明边界可替换
5. **MCP 阶段**：薄 facade 复用 handler/schema/权限；宿主断线不能终止 app，两个宿主不能造成两个调度器；CLI/MCP 相同 commandId 必须映射同一收据
6. **迁移阶段**：替换 owner 宿主或 Electron 控制面实现时保留领域 API、逻辑 ID 与迁移后的权威数据；adapter 私有映射可以变化。MCP Tasks/HTTP/远端执行仅在真实需求和独立安全验收后添加

最低契约测试包括：两入口结果一致；跨 owner 无泄漏；凭据撤销；重复 owner spawn 不创建双会话；spawn 超时不假成功；客户端退出后任务可查询；取消先于/后于完成两条路径；cursor 过期；artifact 篡改；结果 ack 不自动验收；切换 provider 后公共请求不变。

验收记录必须注明实测宿主、SDK/协议、平台、adapter 版本与证据。在这些记录出现前，CLI、MCP、真实 owner spawn 和真实 worker 都保持“设计/未接入”标识，不以本 ADR 当作实现证明。
