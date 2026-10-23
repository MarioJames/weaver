# Bot 调度主引擎 — 浏览器验收证据（本轮）

## 环境（隔离，仓库内）

- 仓库：`/home/mocha/opensource/weaver`；被测代码：`src/renderer/features/bots/ImSettings.tsx`、`im-state.ts`
  （含 UI 层哨兵 `OWNER_AUTO_VALUE=':auto:'`：草稿/契约里自动仍是 `''`，下拉 value/回调之间做 `'' <-> 哨兵` 映射），
  单测 `tests/renderer/renderer-im-owner-profile.test.ts`。
- 隔离实例：`http://127.0.0.1:4791/`（端口 4791，`ss` 确认空闲后使用）。
- 数据目录（仓库内）：`/home/mocha/opensource/weaver/.weaver/a2d`（`chmod 700`，真实目录非 symlink；
  实测 control socket 路径 91 字节，低于 local-ipc 103 字节上限；未使用 `/tmp` 或其他仓库外目录）。
- XDG：`export XDG_DATA_HOME=/home/mocha/opensource/weaver/.weaver/scratch/b6ec2a77/a2/xdg`（只给 CLI，服务进程未设）。
- 服务启动：`systemd-run --user --scope --collect --unit=dev-weaver-b6ec2a77-a2 -p MemoryHigh=8G -p MemoryMax=10G -- npx tsx src/cli/main.ts web --dev --no-open --port 4791 --data-dir /home/mocha/opensource/weaver/.weaver/a2d`
  （`setsid … &` 后台化以避开工具超时 kill；unit 名与任务书一致）。
- 所有 CLI 调用均显式带 `--data-dir /home/mocha/opensource/weaver/.weaver/a2d`；每次写操作（`policy save`）前先 `policy get` 核对修订号来自隔离实例（策略 rev 0→4）。
- 浏览器：`agent-browser`，session `weaver-b6ec2a77-a2`，profile
  `/home/mocha/opensource/weaver/.weaver/scratch/b6ec2a77/a2/browser-profile`（无头；结束后已关闭并删除）。
- 全程 Bot 保持 `enabled=false`，未填 App ID/Secret/open_id，未连接飞书；Agent 状态始终「未启动」。
- 本轮验收期间（服务启动 → 结束）未改动任何代码；服务为全新启动后的干净页面加载。

## 步骤与结果（每步后均执行 `agent-browser console` + `agent-browser errors`）

### (a) 下拉选项 — `a-bot-page.png` / `a-owner-options.png`
- Bot 页出现「调度主引擎」行（聊天引擎/模型/力度之后、工作空间之前）。触发框在默认状态下直接显示「自动（按策略）」（哨兵修复生效，不再空白）。
- 下拉打开后选项：
  - `自动（按策略）`（首项，已选中）
  - `claude_owner · claude · claude-opus-5-5`（可选）
  - `codex_owner · codex · gpt-6-astra`（可选）
  - `pi_owner · pi · glm-5.3-flash（已停用）`（禁用）
- 说明文案含「父 Agent」，无「负责人/工作代理」用语。
- 控制台：仅 vite `connecting/connected` debug + React DevTools 提示；`errors` 为空。

### (b) 选择保存后刷新保持 — `b-saved.png` / `b-after-reload.png`
- 选择 `codex_owner` → 触发框显示 `codex_owner · codex · gpt-6-astra`，保存/放弃可用 → 点保存 → 放弃按钮变 disabled（草稿清空）。
- 刷新页面后仍显示 `codex_owner · codex · gpt-6-astra`，无草稿。
- 控制台：仅 vite + DevTools；`errors` 为空。

### (c) 停用 → 失效提示 + 阻止保存 → 切回自动；删除 → missing — `c-*.png`
- CLI 将 `codex_owner` 停用（`policy save`，策略 rev 0→1）→ 刷新后该行即时提示
  「当前选择的父 Agent 已停用，请改选或切换为自动。」（`c-disabled-hint.png`），触发框显示 `codex_owner · codex · gpt-6-astra（已停用）`。
- 选当时有效的 `claude_owner` 建草稿后，CLI 又将其停用（rev 1→2）→ 轮询拿到新快照后
  草稿行出现同一失效提示；此时点「保存修改」被前端校验拦下：字段错误保留、无「已保存」、
  草稿原样保留（`c-save-blocked.png`）。
- 下拉改选「自动（按策略）」→ 触发框直接显示自动标签 → 保存成功 → 刷新保持（`c-auto-saved.png`）。
- 删除变体：重启用 `claude_owner`（rev 2→3），页面选它并保存；CLI 从策略删除该 profile（rev 3→4）→ 刷新后显示
  `claude_owner（已删除）` + 「当前选择的父 Agent 已删除，请改选或切换为自动。」（`c-missing-hint.png`），
  下拉末尾保留 `claude_owner（已删除）` 禁用项（`c-missing-options.png`）；切回自动后保存成功、刷新保持。
- 控制台（四次检查点）：均为仅 vite + DevTools；`errors` 为空。

### (d) 未保存草稿可放弃 — `d-unsaved-draft.png` / `d-discarded.png`
- 空闲超时 30→35 后「保存修改/放弃修改」可用；点「放弃修改」后恢复为 30，未发起保存。
- 控制台：仅 vite + DevTools；`errors` 为空。

### (e) 外部修改冲突 — `e-tabB-saved.png` / `e-conflict.png` / `e-resolved.png`
- 标签页 A 草稿（空闲 35，未保存）；标签页 B 同页改为 45 并保存（IM 修订 4→5，`e-tabB-saved.png`）。
- 标签页 A 的轮询已先显示「配置在别处被修改」（草稿基于修订 4、控制面已到修订 5）；再点保存出现
  saveError `IM_SETTINGS_CONFLICT: IM 操作失败，请检查配置或重新连接。`，草稿（35）不丢（`e-conflict.png`）。
- 点「放弃修改并载入最新」：冲突消除，页面载入最新值 45（`e-resolved.png`），随后关闭标签页 B。
- 控制台：仅 vite + DevTools（两个标签页各一条）；`errors` 为空。

### (f) 控制台 — `f-final-state.png`
- 全程 8 个检查点（a/b/c×4/d/e/终态）`agent-browser console` 均为 vite debug + DevTools info，无 error；
  `agent-browser errors`（页面错误）全程为空。
- 上轮出现的 `An error occurred in the <ImSettingsView> component`（React 对未捕获渲染/提交错误的 dev 日志，
  代码库与依赖中无该字符串，系 React 核心报错格式）本轮零复现：
  本轮从全新服务、干净页面加载开始，验收全程未改代码，共 15 张截图覆盖的每次交互后控制台均干净。
  上轮该错误仅出现在两次前端改码热更新窗口内（旧 service.log 可见对应时段 vite page reload），
  本轮对照表明它来自改码期间的 HMR 中间态，而非当前代码的稳定行为。

## 清理

- `agent-browser close` 已执行（会话 `weaver-b6ec2a77-a2` 终止），浏览器 profile 目录已删除。
- `systemctl --user stop dev-weaver-b6ec2a77-a2.scope` 已执行，4791 无残留监听。
- 隔离数据目录 `.weaver/a2d` 已删除；`policy-*.json` 中间文件保留于 `scratch/b6ec2a77/a2/` 由 owner 回收。
- 共享服务（`~/.local/share/weaver`、端口 4737）与 `.weaver-dev`/4738 未做任何读写、未重启/停止。
