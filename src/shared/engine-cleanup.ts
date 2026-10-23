import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanup } from './opencode-cleanup-core.mjs';
import type { EngineCleanupInput } from './contracts/engine-cleanup';

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
