# 账号与渠道重构独立架构审查

首次审查包：`aa2f2020-a203-40e3-b78b-e0e7419f7333`；Qoder/OpenCode delta复核包：`cbab6c7f-3a7f-410b-a1ae-b20fdd26e517`；证据封口包：`6d931ec5-81f6-4e30-8078-5791c98ad8b9`；基线 `780165e`。早期布尔结果对应各原审查时点；本次仅对随后三类修复完成focused只读复核，最终文件指纹更新到2026-10-24封口时点；完整SHA-256见[文件指纹](review/file-hashes.json)。只修改本报告及非敏感审查证据，未修改业务源码、测试、依赖、真实认证或全局CLI文件，未启动服务或浏览器。

当前不能给出“所有引擎真实身份绑定通过”的结论。源码结构已实现渠道作为角色引用与私有认证边界；本次发现的旧暂停丢失、Hello输出泄密、Pi/Grok协议丢失均已修复并由独立fixture复测；Qoder BYOK与OpenCode引用物化最终delta也已完成独立源码及隔离行为复核，未发现新的阻断；真实远端身份与计费边界仍未验证。

## 发现与修复复核

| 项目 | 触发、影响与最小修复 | 本次状态 |
| --- | --- | --- |
| Qoder BYOK 无可导入路径，且 API 模型尚无可靠身份约束 | 审查初始版本`channels/import.ts`的Qoder分支仅复制 `.auth/user`、`.auth/machine_id` 并创建 subscription，没有复制 `.models` 或创建 API；`channels/runtime.ts` API 却要求 `.models`。用户通过原生 `/model` 配置后依然不能导入 API。补充有界 opaque 原生复制，并仅允许原生确认的 Custom 模型，不能携带官方认证后允许 `auto` 回退订阅。 | 已修复：opaque材料+machine_id复制、原生list差值白名单、customs/machine哈希、运行时与模型列表同一白名单；独立fixture确认auto/官方/未知及空/截断/变更材料拒绝。真实BYOK计费未验。 |
| 原生导入重映射角色后旧暂停丢失 | `channels/import.ts` 将角色 `default_codex` 改为 `import_*`，最后却原样保存 `snapshot.blocks`。既有 `worker=codex_worker, channel=default_codex` 的供应商暂停不再覆盖同一身份角色，`coveringBlock` 返回空，可能提前恢复限流账号。按实际角色及身份重映射可唯一归属的暂停；聚合旧引擎暂停不能随意扩散到所有新账号。 | 已修复并独立复跑：priorBlockStillCovers=true。新增import-blocks保留worker限制、旧官方quota归属与真正全局stall。 |
| Hello 将认证形状错误直接经 RPC 返回 | `engines/hello.ts` 的 `done` 未脱敏，失败分支把 native `parsed.error` 或 stderr 直接 `clip` 到 `HelloResult.error`，随后 HelloJobs 缓存并返回。合成 native stderr `api_key=sk-review-fixture12345` 原样出现。最小修复为所有结果出口复用现有 `shared/redact`，至少处理 error/reply/model；避免另建第二套正则。 | 已修复并独立复跑：secretShapedErrorExposed=false；统一出口处理error/reply/model，复用shared/redact并遮蔽所选显式apiKey。 |
| Pi/Grok 导入后原生协议被默认值覆盖 | importer未保存protocol，runtime对有API key的Pi无条件将provider.api改为openai-completions，对Grok无条件将model.api_backend改为chat_completions。原本Messages/Responses端点导入后改用错误协议。应只有显式metadata.protocol才覆盖，否则保留原生值并采用引擎fallback。 | 已修复并独立复跑：Pi/Grok均nativeMessagesProtocolPreserved=true、compiledDefaultChat=false。 |
| Hello 缺 channel 或引擎错配继承全局认证 | 原公开输入允许没有 channel，且把请求 engine 与另一渠道 binding 混合。例如 Codex API binding 配 Grok engine，只设 CODEX_HOME，Grok 可读全局 HOME。 | 已修复复核：parser 拒绝缺 channel，`sayHi` 拒绝 binding.engine/kind 错配；合成输入均在 spawn 前拒绝。 |
| Herdr 复用 pane 清理凭据变量范围小于 worker | 原 shell 只清固定厂商前缀，遗漏 `CUSTOM_API_KEY` 等 worker sanitizer 本会清理的变量。native env-key 引用可取得上一身份凭据。 | 已修复源码复核：两端共享 `CHANNEL_AUTH_ENV_PATTERNS` 与 suffix；已有 owner-host 行为测试在新 sh 中验证清理，私有 env 文件不进入 Herdr argv。 |
| Pi `$NAME` 凭据被当作字面量 | 原导入以 `env[reference] ?? reference` 处理 `$TEST_PROVIDER_KEY`，存下未解析模板，隔离 env 又移除 key。 | 已修复并独立复跑：`resolvedCorrectly=true`、`storedLiteralReference=false`；`!command` 导入明确拒绝执行。 |
| OpenCode auth.json 覆盖显式 provider key | 原 importer 先取共享 auth.json 的 A，然后 runtime 覆盖原生 provider.options.apiKey 的 B，导入后用错账户。 | 已修复并独立复跑：`nativeInlineKeyPreserved=true`、`globalAuthOverrodeInlineKey=false`。 |
| Claude 大元信息文件与 OpenCode 严格 switch 参数 | owner 原生副本验收发现 `.claude.json` 625107 字节超过512KiB，以及 spread org 多余字段被严格 parser 拒绝。 | 源码复核已修：Claude 元信息限16MiB且仅抽取 oauthAccount；OpenCode switch 显式传 accountID/orgID/expectedActive。未读取真实源，真实副本行为证据归 owner。 |

早期独立复现使用临时脚本、新建目录、合成凭据与内存SQLite，结束删除fixture。长期证据：[修前结果](review/repro-results-before.json)、[修后结果](review/repro-results.json)、[Hello拒绝与脱敏](review/hello-results.json)、[Pi/Grok协议](review/protocol-results.json)。三组修后结果均符合预期；脚本首次CJS顶层await失败后改用async main成功运行，未修改产品。

另外实跑现有隔离测试：channels/owner-host 共52项通过，worker-hello/channel-runtime 共25项通过，合计77项。测试没有调用真实收费引擎；这些结果补充源码与独立fixture证据，不能替代真实身份或计费验证。

## 逐入口与职责核对

| 入口 | 核对结果与边界 |
| --- | --- |
| 模型与存储 | Config 版本仍为1；Channel.engine 引用 policy engine ID、通过 kind 支持别名，Owner/Worker 引用 channel。ChannelStore 与 PolicyStore 同连接事务；公开摘要仅 hasApiKey/hasConfig/hasCredentials，secret 不进入 policy。CRUD 校验128KiB UTF-8上限，不在错误中回显字段值。 |
| worker stream/file 两条 launcher | `adapters/routing.ts binding()` 都要求冻结 dispatch.channel，解析私有 binding，并核对 engine ID 与 engineKind。`prepareCliAgentInput` 把 native argv 放在命令参数前；dsh 的渠道 patch 在最终权限 patch 之前。未使用 mock 替代失败真实启动。 |
| Herdr owner | 生产调用传 channelConfig；私有0600 shell 文件承载 env，Herdr argv 仅私有文件路径。执行前 set +x，清理共享凭据变量模式，再注入所选配置。Codex/Claude 原生参数对应同一 binding。close/failure 清理记录的运行目录与 env 文件。 |
| IM | 配置与 profile 使用 channel；生产 parent/probe 传入解析 binding，实际启动不再只凭 engine。模型安装/列表可只读 engine，不能把这种查询当成身份启动证明。 |
| schedule | 角色执行走 channel binding；quota schedule 枚举 enabled channel、按 channel 调 refreshQuota；并非按 engine 重复使用同一全局账号。 |
| Hello / free/stall probes | 生产路径需 binding，现公开 parser 与底层错配校验均 fail closed。Hello 输出脱敏缺口另列发现；模型成功回答只能说明路由当时可用，不能证明订阅/API计费归属。 |
| models | 有 channel 时核对 engine 并用 `prepareChannelRun(...purpose:'models')`，finally 清理；无 channel 只读本机列表仍允许。列表失败不回显 native stderr。 |
| quota | `quota/index.ts` 按 channel 缓存独立 native runtime、私有 snapshot scope 与签名；API 不执行订阅额度探测。`policy/quota.ts` 要 record.channel 精确匹配 subscription，并只更新该渠道；OpenCode继续 display-only，不把 Go 额度扩散到其他provider。 |
| 恢复与 reattach | file-mode attach 使用持久运行路径接回旧进程，不重新选择全局账号；持久启动记录未包含 ChannelBinding.secret。replaceExisting 使用新私有认证根，既有进程继续旧根。 |
| 旧 OpenCode 全局控制面 | `src/main`、`src/shared`、`src/renderer` 搜索旧 Pool/Admission/switch/login/quota公共RPC名无结果；原生 OpenCodeAccounts 类仍用于隔离副本枚举/切组织，不重新启用全局游标。 |

## 隔离、迁移与恢复核对

`prepareChannelRun` 清理继承的厂商认证/常见凭据变量，生成0700运行根与0600原生文件。Codex API 使用独立 CODEX_HOME 和 auth.json 空对象；Claude API 使用独立 CLAUDE_CONFIG_DIR 与禁用其他 settings source；Grok 使用 GROK_HOME；OpenCode使用独立 XDG/DB、禁项目配置与空 API auth；Pi 使用独立 PI_CODING_AGENT_DIR；dsh 凭据写入私有文件且仅接原生 deepseek provider。Qoder 原生认证必须由原生 CLI 验证，不能解密并自行解释 opaque 内容。相同渠道的官方 refresh 根有意持久；不同账号/组织不共用全局游标。

导入读取普通有界文件、拒绝最终文件 symlink，不改来源。OpenCode SQLite 使用 online backup 处理 WAL 后在副本切组织，并重新验证目标 account/org active。稳定 identity 决定 `import_*` ID；metadata与secret都存在时默认跳过，保护托管refresh；回滚后metadata缺失而secret保留时恢复metadata及legacy角色/blocks，直接复用托管secret/root，不复制旧来源；明确 replaceExisting 才建新随机根并原子替换 secret，保留 metadata/角色选择。revision 冲突事务回滚，未提交的新 stage/target 在 finally 清理。对于同 sourceDir 重登为另一稳定身份应产生另一渠道；没有稳定账户标识不能假定身份相同。

读取 owner 既有非敏感证据：`live-schema-migration.json` 记录真实数据库一致性副本升级，14表逐行不变（包含1230任务、101662事件）、333历史 snapshot validate、连续两次迁移稳定；`qoder-native-auth.json` 和 `native-source-migration.json` 是 owner 的原生隔离证据。该部分为证据复核，未在本 worker 重读真实凭据或重跑真实源。早期审查发现旧block重映射遗漏，已修复并经独立fixture复核，不能用升级测试绿代替这一行为检查。证据明确sourceStillSchema12=true，未升级共享0.7.9/schema12实例。原生隔离导入覆盖5个官方订阅与dsh API、7个worker，保留source hash及blocks/quota开关。

## 原生一手依据与无法证实项

- [Qoder Custom Models](https://docs.qoder.com/cli/custom-models)：通过原生 `/model` Custom 向导配置，不能假设 settings.json 可声明 provider；[CLI reference](https://docs.qoder.com/cli/cli-reference) 与 [model 命令](https://docs.qoder.com/cli/model) 提供原生模型列表/自定义 modelID。没有找到可直接作为 API-only 白名单的公开 key 前缀或 opaque schema。
- [DeepSeek 官方 Qoder 集成](https://api-docs.deepseek.com/quick_start/agent_integrations/qoder/) 区分内置模型消耗 Qoder Credits 与 Custom 使用 API 账户。单凭带 `.auth` 的根和 `auto` 不足以证明 Custom 路由。
- [Pi 官方 models.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md) 定义 `$NAME`/`${NAME}`、literal/command与转义语义；本机未实际执行 Pi 登录或远端请求，只验证导入编译结果。
- [OpenCode v1.19.4 provider源码](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/provider/provider.ts) 仅在 options.apiKey 未定义时采用 auth provider.key；据此确认显式 inline key 优先级，未调用远端账户。

OpenCode原生引用物化已实现并独立验证：`{env:NAME}`从导入环境取值，`{file:path}`仅来源根内有界普通文件；缺env、缺文件或路径逃逸拒绝。显式key继续优先，来源命令不执行；运行配置将模板左括号写成JSON unicode escape，native loader再次扫描时不会第三轮展开，JSON解析后的原值保持。[官方Config变量](https://opencode.ai/docs/config/#variables)与[v1.19.4 variable.ts](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/config/variable.ts)为一手依据。探索中env返回`{file:...}`又展开为file，核对原生本就先env再file，因此不是新blocker，也未为此扩大实现；[判定证据](review/native-substitution-order.json)。

## 最终delta独立验证

现有`channel-runtime.test.ts`实跑20/20通过；额外独立fixture不调用真实CLI，通过注入native模型列表检验18个布尔结果全部为true，见[delta结果](review/delta-results.json)与[验证汇总](review/test-summary.json)。这些fixture创建在本包专属临时根并在finally删除。

Qoder验证覆盖opaque customs与相同machine_id复制、两个相同认证副本的native list差值、完整未截断ID、API与模型列表仅接受白名单、auto/官方/未知模型拒绝、空列表/截断failclosed、customs或machine变化拒绝，以及只有官方catalog不创建API。差值列表是注入的合成输出，不是本机真实Custom请求；没有解密opaque数据。OpenCode验证覆盖env/file物化与模板第三轮防护、缺环境/文件、路径逃逸和不执行来源命令。未把fixture成功当作远端账户/协议/计费证明。

本审查没有执行任何收费推理、官方 OAuth refresh 并发或远端 provider 身份查询；也没有浏览器验收。owner 本机 Qoder `allow_byok=0`，无法给出真实 Custom/BYOK 计费成功证明。最终实现以native list与customs有无对照副本建立白名单，并在调用CLI前拒绝不在白名单的模型，无需依赖native未知ID是否回退auto；真实Custom请求和计费仍未证实。通用日志脱敏为启发式规则，不能承诺捕获任意自然语言回显秘密，本报告的新 Hello 问题仅使用现有规则明确可识别的字段。

未启动长驻进程；本worker创建的fixture目录已在脚本finally删除；长期所需布尔结果与hash均归档在本报告旁的review目录，不再链接临时脚本。专属scratch只剩探索脚本、公开源码和测试日志，owner验收归档后可回收；没有自有长驻进程。

## 恢复与公开投影最终封口

以下三类修复在Qoder/OpenCode独立delta之后落盘，本次只读核对源码、相应测试及owner已归档证据，没有重跑全量或启动HTTP服务。[封口证据摘要](review/final-corrections.json)记录检查来源及边界，旧布尔原始结果未改写。

| 修正 | 具体复核与证据 |
| --- | --- |
| 回滚恢复复用托管凭据 | `channels/import.ts`区分metadata+secret均存在的幂等skip与仅secret存在的恢复；后者不复制来源，恢复metadata后继续角色/blocks映射，在同一事务保存。`channel-runtime.test.ts`覆盖已续期凭据内容与inode不变、source不变、quota开关/角色/block恢复；也覆盖无secret但旧root存在时拒绝认领。owner[真实副本恢复证据](rollback-recovery.json)为isolatedCopyOnly=true、恢复6渠道，metadata/secret指针和值/auth文件/角色/blocks均保留。此为证据复核，未由本worker打开真实私有DB或auth。 |
| HTTP/RPC不暴露渠道临时路径 | `application/tasks/records.ts publicTaskChannelPaths`复制后删除ownerHost三条channel路径和run两条channel路径；不改持久cleanup/reattach记录。`transport/handlers.ts`的get/list/create/start/cancel统一使用该投影，保留已有owner与其他RPC字段。`task-public-paths.test.ts`覆盖有/无run、字段投影、三个写入口及原对象不变；`integration/channels-rpc.test.ts`含真实临时HTTP get/list、owner保留和持久记录不变断言。本次只读其真实HTTP用例，没有再启动服务，不把mock handler用例当独立HTTP实跑。 |
| SQL NULL与JSON历史一致 | `migrate.ts migrateChannels`先移除SQL row中值为NULL的可选字段，再调用共用policy转换，避免`worker:null`妨碍无worker聚合vendor块channel化。`channels.test.ts`以真实schema12 SQL NULL和JSON历史比较当前/历史blocks，保留真正global stall/manual暂停，复验迁移重复与rollback一致。最新[副本迁移](live-schema-migration.json)中normalizedAndHistoricalBlocksAgree=true、1230任务/101662事件逐行不变、333历史快照验证、sourceStillSchema12=true。 |

删除导入渠道后，若secret记录已删但同名旧认证根仍存在，普通重导明确拒绝认领该root；UI勾选「更新已导入的配置与认证」可新建随机root恢复，不覆盖旧根。该保护与回滚“保留secret可复用”是两条不同恢复路径。[浏览器原生错误现场](browser/orphan-root-guard/dom.json)显示普通重导拒绝及更新入口；本worker没有浏览器操作，浏览器恢复结果由owner独立验收。

## 关键文件指纹

以下为证据封口时点（包含三类后续修复）的SHA-256前16位；完整值见[文件指纹](review/file-hashes.json)。此前77项与20项测试/18个布尔结果对应原时点，不表示本轮重新运行；指纹对应工作区内容，不代表Git提交。

| 文件 | SHA-256前16位 |
| --- | --- |
| `src/main/channels/import.ts` | `6042edf251256c37` |
| `src/main/channels/runtime.ts` | `4b5e2471c780e76e` |
| `src/main/channels/service.ts` | `776d432cd3c8d2c5` |
| `src/main/channels/store.ts` | `ac332805bda8e22c` |
| `src/main/runtime.ts` | `8fef68ad8283d692` |
| `src/main/adapters/routing.ts` | `b877862facd5327e` |
| `src/main/adapters/cli/launch.ts` | `033b8d3e51377044` |
| `src/main/adapters/cli/run.ts` | `9abbb3d51bbb19d5` |
| `src/main/owner-host.ts` | `1aed626c41a65e87` |
| `src/main/im/service.ts` | `f7e50b1ae30c4858` |
| `src/main/im/parent-agent.ts` | `918408be2b964380` |
| `src/main/schedules/agent.ts` | `847e3f0ea8346be5` |
| `src/main/schedules/service.ts` | `8209ff3bc928d31b` |
| `src/main/engines/hello.ts` | `100d4de6311fad82` |
| `src/main/engines/models.ts` | `b0eed2f06234e50d` |
| `src/main/quota/index.ts` | `54aea5422cf54c17` |
| `src/main/quota/credentials.ts` | `b8973c191896890a` |
| `src/main/policy/quota.ts` | `0edaa7bbfdfba61d` |
| `src/main/migrate.ts` | `08866829eecb3f18` |
| `src/shared/policy/availability.ts` | `bf5091c2f07e33dd` |
| `src/main/channels/import-blocks.ts` | `4e41722735b7b4fe` |
| `src/main/channels/qoder.ts` | `f8f4f36724dd5303` |
| `tests/main/channel-runtime.test.ts` | `e2b376feeafe4c8a` |
| `src/main/application/tasks/records.ts` | `1018a773727f5338` |
| `src/main/transport/handlers.ts` | `2cdbe343b7a23070` |
| `tests/main/task-public-paths.test.ts` | `642731e0e80ba0ad` |
| `tests/integration/channels-rpc.test.ts` | `8e00da26b825bc92` |
| `tests/main/channels.test.ts` | `a405ebb46ac4519e` |
