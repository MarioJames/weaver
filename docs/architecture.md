# Weaver 当前架构

状态：当前系统事实说明，2026-10-19。本文只描述已实现组件与行为；未实现能力明确列出，不保留已撤销的 Electron/SQLite/MCP 目标叙述。命令逐项说明见 [agent-interface](agent-interface.md) 与 [README](../README.md)，引擎接入与排障见 [本地引擎运行说明](local-integration-plan.md)。

## 1. 决策与边界

Weaver 是本地任务控制面，交付三件套：

1. 公开技能 `skills/agents-weaver`（skill name `agents-weaver`，`weaver skills install` 安装）：宿主里的真实 owner agent 按它读能力、路由与包，再调 CLI 派发、验收与登记。workers 不递归，owner 不在 Weaver 之外另跑调度循环。
2. Node CLI `weaver`（`src/cli/main.ts`）：一次命令一次连接，经 Unix 域 socket 的帧 token 认证通道写入运行中的控制面；自身不打开任务文件、不持有状态、不启动 worker。
3. Weaver 服务进程（`src/main/runtime.ts`）：唯一写者与进程监督者，两种运行方式是同一实现的两种启动法——前台 `weaver web`（开发/调试，打开浏览器）与后台 `weaver server start`（分离进程，日志 `<data-dir>/server.log`；`weaver server install` 让它随登录启动）。绑定 loopback HTTP（仅 `127.0.0.1`，dev 模式同源 Vite middleware）并同时开启已认证的 Unix CLI socket。HTTP 面与 CLI 面共享同一个 `CommandHandler`：`src/main/commands.ts` 只是装配门面，命令处理拆在应用层单元里（见 §2.1）。

被撤销的旧方案（仅作历史，不是目标）：Electron 桌面、/render/preload 分层、SQLite/outbox、MCP facade、Weaver 自己养一个隐形的 owner 模型进程、多机调度。当前系统没有第二守护进程，也没有隐藏的付费 owner 模型；owner 宿主只在 父 Agent 显式发起时作为 Herdr 里可见的会话存在（§1 原则 1、§7），Weaver 不轮询它、不替它说话。

核心原则：

1. Owner 是真实技能宿主 agent。登记永远是元数据：`owners.attach`/`owners.spawn` 只写 logical owner（manual 记录，或显式 `provider:"mock"` 的进程内测试宿主），既不联系宿主也不起进程，登记存在不等于 AI 已启动；`owners.attach` 另外为该实例写一份私有凭据文件（见 §7），但不改变这个边界。唯一的例外是 父 Agent**显式发起**的那一步——根任务（无 parentTaskId、未冻结）的首次启动走 `tasks.start`（`src/main/application/commands/registry.ts` 路由到 `src/main/application/owners/lifecycle.ts` 的 `startRoot`：任务须绑定 owner profile 且 profile 可用，命令先持久化再在 Herdr 可见会话里原地起宿主；该任务此前 failed 且尚无 ownerHost 时，同一命令按重启处理——`ownerEpoch` 加一并丢弃旧 contextPack）；接续/重启宿主走 `owners.switch` 带 `launch:true` 与 `owners.launch`——两者都经 `src/main/owner-host.ts` 在 Herdr 可见会话里按 owner profile 的引擎 kind（claude/codex）起一个宿主并分别投接手 prompt 与续投接续 prompt。Weaver 不自动做这件事，也不为它背书：`capabilities` 的 `ownerModelSpawned:false`、`attachmentVerified:false`、`manualAttach:'metadata-only'` 不随 launch 结果翻转，宿主是否真在推理由用户在 Herdr 里看。
2. 单写权威是运行中的 Weaver 服务进程（前台 `weaver web` 或后台 `weaver server start`，同一实现）；renderer、worker 日志、宿主屏幕文字都不是状态权威。CLI 与浏览器只是客户端。
3. `执行完成 ≠ 结果送达 ≠ owner 已 ack ≠ owner 已验收`。执行终态需要 vendor 真实成功 final + 零退出。
4. 能力探测只证明安装与版本；enable 与角色配置分离；未知即明确报告，不假称可用。
5. mock 是显式测试 provider；真实引擎失败/launcher 缺失/引擎不支持都失败，不回退 mock、Claude Code 或其他引擎。

## 2. 组件与进程生命周期

```text
宿主 agent + agents-weaver ─┐
                            ├─┤ weaver CLI（Unix socket，weaver.v1 帧）
浏览器 Web UI (React) ────┘ ─ POST /api/rpc（loopback HTTP，同一 handler）
                 │
        Weaver 服务进程（唯一写者）
          ├─ CommandHandler ─ src/main/commands.ts 门面：CommandGateway（信封校验、durable intent/receipt、统一错误出口）+ registry 路由 + tasks/scheduling/owners 应用单元（src/main/application/**），调度 pump 与结果/重试/owner 生命周期都在这些单元里
          ├─ TaskManager ─ worker 子进程监督（SIGTERM→1.5s SIGKILL）
          │    ├─ MockWorkerAdapter（显式 mock-jsonl，bundled scripts/mock-worker.mjs）
          │    └─ RoutingWorkerAdapter → startCliAgent（src/main/adapters/cli）真实引擎（含 qodercli）
          ├─ PolicyStore（weaver.db 的 policy_* 表）+ 纯路由 policy/routing.ts、路由预览 policy/preview.ts
          ├─ TaskStore（weaver.db，SQLite 事务）；槽位/事件规则 domain/tasks.ts，启动恢复 application/tasks/recovery.ts
          ├─ StallMonitor（src/main/stall.ts，60 秒一次采样/惩罚/恢复探测；CPU 读取 monitors/cpu.ts；状态经 storage/stall-state.ts 落 weaver.db 的 stall_* 表，free-channel 与额度观测的 SQLite 适配同在 src/main/storage/；监视器共用的小机制是 monitors/ladder.ts（阶梯起算、级别、重置窗口、供应商限流步进）与 monitors/lifecycle.ts（tick 合并、定时器、可中止探测、stop 围栏），不是监视器基类）
          ├─ PolicyBlockService（src/main/policy/blocks.ts）：stall、免费渠道探测、供应商限流与额度四个来源，以及用户的引擎与子 Agent 手动解除，对 policy blocks 的读—改—存（revision 冲突后重读重试）都经它。自动来源可经 `atomic()` 把 block 保存与配套监视器状态（阶梯、监视器行）在同一 SQLite 连接上的单个事务里提交，两者要么都落盘要么都不落盘（生产装配满足同连接；测试替身或异连接时退化为各自保存）；人工解除（`engines unblock`）是多步骤：先提交清块保存，随后复位 StallMonitor 阶梯与免费渠道未决问题——清块提交后即使 stall/free probe 复位失败也会通知调度恢复路由，stall 状态保存失败则留 dirty 由下次 tick 收敛；来源标记与归属/作用域谓词只定义在 src/shared/policy/blocks.ts
          ├─ engines/{probe,control}.ts（PATH+--version 只读探测）
          ├─ engines/hello.ts（sayHi 最轻一次性调用：页面探测与惩罚恢复探测共用）
          ├─ owner-host.ts（Herdr 可见 owner 宿主，仅由 tasks.start（根任务首次启动/重启）与 owners.switch launch / owners.launch（接续宿主）显式调用）
          ├─ quota/（原生凭据只读 + 固定 HTTPS GET，进程内额度观测）
          ├─ policy/quota.ts（新鲜账户观测 → 自有 policy.blocks 原子合并）
          └─ ContinuationService（src/main/continuation.ts，owner 手动上下文；接手/根任务提示词在 src/main/owners/prompts.ts，脱敏规则在 src/shared/redact.ts，上下文截断封装在 src/main/redact-context.ts）
```

### 2.1 源码目录、依赖方向与命令/RPC 契约

```text
src/
  shared/                 跨端契约与浏览器可用的纯规则；不依赖 main/renderer，不做 Node I/O
    contracts/            跨端 DTO：commands/tasks/owners/policy/monitoring/quota/continuation/api/rpc
    policy/               availability、weights、settings、blocks（block 来源常量与归属/作用域谓词）、owner-instance
    engines.ts validation.ts redact.ts version.ts
  main/                   服务进程（唯一写者）
    runtime.ts            装配、全局 ready/draining、启动与关闭顺序
    migrate.ts            有序 SQLite 迁移（SCHEMA_VERSION=11，追加式）
    commands.ts           CommandHandler 门面：只装配应用层单元
    application/          用例层：commands/{gateway,registry,errors}、tasks/{queries,mutations,records,results,recovery}、
                          scheduling/{coordinator,dispatch,retry,vendor-limits}、owners/lifecycle、engines/unblock、workers/unblock
    transport/handlers.ts 每个 RPC 方法一个 handler 的分派层
    rpc.ts                RPC 请求解析与 HTTP 状态码映射
    http.ts local-ipc.ts  两个传输适配器：loopback HTTP 与已认证 Unix socket 帧
    store.ts              TaskStore：任务/事件/产物/owner/包/收据与流式缓冲
    policy/store.ts       PolicyStore：policy 表映射、revision 乐观锁与历史
    storage/              SQLite 适配：transaction、stall-state、free-probe-state、quota-snapshot、vendor-limits（监视器状态的 SQL 都在这里；TaskStore、PolicyStore 与 migrate 各持自己的 SQL）
    domain/               纯领域规则与常量：tasks.ts、penalties.ts（阶梯常量）、quota-engines.ts
    monitors/             监视器共用小机制：cpu.ts（cgroup CPU 采样）、ladder.ts、lifecycle.ts（tick 合并/定时器/stop 围栏）
    stall.ts free-channel.ts quota/   三个监视/观测模块，判定归各自模块
    policy/               routing.ts（路由与配置校验）、preview.ts、blocks.ts（PolicyBlockService）、quota.ts、json-schema.ts + config.schema.json + config.default.json
    adapters/             worker JSONL 适配与真实引擎 launcher（adapters/cli/{argv,launch,normalize,redact,scope,vendor-errors}）
    engines/              probe/control/hello/models
    owner-host.ts owners/prompts.ts continuation.ts
    quota/                credentials/index/providers/opencode-console/third-party/timestamps
    system/executables.ts 可执行文件查找（PATH 扫描、X_OK、realpath）
    manager.ts protocol.ts workspace.ts embedded.ts redact-context.ts
  cli/                    main.ts run.ts catalog.ts parse.ts input.ts output.ts client.ts poll-task.ts、
                          commands/{web,skills}.ts、server/{commands,env,lifecycle,systemd,launchd}.ts
  renderer/               main.tsx、app/（壳与全局样式）、api/（client/notify/reconnect）、
                          features/{tasks,engines,probes,quota,roles,settings}、policy/、ui/、format/
```

依赖方向由守卫测试（`tests/integration/architecture-boundaries.test.ts`）强制：

- `shared` 只依赖 shared；`renderer` 依赖 renderer、shared；`cli` 依赖 cli、shared，另有三个明确豁免的入口 `main/{local-ipc,runtime,embedded}`；`main` 依赖 main、shared，绝不导入 renderer 或 cli。
- `main/application` 不导入 transport、runtime、http、local-ipc、embedded、rpc 或 `main/commands`；只有 `main/runtime` 与 `main/transport/handlers` 导入 `main/commands`。
- `main/storage` 不导入监视器、quota 运行时、application 或入口；监视器状态的 SQL 与 `DatabaseSync` 只出现在 `main/storage`，TaskStore（src/main/store.ts）、PolicyStore（src/main/policy/store.ts）与 migrate 仍各持自己的 SQL 与 SQLite 连接。
- 监视器（`stall`、`free-channel`、`quota/index`、`monitors/*`）不导入 application、transport、入口或 `main/continuation`。

命令处理与 RPC 契约的单一来源：

- logical 命令名称与读写分类定义在 `src/shared/contracts/commands.ts`（`READ_COMMANDS`/`WRITE_COMMANDS`）。
- RPC 方法表只有一份：`src/shared/contracts/rpc.ts`（方法、arity、retryable、`cli` 直连映射、`timeoutMs`）。`main/rpc.ts` 的 allowlist/arity 校验、`transport/handlers.ts` 的 handler 覆盖、CLI catalog 的直连 RPC 映射与 renderer client 的重试/超时都从它读取，没有第二份 allowlist。
- 处理链：`CommandGateway` 校验 `weaver.v1` 信封、维护 durable intent/receipt（`COMMAND_INDETERMINATE`/`IDEMPOTENCY_CONFLICT` 语义）与统一错误出口；`createRegistry` 把每个命令路由到 tasks/scheduling/owners 单元；`Coordinator` 负责 pump、准入与冻结路由复核，`Dispatcher`/`Retries` 派发与重试，`VendorLimits` 写供应商限流阶梯与对应 block。

进程语义：服务单实例。前台 `weaver web` 跑在当前终端；后台 `weaver server start` 以分离进程启动并等到能应答才返回，已有运行实例时不再起第二个、直接返回它的信息，同一 port + data dir 装了登录自启服务时由该服务启动。端口被占返回 `EADDRINUSE`；`--data-dir` 决定默认 endpoint/state 目录。崩溃服务遗留的 stale endpoint（discovery 文件还在、socket 已不应答）在启动时自动清除。停止两种模式走同一条关停路径——`weaver web` 用 Ctrl+C，后台用 `weaver server stop`（有 running worker 时默认拒绝 `SERVER_BUSY`，因为停止会取消它们，`--force` 才强制）——随后 draining（`ready=false`，命令面报 `APP_DRAINING`，同时开始 `commands.drain()` 中止在途 owner launch）→ 停额度定时器 → 停 StallMonitor（中止在途恢复探测，并等当前那次 tick 收束）→ 停免费渠道探测（`freeProbe.stop()`，同样中止在途探测并等当前 tick 收束，见 src/main/runtime.ts）→ 中止在途额度探测与引擎 hello → 等待 owner launch/精确清理与其余未响应请求完成 → `manager.shutdown()` 逐个取消本进程拥有的 running 任务并等待子进程退出 → 关闭 HTTP/socket → 退出。draining 后完成的额度请求不再保存策略；采样与探测都是 await 过的，回到写状态前会再确认一次仍在 ready 窗口内，所以关停之后不会补写 block 或惩罚状态。任务、策略与惩罚文件保留。关闭浏览器页不停任务。客户端断开不取消已提交的工作。服务是整机共享的：owner agent 不把停服务当作任务收尾，也不杀它的进程或 systemd scope，只有用户停。登录自启由 `weaver server install` / `uninstall` 管理：Linux 写 systemd user unit `weaver.service`，macOS 写 launchd agent `dev.weaver.server`，只从安装后的独立可执行文件可用，install 捕获当前 `PATH` 让 worker 仍找得到引擎 CLI，对未被该服务管理的运行实例只给提示不动它。

## 3. 单写权威与存储

全部持久状态只有一个权威：`--data-dir` 下的 `weaver.db`（SQLite，0600）。进程启动只认它，不读也不写任何 `*.v1.json`。目录里其余内容都不是状态权威：认证用的 endpoint/control 文件（`control.v1.json`）、后台模式的 `server.log`、`agent-state/` 下每个 launch 私有的提示词与厂商会话目录（保留，不回收）以及 dev 模式的 Vite 缓存。Agent 与用户读取状态一律经提示词 + CLI，不直接读文件或库。

- `weaver.db`：内置 `node:sqlite` DatabaseSync，WAL + synchronous=FULL，所有写者共用同一个连接与事务。结构由有序迁移步骤建立，`PRAGMA user_version` 记录已执行到哪一步（当前 11；第 11 步移除已下线的 zcode 引擎：删除 kind 为 zcode 的引擎行及其子 Agent、父 Agent、引用、封禁与运行状态，历史任务原样保留）：空库从 0 逐步升到最新，已是最新时为空操作，版本比本构建新则拒绝启动；后续结构变更只追加新步骤。
  - 任务面（步骤 1、6）：`tasks` 保存主字段及不含 events/artifacts 的 JSON；`task_events`、`artifacts`（content 独立列）、`owners`、`packages`、`receipts`、`kv`（sequence）按访问模式分表；`vendor_worker_limits`（worker，无法确定 worker 时是 `@engine:<id>`；level、last_trigger_at）是**唯一**的供应商限流阶梯（步骤 6 起为按引擎的 `vendor_limits`，步骤 7 改为按 worker）：派发失败路径与免费渠道探测路径都读写它，窗口同为 2 小时、级数同为 10 → 30 → 60 分钟，两条路径互相可见。命令 intent、spawn 前状态都先同步提交再产生进程效果。保留每任务 500 events、20 artifacts（内容 ≤32,000 字符）。流式输出只缓冲被改动任务，500ms 合并检查点；同步命令同时提交待落盘流式记录，失败回滚数据库及内存 sequence/缓冲。子 Agent 运行记录（task 的 `run.evidence`）登记 `promptPath`、仅 pi 引擎才有的 `sessionDir` 与从事件流解析出的厂商会话 ID（`vendorSessionId`，如 codex thread id、claude session id），`tasks get` 原样返回。
  - 策略（步骤 2）：`policy_engines`、`policy_owners`、`policy_owner_workers`（owner 的子 Agent 顺序与权重）、`policy_workers`、`policy_settings`（`herdr`、`chatgpt_review`、`quota`、`free_channel_probe`、`display` 等按键一行）、`policy_blocks`，整体上限 256 KiB、500 blocks；`revision` 乐观锁，保存在单个事务里整体替换各表并追加一行 `policy_revisions`（修订号、时间、来源 `save`/`rollback:N`/`import`、完整快照），取代原来的 `.bak`/`pre-*` 备份文件；回滚把某修订的快照作为新修订写入，从不原地改写历史。`blocks` 是唯一的持久阻断来源，额度自动阻断（`by:"weaver-quota:<kind>"`）与卡住惩罚（`by:"weaver-stall"`）都写在这里，人工条目按来源保留。`display.timezone` 是可选 IANA 时区名，保存时按 Intl 校验。owners 与 workers 不再有 proxy 字段——迁移步骤 8 把它从表和历史快照里删除，agent 进程一律沿用服务进程自身环境，没有按角色的代理设置。
  - 惩罚（步骤 3）：`stall_penalties`（每引擎一行：level、lastTriggerAt、needsAttention、blockedUntil、nextProbeAt、probeSuccesses、head）与 `stall_history`（全局最近 50 条，每条 `engine`、`level`、`at` 与 JSON 明细：`tasks` 至多 50 个完整任务 ID 并以 `taskCount` 保留总数、触发时的 `stalledMinutes`，或探测结果 `probe:{ok, ms, error?}` 加 `model`/`effort`，或恢复 `message`；探测错误经脱敏并截到 200 字符）。`blockedUntil`/`nextProbeAt` 是名义期限与下次探测时刻（epoch ms，不是策略 `release_at`），`probeSuccesses` 是 level 3 的连续成功数。重启后期限、连击与记录接着用；某次读取的语义校验失败（level/连击超出整数范围、时间戳无效等）则整份忽略、记一行日志，阶梯从 0 重新开始——但策略里那条 stall block 还在，下一 tick 会按它把级别补到至少 1 并重新武装探测，不会静默放行。只有监控器与手动解除会改这些表。
  - 免费渠道探测（步骤 4）：`free_probe_workers`（每个 free_channel 子 Agent 一行的未决问题与探测排程；`mode='rate_limit'` 的行不再自存级数——步骤 9 把这些行的 level/last_trigger_at 并入 `vendor_worker_limits`：同 worker 两边都有时 last_trigger_at 取较新者，两次触发相差不足 2 小时取较高 level、否则取较新一方的 level，随后这些行的 level 清零、last_trigger_at 置空；stall 与 quota 模式的阶梯仍在本表）与 `free_probe_history`（最近 50 条探测记录）。
  - 额度（步骤 5）：`quota_records`（每引擎最近一次观测）与 `quota_state`（凭据指纹、上次账号、下次请求时刻）。
  - 读取入口都是 CLI：`tasks get/list`、`policy get`、`policy history`、`engines health/penalty`、`workers probe-status`、`quota get`。
  - 旧 JSON 数据的一次性迁入不在产品内：产品里没有任何 JSON 自动导入；迁移由仓库外的单文件脚本在部署时手动对真实数据执行（目标库有数据即拒绝；在临时库构建并校验后原子替换；不改不删源 JSON）。回滚方式是停服务后移走 `weaver.db`，原 JSON 未被改动（需旧版本二进制读取）。

额度观测：`QuotaProber` 只读原生认证并通过固定非公开/未文档化 HTTPS GET 获取四种额度数据（Codex、Claude Code、Grok 各一个，OpenCode 按当前 Console 账号/org 与 Go API key 各走一个，不承诺为公开稳定 API），观测保鲜 5 分钟（之后显示陈旧）、每 provider 请求间隔至少 60 秒，每次观测写入 `quota_records`，重启后可读；`quota get` 无网络，`quota refresh` 显式触发探测与自有 blocks 合并。内置 `quota.refresh` 定时任务（`builtinSchedule`，`src/main/schedules/service.ts` 的 `builtin:'quota.refresh'`）按已保存的 `quota.auto_refresh` / `quota.interval_minutes`（缺省开启、15 分钟，5–1440）触发，到期后对已启用且 `quota_refresh` 生效的引擎所属 kind 走同一探测与合并路径；进程启动后首轮至少等一个检查周期。Codex/Claude Code/Grok 的新鲜耗尽观测可增删自有阻断，OpenCode Go 套餐窗口仅展示三窗口百分比（金额为 `null`，reset 用服务端时间）、永不自动增删阻断。`policy.blocks` 仍是唯一持久阻断来源；人工来源不被自动覆盖，遇到妨碍施加自动阻断的过期 foreign 唯一 key 返回原子冲突。请求/认证边界及错误语义见 [额度接口](agent-interface.md#31-原生账户额度)。

写入模型均在 SQLite 事务内完成（`src/main/store.ts`）；中断的写命令先以 durable intent（receipt 写入）暴露为 `COMMAND_INDETERMINATE`，要求用 `operations.get` 查收据并核对现状，不做自动重放。命令收据键为 `local-demo:<commandId>`，同键同参返回原响应、同键不同参拒绝 `IDEMPOTENCY_CONFLICT`。这不是 exactly-once 外部执行保证，也没有事务 outbox。

同步面只有拉取：`sync.status`（revision 比对）、`sync.snapshot`（受界摘要）、`tasks.events`（保留事件 ID 游标，过期 `CURSOR_EXPIRED`）。revision 是 TaskStore 管理状态（任务/事件/收据等）的变化序号，不覆盖供应商限流阶梯、stall 惩罚等监视器表——这些表自身的写入不推进 revision。网页 `listTasks` 只返回最近 3 条事件及产物元数据（无正文），详情通过 `getTask(id)` 按需读取完整任务。renderer 失效通知只表示"revision 变了"，不是持久 push 流。

## 4. 调度与准入（policy/routing.ts）

路由基于 policy 配置（`engines`/`owners`/`workers`/`herdr` + `blocks`）：

- `resolveDispatch` 在 owner.workers 里按权重做**全局负载最少化**：可用候选（worker 启用、引擎启用、无生效 block、权重 >0、worker 未被本次重试链排除、引擎未被引擎级改派排除）中，比较 `(running + 1) / weight`，最小者胜出；并列先取权重更高者，再按 owner.workers 列表顺序。这里的 `running` 是全局数：所有 owner 下 `running`+`cancelling` 的任务数之和（`workerLoad()` 扫全表），跟任务绑在哪个 owner 实例无关。空闲时这个比较退化为按权重试用，有负载时按权重比例分摊。比较用交叉相乘，不做除法。
- `worker_weights`：整数 0..10，缺省 5；0 表示永不调度该 worker，显式指定 worker 也不能绕过权重 0，也不能绕过被排除 worker（`NO_ALTERNATIVE_WORKER`）或被排除引擎（`NO_ALTERNATIVE_ENGINE`）。所有权键必须在该 owner 的 workers 列表里。
- 重试链排除：此前在链上 failed/cancelled/cancelling 的尝试按 `dispatch.worker` 进 `excludeWorkers`；当前 `cancel:true` 放弃的 worker 即使仍在 cancelling、仍占槽，也排除。completed worker 仍可入选，同引擎的其他 worker 可以接手，因此重试不要求换引擎。链上候选全被排除时，在取消原任务或创建子任务前明确报 `NO_ALTERNATIVE_WORKER` 并保留原状；不排除无关任务的 worker。队列因 worker/engine 级 vendor block 改派时同样遵守重试链回避，engine 级 block 的改派继续使用通用 `excludeEngines`。
- 配额 block 按引擎/model 精确匹配，绝对时间戳 `release_at` 到期后失效，其余手动解除。运行时供应商限流/额度错误优先封被派发的那个 worker（`by:"weaver-vendor-limit"` 的 worker 级 block）；该引擎所有启用 worker 都已被封时升级为 engine 级 block（`src/main/policy/routing.ts` 的 `escalateEngineBlock`，`release_at` 取覆盖这些 worker 的 block 中最早者）；派发时无法确定 worker（或派发的 worker 不属于该引擎）则直接按 engine 封（`src/main/application/scheduling/vendor-limits.ts`）。reason 为短说明（如 `限流：Rate limit exceeded…`）；同一 worker（无法确定 worker 时按引擎）2 小时内重复限流按 10 → 30 → 60 分钟递增，安静满 2 小时重置，供应商给出更晚的 retryAt 时取更晚时间；阶梯只有 `vendor_worker_limits` 这一份，派发失败与免费渠道探测的限流共用它。块与阶梯在同一个 SQLite 事务里提交（stall、免费渠道探测、供应商三条路径），事务中途失败则两者都不落盘、内存快照也不前进，同一失败再次处理只升一级；探测与网络等待留在事务之外。额度错误无重试时间则持续到手动解除。
- 准入与派发同一 resolve 函数：`policy preview` 只读（`dispatch:"preview"`、`execution:"disabled"`）不执行；`workers.spawn` 实际校验 workspace/provider/容量后按结果 start 或入队。页面走的 `previewRoute` 由服务端当场补上同一份全局负载，所以预览显示的选择就是此刻派发会走的选择。
- 并发按 **owner 实例**的 `profile.max_parallel`：槽位分组是 `instance:<ownerId>`，任务绑定 `ownerId` 时竞争的就是那个确切实例自己的额度；没有 `ownerId` 的遗留任务单独共用 `profile:<profileId>` 组。同一 profile 的多个实例各占各的额度，A 会话排满不影响 B 会话开工。容量在 `workers.spawn`、pump 复核和 `manager.start()` 启动前三处都查，超限一律入队而不是抢占。
- `capabilities.maxParallel` 是 enabled profile 的 `max_parallel` 之和，配合 `capacity:{unit:'owner-instance', admission:…}` 只作规模提示——既不是 profile 级也不是全局的准入帽；系统没有全局并发上限。被限制的是**每个实例**的并发，跨实例的 子 Agent 负载均衡仍是全局的（见第一条）。
- `herdr.max_wait_minutes`（1–1440）是 父 Agent 对同一 子 Agent 两次检查之间的最长间隔：等待只用 `weaver tasks wait --task-id`，不带 `--for` 时上限取 `min(600 秒, max_wait_minutes × 60 秒)`（策略读不到时退到 30 秒），任务一结束就返回。期间 父 Agent 查看进展并决定继续等待、取消或收回，Weaver 不会据此停止 子 Agent。

队列与冻结：

- `workers.spawn` 通过预检后把当时选出的 owner/worker/engine/kind/model/effort/execution/adapter/workspace 冻结进 `task.dispatch`；排队槽只是等待容量。
- worker 与 owner 同引擎时 `execution:"native"`、adapter `native`：不启动进程，任务进入 running 并占用 owner 实例的槽位，由 owner 用宿主内置子代理工具执行后调用 `workers.complete` 回报；取消直接转 cancelled，重启恢复时保持 running（`recoverInterruptedTasks()` 只把非 native 的在途任务判失败）。
- 派发响应除任务快照外还带 `next`——父 Agent 照它做一步即可，不需要理解引擎：非 native（real/mock）和还没拿到容量的排队任务是 `{action:'wait', command:'weaver tasks wait --task-id <id>'}`；已 running 的 native 任务是 `{action:'run_subagent', model, effort, prompt, then}`，`prompt` 与真实 worker 拿到的角色指令逐字相同（`workerInstruction`），`then` 是回报命令 `weaver workers complete --task-id <id> --input report.json`。`tasks.get` 对 running 的 native 任务同样给出 `next`，所以 spawn 回复丢了也能找回那份指令。
- pump 复核当前资格/容量/配额/pin/workspace：route 改变（含 kind 不符）、容量不足、workspace 失效或 launch 失败都会给 `task.queueReason`（有界 message，仅变化落盘），代码取 `waiting_for_capacity/policy_blocked/frozen_route_changed/workspace_changed/launch_blocked`。除供应商限流/额度阻断外，冻结路由不会被默默改派或跨引擎替换；`by:"weaver-vendor-limit"` 的生效阻断会让排队任务重新选择其他可用引擎，已失败尝试仍需显式重试。
- 取消：queued 直接转 cancelled；running 先 `cancelling` 再等待本进程拥有的 worker 子进程退出（SIGTERM → 1.5s SIGKILL）。取消/文件损坏不删除已有 history 与事件。
- `tasks.retry` 是单次自动派发：先完成路由、worker 能力、workspace、指令长度（≤16000）、冻结包存在性等全部预检，再按需取消原尝试并原子创建带 `retryOf` 的新任务与新冻结包。原任务有冻结包也会创建一个新包；不再受 JSON 存储的总数上限限制。复制 owner/workspace/constraints 与冻结 scope/criteria，指令只加一份上次尝试与读取 git diff/部分产出的接续说明，再接链根的原始目标，避免逐代堆叠前缀；复用 `workers.spawn` 同一派发路径，直接返回任务、`next` 与非空的 `excludedWorkers`。显式 mock 保持 mock，real 不回退 mock；写命令拒绝仍保留可回放收据。

## 5. 真实 worker 执行（src/main/adapters/cli）

launcher 组合（`startCliAgent`）：`RealEngineKind = 'opencode'|'pi'|'grok'|'codex'|'qodercli'|'dsh'`（`REAL_ENGINE_KINDS`，同一份清单也是 `capabilities.workerProviders` 里真实引擎的来源）。固定可执行名+固定 argv 组装（`adapters/cli/argv.ts`），`shell:false`，workspace 必须是已存在的绝对路径，启动前核验并随 dispatch 冻结 `workspaceIdentity`。认证使用各引擎自身的本机配置（settings/auth 文件），Weaver 不复制、不打印、不把它写进 argv/日志/请求包。`dsh` 用 `dsh --profile headless --patch <私有 overlay> --json`（提示词走 stdin），凭据由 dsh 自己按顺序解析：凭据库 `~/.dsh/.credentials.yaml`（dsh 设置里保存的 Key）→ 服务进程环境 `DEEPSEEK_API_KEY` → 调用目录 `.env` → `~/.dsh/.env`；Weaver 自身从不读取或保存该密钥，overlay 不含凭据，只固定 `deepseek-official` 并启用本地凭据服务，`authorization` 与 `deepseek-account`（账号登录）保持禁用。

- 指令传递走 stdin 或私有 prompt 文件优先，不在 argv 放长 prompt。state 目录是 app 拥有的 `agent-state` 下私有 job 目录，不是凭据目录。
- Codex 使用 `--sandbox danger-full-access`，与其他引擎的 bypass 模式一样允许本机 Docker、端口和网络访问；OpenCode 使用 `--print-logs --log-level ERROR` 及时暴露供应商限制（提交 `76933be` 记录约 2 秒，代码不保证该时限）。
- 真实 子 Agent 首个有效供应商输出后才算启动，spawn/retry 在请求总计 8 秒预算内等待并返回 `started`；120 秒无有效输出以 `no_output` 失败。限流/额度错误立即失败，`task.failure` 保留 `kind`、`message` 及可用的 `stderrTail`、`vendorError`、`retryAt`。agent 进程原样继承服务进程的环境变量（只删除 `ELECTRON_RUN_AS_NODE`），没有按角色的代理设置；策略里的 proxy 字段已在迁移步骤 8 删除。
- 输出 streams 解析为普通 WorkerRecord JSONL（log/progress/artifact/result/final），stderr 脱敏有界；provider 自报的 session/model/usage 是可选 `evidence`，未知保持未知，没有捏造的模型验证。
- 终态条件：vendor terminal success + final assistant text + 零退出才写 `completed`；missing/truncated/非零退出都失败。产物抓取为有界 `result.md`/结构化 artifact，内容当纯文本数据，不当可执行 HTML。
- 请求的真实引擎/model/effort、adapter、workspace、scopeUnit 和 observed evidence 都记录在 `run` 与 observability 里；mock 显式记录 `execution:'mock'`。没有静默回退：CC 报 `CAPABILITY_UNAVAILABLE`（deferred），unknown kind 同拒，launcher 未加载同拒。
- 生命周期收尾只清理本 launch 拥有的进程；Linux/systemd host 上每个真实 launch 使用唯一命名 user scope，取消/超时/完成前先关闭自身 scope。没有共享 leader/daemon。

真实执行首个有效输出后与 native 执行都不设总执行时限；`herdr.max_wait_minutes` 只是 父 Agent 两次检查之间的最长间隔（`weaver tasks wait`/`tasks watch` 不带 `--for` 即按 `min(600 秒, max_wait_minutes × 60 秒)` 取上限，策略读不到时为 30 秒，任务结束即返回，`wait` 还会在 health 为 `stalled` 时提前返回并带 `reason:'stalled'` 与重试/取消提示），Weaver 不据此停止 子 Agent，直接单测的 mock adapter 才允许一个更短的测试等待。

## 6. 卡住检测与引擎惩罚（src/main/stall.ts）

判定（S1）：一个 running 且 `execution:'real'` 的任务只有**两个条件同时成立**才算卡住——距最后一条事件（没有事件则从 run 起始时刻）静默 ≥5 分钟，**且**它自己那个 scope 连续 ≥5 分钟空闲。空闲按 owned-scope 的累计 CPU 判定：每 60 秒采一次、每任务保留最近 12 个样本，一个采样区间里 CPU 增量低于单核 5% 才算空闲；CPU 来自 `systemctl --user show -p CPUUsageNSec`，读不到时退到该 cgroup 的 `cpu.stat usage_usec`，两者都拿不到就是 `null`。**读不到 CPU 永不判卡住**——没有证据不是证据；只有单个样本、区间时间不前进、计数器回退或任何一个忙区间都会结束这段空闲。任务还在持续上报事件则既不算卡住也不参与统计。

阶梯（S3）：同一引擎的卡住任务凑够 2 个才惩罚引擎本身（按引擎分组，任务列表顺序）。惩罚是往策略里写一条 `by:"weaver-stall"`、**不带 `release_at`** 的 engine 级 block——它自己永不到期，也没有任何超时能解除它。级别按时点排队：L1 名义等 5 分钟、L2 等 10 分钟、L3 转 `needsAttention` 并每 10 分钟探测一次、永不因时间流逝自动解除；两小时内再次触发逐级上升，超过就停在 L3，安静满两小时级别才退役。该引擎上已经生效的非 stall engine 级 block（人工/额度）不会被叠加惩罚，未知引擎在写任何东西之前被拒。

到点（`nextProbeAt`）跑一次恢复探测：取该引擎上**第一个启用 worker** 的 model/effort，走与 engines 页同一个 `sayHi` 最轻一次性调用（`src/main/engines/hello.ts`，`agent-state/` 下私有临时目录，真实推理）。该引擎没有启用的 worker 时探测直接算失败并记原因，不调用任何东西。

- 探测失败：立刻升一级并重写那条 block 的 reason（block 一直保持着引擎的排除资格，因此不需要重新 pump），连击清零。
- 探测成功：只删自己那条 stall block，级别与 `lastTriggerAt` 原样留着，好让下一次触发直接进下一级；删失败就保持武装、下一 tick 再探。L3 要**连续三次**成功才自动解除，并在记录里留一条「自动恢复，请留意」，任何一次失败都把这串连击清零。
- 手动解除（`engines unblock --engine <id>`）是应用层操作（`src/main/application/engines/unblock.ts`，不是监视器方法）：经 PolicyBlockService 清除所选引擎的全部 block（含人工、额度及 model 级），再让 StallMonitor 复位它的阶梯、期限与连击、让免费渠道探测复位该引擎下已失去 block 的未决问题；history、配置、其他引擎和任务事件保留。自动恢复仍只删除监控器自己的 stall block。刚解除或刚恢复的引擎在同一次 tick 里不会被再次惩罚。用户单独删掉策略里的 stall block 会复位相应阶梯，不会替它清除其他来源。
- 子 Agent 解除（`workers unblock --worker <id>`，由用户决定）同为应用层操作（`src/main/application/workers/unblock.ts`）：先校验子 Agent 存在（未知为 `NOT_FOUND`，不写任何东西），再经 PolicyBlockService（`clearWorker`）删除所有 `block.worker` 等于它的 block（任意来源与 model）；引擎级「全部子 Agent 均被限流」供应商 block 只在去掉该子 Agent 的 block 后引擎已不再整体被封时才一并删除，手动或其他来源的引擎级 block、其他子 Agent 的 block 与供应商限流阶梯都保留。随后让免费渠道探测复位该子 Agent 的未决问题；stall 阶梯按引擎保存，只在该引擎已无 stall block 时复位；最后通知排队任务重新路由，步骤失败时已删除的 block 不回滚。
- 惩罚只暂停引擎的派发资格：从不取消任务、从不杀进程；running 的任务继续跑完并照常回报。

监控器每 60 秒 tick 一次，并发 tick 合并成在途那一次；只在 ready 窗口内写状态，await 采样与 await 探测之后都重新确认窗口仍然开着。期限、连击与记录落 `weaver.db` 的 `stall_*` 表（见 §3），重启后继续；`stop()` 中止在途探测并等当前 tick 收束，独立于服务 ready 回调也会阻止晚到的采样/探测写入，只有再次 `start()` 才恢复 tick；免费渠道探测与额度调度器同样：停止之后手动 tick、晚到的探测回答、手动探测都不再写库或策略，也不再启动新的探测或刷新（ready 回调为 true 或未提供都一样）。`taskHealth` 与引擎页/CLI 用的是**同一套**样本与分类器，不存在第二个判定者：`ended`（已完成/失败/取消，带最终 `taskStatus`）、`owner_starting`/`owner_running`（owner 根任务专属：`executionRole:'owner'` 的任务从不判 stalled，尚无 ownerHost 为 `owner_starting`、已有 ownerHost 为 `owner_running`）、`starting`（running real 尚无首个有效输出）、`stalled`（两条都满足）、`waiting_model`（静默 ≥5 分钟且 CPU 没有证明在忙，包含读不到的情况）、`working`（其余），非 running real 任务的 `silenceMs`/`cpuActive`/`cpuIdleMs` 保留为 `null` 而不是猜。`tasks.health`、`engines.health`、`engines.penalty`、`engines.unblock` 已接入同一 `CommandHandler`：health 返回不含 history 的摘要，penalty 返回单引擎完整保留记录，unblock 返回清理结果；缺监控器时返回 `CAPABILITY_UNAVAILABLE`。逐项命令语义见 [agent-interface](agent-interface.md#33-卡住健康与引擎惩罚命令)。

## 7. Owner 手动上下文与结果（ContinuationService）

- `owners.attach` 与 `owners.spawn`（缺省，无 provider）都登记 manual logical owner：名字/profile + 调用方可选 session/pane 标签（缺省 `external-cli`/`unverified`），`verified:false`、`attachmentVerified:false`。登记这一步永远是元数据：没有进程被创建、没有宿主被联系。`owners.attach` 的 **profileId+name+session 三元组全同就是同一个 durable 实例**：换 `--command-id` 重发返回同一条记录、不再新建，重启后仍旧是同一条，`pane` 只是附加的未验证元数据不参与身份；session 同时存为实例自己的字段与 host evidence 里的旧字段（早于该字段存在的记录在装载时把 `host.session` 回填到顶层）。带可选 `ownerId` 时 attach 认领该既有行（profile 必须一致、仅 manual），不新建第二个实例；Herdr 启动的根/接续宿主用它认领当前行。attach 返回 LogicalOwner 字段加 `credentialPath`（`<data-dir>/owner-credentials/<ownerId>.json`）：token 只写在该 0600、当前用户所有、非符号链接的普通文件里，响应、日志和任务数据都不含 token。CLI 的 `--owner-file` 读取该文件，把 `ownerAuth:{ownerId,token}` 放在逻辑 CommandRequest 顶层（不是 args）；文件缺失、权限/格式/大小/符号链接错误在发送任何请求前失败，直接 RPC 只校验文件而不携带 ownerAuth。该身份是**本机可信用户**边界，不复用也不替代既有管理员控制面认证，不宣称 tenant 或 per-owner 隔离。`owners.spawn` 是显式登记，永不与 attach 的实例合并；显式 `provider:"mock"` 保留进程内 mock 宿主测试路径。
- `owners.list` 的每一项是一个**已登记实例**，带自己的 `runningTaskCount`（running + cancelling，即它此刻占着的槽）；`owners.get` 同样。带 `ownerId` 的任务绑的就是这个确切实例（准入见 §4）。
- `owners.switch`（需 expectedRevision,可选 expectedEpoch/reason/profileId,以及 `launch?:boolean`）在 mock 宿主上做原子握手；manual 分支在 quiescent + revision/epoch 校验后组装有界 `contextPack`（≤32 KiB，不含 artifact 正文与全量 transcript），创建 manual replacement registration（`host.attach`，ownsHost=false/verified=false），原子更新任务 owner binding/epoch/history/pack，返回 pack 与一份可直接投给新宿主的纯文本 `prompt`（每个自由文本值都经 `redactContext` 脱敏、按段压缩到 ≤6000 字符）。`owners.continuation.get` 在有 pack 时给同一个 `prompt`。这个交接包是纯元数据：`acknowledgementId` 为 `null`，pack limitations 写明"external owner 必须自行读取 pack；真实宿主切换由 CLI 承担；Weaver 没有自动投递/确认"。
- `launch:true` 时，轮换**已经提交**之后再显式尝试 Herdr 宿主：`src/main/owner-host.ts` 在 Herdr 的 `default` session 里 `workspace create --cwd <任务 workspace> --no-focus`，读回它自己报的 `result.workspace.workspace_id` 与 `result.root_pane.pane_id`（不透明 pane id 绝不当 workspace id 用），再 `agent start owner-<任务 ID 前 8 位>-<epoch>`（kind 只支持 claude/codex，按 profile 的 model/effort 组装 argv）并 `agent prompt` 投那份接手 prompt。Herdr 退出码 0 但回体带 `error` 也按失败处理；有确切 workspace ID 后的任一步失败都定向尝试关闭它自己创建的 workspace，清理失败会并入原错误；拿不到 workspace ID 时不猜测归属、不误删资源。失败时**轮换不回滚**：响应 `launch:{ok:false, code, message}`，`OWNER_LAUNCH_UNSUPPORTED`/`OWNER_LAUNCH_UNAVAILABLE`/`OWNER_LAUNCH_FAILED` 如实区分，任务事件记一条 error。之后 `owners.launch`（需 expectedRevision）用任务上现存的 `contextPack` 重试拉起，**不再轮换**，返回 `prompt` 与 `launch` 结果。`capabilities.ownerSpawn` 只在 `herdr` 可在 `PATH` 上执行时是 `'herdr'`：它证明的是这个可执行文件存在，不证明有活的模型/登录/宿主，登记本身也仍然是元数据（`manualAttach:'metadata-only'`）。成功拉起的宿主记在 `task.ownerHost`（`{kind:'herdr', session, workspaceId, paneId, agentName, launchedAt}`），是出处记录，不是可用性证明。
- 生产 HTTP/Unix 通道调用异步 `handleAsync()`；同步入口与异步入口共用命令流及 Herdr 协议，没有第二套 launcher。响应仍等待最终 `{launch:{ok,...}}`，没有 pending/jobs API。意图先持久化；同 commandId 同参在途重发返回 `COMMAND_INDETERMINATE`，完成后回放最终收据，不重复拉起。同 task+epoch 的另一启动返回 `INVALID_STATE`。异步完成时重新读取任务，只在 ownerId/epoch 仍一致且未 draining 时保存 ownerHost 和事件，保留等待期间的新任务状态；已被新 binding 或关停取代的成功宿主只按本次确切 session/workspace 清理，不覆盖新状态。
- ownerHost 落盘失败时清理这次宿主并如实报告；若实际落盘已成功、只是后续通知监听器抛错，则保留已持久可见的宿主。收据完成保存失败仍返回 `COMMAND_INDETERMINATE`，不把副作用当作未执行。`commands.drain()` 先拒新命令、中止启动、等待启动及必要清理收束，再由 runtime 关闭其余资源；清理不复用已中止的启动 signal。
- 传输常规时限是 15000 ms。仅完整且通过 token 校验的 IPC 帧，或同源校验和 body 解析通过的 HTTP 请求，且逻辑请求为格式合法的 `owners.launch` 或 `owners.switch`+`launch:true` 时，采用固定 210000 ms 启动等待；半帧、坏格式、未认证及普通请求仍走 15 秒。CLI 使用同一分类并尊重调用方明确给出的更短等待。这个请求等待不改变 worker 生命周期，也不保证宿主/模型可用。
- manual 空闲到期只把任务标记 due 并提示技能发起手动接续；mock-only 的 prepareOwnerActivity 自动轮换保留在 mock 路径里。
- 结果流：manual owner 自己 `tasks.results` 拉 manifest（含 artifact sha256 与 `manifestDigest`）→ 独立查文件/跑测试 → `results.ack`（expectedRevision + 当前 digest；ack 后 delivery=acknowledged，验收不变）→ `reviews.submit`（同 digest + expectedRevision,decision accepted/rejected）更新 `acceptance`。`results.deliver` 对 manual owner 显式 `CAPABILITY_UNAVAILABLE`，不伪造外部投递。

## 8. 引擎目录与探测

固定 catalog（`src/shared/engines.ts`）：claude/codex/grok/opencode/pi/qoder/dsh 七个 id，kind 分别 claude/codex/grok/opencode/pi/qodercli/dsh。探测只做 PATH 可执行文件（与 owner-host 查 herdr/claude 共用 src/main/system/executables.ts：跳过空 PATH 段、检查 X_OK、只接受解析后的普通文件、返回 realpath）+ 带超时 `--version`（shell:false、ANSI 去除、4s 超时、进程组收尾）；结果永远 `authenticated:false`、`modelUsable:false`。启用权威是 PolicyStore `engines[id].enabled`（`engines set-enabled` 需 installed 探测 + revision）；启用引擎不会创建任何角色。adapter 状态按 kind 判：`real` = opencode/pi/grok/codex/qodercli/dsh（`REAL_ADAPTER_KINDS`），`deferred` = claude，其余 kind 才是 `not_implemented`；`realExecution` = 该引擎 adapter 为 real 且已启用且有启用的 worker 使用它，探测≠可用。`EXECUTION_BOUNDARY.realAdapter` 也从同一份真实 adapter 清单生成，包含 dsh。

真实执行适配（`src/main/adapters/cli/argv.ts` + `normalize.ts`）覆盖 opencode、pi、grok、codex、qodercli、dsh。qodercli 以 `-p -o stream-json` 从 stdin 读任务，`--permission-mode bypass_permissions`（CLI 策略，不是 OS 隔离），`--setting-sources ""` 与 `--strict-mcp-config` 跳过用户级 hooks、插件与 MCP，`--no-session-persistence` 不落会话；输出按 Claude Code 风格的 system/assistant/result 事件归一化。dsh 以 `dsh --profile headless --patch <私有 overlay> --json` 从 stdin 读任务，子进程 cwd 即 workspace（dsh 无 workdir 开关）；overlay 固定 `deepseek-official`、模型、reasoningEffort（off|low|high|max）与 `workspace-write` 沙箱 + `ask` 审批（workspace 内读写/运行无需审批，越界升级走审批并在无头下 fail-closed；`danger-full-access` 语义是"确定性拒绝需审批动作"而非自动批准，故不用），仅启用本地凭据服务（`credentials` / `disabled: false`），`authorization` 与 `deepseek-account`（账号登录）保持禁用，无凭据内容；凭据由 dsh 自己按凭据库 `~/.dsh/.credentials.yaml` → 服务进程环境 `DEEPSEEK_API_KEY` → 调用目录 `.env` → `~/.dsh/.env` 解析，Weaver 自身从不读取或保存密钥；NDJSON 的 session/status/thinking/text/tool_call/tool_result/final/error 事件归一化，final 为结果，error 事件、缺 final 或 turn_end reason 非 completed 即失败，sessionId 记为 vendorSessionId。claude 仍无执行适配。

## 9. 已知限制（不是未来路线）

- 没有按 owner 的认证/对象级权限；本地凭据是 trusted-user 级（`capabilities.authentication` 声明）。
- 定时额度刷新只按固定间隔探测并同步自有阻断，不做失败重试；超额失败按 provider 错误如实报告，不自动重试已失败尝试；运行时供应商阻断会重路由排队任务（§4）。
- 本地控制面只面向 Linux/Unix：服务进程（前台 `weaver web`，或 `weaver server start` 起的后台实例）先启动 Unix CLI socket 再启动 HTTP（`src/main/runtime.ts`），而 `startLocalIPC` 在 win32 直接 `UNSUPPORTED_PLATFORM`（`src/main/local-ipc.ts`），因此控制面在原生 Windows 不能启动。真实受管 worker 还依赖 Linux systemd user scope。不声称原生 Windows 支持，也不再描述未验证的远程访问形态。
- 没有持久任务 retention/自动清理策略、迁移导入工具、outbox/事件总线、全局持久事件流（weaver.db/SQLite 本身是现有存储，不在此列）。任务页已有归档抽屉：将已结束满一天的任务显示在派生归档视图中，不删除持久任务。
- 没有 worker 递归与多 owner 交叉指挥；一个任务一个 owner，owner 间协作回到技能宿主的可见会话。
- 卡住判定依赖能读到 owned-scope 的 CPU：非 systemd host 或读不到计数器时任务永远不算卡住，也就不会有惩罚——这是有意的保守默认，代价是这类 host 上惩罚阶梯事实上不会启动。
- 本机实测宿主/版本证据以 `docs/verification/**` 与 [VERIFICATION.md](../VERIFICATION.md) 为准；本文不声称最终验收。

## 10. 来源与出处

沿用 skill-foundry 上游 provenance（Apache-2.0）：上游仓库 [MarioJames/skill-foundry](https://github.com/MarioJames/skill-foundry/tree/61989b11a5d0565d2a6630833e64a2d73769a947/skills/agents-cooperation)（其中 `scripts/agents-config.ts` 与 `scripts/lib/json-schema.ts` 是上游仓库内的路径，本仓库不含；两者迁入本仓库 `src/main/policy/*`），详见 [script-migration](script-migration.md)。Weaver 自有扩产（权重/pin/真实 launcher/CLI 面等）是本仓库独立实现。公开技能见 [skills/agents-weaver/SKILL.md](../skills/agents-weaver/SKILL.md) 与 [provenance](../skills/agents-weaver/references/provenance.md)。
