# Bot 生命周期浏览器验收（im-lifecycle）— 脱敏摘要

结论：**PASS**。真浏览器改模型保存 → 真实 API/store/ImService 仅换 Agent 不换 channel，
starting 后约 3s 经 1s 轮询自主变 ready（无手动刷新）；Agent 启动失败时 connection 保持
connected，错误文案与按钮名准确；桌面及 390px 布局可读无水平溢出。

- 日期：2026-10-22（UTC 01:23–01:27）；被测源码见下“冻结版本”。
- 真实链路：任务模式 Chrome（session `im-final-lifecycle`，私有 profile，用后删除）＋
  私有构建 UI（vite build 到任务私有目录）＋ `startRuntime` 私有实例（port 0，私有 dataDir，
  PolicyStore 禁自动 quota/free-probe、禁真实 workers/owners 执行）＋ 真实 HTTP `/api/rpc`
 （`getImSettings`/`saveImSettings` 未做任何 mock）。
- 唯一合成边界：`parentFactory`（受控 2500ms 启动延迟＋可定点 reject）与 `channelFactory`
  （即时假连接，`state()=connected`，仅计数）；入站消息经私有 fixture 端口合成
  NormalizedMessage 注入（只合成入站，不真连飞书）。**不是真飞书，不是真实模型。**

## 冻结版本

- HEAD `5ae023f9a572e075a47eb46dfeba67ad413f124c`
- `src/renderer/features/bots/ImSettings.tsx` sha256 `9d1fffcb…c9859d94`（与 HEAD 差 3 处文案，
  逻辑零改动：error 描述按钮名、CHANNEL_DESC、save 描述）
- `src/renderer/features/bots/im-polling.ts` sha256 `05154645…a9374df1`（与 HEAD **无差异**，
  控制器未变 → `docs/verification/im-polling` 六项证据按影响分析复用，不重跑）
- `src/main/im/service.ts` sha256 `4e809d37…4ff0dc`（工作树版本，属后台包范围；本包只读，
  其 Agent/transport 分代语义是本次“只换 Agent”行为的依赖）

## 逐项结果

| # | 验收项 | 结果 |
|---|--------|------|
| A | 桌面打开 `/#/bots`：独立单聊 Agent 说明＋后台无需终端＋跨引擎提示可读；模型 m1、已连接、Agent 待命 | PASS（`A-desktop-initial.png`） |
| B | 浏览器改 m1→m2 点保存：真实 save 成功；parents 1→2、parentCloses 1、channels 仍 1、channelCloses 0；starting→ready 全自动 | PASS（`B-starting-transition.png`、`B-ready-after-m2-save.png`，时序见下） |
| B2 | 同一 live channel 合成入站 → 新 m2 parent 回复（parentSends 1、replies 1），无新增 parent/channel，仍 ready | PASS（`B-inject-replied.png`） |
| C | 改模型使 fake parent 报 protocol 错误：connection 仍 connected、Agent 启动异常、文案含真正按钮名“重建连接与会话”；草稿 m3-broken 保留可继续编辑；无假 ready | PASS（`C-agent-error.png`） |
| D | 390px：新长说明、保存提示、Agent 反馈可读，无水平溢出（scrollWidth=innerWidth=390）无遮挡 | PASS（`D-390-top.png`、`D-390-bottom.png`） |

B 过渡时序（浏览器真实请求/响应体，UTC）：save 01:25:03.807 返回
`connected/starting` → getImSettings 04.807/05.808 均为 `connected/starting` →
06.807 `connected/ready`。1.00s 轮询节拍，无手动刷新（全程未点“刷新状态”），
106 个 HAR 请求全部 2xx，console 0 条，network-errors 0。

fixture 计数（真实 factory 调用记录）：B 保存后 parents=2、parentCloses=1、channels=1、
channelCloses=0；入站后 parentSends=1、replies=1；C 失败后 parents=3、parentCloses=2、
channels 仍 1。机器契约见 `proof.json`。

## 过程中发现并已处置的 fake 边界问题（非产品 bug）

两次入站/ turn 失败均由本包自有 fake 不完整导致，已对照产品代码定位并修复 fixture 后重验通过：
1. fake channel 的 stream controller 缺 `append`，turn 内 `controller.append` 抛错；
2. fake `stream` 返回拼接文本而非 `controller.messageId`，产品按 `result === messageId`
   判定投递（`IM_DELIVERY_FAILED`）——这是真实投递语义，fake 必须遵守。
最终 B2 全回复链（lastReplyAt 落地）与 C 定点 protocol 失败均在修正后的 fixture 上复验通过。

## 未解决风险

- 私有验证 server 进程在采证间隙静默退出 3 次（无 crash 日志、无 unhandled rejection 记录；
  每次均为全部采证完成后、两次操作之间）。scope `--collect` 自动回收，端口经 curl 确认已释放，
  无证据丢失。退出原因未定位——若属产品运行时行为，需 owner 另起包调查；本包不做断言。
- 30s 稳态低频轮询沿用 im-polling 六项证据（控制器无变更），本包只观测到过渡态 1s 节拍。
- HAR/请求体含合成假 secret，只留任务私有区，已随私有现场删除，未进 git。

## 资源清理

- Chrome：`agent-browser close`（本任务 session），确认无占用本任务 profile 的进程后
  `bh task-profile remove`（profile 目录已删）。他人 Chrome/Convorel 未触碰。
- 服务：scope `dev-weaver-im-final-lifecycle` 已无残留（`status` 查无此 unit），PID 无残留，
  端口 curl 已拒绝连接。共享 4737/4738、真实开发 DB、用户数据均未触碰。
- 私有现场：任务临时根 `browser-final/`（data/build/HAR/profile/脚本/日志）已整体删除；
  保留本目录最小 durable 证据（本文件＋`REPORT.html`＋`proof.json`＋7 张 png）。
- 本包未提交、未推送；产品/测试代码零改动（除任务要求的 `tests/README.md` 门禁单条，见下）。

## 附带交付（本包唯一允许的 README 改动）

`tests/README.md` 的 Master acceptance gate 单条：删除临时过程信息“该报告 QA 正在更新”，
把已验证的测试约束恢复到这一个单一位置（真实 Codex staged 资产＋真实私有 Weaver CLI/
startRuntime、仅 external ownerHost 替身；禁手写 JSON/envelope；help 前后业务写 0；
root 计数含空/坏 root；workspace 真实存在；ACK 与 ownerHost 分别查；追问须真实 API/receipt
才称送达），证据路由仍为 `docs/verification/im-master/SUMMARY.md`，能力细节不复制。
