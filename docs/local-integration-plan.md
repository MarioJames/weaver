# Weaver 用户本地集成计划

> 实现状态更新（2026-10-18）：下文保留完整目标设计，不能把其中旧的“CLI 未实现 / 只有预览”描述当作当前状态。已实现 weaver.v1 共享 handler、Unix CLI/认证 IPC 代码、mock owner/worker 适配层、策略准入/排队、结果验收、上下文轮换及同步快照。真实 agent 接入、外部 owner scoped auth、SQLite/outbox 和生产级进程树控制仍待实现。CLI 的真实 socket 集成因当前环境 EPERM 未验收；最新事实见 [README](../README.md) 与 [VERIFICATION](../VERIFICATION.md)。

状态：后续执行方案，2026-10-18。对应 [全生命周期架构](architecture.md)。本文负责设计与后续集成；并行纯策略迁移不启用真实执行。不运行 Codex/Claude/Herdr 等真实 agent，不调用模型 API，不安装 skill 到用户宿主、不修改用户配置，不启动云任务。除下述已实现 policy 模块与现有 mock 外，文中的新模块/API 名称是目标，不是现有命令。

## 1. 交付与开始条件

当前执行仍为 mock：手动 JSON 导入、显式运行 mock、事件与文本产物、简单取消和 JSON 历史。已新增纯 policy 校验/路由/quota block 模块、policy.v1.json 与 Settings 配置/预览界面；它们不执行 agent，不返回启动 argv，不改变 mock 固定两槽。预览 runningCount 只是人工假设值，不是实际并发观测。用户可以把源码带到本机，先按 README 安装依赖、运行测试和打开 Electron。**打开应用不等于真实 agent 已接通。** 不要因看到成功示例而把真实任务标为完成。

本地实施开始前，由用户明确：

- 使用的 OS/版本、目标代码目录，以及哪些内容可读/可写
- 自己的 agent 宿主及 skill 安装位置；要附接现有 owner，还是允许创建新的可见协作 owner
- 第一种要支持的真实 worker provider，允许的模型/effort、费用与网络边界
- 是否仅做只读试运行；随后哪些测试仓库允许有界修改
- 权限/凭据如何由用户在本机配置，是否需要审批桥接

缺少这些信息不妨碍做 schema/fixture/mock 工程，但阻塞真实执行。不要为“验证连接”悄悄启动收费 agent。优先本机已安装工具；安装、登录、持久凭据和权限扩展分别按用户批准处理。

## 2. 分阶段路线与停止门槛

每阶段交付独立可审阅变更，上一阶段通过后才解锁依赖它的下一阶段。贯穿保留 mock，所有真实功能默认关闭。纯 policy 迁移是现有安全前置成果，不意味着 P1 的事务存储、P2 的真实调度或 P5 的 MCP/bin 已完成。配置的 max_parallel 目前只用于预览，接入权威 scheduler 后才能强制控制真实并发。

| 阶段 | 实施内容 | 可验收交付 | 退出门槛 |
|---|---|---|---|
| P0 基线 | 本机启动 mock；记录 OS、应用版本、测试结果与 UI；备份旧 JSON | 基线报告、可重现测试日志 | mock 完整流程可运行；失败先修基线 |
| P1 领域与持久化 | 包/attempt/review/lease schema、SQLite 单写事务、events/outbox、迁移 | schema、迁移测试、旧历史导入预览 | 旧 completed 不变成 accepted；崩溃/回滚测试通过 |
| P2 控制面 | 命令幂等、DAG、权限检查、调度、并发槽、scope lease | 仍使用 mock 的多包 UI、重复/冲突测试 | 不重复执行，不提前解锁依赖，无跨 owner 越权 |
| P3 生命周期与文件库 | Supervisor、OS containment、取消升级、恢复核对、artifact 导入安全 | 恶意 fixture/故障注入、恢复中心 | 真实执行前必须通过进程树与路径安全 gate |
| P4 首个 provider | 只读 probe、版本 fixture、native event normalizer、权限策略 | 能力报告与显式启用开关 | 不支持非交互/结构化/安全回收即阻塞 |
| P5 Agent 入口与 owner 后端 | 统一 MCP/bin 命令、attach/spawn owner、配对、深度/预算/权限、ack/replay、owned/attached 清理 | skill 无 Herdr 耦合；初始 Herdr 后端往返闭环 | 未验身份不进入 ready/派发；无可靠确认不伪造 ack；附接资源不自动关闭 |
| P6 受限真实试验 | 用户许可后，从只读到隔离写入；review 与重试 | 小型本地测试仓库的端到端证据 | owner 真正核验，资源干净，实际权限符合说明 |
| P7 异构验证与发布 | 第二种 provider、双 owner、版本兼容、打包签名 | 兼容矩阵、安装/升级/卸载/备份说明 | 不以一种厂商协议冒充通用协议 |

P4 与 P5 的只读调查可以并行；两者不得绕过 P3 的安全 gate 开启真实执行。生产 v1 需要 P7；若只完成 P4/P6，版本必须标明“单 provider 实验接入”，不能宣传已完整支持异构协作。

## 3. 本机能力调查：只探测，不猜旗标

为每个 provider 记录以下证据，原始输出先脱敏：

1. 可执行文件的规范绝对路径、版本、签名/安装来源（如平台可查）
2. 本机 `--help` 等官方只读入口及对应版本的官方文档；不要直接执行未知子命令以试错
3. 非交互模式、输入方式、stdout/stderr 格式、final 与退出码语义
4. 模型/effort 请求及实际模型证据；无法证明时标 unverified
5. 认证现状、网络需求、权限/沙箱模式、是否可能停在交互提示
6. 取消方式、子进程派生、工具命令执行边界、是否可脱离 containment
7. resume token 的范围、持久位置、版本依赖与重放副作用
8. rate limit/配额/审批所输出的可区分结构化错误

每项给 `verified / unsupported / unknown` 和证据时间。只有 help 中存在某个 JSON 标志并不证明所有执行路径都结构化，也不证明没有交互。真实只读 smoke 仍须用户同意费用/权限后才做。更新 CLI 后重新探测并跑 fixture；未经兼容确认的版本默认禁用。

Herdr 作为首个 OwnerBackendAdapter 分别确认：可见资源的查询与稳定 ID、创建新的可见 owner 的能力、是否能区分隐藏资源、附接现有 owner、按创建凭证精准回收 owned 资源、宿主接收逻辑 MCP/bin 调用的入口、是否有可认证双向回执。此调查属于后端，不把 Herdr 操作写入 skill。源仓库里见过的 `agent prompt/read/wait` 只能作为调查线索，不能提前写死 argv 或宣称本地可用。若只支持屏幕读写，不做基于抓屏猜测的可靠 transport；保留人工工作流。

## 4. 目标模块拆分与修改顺序

以下为拟新增/拆分目录，不表示本轮已创建代码：

```text
src/shared/contracts/       command / event / manifest / capability schemas
src/main/control/          command-handler, scheduler, owner-registry, review
src/main/persistence/      SQLite repository, migrations, outbox
src/main/execution/        supervisor, containment/<platform>, reconciliation
src/main/workspaces/       scope leases, worktrees, dirty-state inspection
src/main/artifacts/        secure ingestion, content store, manifests
src/main/adapters/         mock + worker provider + owner backend（初始 Herdr）
src/main/agent-interface/  MCP/bin facade，共享 command handler 与鉴权
src/main/policy/           纯配置校验、路由与 quota block，无执行副作用
src/renderer/              task/package/attempt/review/recovery views
```

先引入版本契约与 repository 接口，用现有 mock 验证；再把 manager 拆出调度/执行/状态转换职责。不要一边更换存储、一边启用真实 CLI、一边重写 UI，导致无法归因。`WorkerCliAdapter` 和 `HerdrOwnerAdapter` 的禁用行为在各自 gate 通过前保持不变。

建议工作包：

- 契约与迁移：只修改 shared contracts/persistence/tests，先冻结接口与 migration mapping
- Supervisor/containment：只修改 execution/adapters mock fixture/tests，依赖冻结的 Attempt/Event
- Artifact 安全：只修改 artifacts/workspaces 指定部分，与 Supervisor 协调 lease API
- Agent 接口/owner 后端：只修改 facade、owner adapter/registry/tests，依赖 command/outbox 契约；MCP 与 bin 不能绕过同一授权和预算 gate
- UI：只消费冻结 preload API，不在 renderer 调用 Node/DB
- Provider：每个 provider 独立 adapter 和 fixture，无权改变审查/权限 policy

交叉部分由 owner 先冻结再派发；重叠 scope 不并行写。修改最终代码/文档由 worker 做，owner 负责 review、裁决与本地提交。验证命令及实际输出进入 review evidence，而不是只记录“测试通过”。

## 5. Skill 与配置迁移

安装入口保持简单：用户把仓库里的 `skills/agents-cooperation` 整个目录放到自己宿主支持的 skill 目录，再打开 Weaver。不得猜测所有宿主共享一个安装路径，也不自动修改全局配置。P0 仍用现有人工 handoff；P5 完成后技能只描述逻辑 MCP/bin 能力，永不要求技能知道 Herdr、pane、进程命令或后端切换。统一接口设计见 [Agent 接口设计](agent-interface.md)。

分两层维护技能：

- 稳定的协作 policy：owner/worker 分工、类别、拆包、冻结方案、review、预算、授权、收尾
- 有版本号的逻辑调用指引：attach/spawn owner、spawn worker、提交/查询/结果验收方式、能力不足的回退、当前版本限制；不包含配置校验算法、路由脚本或 quota 状态写入实现

迁移旧配置前先只读展示映射与差异。可映射 owner/worker ID、类别标签、模型偏好、effort、并发限制、额度 block 和审查开关；不能无提示移植任意启动 argv、旧 hidden session/lane 标识、免审批标志、旧凭据或全局路径。新增全局资源上限明确属于 Weaver 新约束，不静默覆盖原 owner 上限。

旧 runtime 的 `agents-runtime`/`route-lane` 不再用于 Weaver worker；迁移不关闭、清理或接管旧会话。用户若仍有旧任务，先在旧系统完成/关闭，Weaver 仅可导入审阅后的历史摘要。旧数据库不成为新 DB 的第二写者。

新增 review 状态不能倒填历史认可。原 JSON 导入的 owner 保留 `unverified`，需要重新配对；原 completed 仅作为 legacy execution 事实。人工导入每次新建任务的 v0.1 语义保留；新自动提交通过 schema major + commandId 明确启用幂等。

## 6. 端到端试验脚本（未来人工执行步骤）

### A. 不使用真实 agent 的控制面试验

1. 创建含两个独立包和一个依赖包的任务，设置明确 owner、scope 与验收条件
2. 同一 commandId 重复提交，确认只有一个逻辑提交；不同内容复用 ID 应拒绝
3. 让两个 mock attempt 运行，第三个等待容量/依赖；final 到达但进程未退出时仍不成功
4. Owner review 之前，依赖包不得运行；记录验收后按固定输入 digest 解锁
5. 通过 MCP 和 bin 分别提交同一 commandId，确认共享幂等/权限结果；断开 owner 入口，完成结果应留在 outbox；重连 replay、重复 ack 不造成重复验收
6. 注入取消、非零退出、JSON 截断、输出洪泛、心跳不断但无进展
7. 在准备、spawn、final、文件 rename、DB 提交、outbox send 各窗口强制中断应用；重启核对不得重复执行或误杀
8. 用 fake owner backend 分别测试 attach/spawn：预算不足、递归创建、越权 profile 均拒绝；重复 spawn 不重复创建；附接资源仅 detach，owned 仅清理精确创建资源

### B. 用户许可后的第一种真实 provider

1. 选择没有敏感信息的测试仓库，明确只读 scope，禁用写入与外部副作用
2. 用户确认费用/网络/实际权限后，运行一个可快速核对的读取任务
3. 对照 provider 原始证据验证 normalized events、实际模型显示、退出与停止语义
4. 取消一个会产生受控子进程的测试任务，确认整个所属进程树退出且用户已有 Herdr/CLI 不受影响
5. 在隔离 worktree 做一个小修改，核对 base commit、变更文件、测试结果和 artifact hash
6. owner 自己查看 diff 并复跑关键测试，记录 review；确认 execution done 与 accepted 分离
7. 拒绝一次结果，产生新 attempt，确认历史不可覆盖、旧进程已停止、写入权没有重叠
8. 有疑似外部副作用或未知进程时停止扩展，进入恢复中心处理，不能直接点重试

### C. 第二种 provider 与双 owner

重复同一测试夹具与权限策略，不把首个 provider 的 flags/JSON/schema 套给第二个。一个 owner 附接现有可见会话，另一个在授权/预算内通过逻辑 spawn owner 创建（初始由 Herdr 后端承载）；两者都可见且身份握手完成，各自派发自己的包；交叉 review 只产生 findings，不能越权修改/验收对方工作。证明 model/effort 配置正确、配额整包改派有记录、结果按各 owner cursor 送达。验证协作 owner 不能再次创建 owner，worker 不能派发任何 agent；结束时 attached 会话保持、owned 按授权策略回收。任何步骤都不创建 hidden session 或 worker pane。

## 7. 发布检查与可接受降级

必须维护一份真实运行证据表：OS、Electron/Node、provider/Herdr 版本、adapter版本、测试时间、执行者、通过/失败/未验证、脱敏日志/fixture引用。现有 [VERIFICATION.md](../VERIFICATION.md) 只代表原 scaffold 的检查，不能被本文当作未来集成通过记录。

发布前检查：

- mock 回归、契约/迁移/幂等测试、renderer 安全与主进程授权测试通过
- process-tree containment、PID 复用、重启不确定窗口、磁盘错误已在所宣称支持的 OS 验证
- Artifact 路径穿越、symlink、大小/类型限制和预览不执行已验证
- MCP/bin 共享逻辑协议和鉴权；owner attach/spawn、身份/可见性、深度/预算、双向 delivery/ack/replay 与差异化回收已验证；未通过时按实际能力标“手工交接”或“仅附接 owner”，不能宣称 spawn owner 可用
- 真实 provider 的非交互/JSON/退出/权限/模型证据及失败路径已验证
- 包装/签名/升级、应用关闭行为、数据位置、备份/导出/保留/删除说明齐全
- README、技能、UI 能力标签与实现一致，未实现接口仍 fail closed

允许的降级：保留 mock、仅只读 provider、手工 owner handoff、禁止 resume、只支持一个经过验证的 OS。必须明确命名，不以降级模式声称完整 v1。

不允许的降级：隐藏 session 代替非交互 worker、交互终端抓屏代替结构化完成、默认免审批、仅杀 direct child 后释放租约、重复 spawn 掩盖崩溃、凭 worker 自述自动验收、旧 PID 自动重连/清理。

## 8. 完成定义

架构文档完成：边界、实体、状态、协议、持久化、安全、UI、迁移和验收均有明确设计；当前仓库功能描述仍真实。

本地集成完成：用户选定环境的能力报告齐全；通过上述 gate；至少一个真实 worker 与可见 owner 完成“提交 → 派发 → 结构化输出 → artifact 固化 → 执行退出 → 可靠结果接收 → owner 验收 → 资源回收”闭环。自动 owner bridge 不可用时只能称“真实 worker + 手工交接接入完成”。

完整异构 v1 完成：第二种 provider、MCP/bin 逻辑入口与双 owner（含授权创建新 owner）验收通过，skill 不含 Herdr 技术依赖，双方均不依赖隐藏会话，失败/取消/重试/重启/版本不兼容都可解释、可恢复、不会越权。任何未验证项进入已知限制，不以未来计划充当完成证据。
