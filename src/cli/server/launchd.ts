import { UNIT_MARKER, type ServerEnv } from './env';

export const LAUNCHD_LABEL = 'dev.weaver.server';

function xmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function xmlPair(key: string, value: string): string[] {
  return [`  <key>${key}</key>`, `  <string>${xmlText(value)}</string>`];
}

export function launchdPlist(command: readonly string[], env: ServerEnv, logPath: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- ${UNIT_MARKER} -->`,
    '<plist version="1.0">',
    '<dict>',
    ...xmlPair('Label', LAUNCHD_LABEL),
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...command.map(value => `    <string>${xmlText(value)}</string>`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...xmlPair('PATH', env.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').map(line => `  ${line}`),
    ...xmlPair('WEAVER_SERVICE', 'launchd').map(line => `  ${line}`),
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    ...xmlPair('StandardOutPath', logPath),
    ...xmlPair('StandardErrorPath', logPath),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function xmlUnescape(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
export function plistStrings(content: string): string[] {
  return [...content.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => xmlUnescape(match[1]!));
}
/** The strings of the ProgramArguments array, in order. */
export function plistProgramArguments(content: string): string[] {
  const key = content.indexOf('<key>ProgramArguments</key>');
  const start = key < 0 ? -1 : content.indexOf('<array>', key);
  const end = start < 0 ? -1 : content.indexOf('</array>', start);
  return end < 0 ? [] : plistStrings(content.slice(start, end));
}
