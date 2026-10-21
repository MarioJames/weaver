import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { PI_MISSING_MODEL_TEXT, missingModelWarning } from '../../src/renderer/features/engines/engine-models';
import { ModelListWarning } from '../../src/renderer/features/engines/ModelPicker';
import type { EngineModelList } from '../../src/shared/engines';

const list = (status: EngineModelList['status'], ...ids: string[]): EngineModelList => ({ engine: 'pi', status, source: 'pi --list-models', models: ids.map(id => ({ id })), fetchedAt: '2026-01-01T00:00:00.000Z' });
const markup = (node: React.ReactNode) => renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { enableCustomFonts: false }, node) }));
const SAVED = 'cc-switch-agentplan/glm-5.3-flash';

test('pi: a saved model missing from the current list warns, and the warning goes away once it is listed or replaced', () => {
  const after = list('ok', 'cc-switch-zhipu-glm/glm-5.3', 'cc-switch-zhipu-glm/glm-5.3-flash');
  assert.equal(missingModelWarning('pi', SAVED, after), PI_MISSING_MODEL_TEXT);
  assert.match(PI_MISSING_MODEL_TEXT, /pi 当前未提供此模型.*cc-switch/);
  assert.equal(missingModelWarning('pi', 'cc-switch-zhipu-glm/glm-5.3-flash', after), undefined, 'picking a listed model clears it');
  assert.equal(missingModelWarning('pi', SAVED, list('ok', SAVED)), undefined, 'switching the provider back clears it');
  assert.equal(missingModelWarning('pi', `  ${SAVED}  `, list('ok', SAVED)), undefined);
});

test('no warning without a successful list, without a model, or for any other engine', () => {
  const after = list('ok', 'cc-switch-zhipu-glm/glm-5.3');
  assert.equal(missingModelWarning('pi', SAVED, undefined), undefined, 'still loading');
  assert.equal(missingModelWarning('pi', SAVED, list('failed')), undefined, 'a failed list proves nothing');
  assert.equal(missingModelWarning('pi', SAVED, list('unavailable')), undefined);
  assert.equal(missingModelWarning('pi', '', after), undefined);
  for (const engine of ['claude', 'codex', 'grok', 'opencode', 'qoder', 'zcode']) assert.equal(missingModelWarning(engine, SAVED, { ...after, engine }), undefined, engine);
});

test('the warning renders under the field as a status line only while the model is missing', () => {
  const after = list('ok', 'cc-switch-zhipu-glm/glm-5.3');
  const shown = markup(React.createElement(ModelListWarning, { engine: 'pi', value: SAVED, list: after }));
  assert.match(shown, /pi 当前未提供此模型，可能已在 cc-switch 切换供应商/);
  assert.match(shown, /role="status"/);
  assert.doesNotMatch(markup(React.createElement(ModelListWarning, { engine: 'pi', value: 'cc-switch-zhipu-glm/glm-5.3', list: after })), /cc-switch 切换供应商/);
  assert.doesNotMatch(markup(React.createElement(ModelListWarning, { engine: 'codex', value: SAVED, list: { ...after, engine: 'codex' } })), /cc-switch 切换供应商/);
});
