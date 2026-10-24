# 账号与渠道：当前实现合同

核对日期：2026-10-24。本文描述当前源码，不表示已部署到共享服务。共享实例仍为0.7.9/schema12；此次只在真实数据库的只读在线备份副本验证升级到schema13，并在隔离认证根验证原生导入，没有升级共享实例或改动原始CLI登录。

## 模型与存储

引擎是底层可执行工具，负责安装探测、启停和CLI能力；上层一个Channel表示官方订阅账号或API连接。角色通过channel选择身份，通过model/effort选择执行参数，不再直接选engine。

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

`Config.channels`只含可公开元数据。`ChannelStore`在同一SQLite连接的私有表保存原生配置文本、key和认证根；`PolicyStore`继续管理规范表、revision、历史与回滚，两个store在同一事务提交。配置/key各限128KiB UTF-8。普通读取只返回hasConfig/hasApiKey/hasCredentials及额度摘要，不回显秘密；目录0700、文件0600，私有根在data-dir/channels，运行材料在agent-state，不放Git。

控制面接口为`getChannels`、`saveChannel`、`deleteChannel`、`importChannels`、`refreshChannelQuota`。保存将metadata与config/apiKey分开；省略秘密保持原值，空config明确清除，空key保持原key。已有渠道的engine/kind不可改；revision冲突必须重读合并。删除被角色、活动任务或定时任务引用的渠道会失败。没有单独的账号/provider/channel三层体系。

## 用户操作与启动

「账号与渠道」页管理身份、原生导入、配置、启停和账号额度；「引擎」页只管理工具安装与可用性。直接添加入口仅创建API渠道，官方订阅通过「导入已有账号或渠道」创建并可重命名；Qoder API先在原生`/model`完成Custom向导再导入，不能靠通用key/settings表单创建。父、子Agent与IM选择channel，任务详情保存安全的channel/channelLabel；历史任务没有记录时显示未记录。

导入或保存后，角色选择渠道；调度冻结channel/engine/model/effort，运行时从私有store解析binding，校验引擎ID与kind一致，再由`prepareChannelRun`编译原生配置。worker两条launcher、Herdr owner、IM、schedule、Hello、带channel模型列表及额度探针都使用该绑定。缺失绑定或引擎错配明确失败，不偷偷读另一全局账号，也不以mock替代真实执行。没有channel的安装/模型目录查询只表示只读发现能力。

native不是“同引擎就复用”：仅当所选worker与owner渠道相同、父root.run.channel也相同，且`root.run.policyRevision === current policy revision`时，调度才允许宿主内置子Agent继承身份；否则走隔离CLI。修改政策/渠道不重写既有run，native不负责热切换宿主登录。外部手工attach而没有可证明的root绑定时也不能据engine推定同账号。

## 原生覆写矩阵

| 引擎 | 官方订阅 | API与每次运行入口 | 具体限制 |
| --- | --- | --- | --- |
| Codex | 导入完整auth.json及稳定account身份到私有根 | `CODEX_HOME`；订阅生成唯一`--profile`文件，API在独立根写config.toml/auth.json，使用Responses原生provider与文件内bearer key | keyring-only不能当作可复制文件认证；API不回退OpenAI订阅 |
| Claude Code | 导入.credentials.json及精简oauthAccount元信息 | `CLAUDE_CONFIG_DIR`、`--settings <private>`、`--setting-sources ''`；API使用Messages | OS keychain不能直接复制；企业managed设置仍可高优先级；使用真实launcher |
| Grok | 导入auth.json并识别稳定OIDC身份 | `GROK_HOME`；API写`[models] default`与单数`[model."id"]`，通过env_key及原生api_backend配置 | 保留导入协议，显式protocol才覆写；不把`[models."id"]`当正确格式 |
| OpenCode | online backup原生DB，在副本选account/org并复验 | `OPENCODE_DB`、独立XDG目录、`OPENCODE_CONFIG[_DIR]`；禁项目配置，API限制provider并设空原生auth content | 不切来源全局游标；同refresh grant的额外组织导入后默认停用，需独立登录，不宣称并发续期已验 |
| Qoder | 复制原生opaque .auth/user与machine_id，用原生status确认身份 | `--config-dir`/`QODER_CONFIG_DIR`；BYOK复制有界.models，通过原生模型列表差值生成私有modelID白名单与customs哈希 | API拒绝auto/官方模型；只有catalog/default且无customs/providers不建API；仅providers或验证失败/ID截断保留停用渠道待重新导入；settings不定义BYOK |
| Pi | 不支持 | `PI_CODING_AGENT_DIR`，私有models.json/auth.json，provider+model/API协议 | 解析原生环境模板，迁移不执行`!command`；本机Pi未安装，未完成真实CLI请求验证 |
| dsh | 不支持 | `DSH_HOME`、私有.credentials.yaml、`--patch`原生凭据与provider，再应用最终权限overlay | 当前仅deepseek-official与Messages；API key必需，不从项目.env偷偷回退 |

Grok订阅只有`GROK_HOME`配置入口，没有可用的每run `--config`参数；运行时在该渠道持久根原子更新`config.toml`，API仍使用每run独立根。因此，同一Grok订阅渠道跨policy revision并发修改时，不能宣称配置完全隔离：已有进程不会被重启，但原生CLI若重新读取配置，可能读到新文件。这是当前隔离边界，未将该重读情形宣称为已实测。

进程继承环境先移除其他厂商认证及常见key/token变量；Herdr复用pane同样使用共享清理模式。秘密在私有文件，argv只出现路径或非秘密选项；Hello结果在返回/缓存前脱敏。native高级配置不能覆写最终权限patch。结束或启动失败回收本run文件，reattach使用原run路径，不重新读取全局当前账号。原生managed设置和未知版本行为仍服从CLI本身，不能承诺任意provider协议在每种CLI均受支持。

## 导入、升级与恢复

schema13为已有engine生成确定性`default_<engine-id>`渠道，将Owner/Worker.engine迁为channel，迁移quota_refresh、暂停及policy_revisions，使旧历史回滚仍可验证；Config版本不变。默认渠道是迁移引用，不代表已经有可用认证。启动时的原生导入复用现有数据迁移机制并记录完成标记；失败保留来源，用户可从渠道页明确重导。

导入读取原生官方认证、API/provider/model定义和可解析凭据，稳定账号身份、来源根和engine决定`import_*` ID。同账号的渠道metadata与secret同时存在时，重复导入默认跳过，保护托管refresh及用户选择。策略回滚保留secret却移除metadata后，普通导入恢复metadata、必要的legacy角色引用与blocks，精确复用现有托管secret和认证根，不用过时来源覆盖已续期凭据；同一原生根换成另一账号产生另一渠道。`replaceExisting:true`才更新已导入配置与认证：创建新私有根、原子切换secret，保留渠道名称、enabled和角色选择；已运行进程继续旧根。旧根没有因重导而删除，避免破坏活动进程；这不等于已实现自动认证根垃圾回收。 删除渠道后若secret记录已无而同名旧认证根仍存在，普通重导会拒绝认领；在导入弹层勾选「更新已导入的配置与认证」可新建随机root恢复，不覆盖旧根。

OpenCode复用现有原生Account类与SQLite online backup，包含WAL一致内容；枚举、选组织和认证复验均在副本中。普通API配置保留显式inline key优先于auth缓存。原生`{env:KEY}`引用在导入时物化到私有配置；`{file:path}`仅允许来源目录内的有界普通文件，拒绝逃逸/缺文件/缺环境变量，保留来源不改。没有实跑每种原生loader和远端请求，物化测试不等同完整provider兼容证明。

导入重映射角色时同步携带既有worker/channel限制和官方quota限制，真正engine级stall仍全局；同渠道的供应商限制不会扩散到后来新建API账号。乐观revision与事务保护metadata/secret一起提交，失败清理本次stage/新target，不改来源和其他运行根。

## 调度与额度

worker权重、并发和model/effort仍属于角色；启用engine、channel和role均为可调度前提。冻结channel后不能由原生全局游标改身份。旧OpenCode全局登录/switch/pool公共控制面已移除，渠道导入替代它；内部原生切组织只操作私有副本。

额度按channel探测、缓存和持久化，`channels.*.quota_refresh`控制订阅的主动刷新。订阅Codex/Claude/Grok的新鲜明确观测只增删该channel的自有quota block；API没有官方订阅额度。OpenCode Go窗口仅展示，不据此自动暂停整个engine。失败/陈旧观测保留旧限制，供应商模型错误仍走既有vendor路径；真正引擎stall继续按engine处置。共享一次订阅的多个组织不因此获得独立额度或独立refresh grant保证。

## 证据与当前边界

[数据库副本升级证据](verification/account-channels/live-schema-migration.json)记录schema12→13、历史快照验证、保留表逐行不变和重复执行稳定；[原生来源隔离导入](verification/account-channels/native-source-migration.json)覆盖Codex/Claude/Grok/Qoder/OpenCode官方认证与dsh API，来源未改且policy无秘密；[Qoder原生隔离](verification/account-channels/qoder-native-auth.json)为官方登录验证。[独立架构审查](verification/account-channels/architecture-review.md)记录已发现与修复的入口、模板、凭据优先级、暂停归属、协议和脱敏问题，以及审查时点的限制。

这些证据没有证明共享服务已经升级，也没有证明全部CLI的真实收费推理、OS keychain导入、refresh grant多组织长期并发续期。本机Qoder `allow_byok=0`，Custom/BYOK只完成隔离材料和路由约束验证，真实BYOK计费未验；Pi没有安装。CLI help/源码证明覆写入口，fixture证明编译和边界，不等同于远端账号身份与计费证明。

## 一手依据

cc-switch的[provider原生投影](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/provider/live.rs)、[Grok](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/provider/grok_direct.rs)、[Pi](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/provider/pi.rs)可参考；Weaver并发运行用私有根，不采用改写live全局文件的切换模式。

- Codex：[配置](https://github.com/openai/codex/blob/main/docs/config.md)、[认证](https://github.com/openai/codex/blob/main/docs/authentication.md)、[ModelProviderInfo](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs)。
- Claude：[目录](https://code.claude.com/docs/en/claude-directory)、[settings](https://code.claude.com/docs/en/settings)、[CLI](https://code.claude.com/docs/en/cli-reference)。
- OpenCode v1.19.4：[config](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/config/config.ts)、[auth](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/auth/index.ts)、[account续期](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/account/account.ts)、[provider优先级](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/provider/provider.ts)。
- Grok：[settings](https://docs.x.ai/build/settings)、[overview](https://docs.x.ai/build/overview)。
- Qoder：[CLI](https://docs.qoder.com/cli/cli-reference)、[Custom Models](https://docs.qoder.com/cli/custom-models)、[model](https://docs.qoder.com/cli/model)。
- Pi：[配置目录源码](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/config.ts)、[models与凭据模板](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)。
- dsh：[CLI reference源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)、[启动配置](https://deepseekdocs.com/en/docs/learn/core/boot-config)。
