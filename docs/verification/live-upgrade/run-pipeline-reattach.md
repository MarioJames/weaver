# Weaver worker 运行态重接调研（run-pipeline-reattach）

调研对象：`/home/mocha/opensource/weaver`（只读，未修改仓库）。
目标方案：worker 厂商 CLI 的 stdout/stderr 直接写入 stateDir 下的日志文件，退出码由 `sh -c` 外壳写入文件；服务仍是唯一写库进程；服务停机不取消 worker；重启后按持久化的 scope unit + invocation 核验归属，从日志重放并继续跟踪，scope 已结束时读退出码文件收尾。

实验环境：Linux，systemd 257（`257.13-1~deb13u1`），systemd user session 为 `running`。第 (6) 节的所有 scope 均由本 worker 创建，unit 前缀为 `weaver-design-exp-`，结束后已确认全部回收（见 6.6）。仓库内没有写入任何文件。

---

## 0. 结论速览

1. **normalizer 本身可由完整日志重放。** 六个引擎的 normalizer 都是“按行累积的闭包状态机”，没有时间、文件、环境变量或进程状态分支；同一有序行序列、同一 `finish()` 输入、从日志开头完整重放，可以得到相同的 `records` 和 `evidence`（`sessionId`、`vendorModel`、`usage`、`terminal`）（`src/main/adapters/cli/normalize.ts:115-165`，逐引擎见 1.2）。本 worker 用 7 字节切片重放做了本地验证，六引擎全部 `IDENTICAL`（1.3）。
2. **但“厂商 raw 日志”不等于当前在线 records 的全集。** 当前 CliAgent 先把厂商行解析成 `WorkerRecord` 写进自己的 stdout，manager 再用 `JsonlParser` 解析；启动时的 3 条 launcher records、`first-output` 的真实时间、stderr 尾部、`vendor-error` 的时间相关分类、manager 的 1000 条/2 MiB 限制，都不在厂商日志里（2.1、2.4、3.5）。
3. **scopeUnit 已入库，invocation 未入库。** `task.run.scopeUnit` 由 `observe()` 在 start 后写入并持久化（`src/main/manager.ts:122-124,207-215`）；任务路径没有写 `InvocationID`，CliAgent 虽发 `identity` 事件但 manager 未监听（`src/main/adapters/cli/launch.ts:169`；对比 schedule 的 `src/main/schedules/service.ts:324,344-351`）。
4. **进程模型支持“服务退出、worker 继续”。** 在 systemd 257 上，`systemd-run --user --scope` 会 exec 成命令本身；父进程存活时命令是父进程的直接子进程；在本实验模拟服务退出（普通 node 父进程被 SIGKILL）后，命令被 `systemd --user`（实验 PID 1646）收养，scope 的 `InvocationID`/cgroup 不变，继续运行并按 `--collect` 在结束后卸载。stdout/stderr 改为文件 fd 后继写不受影响；若仍是 pipe，父进程死亡后下一次写会触发 `SIGPIPE`（6.1-6.3）。实际 `weaver.service` 的 systemd stop 未直接实测，见第 9 节风险。
5. **退出码只能由外壳文件可靠带回。** `--collect` 后 `systemctl show` 得到 `LoadState=not-found`，没有 `MainPID`/`ExecMainStatus`；即便命令 `exit 7`，短暂窗口和保留的 `Result` 仍可能是 `success`。父进程不在时 systemd 的 `Result` 不能当退出码使用；SIGKILL 则根本没有机会写文件（6.4）。
6. **重接的主要新工作不是 normalizer，而是持久化 replay 游标/幂等和运行态对象。** 事件/artifact 用 `randomUUID()` 生成（`src/main/domain/tasks.ts:19-22`），从日志开头重放会重复写事件/artifact；必须持久化“已应用到的日志位置/记录数”，或让重放只产生确定性的新后缀（3.4、8）。

---

## 1. normalizer：内部状态、重放能力、finish()

### 1.1 结构

`createNormalizer(engine)` 返回 `push(line)`、`finish(outcome)`、`sessionId()`（`src/main/adapters/cli/normalize.ts:115-165`）。内部状态：

- `state: MutableEvidence`：`terminal`、`assistantText`、`vendorTerminal`、`sessionClosed`（pi）、`stopReason`、`failure`、`failureDetail`、`assistantClipped`、`clipped`、`dshTools`（`normalize.ts:15-35,121`）。
- `unparsed`：非 JSON/非对象行计数（`normalize.ts:122,128-130`）。
- `sawError`：任一引擎错误事件后置真（`normalize.ts:123,131`；各引擎通过 `markError` 调用）。
- 每个引擎的 `acceptX` 只读写 `state` 和本次 `out` 数组，没有 `Date.now()`、`setTimeout`、文件、环境变量或进程调用（`normalize.ts:167-480`；对本文件做 `Date/now/setTimeout/process` 搜索无命中）。
- `record()` 只做 `redactSecrets` + `clip`，不附加时间（`normalize.ts:37-40`）；`redactSecrets` 是纯字符串替换（`src/shared/redact.ts:1-43`）。

因此 normalizer 不是“无状态纯函数”，而是**有序行序列上的确定性状态机**：`push` 的返回值依赖此前所有行；从日志开头完整重放可以重建同一状态。

### 1.2 逐引擎

| 引擎 | 状态/关键分支（文件:行号） | 能否从日志开头完整重放 | 不能/需注意的具体原因 |
|---|---|---|---|
| pi | `session.id` → vendorSessionId；`agent_start` progress；`message_end` 的 model/provider/usage/stopReason/content；`agent_end`/`agent_settled` 设 `sessionClosed`；`aborted`/`error` 设 failure（`normalize.ts:178-213`）。`finish` 时重新计算 `vendorTerminal = sessionClosed && stopReason==='stop'`（`normalize.ts:141`）。 | 能 | 必须重放到 `agent_end`/`agent_settled`，且 `stopReason` 仍为 `stop`；否则即使 `message_end` 成功也不是 success。`finish` 的 pi 特判在末尾执行，日志顺序影响结果；完整重放顺序一致即可。 |
| opencode | 任意事件带 `sessionID`；`step_start`; `text` 追加；`tool_use`; `step_finish` 的 tokens/reason；`error`（`normalize.ts:215-251`）。`error`/`aborted` sticky，后续 `stop` 不会清除（`normalize.ts:237-241`）。 | 能 | `text` 是 `rememberAssistant(..., append=true)`，从中间开始重放会丢前缀；必须从开头。`step_finish` 的 `tool-calls` 等中间 reason 不置成功（`normalize.ts:235-241`）。 |
| grok | `system` 的 session/model；`assistant` 的 model/usage/content/stop_reason；`result` 的 session/usage/result/stop_reason；`is_error`/非 `success` subtype 失败（`normalize.ts:253-287`）。 | 能 | `result` 成功才置 `vendorTerminal`；`assistant` 文本是替换语义（默认 `append=false`），只有最后一次 assistant 文本保留；完整重放相同。 |
| codex | `thread.started` 的 thread_id；`item.completed` 的 `agent_message` 追加；其它 item 工具日志；`turn.completed` usage 并置成功；`turn.failed`/`error` 失败（`normalize.ts:308-337`）。 | 能 | `item.started` 的 `agent_message` 不采集正文，只有 `item.completed` 采集；完整重放一致。 |
| qodercli | `system` 仅 `subtype==='init'`；assistant 的 model/usage/tool_use/content/stop_reason；`result` 成功置 `vendorTerminal`；`error` 失败（`normalize.ts:340-384`）。 | 能 | `result` 失败分支不采集 `result` 文本（只写 failureDetail），成功分支才 `rememberAssistant`；完整重放一致。 |
| dsh | `session`；`status` 的 `turn_start`/`step_end`/`turn_end`；`turn_end.reason.kind` 决定成功/失败；`tool_call` 写 `dshTools`，`tool_result` 通过 Map 回查工具名；`final` 替换 assistant 文本；`error` 失败（`normalize.ts:428-472`）。 | 能，但要求完整日志 | `dshTools` 是进程内 `Map`，上限 50、按最早键淘汰（`normalize.ts:33-35,387-418`）；从日志中间开始会丢失 `tool_call`，`tool_result` 只能得到通用 “tool finished/failed”。`final` 的“替换”语义（`normalize.ts:461-463,475-480`）也要求从开头重放。中间 `text`/`thinking` 事件不保留，只有 `final` 成为结果。 |

所有引擎的共同点：

- `vendorModel` 只在事件明确带 model 时写入；opencode/codex/dsh 的样例中为 `undefined`（未知保持未知，不捏造），`evidence` 返回这个未知值（`normalize.ts:162`）。
- `usage` 按 key 合并，后出现的事件覆盖同名 key（`normalize.ts:54-59`）。
- 超过 512 字符的 session/model 不写入，超过 80 字符的 stopReason 变 `unknown`，超过 30000 的 assistant 文本保留尾部并记录 clipped（`normalize.ts:11-12,78-107`）。
- `unparsed` 和 `clipped` 只在 `finish()` 生成日志（`normalize.ts:138-139`）；so 在线时这些日志要到结束才出现，重放时也应只在 finish 出现。

### 1.3 完整重放等价性验证

本 worker 在 `/tmp/weaver-restart-design-FMDYA1/worker-b/replay-check.ts` 用仓库的 `createNormalizer` 和 `decodeLines`，对六个引擎各构造一组事件行：

- 在线路径：逐行 `normalizer.push(line)`，收集返回 records，再 `finish({exitCode:0,cancelled:false,truncated:false})`。
- 重放路径：把同一组行拼成字节，按 7 字节切片喂给 `decodeLines`（故意跨 UTF-8/JSON 边界），再把解码出的行交给新的 normalizer，最后同样 `finish`。
- 比较 `records`、`evidence`、`sessionId()`；额外验证非 JSON 行的 `finish` 记录可重复。

实际输出：

```text
pi IDENTICAL records=5 terminal=success session=sess-pi model=p/m
opencode IDENTICAL records=4 terminal=success session=sess-oc model=
grok IDENTICAL records=3 terminal=success session=sess-grok model=grok-1
codex IDENTICAL records=4 terminal=success session=sess-codex model=
qodercli IDENTICAL records=4 terminal=success session=sess-qoder model=qoder-1
dsh IDENTICAL records=6 terminal=success session=sess-dsh model=
unparsed-finish-equal true
```

结论：**逐引擎都能从日志开头完整重放得到相同的 records 和 evidence**；上表的“需注意”是重放前提，不是不确定性。`decodeLines` 的分块方式不影响完整行（`src/main/adapters/cli/scope.ts:328-393`），其 8 MiB 行长上限的 overflow 诊断记录依赖累计 `vendorBytes`/`vendorFrames`（`src/main/adapters/cli/launch.ts:213-215`），从日志开头重放时累计值也相同；从中间开始则不同。

### 1.4 finish() 的输入如何影响结果

`finish(outcome: {exitCode: number | null; cancelled: boolean; truncated: boolean})` 定义在 `normalize.ts:117`，判定顺序在 `normalize.ts:143-148`：

| 输入/状态 | 结果 | 依据 |
|---|---|---|
| `outcome.cancelled === true` | `terminal='cancelled'`，优先于 truncated/error | `normalize.ts:144` |
| `outcome.truncated === true` 或 `stopReason === 'length'/'max_tokens'` | `terminal='truncated'` | `normalize.ts:145` |
| `sawError` 或 `state.failure` 或 `exitCode !== 0 && exitCode !== null` | `terminal='error'` | `normalize.ts:146` |
| `vendorTerminal && !sawError && !failure && assistantText.trim().length>0 && exitCode===0` | `terminal='success'` | `normalize.ts:140-147` |
| 其余（没有 vendor terminal、没有文本、`exitCode===null` 等） | `terminal='missing'` | `normalize.ts:143,148` |

要点：

- `cancelled` 优先级最高；即使 vendor 已成功、exit 0，也会是 `cancelled`。
- `truncated` 优先于 error；但 `source` 日志只在 `outcome.truncated` 时为 `local protocol`，由 vendor `stopReason` 触发的截断仍写 `vendor`（`normalize.ts:159`）。
- `exitCode===null`（信号/未知）不会进入 error 分支；若不取消，通常落到 `missing`。因此重启重放必须把“取消/信号”持久化，否则会把被信号终止的 worker 误判为 missing/失败，而不是 cancelled。
- pi 的 `vendorTerminal` 在 finish 内重新计算（`normalize.ts:141`），所以 pi 必须同时满足“会话关闭”和 `stopReason==='stop'`。
- success 时额外产生 `artifact result.md` 与 `result`；失败时产生一条 `vendor terminal ... exit N` 日志（`normalize.ts:150-161`）。`launch.ts:242` 还会在非 success 的 terminal 日志后追加 `stderr tail` 和 `last vendor error`。
- 当前 CliAgent 调用 finish 时 `truncated` **硬编码为 false**（`src/main/adapters/cli/launch.ts:237`），所以 `outcome.truncated` 分支目前只在测试/未来接入时使用；真实运行中的 truncated 主要来自 `stopReason`。

---

## 2. CliAgent：实时流依赖与可重放部分

### 2.1 当前数据流

1. `startOwnedScope` 用 `systemd-run --user --scope --collect ... -- argv` 启动进程，stdout/stderr 是 pipe（`src/main/adapters/cli/scope.ts:144-148`）。
2. `CliAgent` 把厂商 stdout 交给 `decodeLines`；每行交给 normalizer；如果 normalizer 产生了 records，就发 `first-output`（`src/main/adapters/cli/launch.ts:154-165`）。
3. 同时做 vendor-error 检测、pi 实际模型检测（`launch.ts:159-163`）。
4. normalizer 的 records 经 `emitRecords` 再脱敏/裁剪，以 JSONL 写入 CliAgent 自己的 `stdout`（`launch.ts:227-232`）。
5. manager 的 `JsonlParser` 解析 CliAgent.stdout，交给 `record()` 写库（`src/main/manager.ts:85-89,191-206`；`src/main/protocol.ts:5-34`）。

因此“厂商日志重放”至少有两层：厂商行 → normalizer records；records → manager 事件/artifact。当前只有第一层的输入来自厂商，第二层的 records 不落盘（只有最终 events/artifacts 在 DB）。

### 2.2 各机制：实时流 vs 可重放

| 机制 | 位置 | 依赖实时流？ | 从文件重放的可能与限制 |
|---|---|---|---|
| `vendor-error` 结构化检测 | `launch.ts:160-162` | 内容检测本身不依赖时间；但 `classifyVendorEvent` 默认用 `Date.now()` 解析相对 `retry-after`（`vendor-errors.ts:47-50,151-158`） | 行内容可重放；`retryAt` 会随重放时刻变化。若要求与在线完全一致，需要持久化 `vendorError`/`retryAt` 或记录事件时间。检测规则包含 `type` 含 error/fail、`error` 字段、`is_error`、result 非 success、assistant `stopReason` error/aborted；都可从行内容复现。 |
| stderr 未完成行探测 | `launch.ts:182-190` | **部分依赖实时流**：它只看当前 stderr 尾部未完成行（`slice(-8192)`，8192 字符），一旦分类成功立即发 `vendor-error`，不等换行 | 如果日志文件保留了这个未完成行，重放时可以“读文件尾部 + 同样分类”复现；但普通“按行读完整文件”会等到换行/EOF 才看到，可能晚于在线行为。必须在重放器中显式保留这个 tail 探测。 |
| 完整 stderr 行缓冲/脱敏 | `launch.ts:153,182,216-226`；`redact.ts:14-101` | 内容不依赖时间；`stderrTail` 每次完整行更新，24 KiB 上限只影响转给 manager 的 stderr，不影响 tail（tail 在 cap 前更新） | 可从原始 stderr 文件重放，但必须应用同样的行拆分、行超长丢弃、PEM 块、脱敏规则；否则 `stderrTail` 不一致。 |
| pi `engine-model` 校验 | `launch.ts:163,204-212`；manager `recordEngineModel`（`manager.ts:170-175`） | 事件内容不依赖时间；`requestedModel` 来自启动参数 | 可从 pi 日志重放；同一 provider/model 只报一次（`reportedModels` 是内存 Set），完整重放可复现。不匹配时在线会立即 `failAttempt` 并终止，这个副作用不在日志中，需要重放时重新执行或依赖已持久化的 failure。 |
| `first-output` | `launch.ts:158` | **时间依赖**：触发条件是“normalizer 产生了非空 records”，但时间戳是 `new Date().toISOString()` | 条件可重放；**精确时间不可从厂商日志得到**。manager 目前用 `'stream'` 持久化 `firstOutputAt`（`manager.ts:79`），崩溃窗口可能丢失。建议改为同步持久化或由日志包装器写时间戳。注意 launcher 自己的 3 条 records 不触发它（`first-output` 只在 decodeLines 回调里置位），重放时必须保持“只由厂商行触发”。 |
| `decodeLines` 行长上限 | `scope.ts:328-394` | 纯字节流逻辑，不依赖时间；但 overflow 诊断依赖累计 `vendorBytes`/`vendorFrames` | 从日志开头完整重放可复现；从中间开始会改变累计值。`end()` 会 flush 最后一个无换行行（`scope.ts:380-390`），在线 `complete` 先 `lines.end()`（`launch.ts:235`），重放也要在进程真正结束后再 end。 |
| `complete()` | `launch.ts:233-248` | 需要进程退出码和 `cancelled`（来自 `kill()` 的内存标记） | 退出码可由外壳文件提供；`cancelled` 必须持久化或在重接时从 `task.status='cancelling'`/取消意图恢复。`complete` 会在失败日志追加 `stderrTail`/`lastVendorError`（`launch.ts:242`），重放要能从 stderr 日志重建这两个值。 |
| manager `JsonlParser` 限制 | `protocol.ts:13,27,30,32` | 在线 records 流的累计字节/行/记录数 | 如果从日志重放后把“全部 records”再喂给新的 JsonlParser，会重新触发 2 MiB/128 KiB/1000 条限制；应只喂持久化游标之后的新 records，或为 replay 使用不带这些在线限制的解析器。 |

### 2.3 pi-guard 的作用

`guardPiLaunch(launch, check)` 只包装 pi：在真正启动 pi 前先调用 `check(input.model)` 确认模型存在；失败则发出 `error` 并 `finish(1,null)`，不启动 pi；成功则启动 inner，并转发 `first-output`/`stderr-tail`/`vendor-error`/`engine-model`/`identity`/`error`，stdout/stderr 通过 pipe 转发；close 前等待两个流 drain 最多 2 秒（`src/main/adapters/cli/pi-guard.ts:8-10,45-79,83-85`）。

对重接的影响：

- 模型预检只在**启动时**发生；重接已有 scope 时不应该重新跑预检，否则会因为外部模型列表变化而误杀正在运行的 worker。
- 如果在预检期间服务退出，尚未创建 scope，库里可能只有 `run` 而没有 `scopeUnit`（`manager.start` 在 adapter.start 之前已持久化 run，`manager.ts:70`）；这种任务没有可接回的进程，只能按“launch 未完成”失败/重试。
- 预检通过后 inner 启动的窗口里，`GuardedPiAgent` 的 `scopeUnit`/`pid` getter 才返回 inner 的值（`pi-guard.ts:35-37`）。当前 task 路径在 `manager.start` 后立即 `observe`，若此时 inner 还没赋值，`scopeUnit` 不会入库；后续第一条 record 触发 `observe` 才会补写。这个窗口对“崩溃后仍能接回”是危险的，应使用同步 `beforeSpawn`（见 4.3）。
- pi-guard 的 `kill` 在 inner 未启动时只设置 `cancelled`，不会启动 pi（`pi-guard.ts:39-43`）；重接后的取消应直接操作 scope，不经过 guard。

---

## 3. manager 的 Running 状态、计时器与持久化节奏

### 3.1 Running 字段

`src/main/manager.ts:12`：

```ts
interface Running { child: ManagedProcess; timeout?: NodeJS.Timeout; killTimer?: NodeJS.Timeout;
  error?: string; result?: string; cancelled: boolean; stderrBytes: number; stderrTail: string;
  adapterTail?: boolean; vendorError?: string; firstTimer?: NodeJS.Timeout }
```

| 字段 | 用途/来源 | 重启后是否需要恢复 | 说明 |
|---|---|---|---|
| `child` | 当前 `ManagedProcess`（scope 包装） | 需要以“attach 对象”重建 | 没有它，`cancel()`/`terminate()` 无法操作 scope（`manager.ts:127-139,187-190`）。 |
| `timeout` | 仅 mock 的测试超时（`executionTimeoutMs` 对 real/native 返回 undefined，`manager.ts:15-19,47,75`） | 否（real 没有） | 不要为 real 重新引入执行超时。 |
| `firstTimer` | real 的 120 秒 no_output 计时（`manager.ts:78`） | 需要，但应从 `startedAt` 计算剩余，不能重启后重新给 120 秒 | 首次输出事件会清除（`manager.ts:79`）；close 也会清除（`manager.ts:104`）。若崩溃后 `firstOutputAt` 已持久化，则不应再计时；若没有，需要判断是否已超过 `startedAt+120s`。 |
| `killTimer` | `terminate` 发 SIGTERM 后 1500ms 强杀（`manager.ts:187-190`） | 取消中的任务需要恢复 | 重启后若 `task.status='cancelling'`，应重新发起终止并重建 killTimer；否则 `cancel()` 对 cancelling 直接返回（`manager.ts:130`）。 |
| `error` | 失败原因（failAttempt/stop/解析错误） | 已通过 `task.failure` 同步持久化（`manager.ts:164-168`） | `run.error` 本身在内存；重接时可由 `task.failure` 判断任务已失败，不应再接回。 |
| `result` | `result` record 的 summary（`manager.ts:203`） | 事件/artifact 已持久化；`run.result` 本身没有单独字段 | close 判断成功依赖它（`manager.ts:111,118`）。重放时需从日志重建最后一个 result，且不要重复写事件。 |
| `cancelled` | `cancel()` 设置（`manager.ts:139`） | 需要：`task.status='cancelling'` 已持久化（`manager.ts:137-138`） | 仅靠退出码 143 无法区分“用户取消”和“vendor 自己退出 143”；必须用持久化意图。 |
| `stderrBytes` | mock 的 32 KiB 上限（`manager.ts:98-99`） | 否（real 不使用） | real 的 stderr 只有 adapter tail。 |
| `stderrTail` | 最后 2048 字符的脱敏 stderr（`manager.ts:80,93`；adapter 侧 `launch.ts:217`） | 建议持久化/可从 stderr 日志重建 | close 失败时写入 `failure.stderrTail`（`manager.ts:114`）；在线中途不落库。 |
| `adapterTail` | 是否由 adapter 提供 tail（`manager.ts:80`） | 可由“execution==='real' && 有 adapter”推导 | mock 与 real 的 stderr 处理不同（`manager.ts:93-100`）。 |
| `vendorError` | 最后一次 vendor-error 的 2048 字符（`manager.ts:81`） | 建议持久化或从日志重放重新分类 | close 失败时写入 `failure.vendorError`（`manager.ts:114`）；时间相关的 `retryAt` 需要额外处理。 |

### 3.2 计时器与 close 语义

- `manager.start` 在 spawn 前先把 `task.run`（id/adapter/execution/status/startedAt/engine/model/effort/workspace）写库（`manager.ts:53-70`），然后 `adapter.start`，再设置 `task.run.pid`、`observe`、同步 persist（`manager.ts:71-124`）。
- real 的 `firstTimer` 从 start 时开始 120 秒（`manager.ts:78`）；`first-output` 到达时清除（`manager.ts:79`）；close 清除（`manager.ts:104`）。
- `killTimer` 只在 `terminate` 中创建（`manager.ts:188`）；close 清除（`manager.ts:104`）。
- close 时：先 `parser.finish()`（仅在非 error/cancelled；`manager.ts:105`），删除 running，更新 `run.status='stopped'`、`endedAt`、`exitCode`、删除 `pid`（`manager.ts:106-109`），再按 cancelled/error/code/result 决定任务状态（`manager.ts:110-119`）。成功要求 `run.result` 存在且 `code===0`（`manager.ts:111,118`）。
- `record()` 在 `run.cancelled` 或 `run.error` 时丢弃 records（`manager.ts:192`）；如果 `run.result` 已设置，后续 record 直接抛 `Records after terminal result are not allowed`（`manager.ts:193`）。重放时如果重复喂已应用过的 result 之后的记录，会误触发这条错误；必须用游标只喂新记录。
- `failAttempt()` 会清 `firstTimer`、写 `task.failure`、置 `run.error`、发 error 事件并**同步** persist，然后终止（`manager.ts:164-168`）。

### 3.3 写库节奏

- `persist(task, durability='sync')` 自增 revision，调用 `store.put(task,durability,this.fatal)` 并 `notify()`（`manager.ts:216`）。
- 同步写：start 前（`manager.ts:70`）、start 后 pid/observe（`manager.ts:124`）、cancel（`manager.ts:138`）、failAttempt（`manager.ts:167`）、close（`manager.ts:119`）。
- 流式写：每条 record（`manager.ts:205`）、每条 stderr（`manager.ts:100`）、first-output（`manager.ts:79`）、engine-model 事件（`manager.ts:174`）。`store.put('stream')` 只是放进 `pending`，500ms 后 checkpoint（`src/main/store.ts:98-107`）；`flush()` 在事务中落盘（`store.ts:64,104`）。
- 结论：崩溃最多丢失约 500ms 的流式事件/evidence；重放必须从**已提交到 DB 的最后位置**继续，不能假定内存中的 `running` 还在。`TaskStore` 的构造函数接受 `checkpoint` 回调，并在事务提交时调用（`store.ts:22,49-65`），适合用来推进 replay 游标（先落库，后推进游标）。

### 3.4 重放最大的坑：重复写事件/artifact

- `event()` 每次生成新的 `randomUUID()` 和 `new Date().toISOString()`（`src/main/domain/tasks.ts:19-22`），artifact 的 id 也是 `randomUUID()`（`manager.ts:199-202`）。从日志开头重放并重新调用 `record()` 会产生**新的事件/artifact id**和重复的总结，无法靠内容去重。
- 因此重接必须持久化一个“已应用到 DB 的 records 游标”（例如已应用的 record 序号/对应的 raw stdout 字节偏移），重放时：
  1. 从日志开头重建 normalizer 状态（保证后续 `push` 与在线一致）；
  2. 对游标之前的 records 只更新内存状态/校验，不写库；
  3. 只把游标之后的新 records 交给 `record()`/`persist()`；
  4. 游标必须在 DB 事务提交后推进（见 3.3 的 checkpoint）。
- 如果只持久化“最后一个 result 的 hash”而不持久化游标，遇到 `result` 之前的 log/artifact 重复仍无法去重；raw stdout 日志本身没有 record 编号。
- 当前 manager 的 `JsonlParser` 限制（`protocol.ts:13,27,30,32`）意味着重放不能简单把完整 records 流再喂一遍；应该只解析新后缀，或使用不带在线配额的重放解析器。

### 3.5 启动恢复现状

`recoverInterruptedTasks(store)` 在 runtime 打开 store 后立即执行（`src/main/runtime.ts:209-210`），对每个 active task：把 `status` 改为 `failed`，`run.status='stopped'`、写 `endedAt`、删除 `pid`，写一条 “Interrupted by app exit. No worker was resumed” 的 error（`src/main/application/tasks/recovery.ts:5-9`）。它**不检查 scope、不读日志、不保留 invocation**；这是重接方案要替换的核心行为。注意它在 manager/StallMonitor 创建之前运行（`runtime.ts:237-240`），新逻辑若要 attach 到 manager，需要调整初始化顺序或在 manager 构造后执行。

---

## 4. task.run 已持久化的字段，以及 scopeUnit/invocation

### 4.1 AgentRun 现有字段

`src/shared/contracts/tasks.ts:35-40`：

| 字段 | 含义 | 写入位置/时机 |
|---|---|---|
| `id` | 本次 attempt id | `manager.start` 创建（`manager.ts:53-60`），start 前 sync persist（`:70`） |
| `adapter` | 适配器名（mock-jsonl/routing/真实 kind） | 同上 |
| `execution` | real/mock/native | 同上 |
| `status` | running/stopping/stopped | start 前 running；cancel 时 stopping（`:137`）；close stopped（`:109`） |
| `engine`/`model`/`effort`/`workspace` | dispatch 冻结参数 | start 前（`:59`） |
| `scopeUnit` | systemd scope 名（无 `.scope` 后缀） | `observe()` 从 `child.scopeUnit` 复制（`:209`），start 后 sync persist（`:122-124`） |
| `evidence` | engine/requestedModel/requestedEffort/workspace/role/promptPath/sessionDir/vendorSessionId/vendorModel/usage/terminal | `observe()` 从 `child.evidence` 复制（`:210-214`）；每次 record 前调用（`:195`），close 时再调用（`:109`） |
| `pid` | 启动时 child/systemd-run exec 的 pid | start 后 `task.run.pid = child.pid`（`:122`）；close/恢复时删除 |
| `firstOutputAt` | 首次厂商 record 时间 | `first-output` 事件（`:79`）；`'stream'` 持久化 |
| `startedAt` | 开始时间 | start 前（`:58`） |
| `endedAt` | 结束时间 | close（`:109`）、cancel 分支（`:133`）、recovery（`recovery.ts:7`） |
| `exitCode` | close 时的 code | close（`:109`），`number|null`；success 要求 0 |
| `evidence.terminal` | pending/success/error/cancelled/missing/truncated | 初始 pending（`launch.ts:151`）；close 时由 `normalize.finish` 设置（`launch.ts:241`） |

`publicTask()` 会从对外视图中删除 `pid`（`src/main/application/tasks/records.ts:12`），所以 pid 不是 UI/owner 依赖的字段。`store.writeTask` 把除 events/artifacts 外的整个 task 作为 JSON body 写入 `tasks.body`（`src/main/store.ts:67-70`；表结构 `src/main/migrate.ts:12`）。因此给 `AgentRun` 增加普通 JSON 字段**不需要表迁移**；只有需要索引/查询的列才需要改 schema。

### 4.2 scopeUnit 与 invocation

- `prepareCliAgentInput` 生成 `unit = weaver-cli-${engine}-${8hex}`（`src/main/adapters/cli/launch.ts:121`）；`CliAgent` 保存为 `scopeUnit`（`launch.ts:128,150`）。
- `scope` 轮询 `systemctl --user show <unit>.scope -p InvocationID -p MainPID ...`，拿到 invocation 后发 `identity`（`src/main/adapters/cli/scope.ts:173-183`），stop 时的 `requireOwned` 也会补发（`scope.ts:196-202`）；`CliAgent` 只是把 `identity` 原样转发（`launch.ts:169`）。
- **任务路径没有消费者**：`TaskManager` 在 `start` 中只监听 `first-output`/`stderr-tail`/`vendor-error`/`engine-model`（`manager.ts:77-83`），没有 `identity`；`AgentRun` 里也没有 invocation 字段。`pi-guard` 虽然把 `identity` 加入转发列表（`pi-guard.ts:9`），但 manager 仍不消费。
- **schedule 路径已有完整先例**：`StoredRun.process={unit,invocation}`（`src/main/schedules/store.ts:4`）；`beforeSpawn` 在启动前把 `unit` 写入 claim（`src/main/schedules/service.ts:296-303`）；`proc.on('identity', ...)` 调 `persistCliInvocation` 写入 invocation（`service.ts:324,344-351`），只接受 32 位十六进制，且 unit 必须匹配；恢复时 `recoverOwnedScope(unit, invocation)` 校验后再停止（`scope.ts:79-123`）。任务路径应复用这个模式。

### 4.3 当前启动持久化窗口

- `manager.start` 先写 `task.run`，再 `adapter.start`（`manager.ts:70-72`），然后才写 `pid`/`scopeUnit`（`:122-124`）。如果服务在 `adapter.start` 之后、`:124` 之前崩溃，DB 里已有 `run` 但没有 `scopeUnit`，无法安全接回。
- `RoutingWorkerAdapter.start` 直接调用 `this.launch({...})`，没有传 `beforeSpawn`（`src/main/adapters/routing.ts:35-44`）；`startCliAgent` 本身支持 `beforeSpawn`，且会在 `new CliAgent` 前调用（`src/main/adapters/cli/launch.ts:269-275`）。schedule 已利用它（`schedules/service.ts:303`）。
- 结论：任务路径应把 `prepared.unit`、`prepared.stateDir`、日志/退出码路径通过 `beforeSpawn` 同步入库，然后才 spawn；`invocation` 在 `identity` 事件到达后同步入库。否则崩溃窗口会留下无法归属的 scope。

---

## 5. 取消、重试、stall、vendor-limits、tasks health 对进程的依赖

### 5.1 取消与重试

- `manager.cancel(id)` 对 running 任务执行：取 `this.running.get(id)`，没有就抛 `No active worker`（`manager.ts:136`）；设置 `task.status='cancelling'`、`run.status='stopping'`、同步 persist，再 `run.cancelled=true; terminate(run)`（`manager.ts:137-139`）。
- `terminate` 先 `run.child.kill('SIGTERM')`，1500ms 后 `kill('SIGKILL')`（`manager.ts:187-190`）。
- 重启后 `running` Map 是空的；`cancel()` 对状态仍为 `running` 的任务会抛 `No active worker`；对已经是 `cancelling` 的任务则在 `manager.ts:130` 直接返回，**不会继续终止**。所以重接必须：
  - 为每个可接回的 running/cancelling 任务建立 attach 对象并放入 `running`；
  - 对 `cancelling` 任务恢复“终止 + 等 close + 写 cancelled”的流程；
  - attach 对象的 `kill` 应走 systemd scope（校验 invocation 后 `systemctl kill -s SIGTERM --kill-whom=all`，再按需 SIGKILL/stop），而不是依赖旧 pid。
- 重试：`Retries.retry` 在 `cancel:true` 且原任务非终态时调用 `manager.cancel(original.id)`（`src/main/application/scheduling/retry.ts:117-140`）；因此“重启后还能取消”是重试功能的前置条件。除此之外 retry 只操作 store/dispatch，不依赖旧进程。

### 5.2 stall 监控

- 候选任务：`status==='running' && dispatch.execution==='real' && run.scopeUnit`（`src/main/stall.ts:321`）。
- CPU 采样：`readCpu(task.run.scopeUnit)`（`stall.ts:326-332`），默认 `systemdCpuUsage` 用 unit 名查 `CPUUsageNSec`/`ControlGroup`，再读 cgroup `cpu.stat`（`src/main/monitors/cpu.ts:18-34`）。**不使用 pid**。
- `samples` 是进程内 `Map`（`stall.ts:178`），重启后丢失；但 monitor 每次 tick 先采样再判断，`idleSince` 需要至少 2 个样本（`stall.ts:72-85,329-331`），所以重启后不会仅凭旧状态立即误判；`tests/main/stall.test.ts:446` 覆盖“重启后先采样再判断”。
- 重接后只要 `scopeUnit` 仍在库里，CPU 采样可立即恢复；但要注意“scope 已结束但任务还是 running”的情况：`systemdCpuUsage` 对不存在的 unit 返回 null，`idleSince` 不会把 null 当空闲证据（`stall.ts:80,88-96`），因此不会误判 stall；`taskHealth` 仍可能显示 `waiting_model`（见 5.4），应在健康判断前先确认 scope 状态。
- `StallMonitor` 从不取消/杀死任务（`stall.ts:169-171` 注释与 `check` 实现），所以它不需要 pid，也不应成为重接的阻碍。

### 5.3 vendor-limits

- `VendorLimits` 只读 `task.failure`（`kind` 为 `rate_limit`/`quota`），按 `task.run?.id ?? task.id` 做去重键（`src/main/application/scheduling/vendor-limits.ts:28-60`）；不读进程、pid 或 CPU。
- 构造时把已有 failure 的 attempt 加进 `vendorBlockedAttempts`，避免重启后对历史失败重复写 block（`vendor-limits.ts:20-21`）。
- 因此重接若从日志重放出一个尚未持久化的 vendor 错误，需要：先按正常路径写 `task.failure`（同步），再让 `applyVendorBlocks` 只处理一次；如果 failure 已经持久化，重放不应再次 block。`run.id` 已持久化，可作为幂等键。
- `retryAt` 依赖分类时的 `now`（`vendor-errors.ts:47-50,151-158`）；重放时若重新分类相对 `retry-after`，得到的 `retryAt` 可能与在线不同，进而影响 block 的 `release_at`。需要持久化 `vendorError`/`retryAt` 或用原事件时间分类。

### 5.4 tasks health

- `StallMonitor.taskHealth(task)` 不读 pid：使用 `task.run.scopeUnit`、`task.events.at(-1)?.at`、`run.startedAt`、`run.firstOutputAt` 和内存 CPU samples（`src/main/stall.ts:223-263`；注册在 `src/main/runtime.ts:244-248`）。
- 重启后：
  - `lastEventAt` 来自已持久化 events（`event()` 写 `updatedAt` 和 events，`domain/tasks.ts:19-22`；store 持久化 events）；
  - `firstOutputAt` 已持久化时可直接用；
  - CPU samples 为空，`cpuActive` 为 null，`cpuIdleMs` 为 null；
  - 如果 silence 已超过 5 分钟且 CPU 未证明活跃，health 可能暂时显示 `waiting_model`，直到新样本出现（`stall.ts:252-262`）。这是诊断显示问题，不是任务状态；重接首轮应尽快采样。
- 若 scope 已结束但任务仍为 running，`scopeUnit` 仍非空，health 的 `scopeUnit` 会显示旧 unit；应先做 scope 状态核验，再决定是否展示/收尾。

### 5.5 pid/cgroup 的重获

- `pid` 只在 start 时写入（`manager.ts:122`），close/恢复时删除（`:109`；`recovery.ts:7`），且不参与 cancel/stall/health/vendor-limit。它不是重接的必需字段。
- 重接后要拿 pid/cgroup：用 `systemctl --user show <unit>.scope -p ControlGroup` 得到 cgroup 路径，再读 `/sys/fs/cgroup<ControlGroup>/cgroup.procs`。实验确认 `MainPID` 在 scope 上为空（6.1、6.5），不能依赖。现有 `processInScope(pid, unit)` 可校验某个 pid 属于该 cgroup（`scope.ts:317-320`）。
- CPU 重获不需要 pid：`systemdCpuUsage(scopeUnit)` 已按 unit 工作（`monitors/cpu.ts:27-34`），实验也验证 `CPUUsageNSec` 可读（6.5）。

---

## 6. `systemd-run --user --scope` 进程模型实验

所有实验在 `/tmp/weaver-restart-design-FMDYA1/worker-b` 下进行；unit 名均以 `weaver-design-exp-` 开头；没有停止、重启或 kill weaver 服务及其任何已有 scope。

### 6.1 命令是不是服务的直接子进程？MainPID 是什么？

脚本 `exp-tree.sh` 的核心命令：

```bash
systemd-run --user --scope --collect --quiet --unit=weaver-design-exp-tree \
  --working-directory=/tmp/weaver-restart-design-FMDYA1/worker-b \
  -p MemoryHigh=8G -p MemoryMax=10G -p KillMode=control-group \
  -- sh -c 'echo "shell_pid=$$ shell_ppid=$PPID"; cat /proc/$$/cgroup; ps -o pid,ppid,pgid,sid,comm,args -p $$ -p $PPID; sleep 8' \
  > tree.out 2> tree.err &
```

输出摘录：

```text
shell_pid=3394315 shell_ppid=3394312
0::/user.slice/user-1000.slice/user@1000.service/app.slice/weaver-design-exp-tree.scope
    PID    PPID    PGID     SID COMMAND
3394312 3322752 3394312 3394312 bash            bash /tmp/.../exp-tree.sh
3394315 3394312 3394312 3394312 sh              /usr/bin/sh -c echo ...
...
ControlGroup=/user.slice/.../weaver-design-exp-tree.scope
CPUUsageNSec=16931000
Id=weaver-design-exp-tree.scope
LoadState=loaded
ActiveState=active
InvocationID=2d2751f27d45442b8e0bd4d2d24ac3e3
...
LoadState=not-found
ActiveState=inactive
launcher_exit=0
```

结论（本机 systemd 257）：

- `systemd-run` 没有留下独立的 wrapper 进程，它 exec 成了 `sh`；`$!`（3394315）就是命令进程，PPID 是启动它的服务/脚本（3394312）。在 Weaver 中，启动者是 node 服务进程，因此**服务存活时命令是服务的直接子进程**。
- `systemctl show` 对整个 scope 输出 `ControlGroup`/`InvocationID`/`CPUUsageNSec`，但输出中**没有 `MainPID`**；单独执行 `systemctl --user show <unit>.scope -p MainPID --value` 得到空字符串（6.5）。因此 `scope.ts` 中 `if (info?.mainPid) handle.pid = info.mainPid`（`scope.ts:179`）在本机不会生效，pid 仍是启动时的 child.pid；重接时不能靠 MainPID 找进程。
- 命令结束后 `--collect` 卸载 unit：`LoadState=not-found`、`ActiveState=inactive`。

### 6.2 父进程/服务退出后谁收养？worker 是否继续？

`parent-orphan.mjs` 用 node 作为“服务”启动 scope，子进程命令为：

```sh
exec >> orphan-worker.log 2>> orphan-worker.err
echo "start pid=$$ ppid=$PPID"
for i in 1 2 3 4 5 6; do echo tick$i; sleep 1; done
echo finish
echo 7 > orphan.exit
exit 7
```

node 在 1.2s 后 `SIGKILL` 自己（模拟服务死亡）。观察输出：

```text
parent_wait=137
--proc
state=S ppid=1646 pgrp=3427398 session=3427398
--cgroup
0::/user.slice/user-1000.slice/user@1000.service/app.slice/weaver-design-exp-orphan.scope
--scope
ControlGroup=/user.slice/.../weaver-design-exp-orphan.scope
LoadState=loaded
ActiveState=active
InvocationID=dd923677a0a245feb9b414421c592072
--log
start pid=3427407 ppid=3427400
tick1
tick2
tick3
tick4
--parent alive?
no
--final log
start pid=3427407 ppid=3427400
tick1
tick2
tick3
tick4
tick5
tick6
finish
--exit file
7
--scope after
LoadState=not-found
ActiveState=inactive
--child exit file
missing
```

结论：

- 在本实验（普通 node 父进程被 SIGKILL，模拟服务退出）中，命令进程被 **systemd --user**（PPID 1646）收养，而不是被杀死；scope 保持 active，`InvocationID` 不变。
- 日志继续写入 `tick5`/`tick6`/`finish`，说明 **stdout/stderr 指向文件 fd 时，父进程退出对 worker 没有影响**：fd 由子进程继承，文件仍可写。
- 退出码文件 `orphan.exit` 写入 `7`；因为父进程已死，没有任何进程收到 child 的退出状态（`orphan-child-exit` 不存在）。
- scope 结束后 `--collect` 正常卸载。

### 6.3 如果 stdout 还是 pipe，会发生什么？

`parent-pipe3.mjs` 用 pipe 作为 stdout/stderr，node 在 3s 后 SIGKILL 自己；命令每 0.5s 写一行。输出：

```text
-- log
1792642673.726625024 start pid=3479477
1792642673.727169219 tick1
...
1792642676.241111159 tick6
1792642676.742832489 tick7
1792642676.743473439 trap-PIPE
-- scope
LoadState=not-found
ActiveState=inactive
```

结论：父进程死亡后，pipe 读端关闭；worker 下一次写 stdout 触发 `SIGPIPE`（示例在 `tick7` 后立即进入 `trap-PIPE`），worker 退出。**当前 scope.ts 的 pipe 传输不是 restart-safe 的**；改成文件 fd 是必要的，不是可选优化。

### 6.4 父进程不在时如何取得退出码？

**(a) 正常结束，父进程在场**：`wait`/`child.on('close')` 得到命令退出码；例如上面的 `launcher_exit=0`、`wait_exit=7`。

**(b) `systemctl show` 的 `Result` 不可当退出码**：

```text
$ systemd-run --user --scope --collect --quiet --unit=weaver-design-exp-exit7 \
    --working-directory=/tmp/... -p KillMode=control-group -- sh -c 'exit 7'
wait_exit=7
$ systemctl --user show weaver-design-exp-exit7.scope \
    -p LoadState -p ActiveState -p Result -p ExecMainStatus -p ExecMainCode -p InvocationID -p MainPID --no-pager
Result=success
LoadState=loaded
ActiveState=active
InvocationID=a58b...
# 立即查询时 unit 仍可能处于 active；稍后：
Result=success
LoadState=not-found
ActiveState=inactive
InvocationID=
```

`ExecMainStatus`/`ExecMainCode` 没有输出；`Result=success` 即使命令 `exit 7` 也一样。**不能用 `Result` 判断成功，也不能用 `show` 取退出码。**

**(c) 外壳文件**：`sh -c 'cmd; code=$?; printf ... > exit.tmp; mv exit.tmp exit; exit $code'` 在正常结束时可靠写入退出码（实验中的 `orphan.exit=7`）。

**(d) 取消/信号**：给 shell 安装 `trap ... TERM` 后，`systemctl kill -s SIGTERM --kill-whom=all` 会执行 trap；实验输出：

```text
$ systemctl --user kill -s SIGTERM --kill-whom=all weaver-design-exp-cancel.scope
wait_exit=143
--exit file
143
--log
start
tick
tick
--scope after
Result=success
LoadState=not-found
ActiveState=inactive
```

没有 trap 时，SIGTERM 可能让 shell/子进程直接死亡，退出码文件不会产生；`SIGKILL` 则**没有任何机会**写文件（6.2 的父进程 SIGKILL 实验也说明只有预先存在的退出码文件/日志可读）。因此：
- 取消场景必须持久化“取消意图”，不能只依赖退出码文件；
- 外壳最好同时写“信号/退出码”信息，并采用临时文件+rename，避免读到半写文件；
- 启动失败（命令未执行）也会没有退出码文件，需按 early_exit 处理。

### 6.5 重接身份、cgroup、CPU

`parent-reident.mjs` 在父进程死亡前后读取同一个 scope：

```text
--before
ControlGroup=/user.slice/.../weaver-design-exp-reident.scope
ActiveState=active
InvocationID=5c9b3862ec994aa3b574cd20a04019f3
--after
child=3541165
state=S ppid=1646
cgroup=0::/user.slice/.../weaver-design-exp-reident.scope
ControlGroup=/user.slice/.../weaver-design-exp-reident.scope
CPUUsageNSec=2906000
LoadState=loaded
ActiveState=active
InvocationID=5c9b3862ec994aa3b574cd20a04019f3
cgroup.procs=3541165 3542093
--diff invocation
before=InvocationID=5c9b3862ec994aa3b574cd20a04019f3 after=InvocationID=5c9b3862ec994aa3b574cd20a04019f3
```

结论：

- `InvocationID` 在父进程死亡前后保持不变，可作为“同一个 scope”的持久化身份。
- `ControlGroup` 可读；`cgroup.procs` 提供当前进程列表（示例是 shell + sleep），可用于重获 pid。
- `CPUUsageNSec` 可直接读，适配 `systemdCpuUsage`（`monitors/cpu.ts:27-34`）。
- `MainPID` 仍为空（`systemctl show -p MainPID --value` 输出空字符串），不能作为 pid 来源。

### 6.6 实验 scope 回收确认

创建的 scope：`weaver-design-exp-tree`、`-mainpid`、`-mainpid2`、`-exit7`、`-orphan`、`-pipe`、`-pipe2`、`-pipe3`、`-cancel`、`-reident`。实验结束检查：

```text
$ systemctl --user list-units 'weaver-design-exp-*' --all --no-legend
（无输出）
$ systemctl --user show 'weaver-design-exp-*.scope' -p Id -p ActiveState -p InvocationID --no-pager
（无输出）
```

`reident` 在读取后被本 worker 用 `systemctl kill -s SIGKILL --kill-whom=all` 结束，随后 `LoadState=not-found`；`orphan`/`pipe3` 等均自然结束或被父进程死亡触发退出。**自建 scope 已全部回收；未触碰 weaver 服务或其他已有 scope。**

---

## 7. 现有测试清单（tests/ 下）

### 7.1 scope / 进程生命周期

| 文件 | 覆盖点 |
|---|---|
| `tests/cli/cli-providers-lifecycle.test.ts` | 真实 owned scope：杀死 detached 孙进程、零退出、取消等待、SIGKILL 升级、pipe 持有者、超大 frame 解码（`decodeLines`）。 |
| `tests/cli/cli-providers-streaming.test.ts` | 真实 systemd scope 下的 pi fixture、transport 字节、`scopeUnit`、结束后 cgroup 回收和 evidence。 |
| `tests/integration/schedules-agent-scope.test.ts` | 真实 systemd scope 的 schedule 路径：成功/缺 terminal、取消、崩溃后重启恢复、invocation 缺失/不匹配保护；由 `WEAVER_SCHEDULE_SCOPE_TEST=1` 和 `WEAVER_SCHEDULE_SCOPE_ROOT` 开启（`tests/integration/schedules-agent-scope.test.ts:10-12`；测试在 `:163,200,238,288`）。 |
| `tests/main/im-parent-scope.test.ts` | `keepStdinOpen`、stdin 写入、close 前流 drain。 |
| `tests/main/schedules-recovery.test.ts` | `recoverOwnedScope`：重启终止持久化 UUID scope、不可验证身份阻塞、cancel 意图、invocation 校验、只接受精确 CLI unit 名、late launcher 清理（`:27-230`）。 |

### 7.2 manager / 运行记录

| 文件 | 覆盖点 |
|---|---|
| `tests/main/manager.test.ts` | mock 完成、queued/running 取消、shutdown 终止、result 后超时、malformed/非零退出等。 |
| `tests/main/worker-startup.test.ts` | `first-output` 排除 launcher records、120s `no_output`、vendor-error 提前失败、close 后 diagnostic 保留（`:22-59`）。 |
| `tests/main/run-record.test.ts` | 运行中 evidence/prompt/session 暴露、DB reload 后保留（`:36-102`）。 |
| `tests/main/dispatch-guard.test.ts` | `scopeUnit`/evidence 持久化、vendorSessionId 截断（`:260-273`）。 |
| `tests/main/opencode-rate-limit.test.ts` | stderr 限流样本使 attempt 失败并停止 scope（`:38-57`）。 |
| `tests/main/pi-model-guard.test.ts` | pi 模型预检、缺失模型不启动、取消 pending check、`engine-model` 上报/不匹配失败（`:114-201,239-312`）。 |
| `tests/main/task-start.test.ts` | drain 后恢复、root start 返回、late host 清理（`:71-80`）。 |

### 7.3 recovery / 重启

| 文件 | 覆盖点 |
|---|---|
| `tests/main/store.test.ts` | `recoverInterruptedTasks` 把 running 改为 failed、删除 pid、run.status stopped（`:15-22`）。 |
| `tests/main/native-dispatch.test.ts` | native 任务重启后保留、不启动进程（`:93-110`）。 |
| `tests/main/task-start.test.ts` | drain 后 `recoverInterruptedTasks` 把未完成 real 任务标记 failed（`:71-80`）。 |
| `tests/main/schedules-agent-execution.test.ts` | schedule 直接 CLI：重启恢复持久化 unit 为 interrupted、不重放 goal（`:362-388`）；持久化 exact invocation（`:559-591`）。 |
| `tests/main/schedules-recovery.test.ts` | 同上，`recoverOwnedScope` 的 fail-closed 行为。 |

### 7.4 stall / health / vendor blocks

| 文件 | 覆盖点 |
|---|---|
| `tests/main/stall.test.ts` | 静默/CPU idle 判定、重启后先采样再判断（`:446`）、惩罚持久化（`:845`）、`taskHealth`（`:1132`）、monitor stop fence。 |
| `tests/main/task-diagnostics.test.ts` | `tasks.health` 只反映 monitor 自己的观察，未观察 CPU 为 null（`:80-112`）。 |
| `tests/main/monitor-mechanisms.test.ts` | `MonitorLifecycle` 合并 tick、stop/abort fence、start 重臂（`:182-...`）。 |
| `tests/main/engine-unblock-recovery.test.ts`、`block-atomicity.test.ts`、`policy-block-sequences.test.ts`、`worker-startup.test.ts` | vendor/stall block 与 router 的交互、block 原子性、失败重路由。 |
| `tests/cli/cli-wait-stall.test.ts` | CLI `tasks wait`/`watch` 对 health/stalled 的轮询。 |

### 7.5 后续写失败测试的建议落点

- `tests/main/manager.test.ts`：新增 attach/re-attach 单测（fake scope + 持久化 run，模拟崩溃后 new manager）。
- `tests/cli/cli-providers.test.ts` 或新建 `cli-normalize-replay.test.ts`：六引擎“在线 push vs 完整日志重放”的等价性；dsh tool map 必须从开头重放；`finish` 的 cancelled/truncated/error/missing 矩阵。
- `tests/main/worker-startup.test.ts`：restart 后 first-output 已存在时不再触发 120s；未输出且已超时则失败并终止。
- `tests/main/run-record.test.ts` / `store.test.ts`：新增字段（invocation、日志路径、游标）round-trip；`recoverInterruptedTasks` 的新行为（可接回 / 已结束收尾 / 不可验证失败）。
- `tests/integration/schedules-agent-scope.test.ts` 的模式可复制成 worker 的真实 systemd 集成测试：scope 存活 → 杀控制器 → 新进程接回并继续读日志 → 读退出码文件 → 只写一次 result；以及 invocation 缺失/不匹配 fail-closed。
- `tests/main/stall.test.ts` / `task-diagnostics.test.ts`：scope 已结束时 health 不应显示旧的 running/scopeUnit；重启后 CPU 样本重建。

---

## 8. 重启接回需要新增持久化的字段清单

### 8.1 现有字段（已可复用）

| 字段 | 来源 | 写入时机 | 用途 |
|---|---|---|---|
| `task.status` | `manager.start/cancel/close` | 状态变化 sync | running/cancelling 是重接入口 |
| `task.dispatch.engineKind`/`adapter`/`model`/`effort`/`workspace` | dispatch 冻结 | dispatch 时 | 选择 normalizer、校验 |
| `task.packageId` | dispatch | dispatch 时 | 任务/包关联，重放不直接需要 |
| `task.failure` | `failAttempt`/close | sync | 已失败的任务不再接回；vendor block 依据 |
| `task.events` / `task.artifacts` / `task.summary` | `record`/close | stream/sync | 已应用输出；重放需去重 |
| `run.id` | `manager.start` | start 前 sync | attempt 幂等键 |
| `run.adapter`/`execution`/`status`/`startedAt`/`engine`/`model`/`effort`/`workspace` | `manager.start` | start 前 sync | 重接判断 |
| `run.scopeUnit` | `observe()`（`child.scopeUnit`） | start 后 sync（`manager.ts:122-124`）；close 再写 | scope 身份（无 `.scope`） |
| `run.evidence.*`（engine/requested*/workspace/role/promptPath/sessionDir/vendorSessionId/vendorModel/usage/terminal） | `observe()` | 每次 record 前/close | 重放校验；`terminal` 在崩溃时可能仍是 pending |
| `run.pid` | `child.pid` | start 后；close/恢复删除 | 仅诊断；重接可从 cgroup.procs 重获，不是必需 |
| `run.firstOutputAt` | `first-output` 事件 | stream（`manager.ts:79`） | no_output 判断；建议改为 sync |
| `run.endedAt` / `run.exitCode` | close | sync | 终态；重接可由退出码文件重写 |

### 8.2 建议新增（按“是否阻塞正确重接”排序）

| 字段（建议名） | 含义 | 来源 | 写入时机 | 必要性 |
|---|---|---|---|---|
| `run.scopeInvocation` | systemd scope 的 32 位 `InvocationID` | `identity` 事件（`scope.ts:173-183,196-202`；`launch.ts:169`） | 收到 identity 后**同步** persist；仅当 unit 匹配 | **必须**：没有它无法证明 active scope 属于本 attempt；现有 `recoverOwnedScope` 对 active CLI 缺 invocation 直接 fail-closed（`scope.ts:93-99`）。 |
| `run.stateDir` | 每次 run 的私有目录 | `PreparedCliAgent.stateDir`（`launch.ts:98-100`）；`RoutingWorkerAdapter` 的 `join(stateRoot,task.id)`（`routing.ts:33`） | `beforeSpawn` 同步 | **必须**：日志/退出码/prompt 都在这里，重接必须知道路径。 |
| `run.logs.stdout` / `run.logs.stderr` / `run.logs.exitCode` | 三个文件路径 | 启动包装器决定，放在 stateDir | `beforeSpawn` 同步 | **必须**：重放输入和退出码来源。 |
| `run.replay.stdoutOffset` / `run.replay.stderrOffset` | 已应用到 DB 的原始日志字节偏移 | 重放器/管理器计算 | 每次 DB 事务提交后推进（利用 `TaskStore` checkpoint，`store.ts:22,49-65`） | **必须**：避免重复写事件/artifact；只重放新后缀。 |
| `run.replay.appliedRecords`（或 `lastRecordSeq`） | 已应用的 normalized record 序号 | normalizer 重放/管理器计数 | 与 offset 一起在事务提交后推进 | **必须**：raw offset 与 record 对应关系需要固定；`JsonlParser` 有 1000 条限制（`protocol.ts:32`），不能把全量记录再喂一遍。 |
| `run.replay.valid` / `run.logTruncated` | 日志是否完整（文件缺失、被截断、轮转） | 重放器在打开/校验时 | 发现异常时 sync | **必须**：日志不完整时不能假装重放成功；应 fail closed 或标记 unverified。 |
| `run.cancelRequestedAt` / `run.cancelSignal` | 用户取消意图与信号 | `manager.cancel`（`manager.ts:127-139`） | 与 `status='cancelling'` 同一事务 sync | **必须**：退出码 143 不能区分取消与 vendor 自己退出；SIGKILL 无退出码文件。已有的 `task.status='cancelling'` 可作最低限度意图，但记录信号/时间更可靠。 |
| `run.noOutputDeadline` | 120s no_output 的绝对截止时间 | `startedAt + 120000`（当前逻辑 `manager.ts:78`） | start 时 sync；或重接时按 `startedAt` 计算 | **建议必须**：否则重启会把 120s 重新计一遍，或永远不再计时。 |
| `run.vendorError` | 最后一次 vendor-error 的 2048 字符 | `vendor-error` 事件（`manager.ts:81`） | 事件到达时 sync（当前只在 failure 中带） | **建议**：close 失败路径需要它（`manager.ts:114`）；可从 stderr 日志重放，但 `retryAt` 时间相关。 |
| `run.stderrTail` | 最后 2048 字符脱敏 stderr | adapter tail（`manager.ts:80`）/ stderr 日志 | 与 failure 同事务，或只依赖日志重放 | **建议**：close 失败诊断；如果 stderr 日志完整，可重建。 |
| `run.resultSummary` | 最后一个 result 的 summary | `record` 的 `result` 分支（`manager.ts:203`） | 应用 result record 时 sync | **建议**：close 成功判断用；也可从 events/artifact 重建，但需要游标避免重复。 |
| `run.scopeEndedAt` / `run.exitCodeReadAt` | scope 结束/读到退出码的时间 | 重接检查者 | 发现 inactive 时 sync | 可选：诊断和防止重复收尾。 |
| `run.lastVendorErrorAt` / `run.lastStderrAt` | 事件时间 | 日志行时间/文件 mtime | 可选 | 可选：帮助重放时间相关分类；不是核心正确性。 |
| `run.logDev`/`run.logInode` | 日志文件身份 | `fs.stat` | `beforeSpawn`/打开时 | 可选：检测文件被替换/轮转；没有轮转时可省略。 |

### 8.3 不建议依赖的字段/值

- `run.pid`：可持久化用于展示，但重接不要依赖；scope 的 `MainPID` 在本机为空（6.5），且 pid 会变/被收养。
- `systemctl show` 的 `Result`/`ExecMainStatus`：`--collect` 后不可靠；`Result=success` 甚至在 `exit 7` 时出现（6.4）。
- 仅 `task.status='cancelling'` 而不记录取消信号：SIGKILL 时无法区分“用户取消”与“异常终止”。
- 仅 `scopeUnit` 而不记录 invocation：active scope 的 unit 名可能被替换；现有 `recoverOwnedScope` 对 CLI 明确要求 invocation（`scope.ts:93-99`）。

---

## 9. 未确认点与风险（不臆测）

1. **systemd 版本差异**：进程模型实验只在 systemd 257/Debian 13 上执行。`systemd-run --scope` 是否在所有版本都 exec 成命令、`MainPID` 是否总为空、`--collect` 后 `Result` 是否总是误导，需要目标机器验证；本文不把单机结果当作跨版本保证。
2. **`Result=success` 的窗口**：实验看到即使 `exit 7`，unit 短暂显示 `active` 且 `Result=success`，随后 `not-found`；没有验证 journal 是否保留可靠退出状态，也没有把 journal 当作 API。结论是“不要依赖”，不是“任何情况下都返回 success”。
3. **跨流顺序**：stdout 与 stderr 是两个文件，重放无法恢复在线时两个 stream 的相对到达顺序。特别是 `vendor-error`（stderr）可能在 `result`（stdout）之前/之后到达，manager 在线会立即 `failAttempt`；仅按文件重放需要额外规则（如“任何 vendor-error 都使本次 attempt 失败”），本次没有用真实 vendor 验证这种竞态。
4. **未完成 stderr 行**：在线 probe 会处理没有换行的尾部；重放器必须显式保留这个行为。本文只验证了代码路径和 pipe/file 行为，没有用真实厂商“无换行后挂起”的样本做端到端重放。
5. **日志完整性**：没有实现/验证日志轮转、截断、磁盘满、fsync。重放的前提是完整、连续的 raw 日志；如果日志被截断，normalizer 的 `unparsed`/`dshTools`/append 文本都可能不完整，必须标记 `logTruncated` 并 fail closed，不能补造。
6. **退出码外壳的信号语义**：SIGTERM trap 可以写 143；SIGKILL 不能。`systemctl stop`/`KillMode=control-group` 对 shell 与子进程的信号顺序、trap 是否一定执行，取决于具体命令和 shell；没有对所有引擎做真实取消实验。
7. **`sh -c` 包装的 argv/引号**：本次实验只是 `sh -c` 固定命令；真实引擎 argv 含 `--`、路径、模型名等，包装器必须用位置参数（如 `sh -c '...' sh "$@"`）而非字符串拼接；未验证所有引擎的 argv 在包装后不变。
8. **原始日志的敏感信息**：当前 CliAgent 在写 records/stderr 前做 `redactSecrets`（`launch.ts:216-232`），raw vendor stdout 可能包含凭据。直接落盘 raw 日志需要 0600 权限，并在重放生成事件前执行同样的脱敏；本次没有评估所有厂商的敏感输出面。
9. **重放游标与 500ms stream 写**：`TaskStore.put('stream')` 的 pending 在内存，崩溃可能丢 500ms（`store.ts:98-107`）。重放游标必须和 DB 提交绑定；如果只按内存中的最后 record 推进，重启后会漏写或重复。本文建议使用 `TaskStore` 的 checkpoint 回调（`store.ts:22,49-65`），但没有实现验证。
10. **任务路径的 `beforeSpawn` 接线**：当前 `RoutingWorkerAdapter` 不传 hook（`routing.ts:35-44`），`startCliAgent` 支持但未被任务路径使用（`launch.ts:269-275`）。这是明确的代码改动点；本文没有修改仓库。
11. **native/owner 路径**：`recoverInterruptedTasks` 对 native 和 owner host 有特殊处理（`recovery.ts:5-9`）；重接只应针对 `execution==='real'` 且 `run.scopeUnit` 存在的 worker attempt，不能影响 native 的 owner 报告语义。
12. **服务关闭语义**：当前 `runtime.close()` 调用 `manager.shutdown()`（`runtime.ts:274-290`），后者会 cancel 所有 running 并等待 close（`manager.ts:153-160`）。目标方案要求“服务停机不再取消 worker”，因此 shutdown 必须改为不 cancel、只 flush/关闭；本次没有改动，风险是漏掉其他关闭路径（如 `commands.drain`、schedules.stop）。
13. **真实 `weaver.service` 的退出方式未实测**：6.2 杀死的是普通 node 父进程，不是 systemd 管理的 `weaver.service`。scope 与 service 分属不同 cgroup，理论上 systemd 停止 service 不会杀死 scope；但 systemd 的 `KillMode`、service stop 顺序、user manager 的 subreaper 行为需要在实际服务上复验。不要把 6.2 的单机结果直接当成“任何 systemd stop 都保留 worker”的保证。

---

## 10. 一句话交付结论

normalizer 的重放能力已经足够：六个引擎从完整日志开头重放都能得到与在线一致的 records/evidence，`finish` 的 cancelled/truncated/error/exitCode 语义也清晰。真正要补的是运行态持久化与生命周期：`scopeInvocation`、日志/退出码路径、replay 游标、取消意图、no_output 截止时间；以及用 systemd scope 的 `ControlGroup`/`cgroup.procs` 重新获得 pid/cgroup（不要依赖 `MainPID`），并在 scope 已结束时只信外壳写出的退出码文件。实验已模拟验证：父进程退出后 worker 可在 `systemd --user` 下继续、文件日志不受影响，而 pipe 会在下次写时因 SIGPIPE 死亡。
