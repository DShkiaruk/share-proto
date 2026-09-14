#!/usr/bin/env node
/* Move a room of comments from one deployment to another.

   Usage:
     node scripts/move-room.mjs \
       --from https://old.vercel.app        --from-password <team password> \
       --to   https://comments.workers.dev  --to-password   <team password> \
       [--to-room <name>] [--from-room <name>] [--dry-run]

   Both ends speak the same API, so the direction does not matter: Vercel → a
   Worker, a Worker → local, one Worker room → another. What moves is the room
   as people know it — authors, times, numbers, statuses, replies, reactions,
   trails, the theme each comment was left in, the pictures, the learned map.

   Safe to re-run: the target skips threads it already has, so an interrupted
   move is resumed by running the same command again.

   It reads from the source and never writes to it: the old deployment keeps
   working, which is what makes it safe to try before you switch the link. */

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const FROM = (opt('from') || '').replace(/\/$/, '');
const TO = (opt('to') || '').replace(/\/$/, '');
const FROM_PASS = opt('from-password');
const TO_PASS = opt('to-password');
const FROM_ROOM = opt('from-room');
const TO_ROOM = opt('to-room');
const DRY = flag('dry-run');
const CHUNK = 25; // threads per request: well under every platform's body limit

if (!FROM || !TO || !FROM_PASS || !TO_PASS) {
  console.error('usage: move-room.mjs --from <url> --from-password <p> --to <url> --to-password <p> [--to-room <name>] [--from-room <name>] [--dry-run]');
  process.exit(1);
}

const q = (room) => (room ? `?room=${encodeURIComponent(room)}` : '');

/* Two deployments, two ways of carrying a session: the Vercel and local
   editions set a cookie, the Worker answers with a token. Take whichever
   arrives and use it for everything after. */
async function signIn(base, password, room) {
  const r = await fetch(`${base}/api/login${q(room)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, name: 'Move' }),
  });
  if (!r.ok) throw new Error(`${base}: login failed (${r.status})`);
  const body = await r.json();
  if (body.role !== 'designer') throw new Error(`${base}: that password is not the team one (got "${body.role}")`);
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const headers = { 'Content-Type': 'application/json' };
  if (body.token) headers.Authorization = `Bearer ${body.token}`;
  if (cookie) headers.Cookie = cookie;
  return headers;
}

const get = async (base, path, headers) => {
  const r = await fetch(`${base}${path}`, { headers });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r;
};

async function post(base, headers, body, room) {
  const r = await fetch(`${base}/api/comments${q(room)}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`POST ${body.action} → ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// Every picture the room refers to, each exactly once.
function mediaPaths(data) {
  const paths = new Set();
  for (const t of data.threads || []) {
    if (t.preview) paths.add(t.preview);
    for (const m of t.messages || []) for (const p of m.img || []) paths.add(p);
  }
  for (const p of Object.values(data.shots || {})) paths.add(p);
  return [...paths];
}

const source = await signIn(FROM, FROM_PASS, FROM_ROOM);
const exported = await (await get(FROM, `/api/comments${q(FROM_ROOM)}`, source)).json();
const files = mediaPaths(exported);
console.log(
  `from ${FROM}: ${exported.threads.length} threads, ` +
    `${Object.keys(exported.nav || {}).length} learned transitions, ` +
    `${Object.keys(exported.shots || {}).length} screens, ${files.length} pictures`
);
if (DRY) {
  console.log('--dry-run: nothing was sent');
  process.exit(0);
}

const target = await signIn(TO, TO_PASS, TO_ROOM);
const already = await (await get(TO, `/api/comments${q(TO_ROOM)}`, target)).json();
if (already.threads.length) console.log(`to ${TO}: ${already.threads.length} threads already there — they stay, the rest is added`);

// Pictures first: a thread that arrives before its picture would show a gap
// until the picture followed, and a failed transfer costs one retry, not the move.
let sent = 0;
let lost = 0;
for (const path of files) {
  try {
    const r = await get(FROM, `/api/file?p=${encodeURIComponent(path)}${FROM_ROOM ? `&room=${encodeURIComponent(FROM_ROOM)}` : ''}`, source);
    const type = r.headers.get('content-type') || 'image/jpeg';
    const image = `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
    await post(TO, target, { action: 'import', file: { path, image } }, TO_ROOM);
    sent++;
  } catch (e) {
    // A picture that will not come across must not stop the comments: the
    // thread still moves, and says so below.
    lost++;
    console.warn(`  picture skipped: ${path} — ${e.message}`);
  }
  if (sent % 10 === 0 && sent) process.stdout.write(`  pictures: ${sent}/${files.length}\r`);
}
if (files.length) console.log(`  pictures: ${sent}/${files.length} moved${lost ? `, ${lost} skipped` : ''}`);

// Then the room itself, in chunks. The first carries the map and the versions.
let imported = 0;
let skipped = 0;
for (let i = 0; i < Math.max(1, exported.threads.length); i += CHUNK) {
  const chunk = exported.threads.slice(i, i + CHUNK);
  const first = i === 0;
  const res = await post(
    TO,
    target,
    {
      action: 'import',
      threads: chunk,
      ...(first
        ? { nav: exported.nav, versions: exported.versions, shots: exported.shots, mapmeta: exported.mapmeta }
        : {}),
    },
    TO_ROOM
  );
  imported += res.imported || 0;
  skipped += res.skipped || 0;
  process.stdout.write(`  threads: ${Math.min(i + CHUNK, exported.threads.length)}/${exported.threads.length}\r`);
}
console.log(`  threads: ${imported} moved${skipped ? `, ${skipped} already there` : ''}          `);

// Say what actually arrived, read back from the target rather than assumed.
const after = await (await get(TO, `/api/comments${q(TO_ROOM)}`, target)).json();
const wanted = new Set(exported.threads.map((t) => t.id));
const arrived = new Set(after.threads.map((t) => t.id));
const missing = [...wanted].filter((id) => !arrived.has(id));
const numbers = exported.threads.filter((t) => {
  const there = after.threads.find((x) => x.id === t.id);
  return there && there.n !== t.n;
});
console.log(`to ${TO}: ${after.threads.length} threads, ${Object.keys(after.nav || {}).length} transitions, ${Object.keys(after.shots || {}).length} screens`);
if (missing.length) console.log(`  ${missing.length} did NOT arrive: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
if (numbers.length) console.log(`  ${numbers.length} were renumbered (the target already used those numbers)`);
console.log(missing.length ? 'INCOMPLETE — run the same command again to resume' : 'OK');
process.exit(missing.length ? 1 : 0);
