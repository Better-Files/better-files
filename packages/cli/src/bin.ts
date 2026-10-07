#!/usr/bin/env node
import { main } from './cli.js';

process.exitCode = await main(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  cwd: process.cwd(),
});
