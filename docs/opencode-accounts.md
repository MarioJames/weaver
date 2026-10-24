# OpenCode Console 账号

引擎卡片中的账号面板通过本机 OpenCode 的原生 Console 接口查询账号和组织。查询可能触发原生 token 续期。账号面板、显式额度刷新和首个排队 Go 任务的账号发现会按需启动临时 helper；引擎扫描与额度缓存读取不会加载账号。

登录运行固定命令 `opencode console login https://opencode.ai/console --pure`。原生 CLI 负责设备授权、轮询、token 和持久化，并尝试打开本机浏览器；面板同时显示原生返回的官方 HTTPS 链接和验证码。Weaver 只提取有界输出中的官方链接、验证码和成功标记，不将原始日志或凭据返回浏览器。取消或超时会终止自有进程；授权与取消同时发生时账号可能已经保存，应重新读取状态。关闭面板再打开可恢复当前 runtime 中的登录任务；重启 Weaver 后不保留登录 job。

查询和切换短时运行 `opencode serve --pure --hostname 127.0.0.1 --port 0`，使用随机 Basic 密码，地址和密码仅保留在主进程。请求拒绝重定向，API 不可用时明确报错，不回退到数据库写入。临时服务与登录进程沿用相同 HOME、XDG_DATA_HOME 和 OPENCODE_DB，通过现有 OwnedScope 管理及确认精确回收。Weaver 不修改 auth.json，不复制 token，不移动会话数据库。额度读取遵守原生 OPENCODE_DB 的绝对、相对及 `:memory:` 解析。

账号变更与所有受控 OpenCode 启动入口共用互斥保护；切换前核对原生列表中的账号与组织组合，以及调用者观察到的 active 账号。该检查用于发现已经发生的外部变化，不是与其他独立 OpenCode 进程之间的数据库事务锁。切换后结束 helper，再启动新 helper 验证组织与 managed providers，避免读取旧 instance 缓存。当前面板只展示官方 Console 来源的组织；原生查询可能省略暂时无法连接的账号。

只有原生新配置明确列出 `opencode-go` 为 Console 管理的 provider，才能确认 Go 凭证跟随该组织；否则面板警告仍可能使用既有 API key，不自动删除其他 provider 的认证、不反向切换。成功后失效 OpenCode 模型缓存并刷新额度；额度刷新失败仍如实报告账号已切换。手动 block 不受账号切换清除。

额度面板用 Segmented 按“账号 + 组织”查看各自额度；查看 B 不会改变当前 A。只有显式“设为当前”或下面的自动调度流程才切换原生游标。每个组合独立保存额度、更新时间、陈旧状态与冷却；`getOpenCodeAccountQuotas` 只读缓存，刷新只接受空参数或一对账号/组织 ID。缓存与处理过的失败 run ID 放在 Weaver 的专用 KV 中，不存 token，重启后的历史观测先按陈旧状态处理。

自动切换只处理尚未启动的真实 `opencode-go/*` 排队任务。首次 Go admission 会发现账号并读取额度；无 Console、只有一个账号或当前额度未知且没有实际账号失败证据时沿用原派发路径。多账号的当前账号已确认耗尽或仍有待恢复的账号失败时，调度器选择近期确认有额度、Go 配置可用且未冷却的其他账号；过期与未知观测不能成为替换候选。没有候选时任务保留排队原因，完成通知、刷新或定时复查可继续调度，其他引擎与免费模型不因 Go 额度池耗尽停用。

自动切换须等待所有 OpenCode 任务真实结束，包括正在准备、取消、停止或恢复未完成的 run，以及连通性/恢复探测和定时任务进程。Linux 只读取同用户 `/proc` 的 executable 链接确认外部原生进程；发现外部进程或无法确认时等待，不关闭它们。其他平台不能证明外部进程空闲，自动切换暂停。启用 OpenCode IM 配置时保守视为保留中的会话/备用服务，等待释放，不调用 IM 重连或关闭来换账号。人工登录/切换也遵守这条等待边界。

每个可归因 run 保存安全的账号/组织 ID 和世代；TaskManager 在 start 与实际 beforeSpawn 再次同步核对 gate、捕获身份和原生只读游标。已归因 Go run 的额度、限流、认证失败按捕获账号冷却，不把 A 的失败封到 B 所用的 worker。人工、stall 和历史无账号归因的 vendor block 保守保留。自动切换不重放任何失败任务，即使任务尚无首条输出；已产生文件修改的失败任务仍保持失败。切换后还要核对原生 active、Go managed providers 与近期额度，无法确认时等待重新读取，不盲目反向切换。

**仅之后新启动进程生效，长驻进程需要重新启动。** 已运行任务、外部服务和其他长驻 OpenCode 实例保留其缓存；本功能不会终止已有任务，不承诺跨进程热切换。原生写入后复验失败会提示状态可能已变更，应重新查询，不能据此认定没有切换。

原生接口依据：本机官方 OpenCode 1.19.4 bundled 源码中的 `experimental.console.listOrgs` (`GET /experimental/console/orgs`)、`experimental.console.get` (`GET /experimental/console`) 和 `experimental.console.switchOrg` (`POST /experimental/console/switch`)，以及原生 Console CLI 的 `login` 流程。官方项目与文档：[OpenCode](https://github.com/anomalyco/opencode)、[CLI](https://opencode.ai/docs/cli/)、[Server](https://opencode.ai/docs/server/)。experimental API 可能随版本变化；不支持时安全失败。
