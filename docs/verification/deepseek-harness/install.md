# DeepSeek Harness（dsh）用户级安装与程序化调用接口验证

- 日期（UTC）：2026-10-21
- 目标：以用户级方式安装 DeepSeek 官方 `dsh`，验证可运行，并调研其非交互/无头 CLI 接口，作为后续接入 Weaver 新引擎的依据。
- 非目标：不改 `opencode_deepseek_worker`（经 opencode CLI 调 `opencode-go/deepseek-v4.1-flash`，与本任务的 `dsh` 无关，未触碰）；不装 PyPI `deepseek-harness(-cli)` 与 npm `@peiyu_wang/deepseek-harness-cli` 等非官方同名包（均未安装）。

## 1. 官方渠道核验（安装前）

命令：

```sh
npm view @deepseek-ai/dsh version dist-tag maintainers repository bin engines homepage
npm view @deepseek-ai/dsh dist-tags
npm view @deepseek-ai/dsh@0.2.1-rc.2 --json  # 结构化复核
```

结果摘要（真实输出）：

- `name`: `@deepseek-ai/dsh`
- `version` / `latest`: `0.2.1-rc.2`（`dist-tags = { latest: '0.2.1-rc.2', alpha: '0.2.1-alpha.5', next: '0.2.1-rc.2' }`）
- `repository`: `{ url: 'git+https://github.com/deepseek-ai/deepseek-harness.git', type: 'git', directory: 'apps/cli' }` —— 指向 `github.com/deepseek-ai/deepseek-harness`，与任务要求的官方源码一致。
- `maintainers`: `imccyu <imccyu@gmail.com>`、`tianyicui-deepseek <tianyi@deepseek.com>`（含 `deepseek.com` 官方邮箱）。
- `bin`: `{ dsh: 'lib/bin.js' }` —— 提供 `dsh` 命令。
- `engines`: 无（`--json` 显示 `engines: None`；`npm view ... engines` 无输出）。依据：包元数据未声明 `engines.node`，不是归属可疑的信号；本机 node v24.21.0 可运行（见 §3）。
- `description`: `dsh CLI: profile launch, plugin management, and configuration inspection`；`license`: `MIT`；`homepage`: `https://github.com/deepseek-ai/deepseek-harness#readme`。
- 结论：官方包存在且归属无可疑，继续安装。

安装前 PATH 检查（避免覆盖不相关程序）：

```sh
which -a dsh   # dsh not found
ls ~/.local/bin/dsh  # 不存在
npm ls -g @deepseek-ai/dsh  # /home/mocha/.local/lib └── (empty)
```

PATH 上无其他 `dsh`，可安装。

## 2. 安装

前置：`npm config get prefix` = `/home/mocha/.local`（用户级），`node v24.21.0`，`npm 12.0.2`。全程未用 `sudo`，未要求系统级依赖。

命令（精确版本安装）：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.2
```

真实输出（原文）：

```text
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead

added 613 packages in 45s

68 packages are looking for funding
  run `npm fund` for details
npm warn install-scripts 5 packages had install scripts blocked because they are not covered by allowScripts:
npm warn install-scripts   @deepseek-ai/dsh-subprocess-local@0.2.1-rc.2 (postinstall: node scripts/ensure-spawn-helper.mjs)
npm warn install-scripts   koffi@3.1.1 (install: node ./cnoke.cjs -P . -D src/koffi --prebuild --release)
npm warn install-scripts   node-pty@1.2.0-beta.15 (install: node scripts/prebuild.js || node-gyp rebuild; postinstall: node scripts/post-install.js)
npm warn install-scripts   @google/genai@2.21.0 (preinstall: echo 'preinstall: no-op')
npm warn install-scripts   protobufjs@7.6.6 (postinstall: node scripts/postinstall)
npm warn install-scripts
npm warn install-scripts Run `npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs` to allow these scripts once, or `npm config set allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs --location=user` to allow them for all global installs.
```

说明：5 个包的 install scripts 被 npm 默认策略拦截（未执行），安装仍成功；`dsh --version` 与各 `--help` 均可运行，未见因此缺失功能。未按提示放行 scripts（保持最小改动）。

安装路径与版本验证：

```sh
$ which dsh
/home/mocha/.local/bin/dsh
$ readlink -f "$(which dsh)"
/home/mocha/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
$ dsh --version
0.2.1-rc.2
$ npm ls -g @deepseek-ai/dsh
/home/mocha/.local/lib
└── @deepseek-ai/dsh@0.2.1-rc.2
```

`command -v dsh` 指向 `/home/mocha/.local` 下由 npm 安装的官方包，`dsh --version` 输出 `0.2.1-rc.2`，退出码 0。

## 3. 真实 `--help` 输出原文

### 3.1 `dsh --help`（启动器自身）

```text
Usage: dsh [--profile] <name> [options] [app-args...]
       dsh plugin --profile <name> <pnpm-args...>

dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch
layers under your own overrides.

Arguments:
  args                           arguments for the booted profile's app (see:
                                 dsh --profile <name> --help)

Options:
  -V, --version                  output the version number
  --profile <name>               the profile under $DSH_HOME/profiles to boot
  --from-default-profile <name>  replace a custom profile with a fresh copy of a
                                 shipped profile template
  --patch <path>                 extra patch-list overlay applied after the
                                 profile layer (repeatable)
  --dump-config                  print the composed profile tree and exit
  --dump-config-schema           print JSON Schema for profile entries and
                                 patches without mounting
  --dump-default-config          print the profile tree without its user layer
                                 or --patch overlays and exit

Examples:
  dsh web                                   boot the web profile (same as: dsh --profile web)
  dsh rescue --from-default-profile web
                                            recreate rescue from the shipped web template, then boot it
  dsh headless "run the tests"              answer one task, print the result, and exit
  dsh tui --patch ./extra.yml               boot a custom profile with one extra overlay
  dsh tui --resume <session>                arguments after the launcher flags reach the app
  dsh web --help                            the web app's own flags and help
  dsh plugin --profile tui add <package>    install a plugin into the tui profile
```

### 3.2 `dsh --profile headless --help`（等价 `dsh headless --help`，已验证两者输出一致）

```text
Usage: dsh --profile headless [options] [task...]

Answer one task and exit; the answer goes to stdout and diagnostics to stderr.

Arguments:
  task               the task text; multiple words are joined by spaces, and `-`
                     reads stdin

Options:
  --json             write newline-delimited run events to stdout instead of the
                     final message
  --session-id <id>  adopt the persisted Session with this id; an unknown id is
                     an error
  -h, --help         show this help

Examples:
  dsh --profile headless "run the tests"          answer one task and exit
  echo "run the tests" | dsh --profile headless   read the task from stdin
  dsh --profile headless --json "run the tests"   emit machine-readable run events
  dsh --profile headless --session-id session-… "continue"   resume an existing Session
```

### 3.3 其他 profile `--help`（供对照；`tui` 未安装，按需说明）

`dsh --profile sdk --help`：

```text
Usage: dsh --profile sdk [options]

Serve DeepSeek Harness SDK clients over stdio JSON-RPC.

Options:
  -h, --help  show this help

Example:
  dsh --profile sdk     serve one SDK runtime until its client disconnects
```

`dsh --profile acp --help`：

```text
Usage: dsh --profile acp [options]

Serve automation clients over Agent Client Protocol stdio.

Options:
  -h, --help  show this help

Example:
  dsh --profile acp     serve ACP until the client disconnects
```

`dsh --profile web --help`：

```text
Usage: dsh --profile web [options]

Serve the DeepSeek Harness browser UI.

Options:
  --host <host>                  bind address: one concrete IPv4 or IPv6 literal
                                 of a local interface; wildcard addresses are
                                 rejected
  --no-open                      do not open the Web UI in the default browser
  --port <port>                  listen port; pass 0 to let the OS pick a free
                                 one
  --public-url <url>             advertise this HTTP(S) root in the printed,
                                 opened, runtime-context, and DSH_WEB_URL forms;
                                 grants no trust
  --trusted-host <authority...>  extra authority the /api browser-trust fence
                                 accepts (host or host:port; repeatable)
  --tls-cert <file>              PEM server certificate chain; requires
                                 --tls-key
  --tls-key <file>               unencrypted PEM private key; requires
                                 --tls-cert
  -h, --help                     show this help

Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --host 10.0.0.7          bind one local interface address
  dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
                                             advertise a prefix-stripping HTTPS proxy entry and admit its authority
  dsh --profile web --tls-cert ./server-chain.pem --tls-key ./server-key.pem
                                             serve HTTPS with an existing certificate and key
```

`dsh plugin --help`：

```text
Usage: dsh plugin [options] [args...]

manage a profile's plugins by forwarding the remaining arguments to pnpm in the
profile directory

Arguments:
  args              pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>,
                    why <pkg>, ...)

Options:
  --profile <name>  the profile whose plugins to manage (initialized on first
                    use)
  -h, --help        show this help
```

注意：`dsh tui --help` 在本机失败退出（exit 1），因为 `tui` profile 未安装，`dsh` npm 包不自带该 profile：`Error: dsh: profile "tui" does not exist; create it with 'dsh plugin --profile tui add <package>'`。本机已自动初始化的 profile 为 `headless`、`sdk`、`web`（见 `~/.dsh/profiles/`）。

## 4. 程序化调用接口（供 Weaver 新引擎接入）

以下均以真实 `--help` 输出与已安装包内文件为依据；凡经核实不存在的接口明确写『不支持』。

包内文件根说明：npm 全局包文件在 `/home/mocha/.local/lib/node_modules/@deepseek-ai/dsh/`，其依赖嵌套在 `node_modules/@deepseek-ai/` 下（如 `node_modules/@deepseek-ai/dsh-headless/`）。下文“包内路径”均相对该根。

### 4.1 非交互/一次性执行模式与确切 argv 模板

支持。`headless` profile 即官方 one-shot 模式（包：`node_modules/@deepseek-ai/dsh-headless/`；README：`node_modules/@deepseek-ai/dsh-headless/README.md`，首句“run a single task from the command line and get the final answer printed … no GUI, no server, no browser … opens no ports and leaves nothing running”）。

argv 模板（`--profile headless` 与位置式 `headless` 等价，顶层 `--help` 示例亦用 `dsh headless "run the tests"`，已实测 `dsh headless --help` 与 `dsh --profile headless --help` 输出一致）：

```sh
dsh --profile headless [--json] [--session-id <id>] [<task words...>]
dsh headless [--json] [--session-id <id>] [<task words...>]   # 等价简写
printf '%s' "<task>" | dsh --profile headless [--json] [--session-id <id>]
dsh --profile headless [--json] [--session-id <id>] - < /path/to/prompt.txt
dsh --profile headless --patch ./overlay.yml "<task>"        # 启动器层 overlay（见 §4.5）
```

语义（依据 `dsh-headless/README.md` §Running a one-shot task 与 `lib/startup.js` 解析逻辑）：

- 多个 task 词按空格连接后作为一个任务；任务原文使用（不做 shell 外的二次解释，Weaver 传参时建议用 argv 数组逐词传递或经 stdin 传递，避免 shell 拼接）。
- task 省略或为单个 `-` 时从 stdin 读取并原文发送（含末尾换行）；`定位参数与 stdin 不同时读取`（给了位置参数就不读 stdin）。
- 空白位置参数、空 stdin 管道均为 usage 错误，调用前即拒绝（不消费模型调用，exit 1；`--json` 下 stdout 额外写一行 `{"type":"error","message":"..."}`，见 §6）。
- `-` 与其他 task 词混用是 usage 错误。
- 每次调用处理恰好一个任务后进程自行退出；无交互式追问。多轮同一会话用 `--session-id` 串联多次调用。
- `sdk` / `acp` profile 为 stdio 常驻服务（JSON-RPC / ACP），不是一次性执行；`web` 为浏览器 UI 服务。本任务未启动它们（见约束与 §6）。

### 4.2 工作目录

- 机制：调用目录即默认 workspace 根。依据：`node_modules/@deepseek-ai/dsh/README.md`（“The invoking directory is the default workspace root.”）与 composed 默认配置中 `sandbox-policy` 的 `workspaceRoot: process.cwd()`（`dsh --profile headless --dump-default-config` 真实输出）。
- 传入方式：**不支持** `--cwd`/`--workdir` 之类 CLI 开关（`headless --help` 仅有 `--json`/`--session-id`/`--help`；`lib/startup.js` 仅解析这三者与 task 位置参数）。Weaver 如需指定工作目录，应以**子进程 `cwd` 选项**启动 `dsh`（即 `child_process.spawn('dsh', [...], { cwd: dir })`）。
- 新 Session 记录该目录；`--session-id` 沿用时若记录目录与当前解析目录不一致会被拒绝（见 §4.7）。

### 4.3 提示词（参数 / 文件 / stdin）

- 参数：位置参数 task（多词空格连接），原文使用。
- 文件：无 `--file` 开关（不支持，依据同 §4.2：startup 仅解析上述选项）。传文件内容请由调用方读取后经 argv 或 stdin 传入，例如 `{ echo "Summarize these changes:"; git diff --stat; } | dsh --profile headless`（README 原例）。
- stdin：省略 task 或 task 为单个 `-` 时读取全部 stdin（含末尾换行）。

### 4.4 模型与推理强度

- **不支持**经 headless CLI 开关指定模型/推理强度（`--help` 无 `--model`/`--effort` 类选项；`lib/startup.js` 证实只解析 `--json`/`--session-id`/`--help`）。模型选择走 composed 配置：
  - 默认选择：`agent-default-model`（默认 composed 值见 `--dump-default-config`：`provider: deepseek-official`、`model: deepseek-flash`）。包说明：`node_modules/@deepseek-ai/dsh-agent-default-model/README.md`（`provider`/`model` 必填，`reasoningEffort` 可选；`saveSelection()` 无配置编辑器时为 no-op）。
  - 推理强度：`@deepseek-ai/dsh-llm-deepseek-api-key` 的 `reasoningEffort`（`off | low | high | max`，默认 `high`；另有 `thinking: enabled|disabled` 部署策略、`maxTokens` 等）。依据：`node_modules/@deepseek-ai/dsh-llm-deepseek/README.md` §Minimal configuration。
  - 可用模型目录（advisory catalog）：默认 `deepseek-flash`（文本+图像）与 `deepseek-v4-pro`（纯文本），上下文窗口各 1,000,000 token；显式 `models` 列表可替换默认值，未列出的模型 id 仍可透传请求但 GUI 选择要求 catalog 条目。依据同上 README。
  - Weaver 覆盖方式：`--patch <overlay.yml>` 传入 patch-list overlay，或改 `$DSH_HOME/profiles/headless/cordis.patch.yml`（profile 用户层）。endpoint 根可用 `$DEEPSEEK_BASE_URL` 覆盖官方 `https://api.deepseek.com/anthropic`（Messages 兼容网关）。
- 输出中不直接回显所用模型 id（`final` 事件仅 `{type, text}`；stderr 诊断不含模型名）。persona 前缀为 `You are a coding agent powered by the {{model}} model.`（composed `system-prompt` 行）。

### 4.5 输出格式与事件字段

默认模式：

- stdout：最终回答全文（lossless；无 assistant 消息时打印空行）。
- stderr：`dsh: reasoning:` 分节的非空 provider reasoning 增量流（连续增量同节；无 reasoning 的成功运行 stderr 为空）；失败时 `dsh: <code>: <message>`（turn 外失败）。

`--json` 模式（NDJSON，每行一个事件，stdout；stderr 仅保留 `dsh:` 诊断）：

| `type` | 关键字段 | 说明 |
|---|---|---|
| `session` | `sessionId`（本次运行采用的身份），`cwd` | 流首事件 |
| `status` | `phase`: `turn_start`/`step_start`/`step_end`/`turn_end`，`turn`，`step`（step 相关），`reason`（`turn_end`），`usage`（`step_end`，provider 上报的本 step 累积用量，complete 时才带；有重试导致不完整时省略该字段） | 过程事件 |
| `thinking` | `text` | 已提交 assistant 消息中的 reasoning 块（commit 点发射，非 per-token；重试/丢弃的尝试不出现） |
| `text` | `text` | 已提交 assistant 消息中的文本块 |
| `tool_call` | `callId`，`tool`，`input`（对象；空参数字符串投影为 `{}`；JSON 无法往返的数保留原文） | 工具调用 |
| `tool_result` | `callId`，`status`: `completed`/`error`，`result`（文本） | 工具结果（仅 append 面） |
| `final` | `text`（与默认模式相同的 lossless 最终答案，不截断） | 流尾事件（成功路径） |
| `error` | `message`（不带 commander 的 `error: ` 前缀） | 仅 runner 在 turn 外抛出的失败（含 usage 错误）；此时**无 `final` 事件**。turn 内失败仍以 `final`（常为空）结尾而无 `error` 事件，此时以 exit code 1 与 `turn_end` 的 `reason` 为失败信号 |

截断规则（`--json`）：除终端 `final` 外，所有字符串与对象键上限 8 KiB 并置 `truncated` 标记；单事件行（含换行）上限 32 KiB（超长时保留标量、丢结构化字段，极端时仅剩 `type`+`truncated`）；嵌套 64 层截断。

依据文件：`node_modules/@deepseek-ai/dsh-headless/README.md` §Machine-readable output；投影实现 `node_modules/@deepseek-ai/dsh-headless/lib/json-stream-BA-F3lfb.js`（事件构造：`session` 含 `sessionId`/`cwd`；`status` 四 phase；`tool_call` 含 `callId`/`tool`/`input`；`tool_result` 含 `callId`/`status`/`result`）；`lib/index.js`（exit 映射与 `dsh: <code>: <message>`）。

token 用量：`step_end` 的 `usage` 为唯一机器可读用量信号（形状为 provider 上报对象，本报告不枚举其内部字段，避免臆测）；默认文本模式无用量输出。

会话 id：`session` 事件的 `sessionId` 即本次身份；默认 `session-<uuid>` 新身份；`--session-id` 沿用已持久化 Session，未知 id 直接失败（见 §4.7）。

### 4.6 权限 / 审批 / 沙箱（无人值守自动批准）

- headless CLI **不支持** `--approve`/`-y`/`--dangerously-skip-permissions` 之类开关（`--help` 无此类选项）。无人值守走环境变量与配置：
  - `DSH_PERMISSION_MODE`（环境变量）：`read-only` | `workspace-write`（默认）| `danger-full-access`。依据：`node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` 第 246 行 `mode: process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`。
  - approval 策略由其派生（同文件第 262 行）：`danger-full-access` → `never`，否则 → `ask`。
  - 预设表见 `node_modules/@deepseek-ai/dsh-permission-presets/README.md`（`read-only: {sandbox: read-only, approval: ask}`、`workspace-write: {sandbox: workspace-write, approval: ask}`、`danger-full-access: {sandbox: danger-full-access, approval: never}`；`defaultPreset: workspace-write`）。
  - 语义：`ask` 将每次敏感工具动作发往已组合的 answerer，无可用 answerer 时 fail-closed（`unavailable`）；`never` 在分发前确定性拒绝（headless README 称其为 CI/无人值守的严格立场）。依据：`node_modules/@deepseek-ai/dsh-user-approval/README.md`。
  - 因此 Weaver 无人值守模板：`DSH_PERMISSION_MODE=danger-full-access dsh --profile headless ...`（沙箱全开 + 审批永不通过，即“自动拒绝需审批动作”而非“自动批准”——含义与常见 `--yolo` 相反，接入时必须按此理解；需在 workspace 内写文件用默认 `workspace-write` 即可）。
  - 同 profile 下也可用 `--patch` overlay 改 `sandbox-policy`/`approval` 配置；另有 `DSH_TOOLS_MODE`（process-wide PTC 模式 opt-in，headless patch 中 `tools.mode = process.env.DSH_TOOLS_MODE`）。
- 注意 headless patch 主动禁用 `authorization`（`disabled: true`，见 `--dump-default-config`），属“无交互 answerer”的 composition 事实；与 `ask` 策略叠加时敏感动作 fail-closed。

### 4.7 `--session-id` 约束

采用已持久化 Session；未知 id 在任务运行前失败。拒绝条件（`node_modules/@deepseek-ai/dsh-headless/README.md` §Choosing the session identity）：cwd 不一致（记录目录 vs 当前解析目录）、subagent/forked session、未记录工作目录、agent preset 非本 profile 所组合或记录损坏、所需 `sessionPersistence`/`sessionQuery` 服务缺失、同进程已有 live Agent 占用该 id。身份字符串精确匹配（含空白）。

### 4.8 退出码

（依据 `node_modules/@deepseek-ai/dsh-headless/README.md` §Exit mapping / §Help and task errors 与 `lib/index.js` 第 361–362 行 `io.exit(outcome.reason?.kind === "completed" ? 0 : 1)`，并经本机实测 usage 路径 exit 1。）

- `0`：任务完成（最终 `turn/end` completed）。`--json` 下流以 `final` 结尾。
- `1`：其余一切——aborted/errored、owned 区间内无 turn、usage 错误（空白任务/空 stdin/`-` 混用/空 `--session-id`/未知 `--session-id`/未知选项等）、boot 失败（未知 profile，如 `dsh doctor` 见 §6）、direct driver 失败（Agent 创建失败等）。
- `dsh --help` / `<profile> --help` / `--dump-*` 成功时 exit 0（实
测）。

### 4.9 配置与凭据位置（仅名称与位置，无任何值）

- 家目录根：`$DSH_HOME`，默认 `~/.dsh`（空/空白视为未设置）。依据：`node_modules/@deepseek-ai/dsh-home-paths/README.md`。本机 `DSH_HOME` 未设置，实际为 `/home/mocha/.dsh`。
- 本机实际布局（`ls ~/.dsh`）：`profiles/`（已 auto-initialize：`headless`、`sdk`、`web`）、`storages/`；`~/.dsh/.env` 不存在、`~/.dsh/sessions/` 不存在（headless 为 one-shot，会话经 projection cache/checkpoint 持久化，`session-persistence-jsonl.root = dshHomePath('sessions')` 按需创建）。
- profile 目录：`$DSH_HOME/profiles/<name>/`，含 `package.json`（`dsh.profile.bundles` 顺序）、`cordis.patch.yml`（用户层，本机 headless 为空数组 `[]`）、`cordis.yml`（空入口）。组成顺序：各 bundle patch → profile `cordis.patch.yml` → home 级 `$DSH_HOME/cordis.patch.yml` → `--patch` overlays。依据：`node_modules/@deepseek-ai/dsh/README.md` §Profiles。
- 只读检查命令（不 boot、不碰凭据）：`dsh --profile <name> --dump-config` / `--dump-default-config` / `--dump-config-schema`（本报告 §6 用其作只读探测，exit 0）。
- 凭据解析层（trust 顺序从高到低，依据 `node_modules/@deepseek-ai/dsh-launch-environment/README.md` 与 `node_modules/@deepseek-ai/dsh-headless/README.md` §Credentials）：继承的进程环境 → `<调用 cwd>/.env` → `$DSH_HOME/.env`。注意：导出的**空值会遮蔽** `.env` fallback（如需 fallback 必须 unset）；启动后才 export 的变量对本次运行不可见（快照在启动时冻结）。
- 变量名（仅名称）：`DEEPSEEK_API_KEY`（`deepseek-official` 路由的 `apiKeyEnv`；web-search/fetch 的 DeepSeek 侧亦用它）、`DEEPSEEK_BASE_URL`（网关覆盖，默认 `https://api.deepseek.com/anthropic`）。headless 默认禁用托管凭据库及 `authorization`/`deepseek-account` 消费者，GUI 保存的登录被忽略；恢复存储认证需在 `$DSH_HOME/profiles/headless/cordis.patch.yml` 或 `--patch` overlay 加三行（`credentials`/`authorization`/`deepseek-account` 设 `disabled: false`），默认不建议。
- 本报告未读取、未打印任何密钥值；`~/.dsh/.env` 与调用目录 `.env` 经 `ls` 确认均不存在。

### 4.10 只读健康检查命令

**不支持** `doctor` / `status` / `models list` 之类命令。依据：顶层 `--help` 无此类子命令；`dsh` 把首个非 launcher 参数一律当作 profile 名，实测 `dsh doctor` 返回 `Error: dsh: profile "doctor" does not exist; ...`（exit 1，见 §6）。等价的只读探测手段：

```sh
dsh --version                                    # exit 0
dsh --profile headless --help                    # exit 0，不运行任务
dsh --profile headless --dump-default-config     # exit 0，不 boot 插件
dsh --profile headless --dump-config             # exit 0，含用户层
dsh --profile headless --dump-config-schema      # exit 0，JSON Schema
```

模型发现走 SDK/ACP 的 `ctx.llm.listModels('deepseek-official')`（库调用），无 CLI 等价物（不支持经 CLI 列模型）。

### 4.11 限流 / 额度耗尽的错误文本特征（源码可见）

传输层 `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/*.js` 的分类（Messages 路由）：

- HTTP `402` 或 quota-exceeded detail → code `QUOTA`；HTTP `429` 或 `type: rate_limit_error` → code `RATE_LIMIT`；`401`/`403` → `AUTH`；`>=500` → `SERVER`；context 窗口超限 → `CONTEXT_WINDOW_EXCEEDED`。
- Files API：`401`/`403` → `AUTH`，`429` → `RATE_LIMIT`，`>=500` → `SERVER`，存储/配额类 detail 匹配 `/(quota|storage|stored files|file count|too many files)/i`。
- 文本特征：turn 外失败 stderr 为 `dsh: <code>: <message>`（如 `dsh: RATE_LIMIT: ...`、`dsh: QUOTA: ...`）；turn 内失败走 `final`（常为空）+ `turn_end` 的 `reason`，exit 1。以上为代码分支结论，未做真实付费调用触发验证（无凭据，见 §5）。

## 5. 最小真实模型调用是否需要凭据：是，需要

- 本机 `env | grep -i DEEPSEEK` 无输出；`~/.dsh/.env` 不存在；调用目录无 `.env`。即三层（进程环境 / cwd `.env` / `$DSH_HOME/.env`）均无 `DEEPSEEK_API_KEY`。
- composed 默认路由 `deepseek-official` 只解析其配置的 API-key 引用（`apiKeyEnv: DEEPSEEK_API_KEY`），不 fallback 到 account 路由；且 headless 默认禁用 `deepseek-account`/stored credentials（`--dump-default-config` 中 `deepseek-account` / `credentials` / `authorization` 均为 `disabled: true`）。因此最小真实模型调用**必须**提供 `DEEPSEEK_API_KEY`，否则请求无法认证（预期为 `AUTH` 类失败，exit 1）。未尝试获取、伪造或使用任何密钥，未发起任何模型调用。
- 用户自行配置（三选一，按 trust 从高到低；仅写方式，不含值）：
  1. `export DEEPSEEK_API_KEY='...'` 后在同一 shell 启动 `dsh`（CI/容器用 `-e` 传入亦可）；
  2. 在调用目录写 `.env` 文件含 `DEEPSEEK_API_KEY=...` 行；
  3. 在 `$DSH_HOME/.env`（默认 `~/.dsh/.env`）写 `DEEPSEEK_API_KEY=...` 行。
  注意空值遮蔽规则：已 export 为空时必须先 `unset DEEPSEEK_API_KEY` 才能让 `.env` 生效。如用自建网关，另设 `DEEPSEEK_BASE_URL`。

## 6. 不需凭据的真实只读探测（命令与原始输出）

均未触发模型调用，未启动 `dsh web` 等长驻服务（故未使用 `systemd-run` 包裹；结束时无残留 unit，`systemctl --user list-units` 中无 `dev-weaver-deepseek-harness`）。

### 6.1 `dsh --version`（exit 0）

```text
0.2.1-rc.2
```

### 6.2 `dsh --profile headless --help`（exit 0）

输出见 §3.2 全文（与 `dsh headless --help` 一致）。

### 6.3 空任务拒绝（usage 错误，exit 1；证明 runner 在无凭据下仍先做参数校验）

```sh
printf '' | dsh --profile headless
# stdout: （空）
# stderr: dsh: a task is required, for example: dsh --profile headless "run the tests"
# exit: 1
printf '' | dsh --profile headless --json
# stdout: {"type":"error","message":"a task is required, for example: dsh --profile headless \"run the tests\""}
# stderr: dsh: a task is required, for example: dsh --profile headless "run the tests"
# exit: 1
```

### 6.4 不存在的“健康检查”命令（证明无 doctor/models 子命令，exit 1）

```sh
$ dsh doctor
Error: dsh: profile "doctor" does not exist; create it with 'dsh plugin --profile doctor add <package>'
# （后跟 Node 堆栈，exit 1）
```

`status`、`models`、`models list` 同理会被当作 profile 名，同等失败（仅实测 `doctor` 与一个虚构名 `boguscmd`，行为一致）。

### 6.5 `dsh --profile headless --dump-default-config`（exit 0，共 382 行，摘录关键行）

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-flash
# ...
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.cwd()
# ...
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: !!js >-
      (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') ===
      'danger-full-access' ? 'never' : 'ask'
# ...
- id: web-search-deepseek
  name: '@deepseek-ai/dsh-web-search-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
- id: web-deepseek-api
  name: '@deepseek-ai/dsh-web-deepseek-api'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
# ...
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
# ...
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
  disabled: true
```

`--dump-config-schema` 亦 exit 0（输出为 JSON Schema，首行为 `{"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Cordis configuration for profile headless", ...}`，全文较长未在此转录）。

## 7. Weaver 接入建议（基于以上事实）

- 首选 argv：`dsh --profile headless --json --session-id <id> <task>`（stdin 备选），stdout 按行解析 NDJSON（`session` 取 `sessionId`/`cwd`，`text`/`thinking` 增量展示，`tool_call`/`tool_result` 结构化记录，`final` 为结果，`error` 或缺 `final` + exit 1 为失败，`turn_end.reason` 为失败原因）。
- 子进程 `cwd` 即工作区；`DSH_PERMISSION_MODE` 默认 `workspace-write`，无人值守且需“遇审批即拒”时设 `danger-full-access`（注意语义与 `--yolo` 相反）。
- 模型/强度无 CLI 开关，需 `--patch` overlay 或 profile 配置固化；凭据经 `DEEPSEEK_API_KEY`（环境或两处 `.env`）由部署方注入，Weaver 不得落盘用户密钥。
- 健康检查：`dsh --version` + `dsh --profile headless --dump-default-config`（均无需凭据）；无 `doctor`/`models list` 可用。
