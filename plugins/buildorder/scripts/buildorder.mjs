#!/usr/bin/env node
// buildorder CLI: the deterministic part of the skills. Prints JSON on stdout.
//
//   node buildorder.mjs detect [dir]
//   node buildorder.mjs nest [dir] [name]
//
// Errors go to stderr as one line `buildorder: <message>` with exit code 1.
import { homedir } from 'node:os';
import { detect } from '../lib/detect.mjs';
import { nest } from '../lib/nest.mjs';

// `args`: how many arguments a command takes after [dir].
const COMMANDS = {
  detect: { args: 0, run: (dir) => detect(dir, { home: homedir() }) },
  nest: { args: 1, run: (dir, name) => nest(dir, name) },
};
const USAGE = `usage: buildorder.mjs <command> [dir] (commands: ${Object.keys(COMMANDS).join(', ')})`;

function main(argv) {
  const [command, dir = '.', ...args] = argv;
  if (!command) throw new Error(USAGE);
  const cmd = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  if (!cmd) throw new Error(`unknown command: ${command} (${USAGE})`);
  if (args.length > cmd.args) throw new Error(`unexpected argument '${args[cmd.args]}'`);
  process.stdout.write(JSON.stringify(cmd.run(dir, ...args), null, 2) + '\n');
}

try {
  main(process.argv.slice(2));
} catch (err) {
  // One readable line for the person; a stack trace would only hide the message.
  process.stderr.write(`buildorder: ${err?.message ?? err}\n`);
  process.exitCode = 1;
}
