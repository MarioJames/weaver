# 飞书任务事件主动推送研究报告（只研究、不实现）

> 范围：Weaver 本地 Agent 任务控制面，在任务完成 / 失败 / 阻塞（含 stalled、需用户决策、引擎被限流阻塞）等事件发生时，能否主动向飞书发消息。结论逐条标注证据类型：**代码已验证（文件:行）** / **官方文档（链接）** / **推测/待确认**。研究过程未读取任何凭据文件、未调用飞书真实 API、未修改除本文件外的任何内容。

---

## 1. 现有 IM 通道能做什么（被动回复能力与可复用部分）

### 1.1 长连接收发：当前只是被动应答机

- 长连接由 `@larksuite/channel` 的 `createLarkChannel` 建立，凭据为 `appId + appSecret`，Weaver 侧再包一层 axios 拦截器做取消围栏与错误分类。**代码已验证（`src/main/im/channel.ts:106-116`：`createLarkChannel({ appId, appSecret, httpInstance, … })`；`:153` connect、`:154-161` close、`:120-122` 重连回调）。**
- 入站只处理**单聊 p2p、用户发送的 `text` / `post`**，群聊、机器人消息、非白名单用户直接忽略；`text`/`post` 范围内的空消息、无可读文字、超限（16KB）给固定安全反馈。**代码已验证（`src/main/im/service.ts:476-480` 严格校验 `senderType/chatType/rawContentType/messageId/chatId` 与双向时间窗；`src/main/im/inbound.ts:24-50` 解析与 16KB 上限）。**
- 出站当前全部是**对已收到的用户消息的回复**：`notice()` 只向本次会话的 `chat` 发纯文本；`turn()` 用 `channel.stream()` 做流式卡片，再用 `updateCardById` 收口为正文+选项按钮。**代码已验证（`src/main/im/service.ts:471-474` `notice()` 经 `channel.send(chat, text)`；`:596-665` `turn()` 全流程；`src/main/im/channel.ts:163` `send`、`:164-171` `stream`、`:172-181` `updateCard`）。**
- 结论：**通道的发送原语本身不区分"回复"与"主动推送"**——`channel.send(to, { text })` 的 `to` 可以是任意 `chat_id`/`open_id`（见 §4），因此**发送能力可复用**；缺的是"何时、以何身份、发给谁、发什么、发几次"的上层决策。**推测/待确认**：无。

### 1.2 卡片与流式进度：可复用的展示形态

- 回复卡片结构：`markdown` 正文 + 最多 6 个"下一步选项"按钮，点击按钮等价于向同一会话发一条新用户消息（经 `card.action.trigger` 回调 + nonce 单次消费校验）。**代码已验证（`src/main/im/cards.ts:41-46` `replyCard`；`src/main/im/service.ts:655-663` 按钮绑定、`668-684` `card()` 校验与 `claim(card:…)` 去重）。**
- 流式进度：`onProgress` 事件渲染为 `⏺ 调用工具：xxx / ⏺ 阶段：xxx` 的临时行，独立预算 20 条 / 2000 字节，不计入正文 20KB 配额，最终 `setContent` 只保留答案正文。**代码已验证（`src/main/im/progress.ts:24-27` 上限、`46-50` 渲染；`src/main/im/service.ts:601-623` 进度装配）。**
- 卡片更新走 CardKit 实体接口 `updateCardById(cardId, card, sequence)`，sequence 必须严格递增；Weaver 用 axios 拦截器观测本 delivery 真实创建的 `card_id` 与 `message_id` 绑定，拒绝外部传入 id。**代码已验证（`src/main/im/channel.ts:45-50` URL 正则、`134-151` 观测绑定、`172-181` 绑定检查）。**
- 可复用判断：
  - 任务完成/失败通知 → 复用 `send(to, { text })` 纯文本或 `replyCard` 静态卡片即可，无需流式。**代码已验证（同上）。**
  - 阻塞/需决策通知 → 可复用"选项按钮"形态，把"重试 / 恢复派发 / 查看任务"做成按钮；但当前按钮语义是"作为新用户消息回填到 Bot 对话"，**并非执行后台操作**，若要"点击即恢复派发"需新增语义。**代码已验证（`docs/feishu-im.md:82-86` 明确"按钮=新用户消息，不是后台操作"）。**

### 1.3 现有"准推送"：只有同步回复与菜单查询，没有事件驱动推送

- `status` 菜单返回"对话忙闲 + 排队条数 + 只读任务数量摘要"，任务详情以任务面板为准；任务计数来自 `options.taskStatus` 回调。**代码已验证（`src/main/im/service.ts:696` status 分支；`src/main/runtime.ts:250` 传入 `taskStatus: () => 'Weaver 任务共 N 项'`）。**
- 所有外发都发生在"收到一条已准入消息/卡片/菜单之后"的同步上下文中（`message/card/menu → notice/turn`），**不存在脱离入站消息的定时/事件外发路径**。**代码已验证（`src/main/im/service.ts:298-303` channel 回调只注册 message/card/menu/error；全文 grep 无 `setInterval/setTimeout` 外发任务事件逻辑，仅 idle/armIdle 计时器 `:583-595`）。**
- 多实例限制：同一应用凭据同时被多个 Weaver 长连接使用时，飞书把消息分摊投递，单实例只看到一部分。**代码已验证（`docs/feishu-im.md:88-90`）。** 主动推送设计必须假设"推送实例即连接实例"，否则推送与会话归属错位。

---

## 2. 本地配置与持久化缺口

### 2.1 现有配置：`im-settings.json`（已存在的例外）

- 私有存储：每个 dataDir 一份 `im-settings.json`（0600，原子替换写，revision 乐观锁），字段为 `enabled/appId/appSecret/allowedOpenIds/engine/model/effort/workspaces/idleTimeoutMinutes`。**代码已验证（`src/main/im/settings.ts:20-21` StoredImConfig、`59-61` 默认值、`137` 路径、`154-209` save 语义、`118-130` `publicImConfig` 脱敏投影；`src/shared/contracts/im.ts:4-16` ImConfig、`19-29` ImStatus）。**
- 白名单是 `open_id`（`ou_` 前缀在 service 层校验 `/^ou_…/`）。**代码已验证（`src/main/im/service.ts:256`、`459`）。**
- 项目约定要求"持久化全部放 SQLite，不新增 JSON 存储；`im-settings.json` 是已存在的例外"。因此**推送开关/目标/去重记录必须进 SQLite（`weaver.db`），不得新建 `im-push.json` 之类文件**。**推测/待确认**：无，此为任务包给定的项目约定，直接采纳。

### 2.2 缺口清单（配置侧）

| # | 缺口 | 说明与证据 |
|---|------|-----------|
| C1 | 无推送总开关 | `ImConfig.enabled` 只控制 Bot 长连接与对话；无 `push.enabled`。**代码已验证（`src/shared/contracts/im.ts:4-16`；`src/main/im/settings.ts:59-61`）。** 建议默认关闭（见 §6），开启需显式 opt-in。 |
| C2 | 无推送目标 | 无 `pushTargets: { open_id | chat_id }[]`、无私聊 vs 群选择、无"默认发给任务发起人"规则。当前只在内存 Session 里有 `chat/user`（`key = chatId:senderId`），**无持久化映射**。**代码已验证（`src/main/im/service.ts:40` Session 接口、`491` key 构造）。** |
| C3 | 任务↔飞书身份无关联 | 经飞书 Bot 派发的任务（Bot 按 master-guideline 用 `tasks.create/start` 建 root）**不在 Task 记录里写 `origin: { imChatId, imUserOpenId }`**；`Task` 接口无此类字段。**代码已验证（`src/shared/contracts/tasks.ts:72` Task 全字段、`25` TaskInput；`src/main/manager.ts:98-104` create 不写来源）。** 这是最大缺口：任务完成后不知道"发给谁"。 |
| C4 | 无事件订阅配置 | 无"哪些事件推送（completed/failed/blocked/需决策）、哪些任务范围（全部/仅我发起的/仅 Bot 派发的）"。**代码已验证（`src/shared/contracts/im.ts` 全 46 行无推送字段）。** |
| C5 | 无去重/已推送记录表 | 入站去重有 `im-inbox.json`（24h TTL、1 万条、只存 id+时间戳、不存正文）。**代码已验证（`src/main/im/inbox.ts:16-17`、`79-91` claim 语义）。** 但它是 JSON 文件且按约定不可复用模式新增 JSON；推送去重需新建 SQLite 表（见 §6 数据模型）。 |
| C6 | 无失败重试状态存放 | 当前外发失败只有两条路：`notice()` 失败 → 标记 transport error（`service.ts:473`）；`turn()` 失败 → 固定提示 + 废弃会话（`:569-577`），**不重试、不落库**。推送需要 `status=pending/sent/failed + nextRetryAt + attemptCount` 的 durable 队列。 |

### 2.3 去重与失败重试应放在哪里（SQLite）

- 权威库是 `weaver.db`（WAL，`sequence` 修订，`tasks/task_events/artifacts/owners/packages/receipts/kv` + 监控表）。**代码已验证（`src/main/store.ts:11` 注释、`26-36` 构造与 PRAGMA、`72-81` writeTask；`src/main/migrate.ts:4` SCHEMA_VERSION=12、`9-124` 建表步骤）。**
- 推送应新增 migration step 13：`im_push_targets`（配置快照或独立表）、`im_push_queue`（待发/已发/失败）、`im_push_log`（审计），全部经 `migrate()` 建表，读写走 `TaskStore.transaction()`。不得新建 JSON。**推测/待确认**：表名与字段为方案建议，非现有代码。
- 幂等键建议：`taskId + eventKind + attemptId(run.id)/policyRevision`，并可透传飞书 `uuid` 参数做服务端 1 小时去重（见 §4）。**官方文档（https://open.feishu.cn/document/server-docs/im-v1/message/create —— 请求体 `uuid`："持有相同 uuid 的请求，在 1 小时内至多成功发送一条消息"）。**

---

## 3. 事件触发缺口

### 3.1 现有任务事件/状态迁移点（可作为触发源的候选）

- 状态机：`queued → running → (completed | failed | cancelled)`，另有 `cancelling` 中间态。**代码已验证（`src/shared/contracts/tasks.ts:22` TaskStatus；`src/main/application/tasks/status.ts:6` TASK_STATUSES）。**
- `terminal(task)` 定义为 completed/failed/cancelled。**代码已验证（`src/main/application/tasks/records.ts:9`）。**
- 终态写入点：
  - `manager.onFinal()`：worker 进程结束 → `completed`（exit 0 + 有 result）/`failed`（含 `unknown_outcome`）/`cancelled`（有取消意图），写 `failure` + `lifecycle/error` 事件并 `persist`。**代码已验证（`src/main/manager.ts:668-736`，其中 `~691` completed、`~694-705` failed、`~684-687` cancelled）。**
  - `completeNative()`：owner 内建子代理上报 `outcome`。**代码已验证（`src/main/manager.ts:287-…`）。**
  - `finalizeFailureNow / finalizeRecovered`：启动失败与重启恢复路径。**代码已验证（`src/main/manager.ts:744-752`、`635`、`158-212` reattach 侧经 `src/main/application/tasks/reattach.ts:158-212`）。**
  - owner root 的 `tasks.complete` 需要"所有最终叶子 completed 且 review  accepted"的前置门。**代码已验证（`src/main/application/tasks/mutations.ts:33`）。**
- "需要用户决策"的候选信号（现有语义，可直接映射）：
  - `reviewState=pending` 的 completed 任务（等待 owner acceptance）+ `acknowledged=false`（结果未认领，`tasks.results` manifest `delivery: pending/acknowledged`）。**代码已验证（`src/shared/contracts/tasks.ts:72`；`src/main/application/tasks/results.ts:15` manifest；`src/main/manager.ts:101` 新建 `reviewState: 'pending'`；`src/main/continuation.ts:138-141` `pendingApprovals: ['Completed result awaits owner acceptance review']`）。**
  - `queueReason.code`：`policy_blocked / waiting_for_capacity / frozen_route_changed / workspace_changed / launch_blocked`。**代码已验证（`src/shared/contracts/tasks.ts:72` queueReason；`src/main/application/scheduling/coordinator.ts:23-27` 写入、`44` phase 初始值、`63-75` 各分支）。**
- 阻塞（含限流）的候选信号：
  - stall：`needsAttention`（level 打满需人工）+ `nextProbeAt`（等待探测）、`taskHealth.state='stalled'`。**代码已验证（`src/main/stall.ts:46` pending 定义、`126-134` nextPenalty、`292-294` health 状态机、`20` STALL_MS=5min、`24` QUORUM=2）。**
  - vendor 限流：`failure.kind='rate_limit'|'quota'` → 写 policy block（worker 级→引擎级升级）并 reroute 排队任务。**代码已验证（`src/main/application/scheduling/vendor-limits.ts:28-61`；`src/main/application/tasks/records.ts:11` vendorLimited；`src/main/application/scheduling/coordinator.ts:48-59` reroute）。**
  - free-channel 探针：`mode='quota'|'rate_limit'|'stall'` + needsAttention。**代码已验证（`src/shared/contracts/monitoring.ts:82-83`；`src/main/free-channel.ts:28-32`）。**

### 3.2 是否存在统一事件总线？——不存在，这是第二大缺口

- `TaskStore` 有 `onCommit(listener)`（COMMIT 成功后触发，含 timer flush 的 commit），`TaskManager` 构造时可传入 `committed` 回调，生产 wiring 传的是 `() => commands?.pump()`（提交后触发调度 pump）。**代码已验证（`src/main/store.ts:24`、`53-71` transaction+emitCommit；`src/main/manager.ts:86-88`；`src/main/runtime.ts:约 285-292` `new TaskManager(store, workers, …, () => { commands?.pump(); })`）。**
- 但**没有任何订阅者把 commit 事件桥接到 IM**：`ImService` 构造参数只有 `{ dataDir, policy, parentFactory, channelFactory, now, taskStatus }`，其中 `taskStatus` 是个同步计数函数，不是订阅。**代码已验证（`src/main/im/service.ts:43` ImServiceOptions；`src/main/runtime.ts:250` 构造调用）。**
- RPC 面每次非 IM 方法执行后会调 `im?.reconcile()`（只做配置漂移 reconciler，不扫描任务）。**代码已验证（`src/main/runtime.ts:184-186` dispatch 尾部）。**
- 结论：需新增订阅点，二选一（见 §6）：
  - (A) `store.onCommit` 轻量 diff 器：记录上次见过的 `(taskId → status/reviewState/queueReason/failure.kind)`，变化即入推送队列。优点：覆盖所有写入路径（含 reattach/恢复）；缺点：高频 commit（stream 每 500ms flush，`store.ts:127-130`）需做节流与"仅终态/阻塞边沿触发"的过滤。
  - (B) 在 `manager.onFinal / completeNative / queueBlocked / stall.trigger / vendor.applyVendorBlocks` 等语义点直接入队。优点：语义精确、无轮询；缺点：写入点多（`manager.ts` 内终态分支 + `coordinator.ts` + `stall.ts` + `free-channel.ts`），需逐一埋点，易遗漏。
  - 推荐 A（diff）为 MVP，因为"离线重启补发"（§6 风险 R4）天然需要"启动时全量 diff"逻辑，两者复用同一函数。

---

## 4. 发送 API（SDK 可用方法、token、限制）

### 4.1 `channel.send / stream`：主动发送无需额外配置

- `LarkChannel.send(to, input, opts?)`：`to` 为接收者 id，SDK 按前缀自动推导 `receive_id_type`（`oc_`→chat_id、`ou_`→open_id、`on_`→union_id、含 `@`→email、否则 user_id）。**代码已验证（`node_modules/@larksuite/channel/dist/index.d.mts:1309` send 签名、`160-206` SendInput 联合类型；`node_modules/@larksuite/channel/dist/index.mjs` `#region src/outbound/routing.ts` 内 `detectReceiveIdType()` 函数体，逐前缀 if 链——因 bundle 未压缩，`grep detectReceiveIdType` 可定位）。**
- 因此主动推送就是 `channel.send(openId, { text })` 或 `channel.send(chatId, { text })`，**与回复共用同一长连接实例与同一 `tenant_access_token` 管理，无需为推送另建连接或另申请 token**。**推测/待确认**：SDK 内部 token 自动刷新逻辑（bundle 内未检索到 `tenant_access_token` 明文标识，`grep -c` 为 0，token 管理疑似在 node-sdk 层或经混淆命名持有），故 token 归属标注"待确认"，但"复用同一 channel 实例即可发送"有 Weaver 侧直接证据（`notice()` 已在任意时刻调用 `channel.send`，不限于消息处理调用栈——如 `status` 菜单与 idle 轮转通知 `service.ts:708`）。
- `SendInput` 支持 `text/post/card/cardId/image/file/audio/video/shareChat/shareUser/sticker`；推送 MVP 用 `text` 即可，富格式用 `post` 对象或 `card` 对象。**代码已验证（`index.d.mts:160-206`）。**
- `stream()` 用于 Bot 对话的打字机式流式卡片，推送场景**不需要**（通知是一次性短消息）。`editMessage/recallMessage/updateCard/updateCardById` 可用于"发出后订正/撤回"，MVP 不需要。**代码已验证（`index.d.mts:1310` stream、`~1351-1360` edit/recall 注释）。**

### 4.2 官方 REST 语义（SDK 底层的实际约束，以官方文档为准）

以下均 **官方文档（https://open.feishu.cn/document/server-docs/im-v1/message/create ，中文同页 `…/message/create?appId=…`）**：

- 接口 `POST /open-apis/im/v1/messages?receive_id_type={open_id|union_id|user_id|email|chat_id}`，body 含 `receive_id/msg_type/content/uuid?`。
- 权限三选一：`im:message` / `im:message:send_as_bot` / `im:message:send`（历史版）；用户身份发送才需 `im:message.send_as_user`。推送用应用身份，`send_as_bot` 足够。
- 频率：**接口级 50 QPS / 1000 次·min⁻¹；同用户 5 QPS；同群（群内机器人共享）5 QPS**。
- 大小：**文本 ≤150KB；卡片/富文本 ≤30KB**（含模板展开与样式标签膨胀）。
- 去重：`uuid`（≤50 字符）相同请求 1 小时内至多成功一条。
- 前提：应用开启机器人能力并发布版本；给用户发要求用户在**可用范围**内；给群发要求机器人在群内且有发言权；用户可屏蔽机器人（错误码 230053）；跨租户 p2p 禁止（230038）等，错误码表同页下半部分。

### 4.3 长连接 vs REST 的选择

- Weaver 已持有长连接 channel，`send()` 经该通道的 HTTP 实例发出（`channel.ts:76` 自建 axios 实例注入 SDK），无需自管 token、无需公网回调地址（这正是 `docs/feishu-im.md:26` 要求"用长连接、不要 Webhook"的原因）。**代码已验证（`src/main/im/channel.ts:76-116`）。**
- 若未来要做"无连接实例的独立推送 worker"，则需直调 REST + 自管 `tenant_access_token`；MVP 不走这条路（见 §6：推送与 IM 共用 channel 实例，无连接不推送并记 `skipped_no_channel`）。

---

## 5. 飞书开放平台权限与应用配置缺口

### 5.1 现有应用已有的权限（按 Weaver 文档）

- `im:message.p2p_msg:readonly`（读单聊）、`im:message:send_as_bot`（以 Bot 发回复）、`cardkit:card:write`（流式卡片）。事件 `im.message.receive_v1` + `application.bot.menu_v6`，卡片回调 `card.action.trigger`，均为长连接。**代码已验证（`docs/feishu-im.md:22-30`）。**

### 5.2 主动推送的增量缺口

| # | 缺口 | 结论 |
|---|------|------|
| P1 | 发送权限 | **零增量**：`im:message:send_as_bot` 已覆盖"以应用身份向用户/群发消息"（与回复同一权限）。**官方文档（发送消息页"权限要求"三选一列表，`im:message:send_as_bot` 在列）**。 |
| P2 | 读取权限 | 若推送只需"向已知 open_id/chat_id 发"，**零增量**。若要"运行时解析群成员/用户姓名做 @提及"，才需通讯录类权限，MVP 不需要。**推测/待确认**：以官方通讯录文档为准，MVP 明确不做。 |
| P3 | 事件订阅 | **零增量**：推送是出站 REST/长连接发送，不新增入站事件订阅。 |
| P4 | 可用范围 | **最大外部约束**：给用户单聊推送要求该用户在应用**可用范围**内，否则报 230013；给群推送要求机器人已在群内。**官方文档（同发送消息页"注意事项"与 230013/230002 排查建议）**。运营动作：在开发者后台"版本管理与发布 → 可用范围"把目标用户/部门纳入并发布版本。**官方文档（同页 230013 解决步骤 1-5）**。 |
| P5 | 用户侧前置条件 | 用户须与机器人存在可发消息的关系（单聊可用范围内；用户可主动屏蔽 → 230053 失败，需在推送队列里记 `blocked_by_user` 并退订该目标，避免重试刷屏）。**官方文档（错误码 230053 行）**。 |
| P6 | 群推送前置 | 机器人须被拉入目标群且有发言权限（否则 230002/230018/230035）。MVP 建议**默认只推单聊（发起人 open_id），群推送作为二期 opt-in**。**官方文档（前提条件与 230002/230018 行）+ 推测/待确认**（"默认单聊"为方案建议）。 |
| P7 | 卡片权限 | 若推送用 interactive 卡片，`cardkit:card:write` 已有（与回复共用）。纯文本推送则连卡片都不依赖。**代码已验证（`docs/feishu-im.md:24`）**。 |

### 5.3 待确认项（明确标注）

- T1：`im:message.p2p_msg:readonly` 是否为读事件的准确 scope 名（Weaver 文档写法），官方新版 scope 是否已更名为 `im:message:readonly` 系——**待确认（推测）**，以应用后台实际 scope 列表为准，不影响推送（推送不读消息）。
- T2：SDK 的 tenant token 自动续期细节与失败码映射——**待确认**，MVP 把发送失败一律记 `failed + 原始分类（rate_limited/permission_denied/not_connected 等 LarkChannelErrorCode，见 `index.d.mts:364`）**，不依赖内部细节。

---

## 6. 最小可行方案（MVP）

### 6.1 设计原则

1. 持久化全部在 SQLite（`weaver.db`，migration step 13），不新增 JSON 文件。
2. 推送目标确定性优先：**只推"可证明归属"的目标**——任务的 `origin`（Bot 派发时写入）或用户显式订阅；无归属的任务不推送（记 `skipped_no_target`），宁可少推不错推。
3. 默认关闭：`push.enabled=false`；开启后默认只推"终态（completed/failed/cancelled）+ 我发起的任务"，阻塞类默认可选开启，避免刷屏。
4. 所有发送经现有 `ImService.channel.send()`，无连接/未启用时不缓存无限膨胀（队列有界，溢出丢弃最旧非终态并记 metric）。

### 6.2 数据模型（SQLite，migration step 13，未实现，仅 DDL 草案）

```sql
-- 推送目标：用户显式订阅（MVP 可先只有"发起人自动订阅"，本表二期再做）
CREATE TABLE IF NOT EXISTS im_push_targets(
  open_id TEXT PRIMARY KEY,          -- ou_…（私聊目标）；群目标二期再加 chat_id 列
  subscribed INTEGER NOT NULL,       -- 1=接受推送，0=退订（含 230053 自动退订）
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- 推送队列/审计（去重 + 重试状态机）
CREATE TABLE IF NOT EXISTS im_push_queue(
  key TEXT PRIMARY KEY,              -- taskId:eventKind:attemptId（attemptId=run.id 或 policy revision）
  task_id TEXT NOT NULL, event_kind TEXT NOT NULL, -- completed|failed|cancelled|blocked|awaiting_review|stalled
  to_open_id TEXT NOT NULL, payload TEXT NOT NULL, -- 已渲染的文本（脱敏后）
  status TEXT NOT NULL,              -- pending|sending|sent|failed|skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT, last_error TEXT, feishu_uuid TEXT NOT NULL, -- 透传给 API uuid 做服务端去重
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

- 去重：`key` 主键天然幂等（INSERT OR IGNORE）；`feishu_uuid=randomUUID` 每次入队生成，透传 API `uuid` 得服务端 1 小时去重。**官方文档（uuid 语义见 §4.2 链接）。**
- 重试：`attempts<5` + 指数退避（1/2/4/8/16 min），`rate_limited` 退避加倍；`permission_denied/230053(blocked)/230013(不在可用范围)` 直接进 `failed` 不重试并可自动退订目标。
- 任务归属：在 `tasks.body` JSON 内增 `origin?: { imChatId: string; imUserOpenId: string }`（body 是 JSON 文本列，加键无需改列，**代码已验证 `migrate.ts:12` body TEXT**），由 Bot 派发路径（master-guideline 的 `tasks.create` 调用处）在创建时写入；历史任务无 origin → 不推送。

### 6.3 触发点（订阅 `store.onCommit` 的 diff 器，§3.2 方案 A）

- 在 `runtime.ts` 中 `new TaskManager(...)` 之后、`im.start()` 之前，注册：
  `store.onCommit(() => pushScanner.scan())`（与 `commands.pump()` 并列的第二个 commit 监听；`onCommit` 支持多监听，**代码已验证 `store.ts:24` Set 语义**）。
- `scan()` 逻辑：读 `listHeadsCommitted()`（durable 视角，**代码已验证 `store.ts:99-101`**）对比内存快照，仅在边沿入队：
  - `status: running→completed|failed|cancelled`（以 `run.finalizedAt` 存在为准，避免未 finalize 的中间态，**代码已验证 `results.ts:15` RESULT_NOT_READY 条件**）→ `completed|failed|cancelled`；
  - `completed && reviewState=pending && !acknowledged` 首次出现 → `awaiting_review`（"需要决策"）；
  - `queueReason.code=policy_blocked|launch_blocked` 首次出现 → `blocked`（含 vendor 限流导致的 reroute/排队，`coordinator.ts:48-59`）；
  - `stall.taskHealth=stalled`（限流：同一 task 24h 只推一次；引擎级 `needsAttention` 变化才推）→ `stalled`。
- 启动补发：`im.start()` 后跑一次全量 `scan()`（覆盖离线期终态），但只补 `completed/failed` 且按"每目标聚合一条 digest"发送，避免重启风暴。

### 6.4 发送路径

```
commit → pushScanner.scan() → SQLite im_push_queue(pending)
→ pushSender.tick (每 10s + commit 后即时各一次，有界并发 1，串行)
→ ImService.pushSend(to, text): channel.send() → messageId 回填 sent
→ 失败分类 → retry / failed / auto-unsubscribe
```

- 发送函数挂在 `ImService` 内（复用 `channel`、`admissible` 白名单检查、`settings` 开关），但**与对话 Session 解耦**（不占用会话、不写排队正文、不触发 Agent）。
- 白名单复用：`to_open_id` 必须在 `allowedOpenIds` 内，否则 `skipped_not_allowlisted`（隐私底线，见 §7 R1）。
- 文案约束：只含任务 id（短 8 位）、标题、状态、失败 kind、查看指引；**不含 instruction 全文、不含路径/密钥**（沿用 `redactSecrets`/`redactContext`，**代码已验证 `progress.ts:39`、`coordinator.ts:24`**）。文本 ≤ 数百字符，远离 150KB 上限。

### 6.5 配置 UI 最小范围（Bot 页增一个"推送"折叠区，默认全关）

- `启用任务推送`（bool，默认 false）；
- `推送事件`（多选：终态 / 需要验收 / 阻塞被限流 / stalled，默认仅终态）；
- `推送范围`（仅我发起的 Bot 任务 / 白名单内全部任务，默认前者）；
- 每目标静默窗（聚合：5 分钟内同一任务多事件合并一条；免打扰时段可选，二期）。
- 配置存 SQLite（`kv` 或新表，**不进 `im-settings.json`**，避免触碰凭据文件与现有 revision 锁语义）。

---

## 7. 风险

- R1 隐私/越权推送：任务 instruction/路径/密钥可能进入推送文案 → 对策：白名单内目标 + 文案字段白名单 + `redactSecrets` 必经。**代码已验证（`src/main/im/progress.ts:33-42` 脱敏先例）。**
- R2 刷屏：stall tick 每分钟、stream flush 每 500ms，commit 高频 → 对策：边沿触发 + 每任务每事件 24h 一次 + 目标级聚合 digest + 默认仅终态。
- R3 凭据：推送不新增凭据文件、不读 secret；`channel` 复用现有 appSecret。**代码已验证（`channel.ts:106` 唯一凭据入口）。**
- R4 离线重启补发风暴：对策见 §6.3（启动只补终态 digest），`im-inbox.json` 模式不可直接复用（它是入站去重 JSON，约定禁新增 JSON）。
- R5 多实例分摊：推送实例必须=连接实例；多机请用独立应用（沿用 `feishu-im.md:90` 规则）。
- R6 用户屏蔽/可用范围外：230053/230013 → 自动退订 + 不再重试，避免每次终态都失败刷日志。
- R7 群推送误伤：MVP 默认关闭群推送；开启需显式配 `chat_id` 且机器人在群内。
- R8 过期会话：`chat_id`（`oc_`）长期有效但用户离职/转租户会失效 → 失败即记 `failed` 不升级为重试风暴。

---

## 8. 验证步骤（至少 5 条可执行，全部只读/沙箱，不碰生产凭据与真实 API）

1. 单测 `pushKey` 幂等：同一 `(taskId, eventKind, run.id)` 两次入队只产生一行（SQLite 内存库 `:memory:` + 新 migration），断言 `INSERT OR IGNORE` 行为。Fixture：伪造 `Task{status:'completed', run:{id:'r1', finalizedAt}}`。
2. 单测边沿触发：连续三次 `scan()`（终态→终态→终态）只入队一次；`reviewState: pending→accepted` 不产生第二次 `awaiting_review`。Fixture：`listHeadsCommitted` stub。
3. 单测失败分类：`LarkChannelError('rate_limited')` → `next_retry_at` 指数退避；`permission_denied` → `failed` 无重试；`230053` 文本 → 目标表 `subscribed=0`。全部用 fake channel（沿用现有 `channelFactory` 注入接缝，**代码已验证 `service.ts:294` 与 `ImServiceOptions.channelFactory:43`**）。
4. 集成（本地 SQLite fixture）：构造含 3 个任务的 `weaver.db` 副本（completed+failed+stalled 各一），跑 `scan()+tick` 全流程，断言队列表 3 行、fake channel 收到 3 次 `send` 且 `to` 均为白名单内 `ou_`。
5. 沙箱手工验证（需企业自建**测试应用**，不使用生产 appId/Secret）：按 `docs/feishu-im.md:17-30` 建测试应用并只加自己到可用范围，启 `push.enabled`，跑一个 mock 执行任务至 completed，手机端收到一条文本推送；再跑一个 `rate_limit` fixture 任务，收到 `blocked` 推送且 1 小时内无重复。
6. 刷屏回归：在沙箱对同一任务连续触发 5 次 commit（stream flush 模拟），断言手机端至多 1 条 + digest 聚合；重启 Weaver 一次，断言无重复补发（除终态 digest 外）。
7. 回滚验证：关闭 `push.enabled` 后终态任务产生 0 行队记录；`git status` 除本文件外无新增改动（本任务验收标准之一）。

---

## 附：关键证据索引（抽查用）

- IM 通道：`src/main/im/channel.ts:106`（建链）、`:153`、`:163-181`（send/stream/updateCard）；`src/main/im/service.ts:43`（Options）、`:294`（channelFactory 接缝）、`:471-474`（notice）、`:475-517`（入站 gate）、`:596-665`（turn）、`:668-684`（card 回调）。
- 配置：`src/shared/contracts/im.ts:1-46`；`src/main/im/settings.ts:20-21,59-61,118-137`；`docs/feishu-im.md:17-30,88-96`。
- 任务：`src/shared/contracts/tasks.ts:22,27,72`；`src/main/store.ts:24,53-81,99-101`；`src/main/migrate.ts:4,12-24`；`src/main/manager.ts:75,86-88,98-104,287,668-752`；`src/main/application/tasks/records.ts:9-11`；`src/main/application/scheduling/coordinator.ts:23-27,48-75`；`src/main/application/scheduling/vendor-limits.ts:28-61`；`src/main/stall.ts:20,24,46,126-134,292-294`；`src/main/runtime.ts:184-186,250`。
- SDK：`node_modules/@larksuite/channel/dist/index.d.mts:160-206`（SendInput）、`:364`（错误码）、`:1309-1347`（send/stream/reply/updateCard系）；`dist/index.mjs` `detectReceiveIdType()`（`oc_/ou_/on_/@/user_id` 前缀映射）。
- 官方文档：发送消息 https://open.feishu.cn/document/server-docs/im-v1/message/create ；事件订阅配置 https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure- ；open_id 获取 https://open.feishu.cn/document/home/user-identity-introduction/how-to-get 。
