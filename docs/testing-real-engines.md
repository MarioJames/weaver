# 真实引擎开发环境

此环境使用本机安装的真实 CLI 和原生订阅/API 配置，不是 Mock。真实调用可能消耗订阅或 API 额度。数据库、账号私有根和开发缓存持久保存在 `~/.local/share/weaver-real-test`，不随任务结束删除，也不放入 Git。默认页面为 <http://127.0.0.1:4738>。

## 启动、停止与重启

在项目根目录运行（使用项目已有依赖，不需要安装额外工具）：

```sh
npm run dev:real
```

脚本复用现有 `tsx watch`、CLI `web --dev --no-open` 和 Vite 开发栈，以当前源码运行；后端源码修改由 watch 重启，前端由 Vite 更新。脚本不初始化第二套配置体系，也不在每次启动时重置数据。常规 CLI 参数可覆盖默认值，例如 `npm run dev:real -- --port 4740 --data-dir /path/to/private-dev-data`。入口会拒绝生产目录及其父子路径、符号链接同根和端口 4737；其他独立目录与端口沿用 CLI。当前 CLI 只接受 `--data-dir PATH`、`--port NUMBER`，不接受 `--data-dir=PATH` 或 `--port=NUMBER`；未知、缺值和重复参数由同一 CLI 解析器报错。入口不自行建目录，创建/启动行为沿用正常 CLI。

需要跨 Agent 生命周期保留服务时，在 Herdr 持久终端中运行：

```sh
systemd-run --user --scope --collect --unit=dev-weaver-real-accounts \
  -p MemoryHigh=8G -p MemoryMax=10G -- npm run dev:real
```

检查：`systemctl --user status dev-weaver-real-accounts.scope`。停止：`systemctl --user stop dev-weaver-real-accounts.scope`。重启：先停止这个测试 scope，再在原持久终端重新执行上面的启动命令。transient scope 无法用 `systemctl restart` 重新创建；它也不是开机自启服务。停止服务保留数据。

若 4738 被占用，先用 `ss -ltnp '( sport = :4738 )'` 确认归属，复用已确认的测试服务或明确指定其他空闲端口。不要停止未知进程。生产 `weaver.service` 与 4737 不属于本测试服务。

## 账号与隔离边界

首次启动由现有 `NativeChannelImporter` 从本机原生配置导入账号；来源配置不修改，托管认证根位于测试数据目录的 `channels/`。SQLite 使用全新初始化的 `weaver.db`，不复制生产数据库、任务、运行、日程或 IM 绑定。原生 OpenCode 账号数据库由既有导入器只读备份到独立根，再在副本内选择组织；已有多组织 refresh grant 保护保持不变。

本次仅通过生产公开 policy 读取角色、模型、effort、权重等元数据，再使用测试实例既有 RPC 校验保存；未复制生产私有认证根。自动额度刷新维持项目默认值与渠道配置，环境建立包没有主动调用额度刷新或Hello；后续实际调用范围见下文分时点说明。缺少凭据时应显示 missing/待登录，不伪造账号。Pi CLI 已安装，但本次没有导入到可用 Pi 凭据。

默认数据根通过 `homedir()` 计算，启动进程 umask 为 `077`，新目录 `0700`、普通文件 `0600`。已有目录的权限仍需核实；原生CLI后续cache文件权限可能不同，应检查test/channel私有祖先为0700，不能承诺所有native子文件永久0600。认证正文、token、完整 auth、测试数据库和日志都不得回显或提交；排查只记录账号数量、引擎、可用性和私有根是否存在。

可用以下只读检查核对实例（不要打印 discovery 内的认证 token）：

```sh
systemctl --user show weaver.service dev-weaver-real-accounts.scope \
  -p Id -p ActiveState -p MainPID -p ControlGroup
ss -ltnp '( sport = :4737 or sport = :4738 )'
stat -c '%n device=%d inode=%i mode=%a' \
  ~/.local/share/weaver/weaver.db ~/.local/share/weaver-real-test/weaver.db
node --import tsx src/cli/main.ts --data-dir ~/.local/share/weaver-real-test policy get --output json
```

两实例的 `control.v1.json` 仅用于各自 data-dir 下的 IPC discovery；实际 socket 位于各自 `control-<instance-id>/ipc.sock`，认证 token 也在该私有目录。运行产物与 `agent-state/` 均由各自 data-dir 派生。默认开发缓存为测试 data-dir 下的 `vite/`。不得借用生产 IPC、数据库或认证目录。

## 本次环境验收记录

2026-10-25（Asia/Shanghai）启动并保留测试 scope，Herdr workspace/tab/pane 为 `w3B` / `w3B:tZ` / `w3B:p1J`，标题 `1025｜FIX｜真实引擎测试环境`。资源归属本真实开发环境，供后续账号修复验收和用户继续使用；不得作为一次性 scratch 清理。源代码改动由父 Agent 统一提交。

- HTTP 4738 返回 200；生产仍为 4737、`weaver.service`，生产 PID 在本次检查期间保持 `1109320`。重启后的测试 HTTP PID 为 `1123123`，位于独立 `dev-weaver-real-accounts.scope`（8 GiB MemoryHigh、10 GiB MemoryMax）。PID 会随 watch/重启改变。
- 同设备 `2050` 上生产 SQLite inode `1907011`、测试 inode `1991412`，路径不同。测试 schema `13`，只读 `PRAGMA integrity_check` 为 `ok`；tasks、owners、packages 均为 0，没有导入生产业务运行记录。测试实例按默认配置自行建立了一条“额度自动刷新”内置日程；日程 run 行为 0，未发现 IM settings key。
- 导入 6 个真实渠道：Codex、Claude、Grok、Qoder、OpenCode 订阅及 dsh API；前五个有独立托管凭据，dsh 有私有 API key。默认占位渠道不代表已认证。Claude/Codex owner 与已启用 worker 均引用真实导入渠道；Qoder worker 按原 policy 保持禁用。
- CLI 版本只读探测：Claude `2.1.310`、Codex `0.164.0`、Grok `1.0.70`、OpenCode `1.19.4`、Pi `1.4.0`、Qoder `1.1.75`、dsh `0.2.1-rc.2`。安装与导入成功不能证明推理调用成功。
- 已停止并重新创建同测试 scope：测试 DB inode、policy revision `5`、policy 深度相等、6 条私有渠道记录、16 个托管文件的聚合摘要均保持一致，无重新 seed 覆盖。重启后再次检查 schema/integrity 和整个测试数据树权限，普通文件 `0600`、目录 `0700`。

以上为环境建立时点记录，不是当前任务数量、policy revision或PID的固定承诺。后续首次真实验收（2026-10-25 04:33–04:36 UTC）已执行Hello：Codex、Claude、Qoder、dsh成功，Grok退出0未解析出回复，OpenCode120秒超时；一次正式Codex worker完成/accepted且观察到所选私有根绑定。Grok/OpenCode适配仍在纠偏与复验，这些不是最终总体结论。真实新官方OAuth、账号交互完整浏览器验收、其他引擎正式worker矩阵、Qoder BYOK、完整owner/IM/调度链路尚未证明通过。生产schema13升级及其整体产品验收未通过的历史结论见[本地升级报告](verification/account-channels/local-upgrade/REPORT.html)。最终独立HTML由后续验收交付，本说明不代替其结果。

## 可复用真实验收运行器

在项目根目录使用源码 CLI，避免全局 `weaver` 版本落后：

```sh
npm run test:real
# 可选：报告只能放在当前测试 data-dir 内的私有子目录
npm run test:real -- --report-dir ~/.local/share/weaver-real-test/real-tests/manual
```

默认只连接已运行的 `~/.local/share/weaver-real-test`，不启动服务、不迁移、seed、reset，不导入账号或刷新额度，也不解除 policy block。目标不存在或不可连接时直接失败，不回退生产。连接通过项目 `src/cli/client.ts` 的现有认证 IPC；普通检查通过 `node --import tsx src/cli/main.ts --data-dir …` 执行。源码依赖须已存在，不自动安装。

可用 `--data-dir /absolute/private-test-path` 指定另一个已有测试实例。运行器拒绝生产默认目录（含符号链接、其父子目录、同 inode 数据库）、生产端口 4737，以及不属于该 data-dir 的数据库。`serverInfo` 必须返回同一个 data-dir，运行结束再次检查 PID/启动时间；watch 重启会使本次运行失败，应在版本稳定后重新执行。拒绝不等于启动或修改该服务。

输出 JSON 含目标目录、数据库 device/inode、HTTP 地址、PID、启动时间、服务版本、源码 HEAD、工作树差异指纹、运行器指纹、policy revision 和每条源码 CLI 的退出码。源码指纹用于标识本地调用端，不能单独证明 watch 服务已载入全部改动；最终验收应先固定代码并确认服务完成重载。报告不保存原始 CLI 输出、认证正文、API key、owner token、完整模型回复或账户标签。报告文件以 `0600` 新建，只允许放在测试 data-dir 内的私有子目录（含符号链接祖先检查），禁止放进仓库；保留持久测试 DB 和任务记录。

默认实际覆盖：

- `engines scan` 探测真实 CLI 安装与版本。安装成功仅表示安装检查通过。
- `channels list` 读取渠道启用状态、配置/凭据存在性。渠道 `passed` 仅表示本地配置存在，不证明远端登录有效或推理可用。缺凭据（包括未配置的 Pi 和默认占位渠道）为 `not_configured`。
- 对每个有凭据/配置的渠道调用 `engines models`，明确传入 `channel`、`engine` 和 `refresh:true`。记录实际模型 ID、来源和获取时间；内置模型名、CLI 发现及 unsupported 的区别由现有模型 API 的 `source/status` 表达。缺凭据的渠道不借用全局配置发现模型。模型发现可能访问供应商目录或在测试私有根生成临时原生配置，但不发送推理 prompt。

只有显式参数才产生真实模型调用，可能消耗订阅/API 额度。用户当前会话已授权这些验证。运行器实现包未运行下面两项；后续首次执行结果见上文。最终纠偏后仍须由owner在源码固定、测试服务稳定后执行并取证：

```sh
# 每个凭据就绪渠道最多一次现有 sayHi；串行启动并等待终态
npm run test:real -- --inference
# 正常 policy 选一路真实 worker；不启动自主 owner 编码根任务
npm run test:real -- --dispatch --owner codex_owner
# 两者合并；单个 Hello/worker 最多等待 300 秒，可改为 1–3600 秒
npm run test:real -- --inference --dispatch --owner codex_owner --timeout-seconds 300
```

`--inference` 优先使用账号现有 worker/owner role 的 model/effort，无论目录是否列出该模型，均实际验证这条保存路由；报告记录 `source:saved_role`、role ID 和参数。目录失败或 unsupported 单独保留 failed/unavailable，Hello 成功不能覆盖目录失败。

有凭据但无 role 的账号（例如当前 dsh API）报告 `needs_selection / MODEL_AND_EFFORT_SELECTION_REQUIRED`，并非 `not_configured`。可通过同一运行器显式选择一个账号及 model/effort：

```sh
# ACCOUNT_ID 来自 channels list；MODEL_ID 来自真实目录或经核实的该账号配置
# EFFORT_VALUE 按 src/shared/policy/settings.ts 的共享规范选择，不猜模型名
npm run test:real -- --inference --channel ACCOUNT_ID --model MODEL_ID --effort EFFORT_VALUE
```

`--channel` 限定实际 Hello 的账号，模型目录仍逐个检查；其他 Hello 标为未请求的 `not_executed`。显式 model/effort 必须成对且带 channel，报告来源 `explicit_arguments`。未给显式参数且无保存 role 时不猜测、不发送 prompt。禁用渠道为`unavailable`；引擎目录默认全部可用，schema13遗留enabled字段由后端归一true，运行器保留的字段检查不构成用户引擎开关；缺凭据（包括 Pi 和空迁移占位）为 `not_configured`。Hello 复用现有 `sayHi` / `sayHiResult`，等待 `done`，要求 `result.ok === true` 且回复精确为 `hi`；提交成功或 HTTP/IPC 成功不算推理通过。Qoder BYOK、订阅/模型限制沿用真实入口的拒绝，不绕过限制。

`--dispatch` 使用当前测试 policy 中指定的 available owner profile（本轮只读 policy 核实的 ID 为 `codex_owner`、`claude_owner`，执行前仍应重读 `policy get`）；显式不存在的 ID 报 `UNKNOWN_OWNER_PROFILE`，不可用的显式 ID 报 `OWNER_PROFILE_UNAVAILABLE`，均退出 1；省略 `--owner` 时使用 policy 中首个 available owner profile，并由正常 `policy preview` / 调度选择 worker。运行器只注册自己的手动验收 owner，使用服务写入测试 data-dir 的 `0600` credential 文件；不回显 token。它创建一个最小回复任务、冻结 package、调用 `workers spawn`、等待真实 worker、读取 `tasks results`，核验后 `results ack` / `reviews submit`。不会调用 `tasks start` 启动一个自主编码 owner，也不手动上报 native/mock 成功。prompt 只要求回复 `WEAVER_REAL_OK`，禁止工具、读写文件、改环境和委派。workspace 是报告目录内独立的私有空目录。

派发通过需同时满足：任务 completed/已 finalized、真实 CLI `execution:real`、vendor terminal success、结果 exitCode 0、精确短标记、run.channel/engine/model/effort 等于实际 `workers spawn` 返回的冻结 dispatch。preview 只作参考，负载可导致实际路由不同；冻结后 owner/worker/channel/engine/model/effort/execution 不得改变。终态轮询按当前 ResultsService 条件：仅 launchPermittedAt 存在且尚未 finalizedAt 时继续等待，已终止且未获启动许可的失败直接取证；成功仍必须 finalizedAt。独立配置绑定通过测试 SQLite **只读**读取内部 run/channel 元数据，并在 Linux `/proc` 中比较实际进程的渠道认证根；API 渠道还比较隔离配置/环境中的 key，全部只比较不回显正文或摘要。缺少绑定明确报 `PROCESS_BINDING_NOT_OBSERVED`；未观察到进程绑定（例如任务过快结束、权限限制或未来适配器改动）会失败，不将元数据匹配冒充独立配置证明。此分支使用项目当前内部持久化字段，不属于外部兼容 API；内部结构变更后需要同步验收脚本。轮询、提交与验收前后检查 server PID/startedAt 和 policy revision；变化明确失败并保留任务。若正常 policy 返回 native，运行器拒绝冒充真实 CLI，不强制改 policy。未通过的任务、owner、结果和私有 workspace 均保留在测试环境供复查；超时不会取消任务，报告指明可能仍运行，不自动重试或重派。

退出码与 JSON 一致：`0 / passed` 表示本次所请求检查全部通过；`1 / failed` 表示至少一次实际失败或安全检查拒绝；`2 / incomplete` 表示存在未配置、不可用或缺模型选择，不能称全部通过。默认未请求的 inference/dispatch 显式为 `not_executed`，不影响只读检查本身的退出码；默认占位渠道缺凭据仍会使只读验收 incomplete。`coverage.counts` 包含已通过、失败、未配置、不可用、待选模型及未执行项（检查项可能分属安装、渠道、模型、推理等不同层次，不能把计数当成独立功能数量）。浏览器交互、账号登录/失效/取消、额度刷新、重启持久化及所有引擎的正式 worker 全矩阵不在这个薄运行器的自动覆盖内，需要单独真实验收。

运行器纠偏包当时只允许语法/help、保护拒绝及一次现有只读路径核验；没有运行 `--inference`、`--dispatch`，没有注册 owner、创建任务或迁移数据库。后续首次执行不替代纠偏后的最终验收；owner应在所有并行代码冻结、服务重载完成后，保存源码 SHA-256 与 `policy get`，再执行上面的实际调用命令。若只读核验遇到 `APP_DRAINING`，保留该失败证据并等待稳定版本，不反复重试。源码检查通过不代表账号功能通过。


## 2026-10-25冻结版最终复验结果

[最终浏览器报告](verification/account-channels/real-test-final/REPORT.html)与[首轮失败报告](verification/account-channels/real-test/REPORT.html)均保留。最终应用摘要为`1c092161ceed7008012cdf22548f919e919033dc24d6df0601ed867be7117f88`；本轮复用4738、server PID1299907（startedAt 2026-10-25T05:29:26.659Z），未主动重启/停止测试或生产服务。上文建立环境时的PID、revision、空任务数量和权限扫描均保留原时点含义。

本轮新增一次性dsh API：UI上传`{}`后保存被后端拒绝且秘密/revision不变；上传`[]`保存、空key保留、配置清除与CAS恢复均实测。新临时worker绑定该API/deepseek-flash/off，从UI调用Hello得到精确hi；随后先移除role，再删除API/secret和私有根，原角色与账号保留。五种官方原生登录入口的链接及必要设备码或Claude密码输入已显示，并验证关闭重开、取消与重试。Claude官方完整`code#state`仅通过浏览器RPC写入当前自有stdin，无CLI code别名；非法格式被server拒绝且保留输入。本人OAuth完整完成仍missing；末尾Codex待授权job的实际期限和scope移交在最终报告中，关闭本任务Chrome不取消该服务器job。

4738上本轮UI全部/单Claude默认导入分别existing=6/existing=1，无重复、Pi未发现。不过[独立首次导入专项](verification/account-channels/import-specific/REPORT.html)明确失败：首次Claude来源缺有效token，返回新增但未就绪；首次全部UI超时后后端才提交6条来源，原HTTP完整回执未知。该时点不能将幂等成功称作首次导入已修复；修复后的独立fresh复验见下文。

[真实运行器分时点证据](verification/account-channels/real-test-final/engine-evidence.json)保留早期五引擎hi（Grok在纠偏后成功）和正式Codex任务`ac722880-d7b1-4886-842d-bc69047846b3`的completed/real/精确WEAVER_REAL_OK、CODEX_HOME进程绑定、ack及accepted。OpenCode Go限额与Pi无key仍为外部限制；没有重跑最终版全引擎矩阵，原先失败/未配置不能涂绿。该较早冻结版时点owner的工程检查为2145 pass / 32 skip / 0 fail，见报告内安全回执，不能代替真实浏览器或本人OAuth验收。


2026-10-25修复后真实默认导入复验见[最终交付报告](verification/account-channels/real-delivery-verified/REPORT.html)和[安全结构结果](verification/account-channels/real-delivery-verified/results.json)。固定摘要为`0c424a5506a69109cfbac6c75ef71624caf8ade40751dd57c57e231ee5fc3be2`（前后源码相同）。两个独立fresh库关闭自动导入，均从revision0、7占位、0 secrets开始：A页面默认Claude首次新增1且凭据就绪（39ms），重复existing1；B页面默认全部首次新增6、Pi未发现、failures空，16102ms取得完整HTTP成功，重复Claude existing1。每次仅一个mutation请求，来源空、不替换，没有15秒TIMEOUT。5个订阅认证根在B私有数据下，dsh为SQLite中的API key，共6新增secrets对应6新增metadata。之前两条失败链路的历史报告原样保留。

浏览器验收包于2026-10-25 06:14:52.477 UTC完成fresh A私有Claude账号的一次正常sayHi/sayHiResult：sonnet/medium，ok=true、精确hi，原生模型claude-sonnet-5-5，4940ms。owner另在持久4738幂等检查结束后、06:18:45.546 UTC最终工程回执前，对既有私有Claude账号正常调用一次sonnet/medium，done、ok=true、精确hi，原生模型claude-sonnet-5-5，6271ms。两次实际/proc观察均证实CLAUDE_CONFIG_DIR、CLAUDE_SECURESTORAGE_CONFIG_DIR和ANTHROPIC_CONFIG_DIR绑定各自私有根；owner调用前后三个全局来源文件未变，仅归档未变布尔值。fresh A调用前后及清理前全局Claude凭据与metadata字节一致。登录selector仅核对共享函数环境构造，未启动新登录作业；本轮没有重新执行全引擎推理矩阵。默认源登录是用户本人恢复，不能写成Weaver修复或五个新官方账号OAuth全部通过。

持久测试URL仍为http://127.0.0.1:4738（本轮PID1381285）。UI默认Claude/全部各一次existing1/6、无新增更新；revision47、18渠道、11 secrets不变，原有secret及认证根文件字节保持。自有4740两个fresh scope和DB/auth/cache、自有Chrome/profile与Herdr workspace均已回收；生产4737 PID1109320保留且未部署本轮修复。报告已实际file打开、390px截图检查、Chrome打印与链接检查；网络一条503来自自有A关闭时的command轮询，导入均为200，JS错误0。

owner同摘要最新`npm run check`于2026-10-25 06:17:57.762–06:18:45.546 UTC自然退出0，约48秒：2184 tests，2152 pass，32 skip，0 fail，typecheck/build通过。测试侧fake worker的close/drain/shutdown与store finally收尾已修正，没有因此修改产品行为。此前06:14:34 UTC完成的约136秒检查也自然退出0，未向该检查发送SIGTERM，不能写成永久死锁或被终止。上述工程检查由owner执行，本次文档核对未重跑；五种旧导入账号hi与正式Codex ac722880...任务仍是较早分时点证据。OpenCode Go限额、Pi未key及五新官方OAuth缺口不改成通过。旧临时设备码/query输出事故事实保留，本包未重复该行为。

安全汇总见[owner最终核对](verification/account-channels/real-delivery-verified/owner-review.json)，与[最终交付报告](verification/account-channels/real-delivery-verified/REPORT.html)配合阅读。feature-acceptance扫描退出2/incomplete：3个用户原有`.worktrees`目录非普通文件被跳过；24条candidate（21条深相对导入、3条报告局部颜色）仅为人工复核线索，未激活门禁，不能称扫描全绿。owner另精确SIGTERM释放第一次无效`/proc` TMPDIR整套测试留下的独立模拟OpenCode PID1367928；fixture属于本任务final-check-tmp，非真实供应商进程或持久服务，未删除schema或数据。这里只核对已有安全证据并修正文档，没有运行引擎、浏览器、测试或服务。
