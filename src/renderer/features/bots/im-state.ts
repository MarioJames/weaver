/**
 * 飞书 IM 设置的状态规则：草稿基线、远端快照的接合、保存计划与请求有效性。
 * 形状全部取自 `src/shared/contracts/im.ts`（后端独占），这里不做本地副本；
 * 本模块只存规则的纯函数，组件在 `ImSettings.tsx`。
 */
import type { ImConfig, ImOwnerProfileOption, ImSettingsSnapshot, SaveImSettingsInput } from '../../../shared/contracts/im';
import type { Config } from '../../../shared/contracts/policy';
import { IM_EFFORT_PATTERN, IM_ENGINE_KINDS as IM_ENGINE_LIST, imEngineEffortAllowed, imEngineEfforts, isImEngineKind } from '../../../shared/im-engines';

/** 页面上可编辑的表单值。Secret 只留在内存草稿里，从不写 localStorage 或磁盘。 */
export interface ImDraft {
  enabled: boolean;
  appId: string;
  secret: string;
  clearSecret: boolean;
  openIdsText: string;
  channel: string;
  model: string;
  effort: string;
  workspaces: string[];
  /** 固定的父 Agent profile id；'' 表示「自动（按策略）」。下拉里用 OWNER_AUTO_VALUE 哨兵显示，草稿与契约里仍是 ''。 */
  ownerProfileId: string;
  /**
   * 用户此刻在分钟数输入框里看到的数：敲好、敲错都如实进草稿，清空或打不出的字符为 null。
   * 非法可见值绝不换底成旧值，能否保存交给 validateDraft，让它以真实状态报错或被放弃/重载复位。
   */
  idleTimeoutMinutes: number | null;
}

/** 一份草稿连同它分支出的已保存基线：期望修订与校验都来自这里，不由后续读到的快照“换底”。 */
export interface ImEdit {
  values: ImDraft;
  base: ImConfig;
  revision: number;
}

export const IDLE_RANGE = { min: 1, max: 1440 } as const;

export const IM_ENGINE_KINDS: ReadonlySet<string> = new Set(IM_ENGINE_LIST);

/**
 * 换引擎后旧力度非法时的回退：仍被新引擎支持的用户值由调用方保留，
 * 这里只在必须换底时按该引擎原生力度表选一个合法值（优先 medium，其次 low，最后取原生首项）。
 * opencode 自由 variant 与未知 kind 沿用 medium 占位（其为合法 variant 字符串）。
 */
function fallbackEffort(kind: string): string {
  if (!isImEngineKind(kind)) return 'medium';
  const values = imEngineEfforts(kind);
  if (!values) return 'medium';
  if (values.includes('medium')) return 'medium';
  if (values.includes('low')) return 'low';
  return values[0] ?? 'medium';
}

/** 客户端先把明显走不通的输入挡回原处；控制面失败时仍会原样报错。 */
const APP_ID_RE = /^cli_[0-9a-f]{16}$/;
const OPEN_ID_PREFIX = 'ou_';

/** 换引擎后必须重新明确模型；力度只有仍被新引擎支持时才保留，否则按新引擎原生表回退。 */
export function switchDraftChannel(draft: ImDraft, channel: string, config: Config | undefined): Pick<ImDraft, 'channel' | 'model' | 'effort'> {
  if (channel === draft.channel) return { channel, model: draft.model, effort: draft.effort };
  const kind = config?.engines[config.channels[channel]?.engine ?? '']?.kind;
  return { channel, model: '', effort: isImEngineKind(kind) && imEngineEffortAllowed(kind, draft.effort) ? draft.effort : fallbackEffort(typeof kind === 'string' ? kind : '') };
}

/** 从所选渠道解析实际 policy engine ID；查询同时携带 channel，身份不由引擎全局状态决定。 */
export function imModelDiscoveryEngine(channel: string, config: Config | undefined): string {
  return config?.channels[channel]?.engine ?? '';
}

export function parseOpenIds(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean);
}

export const IM_WORKSPACE_LIMIT = 32;

/** 这里只拦可见结构错误；目录存在、realpath 别名与凭据目录保护由控制面在保存时验证。 */
export function workspaceListError(workspaces: readonly string[], required = false): string {
  if (workspaces.length > IM_WORKSPACE_LIMIT) return `最多添加 ${IM_WORKSPACE_LIMIT} 个工作空间，请先移除不再使用的目录。`;
  if (required && workspaces.length === 0) return '开启时至少添加一个工作空间。';
  if (workspaces.some(path => !path.startsWith('/') || path.trim() !== path || path.length > 2000 || /[\x00-\x1f\x7f]/.test(path))) {
    return '工作空间需要是绝对路径，最多 2000 字符，不能包含首尾空格或控制字符。';
  }
  if (new Set(workspaces).size !== workspaces.length) return '这个工作空间已在列表中，每个目录只需添加一次。';
  return '';
}

/** 已保存配置的只读展示值；Secret 不在其中，绝不回显。 */
export function draftOf(config: ImConfig): ImDraft {
  return {
    enabled: config.enabled,
    appId: config.appId,
    secret: '',
    clearSecret: false,
    openIdsText: config.allowedOpenIds.join('\n'),
    channel: config.channel,
    model: config.model,
    effort: config.effort,
    workspaces: [...config.workspaces],
    idleTimeoutMinutes: config.idleTimeoutMinutes,
    ownerProfileId: config.ownerProfileId ?? '',
  };
}

/** 草稿显示的值是否已与一份已保存配置一致（按保存时的投影：去空格、拆行复原白名单）。 */
export function valuesMatchConfig(values: ImDraft, config: ImConfig): boolean {
  return values.enabled === config.enabled
    && values.appId.trim() === config.appId
    && values.channel === config.channel
    && values.model.trim() === config.model
    && values.effort === config.effort
    && JSON.stringify(values.workspaces) === JSON.stringify(config.workspaces)
    && values.idleTimeoutMinutes === config.idleTimeoutMinutes
    && values.ownerProfileId === (config.ownerProfileId ?? '')
    && JSON.stringify(parseOpenIds(values.openIdsText)) === JSON.stringify(config.allowedOpenIds);
}

/** 有没有真正要写回的改动：只在它为真时，页面才算“有一份草稿”。 */
export function modifiedEdit(edit: ImEdit): boolean {
  return edit.values.secret !== ''
    || edit.values.clearSecret
    || edit.values.enabled !== edit.base.enabled
    || edit.values.appId !== edit.base.appId
    || edit.values.channel !== edit.base.channel
    || edit.values.model !== edit.base.model
    || edit.values.effort !== edit.base.effort
    || edit.values.ownerProfileId !== (edit.base.ownerProfileId ?? '')
    || JSON.stringify(edit.values.workspaces) !== JSON.stringify(edit.base.workspaces)
    || edit.values.idleTimeoutMinutes !== edit.base.idleTimeoutMinutes
    || JSON.stringify(parseOpenIds(edit.values.openIdsText)) !== JSON.stringify(edit.base.allowedOpenIds);
}

export interface ServerAdoption {
  /** 服务端当前真实状态；页面渲染所依据的已保存配置。 */
  saved: ImSettingsSnapshot;
  /** 接合之后的草稿：活动草稿原样保留，无草稿或已同步时为 undefined。 */
  edit: ImEdit | undefined;
  /** 草稿尚未写回而控制面已经前进：给出冲突提示与恢复入口。 */
  conflict: boolean;
}

/**
 * 把一次远端快照接合进页面状态。基调：
 * - 页面没有活动草稿（或只是把值改回了已保存值）→ 整幅采纳，修订、配置与状态一起移动；
 * - 活动草稿 → 草稿的基线修订与配置原样保留，只吸收最新 status，约定由后端乐观锁背书。
 * 公开字段一致证明不了一次 Secret 操作已落库：公共 DTO 只有 `appSecretConfigured` 这一个布尔，
 * 说明不了新粘贴的值已写入。所以带 Secret 操作的草稿绝不被普通重读放下，只有组件收到
 * 「显式保存成功」的响应（或用户点放弃/载入最新）才会清除；存疑的保存如实保留草稿让人核对，
 * 不伪装成功。唯一例外是纯清除且 `appSecretConfigured` 已变 false——公共布尔证明了已无 Secret，
 * 此时按既有的「已同步」规则核对并放下草稿。其余保留的草稿维持原基线 revision，冲突由后端裁决。
 */
export function adoptServer(next: ImSettingsSnapshot, edit: ImEdit | undefined): ServerAdoption {
  if (!edit || !modifiedEdit(edit)) return { saved: next, edit: undefined, conflict: false };
  const secretPending = edit.values.secret !== '' || edit.values.clearSecret;
  const provable = !secretPending
    || (edit.values.secret === '' && edit.values.clearSecret && !next.config.appSecretConfigured);
  if (provable && valuesMatchConfig(edit.values, next.config)) return { saved: next, edit: undefined, conflict: false };
  return { saved: next, edit, conflict: next.revision !== edit.revision };
}

export interface ImSavePlan {
  /**
   * 组件只在 `errors` 为空时发请求：errors 非空时没有保存发生，input 只是同一草稿的提交镜像。
   * 分钟框的草稿是用户可见的原始数（见 ImDraft.idleTimeoutMinutes）：input 一旦可构造，
   * 其分钟数字段就是所见之数，绝不用旧值顶替；框里没有数（null）时按共享契约无从构造，为 undefined。
   */
  input: SaveImSettingsInput | undefined;
  errors: Record<string, string>;
}

/**
 * 保存计划：`expectedRevision` 取自草稿的基线修订，即这份草稿从哪个已保存版本分支出来，
 * 绝不用刷新读到的最新修订（保存冲突只能由后端裁决，也不在此无条件提升 revision 绕过它）。
 * `ownerProfiles` 是最新快照里的父 Agent 列表：传了才做本地可选性预检（挡住已停用/已删除的固定值），
 * 没传（例如旧快照不可用）则跳过该项、交由后端裁决；空 pin（自动）永远合法。
 */
export function savePlan(edit: ImEdit, config: Config | undefined, ownerProfiles?: readonly ImOwnerProfileOption[]): ImSavePlan {
  const errors = validateDraft(edit.values, edit.base, config, ownerProfiles);
  const idle = edit.values.idleTimeoutMinutes;
  // 框里没有数（null/打出的非法字符被控件收归 null）时按共享契约无从构造；
  // 一旦可构造，payload 携带的分钟数就是用户所见之数，非法数靠组件按 errors 拦下而非被换底。
  if (idle === null) return { input: undefined, errors };
  const values = edit.values;
  const input: SaveImSettingsInput = {
    expectedRevision: edit.revision,
    config: {
      enabled: values.enabled,
      appId: values.appId.trim(),
      allowedOpenIds: parseOpenIds(values.openIdsText),
      channel: values.channel,
      model: values.model.trim(),
      effort: values.effort,
      workspaces: [...values.workspaces],
      idleTimeoutMinutes: idle,
      ownerProfileId: values.ownerProfileId,
    },
  };
  if (values.secret !== '') input.config.appSecret = values.secret;
  else if (values.clearSecret) input.config.appSecret = '';
  return { input, errors };
}

/**
 * 显式保存前的本地校验。关闭 IM 时允许保存未完整配置、只挡格式错误；
 * 开启时每项都在本地说清楚缺什么，错误文字回投给各自的字段。
 * `ownerProfiles` 是最新快照里的父 Agent 列表：传了才校验固定值的可选性，
 * 没传则跳过该项（交由后端裁决）；与已保存存储的规则一致，关闭 Bot 且 pin 未动时跳过该项检查，总能关闭。
 */
export function validateDraft(draft: ImDraft, saved: ImConfig, config: Config | undefined, ownerProfiles?: readonly ImOwnerProfileOption[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const directoriesError = workspaceListError(draft.workspaces, draft.enabled);
  if (directoriesError) errors.workspaces = directoriesError;
  const openIds = parseOpenIds(draft.openIdsText);
  const badId = openIds.find(id => !id.startsWith(OPEN_ID_PREFIX));
  if (badId) errors.openIds = `open_id 以 ou_ 开头，这一行不合适：${badId.length > 24 ? `${badId.slice(0, 24)}…` : badId}`;
  else if (openIds.length !== new Set(openIds).size) errors.openIds = '白名单里有重复行，每行只保留一个。';
  if (draft.appId.trim() !== '' && !APP_ID_RE.test(draft.appId.trim())) {
    errors.appId = `App ID 形如 cli_a1b2c3d4e5f6a7b8：cli_ 后跟 16 位十六进制字符，这一输入不符合。`;
  }
  if (draft.idleTimeoutMinutes === null || !Number.isInteger(draft.idleTimeoutMinutes) || draft.idleTimeoutMinutes < IDLE_RANGE.min || draft.idleTimeoutMinutes > IDLE_RANGE.max) {
    errors.timeout = `空闲超时是 ${IDLE_RANGE.min} 到 ${IDLE_RANGE.max} 之间的整数分钟。`;
  }
  const channel = config?.channels[draft.channel];
  const engine = channel ? config?.engines[channel.engine] : undefined;
  if (draft.channel && !/^[A-Za-z0-9_-]{1,128}$/.test(draft.channel)) errors.channel = '渠道标识格式不正确，请重新选择。';
  if (draft.model.trim() && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(draft.model.trim())) errors.model = '模型名称格式不正确，可填写字母、数字及 . _ : / -，最多 200 字符。';
  if (draft.effort && !IM_EFFORT_PATTERN.test(draft.effort)) errors.effort = '思考力度格式不正确，请重新选择。';
  if (draft.enabled) {
    if (!draft.channel) errors.channel = '开启时需要选择支持飞书对话的已启用渠道。';
    else if (!channel?.enabled) errors.channel = '该渠道尚未启用，请在账号与渠道页检查。';
    else if (!engine || !isImEngineKind(engine.kind)) errors.channel = '请选择使用已安装、已启用引擎的飞书对话渠道。';
    else if (!engine.enabled) errors.channel = '该引擎尚未启用，请先在引擎页启用。';
    if (engine && isImEngineKind(engine.kind) && draft.effort && !imEngineEffortAllowed(engine.kind, draft.effort)) {
      errors.effort = engine.kind === 'opencode' ? '请填写该模型接受的 variant（最多 32 字符）。' : '请选择该引擎支持的思考力度。';
    }
    if (!draft.model.trim()) errors.model = '开启时需要选择或填写模型。';
    if (!draft.effort) errors.effort = '开启时需要选择思考力度。';
    if (draft.appId.trim() === '') errors.appId = '开启时需要填写飞书开放平台的 App ID。';
    const secretReady = draft.clearSecret ? draft.secret.trim() !== '' : saved.appSecretConfigured || draft.secret.trim() !== '';
    if (!secretReady) errors.secret = draft.clearSecret ? '清除已保存的 Secret 前请先粘贴新的 Secret，或先关闭开关再保存。' : '开启时需要已保存的 App Secret，或现在粘贴一个新的。';
    if (!openIds.length && !errors.openIds) errors.openIds = '开启时至少填写一个以 ou_ 开头的 open_id。';
  }
  // 与已保存存储的规则一致：变更 App ID 后旧 Secret 不再匹配，需要显式粘贴新值或显式清除，不能默认沿用。
  if (draft.appId.trim() !== '' && draft.appId.trim() !== saved.appId.trim() && saved.appSecretConfigured && !draft.clearSecret && draft.secret.trim() === '') {
    errors.secret = 'App ID 变更后旧 Secret 不再适用：请粘贴新的应用 Secret，或点「清除已保存」。';
  }
  if (ownerProfiles !== undefined) {
    const ownerError = ownerProfileError(draft.ownerProfileId ?? '', ownerProfiles, saved.ownerProfileId ?? '', draft.enabled);
    if (ownerError) errors.ownerProfileId = ownerError;
  }
  return errors;
}

/** UI 层专用的「自动（按策略）」哨兵：lobe Select 把空选项值归一为 undefined 再回调，
 * 直接用 '' 做选项 value 会导致选中自动时触发框显示为空（只有展开才看到勾选）。
 * 哨兵含冒号，永远通不过后端的 `^[A-Za-z0-9_-]+$` 与策略 owner id 的 `^[a-z][a-z0-9_]{0,39}$`，
 * 因此不可能与合法 profile id 冲突；它只存在于下拉的 value/回调之间，草稿与契约里仍是 ''。 */
export const OWNER_AUTO_VALUE = ':auto:';

/** 草稿 '' <-> 下拉哨兵：选中自动时框内显示「自动（按策略）」，草稿里仍是 ''。 */
export function ownerSelectDisplay(ownerProfileId: string | undefined): string {
  return ownerProfileId === '' || ownerProfileId === undefined ? OWNER_AUTO_VALUE : ownerProfileId;
}

/** 下拉回调 -> 草稿：哨兵回填为 ''；lobe 把无值回调为 undefined，这里同样回填 ''。 */
export function ownerSelectValue(value: unknown): string {
  if (value === OWNER_AUTO_VALUE) return '';
  return typeof value === 'string' ? value : '';
}

/** 调度主引擎下拉的选项：首项固定为自动，其余保持快照顺序（后端已按 id 排序）；不可选项禁用并按原因加后缀。 */
export function ownerProfileOptions(profiles: readonly ImOwnerProfileOption[]): { value: string; label: string; disabled: boolean }[] {
  const suffix: Record<string, string> = {
    disabled: '（已停用）',
    channel_disabled: '（渠道未启用）',
    engine_disabled: '（引擎未启用）',
    not_launchable: '（不能作为父 Agent 启动）',
    missing: '（已删除）',
  };
  return [
    { value: OWNER_AUTO_VALUE, label: '自动（按策略）', disabled: false },
    ...profiles.map(option => {
      const detail = [option.engineKind, option.model].filter(part => part !== '').join(' · ');
      const tail = option.selectable ? '' : (suffix[option.reason ?? ''] ?? '（不可用）');
      return { value: option.id, label: detail === '' ? `${option.id}${tail}` : `${option.id} · ${detail}${tail}`, disabled: !option.selectable };
    }),
  ];
}

/**
 * 固定父 Agent 值的即时说明：空 pin（自动）永远合法；关闭 Bot 且 pin 与已存值一致时跳过检查，总能关闭；
 * 快照列表缺失（旧快照不可用）时无法判断，返回空、交由后端裁决。其余按原因给出具体字段错误。
 */
export function ownerProfileError(
  ownerProfileId: string,
  profiles: readonly ImOwnerProfileOption[] | undefined,
  savedOwnerProfileId: string,
  enabled: boolean,
): string {
  if (ownerProfileId === '') return '';
  if (!enabled && ownerProfileId === savedOwnerProfileId) return '';
  if (profiles === undefined) return '';
  const found = profiles.find(option => option.id === ownerProfileId);
  if (!found) return '当前选择的父 Agent 已删除，请改选或切换为自动。';
  if (found.selectable) return '';
  switch (found.reason) {
    case 'disabled': return '当前选择的父 Agent 已停用，请改选或切换为自动。';
    case 'channel_disabled': return '当前选择的父 Agent 所属渠道未启用，请改选或切换为自动。';
    case 'engine_disabled': return '当前选择的父 Agent 所属引擎未启用，请改选或切换为自动。';
    case 'not_launchable': return '当前选择的父 Agent 无法启动，请改选或切换为自动。';
    case 'missing':
    default: return '当前选择的父 Agent 已删除，请改选或切换为自动。';
  }
}

/** 冲突说明：点明草稿依据的基线与控制面当前修订，给出恢复动作，不暗示自动修复。 */
export function conflictNote(edit: ImEdit, saved: ImSettingsSnapshot): string {
  return `页面里的草稿基于修订 ${edit.revision}，控制面已推进到修订 ${saved.revision}（可能来自另一标签页或其他工具）。直接保存会被版本冲突拒绝；点「放弃修改并载入最新」改用控制面的当前配置，未保存的输入不会保留。`;
}

/**
 * 面板请求的确定性生命周期，`ImSettings` 的每条请求路径都从这里开始：
 * - 一条全局落地线：只有最新发起的请求能把结果写进页面数据，晚到的旧响应（保存前的旧读、
 *   被保存超过的刷新）一律丢弃，绝不回头覆盖新结果；
 * - 每类请求各记在飞名额：收尾时该类仍有别的在飞请求，就不得复位该类的 spinner——
 *   spinner 归“这个类还有没有请求在飞”管，不归全局序号管，后台轮询或别的请求推进落地线
 *   再也不会把 refreshing/reconnecting 卡成永久 true；
 * - `busy()` 报告是否有互斥请求在飞：后台轮询只在空闲时进行，不和读写互相踩踏。
 */
export type ImRequestKind = 'load' | 'force' | 'refresh' | 'reconnect' | 'save' | 'poll';

export interface ImFlight {
  /** 全局落地线：本请求是否仍是最新发起的；为假时响应必须整体丢弃。 */
  lands(): boolean;
  /** 收尾：让出在飞名额。返回本类是否已无在飞请求——返回 true 才允许复位该类的状态标记。 */
  end(): boolean;
}

export interface ImRequestGate {
  begin(kind: ImRequestKind): ImFlight;
  /** 有互斥请求（load/force/refresh/reconnect/save）在飞；poll 不算，它不与任何请求竞争状态。 */
  busy(): boolean;
}

export function createRequestGate(): ImRequestGate {
  let landed = 0;
  let exclusive = 0;
  const inFlight = new Map<ImRequestKind, number>();
  return {
    begin(kind) {
      const mine = ++landed;
      inFlight.set(kind, (inFlight.get(kind) ?? 0) + 1);
      if (kind !== 'poll') exclusive += 1;
      let done = false;
      return {
        lands: () => mine === landed,
        end() {
          if (done) return false;
          done = true;
          const left = (inFlight.get(kind) ?? 1) - 1;
          if (left <= 0) inFlight.delete(kind); else inFlight.set(kind, left);
          if (kind !== 'poll') exclusive -= 1;
          return left <= 0;
        },
      };
    },
    busy: () => exclusive > 0,
  };
}

/**
 * 未保存草稿在页面切换之间留在内存：导航去别的页再回来，草稿还在，不静默丢失。
 * 仅进程内存，不做 localStorage / 磁盘持久化；Secret 同样只留在这里。
 * 文档关闭保护也挂在 holder 的生命周期上：只要 holder 里有一份真实未保存的草稿，
 * beforeunload 提醒就有效——设置页卸载、用户去别的页面后关文档，提醒依然在；
 * 保存成功或「放弃修改」清空 holder 时一并解除。SSR / 无 window 环境只跳过监听器安装。
 */
let held: ImEdit | undefined;
let closeGuard = false;
const blockClose = (event: BeforeUnloadEvent): void => { event.preventDefault(); };
function syncCloseGuard(): void {
  if (typeof window === 'undefined') return;
  const dirty = held !== undefined && modifiedEdit(held);
  if (dirty === closeGuard) return;
  closeGuard = dirty;
  if (dirty) window.addEventListener('beforeunload', blockClose);
  else window.removeEventListener('beforeunload', blockClose);
}
export function peekImDraft(): ImEdit | undefined { return held; }
export function keepImDraft(edit: ImEdit | undefined): void { held = edit; syncCloseGuard(); }
