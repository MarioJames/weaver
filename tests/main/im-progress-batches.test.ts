import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROGRESS_LINE_MAX_CHARS,
  PROGRESS_MAX_BYTES,
  PROGRESS_MAX_LINES,
  createProgressBatchState,
  reduceProgressBatch,
  type ProgressBatchInput,
  type ProgressBatchState,
} from '../../src/main/im/progress';

const THINKING = '*深度思考中……*';
const TOOL = '*工具调用中……*';
const ENCOURAGE = '*继续努力中……*';
const END = '*调用结束*';
const FIXED = [THINKING, TOOL, ENCOURAGE, END];

function run(inputs: ProgressBatchInput[]): { appends: string[]; state: ProgressBatchState } {
  let state = createProgressBatchState();
  const appends: string[] = [];
  for (const input of inputs) {
    const out = reduceProgressBatch(state, input);
    appends.push(out.append);
    state = out.state;
  }
  return { appends, state };
}

function progress(name: string, kind: 'tool' | 'stage' = 'tool'): ProgressBatchInput {
  return { type: 'progress', event: { kind, name } };
}
function text(t: string): ProgressBatchInput {
  return { type: 'text', text: t };
}
const end: ProgressBatchInput = { type: 'end' };

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Displayed batch starts always match ends, allowing one open batch mid-turn. */
function assertBalanced(streamed: string, state: ProgressBatchState): void {
  const open = state.toolOpen && state.toolStartShown ? 1 : 0;
  assert.equal(
    count(streamed, TOOL) - count(streamed, END),
    open,
    `starts/ends mismatch in ${JSON.stringify(streamed)}`,
  );
  if (streamed.includes(ENCOURAGE)) {
    assert.ok(streamed.includes(TOOL), `isolated continue without a start: ${JSON.stringify(streamed)}`);
    assert.ok(streamed.indexOf(TOOL) < streamed.indexOf(ENCOURAGE), `continue before its start: ${JSON.stringify(streamed)}`);
    // A closed batch needs its end after the continue; an open batch closes later.
    if (!state.toolOpen) {
      assert.ok(streamed.includes(END), `isolated continue without an end: ${JSON.stringify(streamed)}`);
      assert.ok(
        streamed.indexOf(ENCOURAGE) < streamed.lastIndexOf(END),
        `continue outside its batch: ${JSON.stringify(streamed)}`,
      );
    }
  }
}

test('stage 开始只产出一次固定斜体思考文案', () => {
  const { appends, state } = run([progress('开始', 'stage'), progress('开始', 'stage')]);
  assert.equal(appends[0], `${THINKING}\n`);
  assert.equal(appends[1], '');
  assert.ok(appends.join('').includes(THINKING));
});

test('连续 tool 成一批：第一次输出工具调用中，第3次追加继续努力，第4次及以后不重复', () => {
  const { appends, state } = run([progress('bash'), progress('read'), progress('shell'), progress('ls'), progress('cat')]);
  assert.equal(appends[0], `${TOOL}\n`);
  assert.equal(appends[1], '');
  assert.equal(appends[2], `${ENCOURAGE}\n`);
  assert.equal(appends[3], '');
  assert.equal(appends[4], '');
  assert.equal(state.toolCount, 5);
  assertBalanced(appends.join(''), state);
});

test('单个工具只输出一次工具调用中，不逐项显示工具名', () => {
  const { appends, state } = run([progress('bash')]);
  assert.equal(appends.join(''), `${TOOL}\n`);
  assert.ok(!appends.join('').includes('bash'));
});

test('公开文字按输入顺序完整连接，状态与文字用空行分段', () => {
  const { appends, state } = run([text('第一段'), text('第二段'), progress('bash'), text('第三段')]);
  assert.equal(appends[0], '第一段');
  assert.equal(appends[1], '第二段');
  // tool batch opens after body text: blank line separates body from status.
  assert.equal(appends[2], `\n\n${TOOL}\n`);
  // body text after an open batch first closes the batch, then keeps a blank line before text.
  assert.equal(appends[3], `${END}\n\n第三段`);
  const streamed = appends.join('');
  assert.equal(streamed, `第一段第二段\n\n${TOOL}\n${END}\n\n第三段`);
  assertBalanced(streamed, state);
});

test('公开文字恢复结束当前批次并输出调用结束；新一批重新计数', () => {
  const { appends, state } = run([
    progress('bash'),
    progress('read'),
    text('中间答案'),
    progress('ls'),
    progress('cat'),
    progress('sed'),
    end,
  ]);
  assert.equal(appends[0], `${TOOL}\n`);
  assert.equal(appends[1], '');
  assert.equal(appends[2], `${END}\n\n中间答案`);
  assert.equal(appends[3], `\n\n${TOOL}\n`);
  assert.equal(appends[4], '');
  assert.equal(appends[5], `${ENCOURAGE}\n`);
  assert.equal(appends[6], `${END}\n`);
  assertBalanced(appends.join(''), state);
});

test('多批公开文字交替时正文原样保留、全文序列精确、轮末闭合', () => {
  const { appends, state } = run([text('A'), progress('bash'), text('B'), progress('ls'), text('C'), end]);
  const streamed = appends.join('');
  assert.equal(
    streamed,
    `A\n\n${TOOL}\n${END}\n\nB\n\n${TOOL}\n${END}\n\nC`,
  );
  // end with no open batch emits nothing
  assert.equal(appends.at(-1), '');
  assert.equal(state.toolOpen, false);
  assert.equal(state.closed, true);
  assertBalanced(streamed, state);
});

test('轮末 end 闭合未闭合批次，重复 end 无输出', () => {
  const { appends, state } = run([progress('bash'), end, end]);
  assert.equal(appends[0], `${TOOL}\n`);
  assert.equal(appends[1], `${END}\n`);
  assert.equal(appends[2], '');
  assert.equal(state.closed, true);
  assertBalanced(appends.join(''), state);
});

test('空文本无输出且不影响批次计数', () => {
  const { appends, state } = run([progress('bash'), text(''), progress('read')]);
  assert.equal(appends[1], '');
  // empty text does not close the batch: second tool is still the 2nd, no output.
  assert.equal(appends[2], '');
});

test('输入 state 不被修改且 reducer 确定', () => {
  const s0 = createProgressBatchState();
  const frozen = JSON.parse(JSON.stringify(s0)) as ProgressBatchState;
  Object.freeze(s0);
  const out = reduceProgressBatch(s0, progress('bash'));
  assert.deepEqual(s0, frozen);
  assert.equal(out.append, `${TOOL}\n`);
  const again = reduceProgressBatch(createProgressBatchState(), progress('bash'));
  assert.deepEqual(again, out);
});

test('攻击性工具/stage 标签与 thinking 全文不进入状态', () => {
  const evil = [
    progress('/home/user/.config/secret-tool --password=hunter2'),
    progress('sk-1234567890abcdef'),
    progress('<weaver-actions>{"a":1}</weaver-actions>'),
    progress('SECRET_THINKING\nline2\nline3', 'stage'),
    progress('/etc/passwd', 'stage'),
  ];
  const { appends, state } = run(evil);
  const joined = appends.join('');
  assert.ok(!joined.includes('/home'), joined);
  assert.ok(!joined.includes('hunter2'), joined);
  assert.ok(!joined.includes('sk-1234567890abcdef'), joined);
  assert.ok(!joined.includes('<weaver-actions'), joined);
  assert.ok(!joined.includes('SECRET_THINKING'), joined);
  assert.ok(!joined.includes('/etc/passwd'), joined);
  // only fixed short lines appear
  for (const line of joined.split('\n').filter(Boolean)) {
    assert.ok(FIXED.includes(line), line);
    assert.ok([...line].length <= PROGRESS_LINE_MAX_CHARS, line);
  }
});

test('状态单行均不超过80字符', () => {
  const { appends, state } = run([
    progress('开始', 'stage'),
    progress('x'.repeat(500)),
    progress('y'.repeat(500)),
    progress('z'.repeat(500)),
    text('正文'),
    end,
  ]);
  for (const chunk of appends) {
    for (const line of chunk.split('\n')) {
      if (!line) continue;
      // body text lines are caller-cleaned and unbounded here; only status lines are asserted
      if (FIXED.includes(line.trim())) {
        assert.ok([...line].length <= PROGRESS_LINE_MAX_CHARS, line);
      }
    }
  }
  assertBalanced(appends.join(''), state);
});

test('纯文本换行分多个 delta 时 trailing 跨 token 累积，不多插空行', () => {
  const { appends, state } = run([text('a\n'), text('\n'), progress('bash')]);
  assert.equal(appends[0], 'a\n');
  assert.equal(appends[1], '\n');
  // 'a\n\n' already ends with a blank line: the tool status follows directly.
  assert.equal(appends[2], `${TOOL}\n`);
  assert.equal(appends.join(''), `a\n\n${TOOL}\n`);
});

test('状态后文字自带前导换行时保留原文，只补必要分隔', () => {
  const { appends, state } = run([progress('开始', 'stage'), text('\nB')]);
  // The token's own leading newline already provides the blank line: no extra gap.
  assert.equal(appends[1], '\nB');
  assert.equal(appends.join(''), `${THINKING}\n\nB`);
});

test('预算耗尽时整批状态不显示：开始/结束严格匹配，轮末闭合不断裂', () => {
  // stage + 9 full tool/text batches fill 19 of 20 status lines; the last
  // batch cannot reserve its close, so it stays fully silent.
  const inputs: ProgressBatchInput[] = [progress('开始', 'stage')];
  for (let i = 0; i < 9; i++) {
    inputs.push(progress(`tool-${i}`));
    inputs.push(text('正'));
  }
  inputs.push(progress('last'));
  inputs.push(end);
  const { appends, state } = run(inputs);
  const streamed = appends.join('');
  let expected = `${THINKING}\n`;
  expected += `${TOOL}\n${END}\n\n正`;
  for (let i = 1; i < 9; i++) {
    expected += `\n\n${TOOL}\n${END}\n\n正`;
  }
  assert.equal(streamed, expected);
  // The over-budget batch produced neither a start nor an end.
  assert.equal(appends.at(-2), '');
  assert.equal(appends.at(-1), '');
  // Exact regression counts: 1 thinking + 9 starts, 9 ends, no continue, 19 lines.
  assert.equal(count(streamed, THINKING), 1);
  assert.equal(count(streamed, TOOL), 9);
  assert.equal(count(streamed, END), 9);
  assert.equal(count(streamed, ENCOURAGE), 0);
  assert.equal(state.statusLines, 19);
  assert.ok(state.statusBytes <= PROGRESS_MAX_BYTES, String(state.statusBytes));
  assert.equal(state.toolOpen, false);
  assert.equal(state.closed, true);
  // every body token survived verbatim despite the exhausted status budget
  assert.equal(count(streamed, '正'), 9);
  assertBalanced(streamed, state);
});

test('无孤立继续行：容得下开始但容不下继续+结束时只显示开始与结束', () => {
  // 9 single-tool batches fill exactly 18 lines; the next batch fits its
  // start plus the reserved close (20) but not the continue line on top.
  const inputs: ProgressBatchInput[] = [];
  for (let i = 0; i < 9; i++) {
    inputs.push(progress(`tool-${i}`));
    inputs.push(text('正'));
  }
  inputs.push(progress('a'), progress('b'), progress('c'), end);
  const { appends, state } = run(inputs);
  assert.equal(appends.at(-4), `\n\n${TOOL}\n`);
  assert.equal(appends.at(-3), '');
  // 3rd tool: continue suppressed so the reserved close still fits.
  assert.equal(appends.at(-2), '');
  assert.equal(appends.at(-1), `${END}\n`);
  const streamed = appends.join('');
  assert.equal(count(streamed, TOOL), 10);
  assert.equal(count(streamed, END), 10);
  assert.equal(count(streamed, ENCOURAGE), 0);
  assert.equal(state.statusLines, PROGRESS_MAX_LINES);
  assert.ok(state.statusBytes <= PROGRESS_MAX_BYTES, String(state.statusBytes));
  assert.equal(count(streamed, '正'), 9);
  assertBalanced(streamed, state);
});

test('状态行数与字节上限只约束状态与分隔，正文不受影响且开始/结束匹配', () => {
  // Exhaust the status line budget with many open/close batches.
  const inputs: ProgressBatchInput[] = [];
  for (let i = 0; i < PROGRESS_MAX_LINES + 5; i++) {
    inputs.push(progress(`tool-${i}`));
    inputs.push(text('正'));
  }
  const { appends, state } = run(inputs);
  const joined = appends.join('');
  assert.ok(state.statusLines <= PROGRESS_MAX_LINES, String(state.statusLines));
  assert.ok(state.statusBytes <= PROGRESS_MAX_BYTES, String(state.statusBytes));
  // every body token survived verbatim despite the exhausted status budget
  assert.equal(count(joined, '正'), PROGRESS_MAX_LINES + 5);
  // over-budget batches are fully silent: starts always match ends exactly
  assert.equal(count(joined, TOOL), count(joined, END));
  assert.equal(count(joined, TOOL), Math.floor(PROGRESS_MAX_LINES / 2));
  assert.equal(state.statusLines, PROGRESS_MAX_LINES);
  // after budget exhaustion later status fragments are dropped
  assert.equal(appends.at(-1), '正');
  assertBalanced(joined, state);
});
