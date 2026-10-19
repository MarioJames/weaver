import { StringDecoder } from 'node:string_decoder';

const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk)-[A-Za-z0-9_-]{8,}|\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{8,}|\b(?:xai|pplx|r8)-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|authorization|credential)\s*[=:]\s*\S+/gi;
const LINE_MAX = 8192;
const BLOCK_MAX = 65536;
const TRUNCATED = '[stderr line truncated]\n';

/** Strip credential-shaped text before a record or diagnostic is forwarded. */
export function redact(value: string): string {
  SECRET.lastIndex = 0;
  return value.replace(SECRET, match => match.includes(' ') && /^bearer\s/i.test(match) ? 'Bearer [REDACTED]' : '[REDACTED]');
}

export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

/** Redact complete UTF-8 lines. A line past LINE_MAX is dropped until its newline. PEM blocks are redacted whole. */
export function createRedactedLineBuffer(emit: (text: string) => void): { write(chunk: Buffer | string): void; flush(): void } {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let skipToNewline = false;
  let skipPem = false;
  let pem = '';
  const emitSafe = (text: string) => {
    const cleaned = redact(text);
    if (cleaned) emit(cleaned);
  };
  const isPemEnd = (line: string) => line.includes('-----END ') && line.includes('PRIVATE KEY-----');
  const consume = () => {
    for (;;) {
      if (skipToNewline || skipPem) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) { buffer = ''; return; }
        const line = buffer.slice(0, newline + 1);
        buffer = buffer.slice(newline + 1);
        skipToNewline = false;
        if (skipPem) skipPem = !isPemEnd(line);
        continue;
      }
      const newline = buffer.indexOf('\n');
      if (pem) {
        if (newline < 0) {
          if (pem.length + buffer.length > BLOCK_MAX) {
            emit(TRUNCATED);
            pem = '';
            buffer = '';
            skipPem = true;
          }
          return;
        }
        const line = buffer.slice(0, newline + 1);
        buffer = buffer.slice(newline + 1);
        if (line.length - 1 > LINE_MAX || pem.length + line.length > BLOCK_MAX) {
          emit(TRUNCATED);
          pem = '';
          skipPem = !isPemEnd(line);
          continue;
        }
        pem += line;
        if (isPemEnd(line)) { emitSafe(pem); pem = ''; }
        continue;
      }
      if (newline < 0) {
        if (buffer.length > LINE_MAX) {
          emit(TRUNCATED);
          buffer = '';
          skipToNewline = true;
        }
        return;
      }
      if (newline > LINE_MAX) {
        emit(TRUNCATED);
        buffer = buffer.slice(newline + 1);
        continue;
      }
      const line = buffer.slice(0, newline + 1);
      buffer = buffer.slice(newline + 1);
      if (line.includes('-----BEGIN ') && line.includes('PRIVATE KEY-----') && !isPemEnd(line)) {
        pem = line;
        continue;
      }
      emitSafe(line);
    }
  };
  return {
    write(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      consume();
    },
    flush() {
      buffer += decoder.end();
      consume();
      if (skipToNewline || skipPem || pem || buffer.length > LINE_MAX) {
        if ((pem || buffer.length > LINE_MAX) && !skipToNewline && !skipPem) emit(TRUNCATED);
        buffer = '';
        pem = '';
        skipToNewline = false;
        skipPem = false;
        return;
      }
      if (buffer) emitSafe(buffer);
      buffer = '';
    },
  };
}
