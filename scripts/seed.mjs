// Replay an exported /api/comments payload into a private store as v2 events.
//   BLOB_READ_WRITE_TOKEN=<target store token> node scripts/seed.mjs export.json [rooms/<room>/]
// Then, as a designer: curl -b <cookie> "<URL>/api/comments?rebuild=1"
// Idempotent: pathnames are deterministic and existing blobs are skipped, so
// re-running never duplicates messages. Also the upgrade path for v1
// deployments on public stores: export as a designer, create a private store,
// seed, deploy, rebuild.
import { put } from '@vercel/blob';
import { readFileSync } from 'node:fs';

const [file, root = ''] = process.argv.slice(2);
if (!file) throw new Error('usage: seed.mjs export.json [root/]');
const opts = { access: 'private', addRandomSuffix: false, contentType: 'application/json' };
const ts = (at) => String(at).padStart(14, '0');
const data = JSON.parse(readFileSync(file, 'utf8'));

let written = 0;
let skipped = 0;
async function write(pathname, payload) {
  try {
    await put(pathname, JSON.stringify(payload), opts); // no allowOverwrite → "already exists" on re-run
    written++;
  } catch (e) {
    if (/already exists/i.test(e?.message || '')) skipped++;
    else throw e;
  }
}

for (const t of data.threads) {
  const [head, ...rest] = t.messages;
  await write(`${root}threads/${t.id}/${ts(t.createdAt)}-seed-0.json`, {
    type: 'msg', at: t.createdAt, author: head.author, role: head.role, text: head.text,
    first: {
      authorRole: t.authorRole, screen: t.screen, screenLabel: t.screenLabel, anchor: t.anchor,
      proto: t.proto || null, page: t.page || null,
    },
  });
  for (const [i, m] of rest.entries()) {
    await write(`${root}threads/${t.id}/${ts(m.at)}-seed-${i + 1}.json`, {
      type: 'msg', at: m.at, author: m.author, role: m.role, text: m.text,
    });
  }
  if (t.resolved) {
    const at = (t.messages.at(-1)?.at || t.createdAt) + 1;
    await write(`${root}threads/${t.id}/${ts(at)}-seed-state.json`, { type: 'state', at, resolved: true });
  }
}
const edges = Object.entries(data.nav || {});
const base = 1_000_000_000_000; // fixed epoch keeps nav pathnames deterministic across runs
for (const [i, [key, anchor]] of edges.entries()) {
  const [from, to] = key.split('>');
  await write(`${root}nav/e-${ts(base + i)}-seed.json`, { from, to, anchor, at: base + i });
}
console.log(`seed: ${written} written, ${skipped} already present (${data.threads.length} threads, ${edges.length} edges)`);
