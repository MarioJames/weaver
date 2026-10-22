import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogTailer } from '../../src/main/adapters/cli/log-tailer';

const TMP = mkdtempSync(join(tmpdir(), 'wv-log-tailer-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

type Seen = Array<{ text: string; endOffset: number }>;

/** Drive a tailer deterministically: no fs.watch reliance, manual poll ticks. */
function manualTailer(path: string, seen: Seen, options?: ConstructorParameters<typeof LogTailer>[2]) {
  let tick!: () => void;
  const tailer = new LogTailer(
    path,
    (line, endOffset) => {
      seen.push({ text: line.toString('utf8'), endOffset });
    },
    {
      pollMs: 1_000_000,
      setPoll: (fn: () => void) => {
        tick = fn;
        return 0;
      },
      clearPoll: () => {},
      ...options,
    },
  );
  tailer.start();
  return { tailer, poll: () => tick() };
}

test('splits lines across block boundaries with exact end offsets', () => {
  const dir = mkdtempSync(join(TMP, 'tailer-'));
  const path = join(dir, 'out.log');
  writeFileSync(path, '');
  const seen: Seen = [];
  const { tailer, poll } = manualTailer(path, seen);
  try {
    // First pump reads nothing; append in fragments smaller than a line.
    appendFileSync(path, 'alpha\nbet');
    poll();
    assert.deepEqual(seen, [{ text: 'alpha', endOffset: 6 }]);
    appendFileSync(path, 'a\ngamma\n');
    poll();
    assert.deepEqual(seen, [
      { text: 'alpha', endOffset: 6 },
      { text: 'beta', endOffset: 11 },
      { text: 'gamma', endOffset: 17 },
    ]);
    // Unterminated tail is buffered, not emitted.
    appendFileSync(path, 'partial');
    poll();
    assert.equal(seen.length, 3);
    assert.equal(tailer.unterminatedTail().toString('utf8'), 'partial');
    assert.equal(tailer.position(), 24);
  } finally {
    tailer.close();
  }
});

test('resumes from a replay offset without re-emitting committed lines', () => {
  const dir = mkdtempSync(join(TMP, 'tailer-'));
  const path = join(dir, 'out.log');
  writeFileSync(path, 'one\ntwo\nthree\n');
  const seen: Seen = [];
  // Cursor sits at end of "two\n" (8 bytes): only "three" is new.
  const { tailer, poll } = manualTailer(path, seen, { offset: 8 });
  try {
    poll();
    assert.deepEqual(seen, [{ text: 'three', endOffset: 14 }]);
  } finally {
    tailer.close();
  }
});

test('detects file replacement via dev/ino identity', () => {
  const dir = mkdtempSync(join(TMP, 'tailer-'));
  const path = join(dir, 'out.log');
  writeFileSync(path, 'v1\n');
  const st = statSync(path);
  const reasons: string[] = [];
  const seen: Seen = [];
  const { tailer, poll } = manualTailer(path, seen, {
    identity: { dev: st.dev, ino: st.ino },
    onIntegrityError: reason => reasons.push(reason),
  });
  try {
    poll();
    assert.deepEqual(seen, [{ text: 'v1', endOffset: 3 }]);
    // Replace the path with a brand-new file (log rotation / swap attack).
    writeFileSync(join(dir, 'swap.log'), 'v2\n');
    renameSync(join(dir, 'swap.log'), path);
    poll();
    assert.deepEqual(reasons, ['replaced']);
    assert.equal(seen.length, 1, 'no lines emitted from the replaced file');
  } finally {
    tailer.close();
  }
});

test('detects truncation when the file shrinks below the read offset', () => {
  const dir = mkdtempSync(join(TMP, 'tailer-'));
  const path = join(dir, 'out.log');
  writeFileSync(path, '0123456789\n');
  const st = statSync(path);
  const reasons: string[] = [];
  const seen: Seen = [];
  const { tailer, poll } = manualTailer(path, seen, {
    identity: { dev: st.dev, ino: st.ino },
    onIntegrityError: reason => reasons.push(reason),
  });
  try {
    poll();
    assert.equal(seen.length, 1);
    writeFileSync(path, 'xy\n'); // same inode, smaller than offset 11
    poll();
    assert.deepEqual(reasons, ['truncated']);
  } finally {
    tailer.close();
  }
});

test('unterminatedTail caps at 8KiB', () => {
  const dir = mkdtempSync(join(TMP, 'tailer-'));
  const path = join(dir, 'out.log');
  writeFileSync(path, 'x'.repeat(9000));
  const seen: Seen = [];
  const { tailer, poll } = manualTailer(path, seen);
  try {
    poll();
    assert.equal(seen.length, 0);
    assert.equal(tailer.unterminatedTail().length, 8192);
  } finally {
    tailer.close();
  }
});
