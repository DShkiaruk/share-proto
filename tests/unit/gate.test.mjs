// One password, typed once. When the page and the comments are hosted apart —
// the shape the Cloudflare runbook recommends — the comments host cannot see the
// page's cookie, so the overlay used to ask for the same password a second time.
// The gate now spends the password on both while it still has it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const assemble = (dir, ...extra) => {
  const proto = join(dir, 'proto.html');
  writeFileSync(proto, '<html><head><title>Acme Console</title></head><body><h1>hi</h1></body></html>');
  execFileSync('python3', [join(root, 'scripts/assemble.py'), proto, join(dir, 'site'), ...extra]);
  return join(dir, 'site');
};
const loginOf = (site) => readFileSync(join(site, 'public/login.html'), 'utf8');

test('the template ships placeholders, never a half-filled page', () => {
  const login = readFileSync(join(root, 'template/public/login.html'), 'utf8');
  assert.ok(login.includes('{{COMMENTS_META}}'), 'the placeholder is gone from the template');
  assert.ok(!login.includes('<meta name="fp-comments"'), 'the template must not name a host of its own');
});

test('a remote comments host is written into the gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  try {
    const site = assemble(dir, '--comments', 'https://c.example.com/', '--room', 'acme');
    const login = loginOf(site);
    assert.match(login, /<meta name="fp-comments" content="https:\/\/c\.example\.com" data-room="acme" \/>/);
    assert.ok(!login.includes('{{'), 'no placeholder survives assembly');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deployment that hosts its own comments gets no meta at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  try {
    const login = loginOf(assemble(dir));
    assert.ok(!/<meta name="fp-comments"/.test(login), 'same-origin installs have nothing to sign in to twice');
    assert.ok(!login.includes('{{'), 'the placeholder is removed, not left visible');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an install made before this gains the meta on update, read off its own overlay tag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  try {
    const site = assemble(dir, '--comments', 'https://c.example.com', '--room', 'acme');
    // Wind it back to what an older install looks like: the tag on the page,
    // nothing on the gate.
    const login = join(site, 'public/login.html');
    writeFileSync(login, loginOf(site).replace(/\s*<meta name="fp-comments"[^>]*>/, ''));
    assert.ok(!/<meta name="fp-comments"/.test(readFileSync(login, 'utf8')));

    execFileSync('python3', [join(root, 'scripts/update.py'), site]);
    assert.match(
      readFileSync(login, 'utf8'),
      /<meta name="fp-comments" content="https:\/\/c\.example\.com" data-room="acme" \/>/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the token is written under the key the overlay reads', () => {
  // Two files, one string. A rename on either side would leave the reviewer
  // signing in twice with no error anywhere.
  const login = readFileSync(join(root, 'template/public/login.html'), 'utf8');
  const overlay = readFileSync(join(root, 'template/public/overlay.js'), 'utf8');
  assert.ok(overlay.includes('`fp_token::${API_ORIGIN}::${ROOM}`'), 'the overlay key moved');
  assert.ok(login.includes('`fp_token::${host}::${room}`'), 'the gate writes a different key');
  assert.ok(login.includes("localStorage.setItem('fp_name', name)"), 'the name must travel with the token');
});

test('the crawler posts where the comments actually live', () => {
  // Hard-coding the page's own origin here cost a whole map: on an install whose
  // comments are on a Worker, every screenshot was refused and the crawl still
  // reported success, so the map came out as a graph of blank cards.
  const crawl = readFileSync(join(root, 'scripts/crawl.mjs'), 'utf8');
  const overlay = readFileSync(join(root, 'template/public/overlay.js'), 'utf8');
  assert.ok(!/fetch\('\/api\//.test(crawl), 'the crawler talks to a fixed origin again');
  assert.ok(crawl.includes("window.__fp.api('POST'"), 'the crawler no longer goes through the overlay');
  assert.match(overlay, /window\.__fp = \{[\s\S]*?\n    api,\n/, 'the overlay stopped exposing api');
});

test('the server side learns the comments host too, and keeps it through an update', () => {
  // The gate covers people signing in from now on. /api/comments-token covers
  // everyone whose session was issued before it existed, and every token that
  // expires mid-review — so the host has to be readable by the API, not only
  // by the login page.
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  try {
    const site = assemble(dir, '--comments', 'https://c.example.com/', '--room', 'acme');
    const file = join(site, 'lib/comments-host.js');
    assert.match(readFileSync(file, 'utf8'), /COMMENTS_HOST = "https:\/\/c\.example\.com"/);
    assert.match(readFileSync(file, 'utf8'), /COMMENTS_ROOM = "acme"/);

    // The template ships it empty; copying that over a live install would cut
    // the bridge without a word.
    writeFileSync(file, readFileSync(join(root, 'template/lib/comments-host.js'), 'utf8'));
    execFileSync('python3', [join(root, 'scripts/update.py'), site]);
    assert.match(readFileSync(file, 'utf8'), /COMMENTS_HOST = "https:\/\/c\.example\.com"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deployment that hosts its own comments has nothing to bridge to', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  try {
    const site = assemble(dir);
    assert.match(readFileSync(join(site, 'lib/comments-host.js'), 'utf8'), /COMMENTS_HOST = (""|'')/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the overlay asks the page before it asks the person', () => {
  const overlay = readFileSync(join(root, 'template/public/overlay.js'), 'utf8');
  assert.ok(overlay.includes("fetch('/api/comments-token'"), 'the overlay stopped asking the gate');
  // Once per page load, and shared: the first load fires several requests, and
  // two of them racing is what put a pill next to a working toolbar.
  assert.ok(overlay.includes('pageSessionTry'), 'the attempt is no longer shared between callers');
  assert.ok(/if \(!pageSessionTry\)/.test(overlay), 'it would ask again on every poll');
  // One way in at a time: the pill replaces the toolbar, it does not join it.
  const pill = overlay.slice(overlay.indexOf('function showPill()'), overlay.indexOf('function hidePill()'));
  assert.ok(pill.includes("toolbar.style.display = 'none'"), 'showPill leaves the toolbar up');
});
