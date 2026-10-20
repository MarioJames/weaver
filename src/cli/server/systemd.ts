import { UNIT_MARKER, type ServerEnv } from './env';

export const SERVICE_NAME = 'weaver.service';

const UNQUOTED = /^[A-Za-z0-9_@+=:,./-]+$/;
/** systemd doubles % for its own specifiers and needs quotes around anything else. */
export function systemdQuote(value: string): string {
  const escaped = value.replace(/%/g, '%%');
  if (escaped && UNQUOTED.test(escaped)) return escaped;
  return `"${escaped.replace(/[\\"]/g, '\\$&')}"`;
}
function systemdEnvironment(name: string, value: string): string {
  const assignment = `${name}=${value}`;
  return `Environment=${UNQUOTED.test(assignment) ? assignment : `"${assignment.replace(/[\\"]/g, '\\$&')}"`}`;
}

export function systemdUnit(command: readonly string[], env: ServerEnv): string {
  return [
    `# ${UNIT_MARKER}`,
    '[Unit]',
    'Description=Weaver local control plane',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${command.map(systemdQuote).join(' ')}`,
    systemdEnvironment('WEAVER_SERVICE', 'systemd'),
    systemdEnvironment('PATH', env.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'),
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Reverse of systemdQuote: enough of systemd's parser to read back a unit this command wrote. */
export function systemdTokens(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote === '"') {
      if (char === '\\') { current += line[++i] ?? ''; continue; }
      if (char === '"') { quote = undefined; continue; }
      current += char;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (char === '\\') { current += line[++i] ?? ''; started = true; continue; }
    if (char === ' ' || char === '\t') {
      if (started) { out.push(current.replace(/%%/g, '%')); current = ''; started = false; }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) out.push(current.replace(/%%/g, '%'));
  return out;
}
