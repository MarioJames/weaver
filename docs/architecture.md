# Weaver 全生命周期架构

> 实现状态更新（2026-10-18）：下文保留完整目标设计，不能把其中旧的“CLI 未实现 / 只有预览”描述当作当前状态。已实现 weaver.v1 共享 handler、Unix CLI/认证 IPC 代码、mock owner/worker 适配层、策略准入/排队、结果验收、上下文轮换及同步快照。真实 agent 接入、外部 owner scoped auth、SQLite/outbox 和生产级进程树控制仍待实现。CLI 的真实 socket 集成因当前环境 EPERM 未验收；最新事实见 [README](../README.md) 与 [VERIFICATION](../VERIFICATION.md)。

状态：架构提案，2026-10-18。除第 2 节明确列出的现状外，本文中的新接口、SQLite 表、服务、状态和 UI 均为**目标设计，不是已经实现的功能**。当前执行能力仍是 mock-mode；真实 worker CLI、owner 的 MCP/bin 入口、owner 创建与自动通信、本机能力探测留待用户本地集成。纯策略模块的实现情况以第 2 节现状表为准。具体接入顺序见 [本地集成计划](local-integration-plan.md)。

## 1. 决策与边界

Weaver 是任务中心式 Electron 桌面应用，也是本机 agent 资源的唯一受管执行控制面。用户先把 cooperation skill 安装到自己的 agent 宿主，再打开桌面应用。Skill 只使用逻辑 MCP 工具或 bin CLI：创建/附接 owner、派发 worker、查询状态、获取结果与验收；**不感知 Herdr、pane、PID、worker argv 或传输细节**。接口方案见 [Agent 接口设计](agent-interface.md)。

接单 owner 可以附接用户现有的可见会话，也可以经授权创建新的可见协作 owner；“新建 owner”是正式目标能力，不要求所有 owner 预先存在。初始 OwnerBackendAdapter 使用 Herdr，未来可替换，Herdr 不是核心协议。Worker 使用非交互受控进程，通过 ProviderAdapter 产出结构化事件；不创建 Herdr worker pane、lane 或 hidden session。

核心原则：

1. Owner 负责理解、冻结方案、拆包、review、裁决和对用户汇报；不亲自修改项目文件。接单 owner 可在权限和预算内创建可见协作 owner；v1 协作 owner 不再创建 owner。Worker 执行明确包，不递归派发、不提交、不直接对用户发消息。
2. 一个本地单写控制面决定资源归属、状态、派发与验收权限。Renderer、worker 日志、Herdr 屏幕文字都不是状态权威。
3. `执行完成 ≠ 结果送达 ≠ owner 已验收 ≠ 已集成`。这些事实各自有证据和状态，不能以绿色进度条互相替代。
4. 宿主能力、执行模式、实际模型、权限和恢复能力必须探测；未知则禁用，不把旧技能里的 argv 当作当前事实。
5. 自动化不扩大用户授权。不可交互 worker 若遇到必须人工批准的动作，报告阻塞并退出，获批后新建 attempt；不通过 stdin 猜测回答或屏幕按键绕过审批。
6. 无本机实际验证的功能只能标为设计/待验收。本文不要求现在安装 CLI、启动真实 agent、调用模型 API 或创建云任务。

### 目标 v1 与后续范围

| 范围 | 目标 v1 | 后续可能扩展 |
|---|---|---|
| 运行位置 | 单用户、单机、单实例 Electron；一个主进程控制面 | 用户明确需要后再考虑独立后台服务、远端执行 |
| worker | mock + 一种验证通过的真实 CLI；第二种适配器证明异构边界 | 更多厂商，不承诺全兼容 |
| owner | 逻辑 attach/spawn owner、认证双向入口；首个后端为可见 Herdr；能力不足时显式人工回退 | 不改变 skill 的其他可见 owner 后端 |
| 调度 | DAG、资源租约、owner 并发限制、重试策略、配额阻塞 | 跨机器调度、复杂公平性策略不做 |
| 持久化 | 本地 SQLite + 受控文件库 | 不做分布式数据库/事件总线 |
| resume | 保存上下文与新 attempt 重试；默认不接管崩溃遗留进程 | 仅经证明安全的厂商会话续接 |
| artifact | 文本、JSON、diff、验证记录；不可执行预览 | 安全的 PDF/图片等更多只读预览 |
| 集成 | owner 验收后明确集成，保留基线与 diff | 不自动推送、发布或合并远端 PR |

## 2. 现有实现与证据

基线 Weaver commit：`f6c684319b5b431eb68ba18261f1ece177c80feb`；上游 skill-foundry commit：`61989b11a5d0565d2a6630833e64a2d73769a947`。相对链接指向当前仓库文件；这两个 commit 固定原 scaffold/上游阅读基线。下表纯策略与 Settings 条目来自本次工作树新增实现，不属于该 scaffold commit。

| 当前已经存在 | 证据 | 与目标的差距 |
|---|---|---|
| Electron main/preload/React 分界，窗口/IPC 安全策略 | [main.ts](../src/main/main.ts)、[preload.ts](../src/main/preload.ts) | 仍需对新增 transport、文件预览逐一维持边界 |
| Task、AgentRun、内联 Artifact、简单事件 | [types.ts](../src/shared/types.ts) | 尚无 WorkPackage/Attempt/Lease/Review 实体 |
| 显式启动、两槽 mock、取消/超时/退出协调 | [manager.ts](../src/main/manager.ts) | 无自动调度、进程树包含、真实 adapter |
| 有界 JSONL 解析及验证 | [protocol.ts](../src/main/protocol.ts)、[validation.ts](../src/shared/validation.ts) | 这是 Weaver mock 协议，不是厂商协议；无版本协商 |
| 原子替换 JSON 历史与中断恢复 | [store.ts](../src/main/store.ts) | 不是 SQLite、outbox 或全事件审计 |
| 禁用的真实执行与 owner 通信接口 | [worker.ts](../src/main/adapters/worker.ts)、[owner-herdr.ts](../src/main/adapters/owner-herdr.ts) | 必须继续 fail closed，不能提前宣称接入 |
| 纯配置校验、类别/模型路由、quota block 过滤与到期判定 | [routing.ts](../src/main/policy/routing.ts)、[json-schema.ts](../src/main/policy/json-schema.ts)、[policy.ts](../src/shared/policy.ts) | 仅选择预览，execution=disabled；无 argv、宿主工具调用或真实派发 |
| policy.v1.json 单写持久化与 revision 冲突检查 | [policy/store.ts](../src/main/policy/store.ts) | 独立 JSON 配置存储，不是目标 SQLite/outbox；不读取或改写上游配置/状态库 |
| Settings 配置/blocks 校验、保存、重载与路由预览 | [Settings.tsx](../src/renderer/Settings.tsx)、[preload.ts](../src/main/preload.ts) | runningCount 是人工输入的假设值，不是活跃进程计数；不能控制 mock 两槽或启动真实 agent |
| 手工导入任务、内联纯文本 artifact | [handoff.md](../skills/agents-cooperation/references/handoff.md) | owner 字段是未验证元数据；重复导入会新建任务 |

当前新增的窄 IPC 为 policy:get/validate/save/preview，preload 方法为 getPolicy/validatePolicy/savePolicy/previewRoute。迁移工作报告 npm run check 通过 37 项测试（19 项新增）；本文核对了对应源码，但未把 headless 环境下未运行的 Electron UI/IPC 标成实机通过。实际运行证据仍以 [VERIFICATION.md](../VERIFICATION.md) 为准。

上游职责、三类工作包、配置路由、review 预算、block 与回收规则来自 [上游固定版本](https://github.com/MarioJames/skill-foundry/tree/61989b11a5d0565d2a6630833e64a2d73769a947/skills/agents-cooperation)。本地审阅文件为 `../../skill-foundry/skills/agents-cooperation/SKILL.md`、`references/config.md`、`references/peer-protocol.md`。迁移技能见 [SKILL.md](../skills/agents-cooperation/SKILL.md) 和 [provenance.md](../skills/agents-cooperation/references/provenance.md)。上游材料不是本机 Herdr/CLI 安装状态证明。

## 3. 进程与服务所有权

```text
用户自己的 agent 宿主 + cooperation skill（仅理解角色与逻辑 API）
          ⇅ MCP / bin CLI（同一版本命令契约；人工导入导出回退）
Electron main：唯一 ControlPlane
  ├─ AgentFacade / OwnerRegistry / LocalTransport
  ├─ OwnerBackendAdapter → 可见 owner（attach 或 spawn，初始 Herdr）
  ├─ CommandHandler → SQLite（实体 + events + outbox）
  ├─ Scheduler / LeaseManager / ReviewCoordinator
  ├─ WorkspaceManager / ArtifactStore
  ├─ ProcessSupervisor → ProviderAdapter → 非交互 worker 进程树
  └─ 有界订阅 / 查询 → preload → React renderer
```

v1 的“服务”是主进程内部模块，不是独立守护进程。关闭窗口默认仅隐藏窗口、仍运行的任务继续，并有托盘/明确状态；真正 Quit 显示影响并走停机流程。平台不支持这种后台交互时，关闭窗口必须直接展示退出确认，不能静默遗留任务。设置页明确这项行为。

启动：取得应用单实例锁 → 打开/检查 DB/schema → 启动 reconciliation → 只读显示历史 → 完成资源核对后开放派发与 owner transport。Renderer 崩溃不停止主进程任务，重载以 cursor 重新订阅。SQLite 不可写/磁盘满时停止派发并请求安全停止现有 worker，不把尚未持久化的结果显示为成功。

退出：拒绝新提交/派发 → 记录 draining → 向所有本应用拥有的活跃 attempt 请求取消 → 有界等待、升级停止 → 刷新 DB/outbox/日志 → 确认资源状态 → 退出。无法确认回收时明确记录 `cleanup_pending`，不宣称全部释放。退出不关闭用户附接的 owner 资源。Weaver 创建的 owner 资源只有在创建时授予的清理策略和归属证据允许时才回收，持有待审结果/未 ack 消息时先保持可见并报告。强制退出或断电走重启核对；v1 不保证杀死无法被 OS containment 约束的任意后台进程，故这类 adapter 不得获得“安全可执行”资格。

## 4. 领域模型

ID 使用不可预测 UUID；时间为 UTC，展示转换本地时区。DB 中所有关联带外键；可变聚合有 `revision` 以防过期命令覆盖。worker 返回的 ID 不可选择任意任务，适配器将输入绑定到本 attempt。

| 实体 | 职责与关键字段 |
|---|---|
| Task | 用户目标、接单 owner、方案版本、验收标准、executionState、acceptanceState、归档状态 |
| WorkPackage | Task 内独立交付单元；负责 owner、类别 mechanical/routine/judgment、scope、依赖、冻结方案引用、验收规则、输入 artifact 版本 |
| Attempt | 某包一次不可变执行；递增序号、adapter/version/config digest、agent、workspace、lease epoch、结果/退出证据、停止原因；重试创建新记录 |
| Agent | 可调度的逻辑 worker 配置；provider、允许模型/effort、能力、启用状态、quota block；不是 PID，也不是 owner |
| Owner | 逻辑注册身份；角色、任务归属、权限、parentOwnerId、spawnDepth、budget、origin=attached/spawned、backendRef、连接 epoch、心跳；Herdr 定位仅存后端私有元数据，显示名不作为鉴权 |
| Session | 通信连接或 provider continuation 引用；kind=owner_transport/provider_context；另存 ownership=attached/owned、resourceGeneration、cleanupPolicy；不是隐藏终端会话，不等同 attempt 生命周期 |
| Lease | 资源写入权与并发槽；holder attempt、resource key、epoch、expiresAt、renewedAt、release evidence；超时不自动证明进程已死 |
| Workspace | 项目根、base commit、隔离 worktree、允许读写范围、资源命名空间、dirty snapshot、回收状态 |
| Artifact | 不可变内容对象；hash、大小、类型、来源 attempt/event、逻辑名称、受控存储位置、验证/隔离状态 |
| Review | 对具体方案/包/artifact 集合 digest 的决定、reviewer、findings、验证证据、轮次预算、accepted/rejected/blocked/superseded |

Task 可以含多个 owner 的包；owner 协作关系是有限成员关系，不是无限递归执行树。v1 接单 owner 的 spawnDepth=0，新协作 owner=1，禁止协作 owner 再 spawn owner；每个 owner 仍只派发一层 worker。各 owner 只能派发/验收自己的包，接单 owner 负责最终集成与裁决。协作 owner 无权跨侧指挥 worker。worker 无注册 owner、变更配置、验收或提交权限。

## 5. 状态机与不变量

### Attempt 执行

| 状态 | 允许后继 | 必需证据/动作 |
|---|---|---|
| queued | preparing / cancelled / blocked | 已持久化包和输入；blocked 不占进程槽 |
| blocked | queued / cancelled | 仅限尚未启动的 attempt；阻塞解除且输入/授权版本未变时回 queued，否则取消并新建 attempt |
| preparing | running / failed / cancelling / unknown | 获取 scope lease、准备 workspace、持久化启动意图、启动并验证身份 |
| running | finishing / cancelling / failed / unknown | 收到有效最终结果后进入 finishing；不能直接写成功 |
| finishing | succeeded / failed / cancelling / unknown | 有效 final + 输出完整关闭 + 零退出 + 所需进程树结束 + artifact 校验才 succeeded |
| cancelling | cancelled / failed / unknown | 停止原因保留为取消/超时/协议错误；确认树退出前不释放写入权 |
| unknown | failed / cancelled | 控制面丢失观察；归属未明时附加 manual_reconciliation 标记并保持 unknown，核对资源后给终态，绝不仅靠旧 PID 判断 |
| succeeded / failed / cancelled | 无 | 终态不可改写；补充 cleanup 事实独立记录；重试新 attempt |

`manual_reconciliation` 和 `cleanup_pending` 是资源核对标记，不是额外的 attempt 生命周期状态。`failed` 可带 `cleanup_pending`，此时原 lease 仍保留，包仍不允许重新取得冲突 lease；资源清理确认后仅更新标记与 lease，不改写失败终态。协议错误导致的终止是失败，不伪装成用户取消。取消命令和成功提交按 DB 序列排序：成功已提交时取消返回 already-terminal；取消先提交时之后到达的 final 仅保留为部分证据，不改成功。

### WorkPackage / Task / 投递

- 包：`draft → ready → queued → executing → awaiting_review → accepted`；还可 `blocked / failed / cancelled / needs_changes`。Review 拒绝不修改已结束 attempt；新包版本/attempt 修复。
- 依赖默认只在上游包 **accepted** 且输入 digest 固定后解锁，不在 worker succeeded 时解锁。共享接口先冻结再并行；DAG 入库时拒绝环。
- Task.execution：`not_started / active / blocked / done / failed / cancelled`。`done` 表示所有必需包达到成功执行且无活跃资源，并不代替最终验收。
- Task.acceptance：`not_ready / pending / accepted / changes_requested`；只有具权限的接单 owner 对完整集成结果和验证证据操作 accepted。代码集成与本地提交需单独记录证据。
- 结果投递：`pending → sent → acknowledged`，失败进入 `retry_wait` 或 `manual_required`；acked 仅表示 owner 客户端持久接收，不能自动变为 accepted。
- Owner 离线不改写已完成执行。暂停该 owner 的新派发；正在运行的有界 attempt 按既定授权继续或按预先选定策略取消。没有显式策略时继续当前 attempt、保存结果、等待重连，禁止无限重派。

## 6. 调度、幂等与写入权

每个提交命令带 `(ownerId, commandId)` 与请求 digest。相同键+相同内容返回既有结果；相同键+不同内容拒绝。人工 v0.1 导入保留原有“每次创建新任务”行为；v1 自动命令使用新版本 envelope，不能暗改旧语义。

派发条件：方案门槛放行、依赖 accepted、owner 有效、provider 能力符合、授权齐全、配额可用、scope 无冲突、并发有槽、workspace 可写。每个 owner 的 `max_parallel` 保留；单机控制面现在能准确计数受管 worker，因此增加用户可见的全局资源上限，作为桌面资源护栏，不冒充上游原规则。外部宿主管理的 native worker 不计入“已知受管容量”，不得声称总量受控；v1 任务不得混用未登记外部执行。

同 workspace 的重叠写 scope 串行；路径按文件系统大小写和规范路径比较。目录 scope 包含后代，依赖/锁文件变更视为共享资源。v1 优先每 attempt 独立 worktree；worktree 只隔离文件版本，不是安全沙箱，也不隔离 Git 公共元数据、数据库或网络。需要共享工作树必须显式开启且租约不重叠。

```ts
// 设计伪代码：同一 SQLite 事务内只做本地确定性决策，不执行 spawn。
transaction(() => {
  dedupe(command.ownerId, command.commandId, hash(command));
  requireCurrentRevisionAndAuthority(command);
  assertDependenciesAcceptedAndApprovalsValid(pkg);
  assertCapacityAndNoConflictingLease(pkg);
  const attempt = insertAttempt(pkg, "preparing");
  acquireLeases(attempt.id, nextEpoch());
  appendEvent("attempt.dispatch_requested", attempt);
  insertOutbox("spawn", attempt.id, uniqueDispatchId);
});
// Supervisor 消费 outbox，使用唯一 dispatchId；spawn 结果另行事务记账。
```

OS spawn 与 DB 不能原子提交，不能承诺 exactly-once execution。Supervisor 为每次启动保留随机 launch nonce、启动意图、进程身份和 containment 标识；同进程内消费去重。跨崩溃存在“已 spawn 未记录”的不确定窗口：先 containment 核对并停止/人工处理，绝不再次自动 spawn。用 at-most-one-active + 可见 uncertain 状态控制风险。

配额错误由 adapter 识别为有证据的 block（provider/model/account 范围）；仅当明确恢复时间存在时自动到期，其他手动解除。重试有最大次数/退避/总时长，失败分类为 retryable、approval_required、configuration、terminal。只有停止证据、部分产物核对和写入权释放后才可重试；有潜在外部副作用的失败不自动重跑。包整体改派保留来源和原因，不在同一 attempt 中悄悄换模型。

## 7. 事件协议与 provider adapter

厂商原始输出不等于 Weaver 协议。Adapter 读 stdout/stderr，按该 CLI 的已验证版本解析，产生有限 normalized event；控制面赋序号并决定状态。未知厂商记录可保留有界 raw evidence，不能当作完成；不支持的关键记录直接失败。

```ts
// 概念接口，非当前 src/shared/types.ts 的已实现导出。
interface EventEnvelope<T> {
  schema: "weaver.event"; major: 1; minor: number;
  eventId: string; taskId: string; packageId: string; attemptId?: string;
  seq: number; recordedAt: string; observedAt?: string;
  source: "control" | "adapter" | "owner";
  kind: string; payload: T; causationId?: string; rawRef?: string;
}
interface ProviderAdapter {
  id: string;
  probe(): Promise<CapabilityReport>; // 本地、只读，不自动启动 agent
  prepare(input: DispatchSpec): Promise<LaunchSpec>; // exe + argv 数组，shell:false
  normalize(stream: AsyncIterable<Uint8Array>): AsyncIterable<NormalizedRecord>;
  classifyFailure(evidence: ExitEvidence): FailureClassification;
  // 不直接授权、改 DB、验收或杀任意 PID。
}
interface CapabilityReport {
  executableRealPath: string; executableVersion: string;
  adapterVersion: string; protocolVersions: string[];
  nonInteractive: boolean; structuredOutput: boolean;
  modelEvidence: "reported" | "configured_only" | "unknown";
  permissionMode: string; supportedResume: boolean;
  processContainment: "verified" | "unsupported";
  available: boolean; reasons: string[];
}
```

Normalized kinds 至少包括 `attempt.started`、`worker.log`、`worker.progress`、`worker.heartbeat`、`artifact.proposed`、`worker.final`、`approval.required`、`provider.quota_blocked`、`process.exited`、`attempt.finished`、`review.recorded`。其中 process/execution 终态只能由 supervisor/control 产生；worker 不能伪造控制事件。百分比仅作提示，心跳不等于进展，日志中的“成功”不作为 final。

协议规则：UTF-8 framing、有界行/总量/速率、严格 runtime schema、唯一 final、final 后仅允许 adapter 明确映射的退出元数据；原始 stderr 与 normalized event 分开。raw 内容可能含凭据，默认不长存、先脱敏、有限保留，导出需确认。输出洪泛不阻塞 UI；背压/磁盘阈值触发可审计失败和停止。

所有 command/event/artifact manifest 都有 schema major/minor。major 不支持则拒绝；minor 只允许已规定的可忽略扩展，关键语义字段未知必须拒绝。adapter 声明厂商版本兼容范围及 fixture digest，版本变化重新 probe；不得只检查有无可执行文件。实际模型无法证明时 UI 写“请求模型，未验证”，不写成已验证模型；严格包可因此阻塞。

## 8. Agent 逻辑入口、owner 生命周期与结果回执

Skill 面向统一 AgentFacade，MCP 与 bin CLI 只是两种入口，调用相同 CommandHandler、授权与幂等机制，不各自创建进程或维护另一份状态。逻辑能力包含 owners.spawn、owners.attach、workers.spawn、tasks.get/list/events、attempts.result/cancel、results.ack、reviews.submit；准确命令名与信封见 [Agent 接口设计](agent-interface.md)。客户端不传 shell 命令、Herdr session/pane ID 或任意 executable，而是受控 profile 的逻辑标识。切换后端不改 skill 的调度原则和任务协议。

v1 内部首选本机 IPC endpoint（Unix-domain socket / Windows named pipe），只允许当前 OS 用户；不默认监听网络端口。先实现 bin CLI，再以 stdio MCP shim 包装同一 IPC；两者使用 weaver.v1 契约，桌面未运行返回 APP_NOT_RUNNING，不能偷偷启动独立控制面。平台 ACL、socket 权限与 Electron IPC sender 校验均需本机验证。任何桥接工具都不是新的模型会话；spawn owner 才是创建新 agent 的显式动作。

OwnerBackendAdapter 负责 probe、attach、spawnVisible、send、observe、release；把 Herdr 定位/原生命令收在后端。owner、worker 使用不同创建路径：前者是可见的交互协作身份，后者是结构化输出的非交互执行 attempt。适配器不能自行扩大权限或派发子 agent。

- **attach owner**：桌面显示一次性短期 pairing challenge → 用户在现有可见会话确认 → 客户端证明挑战 → 后端验证资源身份/可见性 → 注册逻辑 ownerId。记录 ownership=attached；Weaver 只有登记/通信/撤销权，默认没有关闭用户会话的权力。不能验证时 manual/unverified，不允许自动控制。
- **spawn owner**：具权限的接单 owner 提交目标/角色、profile、项目范围、预算和 commandId → 控制面检查允许的后端、最大 owner 数、深度、成本/时限、用户授权与所需外部审批 → 持久化创建意图/资源租约 → 后端创建可见资源并完成身份握手 → 返回逻辑 ownerId。资源 ownership=owned，记录创建凭证、generation、父任务和清理策略；失败窗口按 worker 同样保守核对，不重复盲建。
- 生命周期：requested → provisioning → awaiting_pairing → ready → draining → closed；失败可为 failed，归属不明附 reconciliation 标记。spawn 返回受理不等于 ready；只有已验证 ready owner 可以接包；异步创建返回 ownerId + operationId 供查询，不伪装成已就绪。附接对象撤销后是 detached，不宣称进程已结束。
- 上限：v1 仅接单 owner 可 spawn 协作 owner；协作 owner 不可再次 spawn owner，worker 无任何 spawn 权限。每任务设置 owner 数、活跃 worker 数、累计成本/时长预算，继承权限取父级与用户授权的交集。改变角色/额度/权限需相应授权，不靠模型描述自我升级。
- 收尾：取消单个任务不关闭 owner 会话。只有明确 owner 生命周期结束时，撤销该 owner 的逻辑凭据与租约；attached 仅断开，不关闭；owned 根据已授权策略在工作、review 与投递收尾后关闭本次创建的精确资源。超时、异常退出或归属不能证明时保持可见并记 cleanup_pending，不能关闭同 pane 名称的新资源。用户选择保留则转成显式保留记录，不静默变成永久后台会话。

凭据只存 OS 安全存储或同用户受限文件，不写 argv/日志/artifact。权限限制到指定 task/owner 操作；后端资源重新绑定、接单 owner 转移、连接身份变化需重新验证。撤销凭据后停止新命令，结果仍保留。重连使用新 connection epoch，旧连接不能续租或提交新决定。

命令集合：submit/amend package、cancel attempt、request retry、review/accept、query、ack events。修改运行中范围必须取消旧 attempt 或排队新 revision，不热改执行授权。返回结构化 command receipt（accepted/rejected、revision、event cursor）；用户可看到命令来源。

事件使用持久 cursor/seq 拉取或双向推送，至少一次送达；每 owner/task 有独立 cursor。发出不删除 outbox，收到 `ack(deliveryId, lastSeq)` 后事务记录确认。重连从最后 ack replay；重复消息由 deliveryId 去重，乱序按 seq 补洞。cursor 早于保留窗口时发 snapshot + 新 cursor，不能默默跳过关键结果。结果摘要包含任务/包/attempt、产物 manifest digest、退出证据、验证状态、待验收事项，附受控读取接口；不发送任意本地路径让 owner 自行信任。

初始 Herdr 后端若只有屏幕发送、没有机器可读 ack，最多只能证明 `sent_unconfirmed`；不得伪造端到端确认。能力不足则保持手工导入 + 桌面导出结果信封 + 用户交给 owner 的回退；回执、验收必须显式记录。等待 owner 重连不保留空闲 worker。

## 9. 心跳、取消、崩溃与 resume

三种活性分开：owner transport 心跳、supervisor 进程存活、worker 实际进展。lease 使用单调时钟判断本次运行内期限；持久时间用于审计，重启不能因系统时钟倒退而自动恢复租约。超时阈值按包配置，含总执行时限、无进展时限、取消 grace；不能让持续刷日志无限延长预算。

ProcessSupervisor 统一负责启动/停止进程树。POSIX 进程组仅是基础，子进程可脱离；Windows Job Object、Linux 受控 cgroup 或平台等价包含需要真实验收。macOS 若不能可靠包含已知 provider 派生进程，先限制为已验证生命周期的 provider，或阻塞真实模式，不能以 kill(-pid) 宣称安全。绝不杀用户附接的 CLI、Herdr 或未归属进程；只允许按授权清理本任务创建且归属可证明的资源。

取消：持久化请求 → adapter 如支持则协作取消 → grace 后向已验证 containment 发 TERM → deadline 后 KILL/平台等价 → 检查树为空与输出关闭 → 记终态 → 核对 workspace 和 artifact → 释放 lease。停止过程中不重派。仅 direct child exit 不足以释放真实 worker 的资源。

启动记录不只存 PID，还存启动时间/OS birth identity、随机 nonce、父监督实例、containment ID、可执行路径。重启按 DB 启动意图核对：

| 观察 | 处理 |
|---|---|
| 有活跃记录，无对应本应用进程 | 标 interrupted/failed；核对部分产物后释放资源 |
| 有可证明本应用拥有的遗留树 | 默认停止并核对，不重接 stdout；新 attempt 才可重试 |
| PID 存在但 birth identity 不同 | 视为 PID 复用，不发信号；原 attempt interrupted |
| 归属不能证明或 containment 无法查询 | 保持 unknown 并标记 `manual_reconciliation`，冻结冲突 lease，告知用户，不自动 kill/retry |
| 有未完成 artifact staging 文件 | 不作为结果；按 manifest 恢复验证或隔离 |
| 有未 ack outbox | 重发同一 deliveryId；不重跑 worker |

Resume 不等于恢复旧 PID。v1 默认将保存输入、已验收 artifact 和失败摘要交给新 attempt；厂商 session continuation 只有在版本、权限、workspace/base digest 一致且用户策略允许时才启用，并记录 predecessor/context token 引用。不能恢复时明确新执行，不能假称“继续原进程”。取消后的 context 不自动续接；所有重试继续遵守相同总预算与外部副作用核对。

## 10. SQLite、文件库与一致性

目标数据库表：tasks、packages、package_dependencies、attempts、agents、owners、sessions、leases、workspaces、artifacts、reviews、events、outbox、command_receipts、schema_migrations。状态投影与追加事件在同一事务写入；主进程单写者，SQLite foreign keys/约束启用，本地磁盘 WAL + 适当 synchronous 配置，具体绑定和崩溃测试本机再定。DB 不放网络共享目录。

不做完全 event-sourcing 框架：实体表是查询权威，event 是审计/投递依据，必须在同一事务一致。`(owner_id, command_id)`、`(attempt_id, event_source_seq)` 等唯一约束防重复；outbox 消费者均需幂等。不能通过“先更新状态后 emit”留下丢消息窗口。

文件与 DB 没有跨介质事务。Artifact 先写同文件系统 staging → 流式 hash/限额/类型校验 → flush 并 rename 到内容寻址库 → DB 事务登记 manifest + 事件 + outbox。崩溃留下未引用 blob 可稍后 GC；DB 不引用尚未提交的 blob。打开时再核对存在和 digest，损坏标 quarantined。批量 GC 先标 tombstone、检查引用和保留策略，再删除；最终交付、review 证据与正在投递的结果不自动删。备份使用一致 SQLite backup 方法和对应 blob 清单，不直接复制活跃 WAL 中的单一 DB 文件。

迁移先备份、校验、独占锁、事务升级，再切换；不支持的新 major 只读/阻塞，禁止回写。旧 JSON 原文件保留，导入记录来源 digest 与 migration ID，重复迁移不会产生重复任务。旧 `completed` 映射为 legacy execution succeeded、acceptance pending/unverified；不能补造 owner 验收或真实模型证据。

## 11. 权限、workspace 与 artifact 安全

执行权限分成三份：用户授权的 scope/policy、owner 签发的包、provider 实际 enforcement。Prompt 约束不是隔离。只允许配置中的绝对可执行文件、参数数组、`shell:false`、明确 cwd、清理后的环境 allowlist；不继承整套 SSH/API/云凭据。需要 provider 登录凭据时按本机支持机制最小授予，敏感内容不进任务/日志。禁止从 worker 输出动态拼接执行命令。

工作目录位于受管 workspace，v1 优先只读探测，再开启明确文件范围的写能力。OS sandbox/CLI 权限不足以实现所承诺 scope 时，UI 说明实际权限；用户必须认可该执行边界，否则阻塞。网络访问、安装、外部通信、数据删除、提交/推送等分别有审批门槛，不能用上游“免审批”argv 默认放行。审批绑定 attempt/package revision、动作与目标、数据和权限，变化必须重审；持久批准不由模型输出生成。

Worktree 内 `.git`/共享 metadata、symlink 指向外部、硬链接、子模块、挂载点都可能越界，不能仅凭字符串前缀判断。Artifact 路径提案只允许受管输出目录的相对逻辑路径；拒绝绝对路径、`..`、UNC/设备路径、NUL、非法编码和大小写冲突。逐层防 symlink，使用平台安全打开/目录句柄与 no-follow 语义，打开后 fstat 核对类型/身份，避免检查后替换（TOCTOU）；平台不能保证时拒绝文件导入而非降级为不安全读取。禁止 FIFO/socket/device，设文件数/单体大小/总量/深度限制。v1 不解压 worker 提供的归档，不跟随外部链接。

文件内容复制进受控内容寻址库，再算 SHA-256、大小与媒体类型；媒体类型不信任扩展名。Artifact provenance 包括 task/package/attempt、adapter版本、输入/基线 digest、producer event、导入时间、验证结果。相同 hash 可去重，逻辑 manifest 仍分别保留来源。部分产物标 partial，不自动成为下游输入。

Renderer 无 Node/任意 fs/通用 IPC，沿用 context isolation、sandbox、精确 sender 校验、CSP 和远程请求拒绝。v1 只把文本/Markdown/JSON 当纯文本渲染；未来 HTML/SVG/富文档必须隔离、无脚本无网络无本地文件访问。打开外部程序、网址、导出覆盖文件是独立用户动作。Worker 文本及 artifact 都是不可信内容，不能指挥控制面变更权限、验收、重试或联系第三方。

## 12. 桌面 UI

- **任务总览**：按任务而非终端 pane 组织，显示接单 owner、包进度、执行/投递/验收三状态、阻塞与待决策。不能把 succeeded 显示成“已验收”。
- **任务详情 / DAG**：方案版本、工作包、依赖、scope、输入、各 attempt 时间线；保留失败和重试历史。
- **执行面板**：逻辑 agent、请求/实际模型、provider/version、PID 仅作诊断、containment、心跳/最近进展、超时、取消过程、资源租约。
- **Owner 面板**：逻辑身份、attached/owned、角色/父任务、深度与预算、ready/provisioning/offline、配对/创建/撤销、最近 ack、待投递消息；后端定位仅在诊断区，不新增 hidden-session 管理页。
- **Artifacts / Review**：不可变版本、diff、验证命令与结果、partial/quarantined 标记、review findings、接受/退回及证据；分离 owner 接收和验收按钮。
- **权限与能力**：各 adapter 探测报告、兼容版本、权限范围、成本/额度 block、只读/真实执行开关。
- **恢复中心**：unknown、cleanup_pending、未释放 lease、失败 outbox；给出可操作下一步，危险清理不隐藏在一键重试里。
- **审计/设置**：配置来源、有效值、变更记录、保留/导出/删除、应用关闭行为。UI 只调用窄命令 API，不写 DB。

## 13. 保留协作规则，替换运行载体

保留上游的 owner/worker 两层职责、mechanical/routine/judgment 分类、配置驱动模型/effort/额度、明确 scope 与冻结方案引用、review 预算、部分产物核对、依赖验收后解锁、单包整体改派、仅接单 owner 最终集成/本地提交。台账由桌面事实生成，owner 可用于汇报，不能隐藏失败/回收异常。

明确替换：同引擎 native/异构 Herdr interactive 的执行选择统一改为受管 process adapter；旧 hidden run/lane/session 生命周期退出。配置导入只能保留语义字段，旧 argv/免审批开关不自动执行。旧 runtime DB 不并入新运行权威，旧任务只作为只读历史，绝不接管旧 PID/pane。跨 owner 继续在可见会话讨论；如当前 owner 后端不可用则选另一个已验证且获准的后端，或单 owner/人工回退，写明降级，不能创建隐藏替代。Skill 只保留角色、调度和 review 原则，配置验证、路由、quota block 与执行决策在桌面 policy/control 内完成；MCP/bin 暴露统一逻辑入口，不把 Herdr 操作搬回技能。

ChatGPT 审查开关、必须/免审判定和轮次预算属于协作 policy，不由 provider adapter 自行决定。设计和结果审查记录关联不可变内容版本；关闭自动审查仍需本地 review，不能显示“已通过”。任何外部审查实际发送材料之前仍检查用户授权。迁移不悄悄扩大旧配置权限。

## 14. 发布验收矩阵

以下为未来必须通过的测试，**本文没有执行这些验收**。

| 场景 | 通过标准 | 层级 |
|---|---|---|
| 正常 final + 零退出 | 执行成功、产物已校验、验收 pending | unit + fixture + 本机 |
| final 后非零退出/缺 final/截断 JSON/洪泛 | 有界失败，部分证据保留，不解锁依赖 | fixture |
| 重复提交/重发 ack/乱序 reconnect | 一份 command 效果、一份投递确认，无重复执行 | unit + integration |
| DB 提交与 spawn 窗口崩溃 | 不确定记录可见，不盲目重派 | 故障注入 |
| worker 派生子进程及脱离尝试 | 取消后树空才释放 lease；不支持则禁用 | 各 OS 本机 |
| PID 被复用/归属不明 | 不误杀，进入核对 | fixture + OS |
| owner 离线/可见后端资源消失 | 结果留存、重连 replay；不新建 hidden session | owner adapter 本机 |
| attach/spawn owner 与越权递归 | 身份握手后才 ready；深度/预算/权限受控，重复命令不重复创建 | fixture + 本机 |
| owner 清理与同名资源复用 | attached 永不自动关闭；owned 只清理精确归属资源，失败可见 | owner adapter 本机 |
| 双 owner 并发/越权验收 | scope/并发限制生效，跨侧越权拒绝 | integration |
| 审查退回/上游未验收 | 新 attempt 历史保留，下游仍锁定 | unit |
| symlink/路径穿越/TOCTOU/超大文件 | 不越界读取，隔离并记审计 | 安全测试 |
| 恶意 HTML/输出指令 | 无脚本/联网/自动控制动作 | renderer |
| schema 变化/CLI 版本变化 | fail closed，保留诊断，旧数据不损坏 | fixtures + 本机 |
| 磁盘满/断电/损坏 blob/迁移中断 | 不假成功，安全恢复或可见阻塞 | 故障注入 |
| 配额/审批/外部副作用不确定 | bounded retry、必须审批、不重复副作用 | integration |
| 用户退出/Renderer 崩溃/应用重启 | 控制面生命周期一致，owner 会话不被关闭 | Electron 本机 |

最高风险依次是：真实 CLI 不能可靠隔离/回收进程树、Herdr 缺少认证与可靠回执能力、厂商 JSON/version/approval 语义变化、spawn 与存储间不确定窗口、artifact 路径攻击、用户把执行成功误认为验收。以上均以发布 gate 处理，不能用文档承诺替代本机证据。
