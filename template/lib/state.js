import { assemble, navPatch } from './threads.js';

/* The state document: <root>state.json = { v, threads, nav, updatedAt },
   derived from the append-only event log. `storage` is injected —
   { readJson, writeJson, readEvents, ConflictError } — so the concurrency
   logic is unit-testable without Blob.

   Every write is conditional: ifMatch on the ETag that was read, or ifAbsent
   when there was no document. Nothing here overwrites a document it has not
   seen, so two racing writers can never silently erase each other's work. */

export const emptyState = () => ({ v: 2, threads: [], nav: {}, updatedAt: 0 });

export const isValidState = (d) =>
  Boolean(d && d.v === 2 && Array.isArray(d.threads) && d.nav && typeof d.nav === 'object');

export function createStateStore(storage, { navCap = 500, attempts = 4 } = {}) {
  const doc = (root) => `${root}state.json`;
  const isConflict = (e) => e instanceof storage.ConflictError;
  const write = (root, next, etag) =>
    storage.writeJson(doc(root), next, etag ? { ifMatch: etag } : { ifAbsent: true });

  async function rebuild(root) {
    const [threadEvents, navEvents] = await Promise.all([
      storage.readEvents(`${root}threads/`),
      storage.readEvents(`${root}nav/`),
    ]);
    const threads = assemble(threadEvents, root);
    const edges = navEvents
      .map((b) => b.data)
      .filter((e) => e && e.from && e.to)
      .sort((a, b) => a.at - b.at);
    let nav = {};
    for (const e of edges) nav = navPatch(nav, e.from, e.to, e.anchor, e.at, navCap);
    return { ...emptyState(), threads, nav, updatedAt: Date.now() };
  }

  // Read the document; rebuild it from events when missing or corrupt.
  // path: 'read' | 'rebuild' | 'rebuild-unsaved'
  async function loadState(root) {
    const { data, etag } = await storage.readJson(doc(root));
    if (isValidState(data)) return { state: data, etag, path: 'read' };
    const state = await rebuild(root);
    try {
      const { etag: fresh } = await write(root, state, etag);
      return { state, etag: fresh, path: 'rebuild' };
    } catch (e) {
      if (!isConflict(e)) throw e;
      // Someone else wrote first — theirs is at least as fresh as ours.
      const again = await storage.readJson(doc(root));
      if (isValidState(again.data)) return { state: again.data, etag: again.etag, path: 'read' };
      return { state, etag: again.etag, path: 'rebuild-unsaved' };
    }
  }

  // Apply a pure patch (state → partial state) with optimistic concurrency.
  // path: 'patch' | 'retry' | 'rebuild' | 'unsaved'
  async function mutate(root, patch) {
    for (let i = 0; i < attempts; i++) {
      const { state, etag } = await loadState(root);
      const next = { ...state, ...patch(state), updatedAt: Date.now() };
      try {
        await write(root, next, etag);
        return { state: next, path: i ? 'retry' : 'patch' };
      } catch (e) {
        if (!isConflict(e)) throw e;
      }
    }
    // Writers keep racing: rebuild from the log and re-apply the patch —
    // list() may lag the event we just wrote, so the patch is not optional.
    for (let i = 0; i < 2; i++) {
      const { etag } = await storage.readJson(doc(root));
      const rebuilt = await rebuild(root);
      const next = { ...rebuilt, ...patch(rebuilt), updatedAt: Date.now() };
      try {
        await write(root, next, etag);
        return { state: next, path: 'rebuild' };
      } catch (e) {
        if (!isConflict(e)) throw e;
      }
    }
    // The event is on the log and the response below is correct; the document
    // catches up on the next rebuild. Loud, because it should never happen.
    console.warn(`state.json: ${attempts + 2} consecutive write conflicts under "${root || '/'}"`);
    const { state } = await loadState(root);
    return { state: { ...state, ...patch(state) }, path: 'unsaved' };
  }

  // Designer-triggered full rebuild (?rebuild=1). Still conditional.
  async function forceRebuild(root) {
    for (let i = 0; i < 2; i++) {
      const { etag } = await storage.readJson(doc(root));
      const state = await rebuild(root);
      try {
        await write(root, state, etag);
        return { state, path: 'rebuild' };
      } catch (e) {
        if (!isConflict(e)) throw e;
      }
    }
    throw new Error('state.json: rebuild lost the race twice');
  }

  return { rebuild, loadState, mutate, forceRebuild };
}
