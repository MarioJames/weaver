import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { defaultConfig } from '../../src/main/policy/routing';
import type { ImConfig, ImSettingsSnapshot, ImStatus } from '../../src/shared/contracts/im';
import type { PolicyDraft } from '../../src/renderer/policy/usePolicyDraft';
import {
  adoptServer, conflictNote, createRequestGate, draftOf, IM_ENGINE_KINDS, imModelDiscoveryEngine, keepImDraft, modifiedEdit, peekImDraft, savePlan, switchDraftEngine, validateDraft,
  type ImDraft, type ImEdit, type ImRequestKind,
} from '../../src/renderer/features/bots/im-state';
import { EFFORTS } from '../../src/shared/policy/settings';
import { ModelListSession } from '../../src/renderer/features/engines/engine-models';
import type { EngineModelList, EngineModelListInput } from '../../src/shared/engines';
import { AgentStatus, ImSettingsView, type ImSettingsViewProps } from '../../src/renderer/features/bots/ImSettings';
import { BotsPage } from '../../src/renderer/features/bots/BotsPage';
import { botStyles } from '../../src/renderer/features/bots/bot-style';

/** The real configured baseline the fixtures branch from, e.g. read at revision 5. */
const APP_ID = 'cli_a1b2c3d4e5f6a7b8';

function configOf(over: Partial<ImConfig> = {}): ImConfig {
  return {
    enabled: true, appId: APP_ID, appSecretConfigured: true, allowedOpenIds: ['ou_1111111111111111'],
    engine: 'claude', model: 'claude-opus-5-5', effort: 'medium', workspaces: ['/home/me/projects/weaver'], idleTimeoutMinutes: 30, ownerProfileId: '', ...over,
  };
}

function statusOf(over: Partial<ImStatus> = {}): ImStatus {
  return { connection: 'connected', agentState: 'ready', activeSessions: 1, busySessions: 0, ...over };
}

function snapshotOf(config: ImConfig, revision: number, status: ImStatus = statusOf()): ImSettingsSnapshot {
  return { revision, config, status, ownerProfiles: [] };
}

function textOf(base: ImConfig, over: Partial<ImDraft> = {}): ImDraft {
  return { ...draftOf(base), ...over };
}

/** An active draft: one real change waiting to be saved, forked from revision 5. */
function activeEdit(over: Partial<ImDraft> = {}, base = configOf(), revision = 5): ImEdit {
  return { values: textOf(base, { openIdsText: 'ou_2222222222222222', ...over }), base, revision };
}

function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) }));
}

test('a page without an active draft adopts a later snapshot whole: revision, config and status move together', () => {
  const next = snapshotOf(configOf({ idleTimeoutMinutes: 45, ownerProfileId: ''}), 7);
  const outcome = adoptServer(next, undefined);
  assert.deepEqual(outcome, { saved: next, edit: undefined, conflict: false });
});

test('an edit whose values sit back on its baseline is not a draft: the page keeps following the saved config', () => {
  const base = configOf();
  const edit: ImEdit = { values: textOf(base), base, revision: 5 };
  const outcome = adoptServer(snapshotOf(configOf({ idleTimeoutMinutes: 45, ownerProfileId: ''}), 7), edit);
  assert.equal(outcome.edit, undefined);
  assert.equal(outcome.conflict, false);
});

test('a concurrent update never rewrites the draft baseline: the later save still carries the forked revision', () => {
  const base = configOf();
  const edit = activeEdit({}, base);
  const next = snapshotOf(configOf({ allowedOpenIds: ['ou_3333333333333333'], idleTimeoutMinutes: 60, ownerProfileId: ''}), 9);
  const outcome = adoptServer(next, edit);
  assert.equal(outcome.saved, next, 'the live status and revision of the control plane are still reflected');
  assert.equal(outcome.conflict, true, 'the page says the config moved underneath the draft instead of mixing them');
  assert.ok(outcome.edit);
  assert.equal(outcome.edit.revision, 5, 'expectedRevision stays at the baseline the content was actually written against');
  assert.deepEqual(outcome.edit.base, base);
  assert.equal(outcome.edit.values.openIdsText, 'ou_2222222222222222', 'the typed draft is not touched by the newer read');
  const plan = savePlan(outcome.edit, undefined);
  assert.ok(plan.input, 'a valid draft still yields the input to submit');
  assert.equal(plan.input.expectedRevision, 5, 'the optimistic lock still guards the real baseline, never the refreshed one');
});

test('a status refresh at the same revision keeps an active draft without raising a conflict', () => {
  const base = configOf();
  const edit = activeEdit({}, base);
  const next = snapshotOf(base, 5, statusOf({ activeSessions: 2 }));
  const outcome = adoptServer(next, edit);
  assert.equal(outcome.edit, edit);
  assert.equal(outcome.conflict, false);
  assert.equal(outcome.saved, next);
});

test('when the control plane already holds what the draft tried to save, the draft is dropped instead of retrying the same save', () => {
  const edit = activeEdit({ secret: '' });
  const outcome = adoptServer(snapshotOf(configOf({ allowedOpenIds: ['ou_2222222222222222'] }), 6), edit);
  assert.equal(outcome.edit, undefined);
  assert.equal(outcome.conflict, false);
});

test('a pasted secret survives routine re-reads at the same or a newer revision: only an explicit save success clears it', () => {
  const base = configOf();
  const edit = activeEdit({ secret: 's3cret-value', openIdsText: 'ou_1111111111111111' }, base);
  // 仅粘贴 Secret 后的普通重读：公开配置与原来完全一样，公开比较证明不了新值已写入。
  const same = adoptServer(snapshotOf(base, 5, statusOf({ activeSessions: 3 })), edit);
  assert.equal(same.edit, edit, 'the secret-only draft is not dropped by a refresh or poll');
  assert.equal(same.conflict, false, 'nothing moved underneath the draft at the same revision');
  // 新修订的重读（例如别处写入过一次）：草稿仍在，基线 revision 不被偷换，冲突如实上报。
  const later = adoptServer(snapshotOf(configOf(), 9), edit);
  assert.ok(later.edit);
  assert.equal(later.conflict, true);
  assert.equal(later.edit.revision, 5, 'the baseline revision is never swapped for the refreshed one');
  const retry = savePlan(later.edit, undefined);
  assert.ok(retry.input, 'a rechargeable draft still produces a submit');
  assert.equal(retry.input.expectedRevision, 5, 'a retry save still carries the forked revision');
});

test('a pending clear survives a re-read while the public boolean still says a secret exists', () => {
  const edit = activeEdit({ clearSecret: true, secret: '', openIdsText: 'ou_1111111111111111' });
  const outcome = adoptServer(snapshotOf(configOf(), 5), edit);
  assert.equal(outcome.edit, edit, 'appSecretConfigured=true cannot prove the stored secret is gone');
  assert.equal(outcome.conflict, false);
});

test('public fields that already match do not certify a replaced secret: the whole draft stays put', () => {
  const base = configOf();
  const edit = activeEdit({ openIdsText: 'ou_2222222222222222', secret: 's3cret-value' }, base);
  // 控制面公开字段已与草稿一致（例如另一处恰好保存了同样的白名单），但 Secret 替换无法从公开 DTO 证明。
  const outcome = adoptServer(snapshotOf(configOf({ allowedOpenIds: ['ou_2222222222222222'] }), 6), edit);
  assert.equal(outcome.edit, edit, 'the unconfirmed secret replacement keeps the draft for the user to check');
  assert.equal(outcome.conflict, true, 'the control plane did move; the page says so instead of silently adopting');
  assert.equal(outcome.edit.revision, 5);
});

test('a clear is settled by the existing sync rule only once the public boolean proves no secret is stored', () => {
  const edit = activeEdit({ clearSecret: true, secret: '', openIdsText: 'ou_1111111111111111' });
  const outcome = adoptServer(snapshotOf(configOf({ appSecretConfigured: false }), 6), edit);
  assert.equal(outcome.edit, undefined, 'appSecretConfigured=false is the one public proof the clear can be checked against');
  assert.equal(outcome.conflict, false);
});

test('the conflict note names the forked revision, the current one and the explicit recovery instead of an auto fix', () => {
  const note = conflictNote(activeEdit(), snapshotOf(configOf(), 9));
  assert.match(note, /修订 5/);
  assert.match(note, /修订 9/);
  assert.match(note, /放弃修改并载入最新/);
  assert.match(note, /不会保留/, 'the note says what the recovery does to the unsaved input');
});

test('the save plan mirrors the shared contract: trimmed text, whitelisted rows and secret keep/clear/replace', () => {
  const base = configOf();
  const plain = savePlan(activeEdit({}, base), defaultConfig());
  assert.ok(plain.input, 'a valid draft yields the input to submit');
  assert.deepEqual(plain.errors, {});
  assert.equal(plain.input.config.appId, APP_ID);
  assert.deepEqual(plain.input.config.allowedOpenIds, ['ou_2222222222222222']);
  assert.deepEqual(plain.input.config.workspaces, ['/home/me/projects/weaver']);
  assert.equal(Object.hasOwn(plain.input.config, 'appSecretConfigured'), false, 'the derived flag stays out of the save input');
  assert.equal(plain.input.config.appSecret, undefined, 'no secret keys change unless the draft says so');
  const pasted = savePlan(activeEdit({ secret: 's3cret-value' }, base), undefined);
  assert.ok(pasted.input);
  assert.equal(pasted.input.config.appSecret, 's3cret-value');
  const cleared = savePlan(activeEdit({ clearSecret: true }, base), undefined);
  assert.ok(cleared.input);
  assert.equal(cleared.input.config.appSecret, '');
  const spaced = savePlan(activeEdit({ appId: ` ${APP_ID} ` }, base), undefined);
  assert.ok(spaced.input, 'an appId-only edit is a valid draft');
  assert.equal(spaced.input.config.appId, APP_ID, 'the trimmed value is what gets submitted');
});

test('the plan consumes the minutes the user sees: an invalid visible number blocks the save instead of carrying the old value', () => {
  const base = configOf();
  for (const idle of [null, 0, 1441, 2.5] as const) {
    const plan = savePlan(activeEdit({ openIdsText: 'ou_1111111111111111', idleTimeoutMinutes: idle }), undefined);
    assert.match(plan.errors.timeout, /空闲超时/, 'the refusal is said on the field the user is fixing');
    if (idle === null) assert.ok(!plan.input, 'an empty box cannot construct a minutes-valid payload at all');
    else {
      assert.ok(plan.input, 'the refused draft still yields a payload');
      assert.equal(plan.input.config.idleTimeoutMinutes, idle, 'even a refused payload carries exactly what the user sees, never the old 30');
    }
  }
  for (const idle of [1, 30, 1440] as const) {
    const plan = savePlan(activeEdit({ openIdsText: 'ou_1111111111111111', idleTimeoutMinutes: idle }), undefined);
    assert.ok(plan.input, 'a corrected number recovers the save');
    assert.equal(plan.input.config.idleTimeoutMinutes, idle, 'what is submitted is exactly the number in the box, never the old one');
  }
});

test('an out-of-range or empty visible idle alone is a real unsaved change gated from saving', () => {
  for (const idle of [null, 0, 1441] as const) {
    const edit = activeEdit({ openIdsText: 'ou_1111111111111111', idleTimeoutMinutes: idle });
    assert.equal(modifiedEdit(edit), true, 'dirty reflects the same visible state the user sees, not a stale hint that everything is saved');
    assert.match(validateDraft(edit.values, edit.base, undefined).timeout, /空闲超时/);
  }
});

test('re-reads keep a draft whose visible idle is invalid: no silent normalization, no swapped baseline, and a corrected number saves as seen', () => {
  const base = configOf({ idleTimeoutMinutes: 40, ownerProfileId: ''});
  for (const idle of [null, 0, 1441] as const) {
    const edit = activeEdit({ openIdsText: 'ou_1111111111111111', idleTimeoutMinutes: idle }, base);
    const same = adoptServer(snapshotOf(base, 5), edit);
    assert.equal(same.edit, edit, 'the invalid number the user sees is not dropped or replaced by the saved 40');
    assert.equal(same.conflict, false);
    assert.equal(same.saved.config.idleTimeoutMinutes, 40, 'the page still reports what the control plane holds');
    const later = adoptServer(snapshotOf(configOf({ idleTimeoutMinutes: 45, ownerProfileId: ''}), 9), edit);
    assert.ok(later.edit, 'the draft with its fixable field survives a newer revision');
    assert.equal(later.edit.revision, 5);
    assert.equal(later.conflict, true);
    const fixed = savePlan({ ...edit, values: { ...edit.values, idleTimeoutMinutes: 90, ownerProfileId: ''} }, undefined);
    assert.ok(fixed.input, 'correcting the visible number unblocks the same draft');
    assert.equal(fixed.input.config.idleTimeoutMinutes, 90);
  }
});

test('validation turns the screen-readable failures into per-field messages and lets a disabled partial config save', () => {
  const base = configOf();
  const blank: ImDraft = textOf(configOf({ enabled: false, appId: '', appSecretConfigured: false, allowedOpenIds: [], engine: '', model: '', effort: 'medium', workspaces: [] }));
  assert.deepEqual(validateDraft(blank, configOf({ appId: '', appSecretConfigured: false }), undefined), {}, 'turning IM off does not require a complete configuration');
  const enabled = validateDraft(textOf(configOf({ appId: '', appSecretConfigured: false, allowedOpenIds: [], engine: '', model: '', effort: '', workspaces: [] })), configOf({ appId: '', appSecretConfigured: false }), defaultConfig());
  assert.equal(Object.keys(enabled).sort().join(','), 'appId,effort,engine,model,openIds,secret,workspaces');
  assert.match(validateDraft(textOf(base, { appId: 'cli_xyz' }), base, undefined).appId, /cli_ 后跟 16 位十六进制字符/);
  assert.match(validateDraft(textOf(base, { appId: `${APP_ID}1` }), base, undefined).appId, /16 位十六进制字符/, '17 hex chars is not the real format either');
  assert.match(validateDraft(textOf(base, { appId: 'cli_0123456789ffffffZ' }), base, undefined).appId, /16 位十六进制字符/, 'non-hex is rejected');
  assert.match(validateDraft(textOf(base, { openIdsText: 'someone@example.com' }), base, undefined).openIds, /ou_ 开头/);
  assert.match(validateDraft(textOf(base, { openIdsText: 'ou_1111111111111111\nou_1111111111111111' }), base, undefined).openIds, /重复/);
  const disabledPi = validateDraft(textOf(base, { engine: 'pi' }), base, defaultConfig());
  assert.match(disabledPi.engine, /尚未启用/, 'pi is a supported catalog engine but disabled by default');
  const withOther = defaultConfig();
  (withOther.engines as Record<string, { enabled: boolean; kind: string; quota_refresh: boolean }>).zed = { enabled: true, kind: 'zed', quota_refresh: false };
  assert.match(validateDraft(textOf(base, { engine: 'zed' }), base, withOther).engine ?? '', /已安装且已启用/, 'kinds outside the installed catalog are not offered');
  const noOwners = defaultConfig(); noOwners.owners = {}; noOwners.workers = {};
  assert.deepEqual(validateDraft(textOf(base), base, noOwners), {}, 'Bot routing is independent of owner/worker profiles');
  assert.match(validateDraft(textOf(base, { effort: 'unknown' }), base, noOwners).effort, /思考力度/);
  assert.match(validateDraft(textOf(base, { model: 'bad model' }), base, noOwners).model, /模型名称/);
  const changedAppId = validateDraft(textOf(base, { appId: 'cli_00000000000000aa' }), base, undefined);
  assert.match(changedAppId.secret, /App ID 变更后.*Secret/, 'matches the store rule: an appId change refuses a silently carried-over secret');
  assert.deepEqual(validateDraft(textOf(base, { appId: 'cli_00000000000000aa', secret: 'new-secret' }), base, undefined).secret, undefined, 'a pasted new secret settles the change');
  assert.match(validateDraft(textOf(base, { appId: 'cli_00000000000000aa', clearSecret: true }), base, undefined).secret, /清除已保存的 Secret 前请先粘贴新的 Secret/, 'keeping IM enabled while clearing the secret still asks for a replacement');
  assert.deepEqual(validateDraft(textOf(base, { enabled: false, appId: 'cli_00000000000000aa', clearSecret: true }), base, undefined).secret, undefined, 'with IM off, an explicit clear settles the appId change');
});

test('the unsaved draft survives page switches in the process memory and clears only when the page discards it', () => {
  keepImDraft(undefined);
  const edit = activeEdit();
  keepImDraft(edit);
  assert.equal(peekImDraft(), edit, 'navigating away and back still finds the same draft');
  keepImDraft({ ...edit, revision: 6 });
  assert.equal(peekImDraft()?.revision, 6);
  keepImDraft(undefined);
  assert.equal(peekImDraft(), undefined, 'an explicit save or 放弃修改 is the only way the draft goes away');
});

test('the document-close guard follows the draft holder lifecycle, not the settings page mount', () => {
  keepImDraft(undefined);
  const added: string[] = [];
  const removed: string[] = [];
  (globalThis as { window?: object }).window = {
    addEventListener: (type: string) => added.push(type),
    removeEventListener: (type: string) => removed.push(type),
  };
  try {
    keepImDraft(activeEdit());
    assert.deepEqual(added, ['beforeunload'], 'a dirty held draft arms the guard');
    assert.deepEqual(removed, []);
    keepImDraft({ ...peekImDraft()!, values: { ...peekImDraft()!.values, openIdsText: draftOf(configOf()).openIdsText } });
    assert.deepEqual(removed, ['beforeunload'], 'values back on the baseline disarm it again');
    keepImDraft(activeEdit({ secret: 's3cret-value' }));
    assert.equal(added.length, 2, 'a secret-only draft is dirty and arms the guard again');
  } finally {
    keepImDraft(undefined);
    delete (globalThis as { window?: object }).window;
  }
  assert.deepEqual(removed, ['beforeunload', 'beforeunload'], 'clearing the holder disarms it wherever the page navigated');
});

// ImSettings 的每条请求路径都从 createRequestGate 开始；这里按组件真实种类演练它的生命周期：
// 全局落地线丢掉晚到的旧响应，各请求类别自己的在飞名额收束自己的 spinner。
test('a request outpaced on the landing line drops its data but still settles its own spinner', () => {
  const gate = createRequestGate();
  const refresh = gate.begin('refresh');
  assert.equal(gate.busy(), true, 'a panel request in flight pauses the background poll');
  // 旧实现的卡死场景：任何后来者（例如静默轮询）先返回并推进落地线，
  // 刷新的响应变晚——它必须丢弃数据，但 refreshing 依然要收尾，不能永久 true。
  const poll = gate.begin('poll');
  assert.equal(poll.lands(), true);
  assert.equal(poll.end(), true);
  assert.equal(gate.busy(), true, 'the poll ending does not release the panel while the refresh is still pending');
  assert.equal(refresh.lands(), false, 'the outpaced refresh response must not overwrite the newer data');
  assert.equal(refresh.end(), true, 'the refresh still resolves refreshing instead of sticking forever');
  assert.equal(gate.busy(), false, 'an idle gate releases the poll again');
});

test('an earlier same-kind request settling late never clears the flag a newer request still owns', () => {
  const gate = createRequestGate();
  const first = gate.begin('refresh');
  const second = gate.begin('refresh');
  assert.equal(first.end(), false, 'the spinner belongs to the still-pending newer request');
  assert.equal(second.end(), true, 'only the last settle of the kind clears it');
  assert.equal(gate.busy(), false, 'an idle gate releases the poll again');
});

test('a read that began before a save cannot overwrite the saved result when it lands late', () => {
  const gate = createRequestGate();
  const preSaveRead = gate.begin('poll');
  const save = gate.begin('save');
  assert.equal(save.lands(), true, 'the newest request writes its result');
  assert.equal(save.end(), true);
  assert.equal(preSaveRead.lands(), false, 'the stale pre-save snapshot is dropped instead of reverting the save');
  assert.equal(preSaveRead.end(), true);
  assert.equal(gate.busy(), false);
});

test('only exclusive requests pause the poll; a poll alone never blocks the panel or itself', () => {
  const gate = createRequestGate();
  assert.equal(gate.busy(), false);
  const poll = gate.begin('poll');
  assert.equal(gate.busy(), false, 'a poll in flight does not pause the panel');
  assert.equal(poll.end(), true);
  for (const kind of ['load', 'force', 'refresh', 'reconnect', 'save'] as const satisfies readonly ImRequestKind[]) {
    const flight = gate.begin(kind);
    assert.equal(gate.busy(), true, `${kind} in flight pauses the background poll`);
    assert.equal(flight.end(), true);
    assert.equal(gate.busy(), false, `${kind} settling releases the poll`);
  }
});

test('the Bot page shows its own heading and IM loading state before the global policy is ready', () => {
  keepImDraft(undefined);
  const html = markup(React.createElement(BotsPage, { policy: {} as PolicyDraft }));
  assert.match(html, /<h1[^>]*>Bot<\/h1>/);
  const start = html.indexOf('<section aria-label="飞书 IM"');
  const end = html.indexOf('</section>', start);
  assert.ok(start >= 0 && end > start, 'the group section exists');
  const group = html.slice(start, end);
  assert.match(group, /正在读取飞书 IM 设置/);
  assert.ok(html.indexOf('正在读取飞书 IM 设置') < end, 'the loading row sits inside the group, not beside it');
});


test('Bot engine/model/effort changes are real drafts and save independently without owner profiles', () => {
  const base = configOf();
  const policy = defaultConfig(); policy.owners = {}; policy.workers = {};
  for (const patch of [{ engine: 'codex' }, { model: 'custom/model' }, { effort: 'high' }]) {
    const edit: ImEdit = { base, revision: 5, values: textOf(base, patch) };
    assert.equal(modifiedEdit(edit), true);
    const next = adoptServer(snapshotOf(base, 9), edit);
    assert.equal(next.edit, edit);
    assert.equal(next.edit.revision, 5);
    assert.equal(next.conflict, true);
    const plan = savePlan(edit, policy);
    assert.deepEqual(plan.errors, {});
    assert.ok(plan.input);
    assert.equal(plan.input.expectedRevision, 5);
    assert.equal(plan.input.config.engine, edit.values.engine);
    assert.equal(plan.input.config.model, edit.values.model);
    assert.equal(plan.input.config.effort, edit.values.effort);
  }
});

test('changing engines clears the model, preserves only a legal effort and never invents a replacement model', () => {
  const policy = defaultConfig();
  const draft = textOf(configOf(), { effort: 'high', secret: 'pending-secret' });
  const same = switchDraftEngine(draft, 'claude', policy);
  assert.equal(same.model, draft.model);
  const switched = switchDraftEngine(draft, 'codex', policy);
  assert.deepEqual(switched, { engine: 'codex', model: '', effort: 'high' });
  const next = { ...draft, ...switched };
  assert.equal(next.secret, 'pending-secret');
  assert.match(validateDraft(next, configOf(), policy).model, /模型/);
  assert.equal(switchDraftEngine({ ...draft, effort: 'ultracode' }, 'codex', policy).effort, 'medium');
  assert.equal(switchDraftEngine({ ...draft, effort: 'medium' }, 'dsh', policy).effort, 'low', 'medium is illegal for dsh and falls back to low');
  assert.equal(switchDraftEngine({ ...draft, effort: 'high' }, 'dsh', policy).effort, 'high', 'a legal dsh effort is preserved');
  for (const kind of ['codex', 'claude', 'dsh']) {
    for (const effort of EFFORTS[kind]) assert.equal(validateDraft(textOf(configOf(), { engine: kind, effort }), configOf(), policy).effort, undefined);
  }
});

test('all seven catalog engines are offered, validated per kind, and OpenCode keeps a free-form bounded variant', () => {
  const policy = defaultConfig();
  for (const engine of Object.values(policy.engines)) engine.enabled = true;
  const cases = [
    ['claude', 'claude'], ['codex', 'codex'], ['grok', 'grok'],
    ['opencode', 'opencode'], ['pi', 'pi'], ['qoder', 'qodercli'], ['dsh', 'dsh'],
  ] as const;
  assert.deepEqual([...IM_ENGINE_KINDS].sort(), cases.map(([, kind]) => kind).sort());
  for (const [engine, kind] of cases) {
    const efforts = kind === 'opencode' ? ['provider-default', 'high'] : EFFORTS[kind];
    assert.ok(efforts?.length, `${kind} has a fixed effort table (opencode uses free-form variants)`);
    for (const effort of efforts) {
      const errors = validateDraft(textOf(configOf(), { engine, effort }), configOf(), policy);
      assert.equal(errors.engine, undefined, `${kind} engine was rejected`);
      assert.equal(errors.effort, undefined, `${kind} effort ${effort} was rejected`);
    }
  }
  // dsh 原生力度只有 off/low/high/max：medium 非法，切换到 dsh 时回退 low。
  assert.deepEqual(EFFORTS.dsh, ['off', 'low', 'high', 'max']);
  assert.match(validateDraft(textOf(configOf(), { engine: 'dsh', effort: 'medium' }), configOf(), policy).effort ?? '', /思考力度/);
  assert.equal(switchDraftEngine({ ...textOf(configOf()), effort: 'medium' }, 'dsh', policy).effort, 'low');
  assert.equal(switchDraftEngine({ ...textOf(configOf()), effort: 'high' }, 'dsh', policy).effort, 'high');
  assert.match(validateDraft(textOf(configOf(), { engine: 'opencode', effort: 'has space' }), configOf(), policy).effort ?? '', /variant/);
  assert.equal(validateDraft(textOf(configOf(), { engine: 'opencode', effort: 'x'.repeat(32) }), configOf(), policy).effort, undefined);
  assert.match(validateDraft(textOf(configOf(), { engine: 'opencode', effort: 'x'.repeat(33) }), configOf(), policy).effort ?? '', /variant/);
  const disabled = defaultConfig();
  const errors = validateDraft(textOf(configOf(), { engine: 'pi', effort: 'high' }), configOf(), disabled);
  assert.match(errors.engine ?? '', /尚未启用/);
  const dshDisabled = validateDraft(textOf(configOf(), { engine: 'dsh', effort: 'high' }), configOf(), disabled);
  assert.match(dshDisabled.engine ?? '', /尚未启用/, 'a disabled dsh engine is not selectable either');
  assert.equal(switchDraftEngine({ ...textOf(configOf()), effort: 'provider-x' }, 'opencode', policy).effort, 'provider-x');
  assert.equal(switchDraftEngine({ ...textOf(configOf()), effort: 'not a variant' }, 'opencode', policy).effort, 'medium');
});

test('policy alias engines resolve to the catalog id for model discovery while saves keep the alias', () => {
  const policy = defaultConfig();
  policy.engines.ocode = { enabled: true, kind: 'opencode', quota_refresh: false };
  policy.engines.pi_alt = { enabled: true, kind: 'pi', quota_refresh: false };
  policy.engines.qoder_alias = { enabled: true, kind: 'qodercli', quota_refresh: false };
  policy.engines.dsh_alias = { enabled: true, kind: 'dsh', quota_refresh: false };
  assert.equal(imModelDiscoveryEngine('ocode', policy), 'opencode');
  assert.equal(imModelDiscoveryEngine('pi_alt', policy), 'pi');
  assert.equal(imModelDiscoveryEngine('qoder_alias', policy), 'qoder');
  assert.equal(imModelDiscoveryEngine('qoder', policy), 'qoder', 'qoder kind qodercli maps to catalog qoder');
  assert.equal(imModelDiscoveryEngine('claude', policy), 'claude');
  assert.equal(imModelDiscoveryEngine('pi', policy), 'pi');
  assert.equal(imModelDiscoveryEngine('dsh', policy), 'dsh');
  assert.equal(imModelDiscoveryEngine('dsh_alias', policy), 'dsh', 'dsh alias kind maps to catalog dsh');
});

test('the reused model-list consumer uses public API only after engine selection and keeps manual model saves on failure', async () => {
  const policy = defaultConfig(); policy.owners = {}; policy.workers = {};
  const requests: EngineModelListInput[] = [];
  const pending = new Map<string, (list: EngineModelList) => void>();
  const state: { list?: EngineModelList; loading: boolean; errors: number } = { loading: false, errors: 0 };
  (globalThis as { window?: object }).window = { weaver: { listEngineModels: (input: EngineModelListInput) => { requests.push(input); return new Promise<EngineModelList>(resolve => pending.set(input.engine, resolve)); } } };
  try {
    const session = new ModelListSession({ list: list => { state.list = list; }, loading: value => { state.loading = value; }, failed: () => { state.errors++; } });
    session.sync(''); assert.deepEqual(requests, []);
    session.sync('claude'); session.sync('codex');
    const list = (engine: string, status: EngineModelList['status']): EngineModelList => ({ engine, status, source: 'test', models: [], fetchedAt: '2026-01-01T00:00:00Z' });
    pending.get('codex')!(list('codex', 'failed'));
    await new Promise(resolve => setImmediate(resolve));
    pending.get('claude')!(list('claude', 'ok'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.list?.engine, 'codex', 'late old-engine suggestions never replace the new engine');
    assert.equal(state.loading, false); assert.equal(state.errors, 1);
    const plan = savePlan(activeEdit({ engine: 'codex', model: 'custom/manual-model', effort: 'medium' }), policy);
    assert.deepEqual(plan.errors, {}, 'model list failure and no suggestion are not authority to reject manual models');
    assert.equal(plan.input?.config.model, 'custom/manual-model');
    const refresh = session.load(true);
    pending.get('codex')!(list('codex', 'ok')); await refresh;
    assert.deepEqual(requests, [{ engine: 'claude' }, { engine: 'codex' }, { engine: 'codex', refresh: true }]);
  } finally { delete (globalThis as { window?: object }).window; }
});


test('an unavailable saved engine never prevents explicitly disabling the Bot', () => {
  const policy = defaultConfig(); policy.engines.claude.enabled = false;
  const base = configOf();
  assert.match(validateDraft(textOf(base), base, policy).engine, /未启用/);
  assert.deepEqual(validateDraft(textOf(base, { enabled: false }), base, policy), {});
  delete policy.engines.claude;
  assert.deepEqual(validateDraft(textOf(base, { enabled: false }), base, policy), {});
});


test('multiple project directories are one explicit draft alongside Secret and the original CAS revision', () => {
  const base = configOf({ engine: 'codex', model: 'gpt-6.1-sol', effort: 'low', workspaces: ['/projects/alpha', '/projects/beta'] });
  const draft = draftOf(base);
  assert.notEqual(draft.workspaces, base.workspaces, 'editing the list cannot mutate the saved snapshot');
  assert.equal(modifiedEdit({ values: draft, base, revision: 12 }), false, 'equal list content is clean even after a new array projection');
  const added: ImEdit = { values: { ...draft, secret: 'fake-replacement', workspaces: [...draft.workspaces, '/projects/gamma'] }, base, revision: 12 };
  assert.equal(modifiedEdit(added), true);
  const later = adoptServer(snapshotOf(configOf({ workspaces: ['/projects/elsewhere'] }), 13), added);
  assert.equal(later.edit, added, 'a concurrent refresh/save-failure read cannot drop either directory or Secret input');
  assert.equal(later.conflict, true);
  const plan = savePlan(later.edit!, defaultConfig());
  assert.deepEqual(plan.errors, {});
  assert.ok(plan.input);
  assert.equal(plan.input.expectedRevision, 12);
  assert.deepEqual(plan.input.config.workspaces, ['/projects/alpha', '/projects/beta', '/projects/gamma']);
  assert.equal(plan.input.config.appSecret, 'fake-replacement');
  assert.equal(plan.input.config.effort, 'low');
  assert.notEqual(plan.input.config.workspaces, added.values.workspaces, 'the RPC payload owns a list snapshot');
  const removed = { ...added, values: { ...added.values, workspaces: added.values.workspaces.filter(path => path !== '/projects/beta') } };
  assert.deepEqual(savePlan(removed, undefined).input?.config.workspaces, ['/projects/alpha', '/projects/gamma']);
  assert.deepEqual(base.workspaces, ['/projects/alpha', '/projects/beta']);
  const restored = { ...removed, values: { ...removed.values, secret: '', workspaces: [...base.workspaces] } };
  assert.equal(modifiedEdit(restored), false, 'adding then removing an unsaved directory returns to the exact baseline');
});

test('a directory-list change remains dirty until that exact list is confirmed and enabled needs at least one', () => {
  const base = configOf({ workspaces: ['/projects/alpha', '/projects/beta'] });
  const edit: ImEdit = { values: { ...draftOf(base), workspaces: ['/projects/beta'] }, base, revision: 4 };
  assert.equal(adoptServer(snapshotOf(base, 4), edit).edit, edit);
  assert.equal(adoptServer(snapshotOf({ ...base, workspaces: ['/projects/beta'] }, 5), edit).edit, undefined);
  const empty = { ...edit, values: { ...edit.values, workspaces: [] } };
  assert.match(savePlan(empty, undefined).errors.workspaces, /至少.*工作空间/);
  assert.equal(savePlan({ ...empty, values: { ...empty.values, enabled: false } }, undefined).errors.workspaces, undefined);
});

test('directory-list validation refuses duplicate, relative, control-character, oversized and excessive input before RPC', () => {
  const base = configOf();
  for (const workspaces of [
    ['/projects/alpha', '/projects/alpha'], ['relative'], [''], ['/projects/line\nfeed'], ['/projects/tab\tname'], [' /projects/spaced'],
    ['/' + 'x'.repeat(2000)], Array.from({ length: 33 }, (_, index) => '/projects/' + index),
  ]) {
    const errors = validateDraft({ ...draftOf(base), enabled: false, workspaces }, base, undefined);
    assert.ok(errors.workspaces, 'invalid list is also refused while Bot is disabled');
  }
  const limit = Array.from({ length: 32 }, (_, index) => '/projects/' + index);
  assert.equal(validateDraft({ ...draftOf(base), workspaces: limit }, base, undefined).workspaces, undefined);
  assert.equal(validateDraft({ ...draftOf(base), workspaces: ['/projects/a folder'] }, base, undefined).workspaces, undefined);
});


test('Agent lifecycle is rendered independently of a connected Feishu transport', () => {
  for (const [agentState, label] of [
    ['disabled', '未启动'], ['starting', '启动中'], ['ready', '待命'], ['busy', '回复中'], ['closing', '结束中'], ['error', '启动异常'],
  ] as const) {
    const html = markup(React.createElement(AgentStatus, { status: statusOf({ agentState, connection: 'connected', activeSessions: 0 }), controlId: 'reconnect' }));
    assert.match(html, new RegExp(`Agent 状态：${label}`));
    if (agentState === 'error') {
      assert.match(html, /重建连接与会话/);
      assert.doesNotMatch(html, /待命|Agent 已就绪/);
    }
  }
});

test('standby needs no phone session and a safe agent failure is visible without changing the network state', () => {
  const ready = statusOf({ agentState: 'ready', activeSessions: 0, busySessions: 0 });
  assert.match(markup(React.createElement(AgentStatus, { status: ready, controlId: 'retry' })), /尚无手机会话时也会保持待命/);
  const failed = statusOf({ connection: 'connected', agentState: 'error', agentMessage: 'IM 操作失败，请检查配置或重新连接。' });
  const html = markup(React.createElement(AgentStatus, { status: failed, controlId: 'retry' }));
  assert.match(html, /IM 操作失败，请检查配置或重新连接。/);
  assert.equal(failed.connection, 'connected');
});

function viewOf(over: Partial<ImSettingsViewProps> = {}): ImSettingsViewProps {
  const base = configOf();
  const defaults: ImSettingsViewProps = {
    id: 'bot',
    loading: false,
    loadError: '',
    saved: snapshotOf(base, 5),
    values: draftOf(base),
    edit: undefined,
    conflict: false,
    fieldErrors: {},
    saveError: '',
    saving: false,
    savedTick: false,
    refreshing: false,
    reconnecting: false,
    forceReading: false,
    dirty: false,
    engineOptions: [{ value: 'claude', label: 'claude', disabled: false }],
    engineUsable: true,
    discoveryEngine: 'claude',
    efforts: ['low', 'medium', 'high'],
    openCodeVariant: false,
    effortOptions: ['low', 'medium', 'high'].map(value => ({ value, label: value, disabled: false })),
    onRetryLoad: () => {},
    onReloadLatest: () => {},
    onRefreshStatus: () => {},
    onReconnect: () => {},
    onUpdate: () => {},
    onEngineChange: () => {},
    onRemoveWorkspace: () => {},
    onAddWorkspace: () => {},
    onDiscard: () => {},
    onSave: () => {},
    onTimeoutError: () => {},
  };
  return { ...defaults, ...over } as ImSettingsViewProps;
}

test('the Bot page offers the real IM channels through one tablist and renders only the selected channel panel', () => {
  keepImDraft(undefined);
  const html = markup(React.createElement(BotsPage, { policy: {} as PolicyDraft }));
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 1, 'the only real channel is Feishu IM, no invented channels');
  assert.match(html, /<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>飞书 IM<\/button>/);
  const panelStart = html.indexOf('role="tabpanel"');
  assert.ok(panelStart > 0, 'the selected channel has a tab panel');
  const panel = html.slice(panelStart);
  assert.match(panel, /data-bot-channel="feishu"/);
  assert.match(panel, /独立单聊的 Agent/);
  assert.match(panel, /正在读取飞书 IM 设置/);
  const section = panel.slice(panel.indexOf('data-bot-channel="feishu"'));
  const headerEnd = section.indexOf('</header>');
  assert.ok(headerEnd > 0, 'the channel explanation is a header at the top of the panel');
  assert.ok(section.indexOf('独立单聊的 Agent') < headerEnd, 'the old left group column explanation moved into the panel header');
  assert.ok(section.indexOf('正在读取飞书 IM 设置') > headerEnd, 'the rows follow the channel header instead of a left group column');
});

test('each Feishu setting is one two-column row: name label plus description on the left, control and its error on the right', () => {
  const html = markup(React.createElement(ImSettingsView, viewOf({ fieldErrors: { appId: 'App ID 需要 cli_ 开头' } })));
  const section = html.slice(html.indexOf('data-bot-channel="feishu"'));
  assert.ok(section.length > 0);
  const rows = section.split('<div data-bot-row="').slice(1);
  assert.ok(rows.length >= 12, 'every existing setting row is still rendered');
  for (const row of rows) {
    const marker = row.match(/^([^"]+)"/)?.[1] ?? '';
    const field = row.indexOf('data-bot-field=""');
    const control = row.indexOf('data-bot-control=""');
    assert.ok(field >= 0 && control > field, `${marker} keeps the name/description and control in separate columns`);
    const htmlFor = row.match(/<label for="([^"]+)">/)?.[1];
    assert.ok(htmlFor, `${marker} has a label linked to its control`);
    assert.ok(row.slice(control).includes(`id="${htmlFor}"`), `${marker} label for="${htmlFor}" points into its own control column`);
  }
  const appId = rows.find(row => row.startsWith('bot-appid"'));
  assert.ok(appId, 'the App ID row exists');
  assert.match(appId, /App ID 需要 cli_ 开头/);
  assert.ok(appId.indexOf('App ID 需要 cli_ 开头') > appId.indexOf('data-bot-control'), 'the field error sits under the control');
  const controlClasses = [...section.matchAll(/<div data-bot-control="" class="([^"]+)">/g)].map(match => match[1]);
  assert.equal(new Set(controlClasses).size, 1, 'all control columns share the same width track');
  assert.equal(controlClasses[0], botStyles.controlCell);
  const rowClasses = [...section.matchAll(/<div data-bot-row="[^"]*" class="([^"]+)">/g)].map(match => match[1]);
  assert.equal(new Set(rowClasses).size, 1, 'all rows share the same two-column grid');
  assert.equal(rowClasses[0], botStyles.row);
});

test('the new channel layout keeps the conflict, workspace empty/limit, save feedback and loading/error states', () => {
  const conflict = markup(React.createElement(ImSettingsView, viewOf({
    edit: activeEdit(), conflict: true, dirty: true, savedTick: true,
    values: { ...draftOf(configOf()), workspaces: [], idleTimeoutMinutes: null },
  })));
  assert.match(conflict, /配置在别处被修改/);
  assert.match(conflict, /放弃修改并载入最新/);
  assert.match(conflict, /尚未添加工作空间/);
  assert.match(conflict, /已保存/);
  const full = markup(React.createElement(ImSettingsView, viewOf({
    values: { ...draftOf(configOf()), workspaces: Array.from({ length: 32 }, (_, index) => `/projects/${index}`) },
  })));
  assert.match(full, /已达 32 个上限/);
  const loading = markup(React.createElement(ImSettingsView, viewOf({ saved: undefined, values: undefined, loading: true })));
  assert.match(loading, /data-bot-channel="feishu"/);
  assert.match(loading, /正在读取飞书 IM 设置/);
  const failed = markup(React.createElement(ImSettingsView, viewOf({ saved: undefined, values: undefined, loading: false, loadError: '读取失败，请重试' })));
  assert.match(failed, /读取失败，请重试/);
  assert.match(failed, />重试<\/button>/);
});

test('the effort description follows the engine kind: OpenCode variant versus no usable engine', () => {
  const opencode = markup(React.createElement(ImSettingsView, viewOf({ efforts: undefined, openCodeVariant: true, engineUsable: false })));
  assert.match(opencode, /OpenCode 的 variant 由模型定义/);
  assert.doesNotMatch(opencode, /先选择一个支持飞书对话的引擎/);
  const none = markup(React.createElement(ImSettingsView, viewOf({ efforts: undefined, openCodeVariant: false, engineUsable: false })));
  assert.match(none, /先选择一个支持飞书对话的引擎/);
  assert.doesNotMatch(none, /OpenCode 的 variant 由模型定义/);
});

test('the channel header shows only the description: no repeated channel title under the selected tab', () => {
  const html = markup(React.createElement(ImSettingsView, viewOf()));
  const sectionStart = html.indexOf('data-bot-channel="feishu"');
  assert.ok(sectionStart > 0, 'the feishu channel section exists');
  const sectionOpen = html.lastIndexOf('<section', sectionStart);
  assert.ok(sectionOpen >= 0);
  assert.match(html.slice(sectionOpen, sectionStart), /aria-label="飞书 IM"/, 'the section keeps aria-label for accessibility');
  const headerStart = html.indexOf('<header', sectionStart);
  assert.ok(headerStart > sectionStart, 'the channel has a header');
  const headerEnd = html.indexOf('</header>', headerStart);
  assert.ok(headerEnd > headerStart);
  const header = html.slice(headerStart, headerEnd);
  assert.doesNotMatch(header, /飞书 IM/, 'the selected tab already names the channel; the header must not repeat it');
  assert.match(header, /独立单聊的 Agent/, 'the channel description stays in the header');
});
