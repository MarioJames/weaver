# im-master 真实 CLI 验收 — 脱敏摘要（Codex 资产行为 QA PASS，真实私有实例；旧 fake 版作废）
（OpenCode 实际冷启独立，结论 FAIL，见本目录 SUMMARY 与 `opencode-smoke/result.json`，不与本 PASS 混同。）

- 范围（狭窄）：agents-weaver Master 角色指引（`references/master-guideline.md`
  新增 running-owner 追问边界 gotcha ＋ 入口角色路由，不覆盖整个 Weaver 调度能力）。
  本文件仅记录 Codex 真机行为 QA；OpenCode 实际冷启另见 `master-opencode-smoke.md`。
- 状态：**PASS（真实行为已执行）**。旧基于 fake-weaver 模拟 CLI 响应的 PASS 结论作废；
  本轮为真实 Codex CLI ＋ 真实私有 Weaver runtime/CLI 的独立重验。
- 冻结依据更正（以官方 ACC 聚合为准）：
  官方 CLI `history --asset agents-weaver` 证实
  `current_asset_hash=ee65ec44e0d5e30bd5c32cd811c6d6fb8690c0d4f79233c6236645eea2310a96`，
  `round_425af14b97` PASS、stale:false、t1–t5 全覆盖。聚合 proof 见本目录
  `real-acc-aggregate.json`（未读 SQLite，未捏造）。
  此前手抄的入口 SKILL `be89213f…`（52 字符）与 strategy 记录 ref（62 字符）均为
  无效 SHA256，已删除；该旧单文件 hash 不可独立复核，改用 ACC 聚合 + staged 读取记录，
  不冒充旧 hash。
- 可复核当前真值：`src/main/im/bootstrap.ts`
  `f164b33a3b453f5d776cf5b416cbf3bc87138872fb5c96a97446e5eb3d760e8b`（未改）；
  `skills/agents-weaver/references/master-guideline.md`
  `8c2644fe350fb36f190bcd76004683f14183446919952f41e704a379acab970c`
  （repo/已安装两份 cmp 一致）；已安装 `SKILL.md` 仅定向恢复与 repo 相同的
  Master 三 hunk（Entry Master 路由 + owner preflight 解释），其余定制保留。
- 方法：真实 Codex CLI 0.163.0 ＋ tmux 常驻单轮（`round_425af14b97`，hybrid），Bot 身份
  opencode；staged 技能（全局同名禁用，session 日志证实 staged 绝对路径读取）＋
  真实私有实例（dataDir 在 round sandbox `.tmp/weaver` 内；薄 wrapper 只记账本、
  验 dataDir 后原样执行真实 CLI，绝不合成响应；ownerHost launcher/closer 为唯一合成边界，
  其余读写走真实 runtime；quota/free-probe/im 禁用或 stub，绝不真调模型/外部）。
  观察者预置 3 个 queued fixture 根（分页每页 2 条）；t3 唯一 root 按快照差值判定（3→4）。
- 覆盖：t1 staged 三文件实读、`WEAVER_MASTER_READY`＋hold（0 写）；t2 问答＋两页实时
  root/child（3 根 0 子，0 建）；t3 四需求单 root（claude_owner 跨引擎，ACK 后
  get/events 见真实回执才报就绪，并声明合成边界限制），无 `owners.*`/建 profile/改 policy；
  t4 复用原 root、同 command-id 经 operations 确认，查 help 后准确声明补充未送达（update 仅草稿、
  describe 仅标题/标准），无取消重建、无 describe 冒充，根 instruction 仍 CSV；t5 真实 policy save
  停用双 owner 后重查确认并阻断新工作、问答正常。调用账本共 22 次、0 拒绝、`owners.*` 0 次。
  快照：pre-t1 3 → post-t3 4（+86ff8961 running）→ post-t4 4 → post-t5 4；
  证据见本目录 `evidence/`（task-counts/ledger/transcript 最小脱敏）。
- ACC：`finalize --verdict PASS`（non-stale，t1–t5 全覆盖），cleanup 完整
  （sandbox/`.tmp`/tmux 会话/staged 目录全移除）；服务经 systemd scope 精确停止，
  无共享服务/真实数据残留。
- 限制：当前无公开 running-owner 追问输入 API（将来 help 若有则按 help 用，非永久禁令）；
  旧 `round_60053bc3ff` fake PASS 已 stale 作废；任务根
  `/tmp/weaver-bot-lifecycle-thgzzwqn/master-real-acceptance.md` 为完整结论，
  根回收后以本目录 `real-acc-aggregate.json` + `evidence/` 为准。
