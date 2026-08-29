// Replay an exported /api/comments payload into a store as v2 events, then
// let the API rebuild state.json.  Usage:
//   BLOB_READ_WRITE_TOKEN=<target store token> node scripts/seed.mjs export.json [rooms/<room>/]
// Then, as a designer: curl -b <cookie> "<URL>/api/comments?rebuild=1"
// Also the upgrade path for v1 deployments on public stores: export as a
// designer, create a private store, seed, rebuild.
import { put } from '@vercel/blob';
import { readFileSync } from 'node:fs';

const [file, root = ''] = process.argv.slice(2);
if (!file) throw new Error('usage: seed.mjs export.json [root/]');
const opts = { access: 'private', addRandomSuffix: false, contentType: 'application/json' };
const ts = (at) => String(at).padStart(14, '0');
const data = JSON.parse(readFileSync(file, 'utf8'));

let n = 0;
for (const t of data.threads) {
  const [head, ...rest] = t.messages;
  await put(
    `${root}threads/${t.id}/${ts(t.createdAt)}-${crypto.randomUUID()}.json`,
    JSON.stringify({
      type: 'msg', at: t.createdAt, author: head.author, role: head.role, text: head.text,
      first: {
        authorRole: t.authorRole, screen: t.screen, screenLabel: t.screenLabel, anchor: t.anchor,
        proto: t.proto || null, page: t.page || null,
      },
    }),
    opts
  );
  n++;
  for (const m of rest) {
    await put(
      `${root}threads/${t.id}/${ts(m.at)}-${crypto.randomUUID()}.json`,
      JSON.stringify({ type: 'msg', at: m.at, author: m.author, role: m.role, text: m.text }),
      opts
    );
    n++;
  }
  if (t.resolved) {
    const at = (t.messages.at(-1)?.at || t.createdAt) + 1;
    await put(
      `${root}threads/${t.id}/${ts(at)}-${crypto.randomUUID()}.json`,
      JSON.stringify({ type: 'state', at, resolved: true }),
      opts
    );
    n++;
  }
}
let at = Date.now() - Object.keys(data.nav || {}).length;
for (const [key, anchor] of Object.entries(data.nav || {})) {
  const [from, to] = key.split('>');
  await put(`${root}nav/e-${ts(at)}-${crypto.randomUUID()}.json`, JSON.stringify({ from, to, anchor, at }), opts);
  at++;
  n++;
}
console.log(`seeded ${n} events (${data.threads.length} threads, ${Object.keys(data.nav || {}).length} edges)`);
