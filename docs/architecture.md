# Weaver 当前架构

状态：当前系统事实说明，2026-10-18。本文只描述已实现组件与行为；未实现能力明确列出，不保留已撤销的 Electron/SQLite/MCP 目标叙述。命令逐项说明见 [agent-interface](agent-interface.md) 与 [README](../README.md)，引擎接入与排障见 [本地引擎运行说明](local-integration-plan.md)。

## 1. 决策与边界

Weaver 是本地任务控制面，交付三件套：

1. 公开技能 `skills/agents-weaver`（skill name `agents-weaver`，`weaver skills install` 安装）：宿主里的真实 owner agent 按它读能力、路由与包，再调 CLI 派发、验收与登记。workers 不递归，owner 不在 Weaver 之外另跑调度循环。
2. Node CLI `weaver`（`src/cli/main.ts`）：一次命令一次连接，经 Unix 域 socket 的帧 token 认证通道写入运行中的控制面；自身不打开任务文件、不持有状态、不启动 worker。
3. 前台 web 进程 `weaver web`（`src/main/runtime.ts`）：唯一写者与进程监督者，绑定 loopback HTTP（仅 `127.0.0.1`，dev 模式同源 Vite middleware）并同时开启已认证的 Unix CLI socket。二者共享同一个 `CommandHandler`（`src/main/commands.ts`）。

被撤销的旧方案（仅作历史，不是目标）：Electron 桌面、/render/preload 分层、SQLite/outbox、MCP facade、独立 owner 模型进程、多机调度。当前系统没有第二守护进程，没有隐藏的付费 owner 模型。

核心原则：

1. Owner 是真实技能宿主 agent；Weaver 只登记 logical owner（manual 元数据）或显式 `provider:"mock"` 的进程内 mock 测试宿主。登记存在不等于 AI 已启动。
2. 单写权威是运行中的 `weaver web` 进程；renderer、worker 日志、宿主屏幕文字都不是状态权威。CLI 与浏览器只是客户端。
3. `执行完成 ≠ 结果送达 ≠ owner 已 ack ≠ owner 已验收`。执行终态需要 vendor 真实成功 final + 零退出。
4. 能力探测只证明安装与版本；enable 与角色配置分离；未知即明确报告，不假称可用。
5. mock 是显式测试 provider；真实引擎失败/launcher 缺失/引擎不支持都失败，不回退 mock、Claude Code 或其他引擎。

## 2. 组件与进程生命周期

```text
宿主 agent + agents-weaver ─┐
                            ├─┤ weaver CLI（Unix socket，weaver.v1 帧）
浏览器 Web UI (React) ────┘ ─ POST /api/rpc（loopback HTTP，同一 handler）
                 │
        weaver web 进程（唯一写者）
          ├─ CommandHandler ─ 命令校验/幂等收据/调度 pump
          ├─ TaskManager ─ worker 子进程监督（SIGTERM→1.5s SIGKILL）
          │    ├─ MockWorkerAdapter（显式 mock-jsonl，bundled scripts/mock-worker.mjs）
          │    └─ RoutingWorkerAdapter → startCliAgent（src/main/adapters/cli）真实四引擎
          ├─ PolicyStore（policy.v1.json）+ 纯路由 policy/routing.ts
          ├─ TaskStore（tasks.v1.json，fsync+rename 原子替换）
          ├─ engines/{probe,control}.ts（PATH+--version 只读探测）
          ├─ quota/（原生凭据只读 + 固定 HTTPS GET，进程内额度观测）
          ├─ policy/quota.ts（新鲜账户观测 → 自有 policy.blocks 原子合并）
          └─ ContinuationService（src/main/continuation.ts，owner 手动上下文）
```

进程语义：`weaver web` 前台单实例；端口被占返回 `EADDRINUSE`；`--data-dir` 决定默认 endpoint/state 目录。Ctrl+C/SIGTERM → draining → 中止在途额度探测 → 等待未响应请求完成 → `manager.shutdown()` 逐个取消本进程拥有的 running 任务并等待子进程退出 → 关闭 HTTP/socket → 退出。draining 后完成的额度请求不再保存策略。任务与策略文件保留。关闭浏览器页不停任务。客户端断开不取消已提交的工作。

## 3. 单写权威与存储

JSON 双文件即全部持久状态：

- `tasks.v1.json`：任务（含 events/artifacts/run/摘要）、owners 元数据、frozen packages、命令收据 revisions；原子快照 revision 单调递增。上限 32 MiB、200 tasks、200 owners、1000 packages、5000 receipts、每任务 500 events、每任务 20 artifacts（内容 ≤32,000 字符）。
- `policy.v1.json`：验证过的 policy 配置 + quota blocks；上限 256 KiB、500 blocks；revision 乐观锁，保存整文档替换。

额度观测不增加持久文件：`QuotaProber` 只读原生认证并通过三个固定非公开 HTTPS GET 获取数据，观测在内存保鲜 5 分钟、每 provider 请求间隔至少 60 秒；`quota get` 无网络，`quota refresh` 显式触发探测与自有 blocks 合并。`QuotaScheduler` 每分钟按已保存的 `quota.auto_refresh` / `quota.interval_minutes`（缺省开启、15 分钟，5–1440）检查一次，到期后对已启用且 `quota_refresh` 生效的引擎所属 kind 走同一探测与合并路径；进程启动后首轮至少等一个检查周期。`policy.blocks` 仍是唯一持久阻断来源；人工来源不被自动覆盖，遇到妨碍施加自动阻断的过期 foreign 唯一 key 返回原子冲突。请求/认证边界及错误语义见 [额度接口](agent-interface.md#31-原生账户额度)。

写入模型均在 fsync + rename 原子替换内完成（`src/main/store.ts`），无 directory fsync；中断的写命令先以 durable intent（receipt 写入）暴露为 `COMMAND_INDETERMINATE`，要求用 `operations.get` 查收据并核对现状，不做自动重放。命令收据键为 `local-demo:<commandId>`，同键同参返回原响应、同键不同参拒绝 `IDEMPOTENCY_CONFLICT`。这不是 exactly-once 外部执行保证，也没有事务 outbox。

同步面只有拉取：`sync.status`（revision 比对）、`sync.snapshot`（受界摘要）、`tasks.events`（保留事件 ID 游标，过期 `CURSOR_EXPIRED`）。renderer 失效通知只表示"revision 变了"，不是持久 push 流。

## 4. 调度与准入（policy/routing.ts）

路由基于 policy 配置（`engines`/`owners`/`workers`/`herdr` + `blocks`）：

- `resolveDispatch` 只按权重：owner.workers 中权重最高且可用（worker 启用、引擎启用、无生效 block）的 worker 胜出；同权重按 owner.workers 声明顺序。
- `worker_weights`：整数 0..1000，缺省 100；0 直接排除该 worker，显式 worker 指定也不能绕过权重 0。
- 配额 block 按引擎/model 精确匹配，绝对时间戳 `release_at` 只有明确恢复时间才自动到期，其余手动解除。
- 准入与派发同一 resolve 函数：`policy preview` 只读（`dispatch:"preview"`、`execution:"disabled"`）不执行；`workers.spawn` 实际校验 workspace/provider/容量后按结果 start 或入队。
- 并发按 owner 的 `max_parallel`；报告总数是 enabled owner 的 `max_parallel` 之和，没有独立全局上限。超时来自 `herdr.max_wait_minutes`（1-1440），没有 60 秒默认值。

队列与冻结：

- `workers.spawn` 通过预检后把当时选出的 owner/worker/engine/kind/model/effort/execution/adapter/workspace 冻结进 `task.dispatch`；排队槽只是等待容量。
- worker 与 owner 同引擎时 `execution:"native"`、adapter `native`：不启动进程，任务进入 running 并占用 owner 槽位，由 owner 用宿主内置子代理工具执行后调用 `workers.complete` 回报；取消直接转 cancelled，重启恢复时保持 running。
- pump 复核当前资格/容量/配额/pin/workspace：route 改变（含 kind 不符）、容量不足、workspace 失效或 launch 失败都会给 `task.queueReason`（有界 message，仅变化落盘），代码取 `waiting_for_capacity/policy_blocked/frozen_route_changed/workspace_changed/launch_blocked`。冻结路由不会被默默改派或跨引擎替换。
- 取消：queued 直接转 cancelled；running 先 `cancelling` 再等待本进程拥有的 worker 子进程退出（SIGTERM → 1.5s SIGKILL）。取消/文件损坏不删除已有 history 与事件。

## 5. 真实 worker 执行（src/main/adapters/cli）

launcher 组合（`startCliAgent`）：`RealEngineKind = 'opencode'|'pi'|'grok'|'codex'`。固定可执行名+固定 argv 组装（`adapters/cli/argv.ts`），`shell:false`，workspace 必须是已存在的绝对路径，启动前核验并随 dispatch 冻结 `workspaceIdentity`。认证使用各引擎自身的本机配置（settings/auth 文件），Weaver 不复制、不打印、不把它写进 argv/日志/请求包。

- 指令传递走 stdin 或私有 prompt 文件优先，不在 argv 放长 prompt。state 目录是 app 拥有的 `agent-state` 下私有 job 目录，不是凭据目录。
- 输出 streams 解析为普通 WorkerRecord JSONL（log/progress/artifact/result/final），stderr 脱敏有界；provider 自报的 session/model/usage 是可选 `evidence`，未知保持未知，没有捏造的模型验证。
- 终态条件：vendor terminal success + final assistant text + 零退出才写 `completed`；missing/truncated/非零退出都失败。产物抓取为有界 `result.md`/结构化 artifact，内容当纯文本数据，不当可执行 HTML。
- 请求的真实引擎/model/effort、adapter、workspace、scopeUnit 和 observed evidence 都记录在 `run` 与 observability 里；mock 显式记录 `execution:'mock'`。没有静默回退：CC 报 `CAPABILITY_UNAVAILABLE`（deferred），unknown kind 同拒，launcher 未加载同拒。
- 生命周期收尾只清理本 launch 拥有的进程；Linux/systemd host 上每个真实 launch 使用唯一命名 user scope，取消/超时/完成前先关闭自身 scope。没有共享 leader/daemon。

真实执行的 timeout 只来自配置的 `herdr.max_wait_minutes`；直接单测的 mock adapter 允许更短的测试等待，不改变真实 runtime 的这一语义。

## 6. Owner 手动上下文与结果（ContinuationService）

- `owners.attach` 与 `owners.spawn`（缺省，无 provider）都登记 manual logical owner：名字/profile + 调用方可选 session/pane 标签（`external-cli`/`unverified`），`verified:false`、`ownerModelSpawned:false`。这些是元数据接续，没有进程被创建、没有宿主被联系。显式 `provider:"mock"` 保留进程内 mock 宿主测试路径。
- `owners.switch`（需 expectedRevision,可选 expectedEpoch/reason/profileId）在 mock 宿主上做原子握手；manual 分支在 quiescent + revision/epoch 校验后组装有界 `contextPack`（≤32 KiB，不含 artifact 正文与全量 transcript），创建 manual replacement registration（`host.attach`，ownsHost=false/verified=false），原子更新任务 owner binding/epoch/history/pack，返回 pack。这个交接包是纯元数据：`acknowledgementId` 为 `null`，pack limitations 写明"external owner 必须自行读取 pack；真实宿主切换由 CLI 承担；Weaver 没有自动投递/确认"。
- manual 空闲到期只把任务标记 due 并提示技能发起手动接续；mock-only 的 prepareOwnerActivity 自动轮换保留在 mock 路径里。
- 结果流：manual owner 自己 `tasks.results` 拉 manifest（含 artifact sha256 与 `manifestDigest`）→ 独立查文件/跑测试 → `results.ack`（expectedRevision + 当前 digest；ack 后 delivery=acknowledged，验收不变）→ `reviews.submit`（同 digest + expectedRevision,decision accepted/rejected）更新 `acceptance`。`results.deliver` 对 manual owner 显式 `CAPABILITY_UNAVAILABLE`，不伪造外部投递。

## 7. 引擎目录与探测

固定 catalog（`src/shared/engines.ts`）：claude/codex/grok/opencode/pi/qoder/gemini 七个 id，kind 分别 claude/codex/grok/opencode/pi/qodercli/gemini。探测只做 PATH 可执行文件 + 带超时 `--version`（shell:false、ANSI 去除、4s 超时、进程组收尾）；结果永远 `authenticated:false`、`modelUsable:false`。启用权威是 PolicyStore `engines[id].enabled`（`engines set-enabled` 需 installed 探测 + revision）；启用引擎不会创建任何角色。adapter 状态分 `real`（opencode/pi/grok/codex）、`deferred`（claude）、`not_implemented`（qodercli/gemini）；`realExecution` = 启用且启用 worker 使用该引擎且 launcher 已加载，探测≠可用。

真实执行适配（`src/main/adapters/cli/argv.ts` + `normalize.ts`）覆盖 opencode、pi、grok、codex、qodercli。qodercli 以 `-p -o stream-json` 从 stdin 读任务，`--permission-mode bypass_permissions`（CLI 策略，不是 OS 隔离），`--setting-sources ""` 与 `--strict-mcp-config` 跳过用户级 hooks、插件与 MCP，`--no-session-persistence` 不落会话；输出按 Claude Code 风格的 system/assistant/result 事件归一化。claude 与 gemini 仍无执行适配。

## 8. 已知限制（不是未来路线）

- 没有按 owner 的认证/对象级权限；本地凭据是 trusted-user 级（`capabilities.authentication` 声明）。
- 定时额度刷新只按固定间隔探测并同步自有阻断，不做失败重试；超额失败按 provider 错误如实报告，不自动换引擎或模型。
- 本地控制面只面向 Linux/Unix：`weaver web` 先启动 Unix CLI socket 再启动 HTTP（`src/main/runtime.ts`），而 `startLocalIPC` 在 win32 直接 `UNSUPPORTED_PLATFORM`（`src/main/local-ipc.ts`），因此 web 控制面在原生 Windows 不能启动。真实受管 worker 还依赖 Linux systemd user scope。不声称原生 Windows 支持，也不再描述未验证的远程访问形态。
- 没有 retention/archival UI、迁移导入工具、SQLite/outbox/事件总线、全局持久事件流。
- 没有 worker 递归与多 owner 交叉指挥；一个任务一个 owner，owner 间协作回到技能宿主的可见会话。
- 本机实测宿主/版本证据以 `docs/verification/**` 与 [VERIFICATION.md](../VERIFICATION.md) 为准；本文不声称最终验收。

## 9. 来源与出处

沿用 skill-foundry 上游 provenance（Apache-2.0）：上游仓库 [MarioJames/skill-foundry](https://github.com/MarioJames/skill-foundry/tree/61989b11a5d0565d2a6630833e64a2d73769a947/skills/agents-cooperation)，`scripts/agents-config.ts` 与 `scripts/lib/json-schema.ts` 迁入 `src/main/policy/*`，详见 [script-migration](script-migration.md)。Weaver 自有扩产（权重/pin/真实 launcher/CLI 面等）是本仓库独立实现。公开技能见 [skills/weaver/SKILL.md](../skills/weaver/SKILL.md) 与 [provenance](../skills/weaver/references/provenance.md)。
