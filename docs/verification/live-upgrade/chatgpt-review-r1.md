**结论：选定方向可以保留，但这版方案还不能保证“任意时刻重启后工作继续、结果与事件恰好一次”。**主要缺口集中在三处：**日志字节之外的收尾事务、业务终态与进程终止的区分、启动及命令执行中间阶段的恢复。**

我核对了：

- 源码基线：`b3bcd2b77486a869cfb0490eac23b29da96dcb71`。
- 方案：`/home/mocha/opensource/weaver/docs/live-upgrade.md`，496 行，SHA-256 `c8b0c7f3ffd383f6363c35d1bd4d2170d4303a604f81fdbbb363bb7731e0f56e`；审查结束时指纹仍一致。
- 以下“已确认”指**代码和方案允许构造出具体错误时序**，不表示已经实机复现。当前 Convorel 的 `buildsAndTests=false`，本次没有运行测试或操作 systemd。

你列出的七项已知问题，我没有重复列为发现；下面涉及它们的部分，主要评价拟议修法是否充分。

## 一、已确认问题

### 1. §6 的字节游标没有覆盖 `normalizer.finish()`，这是 result 重复或错误收尾的直接窗口

真实引擎的 `artifact/result` **不是某条日志行直接产生的**。

`normalizer.push(line)` 主要累计状态；成功时的 `result.md` 和 `result` 在 `finish()` 中一起产生。随后 `CliAgent.complete()` 先发送这批 records，再发送 `close`。证据：

- `/home/mocha/opensource/weaver/src/main/adapters/cli/normalize.ts:136–162`
- `/home/mocha/opensource/weaver/src/main/adapters/cli/launch.ts:233–247`
- `/home/mocha/opensource/weaver/src/main/manager.ts:103–120,191–206`

**反例时序：**

1. 最后一条原始日志已经应用，`stdoutOffset` 提交到 EOF。
2. `normalizer.finish()` 生成 artifact 和 result。
3. 按 §7.4，应用 result 时同步保存 `run.resultSummary`，这批输出已进入数据库。
4. **在 manager 的 close 将任务改成 completed 之前，服务被 SIGKILL。**
5. 重启看到任务仍 running、游标已经在 EOF，于是从头重建 normalizer，然后再次执行 finish。

此时有两种直接错误：

- 再应用 finish 输出：重复 artifact/result。
- 从 `resultSummary` 恢复 `Running.result`，但仍应用 finish 输出：`record()` 在 `manager.ts:193` 抛出 `Records after terminal result are not allowed`，成功任务可能被当成协议错误。

**§7.4 的 `resultSummary` 确实解决了“成功摘要只在内存里”的问题，但没有定义“整个 finish 批次已经提交”的含义。**`appliedRecords` 也只是计数，§6.3 没有给出针对这批无新增日志字节的 records 的恢复算法。

**最小修正：**为 finish 增加独立、持久的幂等边界。推荐将 finish records、最终 evidence、summary、游标、run/task 终态一起提交。也可以分成两个事务，但第一个事务必须完整提交 finish 批次及标记，第二步 close 必须可以幂等续办。

可直接补入 §6：

> `normalizer.finish()` 的输出属于独立收尾批次，不对应新增日志字节，不能仅凭 stdoutOffset/stderrOffset 去重。该批次的全部 records、resultSummary、最终 evidence 及 finishApplied 标记必须原子提交。恢复时，已经提交 finishApplied 的运行只恢复收尾材料，不再次应用 finish records。优先将该批次与最终游标、run/task 终态和收尾事件在同一事务提交；失败收尾同样需要该标记，不能以存在 resultSummary 作为唯一判断。

---

### 2. “每条 record 分别 put，最后推进整行游标”仍允许半行提交

这里需要精确区分：**500ms 定时器不会插进一个没有让出执行权的同步 JavaScript 循环**。因此，不能仅凭“每条 stream put”就断言它必然半行落库。

但现有链路有明确的异常路径：

- 一条 qoder assistant 行可以产生多个工具记录。
- `JsonlParser` 在第 1001 条 normalized record 抛错。
- 先前已处理的 records 留在 `pending`。
- `stop()` 只设置内存中的 `run.error` 并开始终止，没有回滚这一行已经放进 pending 的部分。

证据：

- `/home/mocha/opensource/weaver/src/main/adapters/cli/normalize.ts:340–355`
- `/home/mocha/opensource/weaver/src/main/protocol.ts:29–33`
- `/home/mocha/opensource/weaver/src/main/manager.ts:85–88,183–206`
- `/home/mocha/opensource/weaver/src/main/store.ts:98–107`

**反例时序：**

1. parser 已接受 999 条记录。
2. 原始日志行 L 产生两个工具记录。
3. 第一个成为第 1000 条，事件进入 pending。
4. 第二个触发超限；按照 §6，L 未全部成功，行末 offset 不能推进。
5. worker 尚在 TERM 宽限期，500ms flush、其他同步事务或 detach flush 将**第一个事件和旧 offset**提交。
6. 重启后重放 L，第一个事件再次生成。

**影响：**数据库里的事件也可能重复；不仅仅是客户端展示重复。重建 parser 后只计算后缀，还可能让原来触发的整次运行配额失效。

**最小修正：**把一整行作为一个应用批次：先验证并计算所有 records 和旁路效果，再一次性形成包含行末 offset 的 task 快照；不能把前半行先交给可被 flush 的 pending。

可以继续保留 500ms 批量落库，不必每行都同步写。关键是：

> pending 中的每份 task 快照自身必须满足“该游标之前的整行效果完整存在”。一行处理失败时，不得留下该行的部分事件、artifact 或游标。同步持久化的 firstOutput、错误分类等旁路，也必须纳入相应输入批次的提交规则。

---

### 3. pending 对外可见，导致 watch 游标失效；数据库应用一次不等于事件交付一次

`TaskStore.get()` 优先返回 pending，而不是数据库已提交快照。`tasks.events` 使用这个值，CLI 则会立即输出事件并保存其 UUID 游标。

证据：

- `/home/mocha/opensource/weaver/src/main/store.ts:77–80,98–107`
- `/home/mocha/opensource/weaver/src/main/application/tasks/queries.ts:53–56`
- `/home/mocha/opensource/weaver/src/cli/poll-task.ts:45–59`

**反例时序：**

1. 事件 E 和对应日志游标进入 pending，尚未 flush。
2. watch 读到 E，输出给 owner，并保存 `after=E.id`。
3. 服务崩溃，E 和游标都未提交。
4. 新服务从数据库游标重放，产生相同内容、不同 UUID 的 E′。
5. watch 带旧 `after=E.id` 请求，服务返回 `CURSOR_EXPIRED`。

当前 CLI 会退出。如果修复时简单清空 `after` 重读，则会重复输出已经交付的事件。

**最小修正：**

- 对外可续接事件流只发布已提交事件，通知也在实际 commit 后发布。
- 或引入跨重放稳定的事件身份和明确的消费者去重协议。
- `store.get()` 不能被普遍称为“读取数据库已提交位置”；**新进程刚创建的 store 没有 pending 时才成立**。

另一个需要纠正的实现细节：`TaskStore.checkpoint` 在 `store.ts:60` 调用，实际 `COMMIT` 在 `/home/mocha/opensource/weaver/src/main/storage/transaction.ts:34–35`，所以它**不是提交成功回调**。文档虽然声明不依赖它保证正确性，也不能用它发布事件或删除日志。

---

### 4. §11 按 task.status 恢复，会漏掉已经 failed、实际仍活着的 worker；最终结果还可能变化两次

`failAttempt()` 的顺序是：

1. `task.status='failed'`；
2. 同步持久化；
3. 调用 terminate；
4. 等真正 close 后，才写 `run.status='stopped'`、exitCode 等。

而 §11.2 仅扫描 running/cancelling。

证据：

- `/home/mocha/opensource/weaver/src/main/manager.ts:103–120,164–168`
- `/home/mocha/opensource/weaver/src/main/domain/tasks.ts:5–13`
- 方案 §11.2，第 311 行

**反例时序：**

1. vendor-error 或模型不匹配触发 failAttempt，failed 已提交。
2. 在发 TERM 前，或 TERM→KILL 宽限期间重启。
3. 新服务跳过 failed task。
4. 旧 scope 继续执行；任务已经允许重试，可能出现两个 worker 同时修改工作区。

这不是你已列出的“缺 InvocationID”问题：**即使 InvocationID 已完整持久化，也会漏掉。**

此外，结果接口仅检查 `terminal(task)`，就生成包含 exitCode、failure 的 manifest；close 随后又补这些字段。因此 owner 可以先拿到 M1，close 后拿到 M2。mock 投递按 `taskId + manifestDigest` 去重，会把它们视为两个结果。

证据：`/home/mocha/opensource/weaver/src/main/application/tasks/results.ts:15–24`。

**最小修正：**将“失败结论已决定”与“外部执行已结束”分开。恢复、并发占用、retry 安全条件、结果可见性和日志清理，都必须考虑尚未完成的 run 生命周期。

可直接替换 §11 的恢复对象定义，并同步修改 §13：

> 恢复枚举不得仅依赖 task.status。所有已经记录启动意图、尚未确认本次 launcher 与 scope 清理完成、或尚未完成收尾提交的真实 run，均进入恢复，包括 task.status 为 failed 的运行。失败决定先持久化，外部进程确认停止后再完成 run 收尾。最终 manifest 只在收尾事务提交后发布，发布后其结果内容保持不变。日志回收和执行资源释放不得仅依据 task 已进入业务终态。

---

### 5. §11 把“scope active”和“引擎还在运行”等同，会永久卡住已有结果的任务

当前 scope 实现特意处理了“直接 CLI 已退出，但后台后代仍在 scope 中”的情况：收到 child `exit` 后清理整个 scope，等待输出排空后才 close。

证据：`/home/mocha/opensource/weaver/src/main/adapters/cli/scope.ts:291–312`。

**反例时序：**

1. CLI 派生后台子进程。
2. Weaver 停机期间，CLI 退出，修正后的 sh 成功写出 exit 文件。
3. 后台子进程仍在 scope 内，所以 scope 仍 active。
4. 重启只进入 §11.a；该分支没有读取 exit 文件。
5. 旧 child-exit 通知已经丢失，任务一直被当成 running，结果不能交付。

systemd 的 scope 生命周期由组内进程整体决定，没有 main process；只要仍有进程，scope 就可能继续存活。[freedesktop.org](https://www.freedesktop.org/software/systemd/man/257/systemd.scope.html?utm_source=chatgpt.com)

**最小修正：**在线 attach 和恢复都必须独立观察 exit 文件。exit 表明直接引擎退出；随后清理匹配 scope 的残余后代，再消费两个文件的稳定最终 EOF，最后 finish。

不能看到 exit 就立刻 finish：后代还可能追加日志。原来 Node 的 `close` 包含 stdio 已关闭的含义，文件模式需要主动重建这个收尾条件。[Node.js v22.23.3 Documentation](https://nodejs.org/download/release/v22.23.3/docs/api/child_process.html?utm_source=chatgpt.com)

可采用正文：

> 退出记录独立于 scope ActiveState 检查。合法退出记录表示直接引擎已退出，不表示所有后代已退出。scope 仍存活时，核验归属并执行现有 child-exit 路径等价的后代清理；确认本次执行不再产生输出后，消费两条日志的最终 EOF，再执行收尾事务。文件暂时读到 EOF 不构成运行结束。

---

### 6. §11.c 对“已证明归属，但日志截断或换 inode”的处理仍会留下孤儿

文档第 329 行只有“InvocationID 匹配但日志**缺失**”允许先杀 scope；截断、inode 变化仍落入“不杀”的默认规则。

**反例时序：**

1. live scope 的 InvocationID 与数据库完全匹配。
2. 日志被 truncate 或替换。
3. 恢复将任务标 failed，但不终止 scope。
4. worker 继续写工作区，后续 retry 可以启动另一份任务。

**最小修正：**把例外扩大到所有“归属明确、但已经无法安全恢复解析”的情况。**日志完整性失败不应撤销已经成立的进程归属证据。**

建议正文：

> 对已证明属于本 run 的 scope，若日志缺失、截断、身份变化或解析协议无法继续，应先持久化失败及终止意图，完成 scope 终止确认后再收尾。无法解析日志不得成为遗留已归属进程的理由。归属不明确时则保留恢复待定状态，不按名字盲杀，也不把未清理的运行当成已安全结束。

---

### 7. §9 的取消意图方向正确，但还缺“恢复门禁”和“不重置的终止期限”

#### 7.1 先重放、后按取消收尾，会改变当前在线行为

当前 manager 在 `run.cancelled` 后忽略 stdout/stderr records。§11.b 却先要求“应用剩余 records，含 result”，之后才分类退出。

证据：`/home/mocha/opensource/weaver/src/main/manager.ts:85–101,127–139,191–193`。

**反例：**取消意图提交 → worker 继续输出 → 服务重启 → scope 已结束 → 恢复先应用未消费输出 → 最后标 cancelled。这样会给已取消任务增加在线路径本来不会接受的事件或可交付材料。

**最小修正：**在任何记录应用和 finish 之前恢复取消、失败门禁；`finish` 必须得到正确的 `cancelled`。可以读取字节重建解析状态，但不能把取消后的未应用输出重新当成可交付结果。

#### 7.2 每次重接重新给 1500ms，会让取消无限延期

**反例：**worker 忽略 TERM，每隔不到 1500ms 重启一次；旧 killTimer 消失，新实例又给满 1500ms，KILL 永远不到。

同样的问题也适用于 vendor-error、协议错误、no_output 引起的终止。

**最小修正：**持久化或由首次意图推导绝对 `killAfter`，恢复只等待剩余时间；过期直接升级 KILL，阶段不能倒退。

可直接补入 §9：

> 取消及失败终止意图绑定 `(taskId, runId)`，在回放前恢复。首次请求终止时记录固定 killAfter 和终止阶段；重启不得延长宽限，也不得将已经进入 KILL 阶段的运行降回 TERM。存在取消或失败决定时，后续原始输出仅用于状态重建和诊断，不生成新的可交付结果。

---

### 8. §7.3 “任一 vendor-error 都 failAttempt”比现行语义更宽，会误杀可恢复的工具错误

**“已经分类为致命错误的事件优先于成功”本身没有新增回归。**现有代码已经会立即失败；正常 complete 也先排空 stderr，再调用 normalizer.finish。

但当前代码区分：

- 广义 `vendor-error` 诊断事件；
- 分类器实际返回的 `TaskFailure`。

`launch.ts` 可能仅因为 `value.error` 存在而发 `vendor-error`；manager 只有在 `failure` 存在时才调用 failAttempt。

证据：

- `/home/mocha/opensource/weaver/src/main/adapters/cli/launch.ts:154–164,233–247`
- `/home/mocha/opensource/weaver/src/main/manager.ts:81`
- `/home/mocha/opensource/weaver/src/main/adapters/cli/normalize.ts:454–469`

**机制反例：**

dsh 的 `tool_result` 带 `status:"error", error:"ENOENT"`，随后 turn 正常完成：

- 当前 normalizer 明确把工具失败视为普通 Agent 流程。
- 广义 vendor-error 可以被触发，但没有致命 TaskFailure，任务可继续成功。
- 按“任一 vendor-error 即 failAttempt”的正文，则会提前终止。

这是代码接受范围内的反例，不是声称真实 dsh 一定输出这组字段。

另外，**错误优先于成功只解决了成功/失败二值，未解决失败类别顺序。**stdout 含 429、stderr 含 401，现有 `failAttempt` 是 first-error-wins；先读哪个流，会影响 auth/rate_limit、retryAt 和后续封禁策略。

可替换 §7.3：

> 跨流错误优先级针对已分类为致命 TaskFailure 的错误，不以 vendor-error 事件名或普通工具失败作为终止依据。成功提交前必须排空两个流并完成分类。已提交的取消或失败决定不可被重放推翻；尚未提交、同时存在的多个致命错误必须采用明确且稳定的原因选择规则，避免读取流顺序改变失败类别、retryAt 或自动封禁行为。

---

### 9. §14 漏掉正常停启时的错误信封，owner `tasks wait` 仍会立即失败

正常 shutdown 先设置 draining、撤销 ready，最后才关闭 IPC；启动则先建立 IPC，稍后 ready。因此请求完全可能传输成功，却得到：

- `APP_DRAINING`
- `APP_STARTING`

证据：

- `/home/mocha/opensource/weaver/src/main/runtime.ts:170–185,250–254,274–293`
- `/home/mocha/opensource/weaver/src/cli/poll-task.ts:45–51,68–74`

**反例时序：**owner wait → 服务收到 TERM → socket 仍能连接 → `tasks.get` 返回 `ok:false, APP_DRAINING` → CLI 立即退出。根本不会进入当前文档列出的传输异常重连。

**最小修正：**统一分类传输异常和错误信封；为上述两个状态使用相同的有界重连预算。

关于“会不会掩盖真实故障”：

- **60 秒有界等待本身只延迟报告，不会无限掩盖。**
- 看到新 instanceId 就重置宽限，会让崩溃循环无限延长。
- IPC token 错误和 owner credential 错误都可能表现为 `UNAUTHORIZED`；实例变化不能证明 owner 身份错误可以忽略。
- 应保留 ownerAuth，不能为重连而移除它或退回另一种身份。

可替换 §14.2：

> 只读请求同时处理传输异常与错误信封。APP_NOT_RUNNING、TRANSPORT_ERROR、APP_DRAINING、APP_STARTING 可进入有界重连；明确的 IPC 实例轮换允许重新读取 discovery 后重试鉴权一次。owner 身份失败、权限失败、协议错误及安全校验失败不得笼统重试。重连保留 taskId、ownerAuth 和已提交事件游标，不重新初始化整个 pollTask。请求超时与退避同时受原始等待截止和连续不可用宽限约束；实例轮换本身不重置预算。最终错误应保留实际错误码和最后一次已提交快照，不能统一声称服务正在重启。

---

### 10. IPC discovery 可以被重启留成空文件，导致后续服务永久启动失败

这条在任务恢复之外，但会直接阻断 reattach。

当前实现先 `open(discoveryPath,'wx')` 创建最终文件，再分别 await stat、writeFile、sync。启动恢复代码若 JSON.parse 失败，会直接放弃判断 stale；下一次创建又因为 EEXIST 失败。

证据：

- `/home/mocha/opensource/weaver/src/main/local-ipc.ts:102–115,213–223`
- `/home/mocha/opensource/weaver/src/cli/commands/web.ts:88–105,122–125`

**反例时序：**

1. 新实例创建空的 `control.v1.json`。
2. 在写完整 JSON 前再次 restart 或崩溃。
3. 下次启动不能解析它，也不能证明它可以清理。
4. exclusive create 持续报 `ENDPOINT_EXISTS`。
5. worker 仍存活，但新控制面起不来。

即使没有崩溃，重连客户端也可能读到创建与写入之间的空文件，得到 `UNSAFE_ENDPOINT` 并退出。

**最小修正：**将活进程互斥和 discovery 发布分开。先取得可靠单例锁，完整写入同目录临时文件并同步，再原子发布；不能简单重试所有 `UNSAFE_ENDPOINT`，也不能无条件删除无法解析的文件。

建议新增正文：

> discovery 必须完整写入后原子发布，不兼任可被中断写入的进程锁。单例锁在打开数据库前取得，直到所有 tailer 停止、pending 写入完成、数据库关闭后才释放。启动中断遗留的空或损坏 discovery 必须有安全的恢复路径，不得永久阻止后续启动。

---

### 11. dispatch 和 `retry --cancel` 没有完整的持久化操作意图，会留下无法继续执行的任务

#### 11.1 dispatch 已接纳，但还没 start

有容量的 dispatch 路径先持久化 `task.dispatch`，随后才 `manager.start`；中间状态仍是 queued，且没有 `scheduled=true`。

调度器只自动处理 `queued && scheduled && dispatch`。

证据：

- `/home/mocha/opensource/weaver/src/main/application/scheduling/dispatch.ts:117–121`
- `/home/mocha/opensource/weaver/src/main/application/scheduling/coordinator.ts:38–43`

**反例：**dispatch 已提交 → manager.start 前崩溃 → §11 不扫描 queued，pump 不扫描未 scheduled → 任务永久搁置。

普通 SIGTERM 回调通常不能打断这个同步调用栈，但 SIGKILL/崩溃可以，方案已明确包含崩溃。

**最小修正：**所有已接纳 dispatch 都必须落入可恢复的待启动阶段。最小实现可以是 package、dispatch、`scheduled=true` 同事务提交，再由统一 pump 启动。

#### 11.2 retry 已取消原任务，但 replacement 尚未完整接纳

当前顺序是：

1. cancel 原任务；
2. 另一个事务创建 retry task/package；
3. 写原任务 backlink 事件；
4. 再 dispatch 新任务。

证据：`/home/mocha/opensource/weaver/src/main/application/scheduling/retry.ts:140–153`。

**两个反例：**

- cancel 提交后、创建 replacement 前崩溃：原任务被取消，替代任务根本不存在。
- replacement 已创建、dispatch 前崩溃：新任务 queued，却没有可恢复的派发意图。

`operations get` 返回 indeterminate 只能报告不确定性，不能自动补完这项操作。

**最小修正：**原任务取消意图、稳定 replacement ID、package、retryOf、待派发意图及 operation 关联信息先同事务提交；外部 kill/spawn 在提交后执行。恢复推进同一个 operation，不能重新创建替代任务。

可新增正文：

> dispatch 和 retry 均采用持久化阶段恢复。已接纳任务不得处于既无运行记录、又不被调度器识别的 queued 状态。retry 的取消意图、替代任务及其关联与待派发意图必须原子提交，重启后按原 operation/task/attempt ID 继续执行。变更命令不自动重发，与恢复已提交操作是两个独立规则。

这些状态可以放在现有 SQLite 的 task/receipt JSON 中，不需要新增 JSON 状态文件。

---

### 12. §4 的 beforeSpawn 接线漏过 `guardPiLaunch`，照当前改动清单做会继续存在启动前未落库窗口

运行时注入 RoutingWorkerAdapter 的实际 launcher 是：

`guardPiLaunch(startCliAgent, checkPiModel)`

但 guard 返回的函数只接受 input，非 pi 分支也只调用 `launch(input)`；pi 预检结束后同样如此。

证据：

- `/home/mocha/opensource/weaver/src/main/runtime.ts:237`
- `/home/mocha/opensource/weaver/src/main/adapters/launch.ts:5`
- `/home/mocha/opensource/weaver/src/main/adapters/cli/pi-guard.ts:30–58,83–85`

**反例：**routing 开始传 beforeSpawn → 外层 guard 丢掉参数 → 实际 startCliAgent 没有 hook → scope 先启动、持久归属记录未建立 → 崩溃窗口仍在。

**最小修正：**扩展 launcher 类型和所有包装层，明确透传同一 beforeSpawn。

你提出的“detach 有界等待 identity”还需补一条：**pi 预检尚未结束时根本没有 identity 可等。**detach 必须阻止尚未完成的预检在关闭数据库后继续 launch；不能只等待已经启动的 scope 身份落库。

---

## 二、§11 分类与 inode 修法：还需要怎样补全

### 分类目前既有遗漏，也有重叠

建议把下面这些情况明确写入恢复表：

| 观察结果 | 应采用的处理 |
|---|---|
| systemctl/D-Bus 查询失败或超时 | 保持恢复待定，保留日志和执行占用；不能当成 scope 不存在 |
| 已归属，处于 active/activating，尚无退出记录 | 接回，并处理启动中的过渡状态 |
| 已归属，处于 deactivating，或已有停止意图 | 继续原终止阶段，使用原绝对期限 |
| 已有合法退出记录，但 scope 仍有后代 | 清理匹配 scope 的后代，再消费最终 EOF |
| scope 已确证消失，且没有仍可能注册 scope 的 launcher | 使用本 run 的日志和退出记录收尾 |
| 无 InvocationID，但找到有效 FD 正向证据 | 补写当前 InvocationID，再接回或终止 |
| 无 InvocationID、scope 已结束、本 run 的退出记录可信 | 允许收尾；不能仅因拿不到活进程身份而丢弃结果 |
| InvocationID 不匹配，或证据不足 | 不操作不匹配的 scope；本 run 保持待核验，不能假装外部执行已清理 |

其中有两个容易遗漏的边界：

- **短命 worker：**可能在首次 identity 查询前已经结束并被 collect。此时同时满足原文的“无 invocation→c”和“scope 已结束→b”。必须规定 b/c 的优先级和退出文件的 run 身份绑定。
- **尚未注册的 launcher：**一次 not-found 不能证明以后不会出现 scope。现有代码已经专门防这个窗口，见 `/home/mocha/opensource/weaver/src/main/adapters/cli/scope.ts:209–219`。新恢复不能丢掉这项保证。

另外，新的 inspect 不能直接沿用会把多种查询失败折叠成 undefined 的 `showScope`；应保留 present/absent/unknown 三态。现有 `recoverOwnedScope` 的 inspect 比这个简化辅助函数更适合作为先例。

### inode 修法是有用的补充，但它只提供正向证据

**“在预期 scope 中发现本 run 独占日志 inode 的写 FD”可以帮助补回 InvocationID；“没发现”不能证明进程已经结束。**

需要把这些条件写进方案：

| 情况 | 对归属判断的含义 |
|---|---|
| 引擎关闭或重定向 stdout/stderr，sh 仍保留这些 FD | 证明仍可能成立，不应只检查引擎 PID |
| 子孙继承日志 FD | 正常关联证据，但命中 PID 不等于主 CLI |
| sh/CLI 已退出，仅剩关闭了日志 FD 的 daemon | 无 FD 命中仍可能有活进程 |
| 文件删除后重新创建 | dev/inode 数值不能当永久 run 身份，必须避免复用 |
| 后代显式迁移到其他 scope | 不能据一个继承 FD 就杀掉另一个 scope 的全部进程 |

FD 继承是正常的 fork 行为；`fdinfo.flags` 可以核对访问模式，但它不能替代生命周期证明。[Linux manual page](https://man7.org/linux/man-pages/man2/fork.2.html?utm_source=chatgpt.com)

最低限度的实现约束是：

1. **每个 run 独占文件，先创建、fstat、持久化，再用同一已打开 FD 启动。**不能先 stat 路径，spawn 时又重新 open 一个可能已经变化的对象。
2. sh 从启动到退出保留明确的锚定 FD；退出记录绑定 runId/随机标识。
3. 只在预期 unit 的 cgroup 内检查，覆盖子 cgroup，并核对 PID starttime、FD 类型/写权限及检查前后的 InvocationID。
4. 成立后先持久化 InvocationID，再进入长期管理。
5. 证据不足时保留恢复待定；不删文件、不释放占用、不自动开启可能重叠的新 attempt。

**因此，你的第 2 项修法能关闭一部分窗口，但不能作为“无 invocation”分支的全部处理。**

---

## 三、待验证假设与必须明确的语义边界

### 1. 真实 `weaver.service` restart，尤其是 scope 注册前窗口

已有“普通父进程 SIGKILL 后 worker 存活”的实验，不能代替真实 service stop。

需要分别覆盖：

- systemd-run 尚在 service cgroup、scope 还未注册；
- scope 已注册、InvocationID 尚未落库；
- InvocationID 已落库；
- 引擎已退出、scope 仍有后代。

仓库 unit 和实际 drop-in、依赖关系、KillMode 的最终组合尚未实测。这仍是发布前必须验证的环境前提。

### 2. sh 的改法方向正确，但要验收实际退出状态与信号竞态

“保留 wrapper、后台运行引擎、空操作 trap、wait 到真实退出”方向正确。验收需要包含 TERM 恰好打断 wait、连续 TERM、子进程忽略 TERM、stdin 确实保留、自然退出与取消并发。

不要仅凭 `wait` 的数值状态就声称已经无歧义恢复真实 signal；成功/失败判定与用户取消意图应继续分开。临时退出文件也必须在最终 exit 文件同一目录创建，才能落实原子发布约定。

### 3. §8 必须先检查积压日志，再执行过期 no_output

场景是：服务在第一次输出前停机，worker 在停机期间已经输出有效记录，新服务在 120 秒后起来。

若先按 `deadline <= now` 调 failAttempt，再补读日志，会误杀正常 worker。§8.2 虽提到补记 firstOutputAt，但需要明确执行顺序：

> 先恢复并检查已有日志中的有效输出，再决定是否执行 no_output；不能在积压日志尚未检查时触发过期 timer。

原始字节没有可靠输出时间戳时，只能确认“恢复时已有输出”，不能精确证明输出发生在原 deadline 前。

### 4. 未完成 stderr 行的 probe 不是纯字节可重放语义

例如在线观察到未完成的 `429` 前缀，立即分类；服务离线时它可能继续变成 `4290 tokens\n`，恢复看到完整行就不再匹配。

同样，停机期间首次出现的相对 retry-after，恢复时只能用新时刻估算。§7.4 能防止**已经提交的分类**漂移，不能恢复从未观察过的时间事实。

这里需要明确选择：限制未完成行触发终止的条件，或者承认这部分依赖观察时刻。不能把 normalizer 的确定性扩展成整条错误检测链路都确定。

### 5. 数据库迁移本身已有正确保护；新增风险在恢复失败的清理顺序

没有发现“迁移被重启打断就会半迁移损坏”的证据。

`migrate.ts:164–178` 将每个版本的迁移语句和 `user_version` 放在同一事务；失败回滚。依据是：

`/home/mocha/opensource/weaver/src/main/migrate.ts:164–178`。

需要补的是新 reattach 加入后的 startup catch：当前错误清理没有 manager.shutdown，且先关 IPC、后关 store。若部分 tailer 已启动、后续初始化失败，必须撤销它们并等待在途处理结束，最后才释放单例。

建议正文：

> 初始化失败与正常 detach 使用同一清理顺序：关闭入口和调度，撤销已创建的 tailer、监听器和定时器，等待在途应用结束，flush 并关闭数据库，最后释放单例锁和 IPC。已 detach 的回调不得继续写库或发起新的 launch。

---

## 四、可选改进与承诺范围

### 明确“恰好一次”到底保证哪一层

建议目标收敛为：

> 每个 attempt 的持久事件投影和最终结果在 SQLite 中恰好提交一次；最终 manifest 发布后不再变化。owner 可以重复读取同一结果，并以 attemptId + manifestDigest 做消费幂等。外部投递或消费副作用若要求恰好一次，需要对应的持久投递记录与消费方幂等协议。

目前真实 owner 主要通过读取结果再 ack 消费；`Results.deliver` 只支持 mock。仅靠日志游标不能证明外部消费者在“已经消费、尚未 ack 时断开”后不会重复处理。

### normalizer 快照可以后做，但快照不能只保存 normalizer

若引入快照，还需要考虑：

- decoder 的未完成行和 overflow 状态；
- parser 的整次运行预算；
- 已报告模型集合等 adapter 状态；
- 取消/失败决定；
- finish 是否已经提交。

快照必须绑定 runId、文件身份、字节位置和解析版本；否则它可能把性能优化变成新的恢复错误。当前优先级应低于前面的事务与生命周期修复。

### 建议优先补进 §17 的故障注入点

| 注入点 | 必须断言 |
|---|---|
| resultSummary 已提交、close 未提交 | artifact/result 不重复，成功任务不变协议错误 |
| 一行第二条 record 抛错 | 不提交半行效果 |
| watch 已看到 pending 事件、服务崩溃 | 不发生静默重复或不可解释的游标丢失 |
| failAttempt 已提交、scope 未退出 | 新服务仍接管并完成终止 |
| exit 已存在、后代保持 scope active | 最终能清理并交付结果 |
| 取消期间连续快速重启 | 原 killAfter 不被延长 |
| dispatch 已接纳、start 未执行 | 同一 attempt 能继续启动 |
| retry 各持久化阶段之间 | replacement 不丢失、不重复创建 |
| discovery 创建与写入之间 | 下一次服务仍可正常启动 |
| 部分 reattach 成功后初始化失败 | 没有遗留写库回调或晚到 launch |

**我会把“finish 批次原子性、未结束 run 的恢复与结果冻结、dispatch/retry 持久意图、discovery 原子发布”作为这版方案进入实现前的阻断项。**这几处补齐后，再以真实 service restart 演练验证 scope 存活，才足以支撑当前承诺。
