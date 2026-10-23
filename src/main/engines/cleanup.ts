import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { embeddedApp } from '../embedded';
import { cleanup } from './opencode-cleanup-core.mjs';
import type { CleanupResult, EngineCleanupInput, EngineCleanupJob } from '../../shared/contracts/engine-cleanup';

export const CLEANUP_RUNNER = '__weaver-opencode-cleanup';
export function parseEngineCleanup(value: unknown): EngineCleanupInput {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('清理参数必须是对象');
 const raw = value as Record<string, unknown>;
 if (Object.keys(raw).some(key => !['engine', 'mode', 'keepDays', 'pruneEvents', 'eventIdleMinutes', 'vacuum', 'previewId'].includes(key))) throw new Error('不支持的清理字段');
 if (raw.engine !== 'opencode') throw new Error('仅支持清理 OpenCode');
 if (raw.mode !== 'preview' && raw.mode !== 'apply') throw new Error('无效的清理模式');
 if (!Number.isSafeInteger(raw.keepDays) || (raw.keepDays as number) < 1 || (raw.keepDays as number) > 36500) throw new Error('保留天数须为 1–36500 的整数');
 if (!Number.isSafeInteger(raw.eventIdleMinutes) || (raw.eventIdleMinutes as number) < 0 || (raw.eventIdleMinutes as number) > 52560000) throw new Error('空闲分钟须为 0–52560000 的整数');
 if (typeof raw.pruneEvents !== 'boolean' || typeof raw.vacuum !== 'boolean') throw new Error('清理开关须为布尔值');
 if (raw.previewId !== undefined && (typeof raw.previewId !== 'string' || !/^[a-f0-9]{16}$/.test(raw.previewId))) throw new Error('无效的预览编号');
 if (raw.mode === 'apply' && !raw.previewId) throw new Error('请先预览并确认清理范围');
 return raw as unknown as EngineCleanupInput;
}
const databasePath = () => process.env.OPENCODE_DB || join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'opencode/opencode.db');
/** Hidden subprocess entry. The database location is resolved from server environment only. */
function cleanupError(error: unknown): string {
 const message = error instanceof Error ? error.message : String(error);
 if (message.startsWith('Database does not exist:')) return 'OpenCode 数据库不存在，未创建新数据库。请确认服务端的数据库位置。';
 if (message.includes('requires Linux')) return '当前平台暂不支持安全检测 OpenCode 进程，未执行清理。';
 if (/Unknown schema|Unknown primary key|Unknown foreign key|Unsupported deletion foreign key|Unknown session timestamp/.test(message)) return '数据库结构暂不支持安全清理，未删除数据。请确认 OpenCode 版本。';
 if (message.includes('Database changed since preview')) return '数据库在预览后发生变化，未删除数据。请重新预览后确认。';
 if (message.includes('Database must be owned')) return '数据库不属于当前服务用户，未执行清理。';
 if (message.includes('Existing foreign key violations')) return '数据库已有外键完整性问题，未执行清理。';
 return message;
}
export function runCleanupChild(args: string[]): number {
 try {
  if (process.platform !== 'linux') throw new Error('当前平台暂不支持安全检测 OpenCode 进程，未执行清理。');
  if (args.length !== 1) throw new Error('Invalid cleanup runner input');
  const payload = JSON.parse(args[0]) as { input: EngineCleanupInput; now: number; selection?: string };
  const input = parseEngineCleanup(payload.input);
  const result = cleanup({ db: databasePath(), keepDays: input.keepDays, pruneEvents: input.pruneEvents, eventIdleMinutes: input.eventIdleMinutes, apply: input.mode === 'apply', vacuum: input.mode === 'apply' && input.vacuum, now: payload.now, expectedSelection: payload.selection });
  process.stdout.write(JSON.stringify(result) + '\n'); return 0;
 } catch (error) { process.stdout.write(JSON.stringify({ status: 'error', error: cleanupError(error) }) + '\n'); return 1; }
}
export class EngineCleanupJobs {
 private entries = new Map<string, { job: EngineCleanupJob; now: number; used?: boolean }>();
 constructor(private readonly track: <T>(promise: Promise<T>) => Promise<T> = promise => promise) {}
 start(input: EngineCleanupInput): EngineCleanupJob {
  for (const [id, entry] of this.entries) if (entry.job.status === 'done' && Date.now() - Date.parse(entry.job.startedAt) > 3600000) this.entries.delete(id);
  if ([...this.entries.values()].some(entry => entry.job.status === 'running')) throw new Error('已有数据库清理任务正在运行');
  let now = Date.now(); let selection: string | undefined;
  if (input.mode === 'apply') {
   const preview = this.entries.get(input.previewId!);
   if (!preview || preview.used || preview.job.result?.status !== 'preview') throw new Error('预览已失效，请重新预览');
   const keys = ['engine', 'keepDays', 'pruneEvents', 'eventIdleMinutes', 'vacuum'] as const;
   if (keys.some(key => preview.job.input[key] !== input[key])) throw new Error('选项已变更，请重新预览');
   if (Date.now() - preview.now > 15 * 60000) throw new Error('预览已过期，请重新预览');
   now = preview.now; selection = preview.job.result.selection; preview.used = true;
  }
  const job: EngineCleanupJob = { id: randomBytes(8).toString('hex'), status: 'running', startedAt: new Date().toISOString(), input: { ...input }, progress: '正在检查数据库…' };
  const entry = { job, now }; this.entries.set(job.id, entry);
  const args = embeddedApp() ? [CLEANUP_RUNNER] : [...process.execArgv, process.argv[1]!, CLEANUP_RUNNER];
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
  void this.track(run);
  return structuredClone(job);
 }
 get(id: unknown): EngineCleanupJob | undefined {
  if (id === 'opencode') return structuredClone([...this.entries.values()].at(-1)?.job);
  if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) throw new Error('无效的清理任务编号');
  return structuredClone(this.entries.get(id)?.job);
 }
}
