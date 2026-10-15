// "Has anything changed?" (template/lib/changes.js), end to end on the local
// server, and in step across the three editions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANGES_PATH, versionTag, VERSION_HEADERS } from '../../template/lib/changes.js';

const root = new URL('../../', import.meta.url).pathname;
const read = (p) => readFileSync(root + p, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'changes-'));
  execFileSync('python3', [join(root, 'scripts/assemble.py'), join(root, 'tests/fixtures/proto.html'), join(dir, 'site')]);
  const port = 4800 + Math.floor(Math.random() * 150);
  const child = spawn('node', ['server.js', '--port', String(port)], {
    cwd: join(dir, 'site'),
    env: { ...process.env, DESIGNER_PASSWORD: 'team-c', CLIENT_PASSWORD: 'client-c', SESSION_SECRET: 's' },
    stdio: 'ignore',
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base + '/login.html');
      break;
    } catch {
      await sleep(50);
    }
  }
  return { base, stop: () => (child.kill(), rmSync(dir, { recursive: true, force: true })) };
}
async function signIn(base, password, name) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, name }) });
  return r.headers.get('set-cookie').split(';')[0];
}
const ask = async (base) => {
  const r = await fetch(base + CHANGES_PATH);
  return { status: r.status, headers: r.headers, v: (await r.json()).v };
};

test('the local server answers without a session, the same for everyone, and never for a browser to keep', async () => {
  const s = await startServer();
  try {
    const a = await ask(s.base);
    assert.equal(a.status, 200);
    assert.equal(typeof a.v, 'string');
    assert.equal(a.headers.get('access-control-allow-origin'), '*');
    assert.equal(a.headers.get('cache-control'), 'no-store');
    assert.equal(a.headers.get('set-cookie'), null);
  } finally {
    s.stop();
  }
});

test('the version a read carries matches the answer, and moves with a write only', async () => {
  const s = await startServer();
  try {
    const cookie = await signIn(s.base, 'team-c', 'Ann');
    const get = async () => (await fetch(s.base + '/api/comments', { headers: { cookie } })).json();
    const first = await get();
    assert.equal(first.changes, CHANGES_PATH);
    assert.equal(first.ver, (await ask(s.base)).v);
    assert.equal((await ask(s.base)).v, first.ver, 'asking again changes nothing');
    await fetch(s.base + '/api/comments', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', text: 'changes: moved', screen: 'Home', screenLabel: 'Home' }),
    });
    const moved = (await ask(s.base)).v;
    assert.notEqual(moved, first.ver);
    assert.equal((await get()).ver, moved);
  } finally {
    s.stop();
  }
});

test('all three editions serve the version and carry it in their reads', () => {
  // the local server: its route, before any session check
  const server = read('template/server.js');
  const local = server.indexOf("pathname === '/api/version'");
  assert.ok(local > 0 && local < server.indexOf('sessionFromHeaders(\n'), 'server.js asks for a session first');
  // the Worker: routed before the session check, answered by the room
  const worker = read('worker/src/index.js');
  assert.ok(worker.indexOf('url.pathname === CHANGES_PATH') < worker.indexOf("url.pathname === '/api/comments' || url.pathname === '/api/file'"));
  assert.match(read('worker/src/room.js'), /this\.room\.version\(\)|version\(\) \{/);
  // Vercel: cached under the room's tag, and every document write purges it
  const fn = read('template/api/version.js');
  assert.match(fn, /Vercel-CDN-Cache-Control/);
  assert.match(fn, /Vercel-Cache-Tag', versionTag\(room\)/);
  assert.doesNotMatch(fn, /sessionFromHeaders/, 'the answer must not depend on who asks, or the CDN would mix them');
  const api = read('template/api/comments.js');
  assert.match(api, /createStateStore\(storage, \{[^}]*onWrite: purgeVersion/);
  assert.match(api, /dangerouslyDeleteByTag\(versionTag\(room\)\)/);
  assert.match(read('template/package.json'), /"@vercel\/functions"/);
});

test('a room’s tag is a valid cache tag, and different from every other room’s', () => {
  assert.equal(versionTag(''), 'fp-state');
  assert.equal(versionTag('pr-7'), 'fp-state-pr-7');
  assert.notEqual(versionTag('pr-7'), versionTag('pr-70'));
  assert.ok(!/,/.test(versionTag('a-b')));
  assert.equal(VERSION_HEADERS['Cache-Control'], 'no-store');
});
