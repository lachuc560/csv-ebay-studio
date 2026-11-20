import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('occupied port reports a useful message and leaves the existing service running', { timeout: 15000 }, async () => {
  const existing = createServer((_req, res) => res.end('existing service'));
  await new Promise((resolve, reject) => {
    existing.once('error', reject);
    existing.listen(0, resolve);
  });
  const port = existing.address().port;
  let child;
  try {
    child = spawn(process.execPath, ['scripts/dev-server.mjs'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, PORT: String(port), CSV_STUDIO_DATA_FILE: join(tmpdir(), `csv-studio-startup-${randomUUID()}.json`) },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Second server did not exit')); }, 10000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    assert.equal(code, 1);
    assert.match(output, new RegExp(`cổng ${port} đang được sử dụng`));
    assert.ok(output.includes(`http://localhost:${port}/`));
    assert.doesNotMatch(output, /Unhandled 'error' event|node:net:/);
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    assert.equal(await response.text(), 'existing service');
  } finally {
    if (child && child.exitCode === null) child.kill();
    await new Promise((resolve) => existing.close(resolve));
  }
});
