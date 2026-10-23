# OpenCode 会话数据库清理

要求 Linux 与 Node.js ≥ 22.13，无额外依赖。不读取生产数据库也能运行测试。脚本默认预览，stdout 为单行 JSON，进度和错误写 stderr；错误退出码为 1，成功与安全跳过为 0。

```sh
# 预览：默认保留上海时区今天更新过的会话
node /home/mocha/opensource/weaver/scripts/cleanup-opencode.mjs
# 可直接作为已有定时器的执行目标，不依赖交互或工作目录
/usr/bin/env node /home/mocha/opensource/weaver/scripts/cleanup-opencode.mjs --apply --keep-days 1 --prune-events --vacuum
# 手工：清理所有保留会话中截至当前已更新的事件，无静默等待
/usr/bin/env node /home/mocha/opensource/weaver/scripts/cleanup-opencode.mjs --apply --prune-events --event-idle-minutes 0 --vacuum
# 指定隔离数据库，保留上海时区今天及前六天
node /home/mocha/opensource/weaver/scripts/cleanup-opencode.mjs --db /absolute/path/opencode.db --keep-days 7
```

这里不注册定时任务。定时运行时应提供正确 PATH/HOME；也可将 node 替换为其绝对路径。默认库为 `$XDG_DATA_HOME/opencode/opencode.db`，未设 XDG_DATA_HOME 时使用 `$HOME/.local/share/opencode/opencode.db`。路径必须存在，脚本不会新建数据库。`--keep-days` 必须是正整数；保留依据为 `session.time_updated`，默认上海当天 00:00（含）之后的数据，未来时间也保留。`--vacuum` 必须同时指定 `--apply`。

执行前检查同一用户的 OpenCode 进程，按其打开文件的设备号和 inode 核实是否持有目标数据库或 WAL/SHM；命中目标时跳过，不终止进程。候选进程的文件描述符无法检查时保守跳过，明确使用其他隔离库的进程不阻断当前清理。Weaver 打开的短暂只读认证连接不会被当成 OpenCode。脚本通过数据库同目录的 `.cleanup.lock` 目录防重入，并用 `BEGIN IMMEDIATE` 固定过期 session ID 集合，遇到数据库忙锁立即跳过。进程扫描与事务之间仍有启动竞态，SQLite 写锁保证写入互斥，但不能证明应用没有未提交的内存状态，宜在 OpenCode 停用时运行。代码拒绝非当前用户拥有的数据库；其他用户进程不在检测范围内。锁记录 PID 和 Linux 进程启动时间，已确认原进程退出的锁会自动回收；缺少或损坏 owner.json 的未知锁保持跳过。回收器自身异常退出遗留 `.reap` 目录时，也保持跳过，需核实归属后人工处理。

事务开启外键，显式删除过期 ID 对应的 event_sequence（级联 event），再删除 session（级联 message、part 与已知会话附属表）。保留会话的 event、没有对应 session 的孤立 event_sequence、认证和项目配置保留。删除前验证核心列、主键和级联外键；不认识的删除关联或触发器拒绝执行。删除后检查保留 ID、各表计数、保留 message/part/event 投影行数、孤立 event 行数、认证/项目/权限小表摘要及外键完整性，失败回滚。不对数十 GB 数据库逐次全量哈希。已有外键损坏也会拒绝清理，需另行诊断。

`--vacuum` 在删除提交后独立执行，可能需要接近数据库大小的额外磁盘空间，也会花费较长时间；压缩后执行 WAL checkpoint(TRUNCATE)。遇到忙锁会报告 skipped-busy 或 vacuum-completed-checkpoint-busy，其他压缩错误标记 failed-after-commit；已经提交的清理不会撤回。两次操作间检测到 OpenCode 启动则跳过压缩。JSON 的 before/after/deleted 是行数，bytesBefore/bytesAfter 给出数据库和 WAL/SHM 的文件大小；未压缩时文件通常不缩小。默认仅清理过期会话。只有显式 `--prune-events` 才额外删除保留会话的事件记录，默认要求 `session.time_updated <= 当前时间 - 60分钟`（边界包含）。`--event-idle-minutes` 接受含 0 的非负整数，0 表示截至当前时间，不包含未来时间。单独设置静默分钟不会启用事件裁剪。

验证命令：

```sh
node --import tsx --test tests/main/cleanup-opencode.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

## 保留会话的事件裁剪

`--prune-events` 是用户明确授权的有损维护：本地会话/消息/工具结果等投影和 event_sequence 的 seq、owner_id 原值完整保留，但旧事件的跨设备同步、回放核验及补发/断线补订阅能力丢失。它不修改事件 JSON、不压缩或重置序号、不删除孤立事件组，也不是 OpenCode 官方提供的无损日志压缩协议。

预览 JSON 的 eventPruning 显示候选会话和事件数、静默边界；统计不读取巨大的 event.data。执行时与过期删除共享事务和同一候选 ID 集合，逐一验证候选事件归零，核验保留 event_sequence 及现有 session/message/part/session_message/session_input/session_context_epoch/todo/session_share 投影内容摘要不变；account/account_state 与认证、项目、权限表也受摘要校验保护。保留会话的事件数按明确候选扣减，孤立事件数量不变。

依据 [OpenCode v1.19.4 event 实现](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/core/src/event.ts)：新事件使用保留 sequence 的 latest+1，旧 seq 回放会核验完整事件；durable 订阅和同步直接使用事件历史。会话读取与 LLM 历史走本地投影。删除历史不会禁用未来事件持久化，因此定时目标可持续清理静默会话的新增历史。运行前仍应停止 OpenCode，进程检查与写锁不能取代应用停用。


## 引擎页手动清理

引擎页仅 OpenCode 卡片提供「清理数据库」。默认保留北京时间今天，关闭保留会话事件裁剪，开启执行后的空间整理。先预览数据库与日志文件大小、待删除与保留数量，再确认不可撤销的删除范围。裁剪开关开启时额外展示同步、回放历史丢失提示；本地消息和工具结果保留。参数修改会使预览失效。

控制面通过 `startEngineCleanup` 启动 preview/apply 后台任务，由 `getEngineCleanup` 读取任务与进度；关闭再打开弹窗仍可查看正在执行的任务。请求失败保留输入，可核对进度和重试。服务端一次只执行一个任务，apply 必须引用同参数、15 分钟内、未使用过的成功预览。执行事务内会再次核对预览选择和表计数；数据库变化时拒绝删除并要求重新预览。原脚本和控制面共用 `src/main/engines/opencode-cleanup-core.mjs`，不存在两份删除 SQL。

目标路径仅由服务端环境决定：优先 `OPENCODE_DB`，其次 `$XDG_DATA_HOME/opencode/opencode.db`，最后 `$HOME/.local/share/opencode/opencode.db`。RPC 不接受客户端数据库路径。SQLite 维护在独立子进程运行，源代码 tsx、Node bundle 和 Bun standalone 都通过自身隐藏 CLI 入口启动；HTTP 服务不会被同步 SQLite 工作阻塞。服务正常关闭时先拒绝新请求，再等待维护子进程完成（包括压缩）后释放服务资源，不强制中断已提交后的空间整理。任务记录只保存在该服务进程内，重启后需重新预览。

缺少数据库、目标库正在被 OpenCode 使用、数据库忙锁或不认识的结构都会返回真实原因，不会停止 OpenCode、创建缺失库或自动放宽结构检查。删除事务成功但空间整理失败时，结果仍说明数据已清理与空间整理的实际状态。

接口集成与数据保护验证：

```sh
node --import tsx --test tests/main/cleanup-opencode.test.ts tests/main/engine-cleanup-api.test.ts
```
