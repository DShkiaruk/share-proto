/* Pure thread logic — no I/O. Shared by the Vercel API (and, later, the
   local server). Event log format (append-only, one JSON blob per event):
     threads/<tid>/<ts>-<uuid>.json  {type:'msg', at, author, role, text, first?}
                                     {type:'state', at, resolved}
                                     {type:'edit', at, target, text}
                                     {type:'tomb', at}
   `first` on the creating msg carries thread meta. */

export const clean = (str, max) => String(str || '').trim().slice(0, max);

export const canSee = (role, thread) => role === 'designer' || thread.authorRole === 'client';

// Global comment numbers. Valid unique numbers are kept; missing or duplicate
// ones get the next free integer in createdAt order (the later thread loses a
// collision). Called on every assemble() and applyCreate(), so a rebuild from
// events and a live patch agree.
export function assignNumbers(threads) {
  const sorted = threads.slice().sort((a, b) => a.createdAt - b.createdAt);
  const used = new Set();
  const out = new Map();
  for (const t of sorted) {
    if (Number.isInteger(t.n) && t.n > 0 && !used.has(t.n)) {
      used.add(t.n);
      out.set(t.id, t.n);
    }
  }
  let next = 1;
  for (const t of sorted) {
    if (out.has(t.id)) continue;
    while (used.has(next)) next++;
    used.add(next);
    out.set(t.id, next);
  }
  return threads.map((t) => (out.get(t.id) === t.n ? t : { ...t, n: out.get(t.id) }));
}

export const nextNumber = (threads) =>
  threads.reduce((m, t) => Math.max(m, Number.isInteger(t.n) ? t.n : 0), 0) + 1;

// The in-screen clicks that produced the commented state (opened a menu, a
// dialog…). Replayed by "Go to comment". Untrusted input → shape-checked.
export function sanitizeTrail(raw) {
  if (!Array.isArray(raw)) return [];
  const out = raw
    .filter((s) => s && typeof s === 'object' && s.anchor && typeof s.anchor === 'object')
    .slice(-8)
    .map((s) => ({ anchor: s.anchor, txt: typeof s.txt === 'string' ? s.txt.slice(0, 60) : null }));
  return JSON.stringify(out).length > 6000 ? [] : out;
}

export function assemble(events, root = '') {
  const byThread = new Map();
  for (const { pathname, data } of events) {
    if (!data) continue;
    const rel = root && pathname.startsWith(root) ? pathname.slice(root.length) : pathname;
    const parts = rel.split('/');
    if (parts.length !== 3 || parts[0] !== 'threads') continue;
    const tid = parts[1];
    if (!byThread.has(tid)) byThread.set(tid, []);
    byThread.get(tid).push({ pathname: rel, data });
  }
  const threads = [];
  for (const [tid, evs] of byThread) {
    evs.sort((a, b) => (a.pathname < b.pathname ? -1 : 1));
    if (evs.some((e) => e.data.type === 'tomb')) continue;
    // Identical (at, author, role) messages are the same message written twice
    // (a seed re-run, a retried request) — keep the first.
    const seen = new Set();
    const msgs = evs
      .filter((e) => e.data.type === 'msg')
      .map((e) => e.data)
      .filter((m) => {
        const k = `${m.at}|${m.author}|${m.role}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    const firstMsg = msgs.find((m) => m.first);
    if (!firstMsg) continue;
    const states = evs.filter((e) => e.data.type === 'state');
    const resolvedStates = states.filter((e) => 'resolved' in e.data);
    const previews = states.filter((e) => typeof e.data.preview === 'string');
    const messages = msgs.map((m) => ({
      author: m.author,
      role: m.role,
      text: m.text,
      at: m.at,
      ...(Array.isArray(m.img) && m.img.length ? { img: m.img.slice(0, 3) } : {}),
    }));
    for (const e of evs.filter((x) => x.data.type === 'edit')) {
      const m = messages.find((x) => x.at === e.data.target);
      if (m) {
        m.text = e.data.text;
        m.edited = true;
      }
    }
    threads.push({
      id: tid,
      createdAt: firstMsg.at,
      authorRole: firstMsg.first.authorRole,
      author: firstMsg.author,
      screen: firstMsg.first.screen,
      screenLabel: firstMsg.first.screenLabel,
      anchor: firstMsg.first.anchor,
      proto: firstMsg.first.proto || null,
      page: firstMsg.first.page || null,
      n: Number.isInteger(firstMsg.first.n) ? firstMsg.first.n : null,
      trail: sanitizeTrail(firstMsg.first.trail),
      // v1 read `.resolved` off the {pathname, data} wrapper → always false after a
      // rebuild from events; the state lives on `.data`. State events carry one
      // concern each (resolved | preview), so filter by field, not by type.
      resolved: resolvedStates.length ? Boolean(resolvedStates.at(-1).data.resolved) : false,
      preview: previews.length ? previews.at(-1).data.preview : null,
      messages,
    });
  }
  threads.sort((a, b) => a.createdAt - b.createdAt);
  return assignNumbers(threads);
}

export const applyCreate = (threads, thread) =>
  threads.some((t) => t.id === thread.id) ? threads : assignNumbers([...threads, thread]);

export const applyReply = (threads, tid, msg) =>
  threads.map((t) =>
    t.id === tid && !t.messages.some((m) => m.at === msg.at && m.author === msg.author)
      ? { ...t, messages: [...t.messages, msg] }
      : t
  );

export const applyEdit = (threads, tid, target, text) =>
  threads.map((t) =>
    t.id === tid
      ? { ...t, messages: t.messages.map((m) => (m.at === target ? { ...m, text, edited: true } : m)) }
      : t
  );

export const applyResolve = (threads, tid, resolved) =>
  threads.map((t) => (t.id === tid ? { ...t, resolved } : t));

export const applyDelete = (threads, tid) => threads.filter((t) => t.id !== tid);

export const applyPreview = (threads, tid, preview) =>
  threads.map((t) => (t.id === tid ? { ...t, preview } : t));

export function navPatch(nav, from, to, anchor, at, cap = 500) {
  const next = { ...nav, [`${from}>${to}`]: { anchor, at } };
  const keys = Object.keys(next).sort((a, b) => next[a].at - next[b].at);
  while (keys.length > cap) delete next[keys.shift()];
  return next;
}
