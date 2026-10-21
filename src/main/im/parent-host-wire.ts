import type { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

export const HOST_FRAME_MAX = 1024 * 1024;
export type HostFrame = { epoch: string; id: number; type: string; [key: string]: unknown };
/** Bounded newline framing and write queue. No protocol payload is included in errors. */
export function hostWire(socket: Socket, epoch: string, receive: (frame: HostFrame) => void, fail: () => void) {
  const decoder = new StringDecoder('utf8');
  let buffer = '', stopped = false;
  const invalid = () => { if (!stopped) { stopped = true; fail(); socket.destroy(); } };
  socket.on('error', invalid);
  socket.on('data', (chunk: Buffer) => {
    if (stopped) return;
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > HOST_FRAME_MAX) { invalid(); return; }
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try {
        const frame = JSON.parse(line) as HostFrame;
        if (!frame || frame.epoch !== epoch || !Number.isSafeInteger(frame.id) || frame.id < 0 || typeof frame.type !== 'string') throw new Error();
        receive(frame);
      } catch { invalid(); return; }
    }
  });
  return {
    send(frame: Omit<HostFrame, 'epoch'>) {
      if (stopped || socket.destroyed) throw new Error('Parent host control unavailable');
      const line = JSON.stringify({ ...frame, epoch }) + '\n';
      if (Buffer.byteLength(line) > HOST_FRAME_MAX || socket.writableLength + Buffer.byteLength(line) > HOST_FRAME_MAX * 2) { invalid(); throw new Error('Parent host control limit'); }
      socket.write(line);
    },
  };
}
