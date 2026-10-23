# Root 任务进度：上报与概览

Root owner 把进度**推**上来，Master、Bot 与用户从同一份全局概览**读**出来。进度写入走 `tasks report`，聚合读取走 `tasks overview`；向运行中 owner 追加目标走 `tasks followup`（见 Skill 与 Master guideline），两者通道分离，不要复用 `describe` 冒充送达。

版本能力（先按实际 CLI 能力检测，再决定是否可用）：旧 `0.7.4` 基线既没有 `tasks followup`，也没有 `tasks report`/`tasks overview`；正式 `0.7.6` 与 `0.7.5` 提供正式 `tasks followup`（输入 `taskId` + `message` 去首尾空白后 1–8000 字符 + 可选 `source` 去首尾空白后 1–40 字符，缺省 `cli`；授权模型与 `tasks start` 一致，不带 `--owner-file` 走本机可信路径，带凭据则必须属于该任务 owner）；`tasks report`/`tasks overview` 从正式 `0.7.6` 提供，已安装 `0.7.5` standalone 的 `--help` 目录与 capabilities 尚未列出它们，旧实例上不要用 `tasks list` 子任务拼凑根进展。`delivered:true` 只表示 Herdr 接受了追加消息（`herdr agent prompt` 已投递），不表示 owner 已处理、不表示新报告已生成：绝不把 `delivered` 当新 `ownerReport` 读。

相关实现：`src/shared/contracts/tasks.ts`（`OwnerReport`、`RootTaskOverview`、`TaskOverview`）、`src/main/application/tasks/owner-report.ts`（`buildTaskOverview`）、`src/main/application/tasks/queries.ts`（`overview`）、`src/main/im/task-status.ts`（Bot 状态文本）、`tests/main/im-task-status.test.ts`；`tasks followup` 见 `src/cli/catalog.ts`（`tasks.followup` 输入契约与 help）、`src/main/application/owners/lifecycle.ts`（`followup` 校验与事件）、`src/main/owner-host.ts`（`verifyOwnerHost`/`deliverOwnerFollowup` 只读核验后单 argv 投递）。

## Schema

```ts
interface OwnerReport {
  summary: string;            // 1–2000，必填：最新一句话进展
  percent: number | null;     // 有限数 0–100；省略（null）则不改 root 进度
  phase: string | null;       // 1–120；省略则不显示阶段
  blockers: string[];         // 0–10 项，每项 ≤500
  nextSteps: string[];        // 0–10 项，每项 ≤500
  reportedAt: string;         // ISO 时间，服务端写入
}
interface RootTaskOverview {
  id: string; title: string; ownerId: string | null;
  status: TaskStatus; progress: number;
  ownerReport: OwnerReport | null;      // 从未上报或旧任务为 null
  reportAgeSeconds: number | null;      // 未上报为 null
  reportStale: boolean;                 // 未上报恒为 false
  childCounts: { total: number; queued: number; running: number;
    cancelling: number; completed: number; failed: number; cancelled: number };
  lastError: string | null;             // failure.message 优先，否则最新 error 事件
}
interface TaskOverview { generatedAt: string; staleAfterSeconds: number; roots: RootTaskOverview[] }
```

`tasks get --view full` 返回同一个 `ownerReport`；未上报的旧任务为 `ownerReport:null`，`tasks get --view brief` 的键集合保持不变。`ownerReport` 是 additive 的可选 JSON 字段，旧版逻辑不依赖它；恢复旧版前仍应先停止写入并备份（见下）。

示例（`tasks overview` 返回，节选一个 root）：

```json
{
  "generatedAt": "2026-10-23T08:15:00.000Z",
  "staleAfterSeconds": 900,
  "roots": [
    {
      "id": "3f2a…",
      "title": "修复登录 flake",
      "ownerId": "9c1d…",
      "status": "running",
      "progress": 42,
      "ownerReport": {
        "summary": "已复现并定位到竞态，补丁验证中",
        "percent": 42,
        "phase": "验证",
        "blockers": ["等待 code review"],
        "nextSteps": ["合入补丁"],
        "reportedAt": "2026-10-23T08:12:00.000Z"
      },
      "reportAgeSeconds": 180,
      "reportStale": false,
      "childCounts": { "total": 3, "queued": 1, "running": 1, "cancelling": 0, "completed": 1, "failed": 0, "cancelled": 0 },
      "lastError": null
    }
  ]
}
```

## CLI

字段与用法以本机可执行文件为准（`weaver tasks report --help --output json`、`weaver tasks overview --help --output json`、`weaver tasks get --help --output json`）：

```sh
# 上报：只有该任务的 owner 凭证，且目标是运行中的 owner root（无 parent）
weaver --data-dir <instance> --owner-file <credentialPath> tasks report --task-id <root> --input - --command-id report-0731-01 <<'JSON'
{"summary":"已复现并定位到竞态，补丁验证中","percent":42,"phase":"验证","blockers":["等待 code review"],"nextSteps":["合入补丁"]}
JSON

# 概览：全部运行中 owner root，无子任务详情
weaver --data-dir <instance> --owner-file <credentialPath> tasks overview --output json
# 只要某 owner 的：--input '{"ownerId":"<UUID>"}'；改过期阈值：--input '{"staleAfterSeconds":600}'

# 单任务：full 含 ownerReport；brief 保持原键集合
weaver --data-dir <instance> --owner-file <credentialPath> tasks get --task-id <root> --view full --output json
weaver --data-dir <instance> --owner-file <credentialPath> tasks get --task-id <root> --view brief --output json
```

`tasks report` 每次成功上报更新最新报告与 revision 并追加一条 progress 事件；`--command-id` 稳定、幂等——不确定的回复先查 `weaver operations get --command-id <id>`，绝不换新 ID 重发。`--input` 支持文件与 stdin（`--input -` 配 quoted heredoc），含中文、换行与引号时不要拼接 shell。`expectedRevision` 可选，用于并发保护。

## 上报时机（owner）与回答规则（Master）

- Owner 上报：`describe`/split 之后、每次 dispatch/review 轮次、遇到阻塞或失败时立即、`complete` 之前。`summary` 简洁、可核查、不含凭据与敏感路径；`percent`/`phase` 没有就不写，不从子任务拼凑百分比。
- Master 回答：进度问题一律先读 `tasks overview`，先讲阻塞与新鲜度；只在用户明确追问某个任务时，才用 `tasks list --input '{"parentTaskId":"<root>"}'` 看子任务，再按需 `tasks get`/`events`/`health` 读一个子任务。用户明确追加目标时，按实际 CLI 能力检测走正式 `tasks followup`（先读 `tasks followup --help` 确认输入契约，再用稳定 `--command-id` 投递；`delivered:true` 只表示 Herdr 已接受追加消息，不当新报告读，仍等 owner 的下一轮 `tasks report` 更新概览）；绝不绕过它直接 Herdr 注入、绝不向忙 owner 终端发消息，也绝不把直接注入等同于正式 `followup`；`tasks describe` 在首个子任务创建后锁定——不要把 `describe` 包装成需求送达，不要 cancel/rebuild 来“补送” follow-up。Agent 不得直接执行 Herdr 注入或终端写入。

## Staleness 语义

`reportStale` 只描述报告的新鲜度，不描述任务的健康度：

- `reportStale = floor(上报年龄秒数) >= staleAfterSeconds`（默认 900 秒，可按调用覆盖 0–86400）；
- 未上报的 root：`reportAgeSeconds:null`、`reportStale:false`，显示“尚未上报”而不是“已过期”；
- stale 的正确反应是等 owner 的下一轮 `tasks report`（或用户去问 owner），不是重试、取消或宣布失败。这句话只描述进度新鲜度，不限制用户明确追加目标：追加目标走正式 `tasks followup`（能力具备时）即时送达，不要把它说成“只能等下一轮上报”。

## Push 优先：上报 push，追加目标走正式 followup，结构化 pull 仍是设计

Phase1 保持 push 优先。Owner 在自己的执行上下文里决定上报什么、何时上报；任何拉取式追问（定时 ping 运行中的 owner、向忙终端注入消息）都会打断执行并跨越 Herdr 会话边界。进度上报通道之外没有轮询式进度拉取：`tasks update` 只改未启动的草稿，`describe` 只改标题与验收标准——它们都不是送达路径，也都不是进度拉取。

已实现的正式送达是 `tasks followup`，不是直接 Herdr 注入：服务先只读核验运行中根任务的 Herdr 宿主（pane 仍存在、`workspace_id` 一致、记录有 `tabId`/`terminalId` 时一致、宿主 engine kind 为 `claude`/`codex`），再以单个 argv 执行 `herdr agent prompt` 投递固定 `【追加目标】` 模板；成功同步返回 `{taskId, delivered:true, deliveredAt, ownerHost:{session,paneId}}`，同 `--command-id` 重放原收据且不重复投递；失败为 `INVALID_STATE`（非根/未运行/已结束/无宿主）、`OWNER_HOST_UNAVAILABLE`（pane 缺失或身份不一致，未投递）或 `OWNER_FOLLOWUP_FAILED`（Herdr 投递失败），失败只记不含原文的 error 事件。`delivered:true` 只表示 Herdr 接受了追加消息，不表示 owner 已处理、更不表示新报告已生成；收到 `delivered:true` 后仍等 owner 的下一轮 `tasks report`，绝不把 `delivered` 读成新 `ownerReport`，绝不绕过服务直接注入 Herdr 或向忙终端写消息。

尚未实现的是带关联 ID、超时与回应状态的结构化 pull 进度请求，仍只是设计（DESIGN ONLY，未实现、不做原型、不写代码、不添加 pull 产品）：一个经认证的持久请求 inbox。鉴权角色固定为：只有该 root 的 owner 凭证可以轮询、领取和回执请求；Master/用户只能创建请求并读取状态，不能冒充 owner 领取。owner 在自己的节奏里轮询，请求状态为 `pending → claimed → completed|failed|expired`；每条请求带 bounded deadline（过期自动转为 `expired` 并丢弃，不堆积），重试以 `requestId`/`--command-id` 幂等（重放返回同一收据，不重复执行），失败走与现有 mutation 相同的 `operations get` 对账。在它落地之前，进度更新等待 owner 的下一轮 `tasks report`；用户明确追加目标走现有的正式 `tasks followup` 即时送达（先按实际 CLI 能力检测 `tasks followup --help`）。

## Bot 状态文本

飞书 Bot 的 `status` 菜单通过 `taskStatus` 回调显示同一份概览（`src/main/im/task-status.ts`，`src/main/runtime.ts` 接线）：每次调用都重建当前已提交概览，不缓存，所以第二轮上报与新变 stale 立即可见。格式规则：每个运行中 root 一块——标题、owner、上报进度（有才显示）/阶段（有才显示）、最新摘要、阻塞（最多 3 条，超了记总数）、上报时间/年龄/新鲜度、直接子任务状态计数；未上报显示“尚未上报”、root 进度、最近错误与计数，不编造上报百分比；无运行中 root 时只用一句中文说明没有运行中的根任务，不向 Bot 用户展示 `tasks.create`/`tasks.start` 等实现命令。上报时间按 `Asia/Shanghai` 显示为 `MM-DD HH:mm`，年龄用分钟/小时近似；时间不可解析时显示未知，不冒充新鲜。文本做 secret 脱敏、控制字符折叠和**逐字段**截断，不做整体长度截断：正常的 12 或 20 个运行 root 必须全部出现标题、摘要、阻塞和新鲜度，不能静默隐藏后面的任务；若平台实际拒绝超长文本，应在 Bot transport 层用有证据的既有分片能力解决，不能在这里重新加整体截断。无子任务详情、无渲染器变更。行为锁定在 `tests/main/im-task-status.test.ts`（多 root/owner、12/20 个长字段 root 全量出现、新鲜/stale/未上报/lastError/计数、省略 percent/phase、清洗/脱敏/逐字段截断、每次重建）。

## 部署：构建、安装、重启、回滚（唯一完整运维流程）

本节是唯一完整部署流程，README 只链接到这里，不再重复长命令串。原功能验收阶段以本地 `npm run build` 作为开发验收，未构建/安装 standalone 发布产物、未部署、未停服/重启共享服务、未覆盖已安装的二进制或技能、未修改生产数据库、未读取生产凭据；发布升级单独由用户授权执行。本节不代表发布升级已完成。以下命令均由用户在维护窗口内手动执行；构建/打包与用户控制的生产操作分开列出。生产数据默认保留；一次性验证资源只清理本任务自有的临时目录。

控制面命令绑定同一个明确实例，不混用默认/生产实例。每组代码块定义或清楚沿用同一组变量：`capabilities`、`tasks overview`/`get`/`list` 和各控制面 `--help` 显式带同一 `--data-dir`；需要 owner 授权的命令同时使用该实例的 `--owner-file`（如 `tasks report` 与凭据验读 `tasks get`）。`server start`/`stop`/`status` 是本地服务管理，只带 `--data-dir`，不接受 `--owner-file`。`skills install` 只安装本地嵌入资源，不接受这两个参数，不连接控制面，也不会连接默认实例；隔离验证使用 `--dir <合成技能目录>`。

```sh
INSTANCE="$HOME/.local/share/weaver"   # 本节唯一实例；全节沿用，禁止裸 weaver 连默认实例
CRED="$INSTANCE/owner-credentials/<ownerId>.json"  # report 所用 owner 凭证（0600 私有文件，只作参数，不打印内容）
```

### 用户手动顺序：构建校验 → 备份 → 停服务 → 安装启动 → 技能 → 验读；回滚见末尾

先确认维护窗口，并记录当前版本。以下要求已安装 regular standalone `weaver`；技能可原本不存在，仍执行备份和回滚以准确恢复不存在。规范 symlink 的真实目标必须是 HOME 内本用户目录，否则在停服前拒绝。本 Bash 流程使用 GNU coreutils，全部步骤在同一 Bash 会话运行，保留 `metadata_seal` 等变量；退出会话后不要猜测变量继续回滚。

**0. 构建、打包与校验产物（开发验收，不是部署）**

```sh
node --version                                  # 需要 >= 22.13
npm ci
npm run typecheck
npm test
npm run build                                   # 开发验收：tsc + renderer + dist/cli/main.mjs

# 安装所需的发布产物（需要 Bun；原功能验收阶段未执行）：
node scripts/build-standalone.mjs               # 本机目标 -> dist/release/ + SHA256SUMS
# node scripts/build-standalone.mjs --all       # 全部发布目标
( cd dist/release && sha256sum -c SHA256SUMS )  # 安装前校验每个产物
```

`npm run build` 是开发验收，不是部署；`build-standalone.mjs` 才生成可安装的单文件产物。`install.sh` 会再次按 `SHA256SUMS` 校验，不校验通过不会替换任何文件。

**1. 先备份现有二进制、技能与校验值（停服/安装前失败关闭）**

二进制采用 fail-closed 的仅常规 standalone 流程：遇到 symlink（含 npm-link）即停下，不进入停服/安装。规范技能可能是 `--link` symlink：单独 `cp -a` symlink 只备份指针、源目标后来的变化会污染备份，不可接受；必须同时独立保存旧内容快照与原链接 metadata。

<!-- closeout-deployment:backup-tested 下一 fenced sh 块为被测备份块，fixture 原样抽取执行 -->

```sh
set -euo pipefail
INSTANCE="$HOME/.local/share/weaver"
stamp="$(date +%Y%m%d-%H%M%S)"
backup="$(mktemp -d "$HOME/weaver-rollback-$stamp.XXXXXX")"
mkdir -p "$backup/skills"

binary="$(command -v weaver)"
[ -n "$binary" ] || { echo "未找到已安装的 weaver" >&2; exit 1; }
if [ -L "$binary" ]; then
  echo "二进制是 symlink ($(readlink "$binary"))：本流程 fail-closed，仅支持常规 standalone 文件；停在此处，不停服、不安装" >&2
  exit 1
fi
[ -f "$binary" ] && [ "$(stat -c %h -- "$binary")" = 1 ] || { echo "二进制不是常规文件，停止" >&2; exit 1; }
[ "$binary" = "$HOME/.local/bin/weaver" ] || { echo "本流程只支持 HOME/.local/bin/weaver，停服前拒绝其他路径" >&2; exit 1; }
cp -a -- "$binary" "$backup/weaver"
"$backup/weaver" --version > "$backup/weaver.version"
cmp -s -- "$binary" "$backup/weaver" || { echo "二进制备份校验失败" >&2; exit 1; }
# 该文件记录不可变备份自身（$backup/weaver）的哈希，不是旧 live 绝对路径：
# 升级后回滚前执行 sha256sum -c 仍能通过；live 是否恢复在回滚后另行校验。
sha256sum -- "$backup/weaver" > "$backup/weaver.sha256"
sha256sum -c "$backup/weaver.sha256"

skill="$HOME/.agents/skills/agents-weaver"
: > "$backup/skills/links.txt"
if [ -e "$skill" ] || [ -L "$skill" ]; then
  if [ -L "$skill" ]; then
    target_path="$(realpath -e -- "$skill")"
    case "$target_path" in "$HOME"/*) ;; *) echo "规范目标必须在 HOME 内" >&2; exit 1;; esac
    case "$skill/" in "$target_path/"*) echo "规范目标不能是技能路径祖先" >&2; exit 1;; esac
    [ -d "$target_path" ] && [ ! -L "$target_path" ] && [ "$(stat -c %u -- "$target_path")" = "$(id -u)" ] || exit 1
    # symlink：链接文本与旧内容快照分开保存；快照用 -L 解引用复制，源目标后来的变化不污染备份
    printf '%s -> %s\n' "$skill" "$(readlink "$skill")" >> "$backup/skills/links.txt"
    mkdir -p "$backup/skills/canonical-content"
    cp -aL -- "$skill/." "$backup/skills/canonical-content/"
    ( cd "$backup/skills/canonical-content" && find . -type f -exec sha256sum {} + | sort -k2 ) > "$backup/skills/agents-weaver-original.sha256"
    ( cd "$skill" && find . -type f -exec sha256sum {} + | sort -k2 ) > "$backup/skills/agents-weaver-live.sha256"
    diff -u "$backup/skills/agents-weaver-original.sha256" "$backup/skills/agents-weaver-live.sha256"
  else
    # 常规目录：整体复制 + 内容校验
    cp -a -- "$skill" "$backup/skills/agents-weaver"
    ( cd "$skill" && find . -type f -exec sha256sum {} + | sort -k2 ) > "$backup/skills/agents-weaver-original.sha256"
    ( cd "$backup/skills/agents-weaver" && find . -type f -exec sha256sum {} + | sort -k2 ) > "$backup/skills/agents-weaver-backup.sha256"
    diff -u "$backup/skills/agents-weaver-original.sha256" "$backup/skills/agents-weaver-backup.sha256"
  fi
fi
for src in "$HOME/.claude/skills/agents-weaver" "$HOME/.codex/skills/agents-weaver"; do
  if [ -e "$src" ] || [ -L "$src" ]; then
    if [ -L "$src" ]; then printf '%s -> %s\n' "$src" "$(readlink "$src")" >> "$backup/skills/links.txt"; fi
    mkdir -p "$backup/skills/agent-links"
    # key 取祖父目录名区分两条 agent 链接：.claude-agents-weaver 与 .codex-agents-weaver；
    # 只用直接父目录名（skills）会导致两条路径生成同一个 skills-agents-weaver 而互相覆盖。
    key="$(basename "$(dirname "$(dirname "$src")")")-$(basename "$src")"
    cp -a -- "$src" "$backup/skills/agent-links/$key"
  fi
done
# 回滚漂移核对：记录备份时刻的二进制路径与本次允许的技能路径集合
printf '%s\n' "$binary" > "$backup/binary.path"
printf '%s\n' "$skill" "$HOME/.claude/skills/agents-weaver" "$HOME/.codex/skills/agents-weaver" > "$backup/skills/allowed-skill-paths.txt"
# 只接受本用户独占的真实目录目标；记录解析后的精确路径和 inode，拒绝 HOME 外、祖先和路径别名。
: > "$backup/skills/target.path"
: > "$backup/skills/target.identity"
if [ -L "$skill" ]; then
  target_path="$(realpath -e -- "$skill")"
  case "$target_path" in "$HOME"/*) ;; *) echo "规范目标必须在 HOME 内" >&2; exit 1;; esac
  case "$skill/" in "$target_path/"*) echo "规范目标不能是技能路径祖先" >&2; exit 1;; esac
  [ -d "$target_path" ] && [ ! -L "$target_path" ] && [ "$(stat -c %u -- "$target_path")" = "$(id -u)" ] || exit 1
  printf '%s\n' "$target_path" > "$backup/skills/target.path"
  stat -c '%d:%i:%u' -- "$target_path" > "$backup/skills/target.identity"
fi
: > "$backup/skills/parents.txt"
for parent in "$HOME/.local/bin" "$HOME/.agents/skills" "$HOME/.claude/skills" "$HOME/.codex/skills"; do
  # 不创建原本不存在的路径；-m 记录缺失路径的解析结果，回滚时必须仍相同。
  printf '%s\n' "$(realpath -m -- "$parent")" >> "$backup/skills/parents.txt"
done
# 同一维护窗口内保存元数据 seal；后续不得重算它来接受篡改。
( cd "$backup" && sha256sum binary.path skills/allowed-skill-paths.txt skills/links.txt skills/target.path skills/target.identity skills/parents.txt ) > "$backup/metadata.sha256"
metadata_seal="$(sha256sum "$backup/metadata.sha256" | cut -d' ' -f1)"
cat "$backup/skills/links.txt"
```

备份目录和校验文件只是本地路径，不是凭据；不要把它们或任何 token 写进聊天、日志或提交。确认 `$backup/weaver.version` 是预期旧版本、链接文本与内容校验均通过后再继续。

**2. 在维护窗口内只停服务，保留运行中的 worker**

```sh
INSTANCE="$HOME/.local/share/weaver"
weaver --data-dir "$INSTANCE" server status
weaver --data-dir "$INSTANCE" server stop                 # 默认：运行中的 worker 保留，重启后自动 reattach
```

**worker 默认不取消；不默认加 `--cancel-workers`/`--force`**：它们会取消 Gateway、Market 或任何其他运行中的任务。只有用户另行明确授权取消哪些任务时才可使用；本流程不把取消任务当作升级或回滚步骤。停服前停止创建新任务，等待 `weaver --data-dir "$INSTANCE" server status` 显示服务已停止。

**3. 安装新二进制并启动（同一实例）**

```sh
INSTANCE="$HOME/.local/share/weaver"
./install.sh --dist-dir dist/release --bin-dir "$(dirname "$binary")"
"$HOME/.local/bin/weaver" --version
weaver --data-dir "$INSTANCE" server start
weaver --data-dir "$INSTANCE" server status
```

`install.sh` 默认只替换 Weaver 自己的可执行文件，不会触碰 `~/.local/share/weaver` 状态；`--force` 只用于显式替换非 Weaver 冲突文件，不应作为默认参数。原功能验收阶段未执行这一步；发布升级单独由用户授权执行。

**4. 更新本地嵌入技能（不连接控制面）**

```sh
weaver skills install --agent claude-code,codex
head -n 40 "$HOME/.agents/skills/agents-weaver/SKILL.md"
cat "$HOME/.agents/skills/agents-weaver/.weaver-skill.json"
readlink "$HOME/.claude/skills/agents-weaver" "$HOME/.codex/skills/agents-weaver"
```

从源码 checkout 开发时也可用 `weaver skills install --link`，让规范路径指向当前 `skills/agents-weaver`；发布环境应使用与二进制同版本的复制安装。安装器只更新带 Weaver marker 的副本，遇到其他来源的同名技能默认拒绝，确认无冲突后再决定是否 `--force`；原功能验收阶段未安装技能，发布升级单独由用户授权执行。可用 `weaver skills install --dir <合成技能目录> --output json` 验证本地安装，不触碰 HOME 技能。

**5. 验读命令目录和 report/overview/followup 帮助（同一实例；report 额外带 owner 凭证）**

```sh
INSTANCE="$HOME/.local/share/weaver"
CRED="$INSTANCE/owner-credentials/<ownerId>.json"
weaver --data-dir "$INSTANCE" tasks overview --help --output json
weaver --data-dir "$INSTANCE" --owner-file "$CRED" tasks report --help --output json
weaver --data-dir "$INSTANCE" tasks followup --help --output json
weaver --data-dir "$INSTANCE" tasks get --help --output json
weaver --data-dir "$INSTANCE" capabilities --output json
weaver --data-dir "$INSTANCE" tasks overview --output json
weaver --data-dir "$INSTANCE" --owner-file "$CRED" tasks get --task-id <root> --view full --output json
```

以 `tasks overview`/`tasks report`/`tasks followup` 的 help 和实际返回为准；`capabilities.commands` 也应列出 `tasks.report`/`tasks.overview`（源码 CLI 测试已覆盖）。正式 `0.7.6` 提供 `report`/`overview`；`0.7.5` 仅提供 `followup`，旧 `0.7.4` 两者均无：先按实际 help 能力检测该实例，再决定是否可用，不要用 `tasks list` 的子任务结果冒充 overview。确认服务启动后，再用真实 Bot 状态菜单检查概览文本。原功能验收阶段未部署、未做生产验读写操作；以下验读仍属于用户授权的发布升级流程。

### 回滚：核对备份与归属 → 停服务 → 恢复旧二进制与技能 → 启动（不动数据库、不动数据）

回滚只撤销二进制和技能，**不删除、不重建、不降级数据库，不清理任务数据**。本特性没有数据库 schema 迁移，也没有数据回滚步骤；`ownerReport` 是 Task JSON 中 additive 的可选字段，旧版本不读取它时，任务与历史数据仍然保留，回滚保留数据库和迁移记录原状。旧二进制可能没有 `tasks report`/`tasks overview`，回滚后这些命令不可用属预期。

回滚前先核实备份和目标归属，不修改未知路径：只允许恢复本节记录过的三个技能路径与备份记录的二进制路径；备份缺失、校验失败或目标不在允许集合内即停止。

<!-- closeout-deployment:rollback-tested 下一 fenced sh 块为被测回滚块，fixture 原样抽取执行 -->

```sh
set -euo pipefail
INSTANCE="$HOME/.local/share/weaver"
# 沿用备份步骤的同一组变量：$backup/$stamp/$binary/$skill（同一次维护窗口内执行，不要换实例、不要换备份目录）
# 0) 核实备份与目标归属；任一失败即停止，不进入停服。
#    这里只校验不可变备份本身（$backup/weaver 与技能快照），不校验已升级的 live；
#    原本无技能时备份中没有技能快照，此时恢复"不存在"而不是失败。
[ -f "$backup/weaver" ] || { echo "缺少二进制备份，停止" >&2; exit 1; }
sha256sum -c "$backup/weaver.sha256"
# 漂移核对：当前 $binary 必须与备份时刻记录一致，否则说明实例/备份错配，停止。
if [ -f "$backup/binary.path" ]; then
  [ "$(cat "$backup/binary.path")" = "$binary" ] || { echo "二进制路径与备份记录不一致（漂移），停止" >&2; exit 1; }
fi
has_skill_backup=0
if [ -f "$backup/skills/agents-weaver-original.sha256" ] || [ -d "$backup/skills/canonical-content" ] || [ -d "$backup/skills/agents-weaver" ]; then
  has_skill_backup=1
else
  echo "备份中无技能快照（原本不存在），回滚后恢复不存在"
fi
case "$binary:$skill" in
  "$HOME/.local/bin/weaver:$HOME/.agents/skills/agents-weaver") : ;;
  *) echo "目标不在允许集合内，不修改未知路径" >&2; exit 1;;
esac
# 从备份时保留的同一 shell 变量核验元数据；缺失或篡改失败关闭。
[ "$(sha256sum "$backup/metadata.sha256" | cut -d' ' -f1)" = "$metadata_seal" ] || exit 1
( cd "$backup" && sha256sum -c metadata.sha256 )
diff -u "$backup/skills/allowed-skill-paths.txt" <(printf '%s\n' "$skill" "$HOME/.claude/skills/agents-weaver" "$HOME/.codex/skills/agents-weaver")
diff -u "$backup/skills/parents.txt" <(for parent in "$HOME/.local/bin" "$HOME/.agents/skills" "$HOME/.claude/skills" "$HOME/.codex/skills"; do realpath -m -- "$parent"; done)
[ ! -L "$binary" ] && [ -f "$binary" ] && [ "$(command -v weaver)" = "$binary" ] || exit 1
if [ -s "$backup/skills/target.path" ]; then
  recorded_target="$(cat "$backup/skills/target.path")"
  [ "$(realpath -e -- "$recorded_target")" = "$recorded_target" ] && [ ! -L "$recorded_target" ] || exit 1
  [ "$(stat -c '%d:%i:%u' -- "$recorded_target")" = "$(cat "$backup/skills/target.identity")" ] || exit 1
  if [ -L "$skill" ]; then [ "$(realpath -e -- "$skill")" = "$recorded_target" ] || exit 1; fi
fi
if [ "$has_skill_backup" = 1 ]; then
  snapshot="$backup/skills/agents-weaver"
  [ ! -d "$backup/skills/canonical-content" ] || snapshot="$backup/skills/canonical-content"
  ( cd "$snapshot" && find . -type f -exec sha256sum {} + | sort -k2 ) > "$backup/skills/preflight.sha256"
  diff -u "$backup/skills/agents-weaver-original.sha256" "$backup/skills/preflight.sha256"
fi
# 停服前先做链接记录合理性检查：空记录、"/"、"$HOME" 本体一律拒绝，不进入停服。
if [ -s "$backup/skills/links.txt" ]; then
  while IFS= read -r rec; do
    case "$rec" in ""|*" -> ") echo "链接记录为空（恶意/漂移），停止" >&2; exit 1;; esac
    rectarget="${rec#* -> }"
    case "$rectarget" in ""|"/"|"$HOME") echo "链接记录目标非法（$rectarget），停止" >&2; exit 1;; esac
  done < "$backup/skills/links.txt"
fi
[ ! -e "$backup/rollback-isolation" ] && [ ! -L "$backup/rollback-isolation" ] || { echo "回滚隔离区已存在，拒绝重复恢复" >&2; exit 1; }
for live in "$skill" "$HOME/.claude/skills/agents-weaver" "$HOME/.codex/skills/agents-weaver"; do
  if [ -e "$live" ] || [ -L "$live" ]; then
    [ "$(stat -c %u -- "$live")" = "$(id -u)" ] || exit 1
  fi
done
mkdir "$backup/rollback-isolation"

# 1) 只停服务，保留 worker；不要加 --cancel-workers/--force
weaver --data-dir "$INSTANCE" server stop

# 2) 恢复旧二进制并校验（仅常规文件流程；备份时已 fail-closed 排除 symlink）。
#    $backup/weaver.sha256 记录的是备份自身哈希，恢复后用 cmp 与哈希字段比对验 live。
install -m 0755 -- "$backup/weaver" "$binary"
cmp -s -- "$binary" "$backup/weaver" || { echo "二进制恢复校验失败" >&2; exit 1; }
sha256sum -- "$binary" > "$backup/weaver.restored.sha256"
[ "$(cut -d' ' -f1 "$backup/weaver.restored.sha256")" = "$(cut -d' ' -f1 "$backup/weaver.sha256")" ] || { echo "二进制恢复后哈希不一致" >&2; exit 1; }
"$binary" --version

# 3) 恢复规范技能目录/链接与 agent 链接原状（先把当前版本移到隔离区，不删除备份也不 rm -rf 未知路径；额外新增文件随移走而隔离）
skill="$HOME/.agents/skills/agents-weaver"
if [ -e "$skill" ] || [ -L "$skill" ]; then
  if [ "$has_skill_backup" = 1 ]; then
    mv -- "$skill" "$backup/agents-weaver-current-$stamp"
  else
    mv -- "$skill" "$backup/rollback-isolation/canonical-new-$stamp"
  fi
fi
if grep -q "^$skill -> " "$backup/skills/links.txt"; then
  target="$(sed -n "s|^$skill -> ||p" "$backup/skills/links.txt" | head -n 1)"
  ln -s -- "$target" "$skill"
  [ "$(readlink "$skill")" = "$target" ] || { echo "规范链接文本恢复失败" >&2; exit 1; }
  # 只移动备份时记录并在停服前核实 inode 的真实目标，不跟随升级后的未知指针。
  tpath="$(cat "$backup/skills/target.path")"
  mv -- "$tpath" "$backup/rollback-isolation/canonical-target-current-$stamp"
  cp -a -- "$backup/skills/canonical-content" "$tpath"
  [ "$(readlink "$skill")" = "$target" ] || exit 1
elif [ -d "$backup/skills/agents-weaver" ]; then
  cp -a -- "$backup/skills/agents-weaver" "$skill"
else
  # 备份无 symlink 记录也无常规快照：原本不存在，把本次新增整目录移入隔离区后恢复不存在
  if [ -e "$skill" ] || [ -L "$skill" ]; then mv -- "$skill" "$backup/rollback-isolation/canonical-new-$stamp"; fi
fi
for src in "$HOME/.claude/skills/agents-weaver" "$HOME/.codex/skills/agents-weaver"; do
  # 与备份侧同一 key 规则：祖父目录名区分两条 agent 链接，避免 skills-agents-weaver 碰撞。
  key="$(basename "$(dirname "$(dirname "$src")")")-$(basename "$src")"
  if [ -e "$backup/skills/agent-links/$key" ] || [ -L "$backup/skills/agent-links/$key" ]; then
    if [ -e "$src" ] || [ -L "$src" ]; then mv -- "$src" "$backup/$key-current-$stamp"; fi
    cp -a -- "$backup/skills/agent-links/$key" "$src"
  else
    # 该 agent 链接原本不存在：把本次新增移入隔离区后恢复不存在，不 rm 未知路径
    if [ -e "$src" ] || [ -L "$src" ]; then mv -- "$src" "$backup/rollback-isolation/$key-new-$stamp"; fi
  fi
  if grep -q "^$src -> " "$backup/skills/links.txt"; then
    want="$(sed -n "s|^$src -> ||p" "$backup/skills/links.txt" | head -n 1)"
    [ "$(readlink "$src")" = "$want" ] || { echo "agent 链接文本恢复失败: $src" >&2; exit 1; }
  elif [ -e "$backup/skills/agent-links/$key" ] || [ -L "$backup/skills/agent-links/$key" ]; then
    : # 常规目录恢复：存在即预期，不做链接文本断言
  else
    [ ! -e "$src" ] && [ ! -L "$src" ] || { echo "agent 链接应恢复不存在但仍存在: $src" >&2; exit 1; }
  fi
done
# 内容与链接文本双重校验：内容按相对路径排序后 diff，链接按文本精确比较（上文已做）；
# 原本不存在时跳过内容 diff（live 已恢复不存在）。
if [ "$has_skill_backup" = 1 ] && { [ -e "$skill" ] || [ -L "$skill" ]; }; then
( cd "$skill" && find . -type f -exec sha256sum {} + | sort -k2 ) > "$backup/skills/agents-weaver-restored.sha256"
diff -u "$backup/skills/agents-weaver-original.sha256" "$backup/skills/agents-weaver-restored.sha256"
fi

# 4) 启动并确认旧版本读到原有任务（同一实例，只读）
weaver --data-dir "$INSTANCE" server start
weaver --data-dir "$INSTANCE" server status
"$HOME/.local/bin/weaver" --version
weaver --data-dir "$INSTANCE" tasks list --view brief --output json
```

不要在回滚时取消 Gateway/Market 或其他运行任务；如果旧二进制启动后某个新生命周期任务不可读，按事件和日志人工判断，不要清库或删除任务。不要把数据回滚写进本节。

本节备份与回滚块由 [deployment fixture](verification/root-progress-4113f179/closeout/deployment/runner.mjs) 原样提取运行。可在仓库根目录独立重跑 `DEPLOYMENT_SCRATCH="$(mktemp -d)" node docs/verification/root-progress-4113f179/closeout/deployment/runner.mjs`；只写该隔离目录，结果保存在其 evidence 子目录，结束自动回收合成 HOME；也可省略环境变量，由 runner 创建安全临时目录并输出路径。证据包含 `assertions.json`、`snippets.sha256.json`、提取的 `backup.sh` / `rollback.sh`、逐例原始日志和 `runner-output.log`。服务调用由仅记录参数的合成 binary 接收；fixture 不构建发布产物、不调用真实安装器、不启动或停止真实服务。
