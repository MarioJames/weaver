import { StringDecoder } from 'node:string_decoder';
import { parseWorkerRecord } from '../shared/validation';
import type { WorkerRecord } from '../shared/contracts/tasks';
/** Strict UTF-8 JSONL framing. Each line is a complete JSON object, not a vendor-specific event.
 * Record volume is intentionally unbounded here: the parser holds no history
 * (at most one partial line), and long runs are kept alive by bounded retention
 * where records land (task events keep head/tail with an omission marker) instead
 * of failing. Only malformed framing still throws. */
export class JsonlParser {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  constructor(private accept: (record: WorkerRecord) => void) {}
  push(chunk: Buffer): void {
   this.consume(this.decoder.write(chunk));
  }
 finish(): void {
  this.consume(this.decoder.end());
  if (this.buffer.trim()) this.line(this.buffer);
  this.buffer = '';
 }
 private consume(chunk: string): void {
  this.buffer += chunk;
  let newline: number;
  while ((newline = this.buffer.indexOf('\n')) >= 0) {
   this.line(this.buffer.slice(0, newline)); this.buffer = this.buffer.slice(newline + 1);
  }
  if (Buffer.byteLength(this.buffer) > 128 * 1024) throw new Error('Worker line exceeds 128 KiB limit');
 }
  private line(line: string): void {
   if (Buffer.byteLength(line) > 128 * 1024) throw new Error('Worker line exceeds 128 KiB limit');
   if (!line.trim()) return;
   this.accept(parseWorkerRecord(JSON.parse(line)));
  }
}
