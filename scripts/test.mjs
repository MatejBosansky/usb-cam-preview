#!/usr/bin/env node
// Runs the tests that drivers and filters keep in their own folders:
//   public/drivers/<id>/test.mjs and public/filters/<id>/test.mjs
// Each runs in its own Node process; a non-zero exit code fails the run.
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DRIVERS_DIR, FILTERS_DIR, PUBLIC_DIR } from './lib/library.mjs';

const tests = [];
for (const dir of [DRIVERS_DIR, FILTERS_DIR]) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const file = join(dir, entry.name, 'test.mjs');
    if (await stat(file).then(() => true, () => false)) tests.push(file);
  }
}

let failed = 0;
for (const file of tests) {
  const name = relative(PUBLIC_DIR, file);
  console.log(`\n# ${name}`);
  const { status } = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (status !== 0) failed++;
}
console.log(`\n${tests.length - failed} of ${tests.length} test files passed.`);
if (failed) process.exit(1);
