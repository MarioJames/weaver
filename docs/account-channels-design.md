# 账号与渠道：当前实现合同

首次验收日期：2026-10-24。当时共享实例为0.7.9/schema12，仅在真实数据库的只读在线备份副本验证schema13和隔离原生导入。2026-10-25已将真实共享实例升级至schema13并完成原生导入；本地维护的实际结果、IM绑定修复与保留范围见[本地升级验收报告](verification/account-channels/local-upgrade/REPORT.html)。原始CLI登录来源保持不变。

## 模型与存储

引擎是底层可执行工具目录，负责安装探测和CLI能力；上层一个Channel表示官方订阅账号或API连接。角色通过channel选择身份，通过model/effort选择执行参数，不再直接选engine。

```ts
interface Channel {
  engine: string; // policy engine ID，可为别名；实际kind从config.engines解析
  label: string;
  kind: 'subscription' | 'api';
  enabled: boolean;
  provider?: string;
  baseUrl?: string;
  protocol?: 'anthropic' | 'openai' | 'openai-responses';
  quota_refresh?: boolean;
}
interface ChannelSecret { config?: string; apiKey?: string; authDir?: string }
// Config.version仍为1；channels为Record<string,Channel>。
// Owner/Worker使用channel、model、effort；roleEngine(config,role)解析engine ID。
```

`Config.channels`只含可公开元数据。`ChannelStore`在同一SQLite连接的私有表保存原生配置文本、key和认证根；`PolicyStore`继续管理规范表、revision、历史与回滚，两个store在同一事务提交。配置/key各限128KiB UTF-8。普通读取只返回hasConfig/hasApiKey/hasCredentials及额度摘要，不回显秘密；Weaver创建的私有目录0700、配置秘密文件0600；原生CLI随后生成的cache子文件权限可能不同，须核对私有祖先目录。私有根在data-dir/channels，运行材料在agent-state，不放Git。

控制面接口为`getChannels`、`saveChannel`、`deleteChannel`、`importChannels`、`refreshChannelQuota`，以及`startChannelLogin`、`getChannelLogin`、`submitChannelLoginCode`、`cancelChannelLogin`。`saveChannel`返回`SaveChannelResult extends ChannelsSnapshot`，其中`savedChannel`是本次保存的精确ID；新官方账号登录必须使用它，不通过列表差集猜测。保存将metadata与config/apiKey分开；省略秘密保持原值，空config明确清除，空key保持原key。已有渠道的engine/kind不可改；revision冲突必须重读合并。删除被角色、活动任务或定时任务引用的渠道会失败。没有单独的账号/provider/channel三层体系。

## 用户操作与启动

「账号与渠道」页管理身份、原生导入、配置、启停和账号额度。列表随页面滚动，弹层正文独立滚动，操作按钮保持可达；这是当前布局合同，实际滚轮、PageDown、焦点与窄屏表现由独立浏览器验收确认。「引擎」页及用户启用引擎开关已删除，安装/版本诊断保留。工具目录默认全部可用，实际执行仍需CLI安装、账号与角色启用、凭据和未被限制的路由。

添加账号可选择官方订阅或API：Codex、Claude、Grok、OpenCode、Qoder支持新建官方账号并在独立私有根原生登录，也支持导入已有身份；Pi和dsh仅支持API。Qoder API先在原生`/model`完成Custom向导再导入，不能靠通用key/settings表单创建。父、子Agent与IM选择channel，任务详情保存安全的channel/channelLabel；历史任务没有记录时显示未记录。

官方账号保存时建立`data-dir/channels/<id>/native`私有根及`.weaver-login-pending`标记；空根不算凭据就绪。已有合法legacy官方渠道无根时，显式开始登录会在事务中分配根，失败回滚并清理本次新根。API、已删除、不支持的账号拒绝登录；已有认证的账号不能通过登录原地换身份，应新建账号。

登录DTO来自`src/shared/contracts/channels.ts`：

```ts
startChannelLogin({ channel }): Promise<ChannelLogin>
getChannelLogin({ channel, id }): Promise<ChannelLogin>
submitChannelLoginCode({ channel, id, code }): Promise<ChannelLogin>
cancelChannelLogin({ channel, id }): Promise<ChannelLogin>
// status: starting | authorizing | verifying | succeeded | failed | cancelled
// 可选 verificationUrl、userCode、acceptsCode、identity: { label }、error: { code, message }
```

登录job在服务内存中，读取/取消必须匹配账号和精确job ID；同账号活动登录复用job。界面仅缓存job引用，关闭弹层不取消，明确取消只停止此次原生登录进程。服务重启后旧job可能不存在，需重试；迟到响应不能切换到别的账号。只有CLI退出成功且strict身份复验成功才移除pending；失败/取消不冒充ready，可在同一待登录根重试。界面成功后重读`getChannels`，不自行设定`hasCredentials`。

| 官方引擎 | 私有根中的实际登录入口 | 成功复验 |
| --- | --- | --- |
| Codex | `CODEX_HOME`，`login --device-auth` | strict材料检查及`login status`的ChatGPT身份 |
| Claude | `CLAUDE_CONFIG_DIR`，`auth login --claudeai` | strict材料及`auth status --json`的claude.ai身份 |
| Grok | `GROK_HOME`，`--leader-socket <root>/leader.sock login --device-auth` | strict材料及官方OIDC userinfo的subject匹配 |
| OpenCode | 私有`OPENCODE_DB`/XDG根，`console login https://opencode.ai/console --pure` | 副本Account状态中opencode-go与活动组织 |
| Qoder | `QODER_CONFIG_DIR`及`--config-dir <root> login` | strict材料及私有根`status --output json`的登录身份 |

Claude原生manual流程显示官方链接、密码输入与提交按钮；本人将官方完整`code#state`通过浏览器RPC `submitChannelLoginCode`传给当前job的自有stdin。不新增CLI code命令或别名；不将返回码放argv、数据库或sessionStorage。参数错误/写入失败保留输入，正常发送后清空，仍等待原生验证；发送不等于登录成功。Codex/Grok/OpenCode显示原生设备码，Qoder使用完整官方设备链接。

新OAuth必须由本人在官方页面授权；源码和fixture不能证明这些真实授权流程均已通过。已有Codex/Claude/Grok本地材料在access过期但含合法非空refresh时允许交由原生CLI续期，`hasCredentials`只表示本地材料可用，不证明远端token、订阅、额度有效；新登录strict检查不以refresh替代当前access。pending账号始终不能运行。OpenCode原生DB按非空普通文件及只读`account_state`活动账号/组织检查，不套普通配置文件512KiB上限。

导入或保存后，角色选择渠道；调度冻结channel/engine/model/effort，运行时从私有store解析binding，校验引擎ID与kind一致，再由`prepareChannelRun`编译原生配置。worker两条launcher、Herdr owner、IM、schedule、Hello、带channel模型列表及额度探针都使用该绑定。缺失绑定或引擎错配明确失败，不偷偷读另一全局账号，也不以mock替代真实执行。没有channel的安装/模型目录查询只表示只读发现能力。

native不是“同引擎就复用”：仅当所选worker与owner渠道相同、父root.run.channel也相同，且`root.run.policyRevision === current policy revision`时，调度才允许宿主内置子Agent继承身份；否则走隔离CLI。修改政策/渠道不重写既有run，native不负责热切换宿主登录。外部手工attach而没有可证明的root绑定时也不能据engine推定同账号。

## 原生覆写矩阵

| 引擎 | 官方订阅 | API与每次运行入口 | 具体限制 |
| --- | --- | --- | --- |
| Codex | 导入完整auth.json及稳定account身份到私有根 | `CODEX_HOME`；订阅推理生成唯一`--profile`文件，API在独立根写config.toml/auth.json，使用Responses原生provider与文件内bearer key | keyring-only不能当作可复制文件认证；API不回退OpenAI订阅 |
| Claude Code | 导入.credentials.json及精简oauthAccount元信息 | `CLAUDE_CONFIG_DIR`、`--settings <private>`、`--setting-sources ''`；API使用Messages | OS keychain不能直接复制；企业managed设置仍可高优先级；使用真实launcher |
| Grok | 导入auth.json并识别稳定OIDC身份 | `GROK_HOME`；API写`[models] default`与单数`[model."id"]`，通过env_key及原生api_backend配置 | 保留导入协议，显式protocol才覆写；不把`[models."id"]`当正确格式 |
| OpenCode | online backup原生DB，在副本选account/org并复验 | `OPENCODE_DB`、独立XDG目录、`OPENCODE_CONFIG[_DIR]`；禁项目配置，API限制provider并设空原生auth content | 不切来源全局游标；同refresh grant的额外组织导入后默认停用，需独立登录，不宣称并发续期已验 |
| Qoder | 复制原生opaque .auth/user与machine_id，用原生status确认身份 | `--config-dir`/`QODER_CONFIG_DIR`；BYOK复制有界.models，通过原生模型列表差值生成私有modelID白名单与customs哈希 | API拒绝auto/官方模型；只有catalog/default且无customs/providers不建API；仅providers或验证失败/ID截断保留停用渠道待重新导入；settings不定义BYOK |
| Pi | 不支持 | `PI_CODING_AGENT_DIR`，私有models.json/auth.json，provider+model/API协议 | 解析原生环境模板，迁移不执行`!command`；2026-10-25已安装Pi 1.4.0，但无可用凭据，未完成真实CLI请求验证 |
| dsh | 不支持 | `DSH_HOME`、私有.credentials.yaml、`--patch`原生凭据与provider，再应用最终权限overlay | 当前仅deepseek-official与Messages；API key必需，不从项目.env偷偷回退 |

Grok订阅只有`GROK_HOME`配置入口，没有可用的每run `--config`参数；运行时在该渠道持久根原子更新`config.toml`，API仍使用每run独立根。因此，同一Grok订阅渠道跨policy revision并发修改时，不能宣称配置完全隔离：已有进程不会被重启，但原生CLI若重新读取配置，可能读到新文件。这是当前隔离边界，未将该重读情形宣称为已实测。

进程继承环境先移除其他厂商认证及常见key/token变量；Herdr复用pane同样使用共享清理模式。秘密在私有文件，argv只出现路径或非秘密选项；Hello结果在返回/缓存前脱敏。native高级配置不能覆写最终权限patch。结束或启动失败回收本run文件，reattach使用原run路径，不重新读取全局当前账号。原生managed设置和未知版本行为仍服从CLI本身，不能承诺任意provider协议在每种CLI均受支持。

模型目录按`source/status`区分：Codex使用原生`debug models`，该子命令不接受runtime `--profile`，但仍使用所选账号的`CODEX_HOME`及API配置；实际推理继续指定所选root/profile。Claude没有原生列表命令，返回内置名称与私有settings配置；dsh为应用内置advisory模型名，不能冒充供应商live目录。其他CLI目录成功也不证明所选模型已成功推理。

## 导入、升级与恢复

schema13为已有engine生成确定性`default_<engine-id>`渠道，将Owner/Worker.engine迁为channel，迁移quota_refresh、暂停及policy_revisions，使旧历史回滚仍可验证；Config版本不变。默认渠道是迁移引用，不代表已经有可用认证。启动时的原生导入复用现有数据迁移机制并记录完成标记；失败保留来源，用户可从渠道页明确重导。

`importChannels(input)`返回`ImportChannelsResult extends ChannelsSnapshot`，附本次操作的`importResult: { added, existing, updated, notFound, failures }`。前三项分别为新metadata身份数、幂等保留数、显式更新数；`notFound`是本次扫描无候选的engine ID，不等于CLI未安装；`failures`为`{ engine, message }[]`安全错误。部分成功返回实际回执；无可导、全部失败、不合法输入或事务错误拒绝，不能显示假完成。`getChannels`不持久保存操作回执。界面保留零项/部分失败结果、来源/引擎/更新选项，关闭后仍提示部分失败，允许单独选失败引擎与来源重试。2026-10-25首次导入专项实测发现：无有效token的Claude来源仍返回added=1而hasCredentials=false；首次全部导入在UI 15秒超时后后端才提交6条来源。该时点两项为失败，不能用已有记录的幂等existing结果掩盖，详见[首次导入复验](verification/account-channels/import-specific/REPORT.html)。

导入读取原生官方认证、API/provider/model定义和可解析凭据，稳定账号身份、来源根和engine决定`import_*` ID。同账号的渠道metadata与secret同时存在时，重复导入默认跳过，保护托管refresh及用户选择。策略回滚保留secret却移除metadata后，普通导入恢复metadata、必要的legacy角色引用与blocks，精确复用现有托管secret和认证根，不用过时来源覆盖已续期凭据；同一原生根换成另一账号产生另一渠道。`replaceExisting:true`才更新已导入配置与认证：创建新私有根、原子切换secret，保留渠道名称、enabled和角色选择；已运行进程继续旧根。旧根没有因重导而删除，避免破坏活动进程；这不等于已实现自动认证根垃圾回收。 删除渠道后若secret记录已无而同名旧认证根仍存在，普通重导会拒绝认领；在导入弹层勾选「更新已导入的配置与认证」可新建随机root恢复，不覆盖旧根。

OpenCode复用现有原生Account类与SQLite online backup，包含WAL一致内容；枚举、选组织和认证复验均在副本中。普通API配置保留显式inline key优先于auth缓存。原生`{env:KEY}`引用在导入时物化到私有配置；`{file:path}`仅允许来源目录内的有界普通文件，拒绝逃逸/缺文件/缺环境变量，保留来源不改。没有实跑每种原生loader和远端请求，物化测试不等同完整provider兼容证明。

导入重映射角色时同步携带既有worker/channel限制和官方quota限制，真正engine级stall仍全局；同渠道的供应商限制不会扩散到后来新建API账号。乐观revision与事务保护metadata/secret一起提交，失败清理本次stage/新target，不改来源和其他运行根。

## 调度与额度

worker权重、并发和model/effort仍属于角色；channel和role启用及既有blocks共同决定可调度性。引擎目录不提供用户停用开关；SQL schema13的`policy_engines.enabled`仅为兼容字段，读取恒true、写入恒1。`PolicyStore.parse`归一历史表/回滚快照中的引擎布尔值并补齐目录，读取不重写历史行；新save明确禁止`engine.enabled=false`，提示改为停用账号或角色。删除引擎页不解除角色/账号停用、quota、manual或stall限制。冻结channel后不能由原生全局游标改身份。旧OpenCode全局登录/switch/pool公共控制面已移除，渠道导入替代它；内部原生切组织只操作私有副本。

额度按channel探测、缓存和持久化，`channels.*.quota_refresh`控制订阅的主动刷新。订阅Codex/Claude/Grok的新鲜明确观测只增删该channel的自有quota block；API没有官方订阅额度。OpenCode Go窗口仅展示，不据此自动暂停整个engine。失败/陈旧观测保留旧限制，供应商模型错误仍走既有vendor路径；真正引擎stall继续按engine处置。共享一次订阅的多个组织不因此获得独立额度或独立refresh grant保证。

## 证据与当前边界

[数据库副本升级证据](verification/account-channels/live-schema-migration.json)记录schema12→13、历史快照验证、保留表逐行不变和重复执行稳定；[原生来源隔离导入](verification/account-channels/native-source-migration.json)覆盖Codex/Claude/Grok/Qoder/OpenCode官方认证与dsh API，来源未改且policy无秘密；[Qoder原生隔离](verification/account-channels/qoder-native-auth.json)为导入的原生官方认证验证，不是新OAuth授权全过程。[独立架构审查](verification/account-channels/architecture-review.md)记录已发现与修复的入口、模板、凭据优先级、暂停归属、协议和脱敏问题，以及审查时点的限制。

上述2026-10-24副本/合成验收不证明当时共享服务已升级；2026-10-25[本地升级报告](verification/account-channels/local-upgrade/REPORT.html)另行证明生产4737、PID1109320已到schema13，并明确整体产品验收未通过。该报告保留用户实报滚动、导入与新官方登录未覆盖的撤回结论，后续源码修复不能抹去这一历史边界。

2026-10-25独立真实测试环境已安装7个CLI（含Pi 1.4.0），导入5个真实订阅与dsh API；Pi仍无可用凭据，见[真实环境说明](testing-real-engines.md)。首次真实Hello（04:33–04:36 UTC）Codex、Claude、Qoder、dsh返回精确hi；Grok退出0但未解析到回复，OpenCode在120秒超时。一次正式Codex worker完成并accepted，观察到私有根进程绑定。这些是首次有限证据，Grok/OpenCode Hello适配正在纠偏与复验，不将诊断推测写成永久限制，也不把四项成功当成最终总体通过。

首次验收及2026-10-25本地升级报告记录Pi未安装及Qoder `allow_byok=0`，仅代表当时时点；当前Qoder BYOK/license路径未验，不据旧值推断当前license。全部CLI正式worker矩阵、新官方OAuth本人授权、owner/IM/定时推理完整链路、OS keychain导入及同refresh grant多组织长期并发续期仍不能宣称通过。CLI help/源码证明覆写入口，fixture证明编译和边界，不等同于远端账号身份与计费证明。最终独立浏览器HTML另行交付，本说明不是验收报告。

## 2026-10-25冻结版独立复验

[最终真实浏览器报告](verification/account-channels/real-test-final/REPORT.html)固定应用摘要`1c092161ceed7008012cdf22548f919e919033dc24d6df0601ed867be7117f88`，与[首轮失败报告](verification/account-channels/real-test/REPORT.html)分别保留。草稿归属/继续/放弃、dsh非法`{}`原子拒绝与合法`[]`的真实API Hello、五官方入口所需链接/码/Claude手工输入、滚动及4738幂等导入已复验；该时点完整OAuth仍需本人完成，首次导入两项失败仍阻断整体放行；后续首次导入复验结果见下文，旧失败记录保留。dsh提交的非空配置必须是原生YAML patch列表，不能把`{}`当合法对象；省略保留，空串明确清除。

[分时点真实引擎证据](verification/account-channels/real-test-final/engine-evidence.json)保留Codex/Claude/Qoder/dsh早期精确hi、Grok首轮解析失败后纠偏与真实HTTP成功、正式Codex任务completed/real/WEAVER_REAL_OK/ack/accepted及原生根绑定。OpenCode Go用量耗尽，Pi无凭据，不计推理通过；这些早期调用不能全算作本次最终源码摘要上的新调用。环境/工程检查与浏览器验收分开记载。

## 一手依据

cc-switch的[provider原生投影](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/provider/live.rs)、[Grok](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/provider/grok_direct.rs)、[Pi](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/provider/pi.rs)可参考；Weaver并发运行用私有根，不采用改写live全局文件的切换模式。

- Codex：[配置](https://github.com/openai/codex/blob/main/docs/config.md)、[认证](https://github.com/openai/codex/blob/main/docs/authentication.md)、[ModelProviderInfo](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs)。
- Claude：[目录](https://code.claude.com/docs/en/claude-directory)、[settings](https://code.claude.com/docs/en/settings)、[CLI](https://code.claude.com/docs/en/cli-reference)。
- OpenCode v1.19.4：[config](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/config/config.ts)、[auth](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/auth/index.ts)、[account续期](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/account/account.ts)、[provider优先级](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/provider/provider.ts)。
- Grok：[settings](https://docs.x.ai/build/settings)、[overview](https://docs.x.ai/build/overview)。
- Qoder：[CLI](https://docs.qoder.com/cli/cli-reference)、[Custom Models](https://docs.qoder.com/cli/custom-models)、[model](https://docs.qoder.com/cli/model)。
- Pi：[配置目录源码](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/config.ts)、[models与凭据模板](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)。
- dsh：[CLI reference源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)、[启动配置](https://deepseekdocs.com/en/docs/learn/core/boot-config)。


2026-10-25 06:14–06:17 UTC，[修复后真实交付复验](verification/account-channels/real-delivery-verified/REPORT.html)在摘要 `0c424a5506a69109cfbac6c75ef71624caf8ade40751dd57c57e231ee5fc3be2` 上完成两个独立新 SQLite 库的默认首次 UI 导入（`autoImport:false`，初始7占位、0 secrets）。A 默认 Claude：added=1/existing=0、hasCredentials=true、39ms，重复 existing=1；B 默认全部：added=6/existing=0、Pi notFound、failures空、16102ms完整HTTP 200，重复 Claude existing=1。每次确认仅一个mutation，无自动重发，无旧15秒TIMEOUT，revision均0→1后幂等保持1。A私有凭据与源相同；B为5个订阅私有根加dsh API key，共6 secrets，对应6新增metadata。dsh无持久authDir，不能误报为六个原生根。

用户本人在本轮前恢复了默认Claude登录；这不是Weaver修复源凭据，也不等于新建官方账号OAuth端到端通过。浏览器验收包于2026-10-25 06:14:52.477 UTC完成fresh A私有Claude账号的一次正常sayHi/sayHiResult：sonnet/medium，ok=true、精确hi，原生模型claude-sonnet-5-5，4940ms。owner另在持久4738幂等检查结束后、06:18:45.546 UTC最终工程回执前，对既有私有Claude账号正常调用一次sonnet/medium，done、ok=true、精确hi，原生模型claude-sonnet-5-5，6271ms。两次实际/proc观察均证实CLAUDE_CONFIG_DIR、CLAUDE_SECURESTORAGE_CONFIG_DIR和ANTHROPIC_CONFIG_DIR绑定各自私有根；owner调用前后三个全局来源文件未变，仅归档未变布尔值。fresh A调用前后及清理前全局Claude凭据与metadata字节一致。登录selector仅核对共享函数环境构造，未启动新登录作业；本轮没有重新执行全引擎推理矩阵。

持久4738本轮UI默认Claude/全部分别existing=1/6，无新增更新；revision47、18渠道、11 secrets保持，原secret/root内容hash一致。owner同摘要最新`npm run check`于2026-10-25 06:17:57.762–06:18:45.546 UTC自然退出0，约48秒：2184 tests，2152 pass，32 skip，0 fail，typecheck/build通过。测试侧fake worker的close/drain/shutdown与store finally收尾已修正，没有因此修改产品行为。此前06:14:34 UTC完成的约136秒检查也自然退出0，未向该检查发送SIGTERM，不能写成永久死锁或被终止。A/B scope、DB/auth/cache、自有Chrome/profile与Herdr workspace已精确回收，源码前后hash一致。旧失败报告、分时点引擎证据、五新官方OAuth未全完成、OpenCode Go限额/Pi无key和既有临时设备码/query事故事实均保留；生产4737未部署本轮修复，用户测试地址为http://127.0.0.1:4738。

安全汇总见[owner最终核对](verification/account-channels/real-delivery-verified/owner-review.json)，与[最终交付报告](verification/account-channels/real-delivery-verified/REPORT.html)配合阅读。feature-acceptance扫描退出2/incomplete：3个用户原有`.worktrees`目录非普通文件被跳过；24条candidate（21条深相对导入、3条报告局部颜色）仅为人工复核线索，未激活门禁，不能称扫描全绿。owner另精确SIGTERM释放第一次无效`/proc` TMPDIR整套测试留下的独立模拟OpenCode PID1367928；fixture属于本任务final-check-tmp，非真实供应商进程或持久服务，未删除schema或数据。这里只核对已有安全证据并修正文档，没有运行引擎、浏览器、测试或服务。
