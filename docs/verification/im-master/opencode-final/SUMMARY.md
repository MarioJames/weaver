# im-master OpenCode final-only 修复 — worker 摘要（fixture 通过，真机待 owner 复验）

- 根因：`finalizeSuccess` 在确认 newest terminal（`time.completed` + 非空 `finish`，
  排除 `tool-calls`/`unknown`，按 `created`/`index` 取最新）后，对整轮所有 assistant
  消息 `flatMap parts join('')`，把中间进度段落与真正 terminal 段落粘成聚合 raw，
  再用 `trim() === WEAVER_MASTER_READY` 严格校验，必然协议失败。
  此前 d9f94e08 的 raw34/77/104 是聚合 transcript 证据，不能据此判定模型单条 final
  自带前缀不合规。单消息自带前缀（既有 `identity-prefix` 负例）仍是 final 本身违规，
  与本次多消息聚合根因不同，两者都要保留认识。
- 修复（最小产品 hunk，无全局状态、无 RPC/配置层）：
  `parent-agent.ts` 新增内部 `ParentAgentSendOptions.finalAssistantOnly`，
  `send(text, signal?, onDelta?, options?)`；其他适配器保持既有行为。
  `parent-opencode.ts` 记录 `ActiveTurn.finalOnly`，终态证据成立后 final-only 只取
  `latest.parts` 公有文本，默认仍返回整轮公有聚合但按真实 assistant 消息边界空行分段、
  同消息内原样、丢 `synthetic/ignored/tool/reasoning` 与跨 session/parent，按原生时间稳定排序；
  final-only 抑制 `onDelta`。普通回复内容不丢，不把普通回复改成只剩最后一句。
  `parent-host.ts` 隐藏身份 send 改为 `send(prompt, signal, undefined, { finalAssistantOnly: true })`，
  仍无 delta，仍严格 `isMasterReadyText`，不放宽、不 fake-ready、不改 phase/取消证明。
- 验证（本 worker 实际执行）：`im-parent-opencode 25/25`（含新增默认空行聚合与
  split 进度+terminal：默认含两段+`\n\n`且严格失败、final-only 精确返回 marker 且零 delta；
  `multi-assistant` 默认精确 `中间-\n\n最终`、final-only 精确 `最终`）、
  `im-parent-host 23/23`（既有 prefix 单消息仍协议失败；新增 split 经 final-only 正常 ready、
  无 delta、不泄露 marker；取消/终态/权限门控未动）。
  真实当前模型私有 BG 冷启复验本 worker 未执行（worker 上下文无私有 bundle/runtime/凭据），
  不虚构 native 消息级证据与 ready 结论；旧 FAIL 历史未篡改，待 owner 按授权复验后闭环。
