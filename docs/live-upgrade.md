# Weaver 服务随时升级/重启设计方案（live-upgrade）

> 目标读者：weaver 服务端开发者。目标：在任意时刻停机升级或重启 weaver 服务（`systemctl --user restart weaver.service`、二进制替换、崩溃），运行中的任务 worker 不中断、结果只交付一次。
> 事实依据：本方案的现状描述以两份只读事实报告为准——报告 A `docs/verification/live-upgrade/process-inventory.md`（服务进程/链路/停机行为）与报告 B `docs/verification/live-upgrade/run-pipeline-reattach.md`（normalizer 可重放性、manager 运行态、systemd scope 实验）；两轮外部审查原文见同目录 `chatgpt-review-r1.md`、`chatgpt-review-r2.md`；源码引用均用 `路径:行号` 标注，行号以基线 `b3bcd2b` 检出为准，已逐项核对。
> 本轮修订（v3）：同一 Convorel 任务第二轮审查（ChatGPT Pro，结论未通过，源码基线 `b3bcd2b`）的 R1–R3 经 owner 对照基线源码逐条核实成立，全部采纳；审查意见二中的锁顺序（统一为先锁后开库）、致命优先级作用域、real spawn 返回时机与 UI 延迟取舍，以及可选补强（flock 不变量、三个针对性切点）一并采纳；owner 自查小项（乱码、`wait` 取码、§17-#13/#15/#23 改写、失效引用、附录字段）同步修正。按审查轮次上限（每个决策版本最多 2 轮），v3 由 owner 最终决定，未再提交第三轮外部复审；R1–R3 均采用审查方给出的修正方向。逐条映射见文末“修订记录：v2 → v3”。v2 修订历史保留在文末。

## 0. 目标与结论（先说结论）

1. **随时停机**：服务停机（`manager.shutdown`）不再取消运行中 worker，改为 detach：停止 tailer、有界等待在途 identity 落库、按游标 flush，任务保持 `running`。升级即“停旧进程、起新进程”，无需排空。停机同时阻止尚未完成的 pi 预检在关库后继续 launch（§4.4、B12）。
2. **worker 存活**：worker 进程（厂商 CLI）不再把 stdout/stderr 接到服务进程的 pipe，而是直接写 `stateDir` 下 `0600` 文件；服务退出不再导致 `SIGPIPE`（报告 B §6.3 已实验证实 pipe 会死、文件 fd 不受影响）。
3. **服务是唯一写库者**：worker 内不运行任何 weaver 代码；新服务进程在持有单例锁、打开数据库前不做任何恢复写（§10.4），按持久化的 `scopeUnit + scopeInvocation`（或 FD 正向证据补回的 invocation，见 §11.4）核验归属后，从日志文件重放并继续跟踪；scope 已结束时读外壳写出的 `exit` 文件收尾。结果只写一次的保障来自**重放游标 + finish 收尾批次 + 同一 `writeTask` 事务**（见 §6）。
4. **只发布已提交状态**：IPC/HTTP 的 `tasks.get/events/results` 与通知只读已提交快照；`checkpoint` 回调发生在 COMMIT 之前，不得用于发布事件或删日志（§6.5）。`tasks wait/watch` 以业务终态 + `run.finalizedAt` 双提交为 terminal 条件（§11.1，§14.2 引用）。
5. **恢复按 run 生命周期枚举**：凡已记录启动意图、尚未确认 launcher/scope 清理完成或尚未完成收尾提交的真实 run 都进入恢复，包括 `task.status=failed` 的 run；最终 manifest 只在收尾事务提交后发布，发布后不变（§11.1、B4）。启动许可（`run.launchPermittedAt`，`beforeSpawn` 同事务提交，§4.2）未提交的 preparing run 可安全回 `queued + scheduled`；许可已提交后绝不因零日志/无 exit 自动重排，无意图缺 exit 以“执行结果未知”（failure kind `unknown_outcome`）失败收尾，重试由 owner 显式操作（§11.2）。
6. **过渡约束**：当前版本停机仍取消 worker，回滚会把新字段任务标 failed 且不杀 scope、留下孤儿（§12 回滚流程变更，另见 §15.3）。因此**第一次升级到新版本必须先排空**（`weaver server stop` 在无 running 任务时执行一次）；**回滚必须先在新版本上 `server stop --cancel-workers`（或确认无运行中 worker）再降级**；之后任意时刻可重启。
7. **“恰好一次”的承诺范围**：每个 attempt 的持久事件投影与最终结果在 SQLite 中恰好提交一次，manifest 发布后不变；owner 以 `attemptId + manifestDigest` 做消费幂等。外部投递（投递动作本身）恰好一次需另有持久投递记录与消费方幂等协议，**不在本方案范围**（§6.6）。
8. **分期**：P1 任务 worker 重接 + CLI 重连 + 停机语义（含 B3/B4/B10/B11/B12 的文件级改动，见 §16）；P2 schedules 同一文件模式 + 可接回（其中 claude-native direct 运行因 stdin 为持续打开的管道，**明确不支持跨重启**，保持现有 interrupted 语义，见 §16）；P3 飞书 IM 父 Agent host 存活与重连（部分待验证）。P1 含 native 交接：有容量的 native dispatch 在接纳事务内登记并直接返回 `run_subagent`，排队 native 由 wait 以 `reason='handoff'` 交回同一 attempt（§14.2、§16-P1）。

---

## 1. 现状根因：为什么现在不能随时重启

四个根因，按“停机瞬间发生了什么”的顺序排列：

### 1.1 worker 的 stdout/stderr 是接到服务进程的管道，事件解析与结果判定全在服务内存

`startOwnedScope` 用 `stdio: [promptFd ?? 'pipe', 'pipe', 'pipe']` 启动 scope（`src/main/adapters/cli/scope.ts:148`），并把 `child.stdout/child.stderr` 直接暴露给 `CliAgent`（`src/main/adapters/cli/scope.ts:152-153`）。`CliAgent` 把厂商行交给 `decodeLines` → normalizer → 自身 `stdout` 的 JSONL（`src/main/adapters/cli/launch.ts:154-165,227-232`），`TaskManager` 再用 `JsonlParser` 解析并 `record()` 写库（`src/main/manager.ts:85-101`）。服务进程退出 = 管道读端消失 = **worker 下一次写即 `SIGPIPE` 死亡**（报告 B §6.3 在 systemd 257 上实测：父进程死后约 0.5s 进入 `trap-PIPE`）。不断开管道也无消费者：新进程没有任何订阅者能接到旧管道。

### 1.2 `runtime.close → manager.shutdown` 主动取消所有运行中 worker

`close()` 顺序为 `im.close()` → `commands.drain()` → `schedules.stop()` → `stall/freeProbe/quota/greetings` → `ownerDrain` → `inflight` → `manager.shutdown()` → `store.close()` → `http/vite/ipc`（`src/main/runtime.ts:274-293`）。而 `shutdown()` 对每个 running 任务调 `cancel()`（running→cancelling，`cancelled=true`，`terminate()` 发 `SIGTERM`，1500ms 后 `SIGKILL`），等待全部 `close` 后 `store.flush()`（`src/main/manager.ts:153-160`，`terminate` 见 `src/main/manager.ts:187-190`）。即：**正常停机必然杀死全部 worker**，这是“升级必须排空”的直接原因。

### 1.3 启动时 `recoverInterruptedTasks` 把非 native 的 running/cancelling 直接标 failed

`startRuntime` 在建 store 后立即执行恢复（`src/main/runtime.ts:210`），把所有 `active()`（`status` 为 running/cancelling，`src/main/domain/tasks.ts:5`）且 `run.execution !== 'native'` 的任务标 `failed`，事件写 “Interrupted by app exit. No worker was resumed”（`src/main/application/tasks/recovery.ts:5-9`，`src/main/runtime.ts:210`）。它不检查 scope、不读日志、不保留 invocation——这是重接方案要替换的核心行为（新逻辑必须在 manager 构造后执行，见 §11）。

### 1.4 `weaver server stop` 的 `SERVER_BUSY` 守卫可被 `systemctl restart` 绕过

`serverStop` 在 `runningWorkers > 0` 且无 `--force` 时返回 `SERVER_BUSY`（“stopping cancels them”，`src/cli/server/lifecycle.ts:150`）。但这只是 CLI 层的守卫；`systemctl --user restart weaver.service` 直接发 SIGTERM 给 service 进程，走 `runForegroundShutdown → close()`（`src/cli/commands/web.ts:88-105`），**不经过 `serverStop`**，于是 1.2 的取消路径照常执行。

**实例证据**（owner 核实）：2026-10-19 09:46:19Z 的一次 `weaver.service` 重启，在同一秒取消了 3 个运行中任务（`814b91a3`、`63413d76`、`56e298e4`）。这正是 1.2 + 1.4 叠加的结果：restart 绕过守卫 → shutdown 取消 worker → 新进程把残留 running 标 failed。

### 1.5 若只改“不取消”，重启后仍会断开的链路（摘要）

报告 A §5 逐条列出 9 条断链，本方案必须逐一承接，承接点散见后文：

| # | 断链 | 承接节 |
|---|------|--------|
| 1 | stdout/stderr 管道断开，无消费者 | §3（文件模式）、§5（同一 tailer） |
| 2 | 进程内 `running` Map（child/firstTimer/killTimer）丢失 | §8（计时器）、§9（取消）、§11（reattach 重建） |
| 3 | 归属证明 InvocationID 未入库 | §4（`scopeInvocation` + FD 正向证据 §11.4） |
| 4 | schedule claim 的内存 job/围栏丢失 | §16-P2 |
| 5 | IM host 控制 socket 断开、host 自杀 | §16-P3 |
| 6 | Herdr owner host 本来就没有控制通道 | 不变（§11 保持豁免） |
| 7 | HelloJobs/stall 采样/quota inflight 丢失 | stall 按 unit 采样可恢复（§11.2 第 2 条）；quota 由 schedule 补齐 |
| 8 | 本地 IPC discovery 轮换，在飞 wait 失败退出 | §14（CLI 重连）+ §10.4（discovery 原子发布） |
| 9 | HTTP 长连接与 inflight RPC 丢失 | 浏览器重连已有退避；任务流以新 `serverInfo.startedAt` 为准 |

---

## 2. 方案对比：选定方向与否决的备选

### 2.1 选定：worker 内不运行任何 weaver 代码；厂商 CLI 的 stdout/stderr 直接写 stateDir 文件；服务仍是唯一写库进程

- worker 侧只有厂商 CLI + 一层固定 `sh` 外壳（写 exit 文件），无 weaver relay、无 JSON 解析、无 DB 访问。
- 服务侧：正常运行时从日志文件 tail（`fs.watch` + 定时轮询兜底），重接时从日志开头重放 normalizer 到游标处再继续 tail。**在线与重接是同一条 tailer 路径**，重接逻辑持续被执行，不会腐烂。
- 跨版本只有一个兼容面：旧版本产生的**原始厂商日志字节**（新版本 normalizer 必须能读，见 §12）。
- 收尾只有一个提交面：finish 批次与终态在**同一事务**提交，已提交 finish 的 run 不再重放（§6.2）。

### 2.2 否决备选 (a)：停机前排空（drain）

只能缩短“有任务时的升级窗口”，不能实现“任意时刻升级”。排空期间新任务无法派发、长任务（数小时）使升级无限推迟；且 `systemctl restart` 照样绕过 CLI 守卫（§1.4），排空不是强制语义。结论：可作为**一次性过渡手段**（§12），不作为方案。

### 2.3 否决备选 (b)：在 scope 内放 weaver relay 直接写 SQLite

理由（两条，每条都是硬伤）：

1. **relay 是长寿命的 weaver 代码**：升级后旧 relay 与新服务**跨版本并存**。库 schema（`SCHEMA_VERSION=11`，`src/main/migrate.ts:4`，高版本直接拒绝启动 `src/main/migrate.ts:167`）、normalizer 语义、`WorkerRecord` 事件格式全部变成跨版本接口；旧 relay 写出的 rows 新服务未必能读，反之亦然。每一次升级都要做多版本兼容矩阵，成本不可收敛。
2. **双写方互相覆盖**：`TaskStore.writeTask` 是**整行覆盖**（`body` JSON 整列 `ON CONFLICT DO UPDATE`，`src/main/store.ts:67-70`），且服务内有 500ms 的 `pending` stream 缓存（`src/main/store.ts:17-64,98-107`）。relay 与服务同时写同一 task 行时，后提交者覆盖先提交者的整行 body（events/artifacts 虽然分表，但 `tasks.body` 内的 `run`、`progress`、`summary` 会丢），500ms 缓存使覆盖窗口更大。正确做法需要行级合并/事务协同，等于重做一套分布式写协调。

因此 relay 方案否决；服务保持**唯一写库进程**，worker 只写文件（文件追加是天然多写者安全的，服务是唯一读者）。

---

## 3. 启动改造：文件模式 + sh 外壳 + exit 文件（设计点 1）

### 3.1 `startOwnedScope` 新增文件模式

签名扩展（`src/main/adapters/cli/scope.ts:124-148` 现状）：

```ts
startOwnedScope({
  command, cwd, env, stdin /* 仍为 prompt 文件 fd */, unit,
  stdoutFile: string;  // 新增：0600，由调用方在 stateDir 下预建
  stderrFile: string;   // 新增：0600
  exitFile: string;    // 新增：外壳写入的退出码文件路径（tmp+rename）
  exitTmpFile: string; // 新增：与 exitFile 同目录的临时文件（§3.3）
  keepFd?: number[];   // 新增：FD 锚定（§11.4）：spawn 前已打开、fstat 并持久化的 run 独占文件 FD
})
```

行为：

- stdout/stderr **不再是 pipe**：以 `O_WRONLY|O_CREAT|O_APPEND, 0600` 打开两个 fd，传给子进程的 `stdio: [promptFd, outFd, errFd]`。父进程（服务）**不持有读端**——服务侧只做文件 tail，见 §5。
- stdin 保持现状：prompt 文件只读 fd（`src/main/adapters/cli/scope.ts:142-149` 的 `promptFd` 逻辑不变）。
- 目录与权限：`stateDir` 0700（沿用 `prepareCliAgentInput` 的 `mkdirSync(..., 0o700)`，`src/main/adapters/cli/launch.ts:98-100`），三文件 0600。事件写库前仍走现有 `redactSecrets`（`src/main/adapters/cli/launch.ts:216-232` 的脱敏点搬到“文件行 → record”处，见 §5.4）。
- FD 锚定（§11.4 的实现前提）：**每个 run 的日志文件先创建、fstat、把 `dev/ino` 持久化到 `run.logIdentity`，再用同一已打开 FD 启动 scope**。不允许“先 stat 路径、spawn 时再 open 一个可能已变化的对象”。

### 3.2 命令包装：固定 sh 外壳 + 位置参数传 argv（不能 exec 引擎）

真实 argv（含 `--`、路径、模型名）**不得做字符串拼接**，必须用位置参数（报告 B §9.7 未验证项的强制要求）：

```sh
sh -c '...外壳... "$@" 0<&0 &' sh <engine> <arg1> <arg2> ...
```

即 `options.command` 的第一个元素是引擎可执行文件，其余原样作为 `"$@"`。外壳行为（硬性规定）：

1. **外壳不 `exec` 引擎**：引擎以后台任务启动并显式保留 stdin——`"$@" 0<&0 &`。原因：非交互 sh 的后台命令默认 `stdin=/dev/null`，不显式重定向则 prompt/持续输入送不到引擎；外壳自身不消费 stdin。
2. **只允许空操作 trap**：`trap ':' TERM INT HUP`。**禁止 `trap '' ...`**：忽略处置会被子进程继承，导致引擎收不到终止信号。
3. **被信号打断后循环 `wait` 直到子进程真实退出**：`wait $enginePid` 被 TERM 打断返回后，**重新进入 `wait`**，直到观测到引擎真实退出状态，再写其真实状态。允许连续 TERM 到达；子进程忽略 TERM 时外壳继续等待（终止升级由服务侧 `killAfter` 阶段推进，见 §9.4，外壳不自作主张 SIGKILL 引擎）。
4. **成功/失败判定与取消意图分开**：外壳只记录“引擎如何退出”（exit code / signal），**不解释**它是取消还是失败。`wait` 的数值状态不得声称为信号的无歧义恢复；分类一律以持久化的取消/失败意图（§9）为准。

外壳伪代码（实现时以此为准，逐引擎验证透明性）：

```sh
trap ':' TERM INT HUP
runid="$WEAVER_RUN_ID"; nonce="$WEAVER_RUN_NONCE"; exitfile="$WEAVER_EXIT_FILE"; tmpfile="$WEAVER_EXIT_TMP"
"$@" 0<&0 &
child=$!
code=0
while :; do
  wait $child && { code=$?; break; } || code=$?
  # wait 被 trap 打断时返回 >128：只要子进程（含 zombie）仍存在就继续等待。
  # kill -0 对 zombie 成功，因此 kill -0 失败只可能发生在已成功回收之后——
  # 但 trap 恰好打断 wait、子进程同时退出的竞态下，首次 wait 返回的 128+n 不是真实状态，
  # 此时必须再执行一次 wait 取真实退出状态；若第二次 wait 返回 127（已无可回收子进程），
  # 说明首次 wait 已成功回收，保留原 code 不覆盖。
  if kill -0 $child 2>/dev/null; then
    continue
  else
    wait $child 2>/dev/null
    status=$?
    [ $status -ne 127 ] && code=$status
    break
  fi
done
printf '{"runId":"%s","nonce":"%s","pid":%s,"code":%s,"signal":%s,"at":"%s"}\n' \
  "$runid" "$nonce" "$child" "$code" "null" "$(date -u +%FT%TZ)" > "$tmpfile"
mv -f "$tmpfile" "$exitfile"
exit $code
```

说明：`signal` 字段在能可靠判定（如外壳自身被 kill 语义穿透的场景由实现补充）时填写，否则 `null` + 非零 code；恢复侧**不依赖**该字段区分取消（§9.3）。

### 3.3 exit 文件：tmp+rename 原子写，内容绑定 runId + nonce

- 路径：`stateDir/exit-<runId>.json`（与日志同目录，`beforeSpawn` 时持久化路径，见 §4）。临时文件必须与最终文件**同目录**（跨目录 rename 不是原子发布），`mktemp` 模板落在同目录。
- 格式（JSON 单行）：`{"runId":"<runId>","nonce":"<hex>","code":7,"signal":null,"pid":1234,"at":"<iso>"}`。其中 `nonce` 由 `beforeSpawn` 生成并持久化（§4.2），外壳通过环境（`WEAVER_RUN_NONCE`）或 argv 传入；读侧校验 `runId + nonce` 双匹配才视为本 run 的合法退出记录。
- 写入：`tmp=$(mktemp exit-XXX.tmp); printf ... > tmp; mv tmp exit`。读侧若发现 `.tmp` 残留或 JSON 解析失败或 `runId/nonce` 不匹配，视为“无合法 exit 文件”（§11 分支 c/待定）。
- **SIGTERM 语义**：外壳安装空操作 trap（`trap ':' TERM`），`systemctl kill SIGTERM` 只打断 `wait`、不杀外壳；外壳继续等到引擎真实退出再写文件。**`SIGKILL` 无法写文件**——这是预期的“无 exit 文件”分支，不做补偿，只按 §11.b/§11.2 分类。
- 服务 `stop()` scope 时的现有语义（TERM→宽限→KILL→stop，`src/main/adapters/cli/scope.ts:203-252`）保持，但 kill 面向文件模式的 scope（unit 名不变）。

### 3.4 失败分支

| 时机 | 现象 | 处理 |
|------|------|------|
| spawn 前 | 参数校验失败/`systemd-run` 返回非零 | 沿用现有 early_exit（`src/main/manager.ts:72-74`），无 scope、无日志 |
| 启动后、identity 前 | 服务崩溃 | DB 有 run + `launchPermittedAt`（§4），无 invocation → §11.2 待定分支（fail closed，不杀，见 §11） |
| 运行中 | 磁盘满导致日志写失败 | 厂商进程收到 `ENOSPC`（行为各引擎不同）；重接时文件大小 < 游标 → 标记截断 → §11.2(c) fail closed，不补造 |
| 结束时 | SIGKILL，无 exit 文件 | §11.2(5)/R1 规则：有取消/失败意图 → 按意图收尾；无意图 → 以 `unknown_outcome`（执行结果未知）失败收尾（写明无退出记录），重试由 owner 显式操作 |
| 结束时 | exit 文件 runId/nonce 不匹配 | 视为无合法 exit 文件；归属不明确 → 恢复待定，不盲杀 |

### 3.5 sh 外壳验收用例（§17 联动，实现前先写）

以下用例覆盖 trap/wait/stdin/并发语义，目标文件见 §17：

1. **TERM 恰好打断 wait**：引擎 sleep 中，外壳 `wait` 时发 TERM → 外壳不退出、不写 exit 文件；引擎随后自然退出 → exit 文件 code 为引擎真实值。
2. **连续 TERM**：wait 期间连续发 3 次 TERM → 外壳仍存活，引擎退出后恰好写一次合法 exit 文件（无重复/截断）。
3. **子进程忽略 TERM**：引擎 trap 忽略 TERM → 外壳继续等待；服务侧按 `killAfter` 升级 KILL（§9.4）后，外壳 `wait` 到 KILL 结果并如实记录。
4. **stdin 确实送达**：prompt 文件内容经 `0<&0` 到达引擎 stdin（断言引擎读到的首字节与 prompt 文件一致）；对照组（去掉 `0<&0`）在非交互 sh 下 stdin 为空，证明重定向必要。
5. **自然退出**：引擎 exit 7 → 外壳不经任何信号即写 `code:7`，`mv` 原子可见，无 `.tmp` 残留。
6. **取消并发**：服务 cancel（TERM→KILL）的同时引擎自然退出 → exit 文件仍只记录真实退出；最终分类以持久化取消意图为准（§9.3），不以 code 143 反推。

---

## 4. 先持久化后启动：`beforeSpawn` + `scopeInvocation` + nonce/identity（设计点 2）

### 4.1 现状窗口

`manager.start` 先写 `task.run` 再 `adapter.start`（`src/main/manager.ts:53-72`），`scopeUnit` 要到 start 后才 `observe()` 入库（`src/main/manager.ts:122-124,207-215`）。`RoutingWorkerAdapter.start` 不传 `beforeSpawn`（`src/main/adapters/routing.ts:35-44`），而 `startCliAgent` 支持但任务路径未用（`src/main/adapters/cli/launch.ts:272-275`）。崩溃窗口：adapter 已 spawn、DB 无 unit → 无法归属的孤儿 scope。

### 4.2 新时序（强制顺序）

1. `prepareCliAgentInput` 生成 `unit/stateDir/promptPath`（`src/main/adapters/cli/launch.ts:98-121`）后，`RoutingWorkerAdapter.start` 传入 `beforeSpawn(prepared)`。
2. `beforeSpawn` 在 **spawn 前、同一 store 事务内**同步写入：
   - `run.stateDir`、`run.scopeUnit = prepared.unit`、
   - `run.logs = { stdout: <stateDir>/stdout.log, stderr: <stateDir>/stderr.log, exit: <stateDir>/exit-<runId>.json }`、
   - `run.nonce = <32hex>`（本次 run 的随机绑定，供 exit 文件与 FD 证据校验）、
   - `run.launchPermittedAt = <iso>`（启动许可：与 unit/nonce/logIdentity 同一事务提交；提交后才允许 spawn；提交前 run 处于 preparing 阶段，见 §4.4/§11.2）、
   - `run.logIdentity = { stdout: {dev, ino}, stderr: {dev, ino} }`（spawn 前预建文件并 `fstat` 的结果；§11.4 的 FD 正向证据锚点）、
   - `run.noOutputDeadline = startedAt + 120s`（§8）。
   同一事务还包含 `task.status='running'`（现状 `src/main/manager.ts:53-70` 的 sync persist 点复用）。
3. `identity` 事件到达（scope 轮询 `systemctl show -p InvocationID`，`src/main/adapters/cli/scope.ts:173-184`；`CliAgent` 转发 `src/main/adapters/cli/launch.ts:169`）→ manager 新增 `identity` 监听，校验 unit 匹配 + 32hex 格式后，**同步**写入 `run.scopeInvocation`。复用 schedules 已有模式（`StoredRun.process={unit,invocation}`，`src/main/schedules/store.ts:4`；`beforeSpawn` 持久化 unit `src/main/schedules/service.ts:296-303`；`persistCliInvocation` `src/main/schedules/service.ts:324,344-351`）。
4. pi-guard 预检窗口（报告 B §2.3）：重接的任务**不重新跑 `guardPiLaunch` 模型预检**；`scopeUnit` 的入库点从“start 后 observe”提前到 `beforeSpawn`，消除 inner 赋值前的崩溃窗口。类型透传见 §4.4。

### 4.3 失败分支

- `beforeSpawn` 抛错 → `startCliAgent` 不 spawn（现状 `src/main/adapters/cli/launch.ts:272-275`），沿用 early_exit。
- identity 校验失败（unit 不匹配/非 32hex）→ 不写 invocation，记事件；该任务只能走 §11.2 待定分支（不可核验）。
- unit 已入库但服务在 spawn 瞬间崩溃 → DB 有 unit 无 invocation，且 `launchPermittedAt` 已提交 → 按 §11.2 R1 规则处理（恢复待定，fail closed，**不杀**，见 §11）；只有许可未提交的 preparing run 才回队。
- nonce/logIdentity 写入失败（`beforeSpawn` 事务回滚）→ 等同 `beforeSpawn` 抛错，不 spawn。

### 4.4 `beforeSpawn` 全链路透传 + pi 预检的停机门（B12）

现状断裂：运行时注入的 launcher 是 `guardPiLaunch(startCliAgent, checkPiModel)`（`src/main/runtime.ts:237`），但 guard 返回的函数只接受 `input`，pi 预检结束后同样只调 `launch(input)`（`src/main/adapters/cli/pi-guard.ts:30-58,83-85`）。`routing` 从不传 `beforeSpawn`（`src/main/adapters/routing.ts:35-44`）→ 外层 guard 丢掉参数 → 实际 `startCliAgent` 没有 hook → scope 先启动、归属记录未建立，崩溃窗口仍在。

修正（P1 阻断项）：

1. 扩展 `StartCliAgent` 类型（`src/main/adapters/launch.ts:5`）：`(input: CliAgentInput, beforeSpawn?: (prepared: PreparedCliAgent) => void) => ManagedProcess`。
2. `guardPiLaunch`（`src/main/adapters/cli/pi-guard.ts:83-85`）及一切包装层（`src/main/schedules/service.ts:296-306` 的 `base` 包装、`RoutingWorkerAdapter.start`）**原样透传同一 `beforeSpawn`**：`guard(input, beforeSpawn)` → 预检通过后 `launch(input, beforeSpawn)`。`GuardedPiAgent` 构造延迟到预检通过后，但 `beforeSpawn` 的调用点仍在真正 spawn 之前。
3. **停机门**：detach 必须**有界等待在途 identity 落库**（§10.1），并且**阻止尚未完成的 pi 预检在关库后继续 launch**：`shutdown` 置 `piPreflightGate=closed`；`GuardedPiAgent.begin()` 在真正 `launch` 前复查门状态，若已关闭则放弃 launch（`finish(null,'SIGTERM')` 等价路径，不写 DB、不 spawn）。被中止的预检 run 按启动许可区分：`launchPermittedAt` 未提交（仍处 preparing）→ 回到 `queued + scheduled`（不标 failed，可被 pump 重新启动）；一旦 `launchPermittedAt` 已提交则按正常运行中 run 进入恢复枚举（§11.2“从未启动的判定”），即使 spawn 尚未实际发生也不自动回队。

---

## 5. 单一代码路径：服务从日志文件 tail（设计点 3）

### 5.1 正常运行也走文件，不再有 pipe 路径

- 服务侧 `CliAgent` 不再拥有 `stdout/stderr` PassThrough 作为输入源；输入源改为 `LogTailer`：打开 `run.logs.stdout/stderr`（`O_RDONLY`），从 offset 0（新任务）或游标（重接）开始读。
- 输送机制：`fs.watch`（rename/truncate 感知）+ 定时轮询兜底（默认 250ms，与 `tasks wait` 轮询同量级 `src/cli/poll-task.ts:44-89`）。`fs.watch` 在 Linux 上对 append 不可靠（多编辑器/rename 场景），轮询是正确性兜底，不是优化。
- 输出：tailer 吐出的完整行 → 同一套 `decodeLines`（行长 8MiB 上限，`src/main/adapters/cli/scope.ts:328-394`）→ 同一套 normalizer `push(line)`（`src/main/adapters/cli/normalize.ts:115-165`）→ records → 同一套 `record()` 写库（`src/main/manager.ts:191-206`）。
- sh 外壳**全程保留锚定 FD**（§11.4）：外壳从启动到退出持有日志文件的写 FD，即使引擎关闭/重定向 stdout/stderr，FD 证据仍可能成立。

### 5.2 重接与在线共用同一 tailer

重接 = `new LogTailer(logPaths, cursor)` + `createNormalizer(engine)` 从日志开头重放到 `cursor.stdoutOffset`（只重建 normalizer 状态，不写库），然后继续正常 tail。新任务 = `cursor = 0` 的同一种构造。**没有第二套解析路径**，重接路径每天（每次重启）都被执行，腐烂即被发现。

### 5.3 行边界与截断

- `decodeLines` 的 8MiB 行长上限与 overflow 诊断保留；从开头重放时累计 `vendorBytes/vendorFrames` 与在线一致（报告 B §1.3）。
- 日志文件被截断（大小 < 游标 offset，或 `dev/ino` 与 `run.logIdentity` 不符）：标记 `run.logTruncated=true`，走 §11.2(c)（归属已证实则先终止 scope 再收尾，见 §11.3-B6）。

### 5.4 脱敏点

`redactSecrets` 从“`CliAgent` 写 records/stderr 前”（`src/main/adapters/cli/launch.ts:216-232`，`src/shared/redact.ts:1-43`）搬到“文件行 → record/event 写库前”。原始日志文件**保留未脱敏字节**（保证重放按字节确定性，§7），文件权限 0600 + 目录 0700 是唯一的保护（§13）。

---

## 6. 重放游标与写库原子性（设计点 4）

### 6.1 数据结构（`tasks.body` JSON 内，无需表迁移）

```ts
run.replay = {
  stdoutOffset: number;   // 已提交到 DB 的 stdout 字节偏移
  stderrOffset: number;   // 已提交到 DB 的 stderr 字节偏移
  appliedRecords: number; // 已提交的 normalized record 序号（单调递增）
};
run.finalizedAt?: string; // 收尾事务提交时刻（B1 幂等标记；与 finishApplied 等价）
run.launchPermittedAt?: string; // 启动许可提交时刻（§4.2/§11.2 R1 判据；未提交 = preparing）
run.logIdentity?: { stdout: {dev:number;ino:number}; stderr: {dev:number;ino:number} };
run.nonce?: string;       // 32hex，本 run 绑定
```

放在 `task.run` 内，随 `TaskStore.writeTask` 整行 JSON 入库（`src/main/store.ts:67-70`）。新增 `AgentRun` 普通 JSON 字段**不需要表迁移**（报告 B §4.1；表结构 `src/main/migrate.ts:12`，迁移本身每版本单事务 `src/main/migrate.ts:163-178`）。

### 6.2 收尾批次：finish 输出独立幂等边界，与终态同一事务（B1，P1 阻断项）

背景：真实引擎的 `artifact/result` 不是某条日志行直接产生的——`normalizer.push(line)` 只累计状态，成功时的 `result.md` 与 `result` 在 `finish()` 中一起产生，随后 `CliAgent.complete()` 先发这批 records 再发 `close`（`src/main/adapters/cli/normalize.ts:136-162`、`src/main/adapters/cli/launch.ts:233-247`、`src/main/manager.ts:103-120,191-206`）。反例：最后一条日志已应用、游标到 EOF → `finish()` 生成 artifact/result → `resultSummary` 已同步 → **manager.close 把任务改成 completed 之前被 SIGKILL** → 重启看到游标在 EOF，从头重建 normalizer 再次 finish → 重复 artifact/result，或从 `resultSummary` 恢复 `Running.result` 后又应用 finish 输出 → `manager.ts:193` 抛 `Records after terminal result are not allowed`。

规则：

1. `normalizer.finish()` 的输出属于**独立收尾批次**，不对应新增日志字节，**不能仅凭 stdoutOffset/stderrOffset 去重**。
2. 该批次的全部 records、resultSummary、最终 evidence、最终游标、`run/task` 终态与收尾事件在**同一事务**提交，并记录 `run.finalizedAt`（等价 `finishApplied` 标记）。失败收尾（failed/cancelled 同理）同样需要该标记——**不得以存在 `resultSummary` 作为唯一判断**。
3. 恢复时已提交 `finalizedAt` 的 run **只恢复收尾材料，不再执行 finish、不再应用 finish records**；close 允许幂等续办（终态已提交则跳过写）。
4. `run.resultSummary`（最后一个 result 的 summary，`src/main/manager.ts:203`）仍在应用 result record 时同步持久化，但它只是摘要缓存，不是 finish 幂等边界。

### 6.3 行批次原子：一行先算完、一次形成快照（B2）

背景：一条厂商行可产生多条工具记录（`src/main/adapters/cli/normalize.ts:340-355`），`JsonlParser` 在第 1001 条 record 抛错（`src/main/protocol.ts:29-33`），先前 records 已在 `pending`（`src/main/manager.ts:85-88,183-206`，`src/main/store.ts:98-107`）；`stop()` 只置内存 `run.error` 开始终止，不回滚本行已进 pending 的部分 → 500ms flush 或 detach flush 把“第一个事件 + 旧 offset”提交 → 重启重放产生重复事件。

规则：

1. 把**一整行作为一个应用批次**：先验证并计算该行的全部 records 与旁路效果（事件、artifact、firstOutput、vendor 分类），再**一次性**形成包含行末 offset 的 task 快照并 `put`。
2. 不得把前半行先交给可被 flush 的 `pending`：行处理失败时，不得留下该行的部分事件、artifact 或游标。
3. 同步持久化的旁路（firstOutput、错误分类）同样纳入对应输入批次的提交规则（见 §7.4、§8.2）。
4. 继续保留 500ms 批量落库（`src/main/store.ts:105-107`），不必每行同步写。关键不变量：**pending 中的每份 task 快照自身必须满足“该游标之前的整行效果完整存在”**。
5. `stream` durability 的 500ms `pending` 缓存意味着崩溃最多丢 500ms 已 `put` 未 `flush` 的事件；重接游标以 **DB 已提交位置**为准（重读 `store.get`，且仅在新进程 pending 为空时成立，见 §6.5），不以内存 tailer 位置为准。`shutdown` 时 `store.flush()`（`src/main/manager.ts:159` 现状保留）把 detach 前的进度落盘。

### 6.4 重放流程（重接时）

1. 打开日志文件，校验存在、可读、大小 ≥ 游标 offset、`dev/ino` 与 `run.logIdentity` 一致（否则 §11.2(c)）。
2. `normalizer = createNormalizer(engine)`；从字节 0 按行 `push` 到 `stdoutOffset`：**只更新 normalizer 内部状态，不调用 `record()`，不写库**。
3. `offset` 之后的新行：正常 `push` → records → 按 §6.3 行批次 → 写库 → 推进游标。
4. **禁止把全量 records 再喂给 `JsonlParser`**：manager 的在线 `JsonlParser` 有 1000 条/2MiB/128KiB 限制（`src/main/protocol.ts:13,27,30,32`）。重放只喂“游标之后的新 records”，或对重放使用不带在线配额的直调 `record()`。违反此条会触发 `Records after terminal result are not allowed`（`src/main/manager.ts:193`）或误报超限。

### 6.5 只发布已提交状态（B3，P1 阻断项）

背景：`TaskStore.get()` 优先返回 pending（`src/main/store.ts:77-80`），`tasks.events` 用此值（`src/main/application/tasks/queries.ts:53-56`），CLI 会立即输出事件并保存 UUID 游标（`src/cli/poll-task.ts:45-59`）。反例：事件 E 与游标进 pending 未 flush → watch 读到 E、`after=E.id` → 崩溃 → E 与游标都未提交 → 新服务重放产生同内容、不同 UUID 的 E′ → watch 带旧 `after` 请求 `CURSOR_EXPIRED`（`src/main/application/tasks/queries.ts:55`）。若简单清空 `after` 重读，则重复输出已交付事件。

规则：

1. 对外可续接事件流（`tasks.get/events/results`）与通知**只发布已提交事件**，通知在实际 COMMIT 后发出。
2. `store.get()` **不能被普遍称为“读取数据库已提交位置”**；仅当新进程刚创建、pending 为空时才成立。`store.listHeads/listSummaries` 的 pending 合并（`src/main/store.ts:83-97`）同样只用于本进程在线读，对外发布时必须过滤未提交部分（实现方式：发布层只读 `writeTask` 已提交行，或维护独立的已提交序列号水位）。
3. 纠正 `checkpoint` 语义：`TaskStore` 构造接受 `checkpoint` 回调并在事务中调用（`src/main/store.ts:22,49-65`），其调用点（`src/main/store.ts:60`）位于 `storage/transaction.ts:34-35` 的实际 `COMMIT` **之前**——它是“提交前钩子”，**不是提交成功回调**。文档此前若暗示其可靠性，必须纠正：**不得用它发布事件或删除日志**。日志删除只允许在收尾事务提交后（§13）。
4. UI 显示延迟是取舍而非回归：对外只读已提交意味着 UI 的 list/get 入口看到的状态最多延迟约一个 500ms flush 周期；实现须覆盖 UI 的 list/get 入口，且定时 flush 的实际 COMMIT 也要触发通知，不能只覆盖同步 `put`。

### 6.6 游标幂等与“恰好一次”承诺范围

- `appliedRecords` 与 `task.events/task.artifacts` 的对应关系由“事务提交顺序”固定；重放已应用区段永不调用 `record()`，因此事件/artifact 的 `randomUUID()`（`src/main/domain/tasks.ts:19-22`，`src/main/manager.ts:199-202`）不会重复生成。result 只写一次的证明见 §17 测试。
- 承诺收敛为：**每个 attempt 的持久事件投影和最终结果在 SQLite 中恰好提交一次；最终 manifest 发布后不再变化。owner 可以重复读取同一结果，并以 `attemptId + manifestDigest` 做消费幂等。外部投递或消费副作用若要求恰好一次，需要对应的持久投递记录与消费方幂等协议**（`Results.deliver` 现只支持 mock，`src/main/application/tasks/results.ts:17-21`；`manifestDigest` 去重见同文件 `:19`）——**不在本方案范围**。仅靠日志游标不能证明外部消费者在“已消费、尚未 ack 时断开”后不重复处理。

---

## 7. stderr 与 vendor-error：尾部重建与分类规则（设计点 5）

### 7.1 现状的两条 stderr 路径

- 完整行：`stderrTail` 每次完整行更新、24KiB 上限（`src/main/adapters/cli/launch.ts:153,216-226`）；manager 侧 2048 字符（`src/main/manager.ts:80,93`）。
- 未完成行：在线 probe 只看当前 stderr 尾部未完成行（`slice(-8192)`），一旦匹配立即发 `vendor-error`，不等换行（`src/main/adapters/cli/launch.ts:182-190`）。这是**部分实时依赖**（报告 B §2.2）。

### 7.2 文件模式下的重建

- `stderrTail`：从 `stderr` 文件尾部重建（读最后 ~24KiB，按行拆分，应用同样的行超长丢弃、PEM 块、脱敏规则；规则现状在 `launch.ts:153,182-190` 与 `redact.ts:14-101`）。
- 未完成行探测：tailer 在每次轮询时，对**当前文件尾部未完成行**（无换行后缀）同样执行 `classifyVendorError`。在线行为保留：不等换行、立即分类。
- `classifyVendorError` 本身内容可重放，但默认用 `Date.now()` 解析相对 `retry-after`（`vendor-errors.ts:47-50,151-158`，报告 B §2.2）。**已提交的分类不随重放漂移**（§7.4）；但停机期间首次出现的相对 retry-after，恢复时只能按恢复时刻估算（见 §18 第 6 项）。

### 7.3 终止依据：分类器返回的致命 TaskFailure（替换原“任一 vendor-error 即 failAttempt”）

原规则（“任一流出现 `vendor-error` 即 `failAttempt`”，`src/main/manager.ts:164-168`）比现行语义更宽，会误杀可恢复的工具错误。现行代码区分广义 `vendor-error` 诊断事件与分类器实际返回的 `TaskFailure`：`launch.ts:154-164,233-247` 可能仅因 `value.error` 存在而发 `vendor-error`，manager 只有在 `failure` 存在时才 `failAttempt`（`src/main/manager.ts:81`）。机制反例：dsh 的 `tool_result` 带 `status:"error", error:"ENOENT"`、随后 turn 正常完成——normalizer 明确把工具失败视为普通 Agent 流程（`src/main/adapters/cli/normalize.ts:454-469`），广义 vendor-error 可被触发但无致命 TaskFailure，任务本可成功；按原正文则会提前终止。

新规则（硬性规定）：

1. **跨流错误优先级只针对已分类为致命 `TaskFailure` 的错误**，不以 `vendor-error` 事件名或普通工具失败作为终止依据。
2. 成功提交前必须**排空两个流并完成分类**（`complete` 先排空 stderr 再调 `normalizer.finish`，现状 `src/main/adapters/cli/launch.ts:233-247` 保留并文件化）。
3. 已提交的取消或失败决定**不可被重放推翻**（恢复门禁，§9.2）。
4. 尚未提交、同时存在的多个致命错误，必须采用明确且稳定的原因选择规则，避免读流顺序改变失败类别、`retryAt` 或自动封禁行为。固定优先级**仅用于同一未提交决策批次内已收集到的候选错误**（**稳定规则，实现与文档双写死**）：
   `auth > quota > rate_limit > model > no_output/early_exit > other`。
   其中 `vendor` 按分类器映射落入对应槽位；同级候选以稳定的来源键（如流名 + 字节偏移）选择，不以分类完成时间选择。**已提交的失败决定保持不变，后续错误只补充诊断；不同批次首次发现的错误不承诺产生相同失败原因**（跨重启不按本优先级重算已提交决定）。

### 7.4 `vendorError` 与 `retryAt` 首次分类时同步持久化

- `vendor-error` 到达且分类器返回致命 `TaskFailure` 时（`src/main/manager.ts:81` 现状只记内存 `run.vendorError`），改为**同步**写入 `run.vendorError`（2048 字符）+ `task.failure.retryAt`（若分类给出），纳入 §6.3 的行批次提交。
- 重放已应用区段时**不重新分类**（游标之前的行跳过 `classifyVendorError`），避免 `retryAt` 随重放时刻漂移、避免重复 vendor block（`VendorLimits` 按 `run.id` 去重，`src/main/application/scheduling/vendor-limits.ts:28-60`；重放若重新 block 会打乱 `release_at`）。
- `run.resultSummary`（最后一个 result 的 summary，`src/main/manager.ts:203`）同样在应用 result record 时同步持久化，供 close 成功判断与重放校验。
- 未完成 stderr 行的 probe **只用于在线观察**；恢复路径只分类完整行。并在此承认：这部分依赖观察时刻——在线看到未完成 `429` 前缀即分类、离线时它可能已变成 `4290 tokens\n` 而不再匹配；**不能把 normalizer 的确定性扩展成整条错误检测链路都确定**。

---

## 8. 计时器：`firstOutputAt` 与 no_output 截止（设计点 6）

### 8.1 现状

real 任务 start 时设 120s `firstTimer`（`src/main/manager.ts:78`）；`first-output` 到达清除并**以 `'stream'` 写 `firstOutputAt`**（`src/main/manager.ts:79`）——崩溃窗口（500ms flush 间隔）可能丢失。`first-output` 触发条件是 normalizer 产出非空 records（`src/main/adapters/cli/launch.ts:158`），时间戳 `new Date().toISOString()`，精确时间不可从日志恢复（报告 B §2.2）。

### 8.2 新规则

- `run.firstOutputAt` 改为**同步持久化**（`durability='sync'`）。
- `run.noOutputDeadline = startedAt + 120s`，在 `beforeSpawn` 同事务写入（§4.2）。no_output 判定改为**绝对时间比较**，不再是“start 后 120s 的 timer”：
  - 在线：timer 照常设 `deadline - now()`。
  - 重接：若 `firstOutputAt` 存在 → 不设 timer；否则 `remaining = deadline - now()`：`remaining <= 0` → 按现有 `failAttempt({kind:'no_output',...})`（`src/main/manager.ts:78` 文案保留）并终止 scope；否则设 timer 为 `remaining`。**重启不再重新给满 120s**。
- 重接时若日志已有厂商 records 但 `firstOutputAt` 缺失（崩溃丢了 stream 写）：以**重接时刻补记**，并在事件中注明 `firstOutputAt approximated at reattach; vendor output already present in log`（近似值标记，诊断用）。
- **执行顺序（硬性）**：**先恢复并检查积压日志中的有效输出，再决定是否执行过期的 no_output；不能在积压日志尚未检查时触发过期 timer**。场景：服务在首次输出前停机，worker 在停机期间已输出有效记录，新服务 120 秒后起来——若先按 `deadline <= now` 调 `failAttempt` 再补读日志，会误杀正常 worker。原始字节没有可靠输出时间戳时，只能确认“恢复时已有输出”，不能精确证明输出发生在原 deadline 之前（此时以“已有输出”为准，不执行 no_output）。

### 8.3 close 语义不变

close 时 `clearTimeout(firstTimer)`（`src/main/manager.ts:104` 现状保留）；`close` 的成功判定（`run.result` 存在且 `code===0`，`src/main/manager.ts:111,118`）不变。

---

## 9. 取消与失败终止：意图持久化、恢复门禁与不重置的终止期限（设计点 7）

### 9.1 现状缺口

`cancel()` 要求 `running.get(id)` 存在，否则抛 `No active worker`（`src/main/manager.ts:127-139`）；重启后 Map 为空，对 running 任务 cancel 抛错、对 cancelling 直接返回**且不继续终止**（`src/main/manager.ts:130`）。`cancelled` 只在内存（`Running.cancelled`，`src/main/manager.ts:12`），退出码 143 无法区分用户取消与 vendor 自退 143（报告 B §1.4）。

### 9.2 新字段与恢复门禁（B7.1）

`manager.cancel` 改为与 `task.status='cancelling'` + `run.status='stopping'`（`src/main/manager.ts:137-138` 现状）**同一事务**同步写入：

```ts
run.cancelRequestedAt: string;  // iso
run.cancelSignal: 'SIGTERM';    // 首选信号；升级为 SIGKILL 时追加记录
run.killAfter: string;          // iso：绝对终止期限（首次请求时固定，见 §9.4）
run.terminationPhase: 'term' | 'kill'; // 当前阶段，只向前
run.recovery?: 'pending' | ...; // 恢复待定标记（§11.2），UI/CLI 可见
```

门禁规则（硬性）：

1. 取消及失败终止意图绑定 `(taskId, runId)`，**在任何记录应用与 finish 之前恢复**。
2. 存在取消或失败决定时，之后的原始输出**仅用于状态重建和诊断，不生成新的可交付结果**：在线 `record()` 的 `run.cancelled/run.error` 短路（`src/main/manager.ts:87,91-93,192`）在重放侧同样生效——§11.2(b) 不得“先应用剩余 records（含 result）再按取消收尾”；应先恢复门禁，`finish` 必须得到正确的 `cancelled`（可读字节重建解析状态，但取消后的未应用输出不再当成可交付结果）。
3. `retry --cancel` 依赖重启后仍可取消（`src/main/application/scheduling/retry.ts:117-140` 调 `manager.cancel`），此字段是其前置条件。

### 9.3 重接对象的 kill 路径

重接为 running/cancelling 任务重建 attach 对象并放入 `running` Map 后：

- cancelling 任务：重新发起终止——校验 invocation 后 `systemctl kill -s SIGTERM --kill-whom=all <unit>.scope` → 宽限（沿用 1500ms，`src/main/manager.ts:188`）→ `SIGKILL` → `stop`。复用 scope 层现有 kill 流程（`src/main/adapters/cli/scope.ts:203-252`）。
- 重启时 cancelling 任务**继续完成终止并按取消收尾**（`cancelled` 分支，`src/main/manager.ts:111`），不因重启变成 failed。
- **退出码 143 不作为取消依据**：close 分类以持久化意图（`status='cancelling'`/`cancelRequestedAt`）为准；vendor 自退 143 且无取消意图 → 按正常 close 收尾（通常 failed，`code !== 0`，`src/main/manager.ts:112-119`）。

### 9.4 绝对 killAfter：重启不延长、不回退（B7.2）

反例：worker 忽略 TERM，每隔不到 1500ms 重启一次；旧 killTimer 消失，新实例又给满 1500ms，KILL 永远不到。同样适用于 vendor-error、协议错误、no_output 引起的终止。

规则：

1. 首次请求终止（cancel、`failAttempt`、协议错误 `stop`）时**持久化绝对 `killAfter`**（`now + 1500ms`，沿用 `src/main/manager.ts:188` 的宽限）与终止阶段（`term`）。
2. 重接只等待 `killAfter - now()` 的剩余时间；过期直接升级 KILL；**阶段不能倒退**（已进入 `kill` 的运行不回到 `term`）。
3. 同样适用于 vendor-error、协议错误、`no_output` 引起的终止（`failAttempt` 与 `stop` 同样写 `killAfter`）。

---

## 10. 停机：`manager.shutdown` 改为 detach（设计点 8）

```ts
async shutdown(): Promise<void> {
  // 不再 cancel。逐个：停止 tailer（fs.watch close + 清 timer）、
  // 有界等待在途 identity 落库（§10.1）、按当前游标 flush，
  // 删除内存 running 条目。任务保持 running/cancelling；DB 状态不做任何终态写入。
  this.piPreflightGate.close(); // 先关门：阻止尚未完成的预检继续 launch（§4.4）
  await this.awaitPendingIdentities(BOUNDED_MS);
  this.store.flush();
}
```

- 现状 `shutdown` 的 cancel+等待 close（`src/main/manager.ts:153-160`）删除；`terminate`（`:187-190`）保留给在线 cancel 用。
- `runtime.close` 顺序不变（`src/main/runtime.ts:280-293`），只是其中 `manager.shutdown()` 不再杀 worker。`commands.drain()`/`schedules.stop()` 的语义由 §16-P2/P3 另行处理；P1 只改任务 worker 路径。
- detach 必须是快速的（不等待 worker 结束）；`store.close()` 前的 `flush` 保证游标落盘。

### 10.1 有界等待在途 identity（A3）

停机 detach 增加**有界等待**：等待已启动、但 `identity` 事件尚未落库的在途 scope 完成 `run.scopeInvocation` 持久化（上限建议 2s，与 scope 启动轮询 50ms（`src/main/adapters/cli/scope.ts:185`）同量级、可配置）。超时仍未落库的 run 按 §11.2 待定分支处理（不杀、恢复待定），不得无限阻塞停机。

### 10.2 初始化失败的清理顺序（与 detach 相同）

reattach 加入后，`startRuntime` 的 startup catch（`src/main/runtime.ts:261-272`）必须扩展：**初始化失败与正常 detach 使用同一清理顺序**——关闭入口和调度，撤销已创建的 tailer、监听器和定时器，等待在途应用结束，flush 并关闭数据库，最后释放单例锁（§10.4）和 IPC。**已 detach 的回调不得继续写库或发起新的 launch**（门状态 + `closed` 检查双保险）。

### 10.3 reattach 在调度 pump 启动、服务 ready 之前完成（A6）

顺序：单例锁（§10.4，开库前取得）→ `store` 打开/迁移 → manager 构造 → **reattach 阶段**（§11）→ 调度 pump 启动 → `ready=true`（`src/main/runtime.ts:250-254` 模式）→ IPC/HTTP ready。此前任何 pump、`tick`、`reconcileAgent` 不得在重接完成前启动新 attempt（否则与恢复中的 run 并发）。

### 10.4 IPC discovery 与单例锁（B10，P1 阻断项）

背景：当前实现先 `open(discoveryPath,'wx')` 创建最终文件，再分别 stat/writeFile/sync（`src/main/local-ipc.ts:205-218`）；启动恢复 `staleEndpoint` 在 JSON.parse 失败时直接放弃判断（`src/main/local-ipc.ts:100-111`），下一次创建又因 EEXIST 失败（`src/main/local-ipc.ts:219-224`）。反例：新实例创建空 `control.v1.json` → 写完整 JSON 前再次 restart → 下次启动不能解析、不能证明可清理 → exclusive create 持续 `ENDPOINT_EXISTS` → worker 存活但控制面起不来。且无崩溃时重连客户端也可读到创建与写入之间的空文件，得 `UNSAFE_ENDPOINT`（`src/main/local-ipc.ts:53-56` 校验）。

规则：

1. **新增单例锁**：打开数据库**前**对 `dataDir` 下锁文件（如 `dataDir/.lock`）取 `flock`（`LOCK_EX|LOCK_NB`；进程死亡内核自动释放）。持有锁的进程是唯一写库者。锁保持到**所有 tailer 停止、pending 写完、数据库关闭后**释放（`close()` 尾部，`src/main/runtime.ts:290-293` 之后）。关闭时锁覆盖在途写入、数据库关闭及本实例 IPC/discovery 清理，全部完成后才释放；释放后不再执行端点清理。
2. **discovery 改为原子发布**：同目录临时文件完整写入并 `fsync` 后 `rename` 原子发布（`src/main/local-ipc.ts:213-218` 的 `open(wx)+writeFile+sync` 改为 `open(tmp)+writeFile+fsync+rename`），**不再兼任进程锁**。
3. 持有单例锁的新进程可安全清理遗留的空或损坏 discovery（能证明无活锁持有者 + 文件不可解析 → 重命名备份后重新发布，不直接删除无备份）。
4. `staleEndpoint`（`src/main/local-ipc.ts:100-121`）保留，但只处理“可解析且可证明死亡”的端点；不可解析文件走第 3 条路径。
5. **锁 FD 不变量**（实现验收条件）：锁 FD 为 `CLOEXEC`，不进入 worker 的 `stdio`/保留 FD（`keepFd`），锁文件不 unlink 后重建。“控制面死亡自动解锁”的前提是没有存活的继承副本（`flock` 关联 open file description，fork/dup 的副本可继续持有锁）；实现必须验收该不变量。

---

## 11. 启动恢复：reattach 阶段替换 `recoverInterruptedTasks`（设计点 9）

### 11.1 接线位置与恢复对象（B4）

现状恢复在 `startRuntime` 建 store 后立即执行（`src/main/runtime.ts:210`），此时 manager/StallMonitor 尚未构造（`src/main/runtime.ts:237-240`）。新逻辑改为**manager 构造后执行的 reattach 阶段**（`runtime.ts:238` 之后、`stall.start()` 之前），因为 attach 对象要注册进 `manager.running` 并启动 tailer。且必须在调度 pump 启动、服务 ready 之前完成（§10.3）。

恢复枚举**不得仅依赖 `task.status`**。所有已经记录启动意图、尚未确认本次 launcher 与 scope 清理完成、或尚未完成收尾提交的真实 run，均进入恢复，**包括 `task.status=failed` 的 run**（`failAttempt` 的顺序是：`task.status='failed'` → 同步持久化 → 调 `terminate` → 真正 close 才写 `run.status='stopped'`，`src/main/manager.ts:103-120,164-168`；而原 §11.2 仅扫描 running/cancelling（`src/main/domain/tasks.ts:5`，方案原第 311 行）——vendor-error 触发 failed 已提交、在发 TERM 前重启，新服务跳过 failed task，旧 scope 继续执行还允许重试，出现两个 worker 同时改工作区）。

规则正文：

> 恢复枚举不得仅依赖 task.status。所有已经记录启动意图、尚未确认本次 launcher/scope 清理完成、或尚未完成收尾提交的真实 run，均进入恢复，包括 task.status 为 failed 的运行。失败决定先持久化，外部进程确认停止后再完成 run 收尾。最终 manifest 只在收尾事务提交后发布（之前 `results` 返回 `RESULT_NOT_READY`），发布后其结果内容保持不变。日志回收和执行资源释放不得仅依据 task 已进入业务终态（见 §13）。

`results.manifest` 仅检查 `terminal(task)` 即生成含 exitCode/failure 的 manifest（`src/main/application/tasks/results.ts:15-24`），close 随后又补字段——owner 可先拿到 M1、close 后拿到 M2，mock 投递按 `taskId+manifestDigest` 去重会视为两个结果。修正后：manifest 在收尾事务（§6.2）提交前不可见，提交后冻结。

> **等待完成与最终结果可读使用同一条件。**对采用本方案文件生命周期的真实 run，只有业务终态与 `run.finalizedAt` 均已提交，`tasks wait/watch` 才以 `reason='terminal'` 返回（基线 `poll-task.ts:62` 只看业务终态，须按本条件修改，见 §14.2、§16-P1）；失败决定已提交但终止/收尾未完成时继续等待，并展示 stopping / recovery pending；到原等待截止按 timeout 返回并保留当前恢复状态。
>
> 此条件只适用于新文件生命周期的真实 run。native/mock 按各自完成条件处理；首次升级前已完成的历史记录（无新字段）保留原完成含义，不得因缺新字段永久 `RESULT_NOT_READY`。
>
> `retry --cancel` 的快速替代语义保留；归属不明运行的重叠启动仍受 §11.4 门禁约束。

### 11.2 逐任务分类表（替换原 (a)(b)(c)）

前置：从 DB 读 `unit`、`scopeInvocation`、`nonce`、`logIdentity`、`logs` 路径、游标、取消/失败意图、`finalizedAt`。已提交 `finalizedAt` 的 run 跳过 finish 重放（§6.2），只恢复收尾材料。

新的 scope 查询保留 `present/absent/unknown` 三态：以 `recoverOwnedScope` 的 `inspect`（`src/main/adapters/cli/scope.ts:84-92`：not-found→`undefined`（即 absent），非零/空输出→抛错（即 unknown），缺 ActiveState/身份变化→抛错）为先例；**不得沿用会把多种查询失败折叠成 `undefined` 的 `showScope`**（`src/main/adapters/cli/scope.ts:56-61`）。

| # | 观察结果 | 处理 |
|---|----------|------|
| 1 | `systemctl`/D-Bus 查询失败或超时（unknown） | **恢复待定**：保留日志与执行占用，周期重试；**不当作 scope 不存在** |
| 2 | 已归属、active/activating、无退出记录 | 接回（attach：tailer + normalizer 重放到游标 + 注册 `running` + 恢复 timer/killTimer）；running 继续跟踪，cancelling 按 §9.3 重新终止；CPU 采样按 unit 恢复（`systemdCpuUsage`，`src/main/monitors/cpu.ts:27-34`） |
| 3 | 已归属、deactivating，或已有停止意图（cancelling/failed 待终止） | **继续原终止阶段与原绝对期限**（`terminationPhase` + `killAfter`，§9.4），不重给宽限 |
| 4 | 已有合法 exit 文件（runId+nonce 匹配），但 scope 仍有后代（active） | **核验归属后按现有 child-exit 路径等价清理后代**（`src/main/adapters/cli/scope.ts:297-306` 的 exit→stop 语义），确认不再产生输出后，消费两条日志最终 EOF 再收尾（§11.3-B5） |
| 5 | scope 已确证消失（absent：not-found/LoadState=not-found），且没有仍可能注册 scope 的 launcher | 用本 run 的日志和 exit 文件收尾（§11.3）：重放剩余日志→读 exit→按 close 语义收尾；无合法 exit 时按取消/失败意图收尾，无意图则以 `unknown_outcome`（执行结果未知）失败收尾，重试由 owner 显式操作（见下“从未启动的判定”） |
| 6 | 无 invocation，但有 FD 正向证据 | 补写当前 InvocationID，再接回或终止（§11.4） |
| 7 | 无 invocation、scope 已结束、本 run 的 exit 文件合法（runId+nonce 匹配） | 允许收尾（短命 worker 优先，见下）；**不能仅因拿不到活进程身份而丢弃结果** |
| 8 | invocation 不匹配，或证据不足 | **不操作不匹配的 scope；本 run 保持恢复待定**，不按名字盲杀，不当成已安全结束 |
| 9 | 尚未注册的 launcher（一次 not-found） | **一次 not-found 不足以证明不会出现 scope**：必须同时确认无存活的 `systemd-run --unit=<unit>` 进程（沿用 `recoverOwnedScope` 的 `/proc` 检查，`src/main/adapters/cli/scope.ts:103-110`），且检查必须收敛——inspect → `/proc` 扫描 `systemd-run --unit=<unit>` → 再 inspect，两次 absent 且中间无 launcher 才算不存在（基线 `scope.ts:111` 扫描后二次 inspect 为先例）；**不得复用扫描前的一次 not-found 作为最终不存在证明**。之后仍只证明“当前不存在”，不证明“从未执行”：能否回队只看 `launchPermittedAt`（见下“从未启动的判定”），§4.4 pi 门同理 |
| 10 | 短命 worker（首次 identity 前已结束被 `--collect` 回收） | 同时满足“无 invocation”与“scope 已结束”时：**若存在绑定本 runId+nonce 的合法 exit 文件，按 scope 已结束收尾（第 5/7 条）优先于不可核验**；否则：`launchPermittedAt` 未提交 → 回 `queued + scheduled`；已提交 → 恢复待定或 `unknown_outcome` 收尾（见下“从未启动的判定”），不触碰任何 scope |
| 11 | 已证明归属、日志缺失/截断/身份变化/解析无法继续 | **先持久化失败与终止意图，确认 scope 终止后再收尾**（§11.3-B6）；归属不明确则保留恢复待定 |

补充规则：

- **deactivating** 按“仍活”处理，走第 3 条（继续原阶段），不按“已结束”收尾。
- **读到 EOF 不等于结束**：文件暂时读到 EOF 只是 tailer 调度状态，不构成运行结束；结束只由“合法 exit + 后代清理 + 最终 EOF + 收尾事务”（§6.2）构成。
- **从未启动的判定**（第 9 条后半）：唯一判据是**启动许可 `run.launchPermittedAt` 未提交**——run 仍处 preparing 阶段（如被停机门中止的 pi 预检，§4.4），且所有启动路径都必须先提交该许可（§4.2），之后才允许 spawn；未提交即证明外部进程从未被允许启动，可安全回 `queued + scheduled`，由统一 pump 启动（§16-P1/B11），不标 failed。**单加 prepared 意图字段不能区分提交后是否真的执行过**，因此许可提交之后的窗口不做自动回队：一旦 `launchPermittedAt` 已提交，绝不因零日志/无 exit/无 launcher 自动重新排队——存在性或归属未确定 → 恢复待定；确认无仍可能注册的 launcher 且 scope 已停止 → 缺合法 exit 的运行按取消/失败意图收尾，无意图则以“执行结果未知”（failure kind `unknown_outcome`，见附录）失败收尾，重试由 owner 显式操作（`tasks retry`）。
- **恢复待定**（`run.recovery='pending'` 一类状态）对 UI/CLI 可见（`tasks.get` 展示 `recovery` 字段与原因事件），并说明人工处置方法：核验 scope 归属（`systemctl show` + InvocationID 比对）→ 若确认为孤儿 scope，手动 `systemctl stop` 后将任务置 failed 并重试；若 scope 属于本 run，等待周期重试自动接回；禁止直接删日志/释放占用。

### 11.3 exit 独立观察与已归属解析失败（B5/B6）

**B5——exit 独立于 scope ActiveState 观察**：当前 scope 实现特意处理“直接 CLI 已退出、后台后代仍在 scope 中”：收到 child `exit` 后清理整个 scope、等输出排空才 close（`src/main/adapters/cli/scope.ts:291-312`）。反例：CLI 派生后台子进程 → 停机期间 CLI 退出、外壳写出 exit → 后代仍在 scope 内 → 重启只进“接回”分支，该分支不读 exit → 旧 child-exit 通知已丢失 → 任务永久 running。另 systemd scope 生命周期由组内进程整体决定（只要仍有进程就可能存活），`MainPID` 永不作为 pid 来源（报告 B §5.5）。

> 退出记录独立于 scope ActiveState 检查。在线 attach 和恢复都必须独立观察 exit 文件。合法退出记录表示直接引擎已退出，不表示所有后代已退出。scope 仍存活时，核验归属并执行现有 child-exit 路径等价的后代清理；确认本次执行不再产生输出后，消费两条日志的最终 EOF，再执行收尾事务。文件暂时读到 EOF 不构成运行结束（Node `close` 含 stdio 已关闭的含义，`child_process` 文档；文件模式需主动重建该收尾条件）。

**B6——已归属 + 日志不可恢复 → 先杀后收尾**：原文仅“invocation 匹配但日志**缺失**”允许先 `systemctl stop` 再 failed（原第 329 行），截断/inode 变化仍落入“不杀”默认。反例：live scope InvocationID 完全匹配 → 日志被 truncate/替换 → 恢复标 failed 但不终止 scope → worker 继续写工作区，后续 retry 启动另一份任务。

> 对已证明属于本 run 的 scope，若日志缺失、截断、身份变化或解析协议无法继续，应先持久化失败及终止意图，完成 scope 终止确认后再收尾。无法解析日志不得成为遗留已归属进程的理由。归属不明确时则保留恢复待定状态，不按名字盲杀，也不把未清理的运行当成已安全结束。

### 11.4 FD 正向证据：实现约束（A2/C，只作正向证据）

“在预期 scope 中发现本 run 独占日志 inode 的写 FD”可以补回 InvocationID；**“没发现”不能证明进程已结束**。约束（照审查意见列入实现）：

1. 每个 run 独占文件，先创建、fstat、持久化 `dev/ino`（`run.logIdentity`，§4.2），再用**同一已打开 FD** 启动。不能先 stat 路径、spawn 时又 open 可能已变化的对象。
2. sh 从启动到退出保留明确的锚定 FD（§5.1）；退出记录绑定 `runId`/随机 `nonce`（§3.3）。
3. 只在预期 unit 的 cgroup 内检查（含子 cgroup，`ControlGroup`，`src/main/adapters/cli/scope.ts:51`），覆盖 `/proc/<pid>/fd`，并核对：PID starttime（防 PID 复用）、FD 类型与写权限（`fdinfo` flags 只作访问模式佐证，不作生命周期证明）、检查前后的 InvocationID（一致性）。
4. 成立后**先持久化 InvocationID**，再进入长期管理（第 2 条接回）。
5. 证据不足保留恢复待定：不删文件、不释放占用、不开启可能重叠的新 attempt。
6. 已知局限（实现与文档双承认，不做过度承诺）：
   - 引擎关闭/重定向 stdout/stderr 但 sh 仍保留 FD → 证据仍可能成立，不只检查引擎 PID；
   - 子孙继承日志 FD 属正常 fork 语义，命中 PID 不等于主 CLI；
   - sh/CLI 已退出、仅剩关闭了日志 FD 的 daemon → 无 FD 命中仍可能有活进程；
   - 文件删除后重建：`dev/ino` 数值不能当永久 run 身份，必须绑定 `runId+nonce`（§3.3）防复用；
   - 后代显式迁移到其他 scope → 不能据一个继承 FD 就杀另一个 scope 的全部进程（归属仍以 unit cgroup + InvocationID 为准）。

因此：**无 invocation 的归属只作正向证据**——命中则补 invocation 接回/终止；不命中则进入恢复待定，证据不足不盲杀（第 8 条）。

### 11.5 保持不变的行为

- native 任务、owner host（有 `ownerHost` 的 owner 任务豁免，`src/main/application/tasks/recovery.ts:6`）、mock worker：mock 仍按旧逻辑标 failed（无 scope、无日志，重接无意义）。
- schedules 的 claude-native direct 运行（stdin 为持续打开的管道，`keepStdinOpen`，`src/main/adapters/cli/scope.ts:155-158`）：**不支持跨重启**，保持现有 interrupted 语义（§16-P2 写明原因：管道读端随服务退出消失，无法文件化）。
- 启动时输出一份**恢复报告**：接回/收尾/失败/待定计数与任务 id 列表，同时写入任务事件（每任务一条 lifecycle）与服务日志。CLI 可查（`server status` 附加 `recoveryReport`，或日志文件）。

---

## 12. 版本兼容与过渡（设计点 10）

- **重放用新版本 normalizer 读旧版本产生的日志**：约束 normalizer 必须保持**按字节确定性**（无 `Date.now()`/`setTimeout`/env/进程状态分支，现状已满足，`src/main/adapters/cli/normalize.ts:167-480` 无此类调用，报告 B §1.1）。游标是**字节偏移**，与版本无关。
- **新增 run 字段全在 `tasks.body` JSON 内**（`AgentRun` 接口扩展，`src/shared/contracts/tasks.ts:35-40`），`writeTask` 整行 JSON（`src/main/store.ts:67-70`）——**无需表迁移**（`migrate.ts` 不动，`SCHEMA_VERSION` 不变）。
- **回滚流程变更**：旧版本不认识 `scopeInvocation/replay/logs/nonce/logIdentity/finalizedAt` 字段，`recoverInterruptedTasks` 会把这些任务标 failed（旧逻辑，`src/main/application/tasks/recovery.ts:5-9`），**且不杀 scope**——留下仍在写工作区的孤儿，后续 retry 可能与之并发。**回滚前必须先在新版本上 `server stop --cancel-workers`（或确认无运行中 worker）再降级**（§15.3）。可接受，但必须写进升级文档与回滚流程。
- **过渡**：当前版本停机仍取消 worker → **第一次升级到新版本必须先排空**（确认无 running/cancelling 后 `weaver server stop`，再替换二进制、`daemon-reload`、`start`）。新版本 running 后，后续升级任意时刻 restart。
- **日志体积与重放成本**（A7）：每次重启从头重放全部日志字节到游标（§6.4 步骤 2），成本与日志体积成正比；大输出任务（数百 MB）的重放 CPU/IO 在启动路径上。normalizer 快照列为**后续可选优化**，快照必须包含：decoder 未完成行与 overflow 状态、parser 整次运行预算（1000 条/2MiB/128KiB，`src/main/protocol.ts:13,27,30,32`）、已报告模型集合等 adapter 状态、取消/失败决定、`finish` 是否已提交（§6.2）；快照必须绑定 `runId` + 文件身份（`logIdentity`）+ 字节位置 + 解析版本，否则把性能优化变成新的恢复错误。当前优先级低于事务与生命周期修复（§6/§11）。

---

## 13. 原始日志的安全与清理（设计点 11）

- 权限：`stateDir` 0700、三文件 0600（§3.1）。原始日志含未脱敏字节（§5.4），权限是唯一保护；`prepareCliAgentInput` 已有 `promptPath` 0600 先例（`src/main/adapters/cli/launch.ts:98-110`）。
- 脱敏：事件/artifact/stderrTail/`vendorError` 写库前仍走现有 `redactSecrets` + `clip`（`src/main/adapters/cli/launch.ts:227-232` 的 `redactRecord` 逻辑搬到 tailer 出口）。
- 清理：任务到达终态（completed/failed/cancelled）**并在收尾事务提交后**（`run.finalizedAt` 已持久化，§6.2；现状 `persist(current)` 成功点 `src/main/manager.ts:119` 升级为收尾事务提交点），删除原始 stdout/stderr + exit 文件。收尾失败（写库抛错/`fatal`）时**保留文件**，并在事件中注明路径（供人工检查）。
- 日志回收与执行资源释放**不得仅依据业务终态**（B4，§11.1）：`failed` 但 scope 未确认停止前不删日志、不释放占用；`results.manifest` 在收尾事务提交前不可见（`RESULT_NOT_READY`）。
- 与 cow-workspace 任务资源生命周期规则对齐：原始日志视为任务临时产物，随任务终态回收；保留需有明确失败原因 + 路径可查。

---

## 14. CLI 停机容忍：只读命令重连（设计点 12）

### 14.1 现状

`sendRequest` 在 discovery 缺失/socket 拒连时抛 `APP_NOT_RUNNING`（`src/cli/client.ts:9-11`，ENOENT/ECONNREFUSED 映射 `src/cli/client.ts:26`），连接后无数据断开为 `TRANSPORT_ERROR`（`src/cli/client.ts:39`）；`pollTask` 只把 `TIMEOUT` 转为 finish，`APP_NOT_RUNNING/TRANSPORT_ERROR` 直接 throw 退出 1（`src/cli/poll-task.ts:90-93`）；重启后新 `instanceId` 导致旧 token `UNAUTHORIZED`（`src/main/local-ipc.ts:179-182`，discovery 轮换 `src/main/local-ipc.ts:144-148` 写 token/目录）。另正常停启时请求可传输成功却得到错误信封：先 draining 拒新请求、后撤销 ready（`src/main/runtime.ts:128-129,170-185`，`src/main/application/commands/gateway.ts:111`）→ `APP_DRAINING` / `APP_STARTING`。

### 14.2 新规则（只读命令：`tasks get/wait/watch/events/health`）——替换原正文

> 只读请求同时处理传输异常与错误信封。`APP_NOT_RUNNING`、`TRANSPORT_ERROR`、`APP_DRAINING`、`APP_STARTING` 进入有界重连（建议默认：初始 250ms、指数退避 ×2、上限 5s、总宽限 60s；参数名建议 `--reconnect-grace / WEAVER_CLI_RECONNECT_GRACE_S` 默认 60、`--reconnect-max-interval-s` 默认 5）。明确的 IPC 实例轮换（discovery 的 `instanceId` 变化）允许重读 discovery 后重试鉴权一次；连续 `UNAUTHORIZED` 仍立即失败，避免掩盖真正的鉴权问题。owner 身份失败、权限失败（`POLICY_DENIED`/`CAPABILITY_UNAVAILABLE`）、协议错误（`INVALID_REQUEST`/`INVALID_RESPONSE`）、安全校验失败（`UNSAFE_ENDPOINT`）**不得笼统重试**。重连保留 `taskId`、ownerAuth、已提交事件游标，不重新初始化整个 `pollTask`。请求超时与退避同时受原等待截止和连续不可用宽限约束；**实例轮换本身不重置宽限预算**（60s 有界只延迟报告，不无限掩盖；看到新 instanceId 就重置宽限会让崩溃循环无限延长）。最终错误保留实际错误码与最后一次已提交快照，不能统一声称“服务正在重启”。

- 反例覆盖：owner wait → 服务收到 TERM → socket 仍可连接 → `tasks.get` 返回 `ok:false, APP_DRAINING` → 旧 CLI 立即退出；新规则下进入重连预算。
- 重连期间向 **stderr** 报告（`[weaver] 服务重启中，等待重连…(12s/60s)`），stdout 的 JSONL 信封不受污染（`writeEnvelope`，`src/cli/poll-task.ts:36-42`）。
- 等待完成条件引用 §11.1：对新文件生命周期的真实 run，`tasks wait/watch` 以业务终态 + `run.finalizedAt` 双提交为 terminal 条件；失败决定已提交但终止/收尾未完成时继续等待并展示 stopping / recovery pending，到原等待截止按 timeout 返回并保留当前恢复状态（基线 `poll-task.ts:62` 只看业务终态，须按本条件修改，见 §16-P1）。
- **native handoff**（排队 native、响应丢失、重连路径）：dispatch/retry 响应确认的是持久接纳，实际执行状态随后由 pump 推进。`tasks wait` 发现已提交快照为 running native 时，以明确的 `reason='handoff'` 返回 `next.run_subagent` 指令（基线 `queries.ts:44` 已在 `tasks.get` 对 running native 返回该指令，`poll-task.ts:62` 只看 terminal 而忽略它，此处补齐），不能继续等待尚未由 owner 发起的执行。handoff 绑定稳定的 `taskId + attemptId`：重复读取返回同一 attempt 的指令；owner 尚未启动该 attempt 时才调用内建 subagent，已有对应执行句柄时继续等待原执行，不再次启动。这也修复了基线中排队 native 的既有交接缺口（基线 `poll-task.ts:62` 只看 terminal、`dispatch.ts:79` scheduled 即回 wait、`queries.ts:44` 的 next 只有 get 侧返回）。
- 变更类命令（`tasks start/cancel/retry`、`server stop` 等）**不自动重试**：不确定结果沿用 `command-id + operations get` 处理（现状语义，`src/cli/run.ts:80-85` envelope 含 `commandId`）。**变更命令不自动重发，与“恢复已提交操作”是两条独立规则**（B11，见 §16-P1/dispatch）。

---

## 15. 服务管理：停机语义与升级流程（设计点 13）

### 15.1 `server stop` 新语义

- `SERVER_BUSY` 守卫（`src/cli/server/lifecycle.ts:150`）文案改为提示“worker 会继续运行，重启后自动接回”，不再以“stopping cancels them”为由拒绝。
- 默认 `server stop` = 优雅 detach（§10）：等 tailer flush + 有界 identity 等待，不杀 worker。
- 如需连带取消，提供显式选项：`server stop --cancel-workers`（`server uninstall` 同理 `--cancel-workers`，对应现状 macOS 守卫 `src/cli/server/lifecycle.ts:219`）。显式取消走现有 `manager.cancel` → scope kill 路径。

### 15.2 标准升级流程

1. 安装新二进制（`install.sh` 原子 `mv`，`install.sh:93-101`；running 进程保持旧文件句柄）或准备 releases drop-in（现状运维侧 drop-in 覆盖 ExecStart，`weaver.service.d/70-feishu-im-release.conf`；消费侧 `unitValues` 回读，`src/cli/server/lifecycle.ts:50-67`）。
2. `systemctl --user restart weaver.service`（任意时刻，无需排空；过渡期第一次除外，见 §12）。
3. 等 ready（`waitForServer` 轮询，`src/cli/server/lifecycle.ts:186-208` 模式）。
4. 检查恢复报告（§11.5）：接回/收尾/失败/待定计数与任务 id；失败/待定项按事件说明处置。

### 15.3 回滚流程（修订：先在新版本上取消 worker 再降级）

1. **先在新版本上执行 `server stop --cancel-workers`**（或确认无 running/cancelling/failed-未收尾 worker），等待全部 scope 停止。
2. 恢复旧二进制/drop-in 指向旧版本，`daemon-reload + restart`。
3. 预期：旧版把残留新字段任务标 failed（§12），需人工按事件重试（`tasks retry`）。未执行第 1 步的回滚会留下孤儿 scope（旧版不杀 scope），**禁止**。

---

## 16. 分期（设计点 14）

### P1：任务 worker 重接 + CLI 重连 + 停机语义 + 持久意图 + 单例/discovery

范围：§3–§11 中任务 worker 路径 + §14 只读 CLI + §15 stop 语义 + B3/B4/B10/B11/B12。

文件级改动点：

- `src/main/adapters/cli/scope.ts`：`startOwnedScope` 文件模式 + sh 外壳 + exit 文件（§3）+ attach 用三态 `inspectScope`（`systemctl show` 只读，`recoverOwnedScope` 的 inspect 为先例，`src/main/adapters/cli/scope.ts:84-92`；`showScope`（`:56-61`）不再用于恢复）。
- `src/main/adapters/cli/launch.ts`：`CliAgent` 输入源改为 tailer（`src/main/adapters/cli/launch.ts:154-194` 重构）；`beforeSpawn` 接线（`:272-275`）；`identity` 转发保留（`:169`）；`complete` 先排空双流再 `finish`（`:233-247`）；致命分类才终止（`:161,187-190,218-219`）。
- `src/main/adapters/launch.ts:5`：`StartCliAgent` 类型扩展 `beforeSpawn` 参数。
- `src/main/adapters/cli/pi-guard.ts:30-58,83-85`：透传 `beforeSpawn` + 停机门（§4.4）。
- `src/main/adapters/routing.ts:35-44`：传入 `beforeSpawn`。
- `src/shared/contracts/tasks.ts:35-40`：`AgentRun` 新增 `scopeInvocation/stateDir/logs/replay/nonce/launchPermittedAt/logIdentity/finalizedAt/killAfter/terminationPhase/cancelRequestedAt/cancelSignal/noOutputDeadline/vendorError/retryAt/stderrTail/resultSummary/logTruncated/recovery`。
- `src/main/store.ts:22,49-65,77-107`：`checkpoint` 语义纠正（仅提交前钩子）+ 行批次快照（§6.3）+ 对外只读已提交（§6.5）。
- `src/main/storage/transaction.ts:24-50`：收尾事务边界（§6.2；实现无需改动，文档锁定用法）。
- `src/main/application/tasks/queries.ts:53-56`：`tasks.events` 只发已提交事件（§6.5）。
- `src/main/application/tasks/results.ts:15-24`：manifest 收尾事务提交前 `RESULT_NOT_READY`、提交后冻结（§11.1；R2：terminal 与结果可读同条件，`tasks wait/watch` 以业务终态 + `finalizedAt` 双提交为 terminal，见 §14.2）。
- `src/main/local-ipc.ts:100-148,205-218`：单例锁 + discovery 原子发布（§10.4）。
- `src/main/application/scheduling/dispatch.ts:111-122`：已接纳 dispatch 落可恢复待启动阶段——`package`、`dispatch`、`scheduled=true` **同事务提交**，由统一 pump 启动，**不再在 dispatch 调用栈里直接 `manager.start`**（`src/main/application/scheduling/coordinator.ts:38-43` 的 pump 是唯一启动点）。**有容量的 native dispatch**：在持久接纳的同一事务内完成 `manager.start` 的 native 登记（native 只登记运行状态、不启动外部进程，无孤儿风险，基线 `manager.ts:62`），`workers spawn` 仍直接返回 `next.run_subagent`，保持现有协议。**需排队的 native**（以及响应丢失、重连路径）：`tasks wait` 发现已提交快照为 running native 时以 `reason='handoff'` 返回 `run_subagent` 指令；handoff 绑定 `taskId + attemptId`，重复读取返回同一 attempt 的指令；owner 尚未启动该 attempt 才调用内建 subagent，已有执行句柄则继续等待原执行，不重复启动（§14.2）。这同时修复基线排队 native 的既有交接缺口（基线 `poll-task.ts:62` 只看 terminal、`dispatch.ts:79`、`queries.ts:44`）。
- `src/main/application/commands/gateway.ts:122`：统一 pump 后 dispatch 先返回 queued，`snapshot.dispatch?.execution==='real' && snapshot.status==='running'` 的 first-output 分支不再进入；`workers spawn` 返回的是**持久接纳**，`started:false` 可为正常状态——文档锁定“接纳成功 ≠ 已实际启动”的区别，实际执行状态随后由 pump 推进（native 交接见上条 §14.2）。
- `src/main/application/scheduling/coordinator.ts:38-77`：pump 扫描待启动阶段 + 启动前重接门禁（§10.3：reattach 完成前不启动）。
- `src/main/application/scheduling/retry.ts:111-154`：原任务取消意图 + 稳定 replacement ID（`randomUUID` 预生成，`:135` 的 `probeId` 模式转正）+ package + `retryOf` 关联 + 待派发意图 + operation/task/attempt ID **同事务提交**，外部 kill/spawn 在提交后执行；重启后按原 operation/task/attempt ID 推进，不重复创建。
- `src/main/manager.ts`：行批次游标推进 + 同事务落库（`:191-206` 重构为行批次）；`firstOutputAt` 同步（`:79` 改 `sync`）；`vendorError/retryAt` 同步（`:81`）；`cancel` 意图 + `killAfter` + 阶段持久化（`:127-140`）；`failAttempt/stop` 写 `killAfter`（`:164-168,183-190`）；`shutdown` 改 detach + 有界 identity 等待 + pi 门（`:153-160`）；新增 `reattach()`（§11）。
- `src/main/runtime.ts`：`recoverInterruptedTasks` 调用（`:210`）替换为 manager 构造后（`:238` 之后）的 `reattach`（§11.1）；单例锁获取（store 打开前）与释放（close 尾部）；初始化失败清理顺序（`:261-272` 扩展，§10.2）；reattach 在 pump/ready（`:250-254`）之前完成（§10.3）。
- `src/main/application/tasks/recovery.ts:5-9`：旧函数删除或仅 mock/legacy 用。
- `src/cli/poll-task.ts` + `src/cli/client.ts`：重连退避（§14.2：`src/cli/client.ts:9-11,26,39` 错误分类 + `src/cli/poll-task.ts:44-93` 循环）；R2：`poll-task.ts:62` 的 terminal 条件改为业务终态 + `run.finalizedAt` 双提交，未 finalized 的 failed 继续等待并展示 stopping/recovery pending；R3：已提交快照为 running native 时以 `reason='handoff'` 返回 `run_subagent`（绑定 taskId + attemptId）。
- `src/cli/server/commands.ts` + `lifecycle.ts`：stop 语义 + `--cancel-workers`（`src/cli/server/lifecycle.ts:150,219`）。
- 新增 `src/main/adapters/cli/log-tailer.ts`（tailer + 未完成行探测 + 截断检测 + FD 锚定打开）。
- 测试（§17 P1 项）。

风险：tailer 与在线行为的细微差异（未完成行时机、stderr 上限语义）；游标与 500ms stream 缓存的对齐；`sh` 外壳对六引擎 argv 的透明性需逐引擎验证。

### P2：schedules 的 direct CLI / script 改同一文件模式 + recover 可接回

范围：schedule 的 `script`（`src/main/schedules/process.ts:31-38`，stdout 捕获 64KiB、detached scope）与 direct CLI（`src/main/schedules/service.ts:296-306`）改用 §3 文件模式 + §6 游标（输出改为文件， Slot 外置 `schedules.output.*` 保留或复用）；`recover()`（`src/main/schedules/service.ts:597-643` 的 tick/recover 路径）从“先确认死亡再认领（interrupted）”改为“可核验则接回、继续跑，结束才收尾”；`scopeConfirm`（`src/main/schedules/service.ts:79`）复用 §11 的核验逻辑。

**claude-native direct 运行明确不支持跨重启**：其 stdin 为持续打开的管道（`keepStdinOpen` 语义，`src/main/adapters/cli/scope.ts:155-158`），管道读端随服务退出消失、无法文件化；保持现有 interrupted 语义（到期/重启即 interrupted，不接回）。script 与 direct CLI（prompt 文件模式）走文件模式，可接回。

文件级改动点：`src/main/schedules/process.ts`、`service.ts`（`beforeSpawn`/`persistCliInvocation`（`:344-351`）/`recover`/`reconcileAgent`（`:520`））/`store.ts`（`StoredRun.process` 加日志路径/游标，`src/main/schedules/store.ts:4`）、`src/main/adapters/cli/scope.ts`（与 P1 同一 tailer）。`quota.refresh`（进程内，无子进程，`src/main/schedules/service.ts:554-575`）不动。

风险：schedule 的 claim/围栏（`jobs/recovering/scripts/directs` 内存态，`src/main/schedules/service.ts:69-72`）与重接的交互；`tick` 期间到期任务的快进语义（`src/main/schedules/service.ts:634-643`）与接回任务的去重；legacy-root 走任务通道，自动获得 P1 能力。

### P3：飞书 IM 父 Agent host 存活与重连

现状（报告 A §1-D）：host 是独立 `systemd-run --service`（`src/main/im/parent-background.ts:194-200`），但服务↔host 的私有 unix socket 由服务侧创建（`src/main/im/parent-background.ts:152,185`），服务退出即 unlink + `socket.on('close', shutdown)` 使 host 自杀（`src/main/im/parent-host.ts:80`）；`ImService` 状态全内存，重启后 standby 全新创建、排队/进行中 turn 丢失（`src/main/im/service.ts:56-67,314-318`）；残留 `im-host/*` 记录会被新服务 `cleanupHostRecord` 回收（`src/main/im/parent-background.ts:57-72`）。

方向：host 在服务重启期间存活（socket 改由 host 侧创建/持有，或重连时重建并对账）；服务重启后重连已存活 host，对账进行中的轮次（epoch/record.json 已有 `unit/endpoint/ownerPid/ownerStart/invocation`，`src/main/im/parent-host-resources.ts:12-21`）；排队 turn 持久化到 `im-inbox.json`（与现有 `im-settings.json/im-inbox.json` 跨重启保留一致，`src/main/im/settings.ts:136-138`）。

**待验证**（标为未决，不写死）：飞书长连接（WS channel）在停机期间的消息是否重投——若平台不重投，需要上线后主动拉取/对账；先做实验再定语义。

风险：双活（新旧服务同时连一个 host；现有 `resourceError()` 防双活 `src/main/im/parent-background.ts:57-72` 需保留并扩展到重连）；对话上下文仍在 host 内存，host 崩溃即丢（与 P1 的文件持久化不对等，需明确告知）。

---

## 17. 测试与验收（设计点 15，TDD 先写失败测试）

### 17.1 失败测试清单（原 14 项 + 故障注入 10 点 + sh 外壳 6 项 + R1–R3 切点 3 项，合并去重）

| # | 测试 | 目标测试文件 | 断言要点 |
|---|------|--------------|----------|
| 1 | 六引擎在线 vs 重放等价 | `tests/main/cli-normalize-replay.test.ts`（新建；参照报告 B §1.3 的 replay-check 方法：7 字节切片喂 `decodeLines`） | 同一有序行序列，在线 `push` 与“拼字节→切片→解码→重放”的 `records/evidence/sessionId` 全等；六引擎各至少一组含 failure/usage/session 的样本 |
| 2 | dsh tool map 必须从开头重放 | 同上 | 从中间偏移重放的 `tool_result` 回退为通用文案，与全量重放不等（锁定“必须从开头”约束） |
| 3 | `finish` 矩阵 | 同上 | cancelled 优先于 truncated/error；`exitCode=null` → missing；pi `sessionClosed && stopReason==='stop'` 才 success（`src/main/adapters/cli/normalize.ts:141-148`） |
| 4 | finish 批次原子：resultSummary 已提交、close 未提交 | 同上或 `tests/main/manager.test.ts`（见 #5 模式） | SIGKILL 恰在 finish 应用后、close 前 → 重启 artifact/result 不重复，成功任务不变协议错误（§6.2；`finalizedAt` 已提交则跳过 finish 重放） |
| 5 | 行批次原子：一行第二条 record 抛错 | `tests/main/cli-normalize-replay.test.ts` + `tests/main/manager.test.ts` | 第 1001 条触发超限（`src/main/protocol.ts:32`）→ 不提交半行事件/artifact/游标；重启重放该行恰好一次（§6.3） |
| 6 | 游标幂等：重放不重复写事件/artifact | `tests/main/manager.test.ts`（新增 attach 单测：fake scope + 持久化 run，模拟崩溃后 new manager） | 推进游标后重放已应用区段，`events/artifacts` 数量不变、无新 `randomUUID` |
| 7 | 重启后接回继续出结果且 result 只写一次 | `tests/integration/worker-reattach.test.ts`（新建；复制 `tests/integration/schedules-agent-scope.test.ts:10-12` 的真实 systemd 门控模式） | scope 存续→杀控制器→新 manager 接回→worker 结束→`result` 事件恰 1 条、`summary` 单值 |
| 8 | 停机期间 worker 结束 | 同上 | detach 后让 worker 自然结束；重启后走 §11.2(5)：读剩余日志+exit 文件收尾为 completed/failed，无“Interrupted”事件 |
| 9 | 重启后取消 | `tests/main/manager.test.ts` | cancelling + `cancelRequestedAt` 的任务重接后重新 `kill scope`（assert `systemctl kill` 调用），收尾为 cancelled；无意图的 143 → 非 cancelled（§9.3） |
| 10 | 取消期间连续快速重启不延长宽限 | 同上 | pre-kill 重启 N 次 → `killAfter` 不变，到期直接 KILL（§9.4）；阶段不回退 |
| 11 | failAttempt 已提交、scope 未退出 | `tests/main/worker-recovery.test.ts`（新建，复用 `tests/main/schedules-recovery.test.ts` 模式） | `failed` 但 scope 存活的 run 仍被接管并完成终止（§11.1）；无双 worker 并发 |
| 12 | exit 已存在、后代保持 scope active | 同上 | 最终能清理后代并交付结果（§11.2(4) + §11.3-B5）；读到中间 EOF 不提前收尾 |
| 13 | invocation 缺失/不符恢复待定 | 同上 | 无 invocation / invocation 不符 → **恢复待定**（`recovery='pending'` + 原因事件），**无 kill 调用**，不是 failed；invocation 匹配但日志缺失/截断 → 先 stop scope 再 failed（§11.3-B6）；证据不足 → 恢复待定，不删文件 |
| 14 | 日志缺失/截断/inode 变化 | 同上 | 文件缺失、大小 < 游标、`dev/ino` 与 `logIdentity` 不符 → `logTruncated` + 按 §11.2(11)/§11.3-B6 处理，不补造 |
| 15 | spawn 前崩溃窗口 | `tests/main/manager.test.ts` | `launchPermittedAt` 未提交的 preparing run → 回 `queued + scheduled`，且不触碰任何 scope；已提交但无 unit/scope 证据 → 按 R1 规则（恢复待定或 `unknown_outcome`），同样不触碰任何 scope |
| 16 | dispatch 已接纳、start 未执行 | `tests/main/dispatch-recovery.test.ts`（新建） | dispatch 提交后、start 前崩溃 → 同一 attempt 被 pump 启动，不永久搁置、不重复创建（§16-P1/B11） |
| 17 | retry 各持久化阶段之间 | 同上 | cancel 已提交/replacement 未创建、replacement 已创建/dispatch 未提交 → 重启后 replacement 不丢失、不重复创建，按原 operation/task/attempt ID 推进 |
| 18 | discovery 创建与写入之间 | `tests/main/local-ipc.test.ts`（现有落点扩展） | 空/损坏 discovery + 无活锁持有者 → 下一次服务仍可正常启动（§10.4）；有活锁持有者 → `ENDPOINT_EXISTS` 不覆盖 |
| 19 | 部分 reattach 成功后初始化失败 | `tests/main/worker-recovery.test.ts` | 无遗留写库回调或晚到 launch（§10.2 门检查）；tailer 已撤销、pending 已 flush、锁已释放 |
| 20 | no_output 截止跨重启 | `tests/main/worker-startup.test.ts`（现有 `:22-59` 落点扩展） | `startedAt+120s` 已过**且积压日志无有效输出** → 重接即 `failAttempt(no_output)`；未过 → timer 为剩余时间（mock clock 断言）；已有 records 但缺 `firstOutputAt` → 补记近似值事件（§8.2）；**有积压有效输出时不执行过期 no_output** |
| 21 | CLI wait 跨重启续上 | `tests/cli/cli-wait-stall.test.ts`（现有落点扩展）或新建 `tests/cli/cli-reconnect.test.ts` | `APP_NOT_RUNNING → APP_DRAINING → UNAUTHORIZED(轮换) → 200` 序列下 `pollTask` 不退出，最终 terminal；stderr 有重连报告；宽限耗尽才退出 1；实例轮换不重置预算（§14.2） |
| 22 | vendor-error 不随重放漂移 | `tests/main/manager.test.ts` | 持久化 `retryAt`；重放已应用区段不重新 `classify`，`release_at` 与首次一致 |
| 23 | 跨流顺序与致命优先级（同一决策批次） | `tests/main/cli-normalize-replay.test.ts` | **同一候选集合、同一决策批次**内改变解析顺序，结果一致（§7.3 优先级 `auth > quota > rate_limit > model > no_output/early_exit > other`，同级以稳定来源键如流名 + 字节偏移选择）；普通工具失败（dsh `tool_result error` 后自愈）不终止；另测 `rate_limit` 已提交后出现 auth，重启后仍保持原决定 |
| 24 | watch 已看到 pending 事件、服务崩溃 | `tests/cli/cli-reconnect.test.ts` 或 `tests/main/manager.test.ts` | 对外只发已提交事件：崩溃前未提交事件不提前可见；重启后无静默重复、无不可解释的游标丢失（§6.5） |
| 25–30 | sh 外壳验收 6 项 | `tests/main/scope-shell.test.ts`（新建，真实 shell；禁 destructive 操作之外的最小集） | 见 §3.5：TERM 打断 wait / 连续 TERM / 子进程忽略 TERM / stdin 送达 / 自然退出 code / 取消并发意图分离 |
| 31 | 启动许可已提交但无日志/exit 不得自动重跑（R1） | `tests/main/worker-recovery.test.ts` | `launchPermittedAt` 已提交、零日志字节、无合法 exit、无 launcher → 不回 queued、不启动新 attempt；恢复待定或 `unknown_outcome` 收尾；对照 §11.2“从未启动的判定” |
| 32 | failed 已提交但未 finalized 时 wait 不返回 terminal（R2） | `tests/cli/cli-reconnect.test.ts` 或 `tests/main/manager.test.ts` | 业务终态 failed 已提交、`finalizedAt` 缺失 → `tasks wait` 继续等待（stopping/recovery pending），不返回 terminal；到等待截止按 timeout 返回并保留当前恢复状态；对照 §11.1/§14.2 |
| 33 | 排队 native 获执行资格后交回同一 attempt 的 handoff（R3） | `tests/cli/cli-reconnect.test.ts` | queued native 经 pump 变 running 后，`tasks wait` 以 `reason='handoff'` 返回 `run_subagent`；重复读取同一 taskId + attemptId 返回同一指令；owner 已有对应执行句柄时继续等待原执行，不重复启动；对照 §14.2/§16-P1 |

### 17.2 真实环境演练步骤（本机 systemd，禁 destructive 操作之外的最小集）

1. 确认基线：`systemctl --user status weaver.service` active；`weaver tasks` 无 running（演练用新任务，不碰现有任务）。
2. 派发一个真实长任务（如约束 10 分钟 sleep + heartbeat 输出的 worker，或真实引擎长问答），记录 task id；另开一个终端 `weaver tasks wait --task-id <id>`（P1 实现后应不断连）。
3. 运行中执行 `systemctl --user restart weaver.service`；观察：
   - worker scope 存续：`systemctl --user show weaver-cli-<engine>-<id>.scope -p ActiveState -p InvocationID` 在重启前后 `InvocationID` 不变；
   - 服务日志出现恢复报告（接回 1 个）；
   - `wait` 终端 stderr 出现重连提示后继续轮询，不退出。
4. 等 worker 自然结束；断言：`tasks get` 为终态；`result` 事件恰 1 条；`stateDir` 下原始日志已清理（终态提交后删除）；exit 文件已清理。
5. 取消演练：另派一任务，`tasks cancel` 后立即 restart；断言重启后任务继续终止流程并收尾为 `cancelled`（不是 failed）。
6. 四窗口覆盖（发布前必须实测，§17.2-6）：分别在以下时刻 restart——(a) systemd-run 仍在 service cgroup、scope 未注册；(b) scope 已注册、invocation 未落库；(c) invocation 已落库；(d) 引擎已退出但后代仍在。每个窗口断言对应 §11.2 分支。
7. 回收：演练任务终态后按正常流程归档；演练 scope `list-units 'weaver-cli-*'` 确认无残留（沿用报告 B §6.6 的回收确认方法）。

---

## 18. 风险与未决问题（设计点 16）

1. **systemd 版本差异**：进程模型实验仅在 systemd 257（Debian 13）完成（报告 B §9.1）：`--scope` exec 语义、`MainPID` 为空、`--collect` 后 `Result` 误导、`KillMode=control-group` 对 shell+trap 的信号顺序，均需在目标机器复验。本方案不把单机结果当跨版本保证；`MainPID` 永不作为 pid 来源（用 `ControlGroup/cgroup.procs`，报告 B §5.5）。
2. **真实 `weaver.service` restart 四窗口需发布前实测**：报告 B §6.2 杀的是普通 node 父进程，不是 systemd 管理的 service。scope 与 service 分属不同 cgroup，理论上 stop 不波及 scope，但 service 的 `KillMode`、stop 顺序、user manager 行为需在真实服务上验证：(a) systemd-run 尚在 service cgroup、scope 还未注册；(b) scope 已注册、InvocationID 尚未落库；(c) 已落 invocation；(d) 引擎已退出但 scope 仍有后代（§17.2-6 演练覆盖）。
3. **磁盘满/日志截断**：重放前提是完整连续日志；截断一律 §11.2(11)/§11.3-B6 处理，磁盘满的厂商行为各引擎不同，不做统一假设。
4. **日志体积与每次重启从头重放的成本**：重放从字节 0 到游标（§6.4），成本 ∝ 日志体积；大输出任务每次重启都付一次。normalizer 快照列为后续可选优化，快照内容与绑定条件见 §12（decoder 未完成行/overflow、parser 预算、模型集合、取消/失败决定、finish 提交标记；绑定 runId + 文件身份 + 字节位置 + 解析版本）。
5. **跨流顺序**：已用硬性规则收敛（§7.3 固定优先级），代价是极少数自愈场景被判失败；上线后若厂商出现高频“error 后自愈”模式，重新评估。
6. **未完成 stderr 行 probe 的观察时刻依赖**：在线未完成行触发的终止条件与恢复路径（只分类完整行）语义不同；停机期间首次出现的相对 retry-after 只能按恢复时刻估算（§7.2）。实现时二选一写死：限制未完成行触发终止的条件，或文档承认观察时刻依赖——本方案选后者，不得声称整条错误检测链路字节确定。
7. **飞书消息重投**：P3 方向已定（§16-P3），但停机期间 WS 消息是否重投**标为待验证**，先实验再定语义。
8. **过渡期单点**：第一次升级必须排空（§12）；排空期间的长任务与新任务派发需运维配合（公告 + `SERVER_BUSY` 仍有效）。

---

## 附：新增 `AgentRun` 字段一览（`src/shared/contracts/tasks.ts:35-40` 扩展）

| 字段 | 类型 | 写入时机 | 用途 |
|------|------|----------|------|
| `scopeInvocation` | `string`（32hex） | identity 到达后同步 | scope 归属证明 |
| `stateDir` | `string` | beforeSpawn 同步 | 日志/退出码目录 |
| `logs` | `{stdout,stderr,exit}` | beforeSpawn 同步 | 重放输入与退出码来源 |
| `replay` | `{stdoutOffset,stderrOffset,appliedRecords}` | 与事件同一事务（行批次，§6.3） | 幂等重放游标（已提交位置） |
| `finalizedAt` | `string`（iso） | 收尾事务提交（§6.2） | finish 幂等标记；恢复时跳过 finish 重放 |
| `nonce` | `string`（32hex） | beforeSpawn 同事务 | exit 文件与 FD 证据的 run 绑定 |
| `launchPermittedAt` | `string`（iso） | beforeSpawn 同事务（§4.2） | 启动许可：未提交 = preparing，可回队；已提交后绝不自动回队（R1，§11.2） |
| `logIdentity` | `{stdout:{dev,ino},stderr:{dev,ino}}` | beforeSpawn 同步（spawn 前 fstat） | FD 正向证据锚点；截断/替换检测 |
| `logTruncated` | `boolean` | 发现截断时同步 | fail closed 标记 |
| `cancelRequestedAt`/`cancelSignal` | `string`/`string` | cancel 同一事务 | 取消意图（143 不足为据） |
| `killAfter` | `string`（iso） | 首次终止请求时 | 绝对终止期限；重启不延长 |
| `terminationPhase` | `'term'`/`'kill'` | 终止推进时，只向前 | 重启不回退阶段 |
| `recovery` | `'pending'` + 原因 | 恢复分类时 | 恢复待定，UI/CLI 可见 + 人工处置 |
| `noOutputDeadline` | `string`（iso） | beforeSpawn 同步 | 绝对截止，不跨重启重置 |
| `firstOutputAt` | 现有，改同步 | first-output 同步 | 同上 |
| `vendorError`/`retryAt` | 现有位置，改同步 | 首次致命分类时同步 | 重放不重新分类 |
| `unknown_outcome` | failure kind（`task.failure.kind` 新增值） | 无合法 exit 且无取消/失败意图的收尾（§11.2 R1 规则） | “执行结果未知”失败收尾；重试由 owner 显式操作 |
| `stderrTail`/`resultSummary` | `string` | 同步 | close 诊断与成功判断 |

（约束：以上全为 `tasks.body` JSON 普通字段，不改表、不升 `SCHEMA_VERSION`；回滚语义见 §12。）

dispatch/retry 的持久意图状态放在现有 SQLite 的 task（`dispatch/scheduled/queueReason/retryOf`）/receipt JSON 中，不新增 JSON 状态文件（B11）。

---

## 修订记录：v1 → v2

- 来源：Convorel 任务 `weaver-live-upgrade-1022`（ChatGPT Pro，源码基线 `b3bcd2b`，v1 文件 SHA-256 前缀 `c8b0c7f3ffd3`）。“已确认问题”经 owner 对照源码逐条核实成立，**全部采纳，本轮无拒绝项**。
- A1（§3.2/§3.3/§3.5）：sh 外壳不 exec 引擎、后台运行 + `0<&0` 显式保留 stdin、空操作 trap（禁 `trap ''`）、打断后循环 wait 到真实退出、exit 绑定 runId + beforeSpawn nonce、同目录 tmp+rename、不声称 wait 数值恢复信号、成功/失败与取消意图分开、6 项验收用例。
- A2（§11.4）：无 invocation 时 FD 正向证据只作正向证据，含 6 条实现约束；证据不足进恢复待定，不盲杀。
- A3（§10.1/§4.4）：停机有界等待在途 identity 落库；阻止未完成 pi 预检关库后继续 launch。
- A4（§12/§15.3）：回滚改为先在新版本 `server stop --cancel-workers`（或确认无运行中 worker）再降级；写明旧版标 failed 且不杀 scope 的孤儿风险。
- A5（§16-P2/§11.5）：schedules claude-native direct（持续打开 stdin 管道）不支持跨重启，保持 interrupted 并写明原因；script 与 direct CLI 走文件模式。
- A6（§10.3/§10.2）：reattach 在调度 pump 启动、服务 ready 之前完成；初始化失败清理顺序与 detach 相同。
- A7（§12/§18 第 4 项）：日志体积与每次重启从头重放成本入风险；normalizer 快照列为后续可选优化，写明快照必须包含的状态与绑定条件。
- B1（§6.2/§17-#4）：finish 批次（records/resultSummary/最终 evidence/最终游标/run-task 终态/收尾事件/`finalizedAt`）同一事务提交；恢复时已收尾不重放 finish；失败收尾同样标记。
- B2（§6.3/§17-#5）：行批次原子——整行先算完再一次性形成行末 offset 快照；pending 快照满足游标前整行完整；一行失败不留部分效果；保留 500ms 批量落库。
- B3（§6.5/§17-#24）：只发布已提交状态；纠正 `checkpoint`（`src/main/store.ts:60` 在 `src/main/storage/transaction.ts:34-35` COMMIT 之前，非提交成功回调，不得发布事件/删日志）；`store.get()` 仅新进程无 pending 时等于已提交位置。
- B4（§11.1/§13/§17-#11）：恢复按 run 生命周期枚举（含 `failed` 但未确认停止的 run）；失败决定先持久化、外部停止确认后收尾；manifest 收尾事务提交前 `RESULT_NOT_READY`、发布后不变；清理不只看业务终态。
- B5（§11.2(4)/§11.3/§17-#12）：exit 独立于 scope ActiveState 检查；exit 表直接引擎退出；scope 仍活则核验归属后清后代、确认无输出后消费最终 EOF 收尾；EOF≠结束。
- B6（§11.2(11)/§11.3/§17-#13/#14）：已归属但日志缺失/截断/身份变化/无法解析→先持久化失败与终止意图、确认 scope 终止后收尾；归属不明→恢复待定，不盲杀、不当安全结束。
- B7（§9.2/§9.4/§17-#9/#10）：意图绑定 `(taskId,runId)`，回放/finish 前恢复门禁；取消后输出只用于重建/诊断；首次终止持久化绝对 `killAfter` + 阶段，重启不延长、不回退，过期直接 KILL；适用于 vendor-error/协议/no_output 终止。
- B8（§7.2/§7.3/§17-#23）：终止依据改为分类器致命 TaskFailure；成功提交前排空双流；已提交决定不被重放推翻；同一决策批次内多致命错误固定优先级 `auth > quota > rate_limit > model > no_output/early_exit > other`，同级以稳定来源键选择；未完成行 probe 仅在线；恢复只分类完整行并承认观察时刻依赖。
- B9（§14.2/§17-#21）：只读请求同时处理传输异常与错误信封；`APP_NOT_RUNNING/TRANSPORT_ERROR/APP_DRAINING/APP_STARTING` 有界重连；实例轮换允许重读 discovery 后重试鉴权一次；owner 身份/权限/协议/安全错误不重试；保留 taskId/ownerAuth/已提交游标；轮换不重置预算；最终错误保留实际码 + 已提交快照。
- B10（§10.4/§17-#18）：单例锁（开库前 `flock`，tailer 停 + pending 落盘 + 关库后释放；进程死亡内核释放）；discovery 同目录 tmp + fsync + rename 原子发布，不兼进程锁；持锁者可清理遗留空/损坏 discovery。
- B11（§16-P1/§17-#16/#17）：dispatch（package/dispatch/`scheduled=true` 同事务，统一 pump 启动，不直接 `manager.start`）与 retry（取消意图 + 稳定 replacement ID + package + `retryOf` + 待派发意图 + operation/task/attempt ID 同事务，kill/spawn 在提交后）持久意图；状态放现有 SQLite task/receipt JSON；不自动重发与恢复已提交操作是两条独立规则。
- B12（§4.4/§16-P1/§17-#15/#19）：`StartCliAgent`（`src/main/adapters/launch.ts:5`）与 `guardPiLaunch`（`src/main/adapters/cli/pi-guard.ts:30-58,83-85`）等包装层透传 `beforeSpawn`；停机中止未完成 pi 预检，可证明从未启动的回 `queued + scheduled`。
- C（§11.2 表/§11.4/§11.5）：恢复表替换/扩充 11 行（含 systemctl unknown→待定、deactivating/停止意图继续原阶段、短命 worker 的 exit 优先、未注册 launcher 的 `/proc` systemd-run 确认 + 从未启动回 queued、present/absent/unknown 三态以 `recoverOwnedScope` inspect 为先例不用 `showScope` 折叠）；`run.recovery='pending'` 对 UI/CLI 可见 + 人工处置方法。
- D（§8.2/§6.6/§17/§18/§0/§16/附录）：先查积压日志再执行过期 no_output（无可靠时间戳只确认恢复时已有输出）；“恰好一次”承诺范围；§17 合并去重（14 + 10 故障注入 + 6 sh 外壳）并标目标文件；§18 增四窗口实测与日志体积风险；§0/§16/附录字段表同步更新（含 `nonce/logIdentity{dev,ino}/finalizedAt/killAfter/terminationPhase/recovery`）。

---

## 修订记录：v2 → v3

- 来源：同一 Convorel 任务第二轮审查（ChatGPT Pro，结论**未通过**，源码基线 `b3bcd2b`，工作树其他会话改动未计入）。R1–R3 经 owner 对照基线源码逐条核实成立，全部采纳；审查意见二.1（UI 延迟取舍）/二.2（锁顺序）/二.3（优先级作用域）/二.4（real spawn 返回时机）采纳；可选补强（flock 不变量、三个切点）采纳。按审查轮次上限（每个决策版本最多 2 轮），v3 由 owner 最终决定，**未再提交第三轮外部复审**；R1–R3 均采用审查方给出的修正方向。
- R1（§4.2/§4.3/§4.4、§11.2 第 5/9/10 条及“从未启动的判定”、§3.4、§17-#31、附录）：引入 `run.launchPermittedAt`（`beforeSpawn` 事务与 unit/nonce/logIdentity 同提交，提交前为 preparing，提交后才允许 spawn）；只有许可未提交的 run 可安全回 `queued + scheduled`；许可已提交后绝不因零日志/无 exit/无 launcher 自动重排（存在性或归属未定 → 恢复待定；确认无 launcher 且 scope 已停 → 按意图收尾，无意图以 `unknown_outcome` 失败收尾，重试显式操作）；launcher/scope 检查收敛（inspect → `/proc` 扫描 → 再 inspect，两次 absent 且中间无 launcher，基线 `scope.ts:111` 为先例，不复用扫描前 not-found）；写明单加 prepared 字段不能区分提交后是否真执行。
- R2（§11.1 新增正文、§14.2 引用、§16-P1 `results.ts`/`poll-task.ts` 改动点）：新文件生命周期真实 run 以业务终态 + `run.finalizedAt` 双提交为 `wait/watch` terminal 条件；失败已提交但终止/收尾未完成继续等待（stopping/recovery pending），截止按 timeout 返回；native/mock 按各自完成条件，升级前已完成历史记录保留原含义；`retry --cancel` 快速替代语义保留。
- R3（§16-P1 dispatch 段 + `gateway.ts:122` 改动点、§14.2、§17-#33）：有容量 native dispatch 在持久接纳同一事务内完成 `manager.start` native 登记（无外部进程、无孤儿风险），`workers spawn` 仍直接返回 `next.run_subagent`；排队 native（及响应丢失、重连路径）由 `tasks wait` 以 `reason='handoff'` 交回 `run_subagent`（绑定 taskId + attemptId，重复读取同一指令，已有执行句柄不重复启动），修复基线排队 native 交接缺口（`poll-task.ts:62`、`dispatch.ts:79`、`queries.ts:44`）；real 的 `workers spawn` 统一 pump 后返回持久接纳，`started:false` 可为正常状态（`gateway.ts:122` first-output 分支不再进入）。
- 二.2（§10.3/§10.4/§16）：锁顺序统一为先单例锁 → 打开/迁移数据库 → 构造组件 → reattach → 启动 pump → 对外 ready；关闭时锁覆盖在途写入、数据库关闭及本实例 IPC/discovery 清理，全部完成后释放，释放后不再做端点清理。
- 二.3（§7.3/§7.4/§17-#23）：致命优先级作用域改为审查意见二.3 正文——已提交失败决定不变，后续错误只补诊断；固定优先级只用于同一未提交决策批次内候选，同级以稳定来源键（流名 + 字节偏移）选择，不以分类完成时间；不同批次不承诺相同原因。§17-#23 改为“同一候选集合、同一决策批次内改变解析顺序结果一致”，另加“`rate_limit` 已提交后出现 auth，重启后仍保持原决定”。
- 二.1/二.4（§6.5、§16-P1 `gateway.ts:122`）：UI 增加约一个 500ms flush 周期的显示延迟是取舍而非回归；实现须覆盖 UI 的 list/get 入口，定时 flush 的实际 COMMIT 也要触发通知。
- 可选补强（§10.4、§17-#31/#32/#33）：flock 锁 FD 为 CLOEXEC、不进入 worker stdio/保留 FD、锁文件不 unlink 重建，“控制面死亡自动解锁”前提是没有存活继承副本，列为实现验收条件；§17 新增三个切点（许可已提交无日志/exit 不得重跑；failed 已提交未 finalized 时 wait 不返回 terminal；排队 native 交回同一 attempt 的 handoff），均标明目标文件。
- owner 自查小项：§11.4 一处西里尔字母乱码改为“（一致性）”并全文明码检查；§3.2 伪代码改为 kill -0 失败后再执行一次 `wait $child` 取真实退出状态；§17-#13 改为“恢复待定 + 无 kill 调用”（不是 failed）、#15 改为“`launchPermittedAt` 未提交 → 回 `queued + scheduled`；已提交但无证据 → 待定或 `unknown_outcome`，不触碰 scope”，并全文检查 §3.4/§4.3 等与 §11.2 表矛盾的表述；修复失效引用（不存在的旧 7.5 节引用改指 §7.2 与 §18 第 6 项，旧回滚引用改指 §15.3，旧四窗口引用改指 §17.2，旧快照引用改指 §18 第 4 项）并全文检查其余 § 引用；附录字段表补 `launchPermittedAt`、`unknown_outcome`；§0 结论与 §16-P1 改动点同步。
