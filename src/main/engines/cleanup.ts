import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { embeddedApp } from '../embedded';
import { CLEANUP_RUNNER } from '../../shared/engine-cleanup';
import type { CleanupResult, EngineCleanupInput, EngineCleanupJob } from '../../shared/contracts/engine-cleanup';

export { parseEngineCleanup } from '../../shared/engine-cleanup';

export class EngineCleanupJobs {
 private entries = new Map<string, { job: EngineCleanupJob; now: number; used?: boolean }>();
 constructor(private readonly track: <T>(promise: Promise<T>) => Promise<T> = promise => promise, private readonly acquire?: () => () => void) {}
 start(input: EngineCleanupInput): EngineCleanupJob {
  for (const [id, entry] of this.entries) if (entry.job.status === 'done' && Date.now() - Date.parse(entry.job.startedAt) > 3600000) this.entries.delete(id);
  if ([...this.entries.values()].some(entry => entry.job.status === 'running')) throw new Error('已有数据库清理任务正在运行');
  let now = Date.now(); let selection: string | undefined; let consumePreview: (() => void) | undefined;
  if (input.mode === 'apply') {
   const preview = this.entries.get(input.previewId!);
   if (!preview || preview.used || preview.job.result?.status !== 'preview') throw new Error('预览已失效，请重新预览');
   const keys = ['engine', 'keepDays', 'pruneEvents', 'eventIdleMinutes', 'vacuum'] as const;
   if (keys.some(key => preview.job.input[key] !== input[key])) throw new Error('选项已变更，请重新预览');
   if (Date.now() - preview.now > 15 * 60000) throw new Error('预览已过期，请重新预览');
   now = preview.now; selection = preview.job.result.selection; consumePreview = () => { preview.used = true; };
  }
  const job: EngineCleanupJob = { id: randomBytes(8).toString('hex'), status: 'running', startedAt: new Date().toISOString(), input: { ...input }, progress: '正在检查数据库…' };
  const args = embeddedApp() ? [CLEANUP_RUNNER] : [...process.execArgv, process.argv[1]!, CLEANUP_RUNNER];
  const release = this.acquire?.();
  consumePreview?.();
  const entry = { job, now }; this.entries.set(job.id, entry);
  const run = new Promise<void>(resolve => {
   let output = ''; let settled = false;
   const finish = (result: CleanupResult) => { if (settled) return; settled = true; entry.job = { ...job, status: 'done', progress: '任务已结束', result }; resolve(); };
   try {
    const child = spawn(process.execPath, [...args, JSON.stringify({ input, now, selection })], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    child.stdout.on('data', chunk => { if (output.length < 8 * 1024 * 1024) output += chunk.toString(); });
    child.stderr.on('data', chunk => { const text = chunk.toString(); entry.job.progress = text.includes('VACUUM') ? '正在压缩数据库并整理日志文件…' : text.includes('Deleting') ? '正在删除已确认范围内的数据并核验保留数据…' : text.includes('committed') ? '事务已提交，正在完成空间统计…' : '正在检查数据库与清理范围…'; });
    child.once('error', error => finish({ status: 'error', error: error.message }));
    child.once('close', code => { try { const result = JSON.parse(output.trim()) as CleanupResult; if (!['preview', 'applied', 'skipped', 'error'].includes(result.status)) throw new Error('清理进程返回无效结果'); finish(result); } catch { finish({ status: 'error', error: `清理进程异常退出（${code}），请检查运行环境` }); } });
   } catch (error) { finish({ status: 'error', error: String(error) }); }
  });
  void this.track(run.finally(() => release?.()));
  return structuredClone(job);
 }
 get(id: unknown): EngineCleanupJob | undefined {
  if (id === 'opencode') return structuredClone([...this.entries.values()].at(-1)?.job);
  if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) throw new Error('无效的清理任务编号');
  return structuredClone(this.entries.get(id)?.job);
 }
}
