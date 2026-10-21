# Weaver v1 接口文档

状态：已实现接口事实说明，2026-10-19。本文只描述 `weaver.v1` 当前命令面，与 `src/cli/main.ts` 的 `CLI_CATALOG` 逐一对应；每条命令的参数以 `weaver --help` 输出与真实代码为准，本文不复制命令条数——目录本身可发现，数量随实现变化。旧 MCP facade 与 Electron 双入口叙述已撤销：接口 = 一个 `weaver` CLI + 浏览器 loopback HTTP，二者调用同一 handler。

组件背景见 [architecture](architecture.md)；命令流程与验收见 [README](../README.md)。

## 1. 调用与信封

CLI 与浏览器都是客户端，共享同一 `CommandHandler` 与同一 `weaver.v1` 契约，没有第二套状态或调度器：

- CLI：`weaver <command> …` → Unix 域 socket（token 帧、每请求 ≤1 MiB；普通请求 15 秒等待，已验证的显式 owner 启动请求 210 秒，见第 7 节）。
- 浏览器：`POST /api/rpc`（仅 loopback `127.0.0.1`）；逻辑命令与方法白名单共享。
- 全部请求/响应用 `apiVersion:"weaver.v1"`；请求体 ≤128 KiB；未知命令 `COMMAND_UNKNOWN` 拒绝。
- App 未运行报 `APP_NOT_RUNNING`（提示 `weaver server start`）；启动中 `APP_STARTING`；退出中 `APP_DRAINING`。CLI 退出只结束自己的等待，不取消已提交的任务。

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

三个贯穿命令面的约定：

- **commandId 是幂等键**，不是参数的一部分：写命令带稳定 commandId，同键同参重发拿回同一张收据（幂等与收据语义见第 4 节）。一次会话内为同一意图复用同一个 `--command-id`，回复丢失时先 `weaver operations get --command-id <id>`，不要换新 ID 盲重试。
- **expectedRevision 是乐观锁**：任务级修改命令读到的 `revision` 写回时必须还是那个值，否则 `REVISION_CONFLICT` 附当前 revision。它与 commandId 作用不同，不能互相替代。
- **`next` 是派发后 父 Agent 唯一要做的一步**：`workers.spawn` 在响应里给出 `next`，运行中的 native 任务 `tasks.get` 会重新给出同一个 `next`，`tasks.retry` 自动派发也返回同一形状。非 native 的执行（real/mock）和尚未拿到容量的排队任务给 `{action:'wait', command:'weaver tasks wait --task-id <id>'}`；native 派发（子 Agent 就是 父 Agent 自己引擎的内建子代理）给 `{action:'run_subagent', model, effort, prompt, then}`，其中 `prompt` 与真实 子 Agent 收到的执行说明逐字相同，做完后用 `then` 那条 `workers.complete` 命令回报。父 Agent 不需要理解引擎、适配器或权重，照 `next` 执行即可；`next` 缺失只表示还没有派发结论，不表示失败。

## 2. CLI 解析与输出

- 命令名按已知目录解析（`engines set-enabled` 保留连字符）；`capabilities` 是 `capabilities.get` 的显式别名；嵌套动词为三词 `owners continuation get`，也可用带点合并形式 `owners.continuation get` 或全名单词形式 `owners.continuation.get`，均解析到同一目录命令。
- 开关按命令收窄，不是一套全局参数：`--engine <id>` 只属于 `engines penalty` 与 `engines unblock`；`--cancel` 是无值开关，只属于 `tasks retry`；`--for <seconds>` 只属于本地 `tasks wait`/`tasks watch`，这两条也不接受 `--input`。用在别的命令上、重复给、缺值，或 `--input` 体里已经带了不同的同一个字段，都在发出请求前以 `INVALID_ARGUMENT` 拒绝（`Input engine does not match CLI engine` 等）。CLI 只把它们映射进请求 args——取消、复制包、派发都由服务端决定，CLI 自己不做。
- 输出格式 `--output json|jsonl|text`，缺省 `json`：成功写一个完整 weaver.v1 信封。`jsonl` 每行一个 JSON 对象。`text` 是人性输出，不承诺机器稳定，agent 请用 json/jsonl；派发/重试含 wait 命令，native 则完整打印 model、effort、prompt 与 then，不能只按任务状态猜下一步。`--json` 是 `--output json` 别名，与 `--output` 组合一律拒绝。
- 错误同格式：`{ok:false,error:{code,message,retryable}}`，无 stack；CLI 退出码 0=成功、1=否则。stdout 无额外闲聊；`weaver web` 缺省打印一行 URL，可用 `--output`/`--json` 转 JSON 就绪信封。
- `--help` 列举目录，`weaver web --help` 单列 web 选项。`weaver --help --output json` 返回机器可读的 `data.catalog`；命令级帮助（例如 `weaver quota refresh --help --output json`）提供 `command`、`mutation`、`rpc`、`usage`、`inputFields`，无需运行中的控制面。

## 3. 命令目录

命令面分两层：**逻辑命令**走 `weaver.v1` 信封（写命令必须带 commandId），以及 `policy`/`engines`/`quota` 下直接提交 usage 所示 JSON 对象的 **method-wrapped RPC 动词**（不接收 command/task ID）。完整清单以 `weaver --help` 为准，机器可读形式是 `weaver --help --output json` 的 `data.catalog`（每条含 `command`/`mutation`/`rpc`/`usage`/`inputFields`）；本文不复制条数，因为目录会随实现增长，而 `capabilities.get` 的 `commands` 数组只列逻辑命令，两个口径不要混同。本地 `tasks wait`/`tasks watch` 在目录里标为 local，不连控制面。

`weaver skills install [--agent claude-code,codex] [--dir <root>] [--link] [--force]` 是不进命令目录、不连控制面的本地命令：把可执行文件携带的 `agents-weaver` 技能装到 `~/.agents/skills/agents-weaver`，并从 `~/.claude/skills`、`~/.codex/skills` 链接过去；只更新自己装的副本，路径上已有别的技能或链接时拒绝覆盖（`--force` 例外）。

| 命令 | CLI 输入要点 |
|---|---|
| `capabilities.get` | 无参；返回 `commands`（仅逻辑命令名）、limits、`realExecution`、`workerProviders`、`capacity`、`maxParallel`、`ownerSpawn`（Herdr 在 PATH 上可为 `'herdr'`）、`authentication:'ephemeral-local-trusted-user-demo'`、`mcp:false` 等；`sayHi`/`sayHiResult`/`getStall` 是只给网页的 RPC，不在逻辑命令面 |
| `sync.snapshot` | 无参；revision + 各任务摘要 + owner 概要 |
| `sync.status` | 可选 `{after}`；返回 revision 是否变化，明示非持久事件流 |
| `owners.list` | 无参；每个实例附 `runningTaskCount`——该实例当前占用的 running+cancelling 任务数，与容量准入用的是同一个数 |
| `owners.get` | `{ownerId}`；同一条实例记录加 `runningTaskCount` |
| `owners.continuation.get` | `{taskId}`（或 `--task-id`） |
| `owners.continuation.configure` | `{expectedRevision, idleRotationMinutes}`：整数，或 `null`（关闭），1–10080 分钟 |
| `owners.attach` | `{name, profileId, session?, pane?, title?}`；纯元数据登记，`verified:false`，不联系宿主也不起进程。`profileId`+`name`+`session` 三元组就是实例身份：同键同参重发（换一个 commandId 也一样）返回那同一个已登记实例而不再建一行；`pane` 只留档、不参与身份。缺省 `session` 补 `'external-cli'`、缺省 `pane` 补 `'unverified'`，补全后的值才参与判断，所以两次都省略 session 仍是同一实例。会话标签持久保存在 `session` 字段，早于该字段的旧记录仍从 `host.session` 取到（见下方两层身份）。可选 `title`（1–120 字符）是该实例当前主任务的看板标题：重复 attach 带 `title` 则更新、省略则保留原值 |
| `owners.spawn` | `{name, profileId}`；缺省也是 manual 逻辑登记，不启动宿主；显式 `provider:"mock"` 保留进程内测试宿主 |
| `owners.describe` | `{ownerId, title}`；只更新该实例的看板 `title`（1–120 字符，去首尾空白），返回更新后的实例（含 `runningTaskCount`）；host、session、state 不动。未知 `ownerId` 返回与 `owners.get` 相同的 `NOT_FOUND`；title 非法返回 `INVALID_REQUEST` 并指明 `title`；同 command-id 重放返回原回执 |
| `owners.switch` | `{expectedRevision(必填), expectedEpoch?, reason? 'manual'/'idle', profileId?, launch?}`；轮换 父 Agent 并生成接续包，响应含 `contextPack` 与 `prompt`（脱敏、≤6000 字符的接手说明）。mock 宿主原子握手；manual 分支只生成接续包。`launch:true` 是显式追加的一步：轮换提交之后再去 Herdr 默认会话拉起新宿主，失败也只回 `launch:{ok:false,code,message}`，已生效的轮换不回滚 |
| `owners.launch` | `{taskId, expectedRevision(必填，写在 JSON 体里)}`；对**已有**接续包再拉起一次宿主，不重复轮换。返回 `{taskId, prompt, launch, task}`，`launch` 为 `{ok:true, ownerHost}` 或 `{ok:false, code, message}`（`OWNER_LAUNCH_FAILED`/`OWNER_LAUNCH_UNAVAILABLE`/`OWNER_LAUNCH_UNSUPPORTED`）。细节见下方「拉起 父 Agent 宿主」 |
| `tasks.create` | `{title, instruction或goal, ownerProfileId或ownerId(+ownerName/ownerProvider), workspace?, acceptanceCriteria?, constraints?}`；≤30 条明细；省略 workspace 时 CLI 用调用方 cwd 补，显式相对路径相对调用方解析；服务端不用自己的 repo 填空 |
| `tasks.get` / `tasks.list` / `tasks.events` | get `{taskId}`，对**运行中的 native 任务**另附 `next`（spawn 回复丢了也从这里取回同一条子代理说明与收尾命令）；list `{offset,limit?,ownerId?}`（≤100/页）；events `{limit?1-100, after?}`，游标过期 `CURSOR_EXPIRED` |
| `tasks.retry` | `{taskId, cancel?, expectedRevision?}`：接续重跑并自动派发的一步式命令，见下方「接续重跑」 |
| `tasks.cancel` | `{taskId, expectedRevision?}`；终态返回 `alreadyTerminal:true` |
| `tasks.health` | `{taskId}`；首个输出前为 `starting`，已结束任务为 `state:'ended'` 并带最终 `taskStatus`；只读该任务在监控器样本下的判定，见 [3.3 卡住健康与引擎惩罚命令](#33-卡住健康与引擎惩罚命令) |
| `tasks.results` | `{taskId}`；非终态 `RESULT_NOT_READY`；manifest 含 artifact sha256 与 `manifestDigest` |
| `artifacts.read` | `{taskId, artifactId}`；内容 ≤32,000 字符 |
| `packages.create` | `{scope, acceptanceCriteria?}`（task 由 `--task-id` 给出，可选 `expectedRevision`）；scope/明细各 1–30 条。省略 `acceptanceCriteria` 时取该子任务自身的标准；显式给出时以工作包为准，且不回写覆盖任务。工作包是子 Agent 目标与验收标准的唯一来源：`workerInstruction` 与 native `next.prompt` 只含 pkg.instruction、scope、constraints 与包内标准，不附带根任务的目标或标准 |
| `packages.get` | `{packageId}` |
| `workers.spawn` | 可选 `{worker?, owner?, provider?('mock-jsonl'才合法), packageId?, expectedRevision?}`；省略 `worker` 时在 owner 可用且权重非 0（权重整数 0..10，缺省 5）的 worker 里选全局负载最低的一个：比较 `(running+cancelling+1)/weight`，平手取权重高者，再平手按策略列表顺序，其中 `running+cancelling` 是跨全部 owner 的全局计数。容量按 owner **实例**的 `max_parallel` 准入；拿不到槽位时 `scheduled:true` + `queueReason{code:'waiting_for_capacity'}` 且路由已冻结。真实 子 Agent 首个有效供应商输出后才算启动；spawn/retry 在请求总计 8 秒的预算内等待并返回 `started`，尚无输出时为 false，120 秒无有效输出以 `no_output` 失败；供应商限流/额度错误立即失败，`task.failure` 含 `kind`、`message`，以及有证据时的 `stderrTail`、`vendorError`、`retryAt`。响应除任务快照外还附 `next`（父 Agent 要做的那一步）与 `excludedEngines`（本次被重试链排除的引擎，非空才出现）；显式 provider 非 mock 直接拒绝 |
| `workers.complete` | `{taskId, expectedRevision?, outcome:'completed'/'failed', summary≤8000, artifacts?≤20}`；只接受运行中的 native 任务，且只接受一次 |
| `results.deliver` | `{taskId}`；manual owner 显式 `CAPABILITY_UNAVAILABLE`，只有 mock owner 有投递 |
| `results.ack` | `{expectedRevision(必), manifestDigest(当前)}`；ack ≠ 验收 |
| `reviews.submit` | `{expectedRevision(必), manifestDigest, decision:'accepted'/'rejected', comment?≤4000}`；仅 completed |
| `engines.health` | 无参 `{}`；只读全部引擎的惩罚级别、名义期限、待处理标记与卡住阻断摘要，不含 history，见 [3.3 卡住健康与引擎惩罚命令](#33-卡住健康与引擎惩罚命令) |
| `engines.penalty` | `{engine}`（由 `--engine` 给出）；只读单个引擎的完整保留记录，返回 `{engine,...statusRecord}`，含 history |
| `engines.unblock` | `{engine}`（由 `--engine` 给出）；写命令：清除所选引擎全部阻断并复位阶梯，保留历史、配置与其他引擎；不承诺引擎此刻可用 |
| `operations.get` | `{commandId}` |
| `observability.get` / `observability.export` | `{taskId, kind?}`；export 返回 JSON 文本形式的完整 trace |

**owner 的两层身份**：策略里的 `owners.<id>` 是 *profile*（每台宿主引擎至多启用一个）；真正派发前要先用 `owners attach` 把当前 agent 会话登记成一个 *owner 实例*，一次会话登记一次，返回的 `id` 全会话复用。输入约定：`name` 为 `<宿主> · <工作区目录名> · <HH:MM 会话开始>`（如 `Claude · weaver · 14:20`），`session` 取 `$CODEX_THREAD_ID`，否则 `$HERDR_PANE_ID`，否则工作区绝对路径；`--command-id` 在同一会话内保持稳定，回复丢失时同键同参取回原收据，仍不确定就 `weaver owners list` 按 name/session 找回那个实例。之后 `tasks create` 一律带 `ownerId`；带 `ownerProfileId` 走的是临时登记路径，服务端为该任务另建一个新的逻辑 owner（默认名 `Task owner`），任务因此散落到互不相干的 owner 行、不再共享同一会话的并发与上报。attach 始终是 `verified:false` 的元数据登记，服务端不联系宿主、不起进程、也不验证那个 session 标签是否真的对应一个活着的会话。

容量也是按**实例**算的：每个登记好的 owner 实例各自持有其 profile 的 `max_parallel` 个槽位，任务绑定 `ownerId` 后就一直用那个具体实例（`owners.list`/`owners.get` 的 `runningTaskCount` 就是它占用的槽位数）。没有 `ownerId` 的遗留任务退回按 profile 分组计数。`capabilities.maxParallel` 因此只是规模提示（各 profile 上限之和），不是全局并发上限；子 Agent 之间的负载均衡仍是全局的，不受 owner 实例边界影响。

**拉起 父 Agent 宿主（显式一步）**：`owners switch` 带 `launch:true`、以及 `owners launch`，都会经 `src/main/owner-host.ts` 在 Herdr 里做一次真实拉起——按 owner profile 引擎的 kind 只支持 `claude` 与 `codex`，其他 kind 直接 `OWNER_LAUNCH_UNSUPPORTED`。序列固定：`herdr --session default workspace create --cwd <任务工作区> --label <标题> --no-focus` → 读响应里的 `result.workspace.workspace_id` 与 `result.root_pane.pane_id`（拿不到 workspace id 就报失败且不认领任何资源；拿不到 root pane id 会先关掉已建 workspace）→ `herdr agent start owner-<任务 id 前 8 位>-<epoch> --kind <kind> --pane <pane> --timeout 60000 -- <模型参数>` → `herdr agent prompt <name> <接手说明>`。Herdr 会把被拒的命令印成 `{"error":{...}}` 却仍然退出 0，所以退出码 0 加信封错误同样算失败。失败时只清理这次创建的 workspace，并把 `code`/`message` 放进 `launch` 返回，不回滚已经提交的轮换；清理失败也保留在同一错误中，不假称资源已释放。成功写进任务的 `ownerHost`（`{kind:'herdr', session, workspaceId, paneId, agentName, launchedAt}`），它是宿主在哪的引用，不是宿主在推理的证明。`owners launch` 用**已有**接续包重试，不再生成第二份接续上下文。`capabilities.ownerSpawn` 为 `'herdr'` 只说明 PATH 上找得到可执行的 `herdr`，不证明有活着的模型、登录或宿主；登记本身仍然只是元数据（`manualAttach:'metadata-only'`、`ownerModelSpawned:false`、`attachmentVerified:false` 不因 launch 结果改变）。

**接续重跑（`tasks.retry`）**：`{taskId, cancel?, expectedRevision?}` 一次完成链接子任务、冻结新包与自动派发。默认只接受终态原任务；`cancel:true`（CLI `--cancel`）允许放弃在途尝试，先完成全部预检才取消它。预检包括 revision、路由与候选引擎、worker 执行能力、workspace、冻结包存在性、指令 ≤16000 字符；原任务已有冻结包仍要新建包，不再受 JSON 存储的任务和包总数限制。预检拒绝时原任务状态/事件/产物/派发保持原状。

新任务保留原 owner/ownerId、工作区、约束，以及原冻结包的 scope 与 acceptanceCriteria，带新 `packageId` 和 `retryOf`。instruction 前只加一份接续说明：上次尝试的引擎与状态、先检查 git diff 和部分产出再继续；正文取链根原目标，避免每次重试叠加前缀。链中 failed/cancelled/cancelling 祖先与当前 `--cancel` 放弃的引擎都会排除，即使它仍在取消中占槽；completed 引擎可以再次入选，无关任务不会让引擎被全局排除。没有剩余候选时在取消/创建之前返回 `NO_ALTERNATIVE_ENGINE`。显式 mock 继续 mock，real 永不回退 mock。复用 `workers.spawn` 的派发路径，直接返回任务快照、`next` 与非空时的 `excludedEngines`，不是等待后续再 spawn 的占位任务。同一 commandId 同参重发返回同一收据（含拒绝），不会重复取消、建子任务或派发。

RPC 动词（method-wrapped，目录条目带 `rpc:{method,arity}`）：`policy get`（无参，即 `weaver policy get`）、`policy validate --input`（config 文档本体，≤256 KiB，返回 issue 数组，空即通过）、`policy save --input`（`{revision,config,blocks}`，revision 乐观锁，返回新 snapshot）、`policy preview --input`（目录输入 `{owner, worker?, runningCount?}`；校验层还接受 `excludeEngines` 与 `workerLoad`，但服务端的 `previewRoute` 一律用实时全局负载覆盖传入的 `workerLoad`。它和 `workers.spawn` 走同一个比较器，所以预览的说法不会与实际选择两样）、`policy history`（无参，保留的修订列表，新到旧：`revision`、`savedAt`、`source`）、`policy rollback --input`（`{revision}`，把该修订的完整快照作为新修订写入；revision 乐观锁之外不改写历史）、`engines scan`（无参）、`engines models --engine <id> [--refresh]`（`listEngineModels`，入参 `{engine, refresh?}`，返回 `EngineModelList`，不调用模型）、`workers probe-status`（无参）、`engines set-enabled --input`（`{id,enabled,revision}`）、`quota get`（无参）、`quota refresh [--input]`（可选 `{engine}`）。这些命令不接受 `--command-id`/`--task-id`；有输入时直接提交 usage 所示 JSON 对象，不接逻辑命令信封。仅 `quota refresh` 的单参数 RPC 允许省略 `--input`，此时传 `{}`；其余单参数 RPC 继续要求输入。注意 `engines` 下两种形态并存：`scan`/`set-enabled` 是 RPC 动词，而 `engines health`/`penalty`/`unblock` 是逻辑命令，其中 `unblock` 是写命令、必须带 `--command-id`。

网页任务列表 RPC `listTasks` 只返回摘要（最近 3 条事件及产物元数据，不含产物正文），详情通过 `getTask(id)` 按需读取完整任务。网页另有两个不进 CLI 目录的 RPC 用于 子 Agent 可用性探测：`sayHi`（`{engine, model, effort}`，engine 为已保存配置里的引擎 id）立即返回 `{id, status:'running', startedAt}`，`sayHiResult(id)` 轮询到 `status:'done'` 后带 `result {ok, reply?, model?, error?, durationMs, checkedAt}`。探测在 `agent-state/` 下的空临时目录里用各 CLI 最轻的一次性调用发一句 hi：不带工具、MCP、插件/hooks 与用户 settings（CLI 支持时），不保存会话，不经过 子 Agent 执行适配，因此 Claude Code 也能探测。claude 不用 `--bare`，因为它不读 OAuth。120 秒超时即停止进程，同时最多 3 个，结果保留 10 分钟，结束后删除临时目录。这是一次真实推理，会消耗少量额度；成功只说明此刻可用。

本地 wait/watch：`tasks wait --task-id` 与 `tasks watch --task-id` 的 `--for` 都是 1–600 **秒**，省略时两条命令共用同一个缺省 `min(600 秒, herdr.max_wait_minutes × 60 秒)`（先把分钟换算成秒，再压到 600 秒上限），读不到策略时退回 30 秒；缺省 `max_wait_minutes` 为 15，于是缺省等待 600 秒。两者轮询 `tasks get`，任务一进入终态就写出那份快照并以 0 退出；`tasks wait` 遇到 health 为 `stalled` 时也以 0 提前返回，带 `reason:'stalled'`、health 和重试/取消提示，`watch` 仅在 text/jsonl 提示卡住转变并继续观察；`watch` 另外增量拉 `tasks events`，事件只在 `--output jsonl|text` 下逐行输出。它们只是轮询，不是第二调度器；超时按 `TIMEOUT` 失败退出，退出不取消任务。`herdr.max_wait_minutes` 是「父 Agent 查看间隔上限」这一个设置，Weaver 从不把它当 子 Agent 的执行 kill 时限——真实执行不会因为到这个分钟数就被停止（见 [architecture](architecture.md)）。

### 3.1 原生账户额度

`quota get` → `getQuota`（arity 0），只返回 `{records,schedule}`（最近一次观测存于 `weaver.db`，重启后仍可读），不读认证文件、不联网、不写策略；`schedule` 为 `{enabled,intervalMinutes,lastRunAt,nextRunAt}`，反映定时刷新的已保存设置与进程内运行时间。首次读取三家都为 `unknown`，`checkedAt/observedAt:null`、`stale:true`。`quota refresh` → `refreshQuota`（arity 1），先探测选定 provider，再将自有阻断合并到当前最新的策略，返回 `{records,snapshot,policyChanged}`。它是 mutation，机器帮助明确标注会同步策略阻断且不做推理。

```sh
weaver quota get --output json
weaver quota get --output jsonl
weaver quota get --output text
weaver quota refresh --output json
weaver quota refresh --output jsonl
weaver quota refresh --output text
printf '{"engine":"codex"}\n' | weaver quota refresh --input - --output json
weaver quota refresh --help --output json
```

以上刷新命令各自会请求额度并可能写策略。缺省输入 `{}` 探测全部三家；单家输入只接受 `{"engine":"codex"}`、`{"engine":"claude"}` 或 `{"engine":"grok"}`，不接受别名、URL、路径、header、force、commandId 或 taskId。HTTP 与 Unix 使用同一 RPC 白名单及参数校验；别名引擎按策略中的 `engines[id].kind` 共用相应原生账户观测。

每条 record 含 `engine/status/source/checkedAt/observedAt/stale/windows/detail/retryAt`，可选 `statusBasis:"account_restriction"` 标识服务端明确的独立全账户消费限制。该限制不会随着套餐窗口 reset 解除，自动阻断不借用套餐 reset 设期限；5 分钟过期及失败状态仍照常生效。窗口保留账户、模型或未知范围、服务端百分比/计数及可信 reset；缺失值保留 `null`，不补 0，不把模型子池耗尽推广为整个账户耗尽。`available` 表示本次有明确账户可继续使用的依据，不证明某个模型可以执行；`exhausted` 表示明确账户耗尽；`unknown`、`unauthenticated`、`unsupported`、`error` 分别保留不确定、原生登录、认证模式与探测失败的信息。读取成功的 CLI 信封可包含失败状态的 provider record，不能只凭 `ok:true` 判定账户可用。

观测仅驻留内存，成功观测 5 分钟后标记 `stale`；进程重启不恢复观测。每家请求合并进行中的刷新，网络请求最短间隔 60 秒，HTTP 429 遵守更晚的 `Retry-After` 并通过 `retryAt` 告知；429 表示探测接口限流，不等于订阅额度耗尽。失败可保留同一凭据的旧窗口，但明确标为过期；身份变化不沿用旧观测。除按 `quota.interval_minutes` 定时刷新外没有后台轮询，也没有循环重试或 force 绕过。

策略只持久保存自有 engine-level 阻断：`by:"weaver-quota:<kind>"`，不设置 model，且只作用于 `quota_refresh` 生效的引擎（缺省 codex、claude、grok 开启，其他 kind 没有额度接口、不得开启）；关闭的引擎不被自动阻断，因为不再有新鲜观测解除它。新鲜 `exhausted` 新增/更新；只有新鲜 `available` 删除自己的 source，其他状态及 stale 观测都不清旧阻断。人工、foreign 和 model-level 阻断原样保留。期限取仍耗尽账户窗口的最晚可信 reset；未知 reset 则不猜期限。新阻断不取消 running 任务；现有队列与新派发继续遵守 policy/pin，不自动改派。

刷新结束后原子合并此刻最新策略，保留请求期间的其他保存；无 block 实质变化不增加 revision。过期人工/foreign engine-level 记录占用唯一 key、导致无法同时保留它并建立有效自动阻断时，整次合并返回 `QUOTA_POLICY_CONFLICT`（HTTP 409），文件、内存策略和 revision 不变；先通过已有策略编辑流程处理该历史记录，再刷新。有效人工阻断正常保留。持久保存失败报 `PERSISTENCE_ERROR`（HTTP 500），不能当作自动阻断成功。退出时先中止探测；draining 后完成的请求不写策略。

主动探测读取既有本地登录的 access token，并仅发送下列固定 HTTPS GET。三个地址均是原生实现或开源客户端使用的**非公开接口**，接口变化可能导致未知、401/403 或限流；当前实现不启动 Codex app-server 或 Claude statusline，也不把它们称为公开额度 API。

| 引擎 / source | 固定 GET | 原生认证来源 |
|---|---|---|
| Codex / `codex_usage` | `https://chatgpt.com/backend-api/wham/usage` | `$CODEX_HOME/auth.json`，否则 `~/.codex/auth.json`；准确的 `tokens.access_token` 与同对象 `account_id`，只支持明确的 ChatGPT 登录；API key 或不明确模式拒绝 |
| Claude Code / `claude_oauth_usage` | `https://api.anthropic.com/api/oauth/usage` | `$CLAUDE_CONFIG_DIR/.credentials.json`，否则 `~/.claude/.credentials.json`；仅 `claudeAiOauth.accessToken`，不读取 MCP OAuth 作为账户 bearer |
| Grok / `grok_cli_billing` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` | `~/.grok/auth.json`；唯一官方 `https://auth.x.ai::<client-id>` OIDC 条目的 `key`；多候选不猜 |

这些认证文件只读；不提取或使用 refresh token，不刷新登录、不登录/登出、不切换账户、不扫描浏览器/Keychain、不启动 TUI 或模型。请求禁止重定向，不遵循自定义 base URL；一次探测的总截止时间 8 秒，认证文件与响应均实际限制为 256 KiB，只输出受控字段与错误，不回传 token、账户 ID 或原始响应。Claude Code 即便未接入真实 worker，也可以独立探测额度。Grok CLI 订阅 credits 与 xAI API 团队钱包、美元余额、RPM/TPM、token 费用不同，不能拿后者替代此处的订阅额度。

### 3.2 服务命令组 `weaver server`

一台机器上的所有 agent 会话共享同一个 Weaver 服务进程（唯一写者与 worker 监督者）。`weaver server` 管理它的生命周期；参数与返回字段以 `weaver server --help` 与 `weaver --help --output json` 为准。

- `weaver server start [--port 4737] [--data-dir D]`：以后台分离进程启动服务，日志写在 `<data-dir>/server.log`，等到服务能应答才返回。已有运行中的服务时不再起第二个，直接返回那个服务的信息；同一 port + data dir 装了登录自启服务时，由它来启动。客户端报 `APP_NOT_RUNNING` 就执行这条。
- `weaver server status`：运行时给出 pid、url、port、data dir、版本、running workers 与 `managedBy`；未运行时明确报停止状态。两种情况都附带「是否已安装登录自启服务」。
- `weaver server stop [--force]`：发 SIGTERM 并等待退出。有 worker 在跑时默认拒绝并返回 `SERVER_BUSY`——停止会取消在途工作——`--force` 才强制。停止由用户发起：owner agent 不把停服务当作任务收尾，也不杀它的进程或 systemd scope。
- `weaver server install [--port] [--data-dir] [--force]` / `weaver server uninstall`：安装或移除登录自启，Linux 写 systemd user unit `weaver.service`，macOS 写 launchd agent `dev.weaver.server`；只在安装后的独立可执行文件下可用。install 捕获调用时的 `PATH`，让 worker 仍找得到各引擎 CLI；对没有被该服务管理的运行实例只给提示，不动它。

前台模式 `weaver web` 保留给开发与调试（打开浏览器），它与后台服务是同一进程实现的两种运行方式。崩溃服务遗留的 stale endpoint（discovery 文件还在、socket 已不应答）在服务启动时自动清除，所以 `weaver server start` 能自行恢复。

### 3.3 卡住健康与引擎惩罚命令

`tasks health`、`engines health`、`engines penalty`、`engines unblock` 已在 `CLI_CATALOG` 与 `CommandHandler` 接通，经同一 HTTP/Unix 逻辑命令通道调用监控器；网页 `getStall` 仍是单独的 method-wrapped RPC。`--engine` 只属于 penalty/unblock；unblock 是需 commandId 的写命令。没有监控器的进程以 `CAPABILITY_UNAVAILABLE` 明确拒绝诊断或解除，不伪造健康读数。

**判定（`tasks health`，逻辑输入 `{taskId}`）**：只有 running 且 `dispatch.execution === 'real'` 的任务有健康读数，其余任务的 `silenceMs`/`cpuActive`/`cpuIdleMs` 保留 `null` 而不是猜。静默从最后一个事件的时间起算，没有事件时退回 `run.startedAt`。CPU 只测该任务自己 worker scope 的累计 CPU（systemd `CPUUsageNSec`，取不到时读 cgroup `cpu.stat`），比较相邻两个 60 秒样本的增量占比，低于单核 5% 算这一个区间空闲。以下状态共用同一个分类器：

- `ended`：已完成、失败或取消，`taskStatus` 保留最终状态。
- `starting`：running 的真实 子 Agent 尚无首个有效供应商输出。
- `stalled`：静默 ≥5 分钟**且**连续观测到空闲 ≥5 分钟，两条同时成立。
- `waiting_model`：静默 ≥5 分钟，且 CPU 没有证明在忙（包含完全读不到的情况）。
- `working`：其余。

读不到 CPU 永远判不出卡住，只会落进 `waiting_model`——这是有意的：没有第二条路径能把「我无法观测」说成「它停了」。读数形状是 `StallMonitor.taskHealth()` 的返回：`{taskId, state, taskStatus, engine|null, lastEventAt, silenceMs, cpuActive, cpuIdleMs, scopeUnit}`，接线只负责把它放进信封 `data`。

**读惩罚（`engines health` 无参 `{}`；`engines penalty` 单引擎 `{engine}`）**：`engines.health` 返回 `{engines,config}`；`config` 为 `{stallMinutes:5, quorum:2, ladder:[5,10,null], resetHours:2}`。每个引擎只含 `level`（0–3）、`lastTriggerAt`、`needsAttention`、`blocked`、`blockedUntil`、`nextProbeAt`、`probeSuccesses`，**不含 history**。`blocked` 只表示策略里是否存在该引擎自己的 `by:"weaver-stall"` 阻断，不代表人工/额度阻断或整体路由可用性；期限是名义探测时点，不是 `release_at`。策略中每个引擎都有摘要，另含留有监控器状态但已从策略移除的引擎。

`engines.penalty` 返回 `{engine,...statusRecord}`，在上述字段外给出该引擎完整保留的 `history`，以及 `vendorLimit`（供应商限流阶梯 `{level,lastTriggerAt}`，无记录时为 `null`）。history 包含触发（`tasks`、`taskCount`、`stalledMinutes`）、探测（`probe:{ok,ms,error?}` 与 model/effort）、恢复（message）记录；存储全局只保留最近 50 条，每条至多 50 个完整任务 ID，`taskCount` 保留真实任务总数，探测错误脱敏且有界。惩罚阶梯与记录存于 `weaver.db` 的 `stall_*` 表，重启后沿用期限、连击与记录；非法整数级别/连击或超出 Date 范围的时间等语义错误按损坏状态整份回退，已存在的策略 stall block 保留并在 tick 中接管重武装，不静默放行。penalty/unblock 用 own-property 成员校验，不接受 `Object.prototype` 上的名字作为已知引擎。

**阶梯怎么走上走下**：一台引擎要**同一时刻有至少 2 个** stalled 任务才受罚（`quorum`），偶发一个不动路由。L1 暂停 5 分钟、L2 暂停 10 分钟、L3 只标 `needsAttention` 并每 10 分钟探测一次；同一引擎在 2 小时内重复触发就再往上一级，超过 2 小时安静级别才回到历史。惩罚写进策略的是 `by:"weaver-stall"` 的 engine 级阻断，**不带 `release_at`**：时间流逝永远不会自动解除它，`blockedUntil` 只是「到点该去探测」。L1/L2 到点、以及 L3 的每轮，都只发一次最轻的真实调用——取该引擎上第一个启用 worker 的 model/effort，走一次 子 Agent 可用性问候那条路（命令目录末尾那段 `sayHi` 说明），不产生任务、不占 worker 槽位。通过就只删自己这条阻断，`level` 与触发时间原样保留，于是下一次直接升一级；不通过就立刻升一级并重写阻断的理由。L3 要**连续 3 次**通过才自动恢复，恢复时在历史里记一条 `自动恢复，请留意`，任何一次失败都把连击清零。引擎被停用、或该引擎上找不到启用的 worker 时探测发不出去，同样按一次失败记录（`这台引擎没有可用的 子 Agent，无法探测。`）。整个过程**从不取消任务、从不杀进程**，它只让新派发绕开这台引擎；首个有效输出后不设总执行 deadline；启动阶段仍有 120 秒无输出失败检查。别的来源（人工、额度）已经在这台引擎上挂着 engine 级阻断时不再叠加惩罚；惩罚解除或自动恢复后会触发一次重新 pump，排队中的任务因此继续走。

**人工解除（`engines unblock`，写命令 `{engine}`）**：删除所选引擎的**全部**策略阻断，包含人工、额度、model 级及监控器自己的条目；复位阶梯、连击和期限，保留历史、配置、其他引擎与任务事件。自动恢复仅删除自己写入的 stall block，两条路径权限范围不同。响应为 `{engine,wasBlocked,cleared,retainedHistory,otherEngines}`：`wasBlocked` 是解除前该引擎自己的 stall 阻断状态，不是所有来源的阻断或整体可用性；`cleared` 是复位后的摘要，`retainedHistory` 是保留记录，`otherEngines` 是其他引擎摘要。相同 commandId 同参回放收据，不重复解除。未知 engine 在任何写入前拒绝。解除后接着的一次 tick 不会立即再罚该引擎；下次新惩罚从 L1 起算。解除不证明认证、模型或当前可用性。

监控器 `stop()` 自身会隔离在途采样与恢复探测的晚到结果并等待 tick 收束，之后 `tick()` 不写入，只有再次 `start()` 才恢复；该约束独立于服务 ready 回调。重试链排除与当前策略阻断共同决定候选，详见上方接续重跑。

## 4. 幂等、续传与修订

- 显式 owner 启动经异步命令流等待**最终响应**；没有 pending/jobs API。在途同 commandId 同参返回 `COMMAND_INDETERMINATE`（不重复启动），完成后同键重发回放最终收据；同 task+epoch 的不同启动请求以 `INVALID_STATE` 拒绝。未响应或断连先查 `operations.get`，不把客户端超时当作服务端取消。
- 异步启动结束后重新读任务：仅 ownerId/epoch 仍匹配且未 draining 时写 ownerHost/事件，保留期间新增的状态；新 binding 或关停已取代该尝试时，清理本次宿主的确切 session/workspace，不把旧结果写回。ownerHost 持久化失败会清理本次宿主；已落盘后通知失败不误清已可见宿主。收据写入失败保留 `COMMAND_INDETERMINATE`，不能据此重做副作用。
- 服务 drain 拒绝新请求、中止在途启动，并等待启动及独立的精确清理完成；已中止的启动 signal 不传给清理。普通读请求在等待 Herdr 的同时仍可响应。

- 写命令携带稳定 commandId；同键同参返回原收据，同键不同参 `IDEMPOTENCY_CONFLICT`；受影响但收据未持久返回 `COMMAND_INDETERMINATE`。未知/损坏回复先 `operations get --command-id <id>` 查收据再决定，不换新 ID 盲重试。
- 顺序是「意图先落盘、再产生副作用」：崩溃只会让同一 commandId 的重发被挡住并要求你核对现状，不会静默重复一次派发。
- 修改型命令带 `expectedRevision`（当前聚合 revision）；过期写返回 `REVISION_CONFLICT` 附当前 revision。`results.ack`/`reviews.submit` 还必须等待当前 `manifestDigest`，否则 `MANIFEST_MISMATCH`。
- `next` 是**当下这一次**的结论，不推送：排队中（`scheduled:true`）的任务拿到的 `next` 是 `wait`，之后被 pump 起来不会有人再通知你。路由是冻结的——pump 只按冻结的 worker/engine/model/effort 复核，对不上就写 `queueReason.code:'frozen_route_changed'` 并继续等待（要么恢复那条路由，要么取消后新建任务），不会偷偷换一个。回到任务上重新 `tasks get` 才是权威答案：运行中的 native 任务会在这里重新给出同样的 `next`。
- 收据按 command key 持久保存于 `weaver.db` 的 receipts 表，`operations.get` 重启后仍可读；不再受原 JSON 存储的 5000 条上限限制。

## 5. 真实生命周期示例

说明：`<taskId>`、`<digest>` 等占位来自命令真实响应中的字段，本文不虚构具体 UUID 或 digest。空行之间是同一任务的连续步骤；每条 mutation 用稳定 commandId 便于幂等。

```sh
weaver owners attach --input owner.json --command-id owner-001
# → data.{id, name, profileId, mode:'manual', state:'attached', host}（一次会话登记一次，同 profileId+name+session 重发返回同一个 id；`<ownerId>` = data.id）

weaver tasks create --input task.json --command-id create-001
# → data.{id, workspace, ownerId, continuationPolicy{idleRotationMinutes:60}}（ownerId 用 attach 返回的实例 id）

weaver packages create --task-id <taskId> --input package.json --command-id package-001
# → data.{id, revision:1, scope, acceptanceCriteria, instruction}（包冻结）

weaver workers spawn --task-id <taskId> --input dispatch.json --command-id spawn-001
# → data.dispatch.{owner,worker,engine,model,effort,execution,workspace,...} 加 data.next；
#   容量满时 data.scheduled=true + queueReason{code:'waiting_for_capacity'}，此时 next 就是 wait；
#   execution 为 native 时 next 是 {action:'run_subagent', model, effort, prompt, then}：
#   按 prompt 用 父 Agent 自己引擎的内建子代理跑，再用 then 那条 workers complete 回报

weaver tasks wait --task-id <taskId> --for 300
# → 轮询至终态；300 秒内未结束返回 TIMEOUT（任务仍在继续，未被取消）

weaver tasks results --task-id <taskId>
# → data.{artifacts:[{id,sha256,...}], manifestDigest, delivery, acceptance}

weaver artifacts read --task-id <taskId> --input read.json
# read.json: {"artifactId":"<id from tasks results>"}
# → data.content（≤32,000 字符；完整文件用任务 workspace 内真实文件复核）
```

```json
owner.json
{ "profileId": "codex_owner", "name": "Codex · your-repo · 14:20", "session": "/home/you/your-repo" }

task.json
{
  "title": "Add retry unit test",
  "instruction": "Add a bounded test covering flake reproduction and result-only-on-zero-exit.",
  "ownerId": "<ownerId>",
  "workspace": "/home/you/your-repo",
  "acceptanceCriteria": ["suite passes locally", "revision kept minimal"]
}

package.json
{ "scope": ["tests/", "src/cmd-name.ts"], "acceptanceCriteria": ["change compiles"] }

dispatch.json
{}

ack.json
{ "expectedRevision": <ack 前从 tasks get / tasks results 读取的当前 revision>, "manifestDigest": "<digest>" }

review.json
{ "expectedRevision": <ack 后重新读取的当前 revision；ack 本身会使任务 revision +1>, "manifestDigest": "<digest>", "decision": "accepted", "comment": "本地复验通过" }
```

外部 owner 接续与验收：

```sh
weaver owners continuation get --task-id <taskId>
# → data.{history:[...], contextPack:{..., limitations:[...]}, prompt}（prompt 是脱敏后 ≤6000 字符的接手说明，与 owners launch 拿同一份接续包投给宿主的说明逐字相同；
#   manual 接续包的 acknowledgementId 为 null，mock 宿主握手才有真实 ack。Weaver 只在 父 Agent 显式发起时（owners switch 带 launch:true，或 owners launch）才在 Herdr 里拉起可见宿主并投递这份说明，不自己决定何时轮换，也不为接续包伪造确认）

weaver owners continuation configure --task-id <taskId> --input cfg.json --command-id keep-001
# cfg.json: {"expectedRevision":2,"idleRotationMinutes":90}（null=关闭；1–10080 分钟）

weaver results ack --task-id <taskId> --input ack.json --command-id ack-001
# → data.delivery 变为 acknowledged；acceptance 保持 pending（ack 不等于验收）

weaver reviews submit --task-id <taskId> --input review.json --command-id review-001
# → data.acceptance 变为 accepted/rejected并把 reviewComment 记录进任务事件
```

## 6. 能力声明

`capabilities.get` 返回的是本进程现状，不是愿景：`workerProviders` 为 `["mock-jsonl","opencode","pi","grok","codex","qodercli"]`（真实 launcher 加载后）或 `["mock-jsonl"]`，顺序与 `REAL_ENGINE_KINDS` 一致；`realExecution` 布尔表示 launcher 已加载，不表示跑通过一次推理或证明过登录；`mcp:false`。父 Agent 侧是 `ownerSpawn`（PATH 上找得到 `herdr` 时为 `'herdr'`，否则 `'logical-registration'`——这只证明有一个可执行文件，不证明有活着的宿主、模型或登录）、`manualAttach:'metadata-only'`、`ownerModelSpawned:false`、`attachmentVerified:false`；显式发起的 launch 成功也不会翻转这几个字段，宿主是否真在推理由你在 Herdr 里看。安全边界是 `authentication:'ephemeral-local-trusted-user-demo'`、`ownerScopedAuthorization:false`、`authenticated:false`、`modelUsable:false`。容量口径是 `capacity:{unit:'owner-instance', aggregate:'sum of enabled owner profile max_parallel', admission:'…'}` 加 `maxParallel`（各启用 profile 上限之和，规模提示而非全局上限，见上文两层身份）；`policyAdmission:true`、`durability:'durable intent before effect; …'`、`cliTransport` 描述当前传输。`commands` 数组只列逻辑读命令与写命令，method-wrapped RPC 动词与本地 `tasks wait/watch` 不在其中——完整 CLI 目录一律读 `weaver --help --output json`，本文不复制任何一个数量。

`quota` 提供额外发现入口：`engines:["codex","claude","grok"]`，`get` 的 CLI/RPC 名及 `network:false`，`refresh` 的 CLI/RPC 名及 `updatesPolicyBlocks:true/inference:false`。

## 7. 本地传输与错误

- 当前本地控制面只面向 Linux/Unix：服务进程（前台 `weaver web`，或 `weaver server start` 起的后台实例）启动顺序是先起 Unix socket 服务再起 HTTP（`src/main/runtime.ts`），而 `startLocalIPC` 在 win32 直接抛 `UNSUPPORTED_PLATFORM`（`src/main/local-ipc.ts`），所以原生 Windows 上整个控制面起不来，HTTP 面不单独可用。真实受管 worker 依赖 Linux systemd user scope。
- token/frame 控制文件在 `<dataDir>/control-<instanceId>/`（用户目录受限），损坏或 stale 的 discovery 文件安全拒绝（`UNSAFE_ENDPOINT`），不能被另一进程伪造这样一套端点。崩溃服务遗留的 stale 端点（discovery 文件在、socket 已不应答）在服务启动时自动清除，见 [3.2 服务命令组](#32-服务命令组-weaver-server)。
- HTTP 错误码映射 `INVALID_HOST/INVALID_ORIGIN` 等有校验；body 中仅 method+args 的白名单 method 可调用，无反射分发。
- 默认传输等待 15000 ms。只有完整、token 认证通过的 IPC 帧，或同源/Host 校验及完整 JSON body/白名单校验通过的 HTTP 请求，才按逻辑命令分类：合法 `owners.launch`，或 `owners.switch` 且 `launch:true`，使用固定 210000 ms。分类要求 `weaver.v1`、非空 commandId、合法 task UUID、非负整数 expectedRevision，并校验 switch 的可选字段；这是传输预算校验，任务存在性、revision 与策略资格仍由 handler 判断。半帧、部分 body、畸形/未认证及普通请求不会获得延长时限。
- CLI `sendRequest` 与服务端使用同一分类，实际客户端上限取分类预算与调用方显式较短 timeout 的较小者；没有新增全局 launch 超时开关。启动步骤本身仍有各自超时与失败清理，请求预算不构成认证或模型运行证明。
