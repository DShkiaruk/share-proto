/* proto-share comment overlay — pins, threads, role-based visibility.
   Runs in a shadow root so prototype styles and overlay styles never collide. */
(() => {
  'use strict';

  const PASTELS = ['#dbffd5', '#d5edff', '#ffd4b1', '#f4d5ff', '#fff3c4', '#ffd5d5'];
  const POLL_MS = 25000;

  /* ---------- embed mode ----------
     When this script is served from a different origin than the page it runs
     on (e.g. dropped into a client's PR preview), the page has no share-proto
     server of its own: API and asset URLs point at the script's origin, auth
     is a Bearer token (cross-site cookies don't survive), login happens in an
     in-overlay modal, and comments are partitioned into a room derived from
     the preview hostname (pr-N.<domain> → room "pr-n"). Same-origin installs
     behave exactly as before. */
  const SCRIPT_EL = document.currentScript;
  const API_ORIGIN = (() => {
    try {
      return new URL(SCRIPT_EL.src).origin;
    } catch {
      return location.origin;
    }
  })();
  // data-embed forces embed mode on a same-origin page (the host's own /demo);
  // data-room pins the comment room instead of deriving it from the hostname.
  const EMBED =
    API_ORIGIN !== location.origin || Boolean(SCRIPT_EL && SCRIPT_EL.hasAttribute('data-embed'));
  const ROOM = EMBED
    ? (SCRIPT_EL && SCRIPT_EL.getAttribute('data-room')) ||
      (location.hostname.toLowerCase().match(/^(pr-\d+)\./) || [])[1] ||
      location.hostname.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63)
    : null;
  const TOKEN_KEY = `fp_token::${API_ORIGIN}`;
  let authToken = EMBED ? localStorage.getItem(TOKEN_KEY) : null;
  const apiUrl = (path) =>
    (EMBED ? API_ORIGIN : '') + path + (ROOM ? `?room=${encodeURIComponent(ROOM)}` : '');
  const authHeaders = () =>
    EMBED && authToken ? { Authorization: `Bearer ${authToken}` } : {};

  // Exact Lucide icon paths (lucide.dev, ISC) — stroke 2, viewBox 24.
  const svg = (inner) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const ICONS = {
    comment: svg(
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6"/><path d="M9 10h6"/>'
    ),
    threads: svg(
      '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>'
    ),
    check: svg('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
    trash: svg(
      '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'
    ),
    close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    send: svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
    eye: svg(
      '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'
    ),
    eyeOff: svg(
      '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>'
    ),
    goto: svg('<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>'),
    link: svg(
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'
    ),
    edit: svg('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>'),
    paperclip: svg(
      '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'
    ),
    eyeSmall: svg('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
    bug: svg(
      '<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>'
    ),
    help: svg('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
    lightbulb: svg(
      '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>'
    ),
    plus: svg('<path d="M5 12h14"/><path d="M12 5v14"/>'),
    history: svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'),
    map: svg(
      '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>'
    ),
    grip: svg(
      '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>'
    ),
  };

  const state = {
    role: null,
    name: '',
    proto: '', // current prototype version (hash of served index.html)
    nav: {}, // shared navigation graph from the server
    threads: [],
    screen: '',
    screenLabel: '',
    mode: false,
    sidebar: false,
    pinsHidden: localStorage.getItem('fp_pins_hidden') === '1',
    filter: 'open',
    draft: null, // {x, y, anchor}
    active: null, // open thread id
    pendingJump: null, // thread id we're guiding the user to
    confirmDelete: null,
    presenting: false, // H: everything hidden, a dot remains
    sort: localStorage.getItem('fp_sort') || 'newest',
    filter: 'active', // active = open + in progress (what needs attention)
    roleFilter: 'all', // designer-only: all | client | team
    serverV: 2, // set from the API; an older comments server has no statuses, media or map
    versions: [],
    navAt: {},
    versionFilter: null,
    showVersions: false,
    shots: {},
    mapmeta: { aliases: {}, hidden: [] },
    map: false,
    prevVisit: 0,
    bootAt: 0,
  };

  const roleLabel = () => (state.role === 'designer' ? 'Designer' : 'Client');
  // Identity comes from login (name + password) via the signed session;
  // the server stamps every comment with it.
  const myLabel = () => state.name || roleLabel();
  // A server that predates numbering (the Worker edition) sends no `n`.
  const numLabel = (t) => (Number.isInteger(t.n) ? `#${t.n}` : '');
  const STATUS_LABEL = { open: 'Open', progress: 'In progress', done: 'Done', wont: 'Won’t do' };
  const KIND_LABEL = { bug: 'Bug', question: 'Question', idea: 'Idea' };
  const KIND_ICON = { bug: 'bug', question: 'help', idea: 'lightbulb' };
  const EMOJI = ['👍', '✅', '❓', '👀'];
  const statusOf = (t) => t.status || (t.resolved ? 'done' : 'open');
  const isResolvedStatus = (s) => s === 'done' || s === 'wont';
  function kindIcon(t) {
    if (!t.kind || !KIND_ICON[t.kind]) return null;
    const k = el('span', `kind-ico k-${t.kind}`);
    k.append(icon(KIND_ICON[t.kind]));
    k.title = KIND_LABEL[t.kind];
    return k;
  }
  // "New since my last visit" — per browser, like read state.
  function isNew(t) {
    if (!state.prevVisit) return false;
    const me = myLabel();
    const mine = (a, r) => a === me && r === state.role;
    if (t.createdAt > state.prevVisit && !mine(t.author, t.authorRole)) return true;
    if (t.messages.some((m) => m.at > state.prevVisit && !mine(m.author, m.role))) return true;
    return (t.history || []).some((h) => h.at > state.prevVisit && h.author && h.author !== me);
  }
  function newScreens() {
    if (!state.prevVisit) return [];
    const seen = {};
    for (const [key, at] of Object.entries(state.navAt || {})) {
      for (const label of key.split('>')) seen[label] = Math.min(seen[label] ?? Infinity, at || Infinity);
    }
    return Object.entries(seen).filter(([, at]) => at > state.prevVisit).map(([l]) => l);
  }
  const withinNewWindow = () => Date.now() - (state.bootAt || 0) < 60000;

  /* ---------- DOM helpers ---------- */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function icon(name) {
    const s = el('span');
    s.innerHTML = ICONS[name];
    s.style.display = 'contents';
    return s;
  }

  function pastel(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PASTELS[h % PASTELS.length];
  }

  function avatar(name, size) {
    const a = el('span', `avatar s${size}`, (name || '?').trim().charAt(0).toUpperCase());
    a.style.background = pastel(name || '?');
    return a;
  }

  /* ---------- unread state (per browser, shown as blue dots) ---------- */

  function readMap() {
    try {
      return JSON.parse(localStorage.getItem('fp_read') || '{}');
    } catch {
      return {};
    }
  }

  function lastAt(t) {
    return t.messages.at(-1)?.at || t.createdAt;
  }

  function isUnread(t) {
    const last = t.messages.at(-1);
    if (!last) return false;
    if (last.author === myLabel() && last.role === state.role) return false;
    return (readMap()[t.id] || 0) < last.at;
  }

  function markRead(threads) {
    const m = readMap();
    for (const t of threads) m[t.id] = lastAt(t);
    localStorage.setItem('fp_read', JSON.stringify(m));
  }

  // When someone sets a display name, keep their role visible via a badge.
  function roleBadge(t) {
    if (t.authorRole === 'client' && t.author !== 'Client') return 'Client';
    if (t.authorRole === 'designer' && t.author !== 'Designer') return 'Team';
    return null;
  }

  function timeAgo(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  /* ---------- shadow root ---------- */

  const host = el('div');
  host.setAttribute('data-fp-host', '');
  host.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const shadow = host.attachShadow({ mode: 'open' });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = (EMBED ? API_ORIGIN : '') + '/overlay.css';
  shadow.appendChild(link);
  const root = el('div', 'root');
  shadow.appendChild(root);

  const clickLayer = el('div', 'click-layer');
  clickLayer.hidden = true;
  const pinsLayer = el('div', 'pins');
  const toolbar = el('div', 'toolbar');
  const sidebar = el('aside', 'sidebar');
  let popover = null;

  root.append(clickLayer, pinsLayer, toolbar, sidebar);
  document.body.appendChild(host);

  // Interacting with the overlay must not count as an "outside click" for the
  // prototype's own menus and popovers — they would close before a comment
  // could be anchored inside them. Our own document-level listeners run in
  // the capture phase and are unaffected.
  // Only the *down* and click events: stopping the *up* events would strand a
  // prototype drag that ends over the overlay.
  for (const type of ['pointerdown', 'mousedown', 'click', 'touchstart']) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  /* ---------- screen fingerprint ---------- */

  function appRoot() {
    return (
      document.getElementById('root') ||
      document.querySelector('body > div:not([data-fp-host])') ||
      document.body
    );
  }

  // Screen identity = the page's heading (its label), NOT a content hash.
  // Content hashes made the same page with different data look like different
  // screens (breaking shared navigation), and a comment belongs to its PAGE:
  // "All Documents" is "All Documents" for everyone, whatever rows it shows.

  // Auto-match the prototype's theme: sample the effective background and
  // flip the overlay to dark tokens when the prototype is dark.
  function detectTheme() {
    let node = appRoot();
    let bg = null;
    while (node && node !== document.documentElement.parentNode) {
      const b = getComputedStyle(node).backgroundColor;
      if (b && b !== 'transparent' && !/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(b)) {
        bg = b;
        break;
      }
      node = node.parentElement;
    }
    if (!bg) return;
    const m = bg.match(/(\d+)[, ]+(\d+)[, ]+(\d+)/);
    if (!m) return;
    const lum = 0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3];
    root.classList.toggle('dark', lum < 128);
  }

  // Screen identity, in order of trust: an explicit [data-screen] tag on the
  // app root (or its first child) → the first two distinct visible headings →
  // the hash route → the first short visible sub-heading-ish text → the title.
  // Only the title is a "fallback label" (never learns graph edges).
  function screenLabel() {
    const rootEl = appRoot();
    const tagged =
      rootEl.getAttribute?.('data-screen') || rootEl.firstElementChild?.getAttribute?.('data-screen');
    // ">" is the separator in navigation-graph keys ("A>B"); a heading that
    // contains one would split into two phantom screens.
    const safe = (l) => l.replace(/>/g, '›');
    if (tagged && tagged.trim()) return safe(tagged.trim().slice(0, 80));
    const parts = [];
    for (const hd of rootEl.querySelectorAll('h1, h2, h3')) {
      const t = (hd.innerText || '').trim().slice(0, 40);
      if (t && hd.getClientRects().length && !parts.includes(t)) {
        parts.push(t);
        if (parts.length === 2) break;
      }
    }
    if (parts.length) return safe(parts.join(' · '));
    if (location.hash.length > 1) return safe(location.hash.slice(1).slice(0, 80));
    for (const n of rootEl.querySelectorAll('h4, h5, h6, [role="heading"], legend, strong')) {
      const t = (n.innerText || '').trim();
      if (t && t.length <= 40 && n.getClientRects().length) return safe(t);
    }
    return safe(document.title || 'Screen');
  }

  /* ---------- anchors ---------- */

  function buildPath(target) {
    const segs = [];
    let n = target;
    let depth = 0;
    while (n && n !== document.body && n.nodeType === 1 && depth < 14) {
      const tag = n.tagName.toLowerCase();
      if (n.id) {
        segs.unshift(`${tag}[id="${n.id.replace(/"/g, '')}"]`);
        return segs.join(' > ');
      }
      let i = 1;
      let sib = n.previousElementSibling;
      while (sib) {
        if (sib.tagName === n.tagName) i++;
        sib = sib.previousElementSibling;
      }
      segs.unshift(`${tag}:nth-of-type(${i})`);
      n = n.parentElement;
      depth++;
    }
    return 'body > ' + segs.join(' > ');
  }

  const CONTAINER_ROLES = /^(dialog|alertdialog|menu|listbox|tooltip|combobox|tree)$/;

  function firstHeadingText(n) {
    for (const h of n.querySelectorAll('h1, h2, h3, h4, [role="heading"]')) {
      const t = (h.innerText || '').trim();
      if (t) return t.slice(0, 40);
    }
    return '';
  }

  // The overlay container (menu, dialog, popover…) that holds `target`, if any:
  // by ARIA role, by open-state convention, or by being a floating layer that
  // does not cover the whole viewport. Also: the element a trail trigger
  // aria-controls. Null for ordinary page content.
  const LANDMARK_TAGS = /^(nav|header|aside|footer)$/i;
  const LANDMARK_ROLES = /^(navigation|banner|complementary|contentinfo)$/;

  function findContainer(target) {
    const rootEl = appRoot();
    const viewport = innerWidth * innerHeight;
    const last = trail.at(-1);
    const lastEl = last && Date.now() - (last.at || 0) < 15000 ? locateAnchor(last.anchor).el : null;
    for (let n = target; n && n !== rootEl && n !== document.body; n = n.parentElement) {
      const role = n.getAttribute('role') || '';
      const byRole =
        CONTAINER_ROLES.test(role) || n.getAttribute('aria-modal') === 'true' || n.getAttribute('data-state') === 'open';
      let byLayer = false;
      if (!byRole && !LANDMARK_TAGS.test(n.tagName) && !LANDMARK_ROLES.test(role)) {
        const cs = getComputedStyle(n);
        if ((cs.position === 'fixed' || cs.position === 'absolute') && (parseInt(cs.zIndex, 10) || 0) >= 1) {
          const r = n.getBoundingClientRect();
          // A floating layer counts only when a recent click *outside* it plausibly
          // opened it — fixed headers and sidebars fail this test.
          byLayer = r.width * r.height > 0 && r.width * r.height < 0.9 * viewport && Boolean(lastEl) && !n.contains(lastEl);
        }
      }
      if (byRole || byLayer) return describeContainer(n, role);
    }
    if (lastEl) {
      const id = lastEl.getAttribute('aria-controls');
      const ctl = id ? document.getElementById(id) : null;
      if (ctl && ctl.contains(target)) return describeContainer(ctl, ctl.getAttribute('role') || '');
    }
    return null;
  }

  function describeContainer(n, role) {
    const name =
      n.getAttribute('aria-label') || firstHeadingText(n) || trail.at(-1)?.txt || n.tagName.toLowerCase();
    return {
      path: buildPath(n),
      role: role || (n.getAttribute('aria-modal') === 'true' ? 'dialog' : 'layer'),
      name: name.slice(0, 60),
    };
  }

  function buildAnchor(x, y) {
    const target =
      document.elementsFromPoint(x, y).find((e) => e !== host && !host.contains(e)) ||
      document.body;
    const rect = target.getBoundingClientRect();
    const de = document.documentElement;
    // Short own text doubles as a cross-breakpoint re-anchor hint: the nth-of-type
    // path can shift when responsive layouts render different surrounding DOM.
    const s = (target.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      path: buildPath(target),
      t: target.tagName.toLowerCase(),
      txt: s && s.length <= 60 ? s : null,
      ox: rect.width ? (x - rect.left) / rect.width : 0.5,
      oy: rect.height ? (y - rect.top) / rect.height : 0.5,
      fx: de.scrollWidth ? (x + window.scrollX) / de.scrollWidth : 0.5,
      fy: de.scrollHeight ? (y + window.scrollY) / de.scrollHeight : 0.5,
      container: findContainer(target),
    };
  }

  function posInside(target, anchor) {
    const r = target.getBoundingClientRect();
    if (!r.width && !r.height) return null; // exists but hidden
    return { x: r.left + (anchor.ox ?? 0.5) * r.width, y: r.top + (anchor.oy ?? 0.5) * r.height };
  }

  // A pin is visible wherever its anchored element actually exists and is
  // rendered — the prototype mounts/unmounts screens, so this is the screen
  // check. pos is null when the anchor isn't on the current screen.
  function locateAnchor(anchor) {
    if (!anchor) return { el: null, pos: null };
    if (anchor.path) {
      let target = null;
      try {
        target = document.querySelector(anchor.path);
      } catch {
        target = null;
      }
      // nth-of-type paths can resolve to a *different* element on another
      // screen with similar structure — verify against the text hint.
      if (target && anchor.txt) {
        const s = (target.textContent || '').replace(/\s+/g, ' ').trim();
        if (s !== anchor.txt) target = null;
      }
      if (target) return { el: target, pos: posInside(target, anchor) };
      // Path failed (responsive layouts shift nth-of-type chains): re-anchor
      // by exact tag + text, only when the match is unambiguous.
      if (anchor.txt && anchor.t) {
        const matches = [...document.querySelectorAll(anchor.t)].filter(
          (e) =>
            !host.contains(e) &&
            e !== host &&
            (e.textContent || '').replace(/\s+/g, ' ').trim() === anchor.txt &&
            e.getClientRects().length
        );
        if (matches.length === 1) return { el: matches[0], pos: posInside(matches[0], anchor) };
      }
      return { el: null, pos: null };
    }
    return { el: null, pos: fracPos(anchor) };
  }

  // Approximate position from stored document fractions — used when the
  // anchor element is gone but the comment still belongs to this page.
  function fracPos(anchor) {
    if (!anchor) return null;
    const de = document.documentElement;
    return {
      x: (anchor.fx ?? 0.5) * de.scrollWidth - window.scrollX,
      y: (anchor.fy ?? 0.5) * de.scrollHeight - window.scrollY,
    };
  }

  const resolveAnchor = (anchor) => locateAnchor(anchor).pos;

  /* ---------- page identity ---------- */

  // A page is pathname + hash: hash routers ("#/settings") are pages too.
  const currentPage = () => location.pathname + location.hash;
  const splitPage = (p) => {
    const i = p.indexOf('#');
    return i < 0 ? { path: p, hash: '' } : { path: p.slice(0, i), hash: p.slice(i) };
  };
  // Legacy threads stored pathname only → match on pathname alone.
  function pageMatches(tPage) {
    if (!tPage) return true;
    const { path, hash } = splitPage(tPage);
    if (path !== location.pathname) return false;
    return !hash || hash === location.hash;
  }
  // Built by assigning pathname (never by parsing the stored string as a URL),
  // so a hostile `page` can't smuggle a scheme or a host into location.href.
  function deepLinkUrl(t) {
    const { path, hash } = splitPage(t.page || location.pathname);
    const u = new URL(location.origin);
    u.pathname = path || '/';
    u.searchParams.set('comment', t.id);
    u.hash = hash;
    return u.href;
  }
  const samePath = (tPage) => !tPage || splitPage(tPage).path === location.pathname;

  // Older builds used a single-heading label; newer ones join two ("A · B").
  // A legacy label equals the first part of its composite successor.
  function labelsMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.split(' · ')[0] === b || b.split(' · ')[0] === a;
  }

  // A comment lives on the PAGE it was left on.
  // Page check first: on multi-page prototypes two pages can share headings,
  // and a label match alone would render the pin on the wrong page.
  // The anchored element being present beats a hash mismatch: in-page anchor
  // links ("#pricing") change the hash without changing the page.
  const onThisScreen = (t) =>
    (pageMatches(t.page) || (samePath(t.page) && Boolean(locateAnchor(t.anchor).el))) &&
    (!t.screenLabel || labelsMatch(t.screenLabel, state.screen));

  /* ---------- api ---------- */

  async function api(method, body) {
    const r = await fetch(apiUrl('/api/comments'), {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) {
      if (EMBED) {
        // Token missing/expired: ask for credentials in place — the host page
        // is the client's preview, there is no login page to bounce to.
        // Respect a dismissal: non-reviewers share these previews, and the
        // poll loop lands here every cycle — it must not re-open the modal.
        authToken = null;
        localStorage.removeItem(TOKEN_KEY);
        if (loginDismissed()) showPill();
        else showLogin();
      } else {
        location.reload(); // same-origin: the server gate shows login.html
      }
      throw new Error('unauthenticated');
    }
    if (!r.ok) throw new Error(`api ${r.status}`);
    return r.json();
  }

  /* ---------- embed login modal ---------- */

  // Previews are shared with people who don't review designs: the modal must
  // be dismissible (X / Esc / backdrop click), the dismissal must stick for
  // the session, and a quiet corner pill takes its place to opt back in.
  let loginCard = null;
  let loginPill = null;
  const LOGIN_DISMISS_KEY = 'fp_login_dismissed';

  function loginDismissed() {
    try {
      return sessionStorage.getItem(LOGIN_DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  }

  function showPill() {
    if (loginPill || loginCard || state.role) return;
    loginPill = el('button', 'login-pill');
    loginPill.append(icon('comment'), el('span', null, 'Review comments'));
    loginPill.title = 'Sign in to leave design-review comments';
    loginPill.addEventListener('click', () => {
      try {
        sessionStorage.removeItem(LOGIN_DISMISS_KEY);
      } catch {}
      showLogin();
    });
    root.appendChild(loginPill);
  }

  function hidePill() {
    loginPill?.remove();
    loginPill = null;
  }

  function dismissLogin() {
    if (!loginCard) return;
    loginCard.remove();
    loginCard = null;
    try {
      sessionStorage.setItem(LOGIN_DISMISS_KEY, '1');
    } catch {}
    showPill();
  }

  function showLogin() {
    if (loginCard) return;
    hidePill();
    setMode(false);
    toolbar.style.display = 'none';
    loginCard = el('div', 'login-wrap');
    loginCard.addEventListener('click', (e) => {
      if (e.target === loginCard) dismissLogin();
    });
    const card = el('div', 'login-card');
    const closeBtn = el('button', 'login-close');
    closeBtn.append(icon('close'));
    closeBtn.title = 'Not now';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.addEventListener('click', dismissLogin);
    card.appendChild(closeBtn);
    card.appendChild(el('div', 'login-title', 'Design review comments'));
    card.appendChild(
      el('div', 'login-sub', 'Enter your name and the password you received — comments you leave will be signed with your name.')
    );
    const nameIn = el('input', 'login-input');
    nameIn.placeholder = 'Your name';
    nameIn.value = localStorage.getItem('fp_name') || '';
    const passIn = el('input', 'login-input');
    passIn.placeholder = 'Password';
    passIn.type = 'password';
    const err = el('div', 'login-err');
    const btn = el('button', 'login-btn', 'Continue');
    const submit = async () => {
      const name = nameIn.value.trim();
      const password = passIn.value.trim();
      if (!name) return err.replaceChildren('Please enter your name.');
      if (!password) return err.replaceChildren('Please enter the password.');
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        const r = await fetch(API_ORIGIN + '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, password }),
        });
        if (!r.ok) {
          err.replaceChildren('That password didn’t work.');
          passIn.select();
          return;
        }
        const data = await r.json();
        if (!data.token) {
          err.replaceChildren('Server is too old for embed mode.');
          return;
        }
        authToken = data.token;
        localStorage.setItem(TOKEN_KEY, authToken);
        localStorage.setItem('fp_name', name);
        try {
          sessionStorage.removeItem(LOGIN_DISMISS_KEY);
        } catch {}
        hidePill();
        loginCard.remove();
        loginCard = null;
        toolbar.style.display = '';
        refresh();
      } catch {
        err.replaceChildren('Network error — try again.');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Continue';
      }
    };
    btn.addEventListener('click', submit);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') dismissLogin();
    });
    // Explicit way out for people who are just using the preview — an icon
    // alone is easy to miss (client-team request).
    const notNow = el('button', 'login-btn secondary', 'Not now');
    notNow.addEventListener('click', dismissLogin);
    const actions = el('div', 'login-actions');
    actions.append(notNow, btn);
    card.append(nameIn, passIn, err, actions);
    loginCard.appendChild(card);
    root.appendChild(loginCard);
    (nameIn.value ? passIn : nameIn).focus();
  }

  /* ---------- media ---------- */

  const fileUrl = (rel) => apiUrl('/api/file') + (ROOM ? '&' : '?') + `p=${encodeURIComponent(rel)}`;
  // Same-origin installs load media by URL (cookie auth). Embed mode cannot
  // put a cookie or a header on an <img>, so it fetches with the bearer token
  // and shows a blob: URL — the session token never lands in a URL.
  const blobCache = new Map();
  async function mediaSrc(rel) {
    if (!EMBED) return fileUrl(rel);
    if (blobCache.has(rel)) return blobCache.get(rel);
    const r = await fetch(fileUrl(rel), { headers: authHeaders() });
    if (!r.ok) throw new Error(`file ${r.status}`);
    const u = URL.createObjectURL(await r.blob());
    blobCache.set(rel, u);
    return u;
  }
  function setImg(im, rel) {
    mediaSrc(rel).then((src) => (im.src = src)).catch(() => im.remove());
  }

  let shotLib = null;
  function loadScreenshotLib() {
    if (shotLib) return shotLib;
    shotLib = new Promise((resolve) => {
      if (window.modernScreenshot) return resolve(window.modernScreenshot);
      const sc = document.createElement('script');
      sc.src = (EMBED ? API_ORIGIN : '') + '/screenshot.js';
      sc.onload = () => resolve(window.modernScreenshot || null);
      sc.onerror = () => resolve(null);
      document.head.appendChild(sc);
    });
    return shotLib;
  }

  // Rasterize the current viewport with the pin marked, downscale, and attach it
  // to the thread. Runs after the post succeeded; any failure is silent — a
  // comment without a picture is still a comment.
  async function capturePreview(thread, point, at) {
    if (state.serverV < 2) return; // no media endpoint on this server
    try {
      // The reviewer may have moved on since the post — a picture of another
      // screen would be worse than none.
      if (at && (at.label !== screenLabel() || at.page !== currentPage())) return;
      const lib = await loadScreenshotLib();
      if (!lib) return;
      const scale = Math.min(1, 960 / innerWidth);
      const full = await Promise.race([
        lib.domToCanvas(document.documentElement, {
          scale,
          width: innerWidth,
          height: innerHeight,
          timeout: 4000,
          filter: (node) => node !== host,
          style: { transform: `translate(${-scrollX}px, ${-scrollY}px)` },
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
      ]);
      const c = document.createElement('canvas');
      c.width = Math.round(innerWidth * scale);
      c.height = Math.round(innerHeight * scale);
      const ctx = c.getContext('2d');
      ctx.drawImage(full, 0, 0, c.width, c.height);
      if (point) {
        const x = point.x * scale;
        const y = point.y * scale;
        ctx.beginPath();
        ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.fillStyle = '#3b82f6';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
      const image = c.toDataURL('image/jpeg', 0.8);
      if (image.length > 1.4e6) return; // ~1 MB of base64 — skip rather than fail the request
      await api('POST', { action: 'preview', threadId: thread.id, image });
      refresh();
    } catch {
      /* no preview */
    }
  }

  // Client-side downscale for attachments: ≤ 1600 px, JPEG.
  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; // JPEG has no alpha — transparent PNGs would turn black
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('bad image'));
      };
      img.src = url;
    });
  }

  let lightbox = null;
  function closeLightbox() {
    lightbox?.remove();
    lightbox = null;
  }
  function openLightbox(rel) {
    closeLightbox();
    lightbox = el('div', 'lightbox');
    const im = el('img');
    setImg(im, rel);
    im.alt = '';
    lightbox.appendChild(im);
    lightbox.addEventListener('click', closeLightbox);
    root.appendChild(lightbox);
  }

  let inflight = null;
  let lastSig = '';
  let legacyNoticeShown = false;
  function refresh() {
    if (!inflight) {
      inflight = (async () => {
        try {
          const data = await api('GET');
          state.role = data.role;
          state.name = data.name || '';
          state.serverV = Number(data.v) || 1;
          state.nav = data.nav || {};
          state.navAt = data.navAt || {};
          state.versions = data.versions || [];
          state.shots = data.shots || {};
          state.mapmeta = data.mapmeta || { aliases: {}, hidden: [] };
          state.threads = data.threads;
          // Re-render only on real change: a wholesale sidebar rebuild under the
          // cursor would swallow the click the reviewer is about to make.
          const sig = JSON.stringify([
            state.threads.map((t) => [
              t.id, lastAt(t), statusOf(t), t.kind, t.preview, t.n,
              t.messages.map((m) => [m.at, m.text.length, m.edited ? 1 : 0, m.reactions || 0, m.img?.length || 0]),
            ]),
            state.versions.map((v) => [v.id, v.label]),
            Object.entries(state.shots), state.mapmeta, Object.keys(state.nav).sort(),
          ]);
          if (state.serverV < 2 && !legacyNoticeShown) {
            legacyNoticeShown = true;
            toast('This comments server is older than the overlay — statuses, pictures and the map are off here', 8000);
          }
          if (sig !== lastSig) {
            lastSig = sig;
            renderAll();
            // Never rebuild the map out from under a rename in progress.
            if (state.map && !mapEl?.querySelector('.map-rename')) renderMap();
          }
          // Live-update an open thread when new replies arrive — unless the
          // viewer is mid-typing a reply.
          if (popover && state.active) {
            const t = state.threads.find((x) => x.id === state.active);
            const p = pinEls.get(state.active);
            const shown = popover.querySelectorAll('.msg').length;
            const ta = popover.querySelector('.compose textarea');
            if (t && p && shown && t.messages.length !== shown && (!ta || !ta.value.trim())) {
              openThread(t.id, p);
            }
          }
        } catch {
          /* transient network errors: keep current state */
        } finally {
          inflight = null;
        }
      })();
    }
    return inflight;
  }

  /* ---------- toast ---------- */

  let toastTimer = null;
  function toast(text, ms = 3000) {
    shadow.querySelectorAll('.toast:not(.sticky)').forEach((t) => t.remove());
    const t = el('div', 'toast', text);
    if (stickyEl) t.style.bottom = '124px'; // don't cover the sticky guide
    root.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), ms);
  }

  let stickyEl = null;
  function toastSticky(text) {
    clearSticky();
    stickyEl = el('div', 'toast sticky', text);
    root.appendChild(stickyEl);
  }
  function clearSticky() {
    stickyEl?.remove();
    stickyEl = null;
  }

  /* ---------- toolbar ---------- */

  const btnMode = el('button', 'tb-btn');
  btnMode.append(icon('comment'), el('span', 'tb-label', 'Comment'), Object.assign(el('kbd'), { textContent: 'C' }));
  btnMode.setAttribute('aria-label', 'Comment mode');
  btnMode.addEventListener('click', () => setMode(!state.mode));

  const btnThreads = el('button', 'tb-btn');
  const countBadge = el('span', 'count');
  btnThreads.append(icon('threads'), el('span', 'tb-label', 'Threads'), countBadge);
  btnThreads.setAttribute('aria-label', 'Comment threads');
  btnThreads.addEventListener('click', () => setSidebar(!state.sidebar));

  const btnMap = el('button', 'tb-btn');
  btnMap.append(icon('map'), el('span', 'tb-label', 'Map'), Object.assign(el('kbd'), { textContent: 'M' }));
  btnMap.setAttribute('aria-label', 'Map of screens');
  btnMap.addEventListener('click', () => toggleMap());

  const btnEye = el('button', 'tb-icon');
  btnEye.addEventListener('click', () => setPinsHidden(!state.pinsHidden));

  const tbAvatar = el('span', 'tb-avatar');
  const grip = el('span', 'tb-grip');
  grip.append(icon('grip'));
  grip.title = 'Drag to move · double-click to reset · H hides comments · J/K next/previous';
  toolbar.append(grip, btnMode, el('span', 'tb-divider'), btnThreads, btnMap, btnEye, tbAvatar);

  /* ---------- draggable toolbar (dodge prototype's own bars) ---------- */

  const TB_POS = 'fp_tb_pos';

  function applyTbPos() {
    let pos = null;
    try {
      pos = JSON.parse(localStorage.getItem(TB_POS) || 'null');
    } catch {
      pos = null;
    }
    if (!pos) {
      toolbar.style.left = '';
      toolbar.style.top = '';
      toolbar.style.bottom = '';
      toolbar.style.translate = '';
      return;
    }
    const r = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.min(Math.max(pos.x, 8), Math.max(8, innerWidth - r.width - 8))}px`;
    toolbar.style.top = `${Math.min(Math.max(pos.y, 8), Math.max(8, innerHeight - r.height - 8))}px`;
    toolbar.style.bottom = 'auto';
    toolbar.style.translate = 'none';
  }

  let tbDrag = null;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = toolbar.getBoundingClientRect();
    tbDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    grip.setPointerCapture(e.pointerId);
    toolbar.classList.add('dragging');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!tbDrag) return;
    const r = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.min(Math.max(e.clientX - tbDrag.dx, 8), innerWidth - r.width - 8)}px`;
    toolbar.style.top = `${Math.min(Math.max(e.clientY - tbDrag.dy, 8), innerHeight - r.height - 8)}px`;
    toolbar.style.bottom = 'auto';
    toolbar.style.translate = 'none';
  });
  const endTbDrag = () => {
    if (!tbDrag) return;
    tbDrag = null;
    toolbar.classList.remove('dragging');
    const r = toolbar.getBoundingClientRect();
    localStorage.setItem(TB_POS, JSON.stringify({ x: r.left, y: r.top }));
  };
  grip.addEventListener('pointerup', endTbDrag);
  grip.addEventListener('pointercancel', endTbDrag);
  grip.addEventListener('dblclick', () => {
    localStorage.removeItem(TB_POS);
    applyTbPos();
    toast('Toolbar back to its default spot');
  });
  window.addEventListener('resize', applyTbPos);

  function setPinsHidden(hidden) {
    state.pinsHidden = hidden;
    localStorage.setItem('fp_pins_hidden', hidden ? '1' : '0');
    pinsLayer.style.display = hidden ? 'none' : '';
    if (hidden) closePopover();
    renderToolbar();
  }

  function renderToolbar() {
    btnMode.classList.toggle('on', state.mode);
    const open = state.threads.filter((t) => !t.resolved).length;
    const fresh = state.threads.filter(isNew).length;
    if (fresh && withinNewWindow()) {
      countBadge.textContent = `${fresh} new`;
      countBadge.classList.add('new-badge');
    } else {
      countBadge.textContent = open ? String(open) : '';
      countBadge.classList.remove('new-badge');
    }
    btnThreads.classList.toggle('has-unread', state.threads.some(isUnread));
    btnEye.replaceChildren(icon(state.pinsHidden ? 'eyeOff' : 'eye'));
    btnEye.title = state.pinsHidden ? 'Show comment pins' : 'Hide comment pins';
    btnEye.setAttribute('aria-label', btnEye.title);
    btnEye.classList.toggle('dim', state.pinsHidden);
    tbAvatar.replaceChildren(avatar(state.role ? myLabel() : '?', 28));
    tbAvatar.title = `Signed in as ${state.role ? `${myLabel()} (${roleLabel()})` : '…'}`;
  }

  /* ---------- pins ---------- */

  const pinEls = new Map();

  // Status filter (Open/Resolved) + designer's role filter. Pins, sidebar and
  // J/K all read the same set.
  function threadsInView() {
    return state.threads.filter(
      (t) =>
        (state.filter === 'all' ||
          (state.filter === 'active' ? !isResolvedStatus(statusOf(t)) : statusOf(t) === state.filter)) &&
        (state.roleFilter === 'all' ||
          (state.roleFilter === 'client' ? t.authorRole === 'client' : t.authorRole === 'designer')) &&
        (!state.versionFilter || t.proto === state.versionFilter)
    );
  }
  // Every thread in view gets a pin element; positionPins() shows it only
  // when it belongs to the current screen.
  const visiblePins = () => threadsInView();

  function sortThreads(list) {
    const arr = list.slice();
    if (state.sort === 'oldest') return arr.sort((a, b) => (a.n || 0) - (b.n || 0));
    if (state.sort === 'unread') return arr.sort((a, b) => isUnread(b) - isUnread(a) || lastAt(b) - lastAt(a));
    return arr.sort((a, b) => lastAt(b) - lastAt(a)); // newest (also inside "by screen" groups)
  }

  // Is the comment's container currently rendered? Then nothing needs
  // reopening — a missing anchor falls back to the approximate pin (v1 rule).
  function containerOpen(t) {
    const c = t.anchor?.container;
    if (!c?.path) return false;
    try {
      const n = document.querySelector(c.path);
      return Boolean(n && !n.hidden && n.getClientRects().length);
    } catch {
      return false;
    }
  }

  // The last trail click is the trigger that opened the commented state.
  function triggerOf(t) {
    const step = t.trail?.at(-1);
    if (!step) return null;
    const loc = locateAnchor(step.anchor);
    return loc.el ? loc : null;
  }

  function renderPins() {
    pinsLayer.replaceChildren();
    pinEls.clear();
    for (const t of visiblePins()) {
      const label = Number.isInteger(t.n) ? String(t.n) : t.author.charAt(0).toUpperCase();
      const p = el('button', 'pin' + (t.resolved ? ' resolved' : ''), label);
      p.style.background = pastel(t.author);
      if (isUnread(t)) p.appendChild(el('span', 'pin-dot'));
      if (t.id === state.active) p.classList.add('active');
      p.setAttribute('aria-label', `Comment ${numLabel(t)} by ${t.author}`.replace('  ', ' '));
      p.addEventListener('click', (e) => {
        e.stopPropagation();
        if (p.classList.contains('ghost')) goTo(t); // reopen the state, then show the real pin
        else openThread(t.id, p);
      });
      pinsLayer.appendChild(p);
      pinEls.set(t.id, p);
    }
    positionPins();
  }

  function positionPins() {
    const ghosts = new Map(); // trigger position → [pin]
    for (const [id, p] of pinEls) {
      const t = state.threads.find((x) => x.id === id);
      p.querySelector('.pin-stack')?.remove();
      if (!t || !onThisScreen(t)) {
        p.style.display = 'none';
        continue;
      }
      // 1. real: the anchored element is here. 2. ghost: it lives in a closed
      // container and the trigger is here. 3. hidden: container, no trigger.
      // 4. approximate: no container → stored document fraction (v1 rule).
      let pos = resolveAnchor(t.anchor);
      let ghost = false;
      if (!pos) {
        if (t.anchor?.container && !containerOpen(t)) {
          const trig = triggerOf(t);
          pos = trig?.pos || null;
          ghost = Boolean(pos);
        } else {
          pos = fracPos(t.anchor);
        }
      }
      if (!pos) {
        p.style.display = 'none';
        continue;
      }
      p.classList.toggle('ghost', ghost);
      if (ghost) p.setAttribute('aria-label', `Comment ${numLabel(t)} by ${t.author} — inside a closed ${t.anchor.container.name || 'menu'}; click to open it`);
      p.style.background = ghost ? '' : pastel(t.author);
      const off = pos.x < -40 || pos.y < -40 || pos.x > innerWidth + 40 || pos.y > innerHeight + 40;
      p.style.display = off ? 'none' : '';
      p.style.left = `${pos.x}px`;
      p.style.top = `${pos.y}px`;
      if (ghost && !off) {
        const key = `${Math.round(pos.x)},${Math.round(pos.y)}`;
        if (!ghosts.has(key)) ghosts.set(key, []);
        ghosts.get(key).push(p);
      }
    }
    // Several comments behind one trigger → one ghost with a count.
    for (const pins of ghosts.values()) {
      if (pins.length < 2) continue;
      pins.slice(1).forEach((x) => (x.style.display = 'none'));
      pins[0].appendChild(el('span', 'pin-stack', String(pins.length)));
    }
    if (state.draft && draftPin) {
      draftPin.style.left = `${state.draft.x}px`;
      draftPin.style.top = `${state.draft.y}px`;
    }
  }

  /* ---------- popover ---------- */

  function closePopover() {
    closeStatusMenu();
    popover?.remove();
    popover = null;
    state.active = null;
    state.confirmDelete = null;
    shadow.querySelectorAll('.pin.active').forEach((p) => p.classList.remove('active'));
  }

  let draftPin = null;

  function cancelDraft() {
    state.draft = null;
    draftPin?.remove();
    draftPin = null;
    closePopover();
  }

  let lastPopAnchor = null;

  function placePopover(x, y) {
    lastPopAnchor = { x, y };
    // Visual viewport shrinks when the mobile keyboard opens; clamp to it so
    // the composer never hides behind the keyboard.
    // documentElement.clientWidth excludes the scrollbar — the same box the CSS
    // `100vw` term does not, which used to let a right-edge popover overhang.
    const vw = Math.min(document.documentElement.clientWidth || innerWidth, window.visualViewport ? window.visualViewport.width : innerWidth);
    const vh = window.visualViewport ? window.visualViewport.height : innerHeight;
    const w = Math.min(340, vw - 24);
    const h = Math.min(popover.offsetHeight || 200, vh - 24);
    let px = x + 20;
    let py = y - 8;
    if (px + w > vw - 12) px = Math.max(12, x - w - 20);
    if (px < 12) px = 12;
    if (py + h > vh - 12) py = Math.max(12, vh - h - 12);
    if (py < 12) py = 12;
    popover.style.left = `${px}px`;
    popover.style.top = `${py}px`;
  }

  window.visualViewport?.addEventListener('resize', () => {
    if (popover && lastPopAnchor) placePopover(lastPopAnchor.x, lastPopAnchor.y);
  });

  function composeRow({ placeholder, onSubmit, bordered }) {
    const row = el('div', 'compose' + (bordered ? ' bordered' : ''));
    const ta = el('textarea');
    ta.placeholder = placeholder;
    ta.rows = 1;
    const send = el('button', 'send');
    send.append(icon('send'));
    send.disabled = true;
    send.setAttribute('aria-label', 'Post comment');
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
      send.disabled = !ta.value.trim();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (ta.value.trim()) onSubmit();
      }
    });
    send.addEventListener('click', onSubmit);

    // Attachments: paperclip button, paste, drop. Kept as data URLs until send.
    const pending = [];
    const input = el('input', 'attach-input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    const strip = el('div', 'attach-strip');
    const attachBtn = el('button', 'attach-btn');
    attachBtn.type = 'button';
    attachBtn.append(icon('paperclip'));
    attachBtn.title = 'Attach an image';
    attachBtn.setAttribute('aria-label', 'Attach an image');
    attachBtn.addEventListener('click', () => input.click());
    const renderStrip = () => {
      strip.replaceChildren();
      strip.hidden = !pending.length;
      pending.forEach((src, i) => {
        const th = el('div', 'thumb');
        const im = el('img');
        im.src = src;
        im.alt = `Attachment ${i + 1}`;
        const rm = el('button', null, '×');
        rm.type = 'button';
        rm.setAttribute('aria-label', 'Remove attachment');
        rm.addEventListener('click', () => {
          pending.splice(i, 1);
          renderStrip();
        });
        th.append(im, rm);
        strip.appendChild(th);
      });
    };
    const addFiles = async (files) => {
      for (const f of [...files].filter((x) => x && x.type.startsWith('image/'))) {
        if (pending.length >= 3) {
          toast('Up to 3 images per message');
          break;
        }
        try {
          const src = await shrinkImage(f);
          if (src.length > 2e6) {
            toast('That image is too large (1.5 MB max)');
            continue;
          }
          const total = pending.reduce((n, x) => n + x.length, 0) + src.length;
          if (total > 3e6) {
            toast('Images too large — try fewer or smaller');
            break;
          }
          pending.push(src);
        } catch {
          toast('That file isn’t an image');
        }
      }
      renderStrip();
    };
    input.addEventListener('change', () => {
      addFiles(input.files);
      input.value = '';
    });
    ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.items || [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      row.classList.add('dragging');
    });
    row.addEventListener('dragleave', () => row.classList.remove('dragging'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('dragging');
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
    });
    strip.hidden = true;
    row.append(ta, attachBtn, send, input);
    const wrap = el('div', 'compose-wrap');
    wrap.append(strip, row);
    return { row: wrap, ta, send, images: () => pending.slice() };
  }

  function openComposer() {
    closePopover();
    popover = el('div', 'popover');

    const { row, ta, send, images } = composeRow({
      placeholder: 'Add a comment',
      onSubmit: async () => {
        const text = ta.value.trim();
        if (!text) return;
        send.disabled = true;
        try {
          const point = { x: state.draft.x, y: state.draft.y };
          const { thread } = await api('POST', {
            action: 'create',
            text,
            screen: state.draft.screen || state.screen,
            screenLabel: state.draft.screenLabel || state.screenLabel,
            anchor: state.draft.anchor,
            proto: state.proto,
            page: currentPage(),
            trail: state.draft.trail,
            kind: state.draft.kind || null,
            images: images(),
          });
          // Picture of where this was left — after the post, never blocking it.
          const at = { label: screenLabel(), page: currentPage() };
          if (window.requestIdleCallback) requestIdleCallback(() => capturePreview(thread, point, at), { timeout: 1500 });
          else setTimeout(() => capturePreview(thread, point, at), 50);
          state.draft = null;
          draftPin?.remove();
          draftPin = null;
          state.filter = 'active'; // a fresh comment is always open — make its pin visible
          await refresh();
          closePopover();
          const pin = pinEls.get(thread.id);
          if (pin) openThread(thread.id, pin);
        } catch {
          toast('Couldn’t post — try again');
          send.disabled = false;
        }
      },
    });
    // Optional kind — Bug / Question / Idea.
    const chips = el('div', 'kind-chips');
    for (const k of Object.keys(KIND_LABEL)) {
      const b = el('button', 'kind-chip', KIND_LABEL[k]);
      b.prepend(icon(KIND_ICON[k]));
      b.addEventListener('click', () => {
        state.draft.kind = state.draft.kind === k ? null : k;
        chips.querySelectorAll('.kind-chip').forEach((c) => c.classList.toggle('on', c === b && state.draft.kind === k));
        ta.focus();
      });
      chips.appendChild(b);
    }
    popover.append(chips, row);
    root.appendChild(popover);
    placePopover(state.draft.x, state.draft.y);
    ta.focus();
  }

  // Status menu: clients toggle Open/Done; designers get all four statuses,
  // a required reason for "Won't do", and the comment kind.
  let statusMenu = null;
  let statusAnchor = null;
  function closeStatusMenu() {
    statusMenu?.remove();
    statusMenu = null;
    statusAnchor = null;
  }
  async function postThread(body, okToast) {
    try {
      const draft = popover?.querySelector('.compose textarea')?.value || '';
      await api('POST', body);
      await refresh();
      const live = state.threads.find((x) => x.id === body.threadId);
      if (live) {
        openThread(live.id, pinEls.get(live.id));
        const ta = popover?.querySelector('.compose textarea');
        if (ta && draft) {
          ta.value = draft; // a half-typed reply survives a status/reaction change
          ta.dispatchEvent(new Event('input'));
        }
      }
      if (okToast) toast(okToast);
    } catch {
      toast('Couldn’t update — try again');
    }
  }
  function toggleStatusMenu(t, anchorBtn) {
    if (state.serverV < 2) return; // this server only knows resolve/reopen
    if (statusMenu) return closeStatusMenu();
    statusAnchor = anchorBtn;
    statusMenu = el('div', 'status-menu');
    statusMenu.setAttribute('role', 'menu');
    const options = state.role === 'designer' ? ['open', 'progress', 'done', 'wont'] : ['open', 'done'];
    for (const st of options) {
      const b = el('button', `s-${st}` + (statusOf(t) === st ? ' on' : ''), STATUS_LABEL[st]);
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (st === 'wont') return askWontNote(t);
        closeStatusMenu();
        postThread({ action: 'status', threadId: t.id, status: st }, `Marked as ${STATUS_LABEL[st]}`);
      });
      statusMenu.appendChild(b);
    }
    if (state.role === 'designer') {
      statusMenu.appendChild(el('div', 'menu-label', 'Kind'));
      const kinds = el('div', 'kind-row');
      for (const k of [...Object.keys(KIND_LABEL), null]) {
        const b = el('button', 'kind-chip' + (t.kind === k ? ' on' : ''), k ? KIND_LABEL[k] : 'None');
        if (k) b.prepend(icon(KIND_ICON[k]));
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          closeStatusMenu();
          postThread({ action: 'kind', threadId: t.id, kind: k });
        });
        kinds.appendChild(b);
      }
      statusMenu.appendChild(kinds);
    }
    popover.appendChild(statusMenu);
    const r = anchorBtn.getBoundingClientRect();
    const pr = popover.getBoundingClientRect();
    const vh = window.visualViewport ? window.visualViewport.height : innerHeight;
    // Open downwards unless that would push the last option off-screen.
    const below = r.bottom + statusMenu.offsetHeight + 12 <= vh;
    statusMenu.style.top = below
      ? `${r.bottom - pr.top + 6}px`
      : `${Math.max(4, r.top - pr.top - statusMenu.offsetHeight - 6)}px`;
    statusMenu.style.left = `${Math.max(8, r.left - pr.left)}px`;
  }
  function askWontNote(t) {
    statusMenu.replaceChildren(el('div', 'menu-label', 'Why won’t this be done?'));
    const wrap = el('div', 'wont-note');
    const ta = el('textarea');
    ta.placeholder = 'Short reason the client will see';
    ta.maxLength = 200;
    const save = el('button', 'wont-save', 'Save');
    save.disabled = true;
    ta.addEventListener('input', () => (save.disabled = !ta.value.trim()));
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') return closeStatusMenu();
      if (e.key === 'Enter' && !e.shiftKey && ta.value.trim()) {
        e.preventDefault();
        save.click();
      }
    });
    save.addEventListener('click', (e) => {
      e.stopPropagation();
      const note = ta.value.trim();
      if (!note) return;
      closeStatusMenu();
      postThread({ action: 'status', threadId: t.id, status: 'wont', note }, 'Marked as Won’t do');
    });
    wrap.append(ta, save);
    statusMenu.appendChild(wrap);
    ta.focus();
  }
  function sysLine(h) {
    const who = h.author;
    const text =
      h.status === 'wont'
        ? `${who || 'Marked as'} ${who ? 'won’t do this' : 'Won’t do'}${h.note ? `: ${h.note}` : ''}`
        : `${who ? `${who} marked as` : 'Marked as'} ${STATUS_LABEL[h.status] || h.status}`;
    const line = el('div', 'sys-line', text);
    line.title = new Date(h.at).toLocaleString();
    return line;
  }
  function reactionsRow(t, m) {
    const row = el('div', 'reacts');
    if (state.serverV < 2) return row; // reactions need a v2 server
    const me = myLabel();
    for (const [emoji, who] of Object.entries(m.reactions || {})) {
      const mine = who.includes(me);
      const chip = el('button', 'react-chip' + (mine ? ' mine' : ''), `${emoji} ${who.length}`);
      chip.title = who.join(', ');
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        postThread({ action: 'react', threadId: t.id, at: m.at, emoji, on: !mine });
      });
      row.appendChild(chip);
    }
    const add = el('button', 'react-add');
    add.append(icon('plus'));
    add.title = 'React';
    add.setAttribute('aria-label', 'Add a reaction');
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = row.querySelector('.react-palette');
      if (open) return open.remove();
      const pal = el('div', 'react-palette');
      for (const emoji of EMOJI) {
        const b = el('button', null, emoji);
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const mine = (m.reactions?.[emoji] || []).includes(me);
          postThread({ action: 'react', threadId: t.id, at: m.at, emoji, on: !mine });
        });
        pal.appendChild(b);
      }
      row.appendChild(pal);
    });
    row.appendChild(add);
    return row;
  }

  function openThread(id, pinEl) {
    closeStatusMenu();
    closePopover();
    const t = state.threads.find((x) => x.id === id);
    if (!t) return;
    state.active = id;
    pinEl?.classList.add('active');

    popover = el('div', 'popover');
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', `Comment by ${t.author}`);

    const head = el('div', 'head');
    const who = el('div', 'who');
    const ki = kindIcon(t);
    if (ki) who.appendChild(ki);
    who.append(el('span', 'num', numLabel(t)), avatar(t.author, 24), el('span', 'name', t.author));
    const rb = roleBadge(t);
    if (rb) who.appendChild(el('span', 'badge', rb));
    if (t.proto && state.proto && t.proto !== state.proto) {
      const v = state.versions.find((x) => x.id === t.proto);
      who.appendChild(el('span', 'badge old-version', v?.label ? `Older version · ${v.label}` : 'Older version'));
    }
    head.appendChild(who);

    const linkBtn = el('button', 'icon-btn');
    linkBtn.append(icon('link'));
    linkBtn.title = 'Copy link to comment';
    linkBtn.setAttribute('aria-label', 'Copy link to comment');
    linkBtn.addEventListener('click', async () => {
      const url = deepLinkUrl(t);
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied');
      } catch {
        toast(url, 6000);
      }
    });
    head.appendChild(linkBtn);

    const meta = el('div', 'head-meta');
    const statusBtn = el('button', `status s-${statusOf(t)}`, STATUS_LABEL[statusOf(t)]);
    statusBtn.title = 'Change status';
    statusBtn.setAttribute('aria-label', `Status: ${STATUS_LABEL[statusOf(t)]} — change`);
    statusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleStatusMenu(t, statusBtn);
    });
    meta.appendChild(statusBtn);
    if (t.anchor?.container?.name) meta.appendChild(el('span', 'in-container', `in: ${t.anchor.container.name}`));
    const ordered = threadsInView().slice().sort((a, b) => (a.n || 0) - (b.n || 0));
    const at = ordered.findIndex((x) => x.id === t.id);
    if (at >= 0) meta.appendChild(el('span', 'nav-pos', `${at + 1} of ${ordered.length}`));

    const canDelete = state.role === 'designer' || (t.authorRole === state.role && t.author === myLabel());
    if (canDelete) {
      const delBtn = el('button', 'icon-btn');
      delBtn.append(icon('trash'));
      delBtn.title = 'Delete thread';
      delBtn.setAttribute('aria-label', 'Delete thread');
      delBtn.addEventListener('click', async () => {
        if (state.confirmDelete !== t.id) {
          state.confirmDelete = t.id;
          delBtn.replaceChildren(el('span', null, 'Delete?'));
          delBtn.style.cssText = 'width:auto;padding:0 8px;color:#dc2626;font-size:12px;font-weight:500;';
          setTimeout(() => {
            if (state.confirmDelete === t.id && popover?.contains(delBtn)) {
              state.confirmDelete = null;
              delBtn.replaceChildren(icon('trash'));
              delBtn.style.cssText = '';
            }
          }, 3000);
          return;
        }
        try {
          await api('POST', { action: 'delete', threadId: t.id });
          closePopover();
          await refresh();
          toast('Comment deleted');
        } catch {
          toast('Couldn’t delete — try again');
        }
      });
      head.appendChild(delBtn);
    }

    const closeBtn = el('button', 'icon-btn');
    closeBtn.append(icon('close'));
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', closePopover);
    head.appendChild(closeBtn);
    popover.appendChild(head);
    popover.appendChild(meta);

    if (!pinEl && !onThisScreen(t)) {
      if (t.preview) {
        const pv = el('img', 'popover-preview');
        setImg(pv, t.preview);
        pv.alt = 'Where this comment is';
        pv.addEventListener('click', () => openLightbox(t.preview));
        popover.appendChild(pv);
      }
      const go = el('button', 'goto-row');
      go.append(icon('goto'), el('span', null, 'Go to comment'));
      if (t.screenLabel) go.appendChild(el('span', 'goto-screen', t.screenLabel));
      go.addEventListener('click', () => {
        closePopover();
        goTo(t);
      });
      popover.appendChild(go);
    }

    const msgs = el('div', 'messages');
    // Messages and status changes, in time order (the implicit initial "open" is not a change).
    const items = [
      ...t.messages.map((m) => ({ at: m.at, m })),
      ...(t.history || []).filter((h, i, arr) => !(i === 0 && h.status === 'open')).map((h) => ({ at: h.at, h })),
    ].sort((a, b) => a.at - b.at);
    for (const item of items) {
      if (item.h) {
        msgs.appendChild(sysLine(item.h));
        continue;
      }
      const m = item.m;
      const box = el('div', 'msg');
      const meta = el('div', 'meta');
      meta.append(
        avatar(m.author, 20),
        el('span', 'name', m.author),
        el('span', 'time', timeAgo(m.at) + (m.edited ? ' · edited' : ''))
      );
      const textEl = el('div', 'text', m.text);
      if (m.author === myLabel() && m.role === state.role) {
        const editBtn = el('button', 'icon-btn msg-edit');
        editBtn.append(icon('edit'));
        editBtn.title = 'Edit';
        editBtn.setAttribute('aria-label', 'Edit message');
        editBtn.addEventListener('click', () => {
          const ta2 = el('textarea', 'msg-editor');
          ta2.value = m.text;
          textEl.replaceWith(ta2);
          ta2.focus();
          ta2.setSelectionRange(ta2.value.length, ta2.value.length);
          const done = async () => {
            const v = ta2.value.trim();
            if (!v || v === m.text) return openThread(t.id, pinEl);
            try {
              await api('POST', { action: 'edit', threadId: t.id, at: m.at, text: v });
              await refresh();
              openThread(t.id, pinEls.get(t.id) || pinEl);
            } catch {
              toast('Couldn’t save — try again');
            }
          };
          ta2.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) {
              ev.preventDefault();
              done();
            } else if (ev.key === 'Escape') {
              ev.stopPropagation();
              openThread(t.id, pinEl);
            }
          });
          ta2.addEventListener('blur', done);
        });
        meta.appendChild(editBtn);
      }
      box.append(meta, textEl);
      if (m.img?.length) {
        const imgs = el('div', 'imgs');
        for (const rel of m.img) {
          const im = el('img');
          setImg(im, rel);
          im.loading = 'lazy';
          im.alt = 'Attachment';
          im.addEventListener('click', () => openLightbox(rel));
          imgs.appendChild(im);
        }
        box.appendChild(imgs);
      }
      box.appendChild(reactionsRow(t, m));
      msgs.appendChild(box);
    }
    popover.appendChild(msgs);

    const { row, ta, send, images } = composeRow({
      placeholder: 'Reply',
      bordered: true,
      onSubmit: async () => {
        const text = ta.value.trim();
        if (!text) return;
        send.disabled = true;
        try {
          await api('POST', { action: 'reply', threadId: t.id, text, images: images() });
          await refresh();
          openThread(t.id, pinEls.get(t.id));
        } catch {
          toast('Couldn’t reply — try again');
          send.disabled = false;
        }
      },
    });
    popover.appendChild(row);
    root.appendChild(popover);

    const pos = pinEl ? pinEl.getBoundingClientRect() : null;
    if (pos) placePopover(pos.left, pos.top);
    else placePopover(innerWidth - 680, 80);
    msgs.scrollTop = msgs.scrollHeight;

    // Opening a thread marks it read — clear the blue dots.
    if (isUnread(t)) {
      markRead([t]);
      renderToolbar();
      renderPins();
      if (state.sidebar) renderSidebar();
    }
  }

  /* ---------- sidebar ---------- */

  /* ---------- navigation graph (learned from real clicks) ---------- */

  // Every prototype click that changes the screen is recorded as an edge
  // (fromScreen --click anchor--> toScreen). "Go to comment" BFS-walks these
  // edges and replays the clicks to reach the comment's screen.
  const NAV_KEY = 'fp_nav2';

  function navMap() {
    try {
      return JSON.parse(localStorage.getItem(NAV_KEY) || '{}');
    } catch {
      return {};
    }
  }

  // Mid-transition screens can have no visible headings — screenLabel falls
  // back to document.title then. Such labels are phantom nodes: never learn
  // edges through them.
  const isFallbackLabel = (l) => l === (document.title || 'Screen');

  function saveEdge(from, to, anchor) {
    if (!from || !to || from === to || !anchor) return;
    if (isFallbackLabel(from) || isFallbackLabel(to)) return;
    const key = `${from}>${to}`;
    const m = navMap();
    const isNew = !m[key] && !state.nav[key];
    m[key] = anchor;
    const keys = Object.keys(m);
    while (keys.length > 300) delete m[keys.shift()];
    localStorage.setItem(NAV_KEY, JSON.stringify(m));
    // Share new transitions: anyone's walking teaches the graph for everyone,
    // so "Go to comment" works even on paths this browser never took.
    if (isNew) {
      state.nav[key] = anchor;
      api('POST', { action: 'edge', from, to, anchor }).catch(() => {
        delete state.nav[key];
      });
    }
  }

  let lastNavClick = null;
  // In-screen click trail: what the reviewer clicked since this screen appeared
  // (opened a menu, a dialog…). Stored on a comment so "Go to comment" can
  // reproduce the state. Reset on screen change, keeping the click that caused it.
  let trail = [];
  const trailStep = (anchor, at = Date.now()) => ({ anchor, txt: anchor.txt || null, at });
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return; // our own replays must not teach the graph or the trail
      if (e.composedPath().includes(host)) return;
      const raw = e.composedPath()[0];
      if (!(raw instanceof Element)) return;
      const target =
        raw.closest('button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"], summary, label') || raw;
      const s = (target.textContent || '').replace(/\s+/g, ' ').trim();
      const anchor = { path: buildPath(target), t: target.tagName.toLowerCase(), txt: s && s.length <= 60 ? s : null };
      // Compute the label NOW: state.screen is debounce-stale during fast
      // clicking, and a wrong `from` poisons the graph with dead edges.
      lastNavClick = { at: Date.now(), from: screenLabel(), anchor };
      trail.push(trailStep(anchor));
      if (trail.length > 8) trail.shift();
    },
    true
  );

  // One-time upload of edges this browser learned before the server graph
  // existed (or while offline) — the shared graph must not depend on luck.
  let edgeSyncDone = false;
  async function syncLocalEdges() {
    if (edgeSyncDone) return;
    edgeSyncDone = true;
    const missing = Object.entries(navMap())
      .filter(([k]) => !state.nav[k])
      .slice(0, 30);
    for (const [key, anchor] of missing) {
      const [from, to] = key.split('>');
      state.nav[key] = anchor;
      try {
        await api('POST', { action: 'edge', from, to, anchor });
      } catch {
        delete state.nav[key];
      }
    }
  }

  function findRoute(from, to, banned) {
    // Server graph wins on key collisions: it's collective and freshest,
    // while a browser's local graph may hold anchors from buggy old builds.
    const m = { ...navMap(), ...state.nav };
    const adj = {};
    for (const key of Object.keys(m)) {
      if (banned && banned.has(key)) continue;
      const [a, b] = key.split('>');
      (adj[a] ||= []).push({ to: b, anchor: m[key] });
    }
    const prev = { [from]: null };
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === to) break;
      for (const edge of adj[cur] || []) {
        if (!(edge.to in prev)) {
          prev[edge.to] = { cur, edge };
          queue.push(edge.to);
        }
      }
    }
    if (!(to in prev)) return null;
    const steps = [];
    let node = to;
    while (prev[node]) {
      steps.unshift(prev[node].edge);
      node = prev[node].cur;
    }
    return steps;
  }

  function waitForScreen(fp, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (labelsMatch(screenLabel(), fp)) {
          clearInterval(iv);
          resolve(true);
        } else if (Date.now() - t0 > timeout) {
          clearInterval(iv);
          resolve(false);
        }
      }, 200);
    });
  }

  let navigating = false;
  let bootScreen = null; // the screen the prototype always starts on

  // A thread's stored label may predate the current label algorithm — map it
  // onto an existing graph node when an equivalent one exists.
  function graphTarget(label) {
    const m = { ...navMap(), ...state.nav };
    const nodes = new Set();
    for (const k of Object.keys(m)) {
      const [a, b] = k.split('>');
      nodes.add(a);
      nodes.add(b);
    }
    if (nodes.has(label)) return label;
    for (const n of nodes) if (labelsMatch(n, label)) return n;
    return label;
  }

  // Drive the prototype hop by hop, re-planning after every step: bad edges
  // happen (recorded on old builds, mis-attributed clicks) and a single one
  // must not kill the trip — ban it and route around from wherever we are.
  // Refresh the screen label and pins right now (the mutation observer is
  // debounced by 250 ms, too slow for navigation code that checks onThisScreen).
  function syncScreen() {
    state.screen = screenLabel();
    state.screenLabel = state.screen;
    renderPins();
  }

  // Synthetic pointer sequence: many UI kits open menus on pointerdown, not click.
  function synthClick(target) {
    const r = target.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    };
    const fire = (Ctor, type, buttons) => {
      try {
        target.dispatchEvent(new Ctor(type, { ...base, buttons }));
      } catch {
        /* old engines */
      }
    };
    fire(PointerEvent, 'pointerdown', 1);
    fire(MouseEvent, 'mousedown', 1);
    fire(PointerEvent, 'pointerup', 0);
    fire(MouseEvent, 'mouseup', 0);
    target.click();
  }

  async function waitFor(pred, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return Boolean(pred());
  }

  // Reproduce the state a comment was left in by replaying its trail until the
  // anchored element appears. Stops early at the first step that cannot be found.
  async function replayTrail(t) {
    const steps = t.trail || [];
    for (let i = 0; i < steps.length; i++) {
      if (locateAnchor(t.anchor).pos) return true;
      const loc = locateAnchor(steps[i].anchor);
      if (!loc.el) continue; // a stale step must not block the ones that still resolve
      synthClick(loc.el);
      const next = steps[i + 1];
      await waitFor(() => locateAnchor(t.anchor).pos || (next && locateAnchor(next.anchor).el), 1500);
    }
    return Boolean(locateAnchor(t.anchor).pos);
  }

  // Every goTo is a trip; a newer trip cancels the stages of an older one
  // after each await (J pressed twice, a row clicked during a hash wait).
  let trip = 0;

  // On the right screen: reopen the state if needed, then open the thread.
  async function openAtState(t, my = trip) {
    cancelJump();
    if (!locateAnchor(t.anchor).pos && t.trail?.length && !containerOpen(t)) {
      toastSticky('Opening the state with this comment…');
      await replayTrail(t);
      if (my !== trip) return;
      clearSticky();
      syncScreen(); // a reopened dialog may carry its own heading
    }
    if (locateAnchor(t.anchor).pos || !t.anchor?.container || containerOpen(t)) return jumpToThread(t);
    armGuided(t, `Open “${t.anchor.container.name || 'the menu'}” — the comment will appear there · Esc to cancel`);
  }

  // One click from anywhere: other page → other screen → closed state → pin.
  async function goTo(t) {
    const my = ++trip;
    if (state.presenting) togglePresent();
    if (state.pinsHidden) setPinsHidden(false);
    setSidebar(false);
    const { path, hash } = splitPage(t.page || location.pathname);
    if ((path || '/') !== location.pathname) {
      // Another document: the deep-link boot on that page finishes the trip.
      toastSticky('Taking you to the comment…');
      location.href = deepLinkUrl(t);
      return;
    }
    if (!onThisScreen(t) && t.page && hash !== location.hash) {
      // Same document, another route: the hash is authoritative and free —
      // no need to walk the learned graph (which may not know the way back).
      toastSticky('Taking you to the comment…');
      location.hash = hash;
      await waitFor(() => onThisScreen(t) || labelsMatch(screenLabel(), t.screenLabel), 3000);
      if (my !== trip) return;
      clearSticky();
      syncScreen(); // the mutation observer is debounced; onThisScreen() must see the new label now
    }
    if (t.screenLabel && !labelsMatch(screenLabel(), t.screenLabel)) return autoNavigate(t, my);
    return openAtState(t, my);
  }

  // Walk the learned graph to a screen label with per-hop re-planning: bad
  // edges are banned and routed around. When only the boot screen knows a
  // route, teleport via reload (prototypes restart there) and let the boot
  // code finish the trip using `jump`. Returns whether the label was reached.
  let reloading = false;
  async function navigateToLabel(target, my = trip, jump = null) {
    if (navigating || reloading) return false;
    navigating = true;
    const banned = new Set();
    try {
      for (let hop = 0; hop < 12; hop++) {
        const from = screenLabel();
        if (labelsMatch(from, target)) return true;
        const route = findRoute(from, target, banned);
        if (!route || !route.length) {
          if (jump && bootScreen && !labelsMatch(bootScreen, from) && findRoute(bootScreen, target, banned)) {
            localStorage.setItem(jump.key, jump.value);
            reloading = true;
            // If the reload is refused (an unsaved-changes prompt), navigation
            // must not stay dead for the rest of the session.
            setTimeout(() => {
              reloading = false;
            }, 5000);
            location.reload();
          }
          return false;
        }
        const step = route[0];
        const loc = locateAnchor(step.anchor);
        if (!loc.el) {
          banned.add(`${from}>${step.to}`);
          continue;
        }
        synthClick(loc.el);
        const arrived = await waitForScreen(step.to, 5000);
        if (my !== trip) return false; // a newer goTo took over
        if (!arrived) banned.add(`${from}>${step.to}`);
      }
      return labelsMatch(screenLabel(), target);
    } catch {
      return false;
    } finally {
      navigating = false;
    }
  }

  async function autoNavigate(t, my = trip) {
    if (navigating || reloading) return;
    // Multi-page prototypes: the thread remembers its page — navigate there
    // directly; the deep-link boot on that page finishes the jump.
    if (!pageMatches(t.page)) {
      toastSticky('Taking you to the comment…');
      location.href = deepLinkUrl(t);
      return;
    }
    toastSticky('Taking you to the comment…');
    const target = graphTarget(t.screenLabel);
    const ok = await navigateToLabel(target, my, { key: 'fp_jump', value: t.id });
    if (my !== trip || reloading) return;
    syncScreen();
    clearSticky();
    if (ok || labelsMatch(state.screen, t.screenLabel)) openAtState(state.threads.find((x) => x.id === t.id) || t, my);
    else armGuided(t);
  }

  // Map → screen: same walk, no thread at the end.
  // One teleport per label per session: a prototype that moves on its own right
  // after boot would otherwise reload forever.
  function teleportAllowed(label) {
    try {
      const key = `fp_tp::${label}`;
      if (sessionStorage.getItem(key)) return false;
      sessionStorage.setItem(key, '1');
      return true;
    } catch {
      return true;
    }
  }

  async function goToScreen(label) {
    if (navigating || reloading) return false; // a walk is already in flight
    const my = ++trip;
    if (labelsMatch(screenLabel(), label)) return true;
    toastSticky(`Taking you to “${label}”…`);
    const jump = teleportAllowed(label) ? { key: 'fp_jump_label', value: label } : null;
    const ok = await navigateToLabel(graphTarget(label), my, jump);
    if (my !== trip || reloading) return ok;
    clearSticky();
    syncScreen();
    if (!ok) toast(`No known path to “${label}” — navigate there by hand`, 5000);
    return ok;
  }

  /* ---------- jump to a comment ---------- */

  function pulsePin(p) {
    if (!p) return;
    p.classList.add('pulse');
    setTimeout(() => p.classList.remove('pulse'), 1000);
  }

  function cancelJump() {
    state.pendingJump = null;
    clearSticky();
  }

  // Fallback when no learned route exists: the user navigates manually and
  // the comment pops open the moment its screen shows.
  function armGuided(t, message) {
    setSidebar(false);
    state.pendingJump = t.id;
    toastSticky(
      message ||
        `Navigate to “${t.screenLabel || 'the screen with this comment'}” — it will open there · Esc to cancel`
    );
    // The thread stays readable while the reviewer walks there.
    if (!popover || state.active !== t.id) openThread(t.id, null);
  }

  function jumpToThread(t) {
    if (!onThisScreen(t)) {
      armGuided(t);
      return;
    }
    cancelJump();
    const loc = locateAnchor(t.anchor);
    const pos = loc.pos || fracPos(t.anchor);
    const openAtPin = () => {
      positionPins();
      const p = pinEls.get(t.id);
      openThread(t.id, p);
      pulsePin(p);
    };
    if (!pos) return openAtPin();
    const off = pos.x < 0 || pos.y < 0 || pos.x > innerWidth || pos.y > innerHeight;
    if (off && loc.el) {
      loc.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(openAtPin, 450);
    } else if (off) {
      const de = document.documentElement;
      window.scrollTo({ top: (t.anchor?.fy ?? 0.5) * de.scrollHeight - innerHeight / 2, behavior: 'smooth' });
      setTimeout(openAtPin, 450);
    } else {
      openAtPin();
    }
  }

  function checkPendingJump() {
    if (!state.pendingJump) return;
    const t = state.threads.find((x) => x.id === state.pendingJump);
    if (!t) return cancelJump();
    if (!onThisScreen(t)) return;
    if (t.anchor?.container && !locateAnchor(t.anchor).pos && !containerOpen(t)) return; // state still closed
    jumpToThread(t);
  }

  let hoverCard = null;
  let hoverTimer = null;
  function hidePreviewCard() {
    clearTimeout(hoverTimer);
    hoverCard?.remove();
    hoverCard = null;
  }
  function showPreviewCard(t, row) {
    hidePreviewCard();
    hoverCard = el('div', 'preview-card');
    if (t.preview) {
      const im = el('img');
      setImg(im, t.preview);
      im.alt = `Screen with comment ${numLabel(t)}`.trim();
      im.addEventListener('click', (e) => {
        e.stopPropagation();
        openLightbox(t.preview);
      });
      hoverCard.appendChild(im);
    } else {
      hoverCard.appendChild(el('div', 'no-preview', t.screenLabel || 'No preview'));
    }
    const body = el('div', 'body');
    body.append(
      el('div', 'meta', [numLabel(t), t.author, t.resolved ? 'Resolved' : 'Open'].filter(Boolean).join(' · ')),
      el('div', 'text', t.messages[0]?.text || '')
    );
    hoverCard.appendChild(body);
    // The card must be reachable: leaving the row starts a short grace timer
    // that entering the card cancels.
    hoverCard.addEventListener('pointerenter', () => clearTimeout(hoverTimer));
    hoverCard.addEventListener('pointerleave', () => (hoverTimer = setTimeout(hidePreviewCard, 150)));
    root.appendChild(hoverCard);
    if (matchMedia('(pointer: coarse)').matches) return; // CSS turns it into a bottom sheet
    const r = row.getBoundingClientRect();
    const w = 300;
    hoverCard.style.left = `${Math.max(12, r.left - w - 12)}px`;
    hoverCard.style.top = `${Math.min(Math.max(12, r.top), innerHeight - 260)}px`;
  }

  function setSidebar(open) {
    if (!open) hidePreviewCard();
    state.sidebar = open;
    sidebar.classList.toggle('open', open);
    if (open) renderSidebar();
  }

  const shortVersion = (id) => String(id).replace(/^W\//, '').replace(/"/g, '').slice(0, 8);
  function renderVersions() {
    const wrap = el('div', 'versions');
    const list = state.versions.slice().sort((a, b) => b.firstSeen - a.firstSeen);
    if (!list.length) wrap.appendChild(el('div', 'sb-empty', 'No versions recorded yet — they appear as builds are opened.'));
    for (const v of list) {
      const row = el('div', 'ver-row' + (v.id === state.proto ? ' current' : ''));
      const label = el('button', 'ver-label', v.label || shortVersion(v.id));
      label.title = state.role === 'designer' ? 'Click to name this version' : v.id;
      if (state.role === 'designer') {
        label.addEventListener('click', () => {
          const input = el('input', 'ver-input');
          input.value = v.label || '';
          input.placeholder = 'Version name';
          input.maxLength = 60;
          label.replaceWith(input);
          input.focus();
          let closed = false; // Enter and the blur it causes must post once; Escape must not post
          const done = async () => {
            if (closed) return;
            closed = true;
            const val = input.value.trim();
            if (val === (v.label || '')) return renderSidebar();
            try {
              await api('POST', { action: 'version-label', id: v.id, label: val });
              await refresh();
            } catch {
              toast('Couldn’t save — try again');
            }
            renderSidebar();
          };
          input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') done();
            if (e.key === 'Escape') {
              closed = true;
              renderSidebar();
            }
          });
          input.addEventListener('blur', done);
        });
      }
      const count = state.threads.filter((t) => t.proto === v.id).length;
      const meta = el('div', 'ver-meta', `${new Date(v.firstSeen).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${count} ${count === 1 ? 'comment' : 'comments'}${v.id === state.proto ? ' · current' : ''}`);
      const use = el('button', 'ver-use', 'Show comments');
      use.addEventListener('click', () => {
        state.versionFilter = v.id;
        state.showVersions = false;
        state.filter = 'all';
        renderSidebar();
        renderPins();
      });
      row.append(label, meta, use);
      wrap.appendChild(row);
    }
    return wrap;
  }

  function renderSidebar() {
    sidebar.replaceChildren();

    const head = el('div', 'sb-head');
    head.appendChild(el('h2', null, state.showVersions ? 'Versions' : 'Comments'));
    const verBtn = el('button', 'icon-btn sb-versions' + (state.showVersions ? ' on' : ''));
    verBtn.append(icon('history'));
    verBtn.title = state.showVersions ? 'Back to comments' : 'Prototype versions';
    verBtn.setAttribute('aria-label', verBtn.title);
    verBtn.addEventListener('click', async () => {
      if (!state.showVersions) await refresh(); // labels may have changed since the last poll
      state.showVersions = !state.showVersions;
      renderSidebar();
    });
    head.appendChild(verBtn);
    if (state.showVersions) {
      const closeV = el('button', 'icon-btn');
      closeV.append(icon('close'));
      closeV.setAttribute('aria-label', 'Close');
      closeV.addEventListener('click', () => setSidebar(false));
      head.append(closeV);
      sidebar.appendChild(head);
      sidebar.appendChild(renderVersions());
      return;
    }
    if (state.threads.some(isUnread)) {
      const mark = el('button', 'mark-read', 'Mark all read');
      mark.addEventListener('click', () => {
        markRead(state.threads);
        renderAll();
      });
      head.appendChild(mark);
    }
    const closeBtn = el('button', 'icon-btn');
    closeBtn.append(icon('close'));
    closeBtn.setAttribute('aria-label', 'Close comments');
    closeBtn.addEventListener('click', () => setSidebar(false));
    head.appendChild(closeBtn);
    sidebar.appendChild(head);

    const controls = el('div', 'sb-controls');
    const seg = el('div', 'seg status-seg');
    const SEG = { active: 'Active', progress: 'Progress', done: 'Done', wont: 'Won’t do', all: 'All' };
    for (const f of ['active', 'progress', 'done', 'wont', 'all']) {
      const b = el('button', state.filter === f ? 'on' : '', SEG[f]);
      b.title = f === 'active' ? 'Open and in progress' : f === 'all' ? 'All statuses' : STATUS_LABEL[f];
      b.addEventListener('click', () => {
        state.filter = f;
        renderSidebar();
        renderPins();
      });
      seg.appendChild(b);
    }
    const sort = el('select', 'sort');
    sort.setAttribute('aria-label', 'Sort comments');
    for (const [v, label] of [['newest', 'Newest'], ['oldest', 'Oldest'], ['unread', 'Unread first'], ['screen', 'By screen']]) {
      const o = el('option', null, label);
      o.value = v;
      o.selected = state.sort === v;
      sort.appendChild(o);
    }
    sort.addEventListener('change', () => {
      state.sort = sort.value;
      localStorage.setItem('fp_sort', state.sort);
      renderSidebar();
    });
    controls.append(seg);
    sidebar.appendChild(controls);
    const row2 = el('div', 'sb-row2');
    sidebar.appendChild(row2);

    if (state.role === 'designer') {
      const chips = el('div', 'chips');
      for (const [v, label] of [['all', 'All'], ['client', 'Client'], ['team', 'Team']]) {
        const c = el('button', 'chip' + (state.roleFilter === v ? ' on' : ''), label);
        c.addEventListener('click', () => {
          state.roleFilter = v;
          renderSidebar();
          renderPins();
        });
        chips.appendChild(c);
      }
      row2.appendChild(chips);
    }
    row2.appendChild(sort);

    const list = el('div', 'sb-list');
    if (state.versionFilter) {
      const v = state.versions.find((x) => x.id === state.versionFilter);
      const chip = el('button', 'filter-chip', `Version: ${v?.label || shortVersion(state.versionFilter)} ×`);
      chip.addEventListener('click', () => {
        state.versionFilter = null;
        renderSidebar();
        renderPins();
      });
      list.appendChild(chip);
    }
    const match = threadsInView();
    const fresh = match.filter(isNew);
    const screens = withinNewWindow() ? newScreens() : [];
    if ((fresh.length || screens.length) && withinNewWindow()) {
      list.appendChild(el('div', 'sb-group', 'New for you'));
      if (screens.length) list.appendChild(el('div', 'sb-note', `New screens: ${screens.join(', ')}`));
    }

    const addRows = (items, label) => {
      if (!items.length) return;
      if (label) list.appendChild(el('div', 'sb-group', label));
      for (const t of sortThreads(items)) {
        const row = el('button', 'sb-row' + (t.resolved ? ' resolved' : '') + (isUnread(t) ? ' unread' : '') + (isNew(t) ? ' new' : ''));
        const meta = el('div', 'meta');
        const ki = kindIcon(t);
        if (ki) meta.appendChild(ki);
        meta.append(el('span', 'num', numLabel(t)), avatar(t.author, 24), el('span', 'name', t.author));
        const st = statusOf(t);
        if (st !== 'open') meta.appendChild(el('span', `status-tag s-${st}`, STATUS_LABEL[st]));
        const rb = roleBadge(t);
        if (rb) meta.appendChild(el('span', 'badge', rb));
        if (t.resolved) {
          const c = el('span', 'check-ico');
          c.append(icon('check'));
          meta.appendChild(c);
        }
        meta.appendChild(el('span', 'time', timeAgo(lastAt(t))));
        if (isUnread(t)) meta.appendChild(el('span', 'row-dot'));
        row.appendChild(meta);
        row.appendChild(el('div', 'excerpt', t.messages[0]?.text || ''));
        const extras = [];
        if (t.messages.length > 1) extras.push(`${t.messages.length - 1} ${t.messages.length === 2 ? 'reply' : 'replies'}`);
        if (t.anchor?.container?.name) extras.push(`in: ${t.anchor.container.name}`);
        if (extras.length) row.appendChild(el('div', 'replies', extras.join(' · ')));
        row.addEventListener('click', () => goTo(t));
        // Desktop: hover shows the preview card; touch: an eye button does.
        row.addEventListener('pointerenter', () => {
          if (matchMedia('(pointer: coarse)').matches) return;
          clearTimeout(hoverTimer);
          hoverTimer = setTimeout(() => showPreviewCard(t, row), 350);
        });
        row.addEventListener('pointerleave', () => {
          clearTimeout(hoverTimer);
          hoverTimer = setTimeout(hidePreviewCard, 150);
        });
        // Touch: an eye control (a span — buttons can't nest) toggles the card.
        const eye = el('span', 'eye');
        eye.setAttribute('role', 'button');
        eye.tabIndex = 0;
        eye.append(icon('eyeSmall'));
        eye.setAttribute('aria-label', 'Preview');
        const toggleCard = (e) => {
          e.stopPropagation();
          if (hoverCard?.dataset.for === t.id) hidePreviewCard();
          else {
            showPreviewCard(t, row);
            hoverCard.dataset.for = t.id;
          }
        };
        eye.addEventListener('click', toggleCard);
        eye.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') toggleCard(e);
        });
        meta.appendChild(eye);
        list.appendChild(row);
      }
    };

    if (fresh.length && withinNewWindow()) {
      // "New for you" first (its group label was added above), then everything else.
      for (const t of sortThreads(fresh)) addRows([t], null);
      const rest = match.filter((t) => !isNew(t));
      if (state.sort === 'screen') {
        addRows(rest.filter(onThisScreen), 'On this screen');
        addRows(rest.filter((t) => !onThisScreen(t)), 'Other screens');
      } else {
        addRows(rest, rest.length ? 'Everything else' : null);
      }
    } else if (state.sort === 'screen') {
      addRows(match.filter(onThisScreen), 'On this screen');
      addRows(match.filter((t) => !onThisScreen(t)), 'Other screens');
    } else {
      addRows(match, null);
    }

    if (!match.length) {
      list.appendChild(
        el(
          'div',
          'sb-empty',
          state.filter === 'open'
            ? matchMedia('(pointer: coarse)').matches
              ? 'No open comments yet. Tap Comment, then tap anywhere on the prototype to leave the first one.'
              : 'No open comments yet. Press C, then click anywhere on the prototype to leave the first one.'
            : 'Nothing resolved yet.'
        )
      );
    }
    sidebar.appendChild(list);

    const foot = el('div', 'sb-foot');
    foot.appendChild(el('span', 'me', `Signed in as ${myLabel()} · ${roleLabel()}`));
    const out = el('a', null, 'Sign out');
    if (EMBED) {
      out.href = '#';
      out.addEventListener('click', (e) => {
        e.preventDefault();
        localStorage.removeItem(TOKEN_KEY);
        location.reload();
      });
    } else {
      out.href = '/api/logout';
    }
    foot.appendChild(out);
    sidebar.appendChild(foot);
  }

  /* ---------- map of screens (M) ---------- */

  // Structure = the learned navigation graph; pictures = shots (crawler or the
  // first preview on a screen). Layout: BFS layers from the boot screen.
  let mapEl = null;
  const mapView = { x: 40, y: 40, k: 1 };
  let showHiddenNodes = false;
  const NODE_W = 240;
  const NODE_H = 196;
  const COL = 320;
  const ROW = 226;

  function mapModel() {
    const hidden = new Set(state.mapmeta?.hidden || []);
    const alias = state.mapmeta?.aliases || {};
    const nodes = new Set();
    const edges = [];
    for (const [key, anchor] of Object.entries(state.nav)) {
      const [a, b] = key.split('>');
      if (!a || !b || isFallbackLabel(a) || isFallbackLabel(b)) continue;
      nodes.add(a);
      nodes.add(b);
      edges.push({ from: a, to: b, txt: anchor?.txt || '' });
    }
    for (const t of state.threads) if (t.screenLabel && !isFallbackLabel(t.screenLabel)) nodes.add(t.screenLabel);
    for (const l of Object.keys(state.shots || {})) if (!isFallbackLabel(l)) nodes.add(l);
    const all = [...nodes];
    const start = bootScreen && nodes.has(bootScreen) ? bootScreen : all[0];
    const depth = new Map(start ? [[start, 0]] : []);
    const q = start ? [start] : [];
    while (q.length) {
      const c = q.shift();
      for (const e of edges) {
        if (e.from === c && !depth.has(e.to)) {
          depth.set(e.to, depth.get(c) + 1);
          q.push(e.to);
        }
      }
    }
    const maxD = Math.max(0, ...depth.values());
    const visible = all.filter((n) => !hidden.has(n));
    const list = visible.map((label) => ({
      label,
      name: alias[label] || label,
      d: depth.has(label) ? depth.get(label) : maxD + 1,
      shot: (state.shots || {})[label] || null,
      open: state.threads.filter((t) => t.screenLabel === label && !t.resolved).length,
      total: state.threads.filter((t) => t.screenLabel === label).length,
      current: labelsMatch(label, state.screen),
    }));
    const cols = new Map();
    for (const n of list.sort((a, b) => a.d - b.d || a.label.localeCompare(b.label))) {
      if (!cols.has(n.d)) cols.set(n.d, []);
      n.row = cols.get(n.d).length;
      cols.get(n.d).push(n);
      n.x = n.d * COL;
      n.y = n.row * ROW;
    }
    return { nodes: list, edges: edges.filter((e) => !hidden.has(e.from) && !hidden.has(e.to)), hidden: [...hidden] };
  }

  function toggleMap() {
    if (state.map) closeMap();
    else openMap();
  }
  function closeMap() {
    mapEl?.remove();
    mapEl = null;
    state.map = false;
  }
  function openMap() {
    if (state.serverV < 2) return toast('The map needs a newer comments server', 5000);
    if (state.presenting) togglePresent();
    closePopover();
    setSidebar(false);
    state.map = true;
    mapEl = el('div', 'map');
    mapEl.setAttribute('role', 'dialog');
    mapEl.setAttribute('aria-label', 'Map of screens');
    root.appendChild(mapEl);
    renderMap(true);
  }

  async function postMapMeta(body) {
    try {
      await api('POST', { action: 'mapmeta', ...body });
      await refresh();
      renderMap();
    } catch {
      toast('Couldn’t save — try again');
    }
  }

  function renderMap(fit = false) {
    if (!mapEl) return;
    const model = mapModel();
    mapEl.replaceChildren();

    const bar = el('div', 'map-toolbar');
    bar.append(el('strong', null, 'Map'), el('span', 'map-count', `${model.nodes.length} ${model.nodes.length === 1 ? 'screen' : 'screens'}`));
    const fitBtn = el('button', 'map-btn', 'Fit');
    fitBtn.addEventListener('click', () => renderMap(true));
    bar.appendChild(fitBtn);
    if (state.role === 'designer' && model.hidden.length) {
      const hid = el('button', 'map-btn map-hidden-toggle', `${showHiddenNodes ? 'Hide' : 'Show'} hidden (${model.hidden.length})`);
      hid.addEventListener('click', () => {
        showHiddenNodes = !showHiddenNodes;
        renderMap();
      });
      bar.appendChild(hid);
    }
    const close = el('button', 'icon-btn map-close');
    close.append(icon('close'));
    close.setAttribute('aria-label', 'Close map');
    close.addEventListener('click', closeMap);
    bar.appendChild(close);
    mapEl.appendChild(bar);

    if (state.role === 'designer' && showHiddenNodes && model.hidden.length) {
      const list = el('div', 'map-hidden');
      list.append(el('span', null, 'Hidden:'));
      for (const l of model.hidden) {
        const b = el('button', null, `${state.mapmeta?.aliases?.[l] || l} — show`);
        b.addEventListener('click', () => postMapMeta({ show: l }));
        list.appendChild(b);
      }
      mapEl.appendChild(list);
    }

    const viewport = el('div', 'map-viewport');
    const canvas = el('div', 'map-canvas');
    viewport.appendChild(canvas);
    mapEl.appendChild(viewport);

    if (!model.nodes.length) {
      canvas.appendChild(el('div', 'map-empty', 'No screens yet — the map fills in as people click around, or all at once with scripts/crawl.mjs.'));
    }

    const W = Math.max(0, ...model.nodes.map((n) => n.x + NODE_W));
    const H = Math.max(0, ...model.nodes.map((n) => n.y + NODE_H));
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'map-edges');
    svg.setAttribute('width', String(W + 40));
    svg.setAttribute('height', String(H + 100)); // room for the labels under back-edges
    const defs = document.createElementNS(svgNS, 'defs');
    defs.innerHTML =
      '<marker id="fp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker>';
    svg.appendChild(defs);
    const byLabel = new Map(model.nodes.map((n) => [n.label, n]));
    // Two edges that loop back under the same nodes get the same midpoint, and
    // their labels used to print on top of each other — unreadable, and it
    // looked like one corrupted word. Keep what has been placed and step down.
    const placed = [];
    const shift = (x, y, w) => {
      let out = y;
      for (let i = 0; i < 8; i++) {
        const hit = placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 && Math.abs(p.y - out) < 14);
        if (!hit) break;
        out += 15;
      }
      placed.push({ x, y: out, w });
      return out;
    };
    for (const e of model.edges) {
      const a = byLabel.get(e.from);
      const b = byLabel.get(e.to);
      if (!a || !b) continue;
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2 - 20;
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2 - 20;
      const back = x2 <= x1; // edge to an earlier layer: loop under the nodes
      const d = back
        ? `M${x1 - NODE_W / 2} ${a.y + NODE_H} C ${x1 - NODE_W / 2} ${a.y + NODE_H + 60}, ${x2 + NODE_W / 2} ${b.y + NODE_H + 60}, ${x2 + NODE_W / 2} ${b.y + NODE_H}`
        : `M${x1} ${y1} C ${x1 + (x2 - x1) / 2} ${y1}, ${x1 + (x2 - x1) / 2} ${y2}, ${x2} ${y2}`;
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('class', 'map-edge');
      path.setAttribute('d', d);
      path.setAttribute('marker-end', 'url(#fp-arrow)');
      svg.appendChild(path);
      if (e.txt) {
        const text = document.createElementNS(svgNS, 'text');
        text.setAttribute('class', 'map-edge-label');
        const label = e.txt.length > 24 ? `${e.txt.slice(0, 23)}…` : e.txt;
        const lx = back ? (x1 + x2) / 2 : x1 + (x2 - x1) / 2;
        const ly = back ? Math.max(a.y, b.y) + NODE_H + 52 : (y1 + y2) / 2 - 6;
        text.setAttribute('x', String(lx));
        text.setAttribute('y', String(shift(lx, ly, label.length * 6.2)));
        text.setAttribute('text-anchor', 'middle');
        text.textContent = label;
        svg.appendChild(text);
      }
    }
    canvas.appendChild(svg);

    for (const n of model.nodes) {
      const card = el('div', 'map-node' + (n.current ? ' current' : ''));
      card.style.left = `${n.x}px`;
      card.style.top = `${n.y}px`;
      card.dataset.label = n.label;
      const thumb = el('button', 'map-thumb');
      thumb.setAttribute('aria-label', `Go to ${n.name}`);
      if (n.shot) {
        const im = el('img');
        setImg(im, n.shot);
        im.alt = '';
        thumb.appendChild(im);
      } else {
        thumb.appendChild(el('div', 'map-placeholder', 'No shot yet'));
      }
      thumb.addEventListener('click', () => {
        closeMap();
        goToScreen(n.label);
      });
      const name = el('div', 'map-name', n.name);
      name.title = n.label === n.name ? n.label : `${n.name} (${n.label})`;
      if (state.role === 'designer') {
        name.addEventListener('dblclick', () => {
          const input = el('input', 'map-rename');
          input.value = n.name === n.label ? '' : n.name;
          input.placeholder = n.label;
          input.maxLength = 60;
          name.replaceWith(input);
          input.focus();
          let closed = false;
          const done = () => {
            if (closed) return;
            closed = true;
            const val = input.value.trim();
            if (val === (state.mapmeta?.aliases?.[n.label] || '')) return renderMap();
            postMapMeta({ alias: { label: n.label, name: val } });
          };
          input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') done();
            if (e.key === 'Escape') {
              closed = true;
              renderMap();
            }
          });
          input.addEventListener('blur', done);
        });
      }
      const count = el('div', 'map-countline', n.total ? `${n.open} open · ${n.total} total` : 'No comments');
      card.append(thumb, name, count);
      if (state.role === 'designer') {
        const hide = el('button', 'map-hide');
        hide.append(icon('close'));
        hide.title = 'Hide this screen from the map';
        hide.setAttribute('aria-label', hide.title);
        hide.addEventListener('click', (e) => {
          e.stopPropagation();
          postMapMeta({ hide: n.label });
        });
        card.appendChild(hide);
      }
      canvas.appendChild(card);
    }

    // Pan (drag the background) and zoom (wheel), fit on open.
    const apply = () => (canvas.style.transform = `translate(${mapView.x}px, ${mapView.y}px) scale(${mapView.k})`);
    if (fit) {
      const vw = mapEl.clientWidth || innerWidth;
      const vh = (mapEl.clientHeight || innerHeight) - 56;
      // 0.3 is the wheel's floor: fitting past it would strand the view.
      mapView.k = Math.max(0.3, Math.min(1, (vw - 80) / Math.max(1, W), (vh - 80) / Math.max(1, H)));
      mapView.x = Math.max(24, (vw - W * mapView.k) / 2);
      mapView.y = Math.max(24, (vh - H * mapView.k) / 2);
    }
    apply();
    let drag = null;
    viewport.addEventListener('pointerdown', (e) => {
      // Drag only on the background (or the edge layer) — never on a node or a button icon.
      const t = e.target;
      const onBackground = t === viewport || t === canvas || (t instanceof SVGElement && t.closest('.map-edges'));
      if (!onBackground) return;
      drag = { x: e.clientX - mapView.x, y: e.clientY - mapView.y };
      viewport.setPointerCapture(e.pointerId);
    });
    viewport.addEventListener('pointermove', (e) => {
      if (!drag) return;
      mapView.x = e.clientX - drag.x;
      mapView.y = e.clientY - drag.y;
      apply();
    });
    const endDrag = () => (drag = null);
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    viewport.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const k = Math.min(2, Math.max(0.3, mapView.k * (e.deltaY < 0 ? 1.1 : 0.9)));
        const r = viewport.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        mapView.x = px - ((px - mapView.x) * k) / mapView.k;
        mapView.y = py - ((py - mapView.y) * k) / mapView.k;
        mapView.k = k;
        apply();
      },
      { passive: false }
    );
  }

  /* ---------- comment mode ---------- */

  function setMode(on) {
    if (on && state.presenting) togglePresent();
    state.mode = on;
    clickLayer.hidden = !on;
    if (on && state.pinsHidden) setPinsHidden(false);
    renderToolbar();
    if (on) closePopover();
  }

  clickLayer.addEventListener('click', (e) => {
    const anchor = buildAnchor(e.clientX, e.clientY);
    cancelDraft();
    state.screen = screenLabel();
    state.screenLabel = screenLabel();
    state.draft = {
      x: e.clientX,
      y: e.clientY,
      anchor,
      screen: state.screen,
      screenLabel: state.screenLabel,
      trail: anchor.container ? trail.slice() : [],
    };
    draftPin = el('button', 'pin draft', '+');
    draftPin.style.left = `${e.clientX}px`;
    draftPin.style.top = `${e.clientY}px`;
    draftPin.addEventListener('click', (ev) => {
      ev.stopPropagation();
      cancelDraft();
    });
    pinsLayer.appendChild(draftPin);
    setMode(false);
    openComposer();
  });

  /* ---------- global events ---------- */

  // H = presentation mode: toolbar, pins, popover and sidebar all go; a faint
  // dot stays as the way back. Restores what was open.
  let presentSaved = null;
  let presentDot = null;
  function togglePresent() {
    state.presenting = !state.presenting;
    if (state.presenting) {
      presentSaved = { sidebar: state.sidebar, active: state.active };
      closeMap();
      closePopover();
      cancelDraft();
      if (state.mode) setMode(false);
      if (state.sidebar) setSidebar(false);
      toolbar.style.display = 'none';
      pinsLayer.style.display = 'none';
      presentDot = el('button', 'present-dot');
      presentDot.title = 'Show comments (H)';
      presentDot.setAttribute('aria-label', 'Show comments');
      presentDot.addEventListener('click', togglePresent);
      root.appendChild(presentDot);
      let hinted = false;
      try {
        hinted = sessionStorage.getItem('fp_present_hint') === '1';
        sessionStorage.setItem('fp_present_hint', '1');
      } catch {
        /* storage blocked */
      }
      if (!hinted) toast('Hidden — press H to bring comments back', 4000);
    } else {
      presentDot?.remove();
      presentDot = null;
      toolbar.style.display = '';
      pinsLayer.style.display = state.pinsHidden ? 'none' : '';
      const saved = presentSaved;
      presentSaved = null;
      renderAll();
      if (saved?.sidebar) setSidebar(true);
      if (saved?.active) openThread(saved.active, pinEls.get(saved.active));
    }
  }

  // J/K (or ] [): walk comments by number within the current filter.
  function stepThread(dir) {
    const list = threadsInView().slice().sort((a, b) => (a.n || 0) - (b.n || 0));
    if (!list.length) return;
    let i = list.findIndex((t) => t.id === state.active);
    if (i < 0) i = dir > 0 ? -1 : list.length;
    i = (i + dir + list.length) % list.length;
    goTo(list[i]);
  }

  document.addEventListener('keydown', (e) => {
    const target = e.composedPath()[0];
    const typing =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (e.key === 'Escape') {
      if (lightbox) closeLightbox();
      else if (state.map) closeMap();
      else if (statusMenu) closeStatusMenu();
      else if (state.draft) cancelDraft();
      else if (popover) closePopover();
      else if (state.pendingJump) cancelJump();
      else if (state.mode) setMode(false);
      else if (state.sidebar) setSidebar(false);
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    // e.code — layout-independent (works on Cyrillic layouts too)
    if (e.code === 'KeyC') setMode(!state.mode);
    else if (e.code === 'KeyH') togglePresent();
    else if (e.code === 'KeyM') toggleMap();
    else if (e.code === 'KeyJ' || e.code === 'BracketRight') stepThread(1);
    else if (e.code === 'KeyK' || e.code === 'BracketLeft') stepThread(-1);
  });

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (hoverCard && !e.composedPath().some((n) => n === hoverCard || n.classList?.contains('eye'))) hidePreviewCard();
      // The chip itself toggles: closing here first would let its click reopen.
      const path = e.composedPath();
      if (statusMenu && !path.includes(statusMenu) && !path.includes(statusAnchor)) closeStatusMenu();
      if (!popover && !state.draft) return;
      if (e.composedPath().includes(host)) return;
      if (state.draft) cancelDraft();
      else closePopover();
    },
    true
  );

  /* ---------- watchers ---------- */

  let mutTimer = null;
  let lastHere = '';
  function onMutate() {
    clearTimeout(mutTimer);
    mutTimer = setTimeout(() => {
      // Never cancel an open draft or thread here: app-driven mutations
      // (animations, async data) must not eat a comment mid-typing.
      const prevScreen = state.screen;
      state.screen = screenLabel();
      state.screenLabel = screenLabel();
      if (state.screen !== prevScreen) {
        // Seed the new screen's trail with the click that caused the change — only if recent.
        trail = lastNavClick && Date.now() - lastNavClick.at < 2500 ? [trailStep(lastNavClick.anchor, lastNavClick.at)] : [];
      }
      if (
        state.screen !== prevScreen &&
        lastNavClick &&
        lastNavClick.from === prevScreen &&
        Date.now() - lastNavClick.at < 2500
      ) {
        saveEdge(prevScreen, state.screen, lastNavClick.anchor);
        lastNavClick = null;
      }
      detectTheme();
      positionPins();
      checkPendingJump();
      // Prototypes mutate constantly (animations, timers); rebuilding the open
      // sidebar on every mutation swallows clicks. Re-render only when its
      // grouping input changed: the screen, or which threads are on it.
      if (state.sidebar) {
        const here = state.threads.filter(onThisScreen).map((t) => t.id).join(',');
        if (state.screen !== prevScreen || here !== lastHere) renderSidebar();
        lastHere = here;
      }
    }, 250);
  }

  new MutationObserver(onMutate).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    // class/style flips are how prototypes switch themes and screens
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-expanded', 'aria-hidden', 'data-state'],
  });
  window.addEventListener('resize', onMutate);
  document.addEventListener('scroll', () => requestAnimationFrame(positionPins), {
    capture: true,
    passive: true,
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_MS);

  // Long-lived tabs are the #1 source of "it doesn't work" reports: they keep
  // running an outdated overlay. Compare our asset's ETag every 30 min and
  // nudge for a refresh when a new version ships.
  let overlayEtag = null;
  let staleNotified = false;
  async function checkOverlayVersion() {
    try {
      const r = await fetch((EMBED ? API_ORIGIN : '') + '/overlay.js', {
        method: 'HEAD',
        cache: 'no-store',
      });
      const tag = r.headers.get('etag');
      if (!tag) return;
      if (overlayEtag === null) overlayEtag = tag;
      else if (tag !== overlayEtag && !staleNotified) {
        staleNotified = true;
        toast('Commenting got an update — refresh the page to use it', 8000);
      }
    } catch {
      /* offline — ignore */
    }
  }
  checkOverlayVersion();
  setInterval(() => {
    if (document.visibilityState === 'visible') checkOverlayVersion();
  }, 30 * 60 * 1000);

  /* ---------- boot ---------- */

  function renderAll() {
    renderToolbar();
    renderPins();
    if (state.sidebar) renderSidebar();
  }

  if (state.pinsHidden) pinsLayer.style.display = 'none';
  state.screen = screenLabel();
  state.screenLabel = screenLabel();
  detectTheme();

  // Prototype version = hash of the served page; threads remember the version
  // they were left on, so updated prototypes show an "Older version" badge.
  // The ETag of the served page identifies the build cheaply (no download);
  // fall back to hashing the HTML when the server sends none. Register it so
  // the Versions panel knows when each build was first seen.
  (async () => {
    try {
      // Always the entry page: one version per prototype, not per page.
      const head = await fetch('/', { method: 'HEAD', cache: 'no-store' });
      const tag = head.headers.get('etag');
      if (tag) state.proto = tag.replace(/^W\//, '').replace(/"/g, '').slice(0, 80);
      else {
        const html = await (await fetch('/', { cache: 'no-store' })).text();
        let h = 5381;
        for (let i = 0; i < html.length; i++) h = ((h << 5) + h + html.charCodeAt(i)) >>> 0;
        state.proto = 'v' + h.toString(36);
      }
      await api('POST', { action: 'version', id: state.proto });
    } catch {
      /* offline or embed without HEAD — versions stay unknown */
    }
  })();

  // "New since my last visit": a visit is a browser session (tab lifetime), so
  // full-page hops inside it — other pages, reload-teleports — don't reset it.
  try {
    if (!sessionStorage.getItem('fp_session')) {
      const prev = Number(localStorage.getItem('fp_last_visit') || 0);
      localStorage.setItem('fp_prev_visit', String(prev));
      localStorage.setItem('fp_last_visit', String(Date.now()));
      sessionStorage.setItem('fp_session', String(Date.now()));
    }
    state.prevVisit = Number(localStorage.getItem('fp_prev_visit') || 0);
    state.bootAt = Number(sessionStorage.getItem('fp_session')) || Date.now();
  } catch {
    state.prevVisit = 0;
    state.bootAt = Date.now();
  }
  // The "new" window closes after a minute even on a quiet room.
  setTimeout(() => renderAll(), Math.max(0, 60000 - (Date.now() - state.bootAt)) + 50);

  // Deep link: /?comment=<id> — strip it from the URL immediately (a
  // reload-teleport must not re-trigger it) and jump after boot.
  const bootUrl = new URL(location.href);
  const deepLink = bootUrl.searchParams.get('comment');
  if (deepLink) {
    // Strip only our param — hash routers and the prototype's own query survive.
    bootUrl.searchParams.delete('comment');
    history.replaceState(null, '', bootUrl.pathname + bootUrl.search + bootUrl.hash);
  }

  setTimeout(() => {
    state.screen = screenLabel();
    state.screenLabel = screenLabel();
    bootScreen = state.screen;
    detectTheme();
    applyTbPos();
    renderPins();
    // Continue a reload-teleport or serve a deep link: replay the learned
    // route to the comment from the start screen.
    const jumpLabel = localStorage.getItem('fp_jump_label');
    if (jumpLabel) {
      localStorage.removeItem('fp_jump_label');
      setTimeout(() => goToScreen(jumpLabel), 800);
    }
    const jump = localStorage.getItem('fp_jump') || deepLink;
    if (jump) {
      localStorage.removeItem('fp_jump');
      toastSticky('Taking you to the comment…');
      const go = () => {
        const t = state.threads.find((x) => x.id === jump);
        if (t) {
          goTo(t);
        } else clearSticky();
      };
      if (state.threads.length) setTimeout(go, 800);
      else refresh().then(() => setTimeout(go, 800));
    }
  }, 1200);

  // Read-only automation hook: the map crawler reads the label through it and
  // tests inspect state. Never used by the overlay itself.
  window.__fp = { version: 2, label: screenLabel, get state() { return state; } };

  refresh().then(() => {
    syncLocalEdges();
    if (!localStorage.getItem('fp_hint')) {
      localStorage.setItem('fp_hint', '1');
      const touch = matchMedia('(pointer: coarse)').matches;
      toast(
        touch
          ? 'Tap Comment, then tap anywhere to leave feedback'
          : 'Press C or click Comment to leave feedback',
        5000
      );
    }
  });
})();
