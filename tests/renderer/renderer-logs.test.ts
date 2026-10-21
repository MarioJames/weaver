import assert from 'node:assert/strict';
import test from 'node:test';
import { redactLog, displayLog } from '../../src/renderer/features/tasks/log-view';
test('log redaction removes common credential formats',()=>{const value='Bearer ABCDEFG token=hidden password="secretpass" https://user:pw@example.com sk-abcdefghijklmnop ghp_abcdefghijklmnop';const redacted=redactLog(value);for(const secret of ['ABCDEFG','hidden','secretpass','user:pw','abcdefghijklmnop'])assert.equal(redacted.includes(secret),false);assert.match(redacted,/REDACTED/);});


test('fixed lifecycle and tool messages have Chinese display labels', () => {
  const cases = [
    ['Frozen work package created', '已冻结工作包'],
    ['Draft edited before start', '已在启动前编辑草稿'],
    ['Owner generated task title and acceptance criteria', '父 Agent 已生成任务标题和验收标准'],
    ['Launching codex in /work', '正在启动 codex，工作目录：/work'],
    ['Policy selected worker; launching codex in /work; engines excluded because they failed earlier in this retry chain: pi', '策略已选择子 Agent worker，正在 /work 启动 codex；因在本次重试链中曾失败而排除的引擎：pi'],
    ['Policy selected worker; explicit mock-jsonl provider; engines excluded because they failed earlier in this retry chain: pi', '策略已选择子 Agent worker，使用显式模拟执行；因在本次重试链中曾失败而排除的引擎：pi'],
    ['Launching codex…', '正在启动 codex…'],
    ['Received result.md', '已收到 result.md'],
    ['Result receipt acknowledged; acceptance unchanged', '已确认收到结果，验收状态未变'],
    ['tool started Bash', '调用工具 Bash'],
    ['tool finished Read', '工具完成 Read'],
    ['tool failed Edit', '工具失败 Edit'],
    ['Task queued. Owner reference is metadata only; no Herdr session was contacted.', '任务待执行。父 Agent 引用仅用于记录；未联系 Herdr 会话。'],
    ['Worker exited successfully; output is ready for owner review', '子 Agent 已成功退出，等待父 Agent 验收'],
    ['Dispatch admitted to queue; waiting for an execution slot', '派发已进入队列，等待执行名额'],
    ['Cancellation requested; waiting for worker exit', '已请求取消，等待子 Agent 退出'],
    ['Cancelled before dispatch', '已在派发前取消'],
    ['Cancelled; the owner should stop its built-in subagent', '已取消，父 Agent 应停止其内置子 Agent'],
    ['Worker stopped after cancellation', '子 Agent 已在取消后停止'],
    ['Started codex_owner in Herdr (owner-1)', '已在 Herdr 启动 codex_owner（owner-1）'],
    ['Vendor limit rerouted queued worker to pi', '因供应商限制，队列中的子 Agent 已改派至 pi'],
    ['Linked as a retry of task abc12345 and frozen with its package', '已关联为任务 abc12345 的重试，并冻结工作包'],
    ['Retried as task abc12345; engines excluded for the chain: codex', '已重试为任务 abc12345；本次重试链排除的引擎：codex'],
  ];
  for (const [source, label] of cases) {
    assert.equal(displayLog(source), label);
  }
});
