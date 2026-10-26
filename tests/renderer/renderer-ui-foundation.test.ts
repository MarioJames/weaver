import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import { DISPLAY_STATUSES, DISPLAY_TONES } from '../../src/renderer/format/status-colors';
import { statusTagColor } from '../../src/renderer/format/tag-colors';
import { MasterDetail } from '../../src/renderer/ui/MasterDetail';
import { masterDetailStyles } from '../../src/renderer/ui/master-detail-style';
import { CompactMetrics } from '../../src/renderer/ui/CompactMetrics';
import { Pane } from '../../src/renderer/ui/Pane';
import { SelectableList, type SelectableSection } from '../../src/renderer/ui/SelectableList';
import { selectableListStyles } from '../../src/renderer/ui/selectable-list-style';
import { GroupHeading } from '../../src/renderer/ui/GroupHeading';
import { StatusBadge } from '../../src/renderer/ui/StatusBadge';
import { AgentChip } from '../../src/renderer/ui/AgentChip';
import { SaveBar } from '../../src/renderer/ui/SaveBar';
import { SettingGroup } from '../../src/renderer/ui/SettingGroup';
import { SettingRow } from '../../src/renderer/ui/SettingRow';
import { EntityLink } from '../../src/renderer/ui/EntityLink';
import { styleCss, styleTokenValues } from './style-helpers';

const markup = (node: React.ReactNode) => renderToStaticMarkup(React.createElement(ConfigProvider, {
  motion, enableCustomFonts: false,
  children: React.createElement(ThemeScope, { appearance: 'light', children: node }),
}));

test('MasterDetail renders list, main and inspector in one frame', () => {
  const html = markup(React.createElement(MasterDetail, {
    list: React.createElement('span', null, '会话列表'),
    main: React.createElement('span', null, '会话详情'),
    inspector: React.createElement('span', null, '任务检查器'),
    inspectorOpen: true,
    onInspectorClose: () => {},
    inspectorLabel: '任务详情',
    listLabel: '会话',
    mainLabel: '详情',
    mobileView: 'main',
  }));
  assert.match(html, /aria-label="会话"/);
  assert.match(html, /aria-label="详情"/);
  assert.match(html, /aria-label="任务详情"/);
  assert.match(html, /会话列表/);
  assert.match(html, /会话详情/);
  assert.match(html, /任务检查器/);
  // The inspector owns its own title and close button; the frame renders none.
  assert.doesNotMatch(html, /关闭任务详情/);
});

test('MasterDetail CSS uses the agreed widths and breakpoints without shadows or horizontal scroll', () => {
  const url = new URL('../../src/renderer/ui/master-detail-style.ts', import.meta.url);
  const list = styleCss(url, masterDetailStyles.list(true)[0]);
  const inspector = styleCss(url, masterDetailStyles.inspector(true, true, true)[0]);
  assert.match(list, /@media \(min-width: 1440px\)/);
  assert.match(list, /@media \(max-width: 1023\.98px\)/);
  assert.match(list, /width:280px/);
  assert.match(list, /width:var\(--weaver-list-width\)/);
  assert.match(list, /width:100%/);
  assert.match(inspector, /inset-inline-end:0/);
  assert.match(inspector, /width:min\(560px,calc\(100% - 280px\)\)/);
  assert.match(inspector, /@media \(min-width: 1440px\)\{[^}]*width:480px/);
  assert.match(styleCss(url, masterDetailStyles.main(true)[0]), /overflow-x:hidden/);
  assert.match(styleCss(url, masterDetailStyles.listWidth(320)[0]), /--weaver-list-width:var\(/);
  assert.doesNotMatch(inspector, /box-shadow/);
});

test('CompactMetrics packs label, value and hint in one row with optional filter buttons', () => {
  const html = markup(React.createElement(CompactMetrics, {
    label: '测试指标',
    items: [
      { label: '执行中', value: 2 },
      { label: '需关注', value: 5, hint: '含失败', valueTone: 'warning', onClick: () => {}, pressed: true },
    ],
  }));
  assert.match(html, /aria-label="测试指标"/);
  for (const text of ['执行中', '需关注', '含失败']) assert.match(html, new RegExp(text));
  assert.match(html, />2</);
  assert.match(html, />5</);
  assert.match(html, /aria-pressed="true"/);
  const loading = markup(React.createElement(CompactMetrics, { label: '测试指标', loading: true, items: [{ label: '执行中', value: 2 }] }));
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /—/);
});

test('Pane keeps its head, toolbar and footer outside the scrolling body', () => {
  const html = markup(React.createElement(Pane, {
    label: '任务列表',
    title: '任务',
    actions: React.createElement('span', null, '操作'),
    toolbar: React.createElement('span', null, '筛选工具'),
    footer: React.createElement('span', null, '页脚'),
    children: React.createElement('span', null, '滚动内容'),
  }));
  assert.match(html, /aria-label="任务列表"/);
  for (const text of ['任务', '操作', '筛选工具', '滚动内容', '页脚']) assert.match(html, new RegExp(text));
});

test('SelectableList exposes listbox options with one selected row and a derived active option', () => {
  const sections: SelectableSection<{ id: string }>[] = [{
    key: 'group',
    heading: React.createElement(GroupHeading, { label: '工作目录', count: 2 }),
    items: [{ id: 'one' }, { id: 'two' }],
  }];
  const html = markup(React.createElement(SelectableList<{ id: string }>, {
    label: '任务列表',
    sections,
    getKey: item => item.id,
    selectedKey: 'two',
    onSelect: () => {},
    renderItem: (item, state) => React.createElement('span', null, `${item.id}:${state.selected}`),
  }));
  assert.match(html, /role="listbox"/);
  assert.match(html, /aria-label="任务列表"/);
  assert.match(html, /aria-activedescendant="[^"]*-option-1"/);
  const options = [...html.matchAll(/<div[^>]*role="option"[^>]*>/g)].map(match => match[0]);
  assert.equal(options.length, 2);
  assert.match(options[0]!, /aria-selected="false"/);
  assert.match(options[1]!, /aria-selected="true"/);
  assert.match(html, /one:false/);
  assert.match(html, /two:true/);
  assert.match(html, /工作目录/);
});

test('SelectableList virtual mode renders rows through virtua with the same listbox contract', () => {
  const html = markup(React.createElement(SelectableList<{ id: string }>, {
    label: '虚拟任务列表',
    sections: [{ key: 'virtual', heading: '全部任务', items: Array.from({ length: 12 }, (_, index) => ({ id: `v-${index}` })) }],
    getKey: item => item.id,
    selectedKey: 'v-3',
    onSelect: () => {},
    virtual: true,
    renderItem: item => React.createElement('span', null, item.id),
  }));
  assert.match(html, /role="listbox"/);
  assert.match(html, /aria-label="虚拟任务列表"/);
  assert.match(html, /role="option"/);
  assert.match(html, /v-3/);
});

test('SelectableList selected and hover surfaces come from the shared fill tokens', () => {
  const url = new URL('../../src/renderer/ui/selectable-list-style.ts', import.meta.url);
  const tokens = styleTokenValues(styleCss(url, selectableListStyles.option));
  assert.ok(tokens.includes('var(--lobe-color-fill-secondary)'));
  assert.ok(tokens.includes('var(--lobe-color-fill-tertiary)'));
});

test('StatusBadge takes every tag color from DISPLAY_TONES through tag-colors', () => {
  for (const status of DISPLAY_STATUSES) {
    const html = markup(React.createElement(StatusBadge, { status, variant: 'tag' }));
    const expected = statusTagColor(DISPLAY_TONES[status]);
    assert.match(html, /data-variant="solid"/);
    if (expected) assert.match(html, new RegExp(`data-color="${expected}"`));
    else assert.doesNotMatch(html, /data-color=/);
  }
  assert.match(markup(React.createElement(StatusBadge, { status: 'rejected' })), /data-tone="volcano"/);
  assert.match(markup(React.createElement(StatusBadge, { status: 'rejected' })), /需修改/);
});

test('SaveBar only exists for a dirty draft and offers both actions', () => {
  assert.equal(renderToStaticMarkup(React.createElement(SaveBar, { dirty: false, onSave: () => {}, onDiscard: () => {} })), '');
  const html = markup(React.createElement(SaveBar, { dirty: true, saving: false, onSave: () => {}, onDiscard: () => {} }));
  assert.match(html, /role="region"/);
  assert.match(html, /aria-label="未保存的修改"/);
  assert.match(html, /有未保存的修改/);
  assert.match(html, /放弃修改/);
  assert.match(html, />保存</);
  const custom = markup(React.createElement(SaveBar, { dirty: true, message: '2 个父 Agent 有未保存的修改', onSave: () => {}, onDiscard: () => {} }));
  assert.match(custom, /2 个父 Agent 有未保存的修改/);
});

test('AgentChip, GroupHeading, SettingGroup/Row and EntityLink render the shared vocabulary', () => {
  const html = markup(React.createElement(React.Fragment, null,
    React.createElement(AgentChip, { kind: 'claude', name: 'claude_owner', title: '父 Agent / claude_owner' }),
    React.createElement(GroupHeading, { label: 'weaver', count: 4, title: '/home/mocha/opensource/weaver' }),
    React.createElement(SettingGroup, {
      title: '基本', tips: '只影响新任务',
      children: React.createElement(SettingRow, {
        label: '模型', tips: '选择执行模型', hint: '保存后生效', status: React.createElement('span', null, '已保存'),
        children: React.createElement('span', null, '控件'),
      }),
    }),
    React.createElement(EntityLink, { route: { page: 'tasks', view: 'all', taskId: 'a/b' }, title: '任务全名', children: '任务 a/b' }),
  ));
  assert.match(html, /claude_owner/);
  assert.match(html, /title="父 Agent \/ claude_owner"/);
  assert.match(html, /weaver/);
  assert.match(html, /title="\/home\/mocha\/opensource\/weaver"/);
  assert.match(html, /基本/);
  assert.match(html, /模型/);
  assert.match(html, /保存后生效/);
  assert.match(html, /已保存/);
  assert.match(html, /href="#\/tasks\/all\/t\/a%2Fb"/);
  assert.match(html, /title="任务全名"/);
});
