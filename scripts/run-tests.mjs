import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = readdirSync(path.join(root, 'tests')).filter((name) => name.endsWith('.test.mjs')).sort();
const result = spawnSync(process.execPath, ['--test', ...tests.map((name) => path.join(root, 'tests', name))], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
