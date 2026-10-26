import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { ImConfig, ImOwnerProfileOption, ImSettingsSnapshot, ImStatus } from '../../src/shared/contracts/im';
import {
  draftOf, modifiedEdit, OWNER_AUTO_VALUE, ownerProfileError, ownerProfileOptions, ownerSelectDisplay, ownerSelectValue, savePlan, validateDraft, valuesMatchConfig,
  type ImDraft, type ImEdit,
} from '../../src/renderer/features/bots/im-state';
import { defaultConfig } from '../../src/main/policy/routing';
import { ImSettingsView } from '../../src/renderer/features/bots/ImSettings';

const APP_ID = 'cli_a1b2c3d4e5f6a7b8';

function configOf(over: Partial<ImConfig> = {}): ImConfig {
  return {
    enabled: true, appId: APP_ID, appSecretConfigured: true, allowedOpenIds: ['ou_1111111111111111'],
    channel: 'default_claude', model: 'claude-opus-5-5', effort: 'medium', workspaces: ['/home/me/projects/weaver'], idleTimeoutMinutes: 30, ownerProfileId: '', ...over,
  };
}

function statusOf(over: Partial<ImStatus> = {}): ImStatus {
  return { connection: 'disabled', agentState: 'disabled', activeSessions: 0, busySessions: 0, ...over };
}

function snapshotOf(config: ImConfig, revision: number, ownerProfiles: ImOwnerProfileOption[] = []): ImSettingsSnapshot {
  return { revision, config, status: statusOf(), ownerProfiles };
}

function profilesOf(): ImOwnerProfileOption[] {
  return [
    { id: 'claude_owner', channel: 'default_claude', engine: 'claude', engineKind: 'claude', model: 'claude-opus-5-5', effort: 'high', selectable: true },
    { id: 'codex_owner', channel: 'default_codex', engine: 'codex', engineKind: 'codex', model: 'gpt-6.1-sol', effort: 'high', selectable: true },
    { id: 'pi_owner', channel: 'default_pi', engine: 'pi', engineKind: 'pi', model: 'glm-5.3-flash', effort: 'high', selectable: false, reason: 'disabled' },
  ];
}

function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, enableCustomFonts: false, children: React.createElement(ThemeScope, { appearance: 'light', children: node }) }));
}

test('owner options start with auto, keep snapshot order and label selectable profiles as id · kind · model', () => {
  const options = ownerProfileOptions(profilesOf());
  assert.equal(options.length, 4);
  assert.deepEqual(options[0], { value: OWNER_AUTO_VALUE, label: '自动（按策略）', disabled: false });
  assert.deepEqual(options.slice(1).map(option => option.value), ['claude_owner', 'codex_owner', 'pi_owner']);
  assert.equal(options[1].label, 'claude_owner · claude · claude-opus-5-5');
  assert.equal(options[1].disabled, false);
  assert.equal(options[2].label, 'codex_owner · codex · gpt-6.1-sol');
});

test('owner options disable unselectable profiles with a per-reason suffix', () => {
  const profiles: ImOwnerProfileOption[] = [
    { id: 'a_off', channel: 'default_claude', engine: 'claude', engineKind: 'claude', model: 'm', effort: 'high', selectable: false, reason: 'disabled' },
    { id: 'b_nochannel', channel: 'default_grok', engine: 'grok', engineKind: 'grok', model: 'm', effort: 'high', selectable: false, reason: 'channel_disabled' },
    { id: 'c_worker', channel: 'default_pi', engine: 'pi', engineKind: 'pi', model: 'm', effort: 'high', selectable: false, reason: 'not_launchable' },
  ];
  const options = ownerProfileOptions(profiles);
  assert.equal(options[1].label, 'a_off · claude · m（已停用）');
  assert.equal(options[2].label, 'b_nochannel · grok · m（渠道未启用）');
  assert.equal(options[3].label, 'c_worker · pi · m（不能作为父 Agent 启动）');
  assert.ok(options.slice(1).every(option => option.disabled));
});

test('a missing owner appended by the backend keeps its id with the deleted suffix', () => {
  const options = ownerProfileOptions([
    ...profilesOf(),
    { id: 'gone_owner', channel: '', engine: '', engineKind: '', model: '', effort: '', selectable: false, reason: 'missing' },
  ]);
  const last = options[options.length - 1];
  assert.equal(last.value, 'gone_owner');
  assert.equal(last.disabled, true);
  assert.match(last.label, /^gone_owner/);
  assert.match(last.label, /（已删除）/);
});

test('an empty pin and a selectable pin never raise an owner error', () => {
  const profiles = profilesOf();
  assert.equal(ownerProfileError('', profiles, '', true), '');
  assert.equal(ownerProfileError('claude_owner', profiles, '', true), '');
  assert.equal(ownerProfileError('codex_owner', profiles, 'claude_owner', true), '');
  assert.equal(ownerProfileError('', undefined, '', true), '');
});

test('the auto sentinel maps back to an empty pin and a real pin passes through untouched', () => {
  assert.equal(ownerSelectValue(OWNER_AUTO_VALUE), '', 'picking the auto option stores "" in the draft');
  assert.equal(ownerSelectValue('codex_owner'), 'codex_owner');
  assert.equal(ownerSelectValue(undefined), '', 'lobe single-select reports a valueless option as undefined; the draft keeps ""');
  assert.equal(ownerSelectDisplay(''), OWNER_AUTO_VALUE, 'an empty pin renders through the sentinel so the box shows the auto label');
  assert.equal(ownerSelectDisplay(undefined), OWNER_AUTO_VALUE);
  assert.equal(ownerSelectDisplay('codex_owner'), 'codex_owner');
  const options = ownerProfileOptions(profilesOf());
  assert.equal(options.find(option => option.value === ownerSelectDisplay(''))?.label, '自动（按策略）', 'the displayed sentinel resolves to the auto label');
});

test('the auto sentinel can never collide with a legal profile id', () => {
  assert.doesNotMatch(OWNER_AUTO_VALUE, /^[A-Za-z0-9_-]+$/, 'backend ownerProfileId charset rejects the sentinel');
  assert.doesNotMatch(OWNER_AUTO_VALUE, /^[a-z][a-z0-9_]{0,39}$/, 'policy owner id pattern rejects the sentinel');
});

test('an unselectable pin reports a per-reason error naming the parent agent', () => {
  const cases = [
    ['pi_owner', /已停用/],
    ['gone_owner', /已删除/],
    ['ghost_owner', /已删除/],
  ] as const;
  const profiles: ImOwnerProfileOption[] = [
    ...profilesOf(),
    { id: 'b_nochannel', channel: 'default_grok', engine: 'grok', engineKind: 'grok', model: 'm', effort: 'high', selectable: false, reason: 'channel_disabled' },
    { id: 'c_worker', channel: 'default_pi', engine: 'pi', engineKind: 'pi', model: 'm', effort: 'high', selectable: false, reason: 'not_launchable' },
    { id: 'gone_owner', channel: '', engine: '', engineKind: '', model: '', effort: '', selectable: false, reason: 'missing' },
  ];
  for (const [id, pattern] of cases) {
    const message = ownerProfileError(id, profiles, '', true);
    assert.match(message, pattern, `${id} explains why it cannot be used`);
    assert.match(message, /父 Agent/);
    assert.match(message, /改选或切换为自动/);
    assert.doesNotMatch(message, /负责人|工作代理/);
  }
  assert.match(ownerProfileError('b_nochannel', profiles, '', true), /渠道未启用/);
  assert.match(ownerProfileError('c_worker', profiles, '', true), /无法启动/);
});

test('an invalid pin blocks the save plan while the payload still mirrors the draft', () => {
  const base = configOf();
  const draft: ImDraft = { ...draftOf(base), ownerProfileId: 'pi_owner' };
  const edit: ImEdit = { values: draft, base, revision: 5 };
  const plan = savePlan(edit, undefined, profilesOf());
  assert.match(plan.errors.ownerProfileId, /已停用/);
  assert.ok(plan.input, 'the refused draft still mirrors what the user picked');
  assert.equal(plan.input.config.ownerProfileId, 'pi_owner');
  assert.equal(plan.input.expectedRevision, 5);
});

test('a selectable pin passes validation and is carried through the save plan', () => {
  const base = configOf();
  const edit: ImEdit = { values: { ...draftOf(base), ownerProfileId: 'codex_owner' }, base, revision: 5 };
  const policy = defaultConfig();
  const plan = savePlan(edit, policy, profilesOf());
  assert.deepEqual(plan.errors, {});
  assert.equal(plan.input?.config.ownerProfileId, 'codex_owner');
  assert.deepEqual(validateDraft(edit.values, base, policy, profilesOf()), {});
});

test('turning the Bot off without touching the pin never blocks on a stale pin', () => {
  const base = configOf({ ownerProfileId: 'pi_owner' });
  const draft: ImDraft = { ...draftOf(base), enabled: false };
  assert.equal(draft.ownerProfileId, 'pi_owner', 'the pin is unchanged, only the switch moved');
  assert.deepEqual(validateDraft(draft, base, undefined, profilesOf()), {}, 'closing the Bot always stays possible');
  const plan = savePlan({ values: draft, base, revision: 5 }, undefined, profilesOf());
  assert.deepEqual(plan.errors, {});
  assert.equal(plan.input?.config.enabled, false);
});

test('turning the Bot off with a newly picked invalid pin is still refused', () => {
  const base = configOf({ ownerProfileId: '' });
  const draft: ImDraft = { ...draftOf(base), enabled: false, ownerProfileId: 'pi_owner' };
  assert.match(validateDraft(draft, base, undefined, profilesOf()).ownerProfileId, /已停用/);
});

test('changing only the pin is a real draft that resets on discard', () => {
  const base = configOf();
  const clean: ImEdit = { values: draftOf(base), base, revision: 5 };
  assert.equal(modifiedEdit(clean), false);
  assert.equal(valuesMatchConfig(clean.values, base), true);
  const dirty: ImEdit = { values: { ...draftOf(base), ownerProfileId: 'codex_owner' }, base, revision: 5 };
  assert.equal(modifiedEdit(dirty), true, 'picking a parent agent arms save/discard');
  assert.equal(valuesMatchConfig(dirty.values, base), false);
  assert.equal(valuesMatchConfig(draftOf({ ...base, ownerProfileId: 'codex_owner' }), { ...base, ownerProfileId: 'codex_owner' }), true);
});

test('the dispatch-master select carries the required accessible name', () => {
  const source = readFileSync(join(import.meta.dirname, '../../src/renderer/features/bots/ImSettings.tsx'), 'utf8');
  assert.match(source, /aria-label="调度主引擎"/, 'the NamedSelect names itself 调度主引擎');
});

test('the dispatch-master box itself shows the auto label when the pin is empty', () => {
  const base = configOf({ enabled: false, ownerProfileId: '' });
  const saved = snapshotOf(base, 5, profilesOf());
  const html = markup(React.createElement(ImSettingsView, {
    id: 'bot', loading: false, loadError: '', saved, values: draftOf(base), edit: undefined, conflict: false,
    fieldErrors: {}, saveError: '', saving: false, savedTick: false, refreshing: false, reconnecting: false,
    forceReading: false, dirty: false,
    channelOptions: [{ value: 'claude', label: 'claude', disabled: false }], channelUsable: true, discoveryEngine: 'claude',
    efforts: ['low', 'medium', 'high'], openCodeVariant: false,
    effortOptions: ['low', 'medium', 'high'].map(value => ({ value, label: value, disabled: false })),
    onRetryLoad: () => {}, onReloadLatest: () => {}, onRefreshStatus: () => {}, onReconnect: () => {},
    onUpdate: () => {}, onChannelChange: () => {}, onRemoveWorkspace: () => {}, onAddWorkspace: () => {},
    onTimeoutError: () => {}, onDiscard: () => {}, onSave: () => {},
  }));
  const rowStart = html.indexOf('data-bot-row="bot-owner"');
  assert.ok(rowStart > 0, 'the dispatch-master row exists');
  const rowEnd = html.indexOf('data-bot-row="', rowStart + 1);
  const row = html.slice(rowStart, rowEnd === -1 ? undefined : rowEnd);
  assert.match(row, /自动（按策略）/, 'the collapsed box directly shows the auto label instead of an empty box');
});

test('the settings row offers the dispatch master with auto first and surfaces the field error', () => {
  const base = configOf({ enabled: false, ownerProfileId: '' });
  const saved = snapshotOf(base, 5, profilesOf());
  const html = markup(React.createElement(ImSettingsView, {
    id: 'bot', loading: false, loadError: '', saved, values: draftOf(base), edit: undefined, conflict: false,
    fieldErrors: {}, saveError: '', saving: false, savedTick: false, refreshing: false, reconnecting: false,
    forceReading: false, dirty: false,
    channelOptions: [{ value: 'claude', label: 'claude', disabled: false }], channelUsable: true, discoveryEngine: 'claude',
    efforts: ['low', 'medium', 'high'], openCodeVariant: false,
    effortOptions: ['low', 'medium', 'high'].map(value => ({ value, label: value, disabled: false })),
    onRetryLoad: () => {}, onReloadLatest: () => {}, onRefreshStatus: () => {}, onReconnect: () => {},
    onUpdate: () => {}, onChannelChange: () => {}, onRemoveWorkspace: () => {}, onAddWorkspace: () => {},
    onTimeoutError: () => {}, onDiscard: () => {}, onSave: () => {},
  }));
  const rowStart = html.indexOf('data-bot-row="bot-owner"');
  assert.ok(rowStart > 0, 'the dispatch-master row exists');
  const row = html.slice(rowStart, html.indexOf('data-bot-row="', rowStart + 1) === -1 ? undefined : html.indexOf('data-bot-row="', rowStart + 1));
  assert.match(row, /调度主引擎/);
  assert.match(row, /<label for="bot-owner">/, 'the native label names the control (NamedSelect id contract)');
  assert.match(row, /id="bot-owner"/);
  assert.match(row, /父 Agent/);
  assert.doesNotMatch(row, /负责人|工作代理/);
  const effortAt = html.indexOf('data-bot-row="bot-effort"');
  const workspaceAt = html.indexOf('data-bot-row="bot-workspaces"');
  assert.ok(effortAt > 0 && workspaceAt > 0, 'the neighbouring rows exist');
  assert.ok(effortAt < rowStart && rowStart < workspaceAt, 'the row sits after effort and before workspaces');

  const invalid = markup(React.createElement(ImSettingsView, {
    id: 'bot', loading: false, loadError: '', saved, values: { ...draftOf(base), ownerProfileId: 'pi_owner' },
    edit: { values: { ...draftOf(base), ownerProfileId: 'pi_owner' }, base, revision: 5 }, conflict: false,
    fieldErrors: { ownerProfileId: '当前选择的父 Agent 已停用，请改选或切换为自动。' }, saveError: '', saving: false,
    savedTick: false, refreshing: false, reconnecting: false, forceReading: false, dirty: true,
    channelOptions: [{ value: 'claude', label: 'claude', disabled: false }], channelUsable: true, discoveryEngine: 'claude',
    efforts: ['low', 'medium', 'high'], openCodeVariant: false,
    effortOptions: ['low', 'medium', 'high'].map(value => ({ value, label: value, disabled: false })),
    onRetryLoad: () => {}, onReloadLatest: () => {}, onRefreshStatus: () => {}, onReconnect: () => {},
    onUpdate: () => {}, onChannelChange: () => {}, onRemoveWorkspace: () => {}, onAddWorkspace: () => {},
    onTimeoutError: () => {}, onDiscard: () => {}, onSave: () => {},
  }));
  assert.match(invalid, /当前选择的父 Agent 已停用，请改选或切换为自动。/);
});

test('a stale pin closed with the Bot still surfaces the live hint without a save attempt', () => {
  const base = configOf({ enabled: false, ownerProfileId: 'pi_owner' });
  const saved = snapshotOf(base, 5, profilesOf());
  const html = markup(React.createElement(ImSettingsView, {
    id: 'bot', loading: false, loadError: '', saved, values: draftOf(base), edit: undefined, conflict: false,
    fieldErrors: {}, saveError: '', saving: false, savedTick: false, refreshing: false, reconnecting: false,
    forceReading: false, dirty: false,
    channelOptions: [{ value: 'claude', label: 'claude', disabled: false }], channelUsable: true, discoveryEngine: 'claude',
    efforts: ['low', 'medium', 'high'], openCodeVariant: false,
    effortOptions: ['low', 'medium', 'high'].map(value => ({ value, label: value, disabled: false })),
    onRetryLoad: () => {}, onReloadLatest: () => {}, onRefreshStatus: () => {}, onReconnect: () => {},
    onUpdate: () => {}, onChannelChange: () => {}, onRemoveWorkspace: () => {}, onAddWorkspace: () => {},
    onTimeoutError: () => {}, onDiscard: () => {}, onSave: () => {},
  }));
  assert.match(html, /当前选择的父 Agent 已停用，请改选或切换为自动。/, 'the poll/refreshed snapshot warns immediately even while the Bot stays off');
});
