// Throwaway probe: after put(overwrite) is get(useCache:false) immediately fresh?
// usage: BLOB_READ_WRITE_TOKEN=… ACCESS=private|public node scripts/spike-blob.mjs
import { put, get, head, del } from '@vercel/blob';

const access = process.env.ACCESS || 'private';
const name = `spike/state-${Date.now()}.json`;
const opts = { access, addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true };
const readJson = async () => {
  const r = await get(name, { access, useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return JSON.parse(await new Response(r.stream).text());
};

let stale = 0, conflicts = 0;
const t0 = Date.now();
for (let i = 0; i < 50; i++) {
  await put(name, JSON.stringify({ i }), opts);
  const gap = i % 2 ? 0 : 200;
  if (gap) await new Promise((r) => setTimeout(r, gap));
  const seen = await readJson();
  if (!seen || seen.i !== i) { stale++; console.log(`  stale at ${i}: saw`, seen, `gap ${gap}ms`); }
}
// Conditional write: second writer with an old etag must be rejected.
const h1 = await head(name);
await put(name, JSON.stringify({ i: 'A' }), { ...opts, ifMatch: h1.etag });
try {
  await put(name, JSON.stringify({ i: 'B' }), { ...opts, ifMatch: h1.etag });
} catch (e) {
  conflicts++;
  console.log('  conflict error class:', e.constructor.name);
}
const final = await readJson();
// Also record what get() exposes, so lib/storage.js can rely on it.
const shape = await get(name, { access, useCache: false });
const keys = Object.keys(shape || {});
const blobKeys = Object.keys(shape?.blob || {});
await del(name).catch(() => {});
console.log(JSON.stringify({ access, iterations: 50, stale, ifMatchRejected: conflicts === 1, final, getKeys: keys, getBlobKeys: blobKeys, ms: Date.now() - t0 }));
