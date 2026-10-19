# Weaver 本地引擎运行说明

状态：本机接入与排障事实说明，2026-10-18。对象是四家真实引擎 OpenCode / Pi / Grok / Codex 的已实现固定 argv adapter（`src/main/adapters/cli/`）。本文件不再描述 Electron/MCP 路线；探测、启用、角色、模型、终态、取消与失败排查都按当前代码事实写。版本号是本机已核实的安装版本，模型/effort 是本机示例，不是普遍可用保证。

## 1. 安装与探测

引擎探测只做两件事：`PATH` 里的固定命令名 + 带超时的 `--version`（`weaver engines scan`）。它不登录、不调用模型、不证明认证或模型可用（`authenticated:false`/`modelUsable:false` 恒定）。固定目录为七个 id：`claude / codex / grok / opencode / pi / qoder / gemini`（kind 分别为 claude/codex/grok/opencode/pi/qodercli/gemini）。目录外的命令不会被探测：不允许调用方传入可执行路径。

本机已核实版本（安装事实，不是可用性承诺）：OpenCode 1.19.3、Pi 1.3.0、Grok 1.0.62、Codex 0.163.0。Claude Code 探测存在但真实执行延期（`deferred`）；`qodercli`/`gemini` 是 `not_implemented`，可以出现在探测记录里但不能配置真实路由角色。Pi `--offline --list-models` 的本机目录含 `cc-switch-agentplan` 的 `ark-code-latest / deepseek-v4.1-flash / glm-5.3-flash / kimi-k3`。

## 2. 启用与角色配置（两步，不互换）

- 第一步 `weaver engines set-enabled --input toggle.json`，body `{"id":"codex","enabled":true,"revision":<current>}`。启用要求已有 installed 探测与当前 revision；停用有启用的 owner/worker 时被拒绝并要求先单独停用角色，引擎记录与角色历史保留，不级联。启用成功后 pump 让排队任务按新准入重估。用 `policy save`/高级 JSON 把停用引擎改成启用是不允许的，同样必须走这里。
- 第二步是角色配置：worker（`engine/model/effort/tags`）与 owner（`engine/model/effort/workers 顺序/worker_weights/only_engine/max_parallel`）都是 policy 字段。每个引擎 kind 有固定 effort 词表（`EFFORTS`：claude/codex low…max、grok none…max、pi off…max、qodercli auto…ultracode；opencode 不限定词表）。启用引擎不会自动建任何角色；权重 0 排除、`only_engine` 是硬 pin（保存合法但派发时无可用 worker 会失败）。保存走 `policy validate` → `policy save`（revision 乐观锁），预览用 `policy preview`。

```json
{"codex_owner": {"enabled": true, "engine": "codex", "model": "gpt-6.1-sol", "effort": "xhigh", "max_parallel": 4,
  "workers": ["grok_worker","pi_worker","codex_worker","opencode_worker"]},
 "opencode_worker": {"enabled": true, "engine": "opencode", "model": "opencode/glm-5.3-flash-free", "effort": "max", "tags": ["mechanical"]},
 "pi_worker": {"enabled": true, "engine": "pi", "model": "cc-switch-agentplan/glm-5.3-flash", "effort": "high", "tags": ["backend","docs","test"]},
 "grok_worker": {"enabled": true, "engine": "grok", "model": "grok-4.7", "effort": "high", "tags": ["research"]},
 "codex_worker": {"enabled": true, "engine": "codex", "model": "gpt-6.1-sol", "effort": "xhigh", "tags": ["backend","algorithm","refactor","long-test"]}}
```

模型/effort 配置只声明"请求的引擎/model/effort"；vendor 自报什么,任务记录保留什么（可选 `evidence`），未报告即"未知"。保存的配置本身不宣称任何 engine/model/effort 可用；各模型 effort 的实证以 [VERIFICATION.md](../VERIFICATION.md) 为准。

## 3. 派发前置（每次真实启动）

1. launcher 模块已加载（`capabilities.realExecution:true`；加载失败 → `CAPABILITY_UNAVAILABLE`，无回退）。
2. workspace 必须是已存在的绝对路径：省略时 `tasks create` 用 CLI 调用方 cwd 补齐，显式相对路径相对调用方解析；服务端不会拿自己的仓库填空。真实派发把 workspace 与 `workspaceIdentity` 冻结进 dispatch，泵复核期间若失效记 `workspace_changed`。
3. 引擎/角色/配额/pin 当前有效：路由改变（worker/engine/kind/model/effort 或 kind 不符）、容量不足、配额 block 都会记 `queueReason`（`policy_blocked / waiting_for_capacity / frozen_route_changed / workspace_changed / launch_blocked`），排队路由不被默默改派或换引擎。
4. 超时是配置的 `herdr.max_wait_minutes`（1–1440），没有 60 秒默认值。
5. 认证复用各引擎自身本机配置；Weaver 从不复制/改写/打印密钥，也没有 global 工具安装。启动用受管 user scope 包裹进程（Linux/systemd 主机上每个 launch 一个唯一 scope），子进程随 scope 收尾。

固定 argv builder（真实核实的调用形态）：

```text
opencode 1.19.3:  run --format json --model <provider/model> --variant <effort> --pure --auto --dir <workspace>
pi 1.3.0:         --print --mode json --model <model> --thinking <effort> --no-session --session-dir <private>
                  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files
                  --tools read,write,edit,bash --approve
grok 1.0.62:      --prompt-file <private> --output-format streaming-messages-json --model <model> --effort <effort>
                  --no-subagents --no-leader --leader-socket <per-job> --permission-mode bypassPermissions
codex 0.163.0:    exec --json --ephemeral --skip-git-repo-check --sandbox workspace-write --cd <workspace>
                  --model <model> -c model_reasoning_effort="<effort>" -
```

## 4. 终态、结果与取消

- 成功终态 = vendor 真实成功 final + 最终助手文本 + 零退出。缺 final/截断/非零退出/错误终态一律 failed，绝不映射为成功；部分输出与脱敏诊断保留（有界 `result.md`/artifact 与 observability）。
- 失败与取消如实区分：quota/认证失败按 provider 错误信息报告，不自动改派模型/引擎或回退 mock。取消/超时保存已产出记录并停止本 launch 的 scope；排队任务可直接取消。服务重启/断开不删除记录，也不复接未知 PID 重复跑。
- 结果验收按 [agent-interface](agent-interface.md) §5：`tasks results` → 独立核文件/测试 → `results.ack` → `reviews.submit`。`execution/ack/review` 是三个独立状态。

## 5. 排障清单

| 现象 | 含义与处理 |
|---|---|
| `APP_NOT_RUNNING` | 没有运行中实例；先 `weaver web --no-open`（可用 `--data-dir` 指定状态目录） |
| `EADDRINUSE 127.0.0.1:<port>` | 已有进程占用；换 `--port` 或停掉旧实例 |
| `CAPABILITY_UNAVAILABLE`（deferred Claude / non-real kind / launcher 未加载） | 请求被拒且无回退；检查 `engines scan` 的 readiness 与 `capabilities.realExecution` |
| 派发报无可用 worker | 权重全 0、pin/only_engine 过滤后为空、角色未启用或配额 block；按 `skipped`/报错明细修 policy，别绕过 pin |
| `POLICY_DENIED` | owner profile 不可用（disabled/引擎停用/block）；先修角色或双 owner 指派 |
| 任务一直 queued 且 `queueReason` 变化 | 容量/配额/冻结路由/失效 workspace/启动失败之一；读 `observability get` 的 `queueReason` 与 route，修对应项；取消是显式动作 |
| workspace 报错 | 真实执行需要存在中的绝对路径；在上游 CLI 用调用方 cwd（`tasks create`）或显式绝对路径 |
| 输出含密钥风险 | loader/协议层已做脱敏与有界截断；仍属 best-effort，共享前自检（`observability` redaction 说明） |
| `TIMEOUT`（wait/watch） | 等待窗口结束不等于失败；查 `tasks get` 后按需再 `tasks wait`，超时不影响任务与配额 |
| 重复/不确定 mutation | 用原 commandId 重发同参数或 `operations get` 查收据；换新 ID 会造成双执行风险 |
