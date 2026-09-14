// Doc drift is silent: a file missing from SKILL.md's install list does not
// break the build, it just removes a feature from every project installed that
// way (this caught public/screenshot.js — previews would never have loaded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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

/* The Cloudflare runbook is executed by somebody else's assistant on a machine
   we will never see, so the failure it must not have is naming something that
   does not exist: a script, a secret the code never reads, an attribute the
   overlay ignores. Prose cannot be run; this checks it against the code. */
test('the Cloudflare runbook only names things that exist', () => {
  const doc = read('docs/CLOUDFLARE.md');

  for (const script of [...doc.matchAll(/`?(scripts\/[a-z-]+\.(?:sh|mjs|py))`?/g)].map((m) => m[1])) {
    assert.ok(existsSync(join(root, script)), `CLOUDFLARE.md tells people to run ${script}, which is missing`);
  }

  // Every secret it tells them to set has to be one the Worker actually reads.
  const worker = read('worker/src/index.js') + read('worker/src/room.js');
  // The ones it tells them to set, and the ones it names in backticks — not
  // every capitalised word (a shell variable in an example is neither).
  const named = [
    ...new Set([
      ...[...doc.matchAll(/secret put ([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]),
      ...[...doc.matchAll(/`([A-Z][A-Z0-9_]{5,})`/g)].map((m) => m[1]),
    ]),
  ];
  assert.ok(named.includes('DESIGNER_PASSWORD') && named.includes('ROOM_PASSWORDS'), `parser broke: ${named.join(', ')}`);
  // Variables wrangler itself consumes are not the Worker's environment.
  const TOOLING = new Set(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
  for (const v of named.filter((x) => !TOOLING.has(x))) {
    assert.match(worker, new RegExp(`env\\.${v}\\b`), `CLOUDFLARE.md names ${v}, but the Worker never reads it`);
  }

  // The tag it hands over must be the one the overlay understands.
  assert.match(doc, /data-room=/, 'the runbook stopped naming the room on the tag');
  assert.match(read('template/public/overlay.js'), /getAttribute\('data-room'\)/, 'the overlay no longer reads data-room');

  // And the preflight has to be the first thing, or the rest fails further from
  // the cause than it should.
  assert.match(doc, /preflight\.sh --worker/);
  assert.match(read('SKILL.md'), /scripts\/preflight\.sh/, 'SKILL.md no longer sends the agent through the preflight');
  assert.match(read('SKILL.md'), /docs\/CLOUDFLARE\.md/, 'SKILL.md no longer points at the Cloudflare runbook');
});

test('the preflight names a fix for everything it can refuse', () => {
  const pre = read('scripts/preflight.sh');
  // Every gap() call carries a second argument: the way out of it.
  for (const [, call] of pre.matchAll(/\n\s*gap (["'].*)/g)) {
    assert.ok(/["']\s+["']/.test(call), `a preflight check refuses without saying how to fix it: ${call.slice(0, 60)}`);
  }
  assert.match(pre, /dash\.cloudflare\.com\/sign-up/, 'the preflight stopped telling people where to make the account');
  // Signing in is the assistant's job, not a command handed over to be pasted.
  assert.match(pre, /cloudflare-login\.sh/, 'the preflight stopped pointing at the login helper');
  assert.ok(!/!\s*cd worker && npx wrangler login/.test(pre), 'the preflight went back to asking the person to type it');
  assert.ok(existsSync(join(root, 'scripts/cloudflare-login.sh')), 'the login helper is missing');
});

/* The assembler is what every install goes through, so the choice of where
   comments live has to be one of its inputs — a tag edited by hand afterwards
   is the step people skip or get subtly wrong. */
test('assemble can point a new project at a comments host from the start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'share-proto-assemble-'));
  const target = join(dir, 'acme-proto');
  try {
    execFileSync('python3', [
      join(root, 'scripts/assemble.py'),
      join(root, 'tests/fixtures/proto.html'),
      target,
      '--comments',
      'https://comments.example.workers.dev/',
    ]);
    const html = readFileSync(join(target, 'public/index.html'), 'utf8');
    assert.match(html, /<script src="https:\/\/comments\.example\.workers\.dev\/overlay\.js" data-room="acme-proto" defer>/);
    assert.ok(!html.includes('src="/overlay.js"'), 'the local tag must not be there as well');

    // Without it, nothing changes for the single-deployment case.
    const plain = join(dir, 'plain');
    execFileSync('python3', [join(root, 'scripts/assemble.py'), join(root, 'tests/fixtures/proto.html'), plain]);
    assert.match(readFileSync(join(plain, 'public/index.html'), 'utf8'), /<script src="\/overlay\.js" defer>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* A shell script with a stray quote fails at the line it reaches, which may be
   minutes into a setup on someone else's machine. `bash -n` costs nothing and
   catches it here. (It caught one: a quote in the preflight's Cloudflare
   branch, which only showed up when that branch was taken.) */
test('every shell script parses', () => {
  for (const f of readdirSync(join(root, 'scripts')).filter((f) => f.endsWith('.sh'))) {
    assert.doesNotThrow(
      () => execFileSync('bash', ['-n', join(root, 'scripts', f)], { stdio: 'pipe' }),
      `scripts/${f} does not parse`
    );
  }
});
