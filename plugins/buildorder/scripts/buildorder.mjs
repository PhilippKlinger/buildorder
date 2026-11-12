#!/usr/bin/env node
// buildorder CLI: the deterministic part of the skills. Prints JSON on stdout.
//
//   node buildorder.mjs detect [dir]
//   node buildorder.mjs nest [dir] [name]
//   node buildorder.mjs status [dir] [--json]   (plain text unless --json)
//   node buildorder.mjs scaffold [dir] [--lang en|de] [--name <name>] [--repo <path>]...
//   node buildorder.mjs verify [dir]
//   node buildorder.mjs finalize [dir]
//   node buildorder.mjs standard [repo] [--stack <id>] [--deploy container|webspace|paas|none]
//                                [--visibility public|private] [--without <id>=<reason>]... [--apply]
//
// Errors go to stderr as one line `buildorder: <message>` with exit code 1. A check that finds
// problems (verify, finalize) prints its JSON report and exits with 1 as well.
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { detect } from '../lib/detect.mjs';
import { nest } from '../lib/nest.mjs';
import { scaffold } from '../lib/scaffold.mjs';
import { standard } from '../lib/standard.mjs';
import { finalize, verify } from '../lib/verify.mjs';
import { formatStatus, status } from '../lib/status.mjs';

// `args`: how many arguments a command takes after [dir]; `options`: node:util parseArgs options;
// `check`: the result's `ok` sets the exit code; `text`: prints plain text unless --json is given.
const COMMANDS = {
  detect: { args: 0, run: (dir) => detect(dir, { home: homedir() }) },
  nest: { args: 1, run: (dir, [name]) => nest(dir, name) },
  status: { args: 0, options: { json: { type: 'boolean' } }, text: formatStatus, run: (dir) => status(dir) },
  scaffold: {
    args: 0,
    options: { lang: { type: 'string' }, name: { type: 'string' }, repo: { type: 'string', multiple: true } },
    run: (dir, _args, opts) => scaffold(dir, opts),
  },
  verify: { args: 0, check: true, run: (dir) => verify(dir) },
  finalize: { args: 0, check: true, run: (dir) => finalize(dir) },
  standard: {
    args: 0,
    options: {
      stack: { type: 'string' },
      deploy: { type: 'string' },
      visibility: { type: 'string' },
      without: { type: 'string', multiple: true },
      apply: { type: 'boolean' },
    },
    run: (dir, _args, opts) => standard(dir, opts),
  },
};
const USAGE = `usage: buildorder.mjs <command> [dir] (commands: ${Object.keys(COMMANDS).join(', ')})`;

function main(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new Error(USAGE);
  const cmd = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  if (!cmd) throw new Error(`unknown command: ${command} (${USAGE})`);
  const { values, positionals } = parseArgs({ args: rest, options: cmd.options ?? {}, allowPositionals: true, strict: true });
  const [dir = '.', ...args] = positionals;
  if (args.length > cmd.args) throw new Error(`unexpected argument '${args[cmd.args]}'`);
  const result = cmd.run(dir, args, { ...values });
  process.stdout.write(cmd.text && !values.json ? cmd.text(result) : JSON.stringify(result, null, 2) + '\n');
  if (cmd.check && !result.ok) process.exitCode = 1;
}

try {
  main(process.argv.slice(2));
} catch (err) {
  // One readable line for the person; a stack trace would only hide the message.
  process.stderr.write(`buildorder: ${err?.message ?? err}\n`);
  process.exitCode = 1;
}
