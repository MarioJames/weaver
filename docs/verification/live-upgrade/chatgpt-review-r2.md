# 结论：**未通过**

v2 已正确关闭了几个关键机制问题，尤其是 **finish 批次与终态同事务、只发布已提交状态、dispatch/retry 的持久接纳、discovery 原子发布**。但仍有 **3 项会影响 P1 正确性的缺口**：错误地自动重跑可能执行过的任务、等待完成与结果可读条件不一致，以及统一 pump 后 native 任务缺少 owner 交接。

本轮核对的证据是：

- `/home/mocha/opensource/weaver/docs/live-upgrade.md`：743 行，SHA-256 `5215d4c20379b05e61289bf7acbda061cfc70dff2ef307d17984ca4dad99964d`，复审结束前再次读取时指纹一致。
- 所有源码判断固定于 `b3bcd2b77486a869cfb0490eac23b29da96dcb71`，未把其他会话的工作树改动算入方案。
- 以下“已确认”指文档规则与基线调用链可推出的反例；本轮没有运行测试或真实 systemd 重启实验。

四个原阻断项的关闭情况如下：

| 原阻断项 | v2 判断 |
|---|---|
| finish 批次原子性 | **已关闭。** §6.2 将 records、摘要、最终游标、终态、事件与 `finalizedAt` 合并提交；§6.3、§6.5 也补齐了 pending 与发布边界。 |
| 未结束 run 的恢复与结果冻结 | **核心修法正确，但尚未闭环。** 恢复包含 failed run、manifest 收尾前不可见都正确；仍有下述 R1、R2。 |
| dispatch/retry 持久意图 | **持久接纳裂缝已关闭。** 稳定 ID、关联与待派发意图同事务能够支持恢复；统一 pump 引入的返回协议问题见 R3。 |
| discovery 原子发布 | **设计层已关闭。** 独立 flock 与临时文件原子发布的职责划分正确；锁顺序有一处文字矛盾，应统一，见后文。 |

## 一、仍然阻断的问题

### R1．“零日志＋无 exit＋无 launcher”不能证明从未执行，自动回 queued 会重复工作

**对应章节：** §11.2 第 9、10 条及“从未启动的判定”，文档第 473、474、481 行；同时影响 §4.4 的回队列条件。

当前规则把一组**缺少证据**的观察，当成了**没有执行过**的证明。

**反例时序：**

1. `beforeSpawn` 已提交启动意图，worker 启动。
2. worker 尚未产生 stdout/stderr 字节，但已经产生工作区或外部副作用。
3. 控制面离线期间，worker 结束；外壳因 ENOSPC 写不出 exit 文件，或者外壳遭到 SIGKILL，scope 随后被 collect。
4. 新服务看到 scope absent、无 launcher、零日志、无合法 exit。
5. 按第 9 条及第 481 行，将任务改回 `queued + scheduled`，pump 再执行一次。

**影响：**同一逻辑任务重复执行、重复产生副作用。即使 SQLite 中的 result 最终只有一份，也无法消除重新执行带来的重复工作。ENOSPC、SIGKILL 导致 exit 缺失已经在方案故障模型内，这个反例不要求新增故障假设。

这里还有一个检查时序问题：第一次 inspect 得到 not-found 后，旧 `systemd-run` 可以完成注册并 exec 成 sh；随后扫描 `/proc` 已找不到名为 `systemd-run` 的 launcher，此时 scope 实际已经存在。不能把两个时刻的负观察拼成一致的“不存在”证明。基线 `/home/mocha/opensource/weaver/src/main/adapters/cli/scope.ts:111` 在扫描后还有第二次 inspect；恢复新流程需要保留相应的收敛检查。但**补第二次 inspect 仍不能解决“曾执行、已结束、无 exit”的歧义**。

**最小修正正文，可替换第 9 条后半及第 481 行：**

> **从未启动必须由启动协议证明。** 仅有零日志、无合法退出记录、当前未发现 launcher/scope，不足以证明本次运行从未执行。只有持久状态仍处于禁止启动外部进程的阶段，且所有启动路径都必须先提交启动许可，才能据此安全回到 `queued + scheduled`。
>
> 一旦本 run 的启动许可已经提交，就不得仅因缺少日志和 exit 而自动重新排队。存在性或归属未确定时保持恢复待定；在确认不存在仍可能注册的 launcher、scope 已停止后，缺少合法 exit 的运行按取消/失败意图或“执行结果未知”失败收尾，重试由明确操作决定。
>
> launcher 检查与 scope 查询必须收敛到一致结论；不得复用扫描 launcher 之前的一次 not-found 作为最终不存在证明。

如果希望“许可已提交、实际尚未启动”的窗口也能自动回队列，需要进一步定义启动屏障。单加一个启动前写入的 `prepared` 或 `launch-intent` 字段，仍然不能区分提交后是否真的执行过。

### R2．`tasks wait` 可以报告 terminal，但同一任务的结果仍是 `RESULT_NOT_READY`

**对应章节：** §11.1、§13、§14.2，以及 §16 对 `poll-task.ts` 的改动范围。

v2 正确允许先持久化失败决定，再继续终止 scope，并把 manifest 推迟到 `finalizedAt` 提交后发布。但等待方仍沿用旧完成条件：

- `/home/mocha/opensource/weaver/src/main/manager.ts:167`：先保存 `status='failed'`，再发起终止。
- `/home/mocha/opensource/weaver/src/cli/poll-task.ts:62`：只要状态是 completed/failed/cancelled，就返回 `reason='terminal'`。

§14.2 目前只补了重连，没有定义这个新的完成条件。

**反例时序：**

1. worker 命中致命错误，失败及终止意图已提交，scope 仍在终止宽限期，`finalizedAt` 尚不存在。
2. 服务重启，owner 的 wait 成功重连。
3. wait 读到已提交的 failed，立即返回 terminal。
4. owner 调用 results，正确得到 `RESULT_NOT_READY`。
5. owner 再调用 wait，仍立即返回 terminal；这个命令无法等待到结果真正可消费。

**影响：**owner 的“wait → results”流程断裂。恢复待定时，这个窗口还可能持续很久。提交后读取本身无法解决问题，因为这里读到的 failed 确实已经提交。

**最小修正正文，建议加入 §11.1，并由 §14.2 引用：**

> **等待完成与最终结果可读使用同一条件。** 对采用本方案文件生命周期的真实 run，只有业务终态和 `run.finalizedAt` 均已提交，`tasks wait/watch` 才能以 `reason='terminal'` 返回。失败决定已提交、但进程终止或收尾尚未完成时，继续等待，并展示 stopping/recovery pending；达到原等待截止时按 timeout 返回，保留当前恢复状态。
>
> 此条件只适用于采用新文件生命周期的真实 run。native/mock 按各自完成条件处理；首次升级前已完成并停止的历史记录，保留其已完成含义，不能仅因缺少新字段而永久返回 `RESULT_NOT_READY`。

这条修正针对**等待与结果发布协议**。`retry --cancel` 原有的快速替代语义可以保留；归属不明运行的重叠启动继续受 §11.4 的门禁约束，无需借此把所有 retry 改成等待旧 run 完全收尾。

### R3．统一 pump 后，native 的 `next=wait` 会让 owner 等待一个尚未由自己启动的子 Agent

**对应章节：** §16-P1，文档第 598、599、604 行；需同时补入 §14 的等待协议。

这项改造使所有 dispatch 先成为 `queued + scheduled=true`。基线调用链决定了：

- `/home/mocha/opensource/weaver/src/main/application/scheduling/dispatch.ts:79`：scheduled 的 native task 返回 `next.action='wait'`。
- `/home/mocha/opensource/weaver/src/main/application/scheduling/coordinator.ts:32`：pump 使用 `setImmediate`，不会在通知调用栈内立即完成启动。
- `/home/mocha/opensource/weaver/src/main/manager.ts:62`：native 只登记运行状态，实际子 Agent 必须由 owner 启动。
- `/home/mocha/opensource/weaver/src/main/application/tasks/queries.ts:44`：运行中的 native 会在 `tasks.get` 返回 `run_subagent`；但当前 pollTask 不根据这个 next 结束等待。

**反例时序：**

1. owner 执行 `workers spawn`，路由选中 native。
2. v2 原子提交 queued/scheduled，命令返回 `next=tasks wait`。
3. 下一轮事件循环，pump 将任务标成 running；Weaver 不创建 native 子进程。
4. owner 遵从 next，调用 wait。
5. wait 忽略 `tasks.get` 中的 `run_subagent`，持续等待终态。
6. 子 Agent 尚未启动，任务一直等到 timeout/stalled。

**影响：**原先有容量时直接取得 `run_subagent` 的路径，变成必然经过这个交接缺口。重连只能恢复连接，无法启动缺失的执行者。

**最小修正正文：**

> dispatch/retry 响应确认的是持久接纳；实际执行状态随后由 pump 推进。native 任务排队后，owner 的等待步骤必须能够在任务获准执行时交回 `next.run_subagent`：wait 发现已提交快照为 running native 时，以明确的 `reason='handoff'` 返回该指令，不能继续等待尚未由 owner 发起的执行。
>
> handoff 绑定稳定的 `taskId + attemptId`。重复读取返回同一 attempt 的指令；owner 尚未启动该 attempt 时才调用内建 subagent，已有对应执行句柄时继续等待原执行，不再次启动。
>
> command receipt 保存接纳响应；当前执行进度从 `tasks.get/wait` 取得。命令层即使有界等待首轮 pump 后重新生成 next，容量排队、响应丢失及重连路径仍必须支持上述 handoff。

## 二、上一轮修法引入的矛盾或语义变化

### 1．§6.5 与 UI 实时性：取舍成立，保留内部 pending 读取

§6.5 已明确区分内部 pending 视图和外部已提交视图，因此没有要求把所有 `store.get()` 都改成数据库读取。这个区分能保留内部 read-your-writes，并避免整行更新覆盖 pending。

UI 会增加批量提交带来的显示延迟，通常约一个 500ms flush 周期。这是提交后发布的直接代价，**不构成正确性回归**。实现时需要覆盖 UI 的 list/get 入口，并让定时 flush 的实际 COMMIT 也触发通知，不能只覆盖同步 `put`。

### 2．单例锁与 IPC 清理：有一处顺序矛盾，已有正确规则可直接统一

§10.3 第 428 行写的是：

> store 打开 → 单例锁

但 §10.4 第 436 行和 §16 第 602 行明确要求**开库前取锁**。应以后者为唯一规则：

> 启动时先取得单例锁，再打开/迁移数据库，构造组件并完成 reattach，之后启动 pump 和对外 ready。关闭时，锁覆盖在途写入、数据库关闭及本实例 IPC/discovery 清理；这些操作全部完成后才释放锁，释放后不再执行端点清理。

这是一处需要消除的实现歧义。鉴于正文两处已有明确正确要求，我不把它另列为机制阻断。

### 3．固定致命优先级与“首次分类立即提交”：当前正文和测试 #23 不能同时满足

这是一项新的、需要收敛承诺的矛盾：

- §7.4 第 329 行：首次致命分类同步提交。
- §7.3 第 322 行：已提交失败不可推翻。
- §17 #23：stdout 429、stderr 401，无论先 tail 哪流，最终都必须 auth。

若先读到 429 并提交 rate_limit，再读到 401，就不能改成 auth。反向读取则先提交 auth。同级错误“取首次完成分类者”也无法保证不同读取顺序选择相同 `retryAt`。

**这不必成为新的架构阻断**：持久失败决定不漂移已经能够支撑结果幂等。建议把优先级的作用域明确为同一未提交决策批次：

> 已提交的失败决定保持不变，后续错误仅补充诊断。固定优先级用于同一次尚未提交的决策批次中已收集到的候选错误；同级候选以稳定的来源键选择，不以分类完成时间选择。不同批次首次发现的错误不承诺产生相同失败原因。

测试 #23 相应验证“**同一候选集合、同一决策批次**内改变解析顺序，结果一致”；另测 rate_limit 已提交后出现 auth，再重启仍保持原决定。若继续要求两条流所有未来输出的全局 auth 优先，就需要另行定义何时关闭候选集合，当前的逐行立即提交规则无法提供该保证。

### 4．real `workers spawn` 的返回时机也会变化

统一 pump 后，最初返回 queued，基线 gateway 的“已 running 且为 real 才等待 first-output”分支将不再进入，见 `/home/mocha/opensource/weaver/src/main/application/commands/gateway.ts:122`。

因此响应会更接近“已持久接纳”，`started:false` 可以是正常状态。这个接口变化可以接受，文档应明确接纳成功与实际启动的区别；R3 所述 native handoff 则必须补齐。

## 三、可选补强，不影响上述判定

- **补上 flock 的 FD 不变量。** 锁 FD 应为 CLOEXEC，不进入 worker 的 `stdio/keepFd`，锁文件不 unlink 后重建。Linux 的 flock 关联 open file description，fork/dup 的副本可以继续持有锁；因此“控制面死亡自动解锁”需要没有存活的继承副本这一前提。这里尚无实现证据证明会发生继承，适合作为实现验收条件。[Linux manual page](https://man7.org/linux/man-pages/man2/flock.2.html?utm_source=chatgpt.com)
- **在现有测试矩阵中补三个针对性切点：** 有启动许可但无日志/exit 时不得自动重跑；failed 已提交但未 finalized 时 wait 不返回 terminal；native 从 queued 获得执行资格后能够交回同一 attempt 的 handoff。它们分别直接验证 R1、R2、R3，无需扩大成新的测试体系。
- **真实 `weaver.service` stop/restart 仍属于实现后的验证项。** 当前文档已经承认这项证据缺口。本轮“未通过”依据是上面三个可推出的机制反例，而真实服务演练用于验证修正后的实现。
