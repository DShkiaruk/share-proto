/* Pure thread logic — no I/O. Shared by the Vercel API (and, later, the
   local server). Event log format (append-only, one JSON blob per event):
     threads/<tid>/<ts>-<uuid>.json  {type:'msg', at, author, role, text, first?}
                                     {type:'state', at, resolved}
                                     {type:'edit', at, target, text}
                                     {type:'tomb', at}
   `first` on the creating msg carries thread meta. */

export const clean = (str, max) => String(str || '').trim().slice(0, max);

export const canSee = (role, thread) => role === 'designer' || thread.authorRole === 'client';

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
    const msgs = evs.filter((e) => e.data.type === 'msg').map((e) => e.data);
    const firstMsg = msgs.find((m) => m.first);
    if (!firstMsg) continue;
    const states = evs.filter((e) => e.data.type === 'state');
    const messages = msgs.map((m) => ({ author: m.author, role: m.role, text: m.text, at: m.at }));
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
      // v1 read `.resolved` off the {pathname, data} wrapper → always false after a
      // rebuild from events; the state lives on `.data`.
      resolved: states.length ? Boolean(states.at(-1).data.resolved) : false,
      messages,
    });
  }
  threads.sort((a, b) => a.createdAt - b.createdAt);
  return threads;
}

export const applyCreate = (threads, thread) =>
  threads.some((t) => t.id === thread.id) ? threads : [...threads, thread];

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

export function navPatch(nav, from, to, anchor, at, cap = 500) {
  const next = { ...nav, [`${from}>${to}`]: { anchor, at } };
  const keys = Object.keys(next).sort((a, b) => next[a].at - next[b].at);
  while (keys.length > cap) delete next[keys.shift()];
  return next;
}
