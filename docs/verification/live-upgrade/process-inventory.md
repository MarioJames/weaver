# Weaver 服务进程与链路盘点（只读事实报告）

> 范围：`/home/mocha/opensource/weaver`（TypeScript，服务入口 `src/main/runtime.ts`）。
> 方法：只读源码 + 只读 `systemctl --user cat/show weaver.service`。未停止/重启任何进程。
> 约定：每条结论后标注 `文件:行号`。行号以当前工作区检出为准。

## 0. 总览

服务进程（`weaver web` / systemd `weaver.service`）拉起的子进程/会话共 7 类：

| # | 类别 | 载体 | systemd 封装 |
|---|------|------|--------------|
| A | 普通任务 worker（real CLI） | `startOwnedScope` | `--scope`（`weaver-cli-<engine>-<id>`） |
| A′ | Mock worker | `child_process.spawn` 直连 | 无 |
| B | 定时任务 schedule：script / direct CLI / direct claude-native / legacy-root / quota.refresh | `startOwnedScope` / `startCliAgent` / `createParentAgent` / 任务通道 / 进程内 | script 与 direct 均为 `--scope`（`weaver-schedule-<runId>` / `weaver-cli-…`）；quota 无子进程 |
| C | Owner host（Herdr 父 Agent） | `herdr` CLI 子进程（spawnSync/spawn，非 scope）+ 远端 Herdr 会话 | 无（Herdr 侧会话在服务外） |
| D | 飞书 IM 父 Agent + background host | `systemd-run --service`（`weaver-im-host-<epoch>.service`）+ host 内 `spawn` 的引擎进程 + 私有 unix socket | `--service`（非 scope） |
| E | 引擎 hello/probe、quota HTTP、stall CPU 采样 | `spawn` 直连 / 进程内 `fetch` / `execFile(systemctl)`+读 cgroup 文件 | 无 |
| F | HTTP/vite/本地 IPC/浏览器打开 | 进程内 server 或 `spawn … unref` 短命进程 | 无 |

服务 `close()` 顺序（`src/main/runtime.ts:274-296`）：`im.close()` → `commands.drain()`（内含 `schedules.stop()` + runner drain）→ `schedules.stop()` → `stall.stop()` → `freeProbe.stop()` → `quotaProber.close()` → `greetings.abort()` → 等 `ownerDrain` → 等 `inflight` → `manager.shutdown()` → `store.close()` → `http.close()` → `ipc.close()`。

---

## (1) 每一类子进程/长驻会话

### A. 普通任务 worker（real / mock）

- **启动方式**：real 执行经 `RoutingWorkerAdapter.start` 调 `launch`（即 `guardPiLaunch(startCliAgent, …)`）(`src/main/adapters/routing.ts:22-45`, `src/main/runtime.ts:237`)；`startCliAgent` 经 `prepareCliAgentInput` 写私有 prompt/state 文件后 `new CliAgent`，其内部调 `startOwnedScope`(`src/main/adapters/cli/launch.ts:272-276`, `src/main/adapters/cli/launch.ts:166-168`)。`systemd-run --user --scope --collect --quiet --unit=weaver-cli-<engine>-<4hex>`，`MemoryHigh=8G MemoryMax=10G KillMode=control-group`，`detached` 默认为 false(`src/main/adapters/cli/scope.ts:144-148`)。unit 形如 `weaver-cli-<engine>-<id>`(`src/main/adapters/cli/launch.ts:121`)。非 Linux 直接抛错(`src/main/adapters/cli/scope.ts:128`)。mock 执行（`dispatch.execution!=='real'`）走 `MockWorkerAdapter.start`：直连 `spawn(node, mock-worker.mjs)`，stdin 写一行业务 JSON 后关闭，无 scope(`src/main/adapters/worker.ts:22-33`)。
- **I/O 通道**：scope 的 stdout/stderr 管道接回服务进程（`stdio: [stdinPath|pipe, pipe, pipe]`，`src/main/adapters/cli/scope.ts:148`；`handle.stdout/stderr = child.stdout/stderr`，`src/main/adapters/cli/scope.ts:152-153`）；`CliAgent` 把 vendor 输出归一化为 JSONL 再经 `PassThrough` 给 `TaskManager`(`src/main/adapters/cli/launch.ts:124-133,177-193,227-232`)。`TaskManager` 订阅 `stdout data → JsonlParser`、`stderr data`、`error/close`(`src/main/manager.ts:86-121`)。
- **close() 行为**：`manager.shutdown()` 对每个 running 任务 `cancel()`（running→cancelling，`cancelled=true`，`terminate()` 发 `SIGTERM`，1500ms 后 `SIGKILL`，`src/main/manager.ts:153-160,187-190`），等待全部 `close` 事件后 `store.flush()`(`src/main/manager.ts:158-159`)。scope 层 `kill()` 走 `systemctl kill --kill-whom=all` 先 TERM 后 KILL 再 `stop`(`src/main/adapters/cli/scope.ts:203-252`)。即：正常停机**取消所有运行中 worker**。
- **启动恢复行为**：`startRuntime` 内 `recoverInterruptedTasks(store)` 把所有 `active()`（running/cancelling）且非 native 的任务标 `failed`，事件写明 “Interrupted by app exit. No worker was resumed”(`src/main/application/tasks/recovery.ts:5-9`, `src/main/runtime.ts:209-210`)。native（owner 自跑）任务不碰（条件 `run.execution!=='native'`，同文件）。`active` 定义 `status running|cancelling`(`src/main/domain/tasks.ts:5`)。
- **持久化标识**：任务行 `tasks` 表（`tasks(id, owner_id, parent_task_id, status, updated_at, body)`，`src/main/migrate.ts:12`；body 含 `run` 对象）。`run.scopeUnit`（`weaver-cli-…`，`src/main/manager.ts:209` 经 `observe()` 写入 `scopeUnit`，`src/main/manager.ts:207-215`）、`run.pid`、`run.evidence`（engine/model/workspace/promptPath/sessionDir 等，`src/main/manager.ts:210-214`）。恢复时**不做** scope 归属校验，直接标失败（与 schedule 的 `recoverOwnedScope` 不同）。

### B. 定时任务 schedules（含 direct 与 recoverOwnedScope）

- **组成**：单 app-owned 轮询器 `ScheduleService`，`setInterval(tick, 1000)` 且 `unref`(`src/main/schedules/service.ts:629-643`)。执行分 5 种：
  1. `script`：`executeScript` → `startOwnedScope({command:['/bin/sh','-c',…], unit:'weaver-schedule-<runId>', detached:true})`(`src/main/schedules/process.ts:31-38`)；输出上限 64KiB(`src/main/schedules/process.ts:7`)；超时按配置秒数后 `SIGKILL`(`src/main/schedules/process.ts:44`)；`cancel()` 发 `SIGKILL`(`src/main/schedules/process.ts:52`)。注意此处 `detached:true`（与任务 worker 不同）。
  2. `direct CLI`（role worker 或非 claude 的 owner）：经 `startCliAgent`（可被 `guardPiLaunch` 包裹），`beforeSpawn` 回调**先在同一事务里持久化 `process={unit}`** 再启动(`src/main/schedules/service.ts:296-306`)；`identity` 事件回写 `invocation`（仅当 unit 匹配且格式为 32hex，`src/main/schedules/service.ts:344-352`）。
  3. `direct claude-native`（role worker + kind claude）：`parentFactory ?? createParentAgent`，launcher 为 `startOwnedScope({stdin:null, keepStdinOpen:true, unit:'weaver-schedule-<runId>'})`(`src/main/schedules/service.ts:380-390`)；初始化期间 cancel 只记 intent，不发送 goal(`src/main/schedules/service.ts:391-404,422-454`)。
  4. `legacy-root`（owner + kind claude/codex 的旧形态）：不直启进程，而是 `createTask` 建任务再走 `tasks.start` 普通任务通道(`src/main/schedules/service.ts:166-180,515-519`)。
  5. `builtin quota.refresh`：进程内循环调 `refreshQuota`（HTTP 额度探测），无子进程(`src/main/schedules/service.ts:554-575`)；失败只记输出，不 fail 整轮（注释 `src/main/schedules/service.ts:570-572`）。
- **I/O 通道**：script：stdout/stderr 管道捕获 64KiB（`src/main/schedules/process.ts:40-41`）。direct CLI：同 A（`ManagedAgentProcess` stdout JSONL，`observeDirectCli` 只解析 `result` 帧，`src/main/schedules/service.ts:253-290`）。direct claude：`session.send(prompt, signal)` 经内存字符串返回，无流式落盘(`src/main/schedules/service.ts:464-467`)；host 的 engine stdio 在 host 进程内（见 D）。
- **close() 行为**：`ScheduleService.stop()` 置 `stopped=true`、清 timer，对 scripts 发 `cancel('interrupted')`、对 directs 调 `cancel()`（记 intent + SIGTERM 精确 scope），`await` 全部 jobs(`src/main/schedules/service.ts:645-650`)。`runtime.close` 中 `schedules.stop()` 被调两次（`commands.drain()` 内一次 + 显式一次，均幂等，`src/main/commands.ts:61-65`、`src/main/runtime.ts:282`）。`finish` 时若 `stopped` 且非用户 intent，状态记 `interrupted` 而非 `cancelled`(`src/main/schedules/service.ts:371-374,497-501`)。
- **启动恢复行为**：`schedules.start()` 遍历有 `activeRunId` 的定义：`taskId` 的走 `reconcileAgent`（任务终态则 `finish`，否则若 receipt 缺失则视为不确定启动并 `abortAgent` 取消到终态才释放 claim，`src/main/schedules/service.ts:520-544`）；其余走 `recover()`：`scopeConfirm(unit, invocation)`（默认即 `recoverOwnedScope`，`src/main/schedules/service.ts:77-80`）确认 scope 已死才清理 `schedule-agent-state/<runId>` 并 `finish(interrupted)`；确认失败则保留 claim 并记 `recoveryError`(`src/main/schedules/service.ts:597-614`)。`tick()` 中运行中但无 job 的 run 也会被 `recover`(`src/main/schedules/service.ts:618-621`)。下线期间到期的 `nextRunAt` 被快进为忙时跳过(`src/main/schedules/service.ts:634-639`)。`recoverOwnedScope` 仅接受 `weaver-schedule-<uuid>` / `weaver-cli-<engine>-<hex>` 命名，其余拒绝；无 invocation 的 CLI scope 拒绝 kill（fail-closed，`src/main/adapters/cli/scope.ts:79-123`)。
- **持久化标识**：全部在 `weaver.db` 的 kv 行：`schedules.v1`（定义数组）、`schedules.runs.<scheduleId>`（`StoredRun[]`，含 `process:{unit, invocation?}`、`cancelRequested`、`recoveryError`、`outputSlot`）、`schedules.output.<scheduleId>.<slot>`（>256B 的输出外置，`src/main/schedules/store.ts:4-5,60-90`）。per-run 私有目录 `schedule-agent-state/<runId>`（0700，`src/main/schedules/agent.ts:108-112`），仅在 scope 确认关闭后删除(`src/main/schedules/service.ts:369,607`)；中性工作区 `schedule-workspaces/<scheduleId>`(`src/main/schedules/agent.ts:92-105`)。

### C. owner host / Herdr 拉起的父 Agent

- **启动方式**：无 systemd scope。`launchOwner` 以 `defaultRunner`（`spawnSync(herdr, …)`，`stdio ignore/pipe/pipe`，`timeout`，`src/main/owner-host.ts:31-37`）或 `launchOwnerAsync`/`defaultAsyncRunner`（`spawn(herdr, …)`，`stdio ignore/pipe/pipe`，**非 detached**，逐块 64KiB 缓冲，超时先 TERM、250ms 后 KILL，`src/main/owner-host.ts:313-344`）串行执行 `herdr workspace/tab create → agent start → agent prompt`（名 `owner-<taskhex>-<epoch>`，`src/main/owner-host.ts:22-29,181-260`）。`EffectRunner.driveAsync` 透传 AbortSignal，8s 的 `first-output` 等待附带(`src/main/application/commands/gateway.ts:47-61`)。`agent start` 超时 60s(`src/main/owner-host.ts:14`)。实际 Agent 进程活在 **Herdr 会话侧**，不在服务 cgroup 内。
- **I/O 通道**：无管道。服务只经 herdr CLI 的 JSON stdout 拿回 `{session, workspaceId, paneId, tabId?, agentName}`(`src/main/owner-host.ts:205-231`)；后续无控制通道。任务侧只读 `tasks.get/events` 轮询。
- **close() 行为**：`commands.drain()` → `runner.drain()` abort 全部 launch controllers 并等待 pending flow(`src/main/application/commands/gateway.ts:62-65`)；进行中的 launch 若已产出 host 且任务已转绑/停机则关闭该 host(`src/main/application/owners/lifecycle.ts:106-112`)。`closeCancelledRoot` 经 `runDeferred` 异步关 host，删除任务行 `ownerHost` 并记事件(`src/main/application/owners/lifecycle.ts:134-152`)。注意 `drain()` 本身**不枚举关闭既有 `ownerHost`**（只处理 in-flight launch 和 cancel-deferred）。
- **启动恢复行为**：`recoverInterruptedTasks` 对 `executionRole==='owner'` 且有 `ownerHost` 的 running 任务**豁免**（不标失败，`src/main/application/tasks/recovery.ts:6`），事件只对无 host 的 owner 写中断。`startRoot` 的 `restart` 分支允许 `failed` 无 host 的 owner root 重试（epoch+1，`src/main/application/owners/lifecycle.ts:156-166`)。
- **持久化标识**：任务 body JSON 的 `ownerHost: {kind:'herdr', session, workspaceId, paneId, tabId?, createdWorkspace?, agentName, launchedAt}`(`src/shared/contracts/tasks.ts:28`；写入 `src/main/application/owners/lifecycle.ts:113-115`)。Herdr 侧 workspace/tab 真实存在与否，服务重启后**不校验**（未见 reconcile Gegen Herdr）。

### D. 飞书 IM 父 Agent 与后台 host

- **启动方式**：`ImService` 每个逻辑 session 经默认工厂 `createBackgroundParentAgent`(`src/main/im/service.ts:368-386`) 拉起**独立 systemd user service**：`systemd-run --user --collect --unit=weaver-im-host-<epoch>.service --service-type=exec … StandardInput=null StandardOutput/Error=journal ExitType=main KillMode=control-group Restart=no … MemoryHigh/Max 8G/10G --working-directory=<workspace> -- <node|entry> __weaver-im-parent-host <endpoint> <epoch>`，附 `ExecCondition=test -S <socket>` 防延迟启动(`src/main/im/parent-background.ts:194-200`)。引擎子进程由 host 进程内 `spawn(cmd, {stdio:[pipe,pipe,pipe]})` 启动（`launch: (command, cwd, extra) => spawn(…)`，`src/main/im/parent-host.ts:89-91`），活在该 service 的 cgroup 内。另有 `startParentScope`（`dev-weaver-im-<rand>` scope，`keepStdinOpen`）供**非 background** 的 IM parent 直连形态(`src/main/im/parent-agent.ts:150-154`)；background 工厂是默认路径(`src/main/im/service.ts:385`)。
- **I/O 通道**：服务↔host 经私有 unix socket `<dataDir>/im-host/<epoch>/s`（`src/main/im/parent-background.ts:64-66`，600 权限，路径>100B 拒绝，`src/main/im/parent-background.ts:67`），`hostWire` 换行帧（1MiB 上限，epoch 校验，`src/main/im/parent-host-wire.ts:7-34`）；类型 `hello/init/ready/failed/prepare/submit/delta/result/error/cancelled/not-submitted/close`(`src/main/im/parent-background.ts:113-150`, `src/main/im/parent-host.ts:81-194`)。turn 16 分钟上限(`src/main/im/parent-background.ts:174`)；host 启动外层预算 125s = 引擎握手 30s + 身份轮 90s + 余量(`src/main/im/parent-identity.ts:3-9`)。飞书 WS 由 `channel`（larksuite）持有，进程内。
- **close() 行为**：`runtime.close` 先 `im.close()`(`src/main/runtime.ts:280`)；`ImService.close` 设 `closed`、双 generation fence、`releaseTransport(true)`：作废 sessions、关 WS、逐个 `parent.close()`（60s `boundedClose`，`src/main/im/service.ts:154,311-322,339-354`）。单个 session `close()` 发 `close` 帧/销毁 socket，`cleanupHostRecord`（unlink socket → `inspectHostUnit` → 关 Herdr lane（background 无 lane，跳过）→ `systemctl stop unit` → 确认 cgroup 消失 → `rm -rf` 整 epoch 目录，`src/main/im/parent-background.ts:152-163`，`src/main/im/parent-host-resources.ts:100-134`）。host 进程内 SIGTERM/SIGHUP：SIGHUP 忽略，SIGTERM 关引擎 session 后退出(`src/main/im/parent-host.ts:78-79,38-61`)。
- **启动恢复行为**：`ImService` 为全新内存状态（sessions/actions/pending 全空，`src/main/im/service.ts:56-67`）。`createBackgroundParentAgent` 启动前串行回收 `im-host/*` 残留：`live` 集合外 + 同 boot 且 ownerPid/start 对不上（即上次服务已死）的记录一律 `cleanupHostRecord`；同 boot 且 owner 仍活的记录直接 `resourceError()` 拒绝启动（防双活，`src/main/im/parent-background.ts:57-72`）。`recordLaunchKind` 拒绝未知 launchMode(`src/main/im/parent-host-resources.ts:28-34`)。
- **持久化标识**：`<dataDir>/im-host/<epoch>/record.json`（`HostRecord`：unit/endpoint/ownerPid/ownerStart/boot/invocation/cgroup/mainPid/launchMode 等，`src/main/im/parent-host-resources.ts:12-21`，`saveHostRecord` 36-37）；`im-settings.json`（`src/main/im/settings.ts:136-138`）、`im-inbox.json`（`src/main/im/inbox.ts:62-68`）跨重启保留配置与收件箱。**对话上下文不持久化**：重启后 standby session 全新创建，排队/进行中的 turn 丢失（`releaseTransport` 清 pending/queue，`src/main/im/service.ts:314-318`）。

### E. 引擎 hello / probe、quota、stall / free-channel 探测

- **hello（页面探测）**：`sayHi` 直接 `spawn(<engine>, argv, {cwd: 私有 scratch, stdio ignore/pipe/pipe})`，**无 systemd scope、无 detached**(`src/main/engines/hello.ts:160-164`)；scratch `<root>/hello-<rand>`（0700，用后删除，`src/main/engines/hello.ts:204-223`）；超时 120s(`src/main/engines/hello.ts:16`)；`signal` 来自 `greetings` AbortController(`src/main/runtime.ts:120-121`)。`HelloJobs` 纯内存（最多 3 并发，完成后保留 10 分钟，`src/main/engines/hello.ts:258-284`）。
- **stall 探测**：`StallMonitor` 60s tick(`src/main/stall.ts:305-307`)；CPU 经 `systemctl show <scope>.scope CPUUsageNSec`，失败则读 `/sys/fs/cgroup/<ControlGroup>/cpu.stat`(`src/main/monitors/cpu.ts:27-35`)；恢复探测复用 `sayHi` 并 `track()` 进 inflight(`src/main/runtime.ts:218-224`)。**从不 kill/cancel 任务**（注释 `src/main/stall.ts:169-172`）。
- **free-channel 探测**：`FreeChannelProbeMonitor` 60s tick(`src/main/free-channel.ts:163-167`)；同 `sayHi` 通道(`src/main/runtime.ts:226-236`)；只写 policy blocks，不碰任务进程。
- **quota**：`QuotaProber` 进程内 `fetch`（单引擎 8s 超时，`src/main/quota/index.ts:50`），无子进程、无独立 timer（由 schedule 的 `quota.refresh` 内置定义驱动，`src/main/schedules/service.ts:81-96`）。
- **close() 行为**：`greetings.abort()` 中断 hello/probe(`src/main/runtime.ts:286`)；`stall.stop()/freeProbe.stop()` 加 fence、中止在飞 probe、等待当轮 tick(`src/main/monitors/lifecycle.ts:59-67`，`src/main/stall.ts:313-315`，`src/main/free-channel.ts:170-172`)；`quotaProber.close()` abort controllers 并等待 inflight(`src/main/quota/index.ts:103-107`)；`await Promise.allSettled(inflight)` 兜底(`src/main/runtime.ts:288`)。`MonitorLifecycle` fence 保证 stop 后写入丢弃(`src/main/monitors/lifecycle.ts:22-30`)，timer 均为 `unref`(`src/main/monitors/lifecycle.ts:43`)。
- **启动恢复行为**：三者状态全在 `weaver.db`（stall：`stall_penalties/history`；free：`free_probe_workers/history`；vendor：`vendor_worker_limits`；quota：`quota_records/quota_state`，`src/main/storage/stall-state.ts:92-127`，`src/main/storage/free-probe-state.ts:94-132`，`src/main/storage/vendor-limits.ts:25-33`，`src/main/storage/quota-snapshot.ts:17-41`），注释明示 “restart keeps …”(`src/main/runtime.ts:214,227`)。内存（CPU 采样、jobs、在飞 probe）丢失；reconcile 以 live policy blocks 为准，未知 block 领养（stall `src/main/stall.ts:373-409`，free `src/main/free-channel.ts:273-306`）。
- **持久化标识**：见上；`quota_records(engine, body)` + `quota_state`(`src/main/migrate.ts:45-49`)。

### F. 附带：HTTP / IPC / 浏览器

- HTTP（127.0.0.1 + 可选 vite，`src/main/runtime.ts:191-208`，`src/main/http.ts:137`）与本地 IPC socket（见 §4）均为进程内 server，随 `http.close()/ipc.close()` 关闭(`src/main/runtime.ts:291-293`)。`openBrowser` 为 `spawn … detached + unref` 短命进程，不跟踪(`src/main/runtime.ts:83-89`)。
- 前台 `weaver web` 的 SIGINT/SIGTERM 由 `runForegroundShutdown` 接管并调一次 `close()`(`src/cli/commands/web.ts:88-105`)；`server start` 拉起的 detached 后台进程同样跑 `weaver web`，故走同一处理器（`serverStop` 发 SIGTERM 后轮询，`src/cli/server/lifecycle.ts:145-160`）。

---

## (2) 外部 CLI 在服务停机期间的行为

- **传输层映射**：`sendRequest` 在 `readDiscovery` 报 ENOENT（无 control 文件）时抛 `APP_NOT_RUNNING`(`src/cli/client.ts:9-14`)；socket `ENOENT/ECONNREFUSED` 同样映射为 `APP_NOT_RUNNING`(`src/cli/client.ts:26`)；连接后无数据断开为 `TRANSPORT_ERROR`(`src/cli/client.ts:39`)。**无任何重试**，一次即抛。`runCLI` 顶层 catch 写 envelope（`{...failure(code,message), commandId}`）并 `exit 1`(`src/cli/run.ts:80-85`)。
- **`tasks wait / watch`（本地轮询）**：`pollTask` 按 `--for`（默认 `min(600, herdr.max_wait_minutes×60)`，读不到为 30s，`src/cli/poll-task.ts:8-16`）循环 `tasks.get[/events/health]`(`src/cli/poll-task.ts:44-89`)。catch 中**仅** `snapshot.ok && TIMEOUT` 转为 `finish('timeout')`（exit 1，`src/cli/poll-task.ts:90-93,36-42`）；`APP_NOT_RUNNING / ECONNREFUSED / TRANSPORT_ERROR` 直接 throw → 立即失败退出，不重试、不等待服务恢复。`tasks.events`（非本地命令）走单次 `sendRequest`，同样无重试(`src/cli/run.ts:74-79`)。
- **父 Agent 正在 wait 时服务重启**：wait 进程当前轮 `sendRequest` 抛 `APP_NOT_RUNNING`（若恰在旧 socket 上则为 `TRANSPORT_ERROR`），`pollTask` 不捕获 → CLI 退出码 1，已走过的轮询结果丢失；服务端该任务按 §1-A（标 failed）或 §1-C（owner 有 host 则保留 running）处理。重启后需用户重新发起 `wait`；新 `wait` 读到终态直接 `finish('terminal')`(`src/cli/poll-task.ts:62-64`)。**重启不会自动续上原来的 wait**。
- **`server status/start/stop` 的探测**：`probeServer` 把 `APP_NOT_RUNNING` 视为 `stopped`（非错误，`src/cli/server/lifecycle.ts:79-92`），故 `status` 在停机时返回 `stopped` + service 信息（exit 0，`src/cli/server/lifecycle.ts:118-124`）；`stop` 在已停时返回 `alreadyStopped`(`src/cli/server/lifecycle.ts:145-148`)。

## (3) 安装与升级路径

- **`install.sh`**：只负责可执行文件：下载 `weaver-<os>-<arch>` + SHA256SUMS 校验 → 原子 `mv` 到 `~/.local/bin/weaver`（同目录 rename，“running weaver keeps its old file”，`install.sh:93-101`）；`--uninstall` 仅删二进制并声明保留 `~/.local/share/weaver`(`install.sh:44-52`)。**不碰数据目录、不写 systemd unit、不重启服务**。
- **`weaver server install/start/stop/uninstall`**（`src/cli/server/commands.ts:1-88`）：
  - `install` 要求 standalone 可执行文件(`src/cli/server/lifecycle.ts:175`)；写 `~/.config/systemd/user/weaver.service`（Linux，`src/cli/server/lifecycle.ts:40-44`）内容 `Type=simple / ExecStart=<self> web --no-open --port … --data-dir … / WEAVER_SERVICE=systemd / Restart=on-failure RestartSec=5`(`src/cli/server/systemd.ts:17-35`)，`daemon-reload + enable` 后 `systemctl start` 并等待 ready(`src/cli/server/lifecycle.ts:186-208`)；macOS 写 `~/Library/LaunchAgents/dev.weaver.server.plist`（`RunAtLoad + KeepAlive{SuccessfulExit:false}`，`src/cli/server/launchd.ts:12-42`）。
  - `start`：同 port+dataDir 的已安装 service 走 `systemctl start`，否则 `spawn(detached, stdio→<dataDir>/server.log) + unref` 拉起 `weaver web --no-open` 并轮询 `serverInfo` 至 ready（默认 20s，`src/cli/server/lifecycle.ts:126-143`，`src/cli/server/env.ts:74-85`）。
  - `stop`：`runningWorkers>0` 且无 `--force` 拒绝 `SERVER_BUSY`（“stopping cancels them”，`src/cli/server/lifecycle.ts:150`；uninstall 在 macOS 同理，`src/cli/server/lifecycle.ts:219`）；否则按 `serverInfo.pid` 发 SIGTERM 并轮询至 socket 消失（默认 60s，`src/cli/server/lifecycle.ts:151-159`）。stop 是干净 drain（service `Restart=on-failure` 不会因正常退出重启，help 文案 `src/cli/server/commands.ts:17`）。
- **数据目录 releases 版本目录**：仓库源码（`src/`、`install.sh`、`src/cli/server/*`）**无任何引用**（全仓 grep `releases` 仅命中 docs/tests 与 codex 自身路径，无版本切换逻辑）。本机实测：`systemctl --user cat weaver.service` 显示主 unit `ExecStart=…/.local/bin/weaver web …`，另有 drop-in `weaver.service.d/70-feishu-im-release.conf` 以 `ExecStart=` 清空后重写为 `/…/node /…/releases/20261021-console-f723e6c44554/dist/cli/main.mjs web …`（同 port/dataDir）。即 releases 目录是**运维侧（owner 手工/脚本）准备的版本化产物 + systemd drop-in 覆盖 ExecStart**的升级手段；`server start/status` 经 `unitValues()` 回读 unit（含 drop-in 合并后）ExecStart 的 `--port/--data-dir` 来复用 service(`src/cli/server/lifecycle.ts:50-67`)，天然跟随 drop-in 指向的版本。未确认：该 drop-in 与 releases 产物的生成/切换脚本不在本仓库（属外部运维操作）。
- **数据库迁移**：`TaskStore` 构造（`new DatabaseSync(weaver.db)` → `chmod 600` → `PRAGMA WAL/FULL/FK/busy_timeout` → `migrate(db)`，`src/main/store.ts:22-32`）与 `PolicyStore` 构造（自带库或**共享同一连接**，同样 `migrate`，`src/main/policy/store.ts:56-67`）在 `startRuntime` 建 store 时执行(`src/main/runtime.ts:209-211`)。`migrate()` 按 `PRAGMA user_version` 逐版本 `BEGIN IMMEDIATE…COMMIT` 升至 `SCHEMA_VERSION=11`(`src/main/migrate.ts:4,164-179`)；库版本**高于**构建则启动直接抛错（无降级，`src/main/migrate.ts:167`）。

## (4) 本地 IPC（socket/token 文件）重启行为

- **布局**：`<dataDir>/control.v1.json`（`{version, instanceId(32hex), socketPath, tokenPath}`）+ `<dataDir>/control-<instanceId>/{ipc.sock, token(64hex)}`(`src/main/local-ipc.ts:27,144-149`；校验路径必须匹配实例，`src/main/local-ipc.ts:53-68`)。权限 0700/0600，多处 `lstat` 硬化（目录不可组写、属主一致、禁 symlink，`src/main/local-ipc.ts:47-68`)。
- **启动**：`startLocalIPC` 先 `staleEndpoint` 探测：仅当 discovery 私有合法、指向自身实例目录、且其 socket `ECONNREFUSED/ENOENT`（`socketIsDead`，`src/main/local-ipc.ts:75-94`）时，才按 inode 比对后删除旧 discovery + `rm -rf` 旧实例目录(`src/main/local-ipc.ts:137-143,100-121`)；否则若 `control.v1.json` 已存在则 `ENDPOINT_EXISTS` 启动失败(`src/main/local-ipc.ts:219-224`)。新实例 `randomBytes` 生成 id/token，`wx` 独占创建(`src/main/local-ipc.ts:205-218`)。socket 路径超 103B 拒绝(`src/main/local-ipc.ts:204`)。
- **运行/关闭**：单连接单请求帧（`version/token/request` + `\n`，token 常量时间比对，`src/main/local-ipc.ts:168-190`)；`close()` 销毁 clients、关 server、按 inode 确认后删 discovery + `rm -rf` 实例目录(`src/main/local-ipc.ts:193-202,226-231`)。服务 `close()` 最后一步即 `ipc.close()`(`src/main/runtime.ts:293`)。
- **重启效果**：每次启动都是新 `instanceId` + 新目录；旧实例目录若残留且 socket 已死则被新进程清理后复用 discovery 位。`APP_NOT_RUNNING` 在 discovery 缺失/拒绝连接时由客户端判定（见 §2），`failure()` 标记 `APP_NOT_RUNNING/TIMEOUT` 可重试（仅语义标记，CLI 本身不重试，`src/main/local-ipc.ts:31-33`)。owner 启用的长 `210s` 额度仅适用于 `owners.launch/switch` 信封(`src/main/local-ipc.ts:13-26`)。

---

## 5. 若 worker 不再随停机被取消：重启时仍会断开的链路（逐条）

前提现状是 `manager.shutdown()` 必取消运行中 worker（`src/main/manager.ts:153-160`）；若改为保留 scope 存活，以下链路仍会在服务重启时断开（按恢复动作分类，均有源码依据）：

1. **任务 stdout/stderr 管道断开**：scope 的两根管道接的是旧服务进程的 fd（`src/main/adapters/cli/scope.ts:148-153`）；服务退出即 EOF/断开。`TaskManager` 的 `JsonlParser`/`stderr` 订阅者随旧进程消失；新进程的 `recoverInterruptedTasks` 根本不 re-attach，而是把 running 任务标 `failed`（`src/main/application/tasks/recovery.ts:6-9`）。不断开管道也无消费者——需新订阅机制 + parser 状态重建。
2. **进程内 `running: Map<taskId, Running>` 丢失**：`child` 句柄、`cancelled/error/result`、`firstTimer`、`killTimer` 全在内存（`src/main/manager.ts:25,75-83`）。新进程无法 `kill` 旧 scope（只能 `recoverOwnedScope` 式整 scope SIGKILL，与“保留运行”矛盾），也收不到 `close` 事件（`src/main/manager.ts:103-121` 的状态机跑在旧进程）。
3. **scope 归属证明（InvocationID）丢失**：`startOwnedScope` 用 `systemctl show` 轮询拿到的 `InvocationID` 证明“这个 scope 是我拉起的”（`src/main/adapters/cli/scope.ts:173-184`）；任务行只存 `scopeUnit` 字符串，不存 invocation（`src/main/manager.ts:209`）。重启后新进程面对同名/同 unit 的 scope 无法区分“我的 worker”与“别人同名 scope”，按现有 fail-closed 规则只能拒绝操作（`src/main/adapters/cli/scope.ts:68-74,96-99`）。
4. **Schedule claim 的 job/内存围栏丢失**：`jobs/recovering/scripts/directs` 全内存（`src/main/schedules/service.ts:69-72`）；`stop()` 语义依赖它们发 cancel（`src/main/schedules/service.ts:645-650`）。重启走 `recover()` 要求 `scopeConfirm` 成功才释放 claim，否则 claim 卡住需人工介入（`src/main/schedules/service.ts:597-614`）。“保留运行”与 `recover()` 的“确认已死才认领”直接冲突。
5. **IM host 控制 socket 断开**：host 进程连的是旧服务进程内 `createServer(endpoint)`（`src/main/im/parent-background.ts:152,185`）；服务退出 socket 文件被 `cleanupHostRecord` unlink（`src/main/im/parent-host-resources.ts:103-110`）且 host 侧 `socket.on('close', shutdown)`（`src/main/im/parent-host.ts:80`）→ host 自我关闭、引擎子进程随 cgroup 被 `stop` 回收。新服务只能按 §1-D 重建 host，会话上下文丢失。
6. **Herdr owner host 无控制通道可恢复**：服务只存了 `ownerHost` 的 id 三元组（`src/shared/contracts/tasks.ts:28`），关闭/续命全靠重启 herdr CLI；旧服务退出不影响 Herdr 侧进程，但新服务与那个 Herdr agent 之间**本来就没有**控制通道（§1-C），重启前后一致地“只能看不能管”。
7. **HelloJobs / stall CPU 采样 / quota inflight 丢失**：`HelloJobs` 纯内存（`src/main/engines/hello.ts:263-284`）；stall 的 `samples` Map 内存（`src/main/stall.ts:179`）；`QuotaProber.inflight/controllers` 内存（`src/main/quota/index.ts:44-46`）。重启后 stall 需重新积累 ≥5 分钟静默+idle 采样才判定（`src/main/stall.ts:14-16,87-96`），期间误判窗口；quota 未完成的 refresh 丢失但下次 schedule 补齐。
8. **本地 IPC discovery 轮换**：新服务生成新 `instanceId`（`src/main/local-ipc.ts:144`）；旧 `wait/watch` 客户端拿着旧 discovery/token，`readDiscovery` 读到新文件后 token 不匹配 → `UNAUTHORIZED`（`src/main/local-ipc.ts:179-182`），或连旧 socket 得 `ENOENT` → `APP_NOT_RUNNING`。无论如何**在飞的 wait 都会失败退出**（§2），需重建轮询。
9. **HTTP 长连接与 `inflight` RPC 丢失**：`http.close()` 断开浏览器/SSE（`src/main/runtime.ts:292`）；`dispatch` 的 `track()` inflight 在 close 时被等待而非迁移（`src/main/runtime.ts:122-126,288`）。重启后浏览器需重连（渲染侧 `reconnect.ts` 有退避重连，但任务流状态以新 `serverInfo.startedAt` 为准）。

## 6. 未确认项（未臆测）

- 本机 `weaver.service.d/70-feishu-im-release.conf` 与 `releases/<date>-<label>/` 产物的**生成与切换流程**（谁构建产物、谁写 drop-in、何时 `daemon-reload + restart`、如何回滚）：仓库源码无实现，属外部运维手段。仅确认消费侧（`unitValues` 回读 ExecStart，`src/cli/server/lifecycle.ts:50-67`）与现象（本机 cat 输出）。
- `weaver server stop` 对**后台 detached 进程**的 SIGTERM：经 `weaver web` 的 `runForegroundShutdown` 处理走优雅 `close`（`src/cli/commands/web.ts:88-105`），但本报告未实际执行 stop，未验证生产进程是否确实走该路径（只读约束）。
- systemd scope 在服务**异常崩溃**（非 close）后的残留：`--collect` 语义与 `KillMode=control-group` 在 Oost-父进程死亡时的行为属 systemd 侧语义，未在仓库内验证；`recoverOwnedScope` 的存在反证设计者假设 scope 可能残留（`src/main/adapters/cli/scope.ts:79-123`）。
- Herdr 侧 agent 在服务重启后是否继续运行并可被新服务复用：服务不持有 Herdr 进程句柄（§1-C），Herdr 侧生命周期不在本仓库定义范围内。
