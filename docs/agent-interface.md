# Weaver v1 接口文档

状态：已实现接口事实说明，2026-10-18。本文只描述 `weaver.v1` 当前命令面，与 `src/cli/main.ts` 的 `CLI_CATALOG` 逐一对应；每条命令的参数以 `weaver --help` 输出与真实代码为准。未实现的接口不描述为可调用。旧 MCP facade 与 Electron 双入口叙述已撤销：接口 = 一个 `weaver` CLI + 浏览器 loopback HTTP，二者调用同一 handler。

组件背景见 [architecture](architecture.md)；命令流程与验收见 [README](../README.md)。

## 1. 调用与信封

CLI 与浏览器都是客户端，共享同一 `CommandHandler` 与同一 `weaver.v1` 契约，没有第二套状态或调度器：

- CLI：`weaver <command> …` → Unix 域 socket（token 帧、每请求 ≤1 MiB、15 秒等待）。
- 浏览器：`POST /api/rpc`（仅 loopback `127.0.0.1`）；逻辑命令与方法白名单共享。
- 全部请求/响应用 `apiVersion:"weaver.v1"`；请求体 ≤128 KiB；未知命令 `COMMAND_UNKNOWN` 拒绝。
- App 未运行报 `APP_NOT_RUNNING`（提示 `weaver web --no-open`）；启动中 `APP_STARTING`；退出中 `APP_DRAINING`。CLI 退出只结束自己的等待，不取消已提交的任务。

逻辑命令信封：

```json
{
  "apiVersion": "weaver.v1",
  "commandId": "unique-stable-key",
  "command": "tasks.create",
  "args": { }
}
```

CLI 直接用 `--input <file|->` 传 JSON（args 对象或完整信封均可；文件 ≤1 MiB，须为普通 JSON 文件）。`--task-id <id>` 校验并注入 `args.taskId`；`--command-id <id>` 校验并填 commandId，未给时自动 `randomUUID()`。控制面校验 command/args 均来自该信封，不接受 shell 命令、宿主 session/pane 定位或任意可执行路径作为输入。

## 2. CLI 解析与输出

- 命令名按已知目录解析（`engines set-enabled` 保留连字符）；`capabilities` 是 `capabilities.get` 的显式别名；嵌套动词为三词 `owners continuation get`，也可用带点合并形式 `owners.continuation get` 或全名单词形式 `owners.continuation.get`，均解析到同一目录命令。
- 输出格式 `--output json|jsonl|text`，缺省 `json`：成功写一个完整 weaver.v1 信封。`jsonl` 每行一个 JSON 对象。`text` 是人性短行，不承诺机器稳定，agent 请用 json/jsonl。`--json` 是 `--output json` 别名，与 `--output` 组合一律拒绝。
- 错误同格式：`{ok:false,error:{code,message,retryable}}`，无 stack；CLI 退出码 0=成功、1=否则。stdout 无额外闲聊；`weaver web` 缺省打印一行 URL，可用 `--output`/`--json` 转 JSON 就绪信封。
- `--help` 列举目录，`weaver web --help` 单列 web 选项。

## 3. 命令目录

读取（15）与写入（12）共 27 条逻辑命令，如下表；另有 `policy`/`engines` 六个 method-wrapped RPC 动词与 CLI 本地 `tasks wait/watch`。写入命令必须带 commandId。

| 命令 | CLI 输入要点 |
|---|---|
| `capabilities.get` | 无参；返回全部命令名、limits、`realExecution`、`workerProviders`、`authentication:'ephemeral-local-trusted-user-demo'`、`mcp:false` 等 |
| `sync.snapshot` | 无参；revision + 各任务摘要 + owner 概要 |
| `sync.status` | 可选 `{after}`；返回 revision 是否变化，明示非持久事件流 |
| `owners.list` | 无参 |
| `owners.get` | `{ownerId}` |
| `owners.continuation.get` | `{taskId}`（或 `--task-id`） |
| `owners.continuation.configure` | `{expectedRevision, idleRotationMinutes}`：整数，或 `null`（关闭），1–10080 分钟 |
| `owners.attach` | `{name, profileId, session?, pane?}`；纯元数据登记，`verified:false`，不联系宿主 |
| `owners.spawn` | `{name, profileId}`；缺省也是 manual 逻辑登记，不启动宿主；显式 `provider:"mock"` 保留进程内测试宿主 |
| `owners.switch` | `{expectedRevision(必填), expectedEpoch?, reason? 'manual'/'idle', profileId?}`；mock 宿主原子握手；manual 分支生成接续包 |
| `tasks.create` | `{title, instruction或goal, ownerProfileId或ownerId(+ownerName/ownerProvider), workspace?, acceptanceCriteria?, constraints?}`；≤30 条明细；省略 workspace 时 CLI 用调用方 cwd 补，显式相对路径相对调用方解析；服务端不用自己的 repo 填空 |
| `tasks.get` / `tasks.list` / `tasks.events` | get `{taskId}`；list `{offset,limit?,ownerId?}`（≤100/页）；events `{limit?1-100, after?}`，游标过期 `CURSOR_EXPIRED` |
| `tasks.retry` | `{taskId}`；仅终态；新任务带 `retryOf` 链接 |
| `tasks.cancel` | `{taskId, expectedRevision?}`；终态返回 `alreadyTerminal:true` |
| `tasks.results` | `{taskId}`；非终态 `RESULT_NOT_READY`；manifest 含 artifact sha256 与 `manifestDigest` |
| `artifacts.read` | `{taskId, artifactId}`；内容 ≤32,000 字符 |
| `packages.create` | `{scope, acceptanceCriteria}`（task 由 `--task-id` 给出，可选 `expectedRevision`）；scope/明细各 1–30 条 |
| `packages.get` | `{packageId}` |
| `workers.spawn` | 可选 `{worker 或 class('routine'缺省/judgment/mechanical 类由 policy 定), tag?, owner?, provider?('mock-jsonl'才合法), packageId?, expectedRevision?}`；排队时 `scheduled:true` 且路由已冻结；显式 provider 非 mock 直接拒绝 |
| `results.deliver` | `{taskId}`；manual owner 显式 `CAPABILITY_UNAVAILABLE`，只有 mock owner 有投递 |
| `results.ack` | `{expectedRevision(必), manifestDigest(当前)}`；ack ≠ 验收 |
| `reviews.submit` | `{expectedRevision(必), manifestDigest, decision:'accepted'/'rejected', comment?≤4000}`；仅 completed |
| `operations.get` | `{commandId}` |
| `observability.get` / `observability.export` | `{taskId, kind?}`；export 返回 JSON 文本形式的完整 trace |

六个 RPC 动词：`policy get`（无参，即 `weaver policy get`）、`policy validate --input`（config 文档本体，≤256 KiB，返回 issue 数组，空即通过）、`policy save --input`（`{revision,config,blocks}`，revision 乐观锁，返回新 snapshot）、`policy preview --input`（`{owner, worker?/class?, tag?, runningCount}`）、`engines scan`（无参）、`engines set-enabled --input`（`{id,enabled,revision}`）。这些命令不接受 `--command-id`/`--task-id`；`policy save` 与 `engines set-enabled` 只提交 usage 里给出的 JSON。

本地 wait/watch：`tasks wait --task-id` / `tasks watch --task-id`，`--for` 1–600 秒（缺省 30）；轮询 `tasks get`（watch 另加 `tasks events` 增量），不是第二调度器；超时按 `TIMEOUT` 失败退出，退出不取消任务。

## 4. 幂等、续传与修订

- 写命令携带稳定 commandId；同键同参返回原收据，同键不同参 `IDEMPOTENCY_CONFLICT`；受影响但收据未持久返回 `COMMAND_INDETERMINATE`。未知/损坏回复先 `operations get --command-id <id>` 查收据再决定，不换新 ID 盲重试。
- 修改型命令带 `expectedRevision`（当前聚合 revision）；过期写返回 `REVISION_CONFLICT` 附当前 revision。`results.ack`/`reviews.submit` 还必须等待当前 `manifestDigest`，否则 `MANIFEST_MISMATCH`。
- 收据持久保存于 tasks.v1.json，`operations.get` 重启后仍可读；上限 5000 条。

## 5. 真实生命周期示例

说明：`<taskId>`、`<digest>` 等占位来自命令真实响应中的字段，本文不虚构具体 UUID 或 digest。空行之间是同一任务的连续步骤；每条 mutation 用稳定 commandId 便于幂等。

```sh
weaver tasks create --input task.json --command-id create-001
# → data.{id, workspace, ownerId, continuationPolicy{idleRotationMinutes:60}}（ownerProfileId 登记时自动绑定）

weaver packages create --task-id <taskId> --input package.json --command-id package-001
# → data.{id, revision:1, scope, acceptanceCriteria, instruction}（包冻结）

weaver workers spawn --task-id <taskId> --input dispatch.json --command-id spawn-001
# → data.dispatch.{owner,worker,engine,model,effort,execution,workspace,...}；
#   容量满时 data.scheduled=true + queueReason{code:'waiting_for_capacity'}

weaver tasks wait --task-id <taskId> --for 300
# → 轮询至终态；300 秒内未结束返回 TIMEOUT（任务仍在继续，未被取消）

weaver tasks results --task-id <taskId>
# → data.{artifacts:[{id,sha256,...}], manifestDigest, delivery, acceptance}

weaver artifacts read --task-id <taskId> --input read.json
# read.json: {"artifactId":"<id from tasks results>"}
# → data.content（≤32,000 字符；完整文件用任务 workspace 内真实文件复核）
```

```json
task.json
{
  "title": "Add retry unit test",
  "instruction": "Add a bounded test covering flake reproduction and result-only-on-zero-exit.",
  "ownerProfileId": "codex_owner",
  "workspace": "/home/you/your-repo",
  "acceptanceCriteria": ["suite passes locally", "revision kept minimal"]
}

package.json
{ "scope": ["tests/", "src/cmd-name.ts"], "acceptanceCriteria": ["change compiles"] }

dispatch.json
{ "class": "judgment" }

ack.json
{ "expectedRevision": <ack 前从 tasks get / tasks results 读取的当前 revision>, "manifestDigest": "<digest>" }

review.json
{ "expectedRevision": <ack 后重新读取的当前 revision；ack 本身会使任务 revision +1>, "manifestDigest": "<digest>", "decision": "accepted", "comment": "本地复验通过" }
```

外部 owner 接续与验收：

```sh
weaver owners continuation get --task-id <taskId>
# → data.{history:[...], contextPack:{..., limitations:[...]}}（manual 接续包，其 acknowledgementId 为 null；mock 宿主握手才有真实 ack；
#   接续宿主切换由真实 CLI 完成，Weaver 不自动投递，也不会为接续包伪造确认）

weaver owners continuation configure --task-id <taskId> --input cfg.json --command-id keep-001
# cfg.json: {"expectedRevision":2,"idleRotationMinutes":90}（null=关闭；1–10080 分钟）

weaver results ack --task-id <taskId> --input ack.json --command-id ack-001
# → data.delivery 变为 acknowledged；acceptance 保持 pending（ack 不等于验收）

weaver reviews submit --task-id <taskId> --input review.json --command-id review-001
# → data.acceptance 变为 accepted/rejected并把 reviewComment 记录进任务事件
```

## 6. 能力声明

`capabilities.get` 返回了接口全部事实：`workerProviders: ["mock-jsonl","opencode","pi","grok","codex"]`（真实 launcher 加载后）或 `["mock-jsonl"]`；`realExecution` 是布尔；`mcp:false`；`ownerSpawn:'logical-registration'`、`manualAttach:'metadata-only'`、`ownerModelSpawned:false`、`attachmentVerified:false`；`authentication:'ephemeral-local-trusted-user-demo'`、`ownerScopedAuthorization:false`。这些字段精确描述本进程现状，不应做更乐观的解释。

## 7. 本地传输与错误

- 当前本地控制面只面向 Linux/Unix：`weaver web` 启动顺序是先起 Unix socket 服务再起 HTTP（`src/main/runtime.ts`），而 `startLocalIPC` 在 win32 直接抛 `UNSUPPORTED_PLATFORM`（`src/main/local-ipc.ts`），所以原生 Windows 上整个 web 控制面起不来，HTTP 面不单独可用。真实受管 worker 依赖 Linux systemd user scope。
- token/frame 控制文件在 `<dataDir>/control-<instanceId>/`（用户目录受限），损坏或 stale 的 discovery 文件安全拒绝（`UNSAFE_ENDPOINT`），不能被另一进程伪造这样一套端点。
- HTTP 错误码映射 `INVALID_HOST/INVALID_ORIGIN` 等有校验；body 中仅 method+args 的白名单 method 可调用，无反射分发。
