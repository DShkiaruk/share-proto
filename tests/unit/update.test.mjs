// The updater is a runbook people run against a live client project, so the
// thing to prove is what it does NOT touch as much as what it copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const template = join(root, 'template');
const script = join(root, 'scripts', 'update.py');
const run = (dir, ...args) =>
  execFileSync('python3', [script, dir, ...args], { encoding: 'utf8' });

function fakeVercelProject({ stale = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'share-proto-update-'));
  cpSync(join(template, 'api'), join(dir, 'api'), { recursive: true });
  cpSync(join(template, 'lib'), join(dir, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'public'), { recursive: true });
  for (const f of ['overlay.js', 'overlay.css', 'login.html']) {
    cpSync(join(template, 'public', f), join(dir, 'public', f));
  }
  cpSync(join(template, 'middleware.js'), join(dir, 'middleware.js'));
  // the project's own things
  writeFileSync(join(dir, 'public', 'index.html'), '<h1>the prototype</h1>');
  writeFileSync(join(dir, '.env.local'), 'DESIGNER_PASSWORD=secret\n');
  mkdirSync(join(dir, '.vercel'), { recursive: true });
  writeFileSync(join(dir, '.vercel', 'project.json'), '{"projectId":"keep-me"}');
  // login.html as an install has it: the placeholder already filled in
  const login = readFileSync(join(template, 'public', 'login.html'), 'utf8');
  writeFileSync(join(dir, 'public', 'login.html'), login.replaceAll('{{PROTO_TITLE}}', 'Acme app'));
  if (stale) writeFileSync(join(dir, 'public', 'overlay.js'), '/* an old build */');
  return dir;
}

test('the updater syncs the tool and leaves the project alone', () => {
  const dir = fakeVercelProject();
  try {
    const out = run(dir);
    assert.match(out, /public\/overlay\.js/, 'the stale file is reported');
    assert.equal(
      readFileSync(join(dir, 'public', 'overlay.js'), 'utf8'),
      readFileSync(join(template, 'public', 'overlay.js'), 'utf8')
    );
    // files the tool gained since that install are added, not skipped
    assert.ok(existsSync(join(dir, 'public', 'screenshot.js')), 'a newly shipped file arrives');
    // the project's own files survive
    assert.equal(readFileSync(join(dir, 'public', 'index.html'), 'utf8'), '<h1>the prototype</h1>');
    assert.equal(readFileSync(join(dir, '.env.local'), 'utf8'), 'DESIGNER_PASSWORD=secret\n');
    assert.match(readFileSync(join(dir, '.vercel', 'project.json'), 'utf8'), /keep-me/);
    // the login page keeps the prototype's name, never the placeholder
    const login = readFileSync(join(dir, 'public', 'login.html'), 'utf8');
    assert.match(login, /<title>Acme app — protected prototype<\/title>/);
    assert.ok(!login.includes('{{PROTO_TITLE}}'), 'the placeholder is not written into an install');
    // a Vercel project does not grow a local server it never had
    assert.ok(!existsSync(join(dir, 'server.js')));
    // and running it twice is a no-op
    assert.match(run(dir), /already current/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--dry-run reports without writing', () => {
  const dir = fakeVercelProject();
  try {
    const out = run(dir, '--dry-run');
    assert.match(out, /Would update/);
    assert.equal(readFileSync(join(dir, 'public', 'overlay.js'), 'utf8'), '/* an old build */');
    assert.ok(!existsSync(join(dir, 'public', 'screenshot.js')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory that never had the tool is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'share-proto-none-'));
  try {
    assert.throws(() => run(dir), /does not look like a share-proto project/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
