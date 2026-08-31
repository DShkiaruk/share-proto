// Three servers speak this API: the Vercel functions, the zero-dependency local
// server, and the Cloudflare Worker's room. A reviewer must not be able to tell
// which one is behind their link, so drift between them is a defect — and it is
// the kind nobody notices until someone's comment behaves differently on one
// deployment. These checks read the sources and compare.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url).pathname;
const read = (p) => readFileSync(root + p, 'utf8');

const SERVERS = {
  'api/comments.js': read('template/api/comments.js'),
  'server.js': read('template/server.js'),
  'worker/src/room.js': read('worker/src/room.js'),
};

const actionsOf = (src) => [...new Set([...src.matchAll(/action === '([a-z-]+)'/g)].map((m) => m[1]))].sort();

test('the three servers accept exactly the same actions', () => {
  const sets = Object.entries(SERVERS).map(([name, src]) => [name, actionsOf(src)]);
  const [, reference] = sets[0];
  assert.ok(reference.length >= 14, `only ${reference.length} actions found — did the parser break?`);
  for (const [name, actions] of sets.slice(1)) {
    assert.deepEqual(actions, reference, `${name} does not accept the same actions as ${sets[0][0]}`);
  }
});

// The GET payload is the overlay's whole view of a deployment. A field missing
// on one server silently switches a feature off there.
function payloadKeys(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start > 0, `payload marker not found: ${marker}`);
  let depth = 0;
  let end = start;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = src.slice(start, end);
  // `key: value` and shorthand `key,` alike, at the payload's own indent.
  const keys = [...body.matchAll(/^\s{4,8}([a-zA-Z][a-zA-Z0-9]*)\s*[:,]/gm)].map((m) => m[1]);
  return [...new Set(keys)].sort();
}

test('the three servers answer GET with the same fields', () => {
  const api = payloadKeys(SERVERS['api/comments.js'], 'return res.status(200).json({');
  const local = payloadKeys(SERVERS['server.js'], 'return json(res, 200, {\n      v: 2,');
  const worker = payloadKeys(SERVERS['worker/src/room.js'], 'return {\n      v: 2,');
  assert.ok(api.includes('navTrail') && api.includes('threads'), `unexpected key set: ${api.join(', ')}`);
  assert.deepEqual(local, api, 'server.js and api/comments.js disagree');
  assert.deepEqual(worker, api, 'the Worker room and api/comments.js disagree');
});

// Rules live in one place; a server that reimplements one will drift from it.
test('every server takes its thread rules from template/lib', () => {
  for (const [name, src] of Object.entries(SERVERS)) {
    assert.match(src, /threads\.js'\)?;?/, `${name} does not import the shared thread rules`);
    for (const fn of ['canSee', 'sanitizeTrail', 'applyTrail', 'applyStatus', 'applyReact']) {
      assert.ok(src.includes(fn), `${name} does not use ${fn} from the shared rules`);
    }
  }
});
