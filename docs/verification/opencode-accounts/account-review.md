# OpenCode 多账号最终独立审查

状态：**通过。当前版本未发现仍然阻断交付的实质问题。**

本轮只读审查，没有修改产品或测试。backend作者确认最后隔离守卫、坏库启动降级、TTL重验证与IM入口修正完成后，再次读取当前源码并独立验证。没有读取真实token，没有发起真实认证/额度查询/账号切换，没有启动真实OpenCode。浏览器验收由其他worker负责。

## 实质发现的处置

| 发现 | 最终修正证据 | 回归证据 |
| --- | --- | --- |
| 默认额度prober未继承隔离env；仅native factory替身会误授权真实凭据reader | runtime.ts:152将helper、pool和游标读取资格分别校验；:199通用quota在读取前校验；:345默认prober继承显式openCode.env | opencode-account-rpc.test.ts的native factory-only拒绝与HTTP查询回归通过 |
| IM parent真实启动和cleanup未共享账号变更gate | runtime.ts:334在factory调用前取得lease，保留custom/default background、dataDir、signal；:189 cleanup在spawn前acquire；engines/cleanup.ts:26持有到子进程结果收束 | cleanup租约拒绝不建job、不消耗preview、覆盖preview/apply与错误释放的3项回归通过；IM取消信号路径作当前源码复核 |
| 首次发现后Go证明过期，下一任务失去账号归因，限额退回worker封禁 | scheduling/opencode-accounts.ts:78、:94、:133记录曾验证pair并在无UI活动的证明过期时有界重查；保留全新unknown及单账号旧路径 | expired Go proof without UI测试通过：受控时间+6分钟，重新捕获A，失败后换B |
| 可选OpenCode坏库导致整个Weaver启动失败 | runtime.ts:317读游标失败降级为cursorUnavailable；scheduling/opencode-accounts.ts:169仅围栏OpenCode并保留服务启动 | 持久safe pool缓存+真正损坏fixture native.db，启动成功/getPolicy可用/active=null且stale的HTTP回归通过 |

以上发现均已直接通知父与backend作者，最终复读确认修正，不将旧版本问题列为未修复。

## 核心一致性核查

- scheduling/opencode-accounts.ts:101仅在可信Go证明存在时捕获账号/组织/generation；manager.ts:123先捕获再建立run，:179在真实beforeSpawn许可再次校验。文件模式与legacy模式均有guard；跨await后游标或generation不符拒绝启动。
- 自动切换singleflight、mutation gate、待真实进程回收与lease机制共用。running/cancelling/未finalized、hello/恢复probe、schedule parent/CLI、IM及maintenance会阻止游标写；外部进程在Linux只读扫描，同用户原生OpenCode存活时保守等待，不终止它。
- 首次CLI Go admission自行发现额度池，不要求先开页面。当前已证实耗尽才自动选其他fresh available+goReady且无冷却的pair；目标写后再次检查原生managed provider及pool证据。未知额度/单账号保留原执行路径；全部无候选走有界重查与idle通知，没有主动重放failed任务。
- vendor-limits.ts按run捕获身份归因A失败，已归因账号限额不生成worker/engine封禁。hasFailure在冷却到期后仍保留，只有失败之后fresh恢复才释放；manual/stall/external/旧无归因block不自动删除。
- pool缓存以DB身份+账号/组织隔离；Segmented额度组件只调用get/refresh，未调用switch。候选Go证据绑定凭据指纹和有效期；列表遗漏保留stale历史，不继续作候选。account_state/session/其他auth fixture保持不变。
- nativehelper固定loopback+随机Basic密码、禁止redirect、限响应大小；公开DTO投影不携带token或配置key。登录取消/授权竞态会提示原生状态可能已变化，不把denied但exit=0误报成功。原生写后复验失败不盲目回滚。
- pool.close跟踪refresh并取消listing等待，probe已关闭后不late persist。runtime先停止admission并在store.close前等待pool/native/account work，保留既有启动失败与关闭错误报告。
- 原API-key额度路径仍由QuotaProber/readNativeCredential承担，未因pool抽取删除；Console absent仍回退既有API-key凭据，present-invalid状态仍fail closed。

## 独立验证

最终命令：

```sh
node --import tsx --test tests/main/opencode-account-admission.test.ts tests/main/opencode-pool.test.ts tests/main/opencode-accounts.test.ts tests/main/quota-console.test.ts tests/integration/opencode-account-rpc.test.ts tests/integration/architecture-boundaries.test.ts tests/main/engine-cleanup-api.test.ts
npm run typecheck
git diff --check
```

结果：**63 tests通过，0失败、0跳过；typecheck与diff检查通过。** 组成：架构9、HTTP账号RPC3、cleanup6、admission11、accounts8、pool14、Console12。测试使用隔离SQLite与fake原生/HTTP边界；maintenance测试仅启动针对一次性fixture DB的Node清理子进程。

## 验证限制

真实多订阅授权、线上Go配置/额度与真实供应商推理没有执行，不能据此声称真实账号切换已实测。独立OpenCode进程不受Weaver跨进程事务控制；已有长驻进程保留旧配置，自动切换等待它们释放，不能承诺热切换。浏览器交互/视觉检查不在本包结论内。

## 已审读版本摘要

- `src/main/application/scheduling/opencode-accounts.ts`：`e8778dd3144e6c19c8b137d74bc01c3279082aa0a308593dabdfbe48b8725457`
- `src/main/runtime.ts`：`c166efbf7cb7619b56090118a8b498f6f6b4553ef7aee78b4839f9318773eb79`
- `src/main/manager.ts`：`a194c7c7ccc32fafca42b4617439bd4bd534ce272aa3dba2963de330dc766814`
- `src/main/application/scheduling/vendor-limits.ts`：`2a530514bcab7009da33622399a2e38bca5bc06455bd32109e3210e649b78e62`
- `src/main/engines/opencode-accounts.ts`：`f2cecfa0087cf6d86ab419546153922bc4d7893547740163c6c4c6904aed866f`
- `src/main/quota/opencode-pool.ts`：`54b608897cc968e0649925ad7a08f9d5169b3bc89fd9f6e931b75495dd4f3f3c`
- `src/main/engines/cleanup.ts`：`abf810eb112cc02088e148bda8fa49dcfe6009824daa16ceeeea0c3d2723f2fc`
