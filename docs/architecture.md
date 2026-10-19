# Weaver 当前架构

状态：当前系统事实说明，2026-10-19。本文只描述已实现组件与行为；未实现能力明确列出，不保留已撤销的 Electron/SQLite/MCP 目标叙述。命令逐项说明见 [agent-interface](agent-interface.md) 与 [README](../README.md)，引擎接入与排障见 [本地引擎运行说明](local-integration-plan.md)。

## 1. 决策与边界

Weaver 是本地任务控制面，交付三件套：

1. 公开技能 `skills/agents-weaver`（skill name `agents-weaver`，`weaver skills install` 安装）：宿主里的真实 owner agent 按它读能力、路由与包，再调 CLI 派发、验收与登记。workers 不递归，owner 不在 Weaver 之外另跑调度循环。
2. Node CLI `weaver`（`src/cli/main.ts`）：一次命令一次连接，经 Unix 域 socket 的帧 token 认证通道写入运行中的控制面；自身不打开任务文件、不持有状态、不启动 worker。
3. Weaver 服务进程（`src/main/runtime.ts`）：唯一写者与进程监督者，两种运行方式是同一实现的两种启动法——前台 `weaver web`（开发/调试，打开浏览器）与后台 `weaver server start`（分离进程，日志 `<data-dir>/server.log`；`weaver server install` 让它随登录启动）。绑定 loopback HTTP（仅 `127.0.0.1`，dev 模式同源 Vite middleware）并同时开启已认证的 Unix CLI socket。HTTP 面与 CLI 面共享同一个 `CommandHandler`（`src/main/commands.ts`）。

被撤销的旧方案（仅作历史，不是目标）：Electron 桌面、/render/preload 分层、SQLite/outbox、MCP facade、Weaver 自己养一个隐形的 owner 模型进程、多机调度。当前系统没有第二守护进程，也没有隐藏的付费 owner 模型；owner 宿主只在负责人显式发起时作为 Herdr 里可见的会话存在（§1 原则 1、§7），Weaver 不轮询它、不替它说话。

核心原则：

1. Owner 是真实技能宿主 agent。登记永远是元数据：`owners.attach`/`owners.spawn` 只写 logical owner（manual 记录，或显式 `provider:"mock"` 的进程内测试宿主），既不联系宿主也不起进程，登记存在不等于 AI 已启动。唯一的例外是负责人**显式发起**的那一步——`owners.switch` 带 `launch:true`、以及 `owners.launch`——它经 `src/main/owner-host.ts` 在 Herdr 可见会话里按 owner profile 的引擎 kind（claude/codex）起一个宿主并把接手 prompt 投给它。Weaver 不自动做这件事，也不为它背书：`capabilities` 的 `ownerModelSpawned:false`、`attachmentVerified:false`、`manualAttach:'metadata-only'` 不随 launch 结果翻转，宿主是否真在推理由用户在 Herdr 里看。
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
          ├─ CommandHandler ─ 命令校验/幂等收据/调度 pump
          ├─ TaskManager ─ worker 子进程监督（SIGTERM→1.5s SIGKILL）
          │    ├─ MockWorkerAdapter（显式 mock-jsonl，bundled scripts/mock-worker.mjs）
          │    └─ RoutingWorkerAdapter → startCliAgent（src/main/adapters/cli）真实引擎（含 qodercli）
          ├─ PolicyStore（policy.v1.json）+ 纯路由 policy/routing.ts
          ├─ TaskStore（tasks.v1.json，fsync+rename 原子替换）
          ├─ StallMonitor（src/main/stall.ts → stall.v1.json，60 秒一次采样/惩罚/恢复探测）
          ├─ engines/{probe,control}.ts（PATH+--version 只读探测）
          ├─ engines/hello.ts（sayHi 最轻一次性调用：页面探测与惩罚恢复探测共用）
          ├─ owner-host.ts（Herdr 可见 owner 宿主，仅 owners.switch launch / owners.launch 显式调用）
          ├─ quota/（原生凭据只读 + 固定 HTTPS GET，进程内额度观测）
          ├─ policy/quota.ts（新鲜账户观测 → 自有 policy.blocks 原子合并）
          └─ ContinuationService（src/main/continuation.ts，owner 手动上下文）
```

进程语义：服务单实例。前台 `weaver web` 跑在当前终端；后台 `weaver server start` 以分离进程启动并等到能应答才返回，已有运行实例时不再起第二个、直接返回它的信息，同一 port + data dir 装了登录自启服务时由该服务启动。端口被占返回 `EADDRINUSE`；`--data-dir` 决定默认 endpoint/state 目录。崩溃服务遗留的 stale endpoint（discovery 文件还在、socket 已不应答）在启动时自动清除。停止两种模式走同一条关停路径——`weaver web` 用 Ctrl+C，后台用 `weaver server stop`（有 running worker 时默认拒绝 `SERVER_BUSY`，因为停止会取消它们，`--force` 才强制）——随后 draining（`ready=false`，命令面报 `APP_DRAINING`，同时开始 `commands.drain()` 中止在途 owner launch）→ 停额度定时器 → 停 StallMonitor（中止在途恢复探测，并等当前那次 tick 收束）→ 中止在途额度探测与引擎 hello → 等待 owner launch/精确清理与其余未响应请求完成 → `manager.shutdown()` 逐个取消本进程拥有的 running 任务并等待子进程退出 → 关闭 HTTP/socket → 退出。draining 后完成的额度请求不再保存策略；采样与探测都是 await 过的，回到写状态前会再确认一次仍在 ready 窗口内，所以关停之后不会补写 block 或惩罚状态。任务、策略与惩罚文件保留。关闭浏览器页不停任务。客户端断开不取消已提交的工作。服务是整机共享的：owner agent 不把停服务当作任务收尾，也不杀它的进程或 systemd scope，只有用户停。登录自启由 `weaver server install` / `uninstall` 管理：Linux 写 systemd user unit `weaver.service`，macOS 写 launchd agent `dev.weaver.server`，只从安装后的独立可执行文件可用，install 捕获当前 `PATH` 让 worker 仍找得到引擎 CLI，对未被该服务管理的运行实例只给提示不动它。

## 3. 单写权威与存储

持久状态按写入者分成三个 JSON store，都在 `--data-dir` 下、0600、fsync + rename 原子替换。除此之外这个目录里只有认证用的 endpoint/control 文件、后台模式的 `server.log`、`agent-state/` 下每个 launch 私有的 job 临时目录以及 dev 模式的 Vite 缓存——它们都不是状态权威：

- `tasks.v1.json`：任务（含 events/artifacts/run/摘要）、owners 元数据、frozen packages、命令收据 revisions；原子快照 revision 单调递增。上限 32 MiB、200 tasks、200 owners、1000 packages、5000 receipts、每任务 500 events、每任务 20 artifacts（内容 ≤32,000 字符）。
- `policy.v1.json`：验证过的 policy 配置 + blocks；上限 256 KiB、500 blocks；revision 乐观锁，保存整文档替换。`blocks` 是唯一的持久阻断来源，额度自动阻断（`by:"weaver-quota:<kind>"`）与卡住惩罚（`by:"weaver-stall"`）都写在这里，人工条目按来源保留。
- `stall.v1.json`：StallMonitor 自有的惩罚阶梯与触发/探测记录，上限 256 KiB、全局 history 最近 50 条。结构是 `{version:1, engines:{<engineId>:{level, lastTriggerAt, needsAttention, blockedUntil, nextProbeAt, probeSuccesses, head}}, history:[…]}`：`blockedUntil`/`nextProbeAt` 是名义期限与下次探测时刻（epoch ms，不是策略 `release_at`），`probeSuccesses` 是 level 3 的连续成功数，`head` 是当初触发它的证据行；history 每条留 `engine`、`level`、`at`、`tasks`（至多 50 个完整任务 ID，并以 `taskCount` 保留实际涉及的任务总数）、触发时的 `stalledMinutes`，或探测结果 `probe:{ok, ms, error?}` 加所用 `model`/`effort`，或一条恢复 `message`；探测错误经脱敏并截到 200 字符（超长另加省略号）。重启后期限、连击与记录都接着用；文件损坏、超限，或 level/连击不在允许的整数范围、时间戳超出 Date 有效范围等语义校验失败，就整份忽略、记一行日志，阶梯从 0 重新开始——但策略里那条 stall block 还在，下一 tick 会按它把级别补到至少 1 并重新武装探测，不会静默放行。这个文件不由 CLI 直接写，只有监控器与手动解除会改它。

额度观测不增加持久文件：`QuotaProber` 只读原生认证并通过三个固定非公开 HTTPS GET 获取数据，观测在内存保鲜 5 分钟、每 provider 请求间隔至少 60 秒；`quota get` 无网络，`quota refresh` 显式触发探测与自有 blocks 合并。`QuotaScheduler` 每分钟按已保存的 `quota.auto_refresh` / `quota.interval_minutes`（缺省开启、15 分钟，5–1440）检查一次，到期后对已启用且 `quota_refresh` 生效的引擎所属 kind 走同一探测与合并路径；进程启动后首轮至少等一个检查周期。`policy.blocks` 仍是唯一持久阻断来源；人工来源不被自动覆盖，遇到妨碍施加自动阻断的过期 foreign 唯一 key 返回原子冲突。请求/认证边界及错误语义见 [额度接口](agent-interface.md#31-原生账户额度)。

写入模型均在 fsync + rename 原子替换内完成（`src/main/store.ts`），无 directory fsync；中断的写命令先以 durable intent（receipt 写入）暴露为 `COMMAND_INDETERMINATE`，要求用 `operations.get` 查收据并核对现状，不做自动重放。命令收据键为 `local-demo:<commandId>`，同键同参返回原响应、同键不同参拒绝 `IDEMPOTENCY_CONFLICT`。这不是 exactly-once 外部执行保证，也没有事务 outbox。

同步面只有拉取：`sync.status`（revision 比对）、`sync.snapshot`（受界摘要）、`tasks.events`（保留事件 ID 游标，过期 `CURSOR_EXPIRED`）。renderer 失效通知只表示"revision 变了"，不是持久 push 流。

## 4. 调度与准入（policy/routing.ts）

路由基于 policy 配置（`engines`/`owners`/`workers`/`herdr` + `blocks`）：

- `resolveDispatch` 在 owner.workers 里按权重做**全局负载最少化**：可用候选（worker 启用、引擎启用、无生效 block、权重 >0、引擎未被本次重试链排除）中，比较 `(running + 1) / weight`，最小者胜出；并列先取权重更高者，再按 owner.workers 列表顺序。这里的 `running` 是全局数：所有 owner 下 `running`+`cancelling` 的任务数之和（`workerLoad()` 扫全表），跟任务绑在哪个 owner 实例无关。空闲时这个比较退化为按权重试用，有负载时按权重比例分摊。比较用交叉相乘，不做除法。
- `worker_weights`：整数 0..10，缺省 5；0 表示永不调度该 worker，显式指定 worker 也不能绕过权重 0，也不能绕过被排除引擎（后者报 `NO_ALTERNATIVE_ENGINE`）。所有权键必须在该 owner 的 workers 列表里。
- 重试链排除：此前在链上 failed/cancelled/cancelling 的尝试的引擎进 `excludeEngines`；当前 `cancel:true` 放弃的尝试即使仍在 cancelling、仍占槽，也排除其引擎。completed 尝试的引擎仍可入选，因此不保证每次重试都换引擎。链上候选全被排除时，在取消原任务或创建子任务前明确报 `NO_ALTERNATIVE_ENGINE` 并保留原状；不排除无关任务的引擎。
- 配额 block 按引擎/model 精确匹配，绝对时间戳 `release_at` 只有明确恢复时间才自动到期，其余手动解除。
- 准入与派发同一 resolve 函数：`policy preview` 只读（`dispatch:"preview"`、`execution:"disabled"`）不执行；`workers.spawn` 实际校验 workspace/provider/容量后按结果 start 或入队。页面走的 `previewRoute` 由服务端当场补上同一份全局负载，所以预览显示的选择就是此刻派发会走的选择。
- 并发按 **owner 实例**的 `profile.max_parallel`：槽位分组是 `instance:<ownerId>`，任务绑定 `ownerId` 时竞争的就是那个确切实例自己的额度；没有 `ownerId` 的遗留任务单独共用 `profile:<profileId>` 组。同一 profile 的多个实例各占各的额度，A 会话排满不影响 B 会话开工。容量在 `workers.spawn`、pump 复核和 `manager.start()` 启动前三处都查，超限一律入队而不是抢占。
- `capabilities.maxParallel` 是 enabled profile 的 `max_parallel` 之和，配合 `capacity:{unit:'owner-instance', admission:…}` 只作规模提示——既不是 profile 级也不是全局的准入帽；系统没有全局并发上限。被限制的是**每个实例**的并发，跨实例的工作代理负载均衡仍是全局的（见第一条）。
- `herdr.max_wait_minutes`（1–1440）是负责人对同一工作代理两次检查之间的最长间隔：等待只用 `weaver tasks wait --task-id`，不带 `--for` 时上限取 `min(600 秒, max_wait_minutes × 60 秒)`（策略读不到时退到 30 秒），任务一结束就返回。期间负责人查看进展并决定继续等待、取消或收回，Weaver 不会据此停止工作代理。

队列与冻结：

- `workers.spawn` 通过预检后把当时选出的 owner/worker/engine/kind/model/effort/execution/adapter/workspace 冻结进 `task.dispatch`；排队槽只是等待容量。
- worker 与 owner 同引擎时 `execution:"native"`、adapter `native`：不启动进程，任务进入 running 并占用 owner 实例的槽位，由 owner 用宿主内置子代理工具执行后调用 `workers.complete` 回报；取消直接转 cancelled，重启恢复时保持 running（`recover()` 只把非 native 的在途任务判失败）。
- 派发响应除任务快照外还带 `next`——负责人照它做一步即可，不需要理解引擎：非 native（real/mock）和还没拿到容量的排队任务是 `{action:'wait', command:'weaver tasks wait --task-id <id>'}`；已 running 的 native 任务是 `{action:'run_subagent', model, effort, prompt, then}`，`prompt` 与真实 worker 拿到的角色指令逐字相同（`workerInstruction`），`then` 是回报命令 `weaver workers complete --task-id <id> --input report.json`。`tasks.get` 对 running 的 native 任务同样给出 `next`，所以 spawn 回复丢了也能找回那份指令。
- pump 复核当前资格/容量/配额/pin/workspace：route 改变（含 kind 不符）、容量不足、workspace 失效或 launch 失败都会给 `task.queueReason`（有界 message，仅变化落盘），代码取 `waiting_for_capacity/policy_blocked/frozen_route_changed/workspace_changed/launch_blocked`。冻结路由不会被默默改派或跨引擎替换。
- 取消：queued 直接转 cancelled；running 先 `cancelling` 再等待本进程拥有的 worker 子进程退出（SIGTERM → 1.5s SIGKILL）。取消/文件损坏不删除已有 history 与事件。
- `tasks.retry` 是单次自动派发：先完成路由、worker 能力、workspace、指令长度（≤16000）、任务数（<200）、包数（<1000）及冻结包存在性等全部预检，再按需取消原尝试并原子创建带 `retryOf` 的新任务与新冻结包。原任务有冻结包也会消耗一个新包。复制 owner/workspace/constraints 与冻结 scope/criteria，指令只加一份上次尝试与读取 git diff/部分产出的接续说明，再接链根的原始目标，避免逐代堆叠前缀；复用 `workers.spawn` 同一派发路径，直接返回任务、`next` 与非空的 `excludedEngines`。显式 mock 保持 mock，real 不回退 mock；写命令拒绝仍保留可回放收据。

## 5. 真实 worker 执行（src/main/adapters/cli）

launcher 组合（`startCliAgent`）：`RealEngineKind = 'opencode'|'pi'|'grok'|'codex'|'qodercli'`（`REAL_ENGINE_KINDS`，同一份清单也是 `capabilities.workerProviders` 里真实引擎的来源）。固定可执行名+固定 argv 组装（`adapters/cli/argv.ts`），`shell:false`，workspace 必须是已存在的绝对路径，启动前核验并随 dispatch 冻结 `workspaceIdentity`。认证使用各引擎自身的本机配置（settings/auth 文件），Weaver 不复制、不打印、不把它写进 argv/日志/请求包。

- 指令传递走 stdin 或私有 prompt 文件优先，不在 argv 放长 prompt。state 目录是 app 拥有的 `agent-state` 下私有 job 目录，不是凭据目录。
- 输出 streams 解析为普通 WorkerRecord JSONL（log/progress/artifact/result/final），stderr 脱敏有界；provider 自报的 session/model/usage 是可选 `evidence`，未知保持未知，没有捏造的模型验证。
- 终态条件：vendor terminal success + final assistant text + 零退出才写 `completed`；missing/truncated/非零退出都失败。产物抓取为有界 `result.md`/结构化 artifact，内容当纯文本数据，不当可执行 HTML。
- 请求的真实引擎/model/effort、adapter、workspace、scopeUnit 和 observed evidence 都记录在 `run` 与 observability 里；mock 显式记录 `execution:'mock'`。没有静默回退：CC 报 `CAPABILITY_UNAVAILABLE`（deferred），unknown kind 同拒，launcher 未加载同拒。
- 生命周期收尾只清理本 launch 拥有的进程；Linux/systemd host 上每个真实 launch 使用唯一命名 user scope，取消/超时/完成前先关闭自身 scope。没有共享 leader/daemon。

真实与 native 执行在 Weaver 侧没有任何停止定时器；`herdr.max_wait_minutes` 只是负责人两次检查之间的最长间隔（`weaver tasks wait`/`tasks watch` 不带 `--for` 即按 `min(600 秒, max_wait_minutes × 60 秒)` 取上限，策略读不到时为 30 秒，任务一结束就返回），Weaver 不据此停止工作代理，直接单测的 mock adapter 才允许一个更短的测试等待。

## 6. 卡住检测与引擎惩罚（src/main/stall.ts）

判定（S1）：一个 running 且 `execution:'real'` 的任务只有**两个条件同时成立**才算卡住——距最后一条事件（没有事件则从 run 起始时刻）静默 ≥5 分钟，**且**它自己那个 scope 连续 ≥5 分钟空闲。空闲按 owned-scope 的累计 CPU 判定：每 60 秒采一次、每任务保留最近 12 个样本，一个采样区间里 CPU 增量低于单核 5% 才算空闲；CPU 来自 `systemctl --user show -p CPUUsageNSec`，读不到时退到该 cgroup 的 `cpu.stat usage_usec`，两者都拿不到就是 `null`。**读不到 CPU 永不判卡住**——没有证据不是证据；只有单个样本、区间时间不前进、计数器回退或任何一个忙区间都会结束这段空闲。任务还在持续上报事件则既不算卡住也不参与统计。

阶梯（S3）：同一引擎的卡住任务凑够 2 个才惩罚引擎本身（按引擎分组，任务列表顺序）。惩罚是往策略里写一条 `by:"weaver-stall"`、**不带 `release_at`** 的 engine 级 block——它自己永不到期，也没有任何超时能解除它。级别按时点排队：L1 名义等 5 分钟、L2 等 10 分钟、L3 转 `needsAttention` 并每 10 分钟探测一次、永不因时间流逝自动解除；两小时内再次触发逐级上升，超过就停在 L3，安静满两小时级别才退役。该引擎上已经生效的非 stall engine 级 block（人工/额度）不会被叠加惩罚，未知引擎在写任何东西之前被拒。

到点（`nextProbeAt`）跑一次恢复探测：取该引擎上**第一个启用 worker** 的 model/effort，走与 engines 页同一个 `sayHi` 最轻一次性调用（`src/main/engines/hello.ts`，`agent-state/` 下私有临时目录，真实推理）。该引擎没有启用的 worker 时探测直接算失败并记原因，不调用任何东西。

- 探测失败：立刻升一级并重写那条 block 的 reason（block 一直保持着引擎的排除资格，因此不需要重新 pump），连击清零。
- 探测成功：只删自己那条 stall block，级别与 `lastTriggerAt` 原样留着，好让下一次触发直接进下一级；删失败就保持武装、下一 tick 再探。L3 要**连续三次**成功才自动解除，并在记录里留一条「自动恢复，请留意」，任何一次失败都把这串连击清零。
- 手动解除（`engines unblock --engine <id>`）：清除所选引擎的全部 block（含人工、额度及 model 级），复位它的阶梯、期限与连击；history、配置、其他引擎和任务事件保留。自动恢复仍只删除监控器自己的 stall block。刚解除或刚恢复的引擎在同一次 tick 里不会被再次惩罚。用户单独删掉策略里的 stall block 会复位相应阶梯，不会替它清除其他来源。
- 惩罚只暂停引擎的派发资格：从不取消任务、从不杀进程；running 的任务继续跑完并照常回报。

监控器每 60 秒 tick 一次，并发 tick 合并成在途那一次；只在 ready 窗口内写状态，await 采样与 await 探测之后都重新确认窗口仍然开着。期限、连击与记录落 `stall.v1.json`（见 §3），重启后继续；`stop()` 中止在途探测并等当前 tick 收束，独立于服务 ready 回调也会阻止晚到的采样/探测写入，只有再次 `start()` 才恢复 tick。`taskHealth` 与引擎页/CLI 用的是**同一套**样本与分类器，不存在第二个判定者：`stalled`（两条都满足）、`waiting_model`（静默 ≥5 分钟且 CPU 没有证明在忙，包含读不到的情况）、`working`（其余），非 running real 任务的 `silenceMs`/`cpuActive`/`cpuIdleMs` 保留为 `null` 而不是猜。`tasks.health`、`engines.health`、`engines.penalty`、`engines.unblock` 已接入同一 `CommandHandler`：health 返回不含 history 的摘要，penalty 返回单引擎完整保留记录，unblock 返回清理结果；缺监控器时返回 `CAPABILITY_UNAVAILABLE`。逐项命令语义见 [agent-interface](agent-interface.md#33-卡住健康与引擎惩罚命令)。

## 7. Owner 手动上下文与结果（ContinuationService）

- `owners.attach` 与 `owners.spawn`（缺省，无 provider）都登记 manual logical owner：名字/profile + 调用方可选 session/pane 标签（缺省 `external-cli`/`unverified`），`verified:false`、`attachmentVerified:false`。登记这一步永远是元数据：没有进程被创建、没有宿主被联系。`owners.attach` 的 **profileId+name+session 三元组全同就是同一个 durable 实例**：换 `--command-id` 重发返回同一条记录、不再新建，重启后仍旧是同一条，`pane` 只是附加的未验证元数据不参与身份；session 同时存为实例自己的字段与 host evidence 里的旧字段（早于该字段存在的记录在装载时把 `host.session` 回填到顶层）。`owners.spawn` 是显式登记，永不与 attach 的实例合并；显式 `provider:"mock"` 保留进程内 mock 宿主测试路径。
- `owners.list` 的每一项是一个**已登记实例**，带自己的 `runningTaskCount`（running + cancelling，即它此刻占着的槽）；`owners.get` 同样。带 `ownerId` 的任务绑的就是这个确切实例（准入见 §4）。
- `owners.switch`（需 expectedRevision,可选 expectedEpoch/reason/profileId,以及 `launch?:boolean`）在 mock 宿主上做原子握手；manual 分支在 quiescent + revision/epoch 校验后组装有界 `contextPack`（≤32 KiB，不含 artifact 正文与全量 transcript），创建 manual replacement registration（`host.attach`，ownsHost=false/verified=false），原子更新任务 owner binding/epoch/history/pack，返回 pack 与一份可直接投给新宿主的纯文本 `prompt`（每个自由文本值都经 `redactContext` 脱敏、按段压缩到 ≤6000 字符）。`owners.continuation.get` 在有 pack 时给同一个 `prompt`。这个交接包是纯元数据：`acknowledgementId` 为 `null`，pack limitations 写明"external owner 必须自行读取 pack；真实宿主切换由 CLI 承担；Weaver 没有自动投递/确认"。
- `launch:true` 时，轮换**已经提交**之后再显式尝试 Herdr 宿主：`src/main/owner-host.ts` 在 Herdr 的 `default` session 里 `workspace create --cwd <任务 workspace> --no-focus`，读回它自己报的 `result.workspace.workspace_id` 与 `result.root_pane.pane_id`（不透明 pane id 绝不当 workspace id 用），再 `agent start owner-<任务 ID 前 8 位>-<epoch>`（kind 只支持 claude/codex，按 profile 的 model/effort 组装 argv）并 `agent prompt` 投那份接手 prompt。Herdr 退出码 0 但回体带 `error` 也按失败处理；有确切 workspace ID 后的任一步失败都定向尝试关闭它自己创建的 workspace，清理失败会并入原错误；拿不到 workspace ID 时不猜测归属、不误删资源。失败时**轮换不回滚**：响应 `launch:{ok:false, code, message}`，`OWNER_LAUNCH_UNSUPPORTED`/`OWNER_LAUNCH_UNAVAILABLE`/`OWNER_LAUNCH_FAILED` 如实区分，任务事件记一条 error。之后 `owners.launch`（需 expectedRevision）用任务上现存的 `contextPack` 重试拉起，**不再轮换**，返回 `prompt` 与 `launch` 结果。`capabilities.ownerSpawn` 只在 `herdr` 可在 `PATH` 上执行时是 `'herdr'`：它证明的是这个可执行文件存在，不证明有活的模型/登录/宿主，登记本身也仍然是元数据（`manualAttach:'metadata-only'`）。成功拉起的宿主记在 `task.ownerHost`（`{kind:'herdr', session, workspaceId, paneId, agentName, launchedAt}`），是出处记录，不是可用性证明。
- 生产 HTTP/Unix 通道调用异步 `handleAsync()`；同步入口与异步入口共用命令流及 Herdr 协议，没有第二套 launcher。响应仍等待最终 `{launch:{ok,...}}`，没有 pending/jobs API。意图先持久化；同 commandId 同参在途重发返回 `COMMAND_INDETERMINATE`，完成后回放最终收据，不重复拉起。同 task+epoch 的另一启动返回 `INVALID_STATE`。异步完成时重新读取任务，只在 ownerId/epoch 仍一致且未 draining 时保存 ownerHost 和事件，保留等待期间的新任务状态；已被新 binding 或关停取代的成功宿主只按本次确切 session/workspace 清理，不覆盖新状态。
- ownerHost 落盘失败时清理这次宿主并如实报告；若实际落盘已成功、只是后续通知监听器抛错，则保留已持久可见的宿主。收据完成保存失败仍返回 `COMMAND_INDETERMINATE`，不把副作用当作未执行。`commands.drain()` 先拒新命令、中止启动、等待启动及必要清理收束，再由 runtime 关闭其余资源；清理不复用已中止的启动 signal。
- 传输常规时限是 15000 ms。仅完整且通过 token 校验的 IPC 帧，或同源校验和 body 解析通过的 HTTP 请求，且逻辑请求为格式合法的 `owners.launch` 或 `owners.switch`+`launch:true` 时，采用固定 210000 ms 启动等待；半帧、坏格式、未认证及普通请求仍走 15 秒。CLI 使用同一分类并尊重调用方明确给出的更短等待。这个请求等待不改变 worker 生命周期，也不保证宿主/模型可用。
- manual 空闲到期只把任务标记 due 并提示技能发起手动接续；mock-only 的 prepareOwnerActivity 自动轮换保留在 mock 路径里。
- 结果流：manual owner 自己 `tasks.results` 拉 manifest（含 artifact sha256 与 `manifestDigest`）→ 独立查文件/跑测试 → `results.ack`（expectedRevision + 当前 digest；ack 后 delivery=acknowledged，验收不变）→ `reviews.submit`（同 digest + expectedRevision,decision accepted/rejected）更新 `acceptance`。`results.deliver` 对 manual owner 显式 `CAPABILITY_UNAVAILABLE`，不伪造外部投递。

## 8. 引擎目录与探测

固定 catalog（`src/shared/engines.ts`）：claude/codex/grok/opencode/pi/qoder 六个 id，kind 分别 claude/codex/grok/opencode/pi/qodercli。探测只做 PATH 可执行文件 + 带超时 `--version`（shell:false、ANSI 去除、4s 超时、进程组收尾）；结果永远 `authenticated:false`、`modelUsable:false`。启用权威是 PolicyStore `engines[id].enabled`（`engines set-enabled` 需 installed 探测 + revision）；启用引擎不会创建任何角色。adapter 状态按 kind 判：`real` = opencode/pi/grok/codex/qodercli（`REAL_ADAPTER_KINDS`），`deferred` = claude，其余 kind 才是 `not_implemented`；`realExecution` = 该引擎 adapter 为 real 且已启用且有启用的 worker 使用它，探测≠可用。`EXECUTION_BOUNDARY.realAdapter` 也从同一份真实 adapter 清单生成，包含 qodercli。

真实执行适配（`src/main/adapters/cli/argv.ts` + `normalize.ts`）覆盖 opencode、pi、grok、codex、qodercli。qodercli 以 `-p -o stream-json` 从 stdin 读任务，`--permission-mode bypass_permissions`（CLI 策略，不是 OS 隔离），`--setting-sources ""` 与 `--strict-mcp-config` 跳过用户级 hooks、插件与 MCP，`--no-session-persistence` 不落会话；输出按 Claude Code 风格的 system/assistant/result 事件归一化。claude 仍无执行适配。

## 9. 已知限制（不是未来路线）

- 没有按 owner 的认证/对象级权限；本地凭据是 trusted-user 级（`capabilities.authentication` 声明）。
- 定时额度刷新只按固定间隔探测并同步自有阻断，不做失败重试；超额失败按 provider 错误如实报告，不自动换引擎或模型。
- 本地控制面只面向 Linux/Unix：服务进程（前台 `weaver web`，或 `weaver server start` 起的后台实例）先启动 Unix CLI socket 再启动 HTTP（`src/main/runtime.ts`），而 `startLocalIPC` 在 win32 直接 `UNSUPPORTED_PLATFORM`（`src/main/local-ipc.ts`），因此控制面在原生 Windows 不能启动。真实受管 worker 还依赖 Linux systemd user scope。不声称原生 Windows 支持，也不再描述未验证的远程访问形态。
- 没有持久任务 retention/自动清理策略、迁移导入工具、SQLite/outbox/事件总线、全局持久事件流。任务页已有归档抽屉：将已结束满一天的任务显示在派生归档视图中，不删除持久任务。
- 没有 worker 递归与多 owner 交叉指挥；一个任务一个 owner，owner 间协作回到技能宿主的可见会话。
- 卡住判定依赖能读到 owned-scope 的 CPU：非 systemd host 或读不到计数器时任务永远不算卡住，也就不会有惩罚——这是有意的保守默认，代价是这类 host 上惩罚阶梯事实上不会启动。
- 本机实测宿主/版本证据以 `docs/verification/**` 与 [VERIFICATION.md](../VERIFICATION.md) 为准；本文不声称最终验收。

## 10. 来源与出处

沿用 skill-foundry 上游 provenance（Apache-2.0）：上游仓库 [MarioJames/skill-foundry](https://github.com/MarioJames/skill-foundry/tree/61989b11a5d0565d2a6630833e64a2d73769a947/skills/agents-cooperation)，`scripts/agents-config.ts` 与 `scripts/lib/json-schema.ts` 迁入 `src/main/policy/*`，详见 [script-migration](script-migration.md)。Weaver 自有扩产（权重/pin/真实 launcher/CLI 面等）是本仓库独立实现。公开技能见 [skills/agents-weaver/SKILL.md](../skills/agents-weaver/SKILL.md) 与 [provenance](../skills/agents-weaver/references/provenance.md)。
