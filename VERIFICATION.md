# Weaver 验收记录与项目门禁

> **历史性质说明**：本文记录的是针对被测版本 冻结 060（runtime/UI 构建 055）的历史验证结果，文中的测试数量（如 185/185）、SHA256、PASS/FAIL 与实机结论都只对各自被测版本成立，**不是当前代码的成绩**，不要把它们当作当前 HEAD 的验证状态。当前代码的验证方式见仓库根 `package.json`：`npm test`（测试套件）、`npm run check`（typecheck + 测试 + build）；文档与实现的事实核对以 `docs/` 与 `src/` 当前内容为准。

本记录针对技能 `skills/weaver`（该技能现已改名为 `skills/agents-weaver`，见提交 283a3f2）、CLI 与普通网页 `weaver web`。Electron 预览是失败历史，不属于新架构通过证据。浏览器、CLI、真实供应商与真实外部 Owner 分开判定，编译和单测不替代实机。

## 被测版本

最终源码冻结 060，SHA256 `0f0390e30f4b36658deaa1255838b4b1f7f43e53ecfdd540057a358f3a8419d4`；runtime/UI 构建仍为 055，SHA256 `be6c1323859308d144e73847615ef5e1b1b5e0b1394832db8ba54841f219e8e1`。CLI 文件 SHA256 `42be2d9bc166a73edc252b4473b5332eaeb8b154d1b7d9f07748c56ccf0dd807`。逐文件表见 [freeze060.json](docs/verification/redesign/final/freeze060.json)。045→055 只改变三处原生 provider 适配器、两处表单 label 及相关测试；055→060 只改两份技能临时根边界文档，构建不变；domain、scheduler、policy、CLI/IPC/HTTP、引擎 argv 及正向工作流未改。旧证据保留原版本，不伪称在 055 重跑。

Node 24.21.0。短 TMPDIR 的 typecheck、185/185 tests、build、canonical skill validator、真实 installed CLI 六项通过。首轮长 TMPDIR 导致 socket 路径 108 bytes 超过既有 103 上限，14 项失败；未改代码或放宽上限，短目录重跑通过。两轮原日志均保留：[失败](docs/verification/redesign/final/final-check.log)、[通过](docs/verification/redesign/final/final-check-short.log)。用户已豁免本任务 Pro 审查，未声称 Pro 通过。

## 实机证据

- installed `weaver` 的 35 项命令均有 json/jsonl/text 实际调用；错误、嵌套命令、帮助、stdin、调用方 cwd、幂等 receipt、有界 wait/watch 与完整分页有单独证据。见 [catalog](docs/verification/redesign/final/catalog-coverage.json)、[CLI 边界](docs/verification/redesign/final/cli-edge-results.json)、[分页](docs/verification/redesign/final/pagination-results.json)。这些属于 045，按上述源码边界映射保留。
- 路由顺序、同层权重、0 排除、硬 pin、禁用/配额、冻结条件、当前容量、多 Owner、队列原因、客户端断开、第二实例、重启与同 attempt 不重复执行，见 [调度](docs/verification/redesign/final/scheduling-results.json)、[runtime](docs/verification/redesign/final/runtime-edge-results.json)、[admission](docs/verification/redesign/final/admission-edge-results.json)、[重启055](docs/verification/redesign/final/restart055-results.json)。
- OpenCode max、Pi high、Codex xhigh 经 Weaver 创建→包→实际 worker→文件独立核对→ack→accepted；Grok high 的唯一实际调用返回 402 余额耗尽，无文件、无 fallback、无恢复时间。见 [真实引擎](docs/verification/redesign/final/real-engine-results.json)。请求 model/effort 不冒充 vendor observed；未回报者保持 unknown。Claude 本轮无模型调用。
- 055 真实 Pi 立即取消后 scope 与实际观察 PID 消失，无关对照进程在取消期间存活、finally 已释放；见 [立即取消](docs/verification/redesign/final/real-pi-immediate055.json)。原 045 Pi hold 取消/60000ms timeout 的父孙进程证据按明确影响映射保留；新构建另测延迟注册与流处理边界。
- 055 普通 Chrome 任务 profile 实际访问五页、1440/960/900×650、明暗共 30 组合；`.ant-app` 满视口、无全局 header、无横向溢出。label 真点击、ID/目录错误、tags 输入/Enter/逗号/移除/保存重载、策略草稿/JSON、路由保存与 CLI 一致、全0/不可用 pin 阻断、迟到响应、离线恢复、任务结果/ack/review/重试/取消及接续包有实际交互证据。见 [viewport](docs/verification/redesign/final/ui055-viewport-matrix.json)、[显式主重试](docs/verification/redesign/final/ui055-offline-explicit-retry.json)、[迟到响应](docs/verification/redesign/final/ui055-late-response.json)、[任务审查](docs/verification/redesign/final/ui055-valid-review-continuation.json)。
- 主错误必须通过实际“重试连接”清除；早期“路由预览恢复”不等于主错误消失。后补显式主重试证据为 `mainNetworkAlertGone=true`、`draft137Preserved=true`。未保存的新建任务草稿在同一页面会话跨页/关闭重开保留，完整页面 reload 重置；策略保存后 reload 读取持久配置，不把未保存内容写盘。
- console 与未捕获 page errors 为空，无 CSP/模块加载错误。网络中的 favicon 404 与主动触发的 disabled-owner/全0/不可用 pin 预览 400 分别保留，不写成零 HTTP 错误。见 [运行健康](docs/verification/redesign/final/ui055-final-health.json)。六维控制台审查基于真实截图/DOM/行为，见 [审查](docs/verification/redesign/final/ui055-six-dimension-review.json)。

## 真实 Owner 行为与限制

ACC 使用真实外部 Codex CLI、每轮 staged `.agents/skills/weaver`，不以宿主子 Agent、QA 发命令或 `--version` 代替。第一轮 `round_85a961ee70` 整体 FAIL；其中 smoke/representative/complex 三阶梯的四包真实 accepted（独立 8/8 与 39/39），AB/BA/权重250 的实际选路证据按影响映射保留。第一 Pi recovery attempt 截断的精确 raw cap 分支/bytes 未持久化，保持 unknown；另一个 attempt 是供应商 Connection error。

055 第二轮 `round_d724e4a216` 整体 FAIL：Pi 硬 pin 首包 completed 后被 Owner 独立 rejected，补强包 Connection error/failed 未 accepted。QA 的 10/10 与原测试 bytes 保留不替代成功终态。negative 只读任务实际仅 rg/cat，前后文件 hash 与任务状态不变。旧 FAIL、拒绝、partial 都保留。[第二轮](docs/verification/redesign/final/acc-round2-finalize.json)、[映射](docs/verification/redesign/final/acc-affected-revalidation-map.json)。

第三轮 round_9008d64020 明确新隔离场景硬 pin Codex，未改历史 Pi，不是隐式 fallback。真实业务链成功：vendor terminal success、ack/accepted、QA 10/10、原测试 bytes 和 README 保留，只有 importer/test 改变。但 Owner 曾用绝对 `/tmp/recovery-import-owner-XXXXXX` 创建任务根外 scratch（结束已自行删除），严格临时隔离未通过，本轮如实 CONDITIONAL finalize/cleanup，见 [隔离偏差](docs/verification/redesign/final/acc-round3-isolation-finding.json)。业务成功不掩盖边界失败；058/059 已只修技能临时根 canonical 说明；060 新 staged 真实 Owner 只读复验 `round_cc3314b9a6` 已 PASS/cleanup。实际输入、响应、baseline 只在 supplied `.tmp` 下唯一私有目录；QA 独立 policy/全部9任务/fixture/hostconfig指纹前后一致，无新 worker。旧 FAIL/CONDITIONAL 不改；按文档化 scoped-evidence reuse 明确复用三阶梯四成功包、Codex恢复及negative，不重跑业务模型。见 [新边界](docs/verification/redesign/final/acc-boundary060-independent.json)、[复用映射](docs/verification/redesign/final/acc-boundary060-evidence-reuse.json)、[合法PASS/清理](docs/verification/redesign/final/acc-boundary060-finalize.json)。规则只维护在 [Task scratch root](skills/agents-weaver/references/handoff.md#task-scratch-root)（当时路径为 `skills/weaver/references/handoff.md`），此处记录验证结果而不复制规则。外部 Owner 第二/三轮及最后只读边界轮实测 GPT-6.1-Sol high，逻辑 codex_owner 的 xhigh 不冒充外部宿主 effort；QA observer 为 medium，worker 的 requested/observed 分列。

## 满屏、表单与网络门禁

1. ThemeProvider 的 `.ant-app` 必须铺满视口；`html/body/#root` 及中间 flex 父级须允许正确伸展，必要 `min-width/min-height:0`。禁止 ConsoleShell 默认 56px header 再出现。验法为真实 1440/960/900×650 明暗截图及 root→main DOM rect，不能用 SSR 或只查 DOM 存在替代。旧 Electron 预览已真实复现外壳失配，最终 rect 见上述 viewport 证据。
2. 有可见 label 的输入须有唯一 id、正确关联，并由真实浏览器点击 label 验证焦点；错误说明与字段关联。Select、数字输入、Switch 及 tags 的 combobox/内部 textbox 都须有可访问名，tags 输入、Enter/逗号、移除、重开保存实测。只给 aria-label 或渲染字符串不替代 label 真点击。
3. 路由预览依赖条件或已保存 revision 变化后，旧成功、旧错误及晚到响应不得复活；未保存草稿不能冒充已生效配置。断网须保留草稿和最后有效数据，恢复后主重试清除主错误。JSON 无效时保留可恢复输入，不执行 mutation；硬 pin 不可用须诚实阻断。
4. HTTP 必须走真实同源 RPC；CSP 的 script/connect 为 self，不为验收加 unsafe-eval、fake window.weaver 或 stub response。受控网络故障、文件 chooser 与原样延迟转发仅用于浏览器边界采证，须单独标明。

## 生命周期与原生流门禁

1. 立即取消不得因为 scope 尚未注册就缓存成功，从而放行晚启动进程。验证必须使用延迟注册真实 systemd fixture，最终核自有 InvocationID/cgroup、实际已出现的父孙 PID 消失及无关进程不受信号；没有出现的后代不能写成“已杀死”。参考 [049 红绿与清理](docs/verification/redesign/final/scope-startup/manifest.json)、[055 built 延迟取消](docs/verification/redesign/final/built-delayed-cancel055.json)。
2. 大量正常 Pi message_update 的累计传输量不能当作保留预算主动终止。原始流逐帧消费，normalizer 的保留内容必须有界，先脱敏再窗口裁剪；`retained evidence clipped` 与 vendor/local protocol truncated 分开。单帧超限报告有限 phase/limitBytes/observedBytes/observedVendorBytes/parsedFrames，不能泄漏原文。参考 [050/051 无模型真实 scope](docs/verification/redesign/final/provider-stream/manifest.json)、[055 built 全链](docs/verification/redesign/final/built-stream055-results.json)。合成 fixture 的 1,936,000 bytes 只说明独立复现，不倒填旧真实 attempt 的未知计数。
3. built stream fixture 的 normal/retained/overflow 只证明传输、保留及失败诊断。通用 helper 附带的 proof.txt criteria 没有执行，不算文件验收；这些任务没有 accepted review，也不是模型调用证明。
4. 终止和清理只能依据本任务记录的 unit/InvocationID/PID。不得按 `weaver-cli-*` 前缀清理用户并发 worker；外部客户端退出不应取消服务内已接收任务，重启不得静默重复执行。

## 资源交接

最终资源释放记录及人读报告放 [final](docs/verification/redesign/final/)。自有服务/ACC scopes、记录worker scopes均无active，自有panes已关闭；Chrome/profile最终验读后精确回收。用户自行接管的 p52/4737 未被QA停止；末次只读复核两者已不在、默认capabilities正确APP_NOT_RUNNING，原因未知，未为验证重启默认data。正式 bin、已验收 `~/.agents/skills/weaver` 链接、默认持久数据、原生 auth、旧桌面数据保留。Owner已独立核对28个精确scope均inactive/无cgroup、全部proc引用与mounts为空，随后精确回收唯一任务临时根，现目录不存在；见 [064预检](docs/verification/redesign/final/064-owner-cleanup-preflight.json) 与 [065实际回收](docs/verification/redesign/final/065-owner-temp-reclaim-result.json)。不以验收完成授权清除开发持久数据。

已验收全局技能链接仅在最后clean边界PASS后安装，见 [入口](docs/verification/redesign/final/global-skill-installed.json)。用户当前可运行 `weaver web`；Grok402与Pi连接风险仍保留，不保证四家实时可用。最终补充浏览器观察见 [启用不代改角色、重命名权重、tabs键盘](docs/verification/redesign/final/ui060-remaining-controls.json)，发生在ACC只读快照结束后，仅修改隔离fixture配置。

## 额度探测门禁

本轮新增额度功能的实际验收结果以 [额度验收报告](docs/verification/quota/REPORT.html) 为准；上文的源码冻结、测试数量、PASS/FAIL 与真实供应商结果属于各自历史版本，不作为本轮通过证明。

- 模型范围、未确认全账户的 surface 不得因 `session`、`weekly_all` 等窗口名被提升为账户级封禁；非空 authoritative limits 不得因信息不完整反向取 legacy 窗口制造可用。见 [provider 行为测试](tests/main/quota-providers.test.ts)。
- 独立账户消费限制不得借套餐窗口 reset 标记为已过期或设定释放期限；主进程、持久阻断和页面本地 aging 使用同一 `statusBasis` 语义，5 分钟 TTL 与失败状态仍有效。见 [集成测试](tests/main/quota-integration.test.ts) 与 [展示状态测试](tests/renderer/quota-renderer.test.ts)。
- missing/null/非法额度值保持未知，不补 0；自动阻断只维护本功能 source，保留人工及其他来源。过期 foreign 条目妨碍正确阻断时，整次合并明确冲突且策略原子不变。HTTP 429 是探测限流，不能当作订阅耗尽。对应契约与验证入口见 [额度接口](docs/agent-interface.md#31-原生账户额度) 及上述三组测试。
