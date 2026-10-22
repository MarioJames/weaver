# DeepSeek Harness 验收记录（隔离实例 + 最小真实调用）

日期：2026-10-22（UTC；界面时间为 EDT 10-21 21:0x）。工作树：`/tmp/weaver-05b7cade-cQz5Lk/owner-patch/wt`
（HEAD 叠加待验收改动的临时 worktree）。隔离数据目录：`/tmp/weaver-05b7cade-cQz5Lk/c3/data`，
端口 4791，unit `dev-weaver-deepseek-harness`。本文件不含任何凭据；
vendorSessionId 仅记录 `session-` 前缀。

所有 CLI 调用均带隔离前缀（为行文简洁下文记为 `ww ...`）：

```
XDG_DATA_HOME=/tmp/weaver-05b7cade-cQz5Lk/c3/xdg node /tmp/weaver-05b7cade-cQz5Lk/owner-patch/wt/dist/cli/main.mjs --data-dir /tmp/weaver-05b7cade-cQz5Lk/c3/data ...
```

从未使用 PATH 上的 `weaver`，从未连接默认数据目录与 4737 端口。

## 1. typecheck / test / build（干净树）

工作树：`npm run typecheck` 无输出通过；`npm test` 共 1636 项、通过 1626、失败 0、
跳过 10、耗时约 30s；`npm run build` 成功（约 1.76s，仅有 lobe 图标
`MODULE_LEVEL_DIRECTIVE "use client"` 打包提示，与本次改动无关）。

结论：三者全部通过。

## 2. 隔离实例启动

- 新建 `/tmp/weaver-05b7cade-cQz5Lk/c3/data`（权限修正为 700，否则本地 IPC
  安全检查报 `UNSAFE_ENDPOINT Application data directory is unsafe` 而拒绝启动；
  原因是目录继承了组可写位，属环境问题非代码问题）、`xdg/`、`ws/`（`git init`）。
- `setsid systemd-run --user --scope --collect --unit=dev-weaver-deepseek-harness
  -p MemoryHigh=8G -p MemoryMax=10G -- node .../dist/cli/main.mjs web --no-open
  --port 4791 --data-dir .../c3/data`，后台启动，返回 `http://127.0.0.1:4791`，
  端口 4791 监听正常。
- 写操作前 `ww policy get` 核对：`revision: 0`，全新空库，确认为隔离实例。

## 3. 引擎验证与策略启用

- `ww engines scan`：dsh `status: installed`，`path` 为 dsh 包内 bin，
  `version: 0.2.1-rc.2`；readiness 中 dsh 初态 `installed: true, enabled: false`。
- `ww engines health`：返回各引擎 stall/penalty 台账，均含 dsh 条目（level 0，
  无阻塞）；启用状态以 scan readiness 为准。
- `ww engines models --engine dsh`：`source: dsh 无列表命令，用内置的
  deepseek-flash 与 deepseek-v4-pro`，模型 `deepseek-flash`（文本+图像·1M 上下文）、
  `deepseek-v4-pro`（纯文本·1M 上下文）。
- `ww workers probe --worker dsh_worker`：被拒绝，
  `INVALID_REQUEST Worker dsh_worker 不是启用且标记 free_channel 的子 Agent，无法探测`
  ——该命令只覆盖免费渠道 worker，dsh_worker 不适用，未产生任何真实调用。
- 策略变更（`policy validate` 先通过，再保存）：
  `ww policy save --input {revision: 0, config, blocks: []}`（dsh_worker 改 enabled，
  claude_owner.workers 追加 dsh_worker 并设 `worker_weights.dsh_worker = 5`，
  engines.dsh 保持禁用由 toggle 开启）→ `revision: 1`；
  `ww engines set-enabled --input {id: dsh, enabled: true, revision: 1}` →
  `revision: 2`，dsh 已启用。
- 启用后 `ww engines scan`：dsh `enabled: true`，`adapterStatus: real`，
  `realExecution: true`，版本 0.2.1-rc.2。
- 连通性 hello（第 3 步授权的 1 次真实问候；probe 未用过额度）：
  子 Agent 页 dsh_worker「连通测试」→ `可用 dsh · deepseek-flash · high，
  2.8 秒`，回复 `hi`。见截图 `worker-dsh-hello.png`。

## 4. 端到端真实运行（第 4 步授权的 1 次任务）

- `ww owners attach`：name=`Claude · 一个特别特别长的父Agent实例名称用于验证卡片省略效果是否正确 · 21:00`，
  profileId=`claude_owner` → ownerId `bf51f7e9-8ae0-45cf-b124-df6a0e843681`。
- `ww tasks create`（workspace=`/tmp/weaver-05b7cade-cQz5Lk/c3/ws`，title 为 52 字超长标题，
  goal 为创建 hello.txt 且不做其他事）→ taskId `014f5743-1594-4ebe-bbd5-21340e33d802`。
- `ww packages create --task-id …`（scope/acceptanceCriteria 限定只写 hello.txt）→
  packageId `fe5ef026-f6c5-4ac0-bce2-1f8ba00cfc62`。
- `ww workers spawn --task-id … --input {worker: dsh_worker}` → `status: running`，
  dispatch `engine: dsh, worker: dsh_worker, model: deepseek-flash, effort: high,
  execution: real`。
- `ww tasks wait --task-id … --for 600`：约 7 秒后 `status: completed`（revision 21）。
- `ww tasks get`：`run.engine = dsh`，`run.execution = real`，`exitCode = 0`，
  `vendorSessionId` 以 `session-` 开头（后缀略），token 耗用 input 162 / output 208。
- `ww tasks results`：`execution: completed`，摘要确认只创建了 hello.txt 并通过自检。
- 工作区：`od -c hello.txt` = `O K \n`（3 字节），`git status --porcelain` 仅 `?? hello.txt`。

结论：任务 completed，run.engine 为 dsh，vendorSessionId 前缀符合，hello.txt 内容为 OK。

## 5. 浏览器验收（http://127.0.0.1:4791，agent-browser）

截图目录 `docs/verification/deepseek-harness/screenshots/`，共 7 张：

| 文件 | 内容与结论 |
|---|---|
| `engines-dsh.png` | 引擎页 dsh 卡片：id `dsh`、`已安装`、`0.2.1-rc.2`、启用开关开、「未提供原生额度接口」、主动刷新额度关。引擎页所有卡片均为无图标文本设计（claude/codex 等亦然），无错位/截断。DeepSeek 品牌图标出现在任务侧标签（见下）。 |
| `worker-dsh-effort.png` | 子 Agent 页 dsh_worker：已启用，引擎 dsh，模型 deepseek-flash（提示 2 个静态模型 deepseek-flash/v4-pro、可手填），推理强度下拉含 off/low/high/max（当前 high）。 |
| `worker-dsh-hello.png` | 连通测试结果：`可用 dsh · deepseek-flash · high`，`2.8 秒 · 21:06`，回复 `hi`。 |
| `owner-claude-dsh-worker.png` | 父 Agent 页 claude_owner 子 Agent 列表含 dsh_worker，权重 5，预设 不派发/默认/最高。 |
| `board-wide.png`（视口 1600px，列宽 ≥300px） | 看板卡片：子 Agent 标签 `dsh_worker`（带 DeepSeek 图标）不挤压标题；标题两行截断；页脚单行`由 [图标] Claude 于 21:03 派发 · 完成于 21:03`，时间片段完整、无重叠。 |
| `board-narrow.png`（视口 900px，列宽 <300px，横向滚动） | 同一卡片：标题两行截断；页脚按部分换行（`…派发 ·` / `完成于 21:03`），各时间片段各自完整、无重叠。 |
| `task-detail-owner.png` | 任务详情 AgentFacts：父 Agent 显示 `Claude · 一个特别特别长的父Agen…` 省略号截断（Tooltip 悬停为全名），子 Agent `dsh_worker`，模型 `dsh / deepseek-flash · high`。 |

补充 DOM 核对（eval，无模型调用）：卡片页脚父 Agent 元素 `title` = 全名
`Claude · 一个特别特别长的父Agent实例名称用于验证卡片省略效果是否正确 · 21:00`
（悬停显示全名），`aria-label=父 Agent：Claude`；子 Agent 标签 `title=dsh_worker`；
首个时间起点 x=876 大于名称右界 857，无重叠。

说明：按实例命名规则（`ownerHostName` 取 ` · ` 之前），卡片页脚显示 host 部分
`Claude`、全名进 `title`，筛选 chips 显示 `Claude · 21:00`、全名进 `title`；
真正的长名省略在视觉上由详情页父 Agent 行直接证明。结合样式 diff
（cardParent flex 收缩+ellipsis、cardTail/cardTime flex:none、cardTag 上限 60%），
( B ) 验收成立。

发现的其它界面问题（只报告，未修改）：

1. 子 Agent 页 dsh_worker「用途说明」仍为默认文本
   `Disabled DeepSeek Harness worker (deepseek-flash via dsh). Needs DEEPSEEK_API_KEY …`，
   与当前已启用状态不符（默认配置文案滞后，数据层小瑕疵）。
2. 窄列下等待文案曾在数字与量词间换行（`已等 5 / 分钟`），属中西文混排常规断行，
   非本次改动引入。
3. 父 Agent 页同样有「连通测试」按钮，未点击（避免超出授权的真实调用额度）。

## 6. 资源清理

- `systemctl --user stop dev-weaver-deepseek-harness.scope`：unit 已消失，
  端口 4791 无监听。
- `agent-browser close --all`：关闭了 `default` 与一个同机既有会话
  `market-upsec-acceptance`（疑似并行任务遗留；如属活跃会话，对方重开即可，
  无数据影响）。
- 未删除 `/tmp/weaver-05b7cade-cQz5Lk/c3/data`（留待父 Agent 复核后回收）。
- 真实调用共 2 次：连通测试 hello ×1、端到端任务 ×1，均在授权内，无失败重试。

## 7. 补测：父 Agent 长标题

环境同上：worktree `/tmp/weaver-05b7cade-cQz5Lk/owner-patch/wt`，隔离数据目录
`/tmp/weaver-05b7cade-cQz5Lk/c3/data`（权限 700），端口 4791，unit
`dev-weaver-deepseek-harness`；CLI 前缀同第 1 节，未调用真实模型、未派发任务。

本次实际命令（无凭据）：

```
export XDG_DATA_HOME=/tmp/weaver-05b7cade-cQz5Lk/c3/xdg
WW=(node /tmp/weaver-05b7cade-cQz5Lk/owner-patch/wt/dist/cli/main.mjs --data-dir /tmp/weaver-05b7cade-cQz5Lk/c3/data)
chmod 700 /tmp/weaver-05b7cade-cQz5Lk/c3/data
setsid systemd-run --user --scope --collect --unit=dev-weaver-deepseek-harness \
  -p MemoryHigh=8G -p MemoryMax=10G -- node /tmp/weaver-05b7cade-cQz5Lk/owner-patch/wt/dist/cli/main.mjs \
  web --no-open --port 4791 --data-dir /tmp/weaver-05b7cade-cQz5Lk/c3/data
"${WW[@]}" policy get
"${WW[@]}" owners list
"${WW[@]}" owners describe --input /tmp/weaver-05b7cade-cQz5Lk/c6/owner-title.json
```

浏览器命令均带独立会话 `dsh-c6`：

```
agent-browser --session dsh-c6 open http://127.0.0.1:4791
agent-browser --session dsh-c6 set viewport 1920 900
agent-browser --session dsh-c6 screenshot .../screenshots/board-long-owner-wide.png
agent-browser --session dsh-c6 set viewport 900 900
agent-browser --session dsh-c6 screenshot .../screenshots/board-long-owner-narrow.png
agent-browser --session dsh-c6 eval --stdin < /tmp/weaver-05b7cade-cQz5Lk/c6/measure.js
agent-browser --session dsh-c6 close
```

### 7.1 设置实例 title

先核对隔离实例：`ww policy get` 返回 `revision: 2`（很小的修订号，与第 3 节
保存后的状态一致）。`ww owners list` 取到实例
`bf51f7e9-8ae0-45cf-b124-df6a0e843681`（`Claude · 一个特别特别长的父Agent实例名称用于验证卡片省略效果是否正确 · 21:00`）。
写入 `/tmp/weaver-05b7cade-cQz5Lk/c6/owner-title.json` 后执行：

```
ww owners describe --input /tmp/weaver-05b7cade-cQz5Lk/c6/owner-title.json
```

返回 `ok: true`，实例新增
`title: 接入本机 DeepSeek Harness（dsh）引擎并验证看板卡片父 Agent 超长标题的省略效果`。
该 title 是本次触发省略所必需：未设置 title 时卡片按实例 name 的 ` · ` 前宿主短名
显示为 `Claude`，不会触发长名称省略。

### 7.2 宽列（≥300px）

服务启动命令与第 2 节一致。视口 1920×900 下「待验收」卡片实测
`rect.width = 368px`（`clientWidth = 366`），已超过 300px 容器查询阈值。
DOM 核对结果：

| 项 | 实测值 |
|---|---|
| 名称可见文本 | `接入本机 DeepSeek Harness（dsh）引擎并验证看板卡片父 Agent 超长标题的省略效果` |
| 名称 `clientWidth / scrollWidth` | `169 / 483`，`scrollWidth > clientWidth` |
| 名称计算样式 | `overflow: hidden`、`text-overflow: ellipsis`、`white-space: nowrap`，视觉为单行省略 |
| 名称 `title` | `接入本机 DeepSeek Harness（dsh）引擎并验证看板卡片父 Agent 超长标题的省略效果 · Claude · 一个特别特别长的父Agent实例名称用于验证卡片省略效果是否正确 · 21:00` |
| 名称 `aria-label` | `父 Agent：接入本机 DeepSeek Harness（dsh）引擎并验证看板卡片父 Agent 超长标题的省略效果` |
| 名称右边界 | `1290.53px` |
| 第一个时间片段左边界 | `1309.88px`（`21:03`），名称右界小于时间左界，未重叠 |
| 第二个时间片段 | `21:03`，完整；页脚文本为 `由 <长 title> 于 21:03 派发 · 完成于 21:03` |

截图 `screenshots/board-long-owner-wide.png`（1920×900）。注：在 1600×900 下侧栏
展开时「待验收」列实际只有 286px（卡片 288px），低于 300px；因此宽列验收使用
1920×900 取得 368px，1600 宽度下的表现与窄列分支一致。

### 7.3 窄列（<300px）

视口 900×900 下卡片 `rect.width = 216px`（`clientWidth = 214`）。DOM 核对结果：

| 项 | 实测值 |
|---|---|
| 卡片内容区 | `left = 553px`，`right = 743px`（padding 12px + border） |
| 名称 `clientWidth / scrollWidth` | `190 / 483`，仍有省略号 |
| 名称边界 | `left = 553px`，`right = 743px`，完全落在内容区内，未越界 |
| 名称与时间 | 名称 `bottom = 691.08px`，时间 `top = 694.08px`，纵向不相交；`overlapNameAndTimes = false` |
| 时间片段 | `21:03`、`21:03` 均完整，`insideCardContent = true` |
| 页脚换行 | `由` / 名称 / `于 21:03 派发 · 完成于 21:03` 分成三行，名称自身单行省略 |

截图 `screenshots/board-long-owner-narrow.png`（900×900）。

### 7.4 父 Agent 筛选中的长标题

长标题同时出现在看板「父 Agent」筛选行，chips 为
`父 Agent 全部 [长标题] 1`。该 chip 实测 `clientWidth = scrollWidth = 509`，
完整显示不截断，`title` 为长 title 加实例全名；在 900px 窄视口下同一行也完整可见。
截图 `screenshots/long-owner-detail.png`（筛选区，1284×235）。

详情抽屉另做了文本/DOM 核对：其「父 Agent」行当前仍显示实例完整 name
（`Claude · 一个特别特别长的父Agent实例名称用于验证卡片省略效果是否正确 · 21:00`），
而不是本次设置的 title；该行在 237.5px 宽度内以省略号截断（`scrollWidth = 503`），
未检出原生 `title` 属性。此项仅记录，未修改。

### 7.5 结论与清理

- 父 Agent 长 title 已在隔离实例成功设置并回读；卡片页脚名称单行省略、`title`
  保留完整名称，宽列时间片段完整且位于名称右侧；窄列名称不越界、时间片段完整，
  两段在纵向上不重叠。验收通过。
- 除上述详情抽屉 title 使用差异外，未发现本次修复引入的其他明显界面问题；
  页面无 console 错误、无页面异常，网络请求均为本机 `/api/rpc` 200。
- `agent-browser --session dsh-c6 close` 仅关闭本次会话；`session list` 仍显示其他
  既有会话（`market-upsec-acceptance`、`im-final-lifecycle`），未触碰。
- `systemctl --user stop dev-weaver-deepseek-harness.scope`：unit 已不存在，端口
  4791 无监听；4737 端口及默认数据目录未接触。隔离数据目录保留，未清理。

## 8. 补测：窄列由与名称同行

### 8.1 改动要点

第 7.3 节记录的窄列三行形态（`由` / 图标+名称 / 时间）是本次要修的问题。原因：
<300px 时页脚是普通文本流，名称 `cardParent` 为 `inline-block` 且
`max-inline-size:100%`，长名称作为整体放不到「由 」之后，只能换行，留下孤立的
`由`。修复只改 `src/renderer/features/tasks/task-style.ts`：

- 窄形态 `cardParent` 的上限改为 `calc(100% - 2em)`，为行首的「由」和其后的空格
  预留位置；长名称因此始终与「由」同行，并在行内以省略号收缩。
- `@container (min-width: 300px)` 内仍为 `max-inline-size:100%`，宽列的单行 flex
  布局与名称宽度分配保持不变。
- 时间片段继续使用 `white-space:nowrap`，放不下时整体换到下一行且文本完整。
- `TaskBoard.tsx`、`AgentFacts.tsx` 与任务详情等非卡片场景均未改动。

`tests/renderer/renderer-card-overflow.test.ts` 先改断言复现问题：旧实现的
`max-inline-size:100%` 使新增的 `calc(100% - 2em)` 断言失败；改样式后该测试通过。

### 8.2 测试结果

| 命令 | 结果 |
|---|---|
| `node --import tsx --test tests/renderer/renderer-card-overflow.test.ts tests/renderer/renderer-board-footer.test.ts` | 17 pass / 0 fail（修复前新增断言失败，修复后通过） |
| `node --import tsx --test 'tests/renderer/**/*.test.ts'` | 517 pass / 0 fail |
| `npm run typecheck` | 退出码 0 |
| `npm run build` | 退出码 0，`vite build` 成功 |

### 8.3 浏览器 DOM 数据

服务仍为同一隔离实例与数据（`--data-dir /tmp/weaver-05b7cade-cQz5Lk/c3/data`，
端口 4791），`agent-browser --session dsh-c7` 访问 `http://127.0.0.1:4791`。

宽列（1920×900，卡片 `368px`，内容区 `342px`）：

| 项 | 实测值 |
|---|---|
| 名称 `max-inline-size` | `100%`（容器查询宽列分支） |
| 名称 `clientWidth / scrollWidth` | `169 / 483`，省略号生效 |
| 名称 `title` | 完整长标题 + `Claude · … · 21:00`，未变 |
| 「由」文本 top / 名称文本 top | `632.23 / 632.23`，同一行 |
| 名称右界 / 第一个时间片段左界 | `1290.53 / 1294.53`，无重叠 |
| 页脚高度 / 第二个时间片段右界 | `20px` / `1448px`（等于内容区右界），单行完整 |

窄列（900×900，卡片 `216px`，内容区 `left=553 / right=743`）：

| 项 | 实测值 |
|---|---|
| 名称 `max-inline-size` | `calc(100% - 24px)` |
| 名称 `clientWidth / scrollWidth` | `166 / 483`，省略号生效 |
| 名称 `title` | 完整长标题 + 实例全名，未变 |
| 「由」文本 top / 名称文本 top | `654.08 / 654.08`，同一行 |
| 名称右界 | `734.34 < 743`，未越出内容区 |
| 页脚高度 | `40px`（两行，不再出现孤立的「由」行） |
| 时间片段 | 第二行 top `674.08`，文本 `于 21:03 派发 · 完成于 21:03` 完整，右界 `705.81` |

短名称回归：在页面内把名称临时替换为 `Claude` 后复测，`由`/名称/第一个时间片段
同在 top `654.08`，仅第二个时间片段落到下一行（top `674.08`），页脚仍为两行、
无多余空行；随后 reload 恢复原 DOM。

### 8.4 截图与清理

- 覆盖更新 `screenshots/board-long-owner-wide.png`（1920×900，宽列单行未变）与
  `screenshots/board-long-owner-narrow.png`（900×900，`由` 与名称同行、时间在
  第二行）。
- 页面无 console 错误/page error；未发起任何真实模型调用。
- `agent-browser --session dsh-c7 close` 仅关闭本次会话，`session list` 中其他
  既有会话（`market-upsec-acceptance`）未触碰。
- `systemctl --user stop dev-weaver-deepseek-harness.scope` 后 unit 为 `inactive`，
  端口 4791 已释放；4737 端口未触碰。隔离数据目录保留，未清理。
