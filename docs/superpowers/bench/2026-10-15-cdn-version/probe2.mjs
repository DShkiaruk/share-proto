const BASE = 'https://sp-cache-probe.vercel.app';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async () => { const r = await fetch(BASE + '/api/v', { cache: 'no-store' }); const j = await r.json(); return `${r.headers.get('x-vercel-cache')}:${String(j.generatedAt).slice(-5)}`; };
for (let k = 0; k < 3; k++) {
  await fetch(BASE + '/api/bump', { cache: 'no-store' });
  const out = [];
  for (let i = 0; i < 16; i++) { out.push(await get()); await sleep(250); }
  console.log(`after purge ${k + 1}:`, out.join(' '));
  await sleep(3000);
}
// and a quiet minute later, nothing purged
await sleep(20000);
const quiet = []; for (let i = 0; i < 6; i++) { quiet.push(await get()); await sleep(250); }
console.log('quiet:', quiet.join(' '));
