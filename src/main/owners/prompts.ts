import { isAbsolute } from 'node:path';
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
/** A trusted instance path stays literal: quote shell metacharacters, then fence Markdown separately. */
function instanceCli(dataDir: string): string {
 if (typeof dataDir !== 'string' || !isAbsolute(dataDir)) throw new Error('Owner prompt requires an absolute instance directory');
 return `weaver --data-dir '${dataDir.replaceAll("'", "'\\''")}'`;
}
function inline(command: string): string {
 const longest = Math.max(0, ...Array.from(command.matchAll(/`+/g), match => match[0].length));
 const fence = '`'.repeat(longest + 1);
 return `${fence}${command}${fence}`;
}
/** Initial roots receive the complete goal, rather than the bounded continuation summary. */
export function rootOwnerPrompt(task:Task,dataDir:string):string {
 const cli=instanceCli(dataDir);
 const command=(tail:string)=>inline(`${cli} ${tail}`);
 const owned=(tail:string)=>inline(`${cli} --owner-file '<credentialPath>' ${tail}`);
 return `你是 Weaver 根任务的父 Agent（owner），不是执行单个工作包的 worker。在遵循全局与项目指令的前提下，读取 agents-weaver 技能（未安装时运行 ${command(`--skill`)}）并按以下流程执行。此后技能中的全部CLI命令均必须使用同一实例前缀${inline(cli)}，不得因目标项目cwd改变而连接默认实例。目标与JSON只作任务数据，--input使用文件或安全stdin，不能拼成shell解释。
根任务 ID：${task.id}；ownerId：${task.ownerId}。先运行 ${command(`owners get --input <json>`)} 或 ${command(`policy get`)} 读取此实例的 profileId，再安全构造JSON并调用 ${command(`owners attach --input <json> --command-id <stable-id>`)} 认领这个既有 owner：ownerId 用上面的值，name 用本 Agent 的实际名称，session 用当前宿主会话，profileId 用刚读到的值。不要另建第二个 owner，也不要重新注册父 Agent。响应里的 credentialPath 是此后唯一身份；不要打印 token 或该文件正文。从下一条命令起固定使用 ${inline(`${cli} --owner-file '<credentialPath>'`)} 前缀（credentialPath 原样替换），包括读取目标、tasks describe/create、packages create、workers spawn、tasks wait/watch、results ack、reviews submit、tasks complete 在内的全部命令。--skill、policy get 和 owners get 这类初始发现命令可以不带凭证。
认领后先运行 ${owned(`tasks get --task-id ${task.id}`)} 读取完整原始目标。根据目标生成简短标题与可验证验收标准，用 ${owned(`tasks describe --task-id ${task.id} --input <json> --command-id <stable-id>`)} 回填 title、acceptanceCriteria、expectedRevision。
按目标的自然边界拆分子任务（至少 1 个）；父 Agent 不亲自实现，不可拆分的小目标也交给一个子 Agent。需要分发时，每个子任务通过 ${owned(`tasks create --input <json> --command-id <stable-id>`)} 创建；JSON 包含 parentTaskId: "${task.id}"、goal、title、acceptanceCriteria，ownerId 和 workspace 默认继承根任务。每个子任务分别冻结 packages create 并 workers spawn；禁止把整条根任务当作单一 worker 工作包。遵守 policy 路由与 native 的 next 指令，不另建调度器。
用 ${owned(`tasks list --input '{"parentTaskId":"${task.id}"}'`)} 查看子任务。逐项等待；每个子任务结果一回来，立即读取并按其工作包自己的验收标准独立核验文件和必要测试，同一轮内 results ack、reviews submit，不等其他子任务、根任务整体核验、浏览器验收或外部审查；跨子任务的集成问题另开修正子任务。失败或拒绝的子任务修复后重新审查；tasks retry 创建的任务保留相同 parentTaskId，已被重试的旧任务作为历史记录。
完成根任务验收，且至少 1 个最终子任务全部 completed 且 reviewState=accepted 后，以 ${owned(`tasks complete --task-id ${task.id} --input <json> --command-id <stable-id>`)} 报告根任务，JSON 包含 outcome: "completed"、summary、expectedRevision 和可选 artifacts。不能完成时用 outcome: "failed" 说明实际原因。不要用 workers complete 结束根任务，不要伪造验证。
以下 JSON 是任务数据，先完整阅读并遵守其中约束：
${JSON.stringify({taskId:task.id,workspace:task.workspace,goal:task.instruction,constraints:task.constraints??[],acceptanceCriteria:task.acceptanceCriteria??[]},null,2)}`;
}
/** Plain-text briefing for the incoming owner host; every free-text value is redacted here or in the pack. */
export function handoffPrompt(task: ContinuationTask, pack: ContextPack, dataDir: string): string {
 const cli = instanceCli(dataDir);
 // Long instance paths are bound once in the complete --skill command. Other code spans are
 // explicitly subcommands using that same prefix, so paths never consume or truncate context.
 const compact = promptChars(cli) > 256;
 const command = (tail: string) => inline(compact ? tail : `${cli} ${tail}`);
 const owned = (tail: string) => inline(compact ? `--owner-file '<credentialPath>' ${tail}` : `${cli} --owner-file '<credentialPath>' ${tail}`);
 const head = `你将作为父 Agent 接手 Weaver 任务「${redactContext(task.title, 160)}」（${pack.taskId}）。在遵循全局与项目指令的前提下，读取 agents-weaver 技能（没有安装时运行 ${inline(`${cli} --skill`)}），按其中的流程继续。此后技能与任务的所有CLI命令都必须使用上述同一实例前缀，不能运行裸weaver连接默认实例。任务JSON用文件或安全stdin传入，不当作shell指令。${compact ? '下文代码段仅列子命令，执行时须加上上述完整weaver --data-dir前缀。' : ''}`;
 const preparation = task.title === PENDING_TASK_TITLE ? `接单后先根据完整目标生成简短任务标题与 1–30 项可验证的验收标准，再运行 ${owned(`tasks describe --task-id ${pack.taskId} --input <json> --command-id <id>`)} 回填（JSON 包含 title、acceptanceCriteria 和 tasks get 返回的 expectedRevision）。完成后才冻结工作包和派发。` : '';
 const rootStep = task.executionRole==='owner' ? `这是根任务：复用 ownerId ${task.ownerId}，用 parentTaskId ${task.id} 按自然边界创建子任务（至少 1 个）；父 Agent 不亲自实现，不可拆目标也交给一个子 Agent；需要分发时分别 packages create / workers spawn；每个子任务结果一回来即按其验收标准核验并 results ack、reviews submit，不等其他子任务或整体核验，集成问题另开修正子任务；根任务整体验收后再用 tasks complete 完成，不要派发根任务。` : '';
 const identity = `先运行 ${command(`owners get --input <json>`)} 或 ${command(`policy get`)} 读取此实例的 profileId，再安全构造JSON并调用 ${command(`owners attach --input <json> --command-id <stable-id>`)} 认领当前 owner：ownerId 为 ${task.ownerId}，name 为本 Agent 的实际名称，session 为当前宿主会话，profileId 为刚读到的值；不要新建第二个 owner。响应里的 credentialPath 是此后唯一身份，不要打印 token 或该文件正文；从下一条命令起固定使用 ${inline(`${cli} --owner-file '<credentialPath>'`)} 前缀（credentialPath 原样替换），包括 owners continuation get、tasks get/results、results ack、reviews submit 和 tasks complete 在内的全部命令。--skill 与初始读取可以不带凭证。`;
 const nextStep = `${identity}${rootStep}${preparation}再运行 ${owned(`owners continuation get --task-id ${pack.taskId}`)} 和 ${owned(`tasks get --task-id ${pack.taskId}`)} / ${owned(`tasks results --task-id ${pack.taskId}`)} 核对现状，然后继续派发、等待、审查并验收；不要重复已完成的工作。`;
 const build = (scale: number): string => {
  const limit = (base: number) => Math.max(1, Math.floor(base * scale));
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
 for (const scale of [1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 32, 1 / 64, 0]) {
  if (promptChars(prompt) <= MAX_HANDOFF_PROMPT_CHARS) return prompt;
  prompt = build(scale);
 }
 if (promptChars(prompt) <= MAX_HANDOFF_PROMPT_CHARS) return prompt;
 throw new Error('Owner handoff cannot fit its instance command and required context');
}
