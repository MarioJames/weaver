// Closeout deployment fixture: extracts the two tested Bash blocks from
// docs/root-task-progress.md (markers closeout-deployment:backup-tested and
// closeout-deployment:rollback-tested) and executes them verbatim against
// synthetic HOME trees. No mirror algorithm: backup/restore bytes are produced
// ONLY by the extracted document blocks (real cp/sha256sum/cmp/install/ln/mv).
// Only HOME, binary, regular dirs and symlinks are synthesized; `weaver` is a
// PATH shim that only logs build/stop/install/start order and answers
// --version. Never touches real HOME binaries/skills, credentials, production
// DB, lockfiles, or shared services. No npm/npx/Vitest.
//
// Re-run (repo root, parent can run independently):
//   DEPLOYMENT_SCRATCH="$(mktemp -d)" node docs/verification/root-progress-4113f179/closeout/deployment/runner.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../../..');
const DOC = join(REPO, 'docs/root-task-progress.md');
// Every run owns a fresh child; never remove a caller-supplied directory.
const OUTPUT_ROOT = process.env.DEPLOYMENT_SCRATCH
  ? resolve(process.env.DEPLOYMENT_SCRATCH)
  : mkdtempSync(join(tmpdir(), 'weaver-deployment-'));
mkdirSync(OUTPUT_ROOT, { recursive: true });
const SCRATCH = mkdtempSync(join(OUTPUT_ROOT, 'fixture-'));
const EVIDENCE = join(OUTPUT_ROOT, 'evidence');
mkdirSync(EVIDENCE, { recursive: true });
console.log(`Deployment fixture evidence: ${EVIDENCE}`);
const TASK_ID = 'portable-deployment-fixture';

const logLines = [];
const log = (s = '') => { logLines.push(s); console.log(s); };
const results = [];
const check = (kase, name, pass, detail = '') => {
  results.push({ case: kase, check: name, pass: !!pass, detail: String(detail).slice(0, 400) });
  log(`${pass ? 'PASS' : 'FAIL'} [${kase}] ${name}${detail ? ` :: ${String(detail).slice(0, 160)}` : ''}`);
  if (!pass) process.exitCode = 1;
};
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const shaFile = (p) => sha256(readFileSync(p));

function extract(marker) {
  const t = readFileSync(DOC, 'utf8');
  const i = t.indexOf(marker);
  if (i < 0) throw new Error(`marker missing: ${marker}`);
  const f = t.indexOf('```sh', i);
  if (f < 0) throw new Error(`fence missing after ${marker}`);
  const e = t.indexOf('\n```', f + 5);
  if (e < 0) throw new Error(`fence end missing after ${marker}`);
  return t.slice(f + 5, e).replace(/^\n/, '');
}

function runBash(scriptPath, env) {
  try {
    const out = execFileSync('bash', [scriptPath], {
      encoding: 'utf8', timeout: 60000, env, maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

const FAKE_SRC = (version) => `#!/usr/bin/env sh
# synthetic standalone stand-in: log every invocation, answer --version, fake server verbs.
log="\${FAKE_WEAVER_LOG:-/dev/null}"
printf 'fake-weaver args=%s\\n' "$*" >> "$log"
case " $* " in
  *" --version"*) echo "${version}"; exit 0;;
esac
echo "fake-weaver-ok $*"
exit 0
`;
const OLD_BIN_BODY = FAKE_SRC('weaver 0.7.4-synth-old');
const NEW_BIN_BODY = FAKE_SRC('weaver 0.7.5-synth-new');

const SKILL_FILES = {
  'SKILL.md': '---\nname: agents-weaver\n---\nOLD CANON BODY\n',
  'references/master-guideline.md': '# guideline OLD\n',
  '.weaver-skill.json': '{"skill":"agents-weaver"}\n',
};
function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
}

// home layout builder. opts: {binary:'regular'|'symlink', canonical:'regular'|'symlink'|'absent', agents:'both'|'absent'}
function buildHome(home, opts) {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  if (opts.binary === 'regular') {
    writeFileSync(join(home, '.local/bin/weaver'), OLD_BIN_BODY, { mode: 0o755 });
    chmodSync(join(home, '.local/bin/weaver'), 0o755);
  } else {
    writeFileSync(join(home, '.local/bin/weaver-target'), 'BIN-TARGET-OLD-BYTES\n');
    symlinkSync('./weaver-target', join(home, '.local/bin/weaver'));
  }
  const canon = join(home, '.agents/skills/agents-weaver');
  if (opts.canonical === 'regular') {
    mkdirSync(join(home, '.agents/skills'), { recursive: true });
    mkdirSync(canon, { recursive: true });
    writeTree(canon, SKILL_FILES);
  } else if (opts.canonical === 'symlink') {
    mkdirSync(join(home, '.agents/skills'), { recursive: true });
    const target = join(home, 'skill-target');
    mkdirSync(target, { recursive: true });
    writeTree(target, {
      'SKILL.md': '---\nname: agents-weaver\n---\nTARGET-OLD BODY\n',
      'references/master-guideline.md': '# guideline TARGET-OLD\n',
      '.weaver-skill.json': '{"skill":"agents-weaver"}\n',
    });
    symlinkSync('../../skill-target', canon);
  }
  if (opts.agents === 'both') {
    const a = join(home, 'agent-a'), b = join(home, 'agent-b');
    mkdirSync(a, { recursive: true }); writeTree(a, { 'SKILL.md': 'AGENT-A BODY\n' });
    mkdirSync(b, { recursive: true }); writeTree(b, { 'SKILL.md': 'AGENT-B BODY\n' });
    mkdirSync(join(home, '.claude/skills'), { recursive: true });
    mkdirSync(join(home, '.codex/skills'), { recursive: true });
    symlinkSync('../../agent-a', join(home, '.claude/skills/agents-weaver'));
    symlinkSync('../../agent-b', join(home, '.codex/skills/agents-weaver'));
  }
}

function phaseEnv(home, caseDir, phase) {
  return {
    ...process.env,
    HOME: home,
    PATH: `${join(home, '.local/bin')}:/usr/bin:/bin`,
    FAKE_WEAVER_LOG: join(caseDir, `calls-${phase}.log`),
  };
}
// fail-closed phases may exit before any shim invocation: missing log means zero calls.
function callsLog(caseDir, phase) {
  const p = join(caseDir, `calls-${phase}.log`);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}
function parseVars(out) {
  const m = out.split('\n').reverse().find((l) => l.startsWith('DEPLOY_VARS '));
  if (!m) return null;
  const kv = {};
  for (const part of m.slice('DEPLOY_VARS '.length).split(' ')) {
    const i = part.indexOf('=');
    if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
  }
  return kv.backup && kv.stamp && kv.binary && kv.skill ? kv : null;
}

async function main() {
  if (process.env.HOME === SCRATCH || String(process.env.HOME).includes('fixture-')) {
    throw new Error('refusing to run with synthetic HOME');
  }
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(join(SCRATCH, 'ownership.json'), JSON.stringify({
    taskId: TASK_ID, kind: 'synthetic-fixture', root: SCRATCH,
    createdAt: new Date().toISOString(),
    note: 'Task-owned temp fixture; recycled in finally. Never real HOME/install/credentials/DB.',
  }, null, 2) + '\n');

  const backupSnippet = extract('closeout-deployment:backup-tested');
  const rollbackSnippet = extract('closeout-deployment:rollback-tested');
  const snippetHashes = {
    'backup.sh': sha256(backupSnippet),
    'rollback.sh': sha256(rollbackSnippet),
    doc: 'docs/root-task-progress.md',
  };
  writeFileSync(join(EVIDENCE, 'backup.sh'), backupSnippet + '\n');
  writeFileSync(join(EVIDENCE, 'rollback.sh'), rollbackSnippet + '\n');
  writeFileSync(join(EVIDENCE, 'snippets.sha256.json'), JSON.stringify(snippetHashes, null, 2) + '\n');
  log(`snippets extracted: backup ${snippetHashes['backup.sh'].slice(0, 12)} rollback ${snippetHashes['rollback.sh'].slice(0, 12)}`);
  check('extract', 'backup+rollback snippets extracted from doc markers', backupSnippet.includes('binary="$(command -v weaver)"') && rollbackSnippet.includes('rollback-isolation'), '');

  // ---- Case 1: regular binary + regular canonical + two agent links roundtrip ----
  {
    const kase = 'regular-roundtrip';
    const caseDir = join(SCRATCH, kase), home = join(caseDir, 'fake-home');
    mkdirSync(caseDir, { recursive: true });
    buildHome(home, { binary: 'regular', canonical: 'regular', agents: 'both' });
    const oldBinHash = shaFile(join(home, '.local/bin/weaver'));
    writeFileSync(join(caseDir, 'phase1.sh'), `exec 2>&1\nexport HOME=${JSON.stringify(home)}\n${backupSnippet}\nprintf 'DEPLOY_VARS backup=%s stamp=%s binary=%s skill=%s metadata_seal=%s\\n' "$backup" "$stamp" "$binary" "$skill" "$metadata_seal"\n`);
    const r1 = runBash(join(caseDir, 'phase1.sh'), phaseEnv(home, caseDir, 'backup'));
    writeFileSync(join(EVIDENCE, `${kase}-backup.log`), r1.out);
    check(kase, 'backup exits 0', r1.code === 0, `code=${r1.code}`);
    const vars = parseVars(r1.out);
    check(kase, 'backup vars captured (same-window vars)', !!vars, JSON.stringify(vars));
    check(kase, 'backup phase calls no server (backup before stop)', !readFileSync(join(caseDir, 'calls-backup.log'), 'utf8').includes('server'), 'no server in backup log');
    // Execute the document's real stop/install/start blocks; only external installer is synthetic.
    const stopSnippet = extract('**2. 在维护窗口内');
    const installSnippet = extract('**3. 安装新二进制');
    writeFileSync(join(caseDir, 'new-weaver'), NEW_BIN_BODY, { mode: 0o755 });
    writeFileSync(join(caseDir, 'install.sh'), `#!/bin/bash\nset -eu\nprintf 'synthetic-install\\n' >> "$FAKE_WEAVER_LOG"\ncp -- new-weaver "$HOME/.local/bin/weaver"\nchmod 755 "$HOME/.local/bin/weaver"\n`, { mode: 0o755 });
    writeFileSync(join(caseDir, 'upgrade.sh'), `set -euo pipefail\ncd ${JSON.stringify(caseDir)}\nbinary=${JSON.stringify(vars.binary)}\n${stopSnippet}\n${installSnippet}\n`);
    const upgrade = runBash(join(caseDir, 'upgrade.sh'), phaseEnv(home, caseDir, 'upgrade'));
    writeFileSync(join(EVIDENCE, `${kase}-upgrade.log`), upgrade.out);
    const upgradeCalls = callsLog(caseDir, 'upgrade');
    writeFileSync(join(EVIDENCE, `${kase}-upgrade-calls.log`), upgradeCalls);
    check(kase, 'document upgrade blocks execute', upgrade.code === 0);
    check(kase, 'document stop before install before start', upgradeCalls.indexOf('server stop') >= 0 && upgradeCalls.indexOf('server stop') < upgradeCalls.indexOf('synthetic-install') && upgradeCalls.indexOf('synthetic-install') < upgradeCalls.indexOf('server start'));
    // pollution simulating new skill bytes and a repointed agent link

    writeFileSync(join(home, '.agents/skills/agents-weaver/SKILL.md'), 'POLLUTED NEW BODY\n');
    writeFileSync(join(home, '.agents/skills/agents-weaver/EXTRA.md'), 'extra must be isolated\n');
    rmSync(join(home, '.claude/skills/agents-weaver'));
    symlinkSync('../../agent-b', join(home, '.claude/skills/agents-weaver'));
    writeFileSync(join(caseDir, 'phase2.sh'), `exec 2>&1\nbackup=${JSON.stringify(vars.backup)}\nstamp=${JSON.stringify(vars.stamp)}\nbinary=${JSON.stringify(vars.binary)}\nskill=${JSON.stringify(vars.skill)}\nmetadata_seal=${JSON.stringify(vars.metadata_seal)}\n${rollbackSnippet}\n`);
    const r2 = runBash(join(caseDir, 'phase2.sh'), phaseEnv(home, caseDir, 'rollback'));
    writeFileSync(join(EVIDENCE, `${kase}-rollback.log`), r2.out);
    check(kase, 'rollback exits 0 despite live!=backup (backup self-hash only)', r2.code === 0, `code=${r2.code}`);
    check(kase, 'binary bytes restored to old', readFileSync(vars.binary, 'utf8') === OLD_BIN_BODY, '');
    check(kase, 'binary mode 0755', (statSync(vars.binary).mode & 0o777) === 0o755, '');
    check(kase, 'restored live hash equals backup hash', shaFile(vars.binary) === shaFile(join(vars.backup, 'weaver')), '');
    check(kase, 'canonical SKILL.md restored', readFileSync(join(home, '.agents/skills/agents-weaver/SKILL.md'), 'utf8') === SKILL_FILES['SKILL.md'], '');
    check(kase, 'extra new file gone from live', !existsSync(join(home, '.agents/skills/agents-weaver/EXTRA.md')), '');
    check(kase, 'extra file isolated (moved, not deleted)', existsSync(join(vars.backup, `agents-weaver-current-${vars.stamp}`, 'EXTRA.md')), '');
    check(kase, 'claude link text restored exactly', readlinkSync(join(home, '.claude/skills/agents-weaver')) === '../../agent-a', '');
    check(kase, 'codex link text intact', readlinkSync(join(home, '.codex/skills/agents-weaver')) === '../../agent-b', '');
    const keys = readdirSync(join(vars.backup, 'skills/agent-links')).sort();
    check(kase, 'agent backup keys independent (no collision)', JSON.stringify(keys) === JSON.stringify(['.claude-agents-weaver', '.codex-agents-weaver']), keys.join(','));
    const calls = readFileSync(join(caseDir, 'calls-rollback.log'), 'utf8');
    check(kase, 'order stop before start', calls.indexOf('server stop') >= 0 && calls.indexOf('server stop') < calls.indexOf('server start'), '');
  }

  // ---- Case 2: tampered backup fails closed before stop ----
  {
    const kase = 'tampered-backup';
    const caseDir = join(SCRATCH, kase), home = join(caseDir, 'fake-home');
    mkdirSync(caseDir, { recursive: true });
    buildHome(home, { binary: 'regular', canonical: 'regular', agents: 'both' });
    writeFileSync(join(caseDir, 'phase1.sh'), `exec 2>&1\nexport HOME=${JSON.stringify(home)}\n${backupSnippet}\nprintf 'DEPLOY_VARS backup=%s stamp=%s binary=%s skill=%s metadata_seal=%s\\n' "$backup" "$stamp" "$binary" "$skill" "$metadata_seal"\n`);
    const r1 = runBash(join(caseDir, 'phase1.sh'), phaseEnv(home, caseDir, 'backup'));
    writeFileSync(join(EVIDENCE, `${kase}-backup.log`), r1.out);
    const vars = parseVars(r1.out);
    check(kase, 'backup exits 0', r1.code === 0 && !!vars, `code=${r1.code}`);
    writeFileSync(join(vars.backup, 'weaver'), readFileSync(join(vars.backup, 'weaver'), 'utf8') + 'TAMPERED\n');
    writeFileSync(vars.binary, NEW_BIN_BODY); chmodSync(vars.binary, 0o755);
    writeFileSync(join(caseDir, 'phase2.sh'), `exec 2>&1\nbackup=${JSON.stringify(vars.backup)}\nstamp=${JSON.stringify(vars.stamp)}\nbinary=${JSON.stringify(vars.binary)}\nskill=${JSON.stringify(vars.skill)}\nmetadata_seal=${JSON.stringify(vars.metadata_seal)}\n${rollbackSnippet}\n`);
    const r2 = runBash(join(caseDir, 'phase2.sh'), phaseEnv(home, caseDir, 'rollback'));
    writeFileSync(join(EVIDENCE, `${kase}-rollback.log`), r2.out);
    check(kase, 'tampered backup rollback non-zero', r2.code !== 0, `code=${r2.code}`);
    check(kase, 'tampered backup fails before stop', !callsLog(caseDir, 'rollback').includes('server stop'), '');
    check(kase, 'live binary untouched (still new)', readFileSync(vars.binary, 'utf8') === NEW_BIN_BODY, '');
    check(kase, 'log shows checksum failure', /FAILED|mismatch/i.test(r2.out), '');
  }

  // ---- Case 3: symlink (incl npm-link shape) binary rejected before stop ----
  {
    const kase = 'symlink-binary';
    const caseDir = join(SCRATCH, kase), home = join(caseDir, 'fake-home');
    mkdirSync(caseDir, { recursive: true });
    buildHome(home, { binary: 'symlink', canonical: 'regular', agents: 'absent' });
    const targetBefore = readFileSync(join(home, '.local/bin/weaver-target'), 'utf8');
    writeFileSync(join(caseDir, 'phase1.sh'), `exec 2>&1\nexport HOME=${JSON.stringify(home)}\n${backupSnippet}\n`);
    const r1 = runBash(join(caseDir, 'phase1.sh'), phaseEnv(home, caseDir, 'backup'));
    writeFileSync(join(EVIDENCE, `${kase}-backup.log`), r1.out);
    check(kase, 'symlink binary backup non-zero', r1.code !== 0, `code=${r1.code}`);
    check(kase, 'fail-closed message before stop/install', /symlink/i.test(r1.out), '');
    check(kase, 'no server call made', !existsSync(join(caseDir, 'calls-backup.log')) || !readFileSync(join(caseDir, 'calls-backup.log'), 'utf8').includes('server'), '');
    check(kase, 'symlink target untouched', readFileSync(join(home, '.local/bin/weaver-target'), 'utf8') === targetBefore, '');
  }

  // ---- Case 4: canonical symlink target modify+new file restored ----
  {
    const kase = 'canonical-symlink';
    const caseDir = join(SCRATCH, kase), home = join(caseDir, 'fake-home');
    mkdirSync(caseDir, { recursive: true });
    buildHome(home, { binary: 'regular', canonical: 'symlink', agents: 'absent' });
    writeFileSync(join(caseDir, 'phase1.sh'), `exec 2>&1\nexport HOME=${JSON.stringify(home)}\n${backupSnippet}\nprintf 'DEPLOY_VARS backup=%s stamp=%s binary=%s skill=%s metadata_seal=%s\\n' "$backup" "$stamp" "$binary" "$skill" "$metadata_seal"\n`);
    const r1 = runBash(join(caseDir, 'phase1.sh'), phaseEnv(home, caseDir, 'backup'));
    writeFileSync(join(EVIDENCE, `${kase}-backup.log`), r1.out);
    const vars = parseVars(r1.out);
    check(kase, 'backup exits 0', r1.code === 0 && !!vars, `code=${r1.code}`);
    check(kase, 'snapshot has real files (not pointer-only)', existsSync(join(vars.backup, 'skills/canonical-content/SKILL.md')), '');
    const target = join(home, 'skill-target');
    writeFileSync(join(target, 'SKILL.md'), 'TARGET-POLLUTED BODY\n');
    writeFileSync(join(target, 'NEWFILE.md'), 'new file must be isolated\n');
    writeFileSync(vars.binary, NEW_BIN_BODY); chmodSync(vars.binary, 0o755);
    writeFileSync(join(caseDir, 'phase2.sh'), `exec 2>&1\nbackup=${JSON.stringify(vars.backup)}\nstamp=${JSON.stringify(vars.stamp)}\nbinary=${JSON.stringify(vars.binary)}\nskill=${JSON.stringify(vars.skill)}\nmetadata_seal=${JSON.stringify(vars.metadata_seal)}\n${rollbackSnippet}\n`);
    const r2 = runBash(join(caseDir, 'phase2.sh'), phaseEnv(home, caseDir, 'rollback'));
    writeFileSync(join(EVIDENCE, `${kase}-rollback.log`), r2.out);
    check(kase, 'rollback exits 0', r2.code === 0, `code=${r2.code}`);
    check(kase, 'link text restored exactly', readlinkSync(join(home, '.agents/skills/agents-weaver')) === '../../skill-target', '');
    check(kase, 'target old bytes restored', readFileSync(join(target, 'SKILL.md'), 'utf8').includes('TARGET-OLD BODY'), '');
    check(kase, 'new file gone from target', !existsSync(join(target, 'NEWFILE.md')), '');
    check(kase, 'new file isolated (target moved, not rm)', existsSync(join(vars.backup, 'rollback-isolation', `canonical-target-current-${vars.stamp}`, 'NEWFILE.md')), '');
    check(kase, 'snapshot unpolluted by later change', !existsSync(join(vars.backup, 'skills/canonical-content/NEWFILE.md')), '');
  }

  // ---- Case 5: initially absent canonical/agent links restore absence ----
  {
    const kase = 'initially-absent';
    const caseDir = join(SCRATCH, kase), home = join(caseDir, 'fake-home');
    mkdirSync(caseDir, { recursive: true });
    buildHome(home, { binary: 'regular', canonical: 'absent', agents: 'absent' });
    writeFileSync(join(caseDir, 'phase1.sh'), `exec 2>&1\nexport HOME=${JSON.stringify(home)}\n${backupSnippet}\nprintf 'DEPLOY_VARS backup=%s stamp=%s binary=%s skill=%s metadata_seal=%s\\n' "$backup" "$stamp" "$binary" "$skill" "$metadata_seal"\n`);
    const r1 = runBash(join(caseDir, 'phase1.sh'), phaseEnv(home, caseDir, 'backup'));
    writeFileSync(join(EVIDENCE, `${kase}-backup.log`), r1.out);
    const vars = parseVars(r1.out);
    check(kase, 'backup exits 0 with no skill snapshot', r1.code === 0 && !!vars, `code=${r1.code}`);
    // simulated bad install creates new canonical dir + agent link + new binary
    const canon = join(home, '.agents/skills/agents-weaver');
    mkdirSync(canon, { recursive: true });
    writeTree(canon, { 'SKILL.md': 'BRAND NEW SKILL\n' });
    const newT = join(home, 'new-agent-target');
    mkdirSync(newT, { recursive: true }); writeTree(newT, { 'SKILL.md': 'NEW AGENT\n' });
    mkdirSync(join(home, '.claude/skills'), { recursive: true });
    symlinkSync('../../new-agent-target', join(home, '.claude/skills/agents-weaver'));
    writeFileSync(vars.binary, NEW_BIN_BODY); chmodSync(vars.binary, 0o755);
    writeFileSync(join(caseDir, 'phase2.sh'), `exec 2>&1\nbackup=${JSON.stringify(vars.backup)}\nstamp=${JSON.stringify(vars.stamp)}\nbinary=${JSON.stringify(vars.binary)}\nskill=${JSON.stringify(vars.skill)}\nmetadata_seal=${JSON.stringify(vars.metadata_seal)}\n${rollbackSnippet}\n`);
    const r2 = runBash(join(caseDir, 'phase2.sh'), phaseEnv(home, caseDir, 'rollback'));
    writeFileSync(join(EVIDENCE, `${kase}-rollback.log`), r2.out);
    check(kase, 'rollback exits 0', r2.code === 0, `code=${r2.code}`);
    check(kase, 'canonical restored to absent', !existsSync(canon) && !lstatSync(canon, { throwIfNoEntry: false }), '');
    check(kase, 'new canonical dir isolated whole (not rm)', existsSync(join(vars.backup, 'rollback-isolation', `canonical-new-${vars.stamp}`, 'SKILL.md')), '');
    check(kase, 'new agent link isolated (not rm)', lstatSync(join(vars.backup, 'rollback-isolation', `.claude-agents-weaver-new-${vars.stamp}`), { throwIfNoEntry: false }) !== undefined, '');
    check(kase, 'agent links absent again', !existsSync(join(home, '.claude/skills/agents-weaver')) && !existsSync(join(home, '.codex/skills/agents-weaver')), '');
    check(kase, 'binary still restored (binary backup always exists)', readFileSync(vars.binary, 'utf8') === OLD_BIN_BODY, '');
  }

  // ---- Case 6: malicious links.txt record (target /) fails closed before stop ----
  {
    const kase = 'malicious-record';
    const caseDir = join(SCRATCH, kase), home = join(caseDir, 'fake-home');
    mkdirSync(caseDir, { recursive: true });
    buildHome(home, { binary: 'regular', canonical: 'symlink', agents: 'absent' });
    writeFileSync(join(caseDir, 'phase1.sh'), `exec 2>&1\nexport HOME=${JSON.stringify(home)}\n${backupSnippet}\nprintf 'DEPLOY_VARS backup=%s stamp=%s binary=%s skill=%s metadata_seal=%s\\n' "$backup" "$stamp" "$binary" "$skill" "$metadata_seal"\n`);
    const r1 = runBash(join(caseDir, 'phase1.sh'), phaseEnv(home, caseDir, 'backup'));
    const vars = parseVars(r1.out);
    check(kase, 'backup exits 0', r1.code === 0 && !!vars, `code=${r1.code}`);
    const linksFile = join(vars.backup, 'skills/links.txt');
    const canonLine = readFileSync(linksFile, 'utf8').split('\n').find((l) => l.startsWith(vars.skill + ' -> '));
    writeFileSync(linksFile, readFileSync(linksFile, 'utf8').replace(canonLine, `${vars.skill} -> /`));
    writeFileSync(vars.binary, NEW_BIN_BODY); chmodSync(vars.binary, 0o755);
    writeFileSync(join(caseDir, 'phase2.sh'), `exec 2>&1\nbackup=${JSON.stringify(vars.backup)}\nstamp=${JSON.stringify(vars.stamp)}\nbinary=${JSON.stringify(vars.binary)}\nskill=${JSON.stringify(vars.skill)}\nmetadata_seal=${JSON.stringify(vars.metadata_seal)}\n${rollbackSnippet}\n`);
    const r2 = runBash(join(caseDir, 'phase2.sh'), phaseEnv(home, caseDir, 'rollback'));
    writeFileSync(join(EVIDENCE, `${kase}-rollback.log`), r2.out);
    check(kase, 'malicious record rollback non-zero', r2.code !== 0, `code=${r2.code}`);
    check(kase, 'malicious record fails before stop', !callsLog(caseDir, 'rollback').includes('server stop'), '');
    check(kase, 'live link unchanged', readlinkSync(join(home, '.agents/skills/agents-weaver')) === '../../skill-target', '');
    check(kase, 'target bytes unchanged', readFileSync(join(home, 'skill-target/SKILL.md'), 'utf8').includes('TARGET-OLD BODY'), '');
  }

  // ---- Case 7: drifted binary.path fails closed before stop ----
  {
    const kase = 'drift-binary-path';
    const caseDir = join(SCRATCH, kase), home = join(caseDir, 'fake-home');
    mkdirSync(caseDir, { recursive: true });
    buildHome(home, { binary: 'regular', canonical: 'regular', agents: 'absent' });
    writeFileSync(join(caseDir, 'phase1.sh'), `exec 2>&1\nexport HOME=${JSON.stringify(home)}\n${backupSnippet}\nprintf 'DEPLOY_VARS backup=%s stamp=%s binary=%s skill=%s metadata_seal=%s\\n' "$backup" "$stamp" "$binary" "$skill" "$metadata_seal"\n`);
    const r1 = runBash(join(caseDir, 'phase1.sh'), phaseEnv(home, caseDir, 'backup'));
    const vars = parseVars(r1.out);
    check(kase, 'backup exits 0', r1.code === 0 && !!vars, `code=${r1.code}`);
    writeFileSync(join(vars.backup, 'binary.path'), `${home}/.local/bin/other\n`);
    writeFileSync(vars.binary, NEW_BIN_BODY); chmodSync(vars.binary, 0o755);
    writeFileSync(join(caseDir, 'phase2.sh'), `exec 2>&1\nbackup=${JSON.stringify(vars.backup)}\nstamp=${JSON.stringify(vars.stamp)}\nbinary=${JSON.stringify(vars.binary)}\nskill=${JSON.stringify(vars.skill)}\nmetadata_seal=${JSON.stringify(vars.metadata_seal)}\n${rollbackSnippet}\n`);
    const r2 = runBash(join(caseDir, 'phase2.sh'), phaseEnv(home, caseDir, 'rollback'));
    writeFileSync(join(EVIDENCE, `${kase}-rollback.log`), r2.out);
    check(kase, 'drift rollback non-zero', r2.code !== 0, `code=${r2.code}`);
    check(kase, 'drift fails before stop', !callsLog(caseDir, 'rollback').includes('server stop'), '');
    check(kase, 'live untouched', readFileSync(vars.binary, 'utf8') === NEW_BIN_BODY, '');
    check(kase, 'log names drift', /漂移|FAILED/.test(r2.out), '');
  }

  // Real filesystem drift / malicious targets, without mocking restore logic.
  for (const mode of ['target-symlink-drift', 'parent-drift', 'allowed-set-tamper', 'canonical-link-drift', 'snapshot-tamper', 'target-record-tamper', 'malicious-outside', 'malicious-ancestor']) {
    const caseDir = join(SCRATCH, mode), home = join(caseDir, 'fake-home');
    mkdirSync(caseDir, { recursive: true });
    buildHome(home, { binary: 'regular', canonical: 'symlink', agents: 'absent' });
    if (mode === 'malicious-ancestor' || mode === 'malicious-outside') {
      rmSync(join(home, '.agents/skills/agents-weaver'));
      symlinkSync(mode === 'malicious-outside' ? '/usr/share' : '../..', join(home, '.agents/skills/agents-weaver'));
    }
    writeFileSync(join(caseDir, 'backup.sh'), `${backupSnippet}\nprintf 'DEPLOY_VARS backup=%s stamp=%s binary=%s skill=%s metadata_seal=%s\\n' "$backup" "$stamp" "$binary" "$skill" "$metadata_seal"\n`);
    const first = runBash(join(caseDir, 'backup.sh'), phaseEnv(home, caseDir, 'backup'));
    writeFileSync(join(EVIDENCE, `${mode}-backup.log`), first.out);
    if (mode === 'malicious-ancestor' || mode === 'malicious-outside') {
      check(mode, 'ancestor target rejected before stop', first.code !== 0 && !callsLog(caseDir, 'backup').includes('server stop'));
      continue;
    }
    const vars = parseVars(first.out);
    check(mode, 'backup ready', first.code === 0 && !!vars);
    if (mode === 'target-symlink-drift') {
      cpSync(join(home, 'skill-target'), join(home, 'other'), { recursive: true });
      rmSync(join(home, 'skill-target'), { recursive: true });
      symlinkSync('other', join(home, 'skill-target'));
    } else if (mode === 'parent-drift') {
      mkdirSync(join(home, 'other-agent-parent'));
      mkdirSync(join(home, '.claude'), { recursive: true });
      symlinkSync('../other-agent-parent', join(home, '.claude/skills'));
    } else if (mode === 'allowed-set-tamper') {
      writeFileSync(join(vars.backup, 'skills/allowed-skill-paths.txt'), '/tmp/unknown\n');
    } else if (mode === 'target-record-tamper') {
      writeFileSync(join(vars.backup, 'skills/target.path'), join(home, 'agent-a') + '\n');
    } else if (mode === 'canonical-link-drift') {
      mkdirSync(join(home, 'other'));
      rmSync(vars.skill); symlinkSync('../../other', vars.skill);
    } else {
      writeFileSync(join(vars.backup, 'skills/canonical-content/SKILL.md'), 'TAMPERED');
    }
    writeFileSync(join(caseDir, 'rollback.sh'), `backup=${JSON.stringify(vars.backup)}\nstamp=${JSON.stringify(vars.stamp)}\nbinary=${JSON.stringify(vars.binary)}\nskill=${JSON.stringify(vars.skill)}\nmetadata_seal=${JSON.stringify(vars.metadata_seal)}\n${rollbackSnippet}\n`);
    const second = runBash(join(caseDir, 'rollback.sh'), phaseEnv(home, caseDir, 'rollback'));
    writeFileSync(join(EVIDENCE, `${mode}-rollback.log`), second.out);
    check(mode, 'refused before stop', second.code !== 0 && !callsLog(caseDir, 'rollback').includes('server stop'), `code=${second.code}`);
    check(mode, 'binary unchanged', readFileSync(vars.binary, 'utf8') === OLD_BIN_BODY);
  }

  writeFileSync(join(EVIDENCE, 'assertions.json'), JSON.stringify({
    taskId: TASK_ID,
    generatedAt: new Date().toISOString(),
    node: process.version,
    doc: 'docs/root-task-progress.md',
    snippetHashes: snippetHashes,
    rerun: 'node docs/verification/root-progress-4113f179/closeout/deployment/runner.mjs',
    scratch: SCRATCH,
    note: 'No real build/install/restart/skill-install executed; server verbs only observed via PATH shim log. Writes only synthetic scratch and evidence under DEPLOYMENT_SCRATCH or a safe temporary directory.',
    results,
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length,
  }, null, 2) + '\n');
  writeFileSync(join(EVIDENCE, 'runner-output.log'), logLines.join('\n') + '\n');
  log(`assertions: ${results.filter((r) => r.pass).length} pass / ${results.filter((r) => !r.pass).length} fail`);
}

try {
  await main();
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
  const gone = !existsSync(SCRATCH);
  logLines.push(`cleanup scratch removed: ${gone}`);
  try {
    const aPath = join(EVIDENCE, 'assertions.json');
    if (existsSync(aPath)) {
      const a = JSON.parse(readFileSync(aPath, 'utf8'));
      a.cleanup = { scratchRemoved: gone, scratchOwnership: 'task-owned disposable deployment scratch' };
      writeFileSync(aPath, JSON.stringify(a, null, 2) + '\n');
    }
    writeFileSync(join(EVIDENCE, 'runner-output.log'), logLines.join('\n') + '\n');
  } catch {}
  if (!gone) process.exitCode = 1;
}
