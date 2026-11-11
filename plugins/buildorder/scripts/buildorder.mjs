#!/usr/bin/env node
// buildorder CLI: the deterministic part of the skills. Prints JSON on stdout.
//
//   node buildorder.mjs detect [dir]
//
// Errors go to stderr as one line `buildorder: <message>` with exit code 1.
import { homedir } from 'node:os';
import { detect } from '../lib/detect.mjs';

const COMMANDS = {
  detect: (dir) => detect(dir, { home: homedir() }),
};
const USAGE = `usage: buildorder.mjs <command> [dir] (commands: ${Object.keys(COMMANDS).join(', ')})`;

function main(argv) {
  const [command, dir = '.', ...args] = argv;
  if (!command) throw new Error(USAGE);
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  if (!run) throw new Error(`unknown command: ${command} (${USAGE})`);
  process.stdout.write(JSON.stringify(run(dir, ...args), null, 2) + '\n');
}

try {
  main(process.argv.slice(2));
} catch (err) {
  // One readable line for the person; a stack trace would only hide the message.
  process.stderr.write(`buildorder: ${err?.message ?? err}\n`);
  process.exitCode = 1;
}
