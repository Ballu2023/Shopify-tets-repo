import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || '4999';
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let logs = '';

before(async () => {
  server = spawn(process.execPath, ['dashboard/server.js'], {
    env: { ...process.env, PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (logs += d));
  server.stderr.on('data', (d) => (logs += d));

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Server crashed on start (exit ${server.exitCode}):\n${logs}`);
    }
    try {
      await fetch(BASE + '/');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Server did not start within 10s on port ${PORT}:\n${logs}`);
});

after(() => server?.kill());

test('dashboard home page returns 200', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
});
