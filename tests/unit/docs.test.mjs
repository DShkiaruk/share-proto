// Doc drift is silent: a file missing from SKILL.md's install list does not
// break the build, it just removes a feature from every project installed that
// way (this caught public/screenshot.js — previews would never have loaded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), 'utf8');

function walk(dir, base = '') {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = base ? `${base}/${name}` : name;
    if (statSync(join(root, dir, name)).isDirectory()) out.push(...walk(join(dir, name), rel));
    else out.push(rel);
  }
  return out;
}

// Files the Vercel install deliberately leaves behind.
const VERCEL_EXCLUDED = new Set(['server.js']);

test('SKILL.md case C lists every template file a Vercel install needs', () => {
  const skill = read('SKILL.md');
  const start = skill.indexOf('**C. Local project already deployed');
  assert.ok(start > 0, 'case C paragraph not found');
  const para = skill.slice(start, skill.indexOf('\n\n', start));
  const files = walk('template').filter((f) => !VERCEL_EXCLUDED.has(f));
  const missing = files.filter((f) => {
    const dir = f.includes('/') ? `${f.split('/')[0]}/` : null;
    return !para.includes(`\`${f}\``) && !(dir && para.includes(`\`${dir}\``));
  });
  assert.deepEqual(missing, [], `not mentioned in SKILL case C: ${missing.join(', ')}`);
});

test('UPGRADE.md names the same set of files to copy', () => {
  const up = read('docs/UPGRADE.md');
  const files = walk('template').filter((f) => !VERCEL_EXCLUDED.has(f));
  const missing = files.filter((f) => {
    const dir = f.includes('/') ? `${f.split('/')[0]}/` : null;
    return !up.includes(`\`${f}\``) && !(dir && up.includes(`\`${dir}\``));
  });
  assert.deepEqual(missing, [], `not mentioned in UPGRADE.md: ${missing.join(', ')}`);
});

test('every script SKILL.md tells the agent to run exists', () => {
  const skill = read('SKILL.md');
  for (const s of ['scripts/assemble.py', 'scripts/smoke.sh', 'scripts/crawl.mjs', 'scripts/seed.mjs']) {
    if (!skill.includes(s)) continue;
    assert.doesNotThrow(() => statSync(join(root, s)), `${s} is referenced by SKILL.md but missing`);
  }
});

// The three servers must keep agreeing about who may see what. A copy of the
// rules inside worker/ would drift silently and surface as a role leak.
test('the Worker imports the shared rules instead of copying them', () => {
  const room = read('worker/src/room.js');
  const index = read('worker/src/index.js');
  for (const mod of ['threads.js', 'state.js', 'media.js']) {
    assert.ok(room.includes(`../../template/lib/${mod}`), `worker/src/room.js no longer imports ${mod}`);
  }
  for (const mod of ['session.js', 'cors.js']) {
    assert.ok(index.includes(`../../template/lib/${mod}`), `worker/src/index.js no longer imports ${mod}`);
  }
  assert.equal(existsSync(join(root, 'worker/src/session.js')), false, 'the duplicated session module is back');
});
