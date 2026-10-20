import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRedactedLineBuffer } from '../../src/main/adapters/cli/redact';
import { redactContext } from '../../src/main/redact-context';
import { redactLog } from '../../src/renderer/features/tasks/log-view';
import { redactSecrets } from '../../src/shared/redact';

/** The three product surfaces plus the shared rule itself; every one of them must apply the same rules. */
function viaBuffer(value: string): string {
  const out: string[] = [];
  const buffer = createRedactedLineBuffer(text => out.push(text));
  buffer.write(`${value}\n`);
  buffer.flush();
  return out.join('').replace(/\n$/, '');
}
const entries: [string, (value: string) => string][] = [
  ['redactSecrets', redactSecrets],
  ['worker/stderr buffer', viaBuffer],
  ['redactContext', value => redactContext(value, 100_000)],
  ['redactLog', redactLog],
];

// [label, text, secret that must not survive, which old rule sets hid it: cli (worker records), ctx (context packs), log (UI)]
type Sample = [label: string, text: string, secret: string, oldCoverage: string];
const SECRET_SAMPLES: Sample[] = [
  ['pem closed', '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA9fakebody\n-----END RSA PRIVATE KEY-----', 'fakebody', 'cli ctx log'],
  ['pem unclosed', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAfake', 'b3BlbnNzaC1rZXktdjEAAAAfake', 'ctx log'],
  ['bearer', 'Bearer abcdefghij1234567890', 'abcdefghij1234567890', 'cli ctx log'],
  ['bearer short token', 'Bearer abc123', 'abc123', 'ctx log'],
  ['bearer lowercase scheme', 'bearer zzzzzzzzzzzz', 'zzzzzzzzzzzz', 'cli ctx log'],
  ['basic', 'Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA', 'ctx'],
  ['authorization header with scheme', 'Authorization: Bearer abcdef1234567890', 'abcdef1234567890', 'ctx log'],
  ['sk-', 'sk-abcdefghijklmnop', 'abcdefghijklmnop', 'cli ctx log'],
  ['sk-ant', 'key sk-ant-api03-AbCdEfGhIjKlMn here', 'AbCdEfGhIjKlMn', 'cli ctx log'],
  ['rk-', 'rk-abcdefghijklmnop', 'abcdefghijklmnop', 'cli'],
  ['ghp_', 'ghp_abcdefghijklmnop', 'abcdefghijklmnop', 'cli ctx log'],
  ['gho_', 'gho_abcdefghijklmnop', 'abcdefghijklmnop', 'cli ctx log'],
  ['ghs_', 'ghs_abcdefghijklmnop', 'abcdefghijklmnop', 'ctx log'],
  ['ghu_', 'ghu_abcdefghijklmnop', 'abcdefghijklmnop', 'ctx log'],
  ['ghr_', 'ghr_abcdefghijklmnop', 'abcdefghijklmnop', 'ctx log'],
  ['github_pat_', 'github_pat_11ABCDEFG0abcdefghij', '11ABCDEFG0abcdefghij', 'cli log'],
  ['xai-', 'xai-abcdefghijklmnop', 'abcdefghijklmnop', 'cli'],
  ['pplx-', 'pplx-abcdefghijklmnop', 'abcdefghijklmnop', 'cli'],
  ['r8-', 'r8-abcdefghijklmnop', 'abcdefghijklmnop', 'cli'],
  ['AKIA', 'AKIAABCDEFGHIJKLMNOP', 'ABCDEFGHIJKLMNOP', 'ctx'],
  ['password=', 'password=hunter2hunter2', 'hunter2hunter2', 'cli ctx log'],
  ['passwd:', 'passwd: hunter2hunter2', 'hunter2hunter2', 'ctx'],
  ['secret=', 'secret=hunter2hunter2', 'hunter2hunter2', 'cli ctx log'],
  ['client_secret', 'client_secret=hunter2hunter2', 'hunter2hunter2', 'cli ctx log'],
  ['token=', 'token=hunter2hunter2', 'hunter2hunter2', 'ctx log'],
  ['access_token', 'access_token=hunter2hunter2', 'hunter2hunter2', 'cli ctx log'],
  ['refresh_token', 'refresh_token: hunter2hunter2', 'hunter2hunter2', 'cli ctx log'],
  ['id_token', 'id_token=hunter2hunter2', 'hunter2hunter2', 'cli log'],
  ['api_key', 'api_key=hunter2hunter2', 'hunter2hunter2', 'cli ctx log'],
  ['api-key', 'api-key: hunter2hunter2', 'hunter2hunter2', 'cli ctx log'],
  ['env-style OPENAI_API_KEY', 'OPENAI_API_KEY=hunter2hunter2', 'hunter2hunter2', 'cli log'],
  ['access_key', 'access_key=hunter2hunter2', 'hunter2hunter2', 'ctx'],
  ['aws_secret_access_key', 'aws_secret_access_key=hunter2hunter2', 'hunter2hunter2', 'none (new)'],
  ['authorization=', 'authorization=hunter2hunter2', 'hunter2hunter2', 'cli ctx log'],
  ['credential=', 'credential=hunter2hunter2', 'hunter2hunter2', 'cli'],
  ['json double-quoted', '{"token":"hunter2hunter2","x":1}', 'hunter2hunter2', 'ctx'],
  ['json value with a space', '{"password": "hunter2 hunter2"}', 'hunter2', 'ctx'],
  ['single-quoted value', "password: 'hunter2 hunter2'", 'hunter2', 'ctx'],
  ['quoted key', '"api_key" = "hunter2hunter2"', 'hunter2hunter2', 'ctx'],
  ['query string', 'https://x.test/?token=hunter2hunter2&page=2', 'hunter2hunter2', 'ctx log'],
  ['value with a comma', 'password=hunter2,hunter2', 'hunter2', 'cli'],
  ['url userinfo https', 'https://user:hunter2pw@example.com/path', 'hunter2pw', 'ctx log'],
  ['url userinfo http with port', 'http://admin:hunter2pw@10.0.0.1:8080/', 'hunter2pw', 'ctx log'],
  ['url userinfo other scheme', 'postgres://app:hunter2pw@db.internal/prod', 'hunter2pw', 'none (new)'],
];

for (const [label, text, secret] of SECRET_SAMPLES) {
  test(`every redaction surface hides: ${label}`, () => {
    for (const [name, redact] of entries) {
      const out = redact(`before ${text} after`);
      assert.equal(out.includes(secret), false, `${name} leaked ${JSON.stringify(secret)}: ${out}`);
      // The line buffer drops an unterminated key block as a framing event instead of masking it.
      if (!(label === 'pem unclosed' && redact === viaBuffer)) assert.match(out, /\[REDACTED\]/, name);
      assert.equal(redact(out), out, `${name} is not idempotent`);
    }
  });
}

test('every surface produces the same text for the same input', () => {
  for (const [label, text] of SECRET_SAMPLES.filter(sample => sample[0] !== 'pem unclosed')) {
    const expected = redactSecrets(text);
    assert.equal(redactContext(text, 100_000), expected, label);
    assert.equal(redactLog(text), expected, label);
    assert.equal(viaBuffer(text), expected, label);
  }
});

test('placeholders keep the key, the scheme word and the URL scheme', () => {
  assert.equal(redactSecrets('password=hunter2'), 'password=[REDACTED]');
  assert.equal(redactSecrets('{"token":"abc","n":1}'), '{"token":"[REDACTED]","n":1}');
  assert.equal(redactSecrets("secret: 'a b'"), "secret: '[REDACTED]'");
  assert.equal(redactSecrets('Bearer abcdef123456'), 'Bearer [REDACTED]');
  assert.equal(redactSecrets('Authorization: Bearer abcdef123456'), 'Authorization: [REDACTED]');
  assert.equal(redactSecrets('Basic dXNlcjpwYXNzd29yZA=='), 'Basic [REDACTED]');
  assert.equal(redactSecrets('https://user:pw@example.com/x'), 'https://[REDACTED]@example.com/x');
  assert.equal(redactSecrets('-----BEGIN PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----\nkept'), '[REDACTED]\nkept');
  assert.equal(redactSecrets('use sk-abcdefghijklmnop now'), 'use [REDACTED] now');
});

const PLAIN_TEXT = [
  'tokens: 1234',
  'used 1234 tokens (max_tokens=4096)',
  'token count: see below',
  'password policy requires twelve characters',
  'The password policy was updated',
  'secret sauce recipe',
  'Basic usage guide',
  'Basic authentication is supported',
  'visit https://example.com:8080/path?page=2',
  'mail to https://example.com/a@b',
  'sk-short and task-abcdefghijklmnop',
  'risk-assessment-overview-document',
  'plain log line: build finished in 3s',
  '工作完成，token 用量见上方统计',
];

for (const text of PLAIN_TEXT) {
  test(`ordinary text is left alone: ${text}`, () => {
    for (const [name, redact] of entries) assert.equal(redact(text), text, name);
  });
}

test('a private key split across stderr chunks is redacted whole, and an unclosed one is dropped at flush', () => {
  const out: string[] = [];
  const buffer = createRedactedLineBuffer(text => out.push(text));
  buffer.write('-----BEGIN PRIVATE KEY-----\nMIIfake');
  buffer.write('body\n-----END PRIVATE KEY-----\nkept\n');
  buffer.flush();
  const joined = out.join('');
  assert.equal(joined.includes('MIIfakebody'), false);
  assert.match(joined, /\[REDACTED\]\nkept/);
  const open: string[] = [];
  const unclosed = createRedactedLineBuffer(text => open.push(text));
  unclosed.write('-----BEGIN PRIVATE KEY-----\nstillsecret\n');
  unclosed.flush();
  assert.equal(open.join('').includes('stillsecret'), false);
});

test('the shared rule set is pure: no imports and no Node globals', () => {
  const source = readFileSync(new URL('../../src/shared/redact.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\bnode:|\bprocess\.|\bBuffer\b|\brequire\(/);
});

test('the redaction patterns are defined once: no other source file builds a credential regex', () => {
  const sources = ['src/main/adapters/cli/redact.ts', 'src/main/redact-context.ts', 'src/renderer/features/tasks/log-view.ts']
    .map(path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
  for (const source of sources) assert.doesNotMatch(source, /Bearer|github_pat_|AKIA|password|\[REDACTED\]/i);
});
