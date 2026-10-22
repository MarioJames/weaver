# DeepSeek Harness 真实调用验证（脱敏）

日期：2026-10-22（UTC）。dsh `@deepseek-ai/dsh@0.2.1-rc.2`，本机 `~/.local/bin/dsh`。
本文件不含任何 token、key、账号标识：会话 id 仅保留 `session-` 前缀判断所需的形状描述，后缀省略。

## 1. 凭据服务启用的依据

- `dsh-llm-deepseek-api-key/README.md`：`apiKeyEnv` defaults to `DEEPSEEK_API_KEY`；
  “When the credentials service exists, its precedence applies; only compositions
  without that service read the launch environment directly”。
- `dsh-credentials-local/README.md`：lookup precedence 为
  stored file → launch environment → project `.env` → harness-home `.env`
 （“the stored file wins, followed by the launch environment, the project's `.env`,
  and the harness-home `.env`”）。
- `dsh-llm-deepseek/README.md`：`deepseek-official` resolves only its configured
  API-key reference（不回退到账号路由）。

headless 默认组成禁用本地凭据服务（`dsh --profile headless --dump-default-config`
中 `id: credentials (dsh-credentials-local)` 为 `disabled: true`，同时
`authorization`、`deepseek-account` 也为 `disabled: true`），因此未启用前读不到
已存 Key，只会报 `MISSING_CREDENTIAL`。

## 2. Overlay 内容（无凭据）

`buildDshOverlayPatch(model, effort)`（`src/main/adapters/cli/argv.ts`）生成的
patch-list overlay，始终 `provider: deepseek-official`，模型仍为
`deepseek-flash` / `deepseek-v4-pro`，不实现账号路由：

```yaml
- id: agent-default-model
  config:
    provider: deepseek-official
    model: "deepseek-flash"
- id: llm-deepseek
  config:
    reasoningEffort: "high"
- id: sandbox-policy
  config:
    mode: workspace-write
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: ask
- id: credentials
  disabled: false
```

最小改动即最后两行（启用 `credentials` / `dsh-credentials-local`）。
`authorization` 与 `deepseek-account` 不在 overlay 中出现，保持 headless 默认禁用；
overlay 不含任何凭据值，Weaver 不读取凭据文件内容。
注意 `--patch` 是 dsh 启动器参数，必须位于 headless 应用参数 `--json` 之前，
正式运行与 hello 均为 `dsh --profile headless --patch <overlay> --json …`。

## 3. dump-config 摘录

以 `dsh --profile headless --dump-config --patch <overlay>` 验证合成结果
（`DSH_PERMISSION_MODE=danger-full-access` 下仍被 overlay 显式值覆盖）：

- `agent-default-model`：`provider: deepseek-official`，`model: deepseek-flash`
- `llm-deepseek (dsh-llm-deepseek-api-key)`：`reasoningEffort: high`
- `sandbox-policy`：`mode: workspace-write`，`workspaceRoot: !!js process.cwd()`
- `approval (dsh-user-approval)`：`policy: ask`
- `credentials (dsh-credentials-local)`：`disabled: false`（本次 overlay 启用）
- `authorization`：`disabled: true`（保持禁用，无交互登录面，ask fail-closed）
- `deepseek-account`：`disabled: true`（保持禁用，不走账号路由）

## 4. 真实调用 a：正式 overlay 路径

- 工作区：`/tmp/weaver-05b7cade-cQz5Lk/c2e/ws`（新建临时目录）。
- 脚本：`/tmp/weaver-05b7cade-cQz5Lk/c2e/run-a.tsx`，经
  `prepareCliAgentInput({ engine: 'dsh', model: 'deepseek-flash', effort: 'high', … })`
  取 `argv/cwd/stdin/overlay` 后直接 `spawn` 真实 dsh，stdout 逐行喂给
  `createNormalizer('dsh')`。
- 提示词：`只回复 OK 两个字母，不要使用任何工具`（stdin）。
- 实际命令形如：`dsh --profile headless --patch <stateDir>/dsh-overlay-*.yml --json`，
  cwd 为上述 ws；overlay 无凭据值（`OVERLAY_HAS_CREDENTIAL_VALUE: false`）。
- 首次尝试：退出码 0、`terminal: success`，但结果文本为 `好的`（未命中 `OK`），
  判为不通过，按允许重试一次。
- 重试结果：退出码 `0`，`terminal: success`，结果文本 `OK`（含 `OK`），
  `vendorSessionId` 以 `session-` 开头（后缀已省略），`usage: { inputTokens, outputTokens }`。
- NDJSON 事件类型序列：
  `session | status:turn_start | status:step_start | thinking | text | status:step_end | status:turn_end | final`。
- `step_end.usage` 真实字段名：
  `inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens`
 （normalizer 仅保留累计的 `inputTokens/outputTokens`）。
- 每次调用耗时远小于 180 秒上限。

## 5. 真实调用 b：hello 探测

- 脚本：`/tmp/weaver-05b7cade-cQz5Lk/c2e/run-b.tsx`，调用 `sayHi(
  { engine: 'dsh', kind: 'dsh', model: 'deepseek-flash', effort: 'high' }, …)`。
- hello 使用与正式运行相同的 overlay 逻辑：私有 scratch 目录内写
  `dsh-overlay.yml` 并以 `--patch <overlay> --json` 启动，随 scratch 删除。
- 结果：`ok: true`，`reply: hi`，耗时约 2.5 秒（< 180 秒）。

## 6. 失败处理说明

若因凭据缺失/失效/额度失败，应停止并原样报告错误码与信息（例如
`MISSING_CREDENTIAL` / `AUTH` / `QUOTA` / `RATE_LIMIT` 及其 message），
并请用户在 dsh web 端或凭据库中更新可用的 `DEEPSEEK_API_KEY`；
不得尝试获取、伪造、打印任何凭据。本次验证未触发此类失败。
