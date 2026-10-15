// results.jsonl → the tables in README.md (medians; "none" = never happened
// within the run's limit). Rows inside a window given with --skip are left
// out and counted, e.g. --skip 19:51:00-19:54:30 for runs that shared the
// machine with something else.
//   [RESULTS=results-turns.jsonl] node summary.mjs [--skip HH:MM:SS-HH:MM:SS ...]
import { readFileSync } from 'node:fs';

const rows = readFileSync(new URL(process.env.RESULTS || 'results.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const skips = [];
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === '--skip') skips.push(process.argv[++i].split('-'));
const skipped = (r) => skips.some(([a, b]) => r.at.slice(11, 19) >= a && r.at.slice(11, 19) <= b);
const kept = rows.filter((r) => !skipped(r));

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return xs.length ? 'none' : '—';
  const m = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return v.length < xs.length ? `${Math.round(m)} (${xs.length - v.length}/${xs.length} none)` : Math.round(m * 10) / 10;
};
const sec = (ms) => (typeof ms === 'number' ? (ms / 1000).toFixed(ms < 1000 ? 2 : 1) + ' s' : ms);
const pick = (f) => kept.filter(f);
const VS = ['old', 'new', 'next'].filter((v) => kept.some((r) => r.v === v));
const line = (cells) => `| ${cells.join(' | ')} |`;

const out = [];
out.push(`${rows.length} rows, ${rows.length - kept.length} left out${skips.length ? ` (${skips.map((s) => s.join('–')).join(', ')} UTC)` : ''}.`, '');

out.push('### Leaving a comment (Chromium)', '');
out.push(line(['page', 'CPU', 'version', 'n', 'comment drawn', 'longest freeze', 'freezes in all', 'extra work', 'picture saved']));
out.push(line(Array(9).fill('---')));
for (const p of ['heavy', 'report', 'app']) for (const rate of [1, 4]) for (const v of VS) {
  const rs = pick((r) => r.test === 'post' && r.p === p && r.rate === rate && r.v === v);
  if (!rs.length) continue;
  const pv = median(rs.map((r) => r.previewMs));
  out.push(line([p, `${rate}×`, v, rs.length, sec(median(rs.map((r) => r.drawnMs))), sec(median(rs.map((r) => r.longestFreezeMs))), sec(median(rs.map((r) => r.frozenTotalMs))), median(rs.map((r) => r.extraWorkS)) + ' s', typeof pv === 'number' ? sec(pv) : pv]));
}

out.push('', '### Your own comment when reads are slow (2 s per read)', '');
out.push(line(['page', 'version', 'n', 'comment drawn']), line(Array(4).fill('---')));
for (const p of ['heavy', 'app']) for (const v of VS) {
  const rs = pick((r) => r.test === 'slowread' && r.p === p && r.v === v);
  if (rs.length) out.push(line([p, v, rs.length, sec(median(rs.map((r) => r.shownMs)))]));
}

out.push('', '### Someone else’s comment, after 20 minutes away', '');
out.push(line(['back by', 'version', 'n', 'seen after']), line(Array(4).fill('---')));
for (const how of ['click', 'focus']) for (const v of VS) {
  const rs = pick((r) => r.test === `idle-${how}` && r.v === v);
  if (rs.length) out.push(line([how === 'click' ? 'a click on the page' : 'the window back in front', v, rs.length, median(rs.map((r) => r.seenAfterS)) + ' s']));
}

out.push('', '### 40 pins, scrolling, 4× slower CPU', '');
out.push(line(['screen', 'version', 'n', 'CPU at rest', 'CPU scrolling', 'frame p50', 'frame p95', 'frames > 50 ms']), line(Array(8).fill('---')));
for (const t of ['scroll', 'scroll-phone']) for (const v of VS) {
  const rs = pick((r) => r.test === t && r.v === v);
  if (rs.length) out.push(line([t === 'scroll' ? 'desktop' : 'phone', v, rs.length, median(rs.map((r) => r.restCpuPct)) + '%', median(rs.map((r) => r.scrollCpuPct)) + '%', median(rs.map((r) => r.frameP50)) + ' ms', median(rs.map((r) => r.frameP95)) + ' ms', median(rs.map((r) => r.jank50))]));
}

out.push('', '### Safari’s engine (WebKit), leaving a comment', '');
out.push(line(['page', 'screen', 'version', 'n', 'longest stuck', 'stuck in all (gaps > 100 ms)', 'picture saved']), line(Array(7).fill('---')));
for (const p of ['heavy', 'report']) for (const t of ['webkit-desk', 'webkit-iphone']) for (const v of VS) {
  const rs = pick((r) => r.test === t && r.p === p && r.v === v);
  if (!rs.length) continue;
  const pv = median(rs.map((r) => r.previewMs));
  out.push(line([p, t === 'webkit-desk' ? 'desktop' : 'iPhone', v, rs.length, sec(median(rs.map((r) => r.longestStuckMs))), sec(median(rs.map((r) => r.stuckOver100ms))), typeof pv === 'number' ? sec(pv) : pv]));
}

const live = pick((r) => r.test === 'live' && r.rep);
if (live.length) {
  out.push('', '### The lab on Vercel (real network, this code)', '');
  const same = pick((r) => r.test === 'live' && r.file).map((r) => `${r.file} ${r.same ? 'same as this checkout' : 'DIFFERENT'}`);
  out.push(same.join('; ') + '.', '');
  out.push(line(['n', 'saved', 'comment drawn', 'longest freeze', 'picture saved', 'a designer at the page sees it']), line(Array(6).fill('---')));
  out.push(line([live.length, sec(median(live.map((r) => r.savedMs))), sec(median(live.map((r) => r.drawnMs))), sec(median(live.map((r) => r.longestFreezeMs))), sec(median(live.map((r) => r.previewMs))), sec(median(live.map((r) => r.designerSeesAfterKeyMs)))]));
}
console.log(out.join('\n'));
