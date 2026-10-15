#!/usr/bin/env node
/* share-proto comment watch — switched off (v2.8.1).

   v2.8 had the designer's Claude open every new session with news from their
   prototypes. In use it broke into chats that had nothing to do with them (a
   slide-deck session began with prototype comments), and the owner switched
   it off.

   The file stays at this path because the hook v2.8 installed calls it. Run
   as that hook, it takes the hook out of ~/.claude/settings.json and deletes
   the list of watched prototypes (it holds team passwords nothing reads any
   more), prints nothing, and lets the session start. So a designer who had it
   loses it at their next session start, with nothing to do.

   The feature itself is in git history (v2.8, commit 41a7c3f).
   Zero dependencies, Node >= 18. */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, chmodSync, statSync, lstatSync, realpathSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SELF = fileURLToPath(import.meta.url);
export const configDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
export const settingsPath = () => join(configDir(), 'settings.json');
export const registryDir = () => join(configDir(), 'share-proto');

const isObj = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
// Ours, and only ours: another tool's watch.mjs is not this one.
const ours = (h) => typeof h?.command === 'string' && /share-proto[\\/]+scripts[\\/]+watch\.mjs"?\s+check\b/.test(h.command);

function readSettings(file) {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  const s = JSON.parse(raw); // throws on invalid JSON: the caller leaves it alone
  if (!isObj(s)) throw new Error('not an object');
  return s;
}

// Through a symlink (a dotfiles repo) to the real file, keeping its mode
// (it often holds tokens and is 0600).
function writeSettings(file, s) {
  let real = file;
  if (lstatSync(file).isSymbolicLink()) real = realpathSync(file);
  const mode = statSync(real).mode & 0o777;
  mkdirSync(dirname(real), { recursive: true });
  const tmp = `${real}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, real);
}

// Takes out this hook and nothing else; a group or a SessionStart list left
// empty goes with it. A file that is not valid JSON is not touched.
export function uninstallHook(file = settingsPath()) {
  let s;
  try {
    s = readSettings(file);
  } catch {
    return false;
  }
  const groups = Array.isArray(s.hooks?.SessionStart) ? s.hooks.SessionStart : [];
  if (!groups.some((g) => (g?.hooks || []).some(ours))) return false;
  const kept = groups.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
  if (kept.length) s.hooks.SessionStart = kept;
  else delete s.hooks.SessionStart;
  if (!Object.keys(s.hooks).length) delete s.hooks;
  writeSettings(file, s);
  return true;
}

// watch.json, its lock, temporary writes and damaged copies set aside — all
// of them can hold team passwords. Only this tool's files; the folder goes
// only if nothing else is in it.
export function removeRegistry(dir = registryDir()) {
  if (!existsSync(dir)) return false;
  let removed = false;
  for (const name of readdirSync(dir)) {
    if (/^watch\.json(\.|$)/.test(name)) {
      rmSync(join(dir, name), { force: true });
      removed = true;
    }
  }
  try {
    rmdirSync(dir); // fails, as it should, if something else lives there
  } catch {
    /* not empty */
  }
  return removed;
}

export function switchOff() {
  const hook = uninstallHook();
  const list = removeRegistry();
  return { hook, list };
}

// Run as a script — also through a symlinked skill folder or ~/.claude.
const invoked = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(SELF);
  } catch {
    return false;
  }
})();

if (invoked) {
  const cmd = process.argv[2];
  if (cmd === 'check') {
    // The old hook. A session must start whatever happens in here: no throw,
    // no output, exit 0.
    try {
      switchOff();
    } catch {
      /* silent by design */
    }
    process.exit(0);
  }
  const { hook, list } = switchOff();
  if (cmd === 'uninstall' || cmd === 'off') {
    console.log(`Startup hook: ${hook ? 'removed' : 'none'}. List of watched prototypes: ${list ? 'deleted' : 'none'}.`);
  } else {
    console.log('The comment watch is switched off (share-proto v2.8.1): nothing was set up.');
    if (hook || list) console.log(`Cleaned up what an earlier version left: ${[hook && 'the startup hook', list && 'the list of watched prototypes'].filter(Boolean).join(' and ')}.`);
  }
}
