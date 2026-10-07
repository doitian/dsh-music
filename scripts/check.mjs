/**
 * Syntax-checks every module under lib/ with `node --check`, so a new module
 * is covered without being listed anywhere.
 *
 * @module dsh-music/scripts/check
 */

import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';

const files = globSync('lib/**/*.js').sort();
let failed = 0;
for (const file of files) {
  const { status } = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (status !== 0) failed += 1;
}
console.log(`checked ${files.length} modules, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
