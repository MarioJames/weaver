#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCLI } from './run';

function isDirectEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    // npm bin links and --preserve-symlinks-main may name the same file differently.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    // Imported hosts can supply a non-file argv[1]; importing must not run the CLI.
    return false;
  }
}
if (isDirectEntry()) {
  void runCLI(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
