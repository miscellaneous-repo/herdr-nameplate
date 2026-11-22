// state.mjs — what the plugin remembers between passes.
//
// state = {
//   version: 3,
//   tabs: { "<tab_id>": { label, source, provenance, frozen, ownName, nameSeenAt } },
//   sessions: { "<path>": { stamp, name, nameAt, task, completed } },
// }
//
// `tabs` answers two questions: is the label herdr reports the one we wrote, or
// did a human type it (`provenance`: auto | manual), and in `once` mode has this
// tab already been named (`frozen`).
//
// Writes are atomic (write a temp file, rename over) because a rename can be
// interrupted by herdr shutting down mid-pass.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PLUGIN_DIR } from "./paths.mjs";

export const STATE_VERSION = 3;
const LEGACY_FILE_NAME = ".state.json";

export function statePath(cfg) {
  return join(cfg.stateDir || PLUGIN_DIR, cfg.stateFileName);
}

function emptyState() {
  return { version: STATE_VERSION, tabs: {}, sessions: {} };
}

/** Accept a v1 file (`tasks` cache) or a v2 file (no provenance) and lift it. */
function migrate(parsed) {
  if (!parsed || typeof parsed !== "object") return emptyState();
  const state = emptyState();
  if (parsed.tabs && typeof parsed.tabs === "object") {
    for (const [id, tab] of Object.entries(parsed.tabs)) {
      if (!tab || typeof tab !== "object") continue;
      state.tabs[id] = {
        ...tab,
        provenance: tab.provenance === "manual" || tab.manual === true ? "manual" : "auto",
        // Tabs that already have a label were named under the old policy; keep
        // them as they are instead of restarting every tab on upgrade.
        frozen: typeof tab.frozen === "boolean" ? tab.frozen : Boolean(tab.label),
      };
      delete state.tabs[id].manual;
    }
  }
  // v1 kept the session cache under `tasks`; the stamp embeds TASK_VERSION, so a
  // stale entry simply misses and is recomputed.
  const sessions = parsed.sessions || parsed.tasks;
  if (sessions && typeof sessions === "object") state.sessions = sessions;
  // Transient one-shot flags must survive a load or `reset` silently stops working.
  if (parsed.adoptUnknown === true) state.adoptUnknown = true;
  if (typeof parsed.adoptOnly === "string" && parsed.adoptOnly) state.adoptOnly = parsed.adoptOnly;
  state.version = STATE_VERSION;
  return state;
}

/**
 * Load state, falling back to the pre-0.2 file next to the code. Returns
 * { state, path, migratedFrom }.
 */
export function loadState(cfg) {
  const path = statePath(cfg);
  if (existsSync(path)) {
    try {
      return { state: migrate(JSON.parse(readFileSync(path, "utf8"))), path, migratedFrom: "", fresh: false };
    } catch {
      return { state: emptyState(), path, migratedFrom: "", fresh: false };
    }
  }
  const legacy = cfg.legacyStateFile || join(PLUGIN_DIR, LEGACY_FILE_NAME);
  if (existsSync(legacy)) {
    try {
      return { state: migrate(JSON.parse(readFileSync(legacy, "utf8"))), path, migratedFrom: legacy, fresh: false };
    } catch {
      /* fall through to an empty state */
    }
  }
  return { state: emptyState(), path, migratedFrom: "", fresh: true };
}

export function saveState(cfg, state) {
  const path = statePath(cfg);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Forget our labels so hand-named tabs opt back in. Returns the count cleared. */
export function clearTabs(cfg, tabId) {
  const { state } = loadState(cfg);
  let cleared = 0;
  for (const id of Object.keys(state.tabs)) {
    if (!tabId || id === tabId) {
      delete state.tabs[id];
      cleared += 1;
    }
  }
  // Without this, tabs whose labels are not herdr's numeric defaults would be
  // read as hand-named on the next pass and reset would do nothing.
  if (tabId) state.adoptOnly = tabId;
  else state.adoptUnknown = true;
  saveState(cfg, state);
  return cleared;
}

/**
 * The plugin's mutex. herdr fires many events at once and each is its own
 * process; without a lock they would all snapshot, all decide, and all rename.
 *
 * A lock is stolen when its owner is gone (a dead pid), or when it is older than
 * a hard ceiling (a hung process that can never finish). Age alone is not enough:
 * a pass over many tabs can legitimately outlive the soft window, because every
 * herdr and git call may take up to `timeoutMs`.
 */
export function acquireLock(cfg, staleMs = 30_000) {
  const dir = cfg.stateDir || PLUGIN_DIR;
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock");
  const take = () => {
    mkdirSync(lock);
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token }));
    } catch {
      // The owner file is advisory; a lock without one is still valid.
    }
    return { ok: true, lock, release: () => release(lock, token) };
  };
  try {
    return take();
  } catch (err) {
    if (err?.code !== "EEXIST") return { ok: false, reason: `lock error: ${err?.message}` };
    try {
      if (lockIsStale(lock, staleMs)) {
        rmSync(lock, { recursive: true, force: true });
        return take();
      }
    } catch {
      return { ok: false, reason: "locked" };
    }
    return { ok: false, reason: "locked" };
  }
}

const LOCK_MAX_AGE_MS = 10 * 60_000;

function lockOwner(lock) {
  try {
    return JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function lockIsStale(lock, staleMs) {
  let age;
  try {
    age = Date.now() - statSync(lock).mtimeMs;
  } catch {
    return true; // it vanished between EEXIST and stat: let the caller retry
  }
  if (age > LOCK_MAX_AGE_MS) return true;
  if (age <= staleMs) return false;
  // Older than the soft window: only steal when the process that took it is gone.
  const owner = lockOwner(lock);
  if (owner && Number.isInteger(owner.pid)) return !pidAlive(owner.pid);
  return true; // a lock from before owner tracking: trust the age
}

function release(lock, token) {
  try {
    const owner = lockOwner(lock);
    // Another process may have stolen the lock (a hung pass); never delete its lock.
    if (owner && owner.token && owner.token !== token) return;
    rmSync(lock, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** `reset`, wrapped in the same mutex so it cannot be lost under a running pass. */
export function clearTabsLocked(cfg, tabId) {
  const lock = acquireLock(cfg);
  if (!lock.ok) return { ok: false, reason: lock.reason, cleared: 0 };
  try {
    return { ok: true, cleared: clearTabs(cfg, tabId) };
  } finally {
    lock.release();
  }
}
