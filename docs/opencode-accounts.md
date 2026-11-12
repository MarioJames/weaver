# OpenCode 2.2.x 账号与凭据

本说明对应 OpenCode 2.2.7 实测。Weaver 只为每个官方渠道维护独立私有根（`OPENCODE_DB`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME`、`XDG_CACHE_HOME`、`OPENCODE_CONFIG_DIR`），不再通过 `opencode serve --pure`、`/experimental/console/*` 或全局账号游标查询/切换账号；旧版 `opencode console login` 也已不存在。

## 登录

新官方账号运行 `opencode auth login opencode --method device --standalone`。原生 CLI 负责设备授权、轮询和持久化；面板显示原生输出的 `Enter code: ...` 与 `https://opencode.ai/console/device?user_code=...&client_id=...` 链接。Weaver 只提取有界输出中的官方链接/验证码，不返回原始日志或凭据。取消或超时会终止自有进程；授权与取消同时发生时原生状态可能已更新，应重新读取状态。

重新登录（`relogin: true`）在渠道根同级的临时根执行同一命令，不写原根。成功且身份与旧账号一致后，事务性把渠道 `authDir` 指向新根；新启动进程使用新凭据，运行中的任务继续原根。失败、取消、身份不一致和服务重启都不改动原凭据。

## 就绪与导入

2.2.x 把推理凭据放在 `opencode.db` 的 `credential` 表，`integration_id=opencode-go`、`label` 通常为 `OpenCode Go`，值为 `{"type":"key","key":"..."}`。`account`/`account_state` 是保留的 legacy 表，不能单独证明模型可用。就绪判断要求私有根存在非空 `opencode-go` 凭据；登录和导入还必须实际运行 `opencode models --standalone` 并看到至少一个 `opencode-go/` 模型。

导入用 SQLite online backup 复制完整来源数据库（含 WAL 一致内容和 `credential` 表）到临时副本，只读检查凭据、执行模型目录验证，再建立私有根。这样同时保留 `account_state`/`account` 供身份与额度兼容读取；官方 `auth export`/`auth import --standalone` 只携带 `credential` 表，会丢失这部分身份信息，因此本项目选择一致性备份。来源数据库只读，不切换来源游标。重复导入按稳定账号身份幂等；`replaceExisting` 建新根并原子切换 secret，旧根保留给活动进程。

## 额度

优先读取 `credential` 表中 `opencode` Console OAuth 登录（若存在）并只向 `https://opencode.ai/console/api/go/status` 发送其 access token 和 `metadata.orgID`。否则使用 `opencode-go` key 请求 `https://opencode.ai/zen/go/v1/usage` 读取 Go 套餐窗口。两者都不可用或响应形状不认识时，额度显示“未知”并给出安全原因，不把额度读取失败当成账号登录失败。只展示官方只读额度；Go 窗口耗尽不代表免费模型、余额或其他路由不可用。

## 其他接触点

- `opencode models`：模型目录。
- `opencode run --format json --model provider/model#effort --auto --standalone`：worker；v2 无 `--variant`/`--pure`/`--dir`，工作目录由 cwd/`$PWD` 决定。
- `opencode serve --hostname 127.0.0.1 --port <port>`：2.2 CLI 仍提供该命令，但 API 已迁到 `/api` 且事件/消息结构变化；Weaver 的 IM 父 Agent 仍按旧 v1 协议实现，未在本包声明 2.2.x 已验证（见任务证据 W1）。
- 数据库清理：`credential` 与 `control_account` 列入保留表摘要，不随会话清理删除。

依据：本机 OpenCode 2.2.7 的 `--help`/子命令帮助、`credential` 表结构与隔离副本实测；官方源码 v2.2.7 `packages/core/src/credential.ts`、`packages/core/src/plugin/provider/opencode.ts`、`packages/cli/src/commands/handlers/auth/*`。
