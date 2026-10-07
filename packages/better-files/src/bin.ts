#!/usr/bin/env node
// `npx better-files …` from the umbrella package; the command line itself lives in @better-files/cli.
import { main } from '@better-files/cli';

process.exitCode = await main(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  cwd: process.cwd(),
});
