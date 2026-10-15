// The comment watch is switched off (v2.8.1). What is left to test is the way
// out: the hook v2.8 installed still runs at every session start, and must
// take itself out — and the list of team passwords with it — without a word,
// without touching anything that is not its own, and without ever stopping a
// session from starting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync, chmodSync, statSync, lstatSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const SCRIPT = join(root, 'scripts/watch.mjs');
const HOOK = `"/opt/homebrew/bin/node" "${SCRIPT}" check`;
const OTHER = { type: 'command', command: 'node ~/tools/ci/watch.mjs check' };

const withConfig = (fn) => async () => {
  const cfg = mkdtempSync(join(tmpdir(), 'watch-off-'));
  try {
    await fn(cfg);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
};
const run = (cfg, ...args) =>
  spawnSync('node', [SCRIPT, ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: cfg }, encoding: 'utf8' });
const settings = (cfg, s) => writeFileSync(join(cfg, 'settings.json'), typeof s === 'string' ? s : JSON.stringify(s, null, 2));
const readSettings = (cfg) => JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8'));
const registry = (cfg, ...names) => {
  mkdirSync(join(cfg, 'share-proto'), { recursive: true });
  for (const n of names) writeFileSync(join(cfg, 'share-proto', n), '{"v":1,"prototypes":[{"password":"team-secret"}]}');
};

test('the old hook takes itself out at the next session start, says nothing, and the session starts', withConfig((cfg) => {
  settings(cfg, { model: 'opus', hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: HOOK, timeout: 5 }] }] } });
  registry(cfg, 'watch.json');
  const r = run(cfg, 'check');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'nothing reaches the session');
  assert.equal(r.stderr, '');
  assert.deepEqual(readSettings(cfg), { model: 'opus' }, 'the hook is gone, and the empty lists it sat in');
  assert.equal(existsSync(join(cfg, 'share-proto')), false, 'the team passwords are gone');
  // the next start finds nothing to do, and is just as quiet
  const again = run(cfg, 'check');
  assert.equal(again.status, 0);
  assert.equal(again.stdout, '');
}));

test('a headless run cleans up the same way: there is no news left to protect', withConfig((cfg) => {
  settings(cfg, { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: HOOK }] }] } });
  const r = spawnSync('node', [SCRIPT, 'check'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ATTENDED: '0', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
    encoding: 'utf8',
  });
  assert.equal(r.stdout, '');
  assert.deepEqual(readSettings(cfg), {});
}));

test('other hooks, in the same group or elsewhere, are kept — another tool’s watch.mjs too', withConfig((cfg) => {
  const lint = { type: 'command', command: 'echo hi' };
  settings(cfg, {
    hooks: {
      SessionStart: [{ matcher: 'startup', hooks: [lint, { type: 'command', command: HOOK }] }, { hooks: [OTHER] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [lint] }],
    },
  });
  run(cfg, 'check');
  assert.deepEqual(readSettings(cfg).hooks, {
    SessionStart: [{ matcher: 'startup', hooks: [lint] }, { hooks: [OTHER] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [lint] }],
  });
}));

test('a hook written with an older path, or plain node, is ours too', withConfig((cfg) => {
  settings(cfg, { hooks: { SessionStart: [
    { hooks: [{ type: 'command', command: 'node "/old/place/share-proto/scripts/watch.mjs" check' }] },
    { hooks: [{ type: 'command', command: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Anna Maria\\share-proto\\scripts\\watch.mjs" check' }] },
  ] } });
  run(cfg, 'check');
  assert.deepEqual(readSettings(cfg), {});
}));

test('a settings file that is not valid JSON is left exactly as it was', withConfig((cfg) => {
  const broken = '{ "hooks": { "SessionStart": [ ' + JSON.stringify({ hooks: [{ command: HOOK }] }) + ' ';
  settings(cfg, broken);
  const r = run(cfg, 'check');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(readFileSync(join(cfg, 'settings.json'), 'utf8'), broken);
}));

test('no settings file is not created, and no hook means the file is not rewritten', withConfig((cfg) => {
  run(cfg, 'check');
  assert.equal(existsSync(join(cfg, 'settings.json')), false);
  const text = '{"model":"opus"}';
  settings(cfg, text);
  run(cfg, 'check');
  assert.equal(readFileSync(join(cfg, 'settings.json'), 'utf8'), text, 'byte for byte');
}));

test('a 0600 settings file stays 0600, and a symlinked one stays a symlink', withConfig((cfg) => {
  const real = join(cfg, 'dotfiles-settings.json');
  writeFileSync(real, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: HOOK }] }] } }));
  chmodSync(real, 0o600);
  symlinkSync(real, join(cfg, 'settings.json'));
  run(cfg, 'check');
  assert.ok(lstatSync(join(cfg, 'settings.json')).isSymbolicLink(), 'still a symlink');
  assert.equal(statSync(real).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')), {});
}));

test('every copy of the list goes — lock, half-writes, damaged copies — and nothing else in the folder', withConfig((cfg) => {
  registry(cfg, 'watch.json', 'watch.json.lock', 'watch.json.123.abc.tmp', 'watch.json.broken-2026-10-15T10-00-00-000Z');
  writeFileSync(join(cfg, 'share-proto', 'notes.txt'), 'someone else’s');
  run(cfg, 'check');
  assert.deepEqual(readdirSync(join(cfg, 'share-proto')), ['notes.txt']);
}));

test('the old runbook’s add sets nothing up, and says so; uninstall says what it removed', withConfig((cfg) => {
  const add = run(cfg, 'add', 'https://p.example.com/', '--password', 'team-x', '--name', 'Dima');
  assert.equal(add.status, 0);
  assert.match(add.stdout, /switched off/);
  assert.equal(existsSync(join(cfg, 'settings.json')), false);
  assert.equal(existsSync(join(cfg, 'share-proto')), false);

  settings(cfg, { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: HOOK }] }] } });
  registry(cfg, 'watch.json');
  assert.match(run(cfg, 'uninstall').stdout, /Startup hook: removed\. List of watched prototypes: deleted\./);
  assert.match(run(cfg, 'uninstall').stdout, /Startup hook: none\. List of watched prototypes: none\./);
}));

test('run through a symlinked skill folder, the hook still finds itself', withConfig((cfg) => {
  const linkDir = mkdtempSync(join(tmpdir(), 'watch-link-'));
  try {
    symlinkSync(root, join(linkDir, 'share-proto'));
    const linked = join(linkDir, 'share-proto', 'scripts', 'watch.mjs');
    settings(cfg, { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${linked}" check` }] }] } });
    const r = spawnSync('node', [linked, 'check'], { env: { ...process.env, CLAUDE_CONFIG_DIR: cfg }, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.deepEqual(readSettings(cfg), {});
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
  }
}));
