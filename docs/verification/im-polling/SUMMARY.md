# IM 轮询自动刷新浏览器验收（SUMMARY）

- 验证对象：`src/renderer/features/bots/im-polling.ts` + `ImSettings.tsx` 控制器 hunk（只读验收，未改业务代码/测试预期/mock）。
- 验证版本：HEAD `e8c11bdc0069e245d335ffbad2bf7c7d094f05f2`；工作树 `ImSettings.tsx` blob `18501ca5`、`im-polling.ts` blob `375331b2`（并行任务未提交改动共存，本包只读）。
- 真实链路：真实 React 挂载（vite dev 实时变换工作树源码）+ 真实 HTTP RPC（`startRuntime` 私有实例）+ 真实 `ImService` 状态机；合成注入仅在 `parentFactory`/`channelFactory` 外部边界（可控延迟/失败），未伪造 `window.weaver` 响应，未读真实飞书凭据，未真发飞书/模型。
- 私有服务：`http://127.0.0.1:46673`（`dev-weaver-bot-poll-verify02` scope，端口以 `verify/server/url.txt` 为准），dataDir `verify/data`（已删），policy 镜像 `tests/integration/im-runtime.test.ts` 隔离（owners 全禁、`quota.auto_refresh=false`、free probe 禁用、仅 `codex` 启用）。
- 浏览器：任务模式 Google Chrome，session `im-bot-poll-01a160d2`，profile `/tmp/weaver-bot-lifecycle-thgzzwqn/im-bot-poll-01a160d2`（已删）。
- 预置：RPC 直存 disabled 有效配置 rev1（含合成 secret，存于私有 DB，已删）；浏览器内全部保存/刷新/重建均为真实 UI 点击。
- 本任务不验证飞书真连与后台 transport 新生命周期（后续集成包范围）。

## 结论（UTC 2026-10-22 00:33–00:38）

| # | 验收项 | 结果 | 证据 |
|---|--------|------|------|
| 1 | 保存/重建显示 connecting/starting/closing 后，不点刷新约 1s 自动跟进到就绪 | PASS | 保存 00:33:38.698 → 轮询 39.695/40.695/41.695/42.695（1.00s 节拍）→ 已连接/待命（`01-auto-ready.png`，`beat-01.txt`） |
| 2 | connected 但 Agent starting/closing 照样快 poll；稳定 ready 后恢复 30s 低频 | PASS | 重建后 channel 先 connected、parent 待定窗口内 1s 节拍（`02-connected-starting.png` 已连接/启动中，`beat-03-rebuild.txt` + 服务端 `channel.connected→parent resolved` 日志）；ready 后 42.695→12.794（30.10s）、12.794→42.796（30.00s）（`beat-02-stable.txt`） |
| 3 | 慢 getImSettings 不重叠、不覆盖保存/未保存草稿（secret/minutes/model 等） | PASS | 页面 fetch 包装延迟 getImSettings 响应 2500ms（真实响应仅延迟、未伪造）：过渡态轮询起点 3.50s 间隔、严格串行（`beat-04-slow.txt`）；全会话 HAR 51 个 getImSettings、重叠对 0；过渡态中键入未保存草稿 `gpt-test-3-draft` 在多次轮询 + ready 翻转后原样保留、无冲突横幅，服务端 revision 停留 4、model 保持已保存值、secret 仍 configured、密码框空 |
| 4 | 手动刷新/重建在飞与后台 poll 交错：按钮最终恢复、旧响应不回滚 | PASS | 连续点击刷新状态→重建连接与会话：中间态已连接/启动中，最终两按钮恢复可点、已连接/待命（`03-interleave-recovered.png`）；revision 单调 1→4、无回退，终态 rev4/model `gpt-test-3` |
| 5 | 断网后可恢复后续 poll | PASS | offline 8s 内 4 次轮询失败（status None）被吞错、调度存活；恢复后自动成功轮询并达 ready，无需整页刷新（`beat-05-offline.txt`：失败 49.996/50.995/52.995/56.994 → 成功 04.994） |
| 6 | 隐藏/切回、切页/卸载不残留 timer、不继续请求 | PASS | 新标签隐藏 8s 内 getImSettings 为 0，切回后 visibility 跟进轮询 29.379；切到 `#/tasks`（过渡态 1s 节奏下）8s 内新增轮询为 0（`beat-06-unmount.txt`），切回 `#/bots` 重新挂载即恢复轮询并显示 ready |

- console：仅 vite 连接与 React DevTools 提示，无报错；页面 errors 为空（`page-errors.txt` 为空）。
- 未执行项：无（6 项全部真实执行）。分钟字段等其它草稿键与本包同走 `adoptServer` 接合（单测已覆盖），浏览器内以 model/secret 为代表验证。

## 清理记录

- HAR 已停止并落盘私有 `verify/evidence/poll-beat.har`（495 条，13MB，含请求体故不进 docs；分析结论：getImSettings 零重叠）。
- `agent-browser close` + `task-profile remove`（profile 目录已删）；自有 scope `dev-weaver-bot-poll-verify02` 已停；私有 `verify/data`（DB/secret/vite 缓存）与服务端日志外其余构建产物已删；共享 Weaver 4737/4738、真实配置库、其他 target 服务均未触碰。
- 本包未提交、未推送。

## 未解决风险

- 30s 稳定节拍只观测到两个完整间隔；更长稳态漂移不在本包范围。
- offline 恢复存在约数秒的客户端退避间隔（失败后 4s 间隙），属现有 `client.ts` 重试语义，非本次控制器改动引入。
