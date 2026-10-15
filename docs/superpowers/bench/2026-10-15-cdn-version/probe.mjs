const BASE = 'https://sp-cache-probe.vercel.app';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (headers = {}) => {
  const t = Date.now();
  const r = await fetch(BASE + '/api/v', { headers, cache: 'no-store' });
  const j = await r.json();
  return { at: j.generatedAt, cache: r.headers.get('x-vercel-cache'), ms: Date.now() - t, region: r.headers.get('x-vercel-id')?.split('::')[0] };
};
// 1. does it cache, with and without a cookie
const seq = [];
for (let i = 0; i < 4; i++) seq.push(await get());
for (let i = 0; i < 3; i++) seq.push(await get({ Cookie: 'fp_session=abc; other=1' }));
console.log('plain then with cookie:', seq.map((s) => `${s.cache}/${s.ms}ms/${String(s.at).slice(-5)}`).join('  '), 'edge', seq[0].region);
// 2. purge latency: bump, then read every 100 ms until the value changes
const lat = [];
for (let k = 0; k < 8; k++) {
  const before = (await get()).at;
  const b0 = Date.now();
  const bump = await (await fetch(BASE + '/api/bump', { cache: 'no-store' })).json();
  const bumpMs = Date.now() - b0;
  let seen = null, cacheAfter = [];
  for (let i = 0; i < 300; i++) {
    const s = await get();
    cacheAfter.push(s.cache);
    if (s.at !== before) { seen = Date.now() - b0; break; }
    await sleep(100);
  }
  const after = [];
  for (let i = 0; i < 3; i++) after.push((await get()).cache);
  lat.push(seen);
  console.log(`purge ${k + 1}: bump answered in ${bumpMs} ms (purge call ${bump.ms} ms); new version seen ${seen} ms after bump; reads until then: ${cacheAfter.length} [${[...new Set(cacheAfter)]}]; next reads ${after}`);
  await sleep(1500);
}
console.log('seen-after ms:', lat.join(', '));
