# im-master 真实 CLI 验收 — 脱敏摘要（Codex 资产行为 QA PASS；OpenCode 冷启另见 smoke 报告）

- 验收任务 `round_425af14b97`（复用 acceptance `acc_1c1b22ab1a` 并替换
  strategy/fixture/tasks 为真实运行时方案；前置 fake-weaver 版结论已作废，
  旧轮次 `round_60053bc3ff` 因资产 hash 变更记 stale:true，不再有效）：
  独立验收 agents-weaver Master 角色指引（狭窄范围：
  `references/master-guideline.md` 新增 running-owner 追问边界 gotcha ＋ 入口角色路由，
  不覆盖整个 Weaver 调度能力）。
- 状态：**Codex 资产行为 QA PASS（真实 Codex CLI + 真实私有 Weaver runtime，已执行）；
  OpenCode 实际冷启 FAIL（见下，两者独立，不混同）**。
  本摘要覆盖 Codex QA；实际当前 OpenCode 模型冷启见任务根
  `/tmp/weaver-bot-lifecycle-thgzzwqn/master-opencode-smoke.md` 与本目录
  `opencode-smoke/result.json`（desensitized），结论为 FAIL，不包装为 PASS。
- 冻结依据（官方 ACC 聚合真值，不手抄单文件 hash）：
  `real-acc-aggregate.json` 经官方 CLI
  `ACCEPTANCE_HOME=/tmp/weaver-bot-lifecycle-thgzzwqn/acc-home bun asset-validation/scripts/acc.ts history --asset agents-weaver`
  核实：`current_asset_hash=ee65ec44e0d5e30bd5c32cd811c6d6fb8690c0d4f79233c6236645eea2310a96`，
  `round_425af14b97` verdict PASS、stale:false、task_keys t1–t5 全覆盖。
  未直接读取 ACC SQLite，未捏造任何 hash。
- 旧单文件 hash 更正：此前报告/strategy 手抄的入口 SKILL `be89213f…9b9c`（52 字符，
  非可用 SHA256）与 strategy 记录的 ref `8c2644fe…14668`（62 字符，非可用 SHA256）
  均为抄写错误，已删除，不再作为冻结依据。该旧单文件 hash 已不可独立复核；
  本轮以实际 ACC 聚合 `ee65ec…0a96` + round 内 staged 副本读取记录为准，
  不把当前已变更入口 hash 冒充旧 hash。
- 可独立复核的当前真值：`src/main/im/bootstrap.ts`
  `f164b33a3b453f5d776cf5b416cbf3bc87138872fb5c96a97446e5eb3d760e8b`（本轮未改，
  与报告一致）；`skills/agents-weaver/references/master-guideline.md`
  `8c2644fe350fb36f190bcd76004683f14183446919952f41e704a379acab970c`
  （repo 当前 64 字符真值；已按此精确恢复已安装副本，两份 cmp 一致，
  `/home/mocha/.codex/skills` 为同一 realpath）。
  已安装 `SKILL.md` Master 三 hunk 已按 repo 定向恢复（Entry Master 路由 +
  owner preflight 解释），其余 DSH/credential 定制保留，未全量覆盖。
- 行为证据（本目录 durable，最小脱敏）：`real-acc-aggregate.json`（官方聚合 proof）、
  `evidence/task-counts.json`（根数 3→4，t4 仍 4 且 instruction 仍 CSV、未取消重建，
  Excel 补充明确未送达；t5 仍 4，policy rev2 全禁用）、`evidence/t*-ledger.jsonl`
  （共 22 次，0 拒绝，`owners.*` 0 次，t1 空调用标记）、`evidence/t*-transcript.txt`
  （逐项公开助手文本，无 reasoning/session 私密）。未复制整个 ACC DB 或原始
  session 日志/环境。任务根 `/tmp/weaver-bot-lifecycle-thgzzwqn/master-real-acceptance.md`
  为完整结论，根删除后以本目录证据为准。
- 详见本目录 `master-acceptance-summary.md`（5 级任务梯、真实调用账本、限制与 cleanup）。
- OpenCode 冷启（独立）：`engine=opencode`、`model=opencode-go/muse-spark-1.3-contributor`、
  `effort=xhigh`，真实 `createBackgroundParentAgent` + 私有 runtime/CLI/wrapper，
  hidden init 阶段 `protocol` 失败约 8s，两次 factory 未 ready，未发送只读问题，
  0 调用/0 新任务/原生 0 ours；私有 scope 已停，本任务 unit/im-host 0，他人数据保留。
  源码 6 文件与 flag hash 全一致，失败与漂移无关；旧 smoke 疑似 `variant=xhigh` 被拒，
  现已被本任务原生诊断证伪（见下），历史 FAIL 文件保留，不改写结论。
  详见任务根 smoke 报告与 `opencode-smoke/result.json`。
- OpenCode 原生根因（本任务新增，不改写旧 FAIL）：同配置真实 `createParentAgent` 直接诊断
  （任务私有 `im-opencode-debug/`，真实 `startOwnedScope` 固定 unit 8G/10G，无 fake 模型）：
  握手 OK（health 200 healthy 1.19.3 + session ses，约 1.4–1.5s），`prompt_async` 接受
  `variant=xhigh`（204，无 400），hidden 身份 send 均 resolve 但公开正文带叙述前缀 +
  marker（34/77/104 字符三例，`isMasterReadyText=false`），故 host 严格门限正确报
  `protocol` 而不 ready。产品传输无 bug，`parent-opencode/bootstrap/host/identity` 零改；
  fixture 新增 `identity-prefix`（真实 34 字符样本）+ host 严格门限测试（prefix 仍
  protocol、不 ready），`im-parent-host 22/22、im-parent-opencode 23/23、budget 7/7、
  typecheck` 全过。判 FAIL（外部模型 marker 合规阻断），不伪造 PASS，不放宽 contains 校验。
  证据见本目录 `opencode-correction/result.json` + `native-evidence.json`，
  报告见任务根 `im-opencode-correction.md`。
- OpenCode 后台冷启动最终验收（本任务 `66c0ccf7` 真实执行，区别旧 FAIL，不改写历史）：
  旧 FAIL 为聚合 `flatMap join` 根因（`parent-opencode` 整轮公有聚合致严格门限失败），已由工作树修复
  （`finalAssistantOnly` 仅取最新 terminal `parts`，默认聚合仍保留全部分段，`trim===WEAVER_MASTER_READY` 未放宽）。
  本轮同值 `engine=opencode/model=opencode-go/muse-spark-1.3-contributor/effort=xhigh` 真实
  `createBackgroundParentAgent` + 私有 `startRuntime`/`TaskStore`/`PolicyStore`/wrapper/bundle：
  `FACTORY_READY ms=9032`，隐藏 init 0 新增 weaver 调用（账本前 2 条为本轮前验证只读 `policy get`），
  原生唯一会话 `ses_e9ea6e03`（`variant xhigh`，`title 入口Master身份初始化待命`，1 user + 2 `tool-calls` + 1 `stop` 终态，
  `read→master-guideline.md` + `skill` 工具元数据），只读问答 6 调用全读（`--version`/`policy get`/`owners list`/`tasks list`/`policy preview x2`，
  精确 catalog/mutation 判定 `attemptedWrites=0`），`tasks 0→0`、`policy rev 1→1`、`REGISTRY_EMPTY=true`，
  close 后原生 `0` 残留（DELETE 预期），回答 `claude_owner`/`codex_owner` 可用、明确无需 `opencode_owner`（跨 engine 正常）。
  判 **PASS**。证据见本目录 `native-final/result.json`（脱敏）+`answer.txt`+`ledger.jsonl`，
  完整报告见任务根 `im-master-native-final.md`；旧 `opencode-smoke`/`opencode-final`/`opencode-correction` FAIL 文件保留。
- 清理记录（本任务）：私有 runtime `dev-weaver-master-native-mviwbdv6-8hx3 scope port 37369 pid 317830` exact 退出已验；
  `nf/d`（weaver.db/WAL/SHM、`im-host` 空、`runtime-ready.json`）、`nf/build/weaver-cli.mjs`（`b3748df7…`）、
  `nf/bin/weaver`、`nf/demo` 一次性回收；他人 `weaver-im-host-2b43…`、共享 4737/4738/Chrome/Herdr、他人 opencode serve/会话未动，未写共享 DB。
