import { StringDecoder } from 'node:string_decoder';
import { parseWorkerRecord } from '../shared/validation';
import type { WorkerRecord } from '../shared/types';
/** Strict UTF-8 JSONL framing. Each line is a complete JSON object, not a vendor-specific event. */
export class JsonlParser {
 private decoder = new StringDecoder('utf8');
 private buffer = '';
 private bytes = 0;
 private records = 0;
 constructor(private accept: (record: WorkerRecord) => void) {}
 push(chunk: Buffer): void {
  this.bytes += chunk.length;
  if (this.bytes > 2 * 1024 * 1024) throw new Error('Worker output exceeds 2 MiB limit');
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
  if (++this.records > 1000) throw new Error('Worker exceeds 1000 record limit');
  this.accept(parseWorkerRecord(JSON.parse(line)));
 }
}
