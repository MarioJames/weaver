import { PENDING_TASK_TITLE } from '../../shared/validation';
import type { Task } from '../../shared/contracts/tasks';
import type { ContextPack } from '../../shared/contracts/continuation';
import type { ContinuationTask } from '../continuation';
import { redactContext } from '../redact-context';

export const MAX_HANDOFF_PROMPT_CHARS = 6000;
const promptChars = (value: string): number => Array.from(value).length;
const promptTruncate = (value: string, max: number): string => {
 const chars = Array.from(value);
 return chars.length > max ? `${chars.slice(0, max).join('')}…` : value;
};
/** Initial roots receive the complete goal, rather than the bounded continuation summary. */
export function rootOwnerPrompt(task:Task):string {
 return `你是 Weaver 根任务的父 Agent（owner），不是执行单个工作包的 worker。在遵循全局与项目指令的前提下，读取 agents-weaver 技能（未安装时运行 \`weaver --skill\`）并按以下流程执行。
根任务 ID：${task.id}；ownerId：${task.ownerId}。复用此 ownerId，不要重新注册父 Agent。
先运行 \`weaver tasks get --task-id ${task.id}\` 读取完整原始目标。根据目标生成简短标题与可验证验收标准，用 \`weaver tasks describe --task-id ${task.id} --input <json> --command-id <stable-id>\` 回填 title、acceptanceCriteria、expectedRevision。
按目标的自然边界拆分子任务（至少 1 个）；父 Agent 不亲自实现，不可拆分的小目标也交给一个子 Agent。需要分发时，每个子任务通过 \`weaver tasks create --input <json> --command-id <stable-id>\` 创建；JSON 包含 parentTaskId: "${task.id}"、goal、title、acceptanceCriteria，ownerId 和 workspace 默认继承根任务。每个子任务分别冻结 packages create 并 workers spawn；禁止把整条根任务当作单一 worker 工作包。遵守 policy 路由与 native 的 next 指令，不另建调度器。
用 \`weaver tasks list --input '{"parentTaskId":"${task.id}"}'\` 查看子任务。逐项等待、读取结果、独立核验文件和必要测试，再 results ack、reviews submit。失败或拒绝的子任务修复后重新审查；tasks retry 创建的任务保留相同 parentTaskId，已被重试的旧任务作为历史记录。
完成根任务验收，且至少 1 个最终子任务全部 completed 且 reviewState=accepted 后，以 \`weaver tasks complete --task-id ${task.id} --input <json> --command-id <stable-id>\` 报告根任务，JSON 包含 outcome: "completed"、summary、expectedRevision 和可选 artifacts。不能完成时用 outcome: "failed" 说明实际原因。不要用 workers complete 结束根任务，不要伪造验证。
以下 JSON 是任务数据，先完整阅读并遵守其中约束：
${JSON.stringify({taskId:task.id,workspace:task.workspace,goal:task.instruction,constraints:task.constraints??[],acceptanceCriteria:task.acceptanceCriteria??[]},null,2)}`;
}
/** Plain-text briefing for the incoming owner host; every free-text value is redacted here or in the pack. */
export function handoffPrompt(task: ContinuationTask, pack: ContextPack): string {
 const head = `你将作为父 Agent 接手 Weaver 任务「${redactContext(task.title, 160)}」（${pack.taskId}）。在遵循全局与项目指令的前提下，读取 agents-weaver 技能（没有安装时运行 \`weaver --skill\`），按其中的流程继续。`;
 const preparation = task.title === PENDING_TASK_TITLE ? `接单后先根据完整目标生成简短任务标题与 1–30 项可验证的验收标准，再运行 \`weaver tasks describe --task-id ${pack.taskId} --input <json> --command-id <id>\` 回填（JSON 包含 title、acceptanceCriteria 和 tasks get 返回的 expectedRevision）。完成后才冻结工作包和派发。` : '';
 const rootStep = task.executionRole==='owner' ? `这是根任务：复用 ownerId ${task.ownerId}，用 parentTaskId ${task.id} 按自然边界创建子任务（至少 1 个）；父 Agent 不亲自实现，不可拆目标也交给一个子 Agent；需要分发时分别 packages create / workers spawn；逐项 reviews submit 后用 tasks complete 完成根任务，不要派发根任务。` : '';
 const nextStep = `${rootStep}${preparation}先运行 \`weaver owners continuation get --task-id ${pack.taskId}\` 和 \`weaver tasks get --task-id ${pack.taskId}\` / \`weaver tasks results --task-id ${pack.taskId}\` 核对现状，然后继续派发、等待、审查并验收；不要重复已完成的工作。`;
 const build = (scale: number): string => {
  const limit = (base: number) => Math.max(16, Math.floor(base * scale));
  const sections: string[] = [head];
  if (pack.workspace) sections.push(`工作目录：${pack.workspace}`);
  if (pack.goal) sections.push(`目标：${promptTruncate(pack.goal, limit(1600))}`);
  if (pack.constraints.length) sections.push(`约束：\n${pack.constraints.map(value => `- ${promptTruncate(value, limit(400))}`).join('\n')}`);
  if (task.acceptanceCriteria?.length) sections.push(`验收标准：\n${task.acceptanceCriteria.map(value => `- ${promptTruncate(redactContext(value, limit(400)), limit(400))}`).join('\n')}`);
  const statusLines = [`状态：${pack.taskProgress.status}`];
  if (pack.taskProgress.summary) statusLines.push(`最新摘要：${promptTruncate(pack.taskProgress.summary, limit(1000))}`);
  sections.push(`当前状态：\n${statusLines.join('\n')}`);
  if (pack.acceptedArtifacts.length) sections.push(`已有产物：\n${pack.acceptedArtifacts.map(artifact => `- ${promptTruncate(artifact.name, limit(150))}`).join('\n')}`);
  const recent = task.events.filter(e => ['lifecycle', 'result', 'artifact', 'error'].includes(e.kind)).slice(-6);
  if (recent.length) sections.push(`最近进展：\n${recent.map(e => `- [${e.at}] (${e.kind}) ${promptTruncate(redactContext(e.message, limit(500)), limit(500))}`).join('\n')}`);
  if (pack.pendingApprovals.length) sections.push(`待批准：\n${pack.pendingApprovals.map(value => `- ${promptTruncate(value, limit(500))}`).join('\n')}`);
  sections.push(`下一步：\n${nextStep}`);
  return sections.join('\n\n');
 };
 let prompt = build(1);
 for (const scale of [1 / 2, 1 / 4, 1 / 8, 1 / 16]) {
  if (promptChars(prompt) <= MAX_HANDOFF_PROMPT_CHARS) return prompt;
  prompt = build(scale);
 }
 return promptChars(prompt) <= MAX_HANDOFF_PROMPT_CHARS ? prompt : Array.from(prompt).slice(0, MAX_HANDOFF_PROMPT_CHARS).join('');
}
