// state.mjs — what the plugin remembers between passes.
//
// state = {
//   version: 2,
//   tabs: { "<tab_id>": { label, source, ownName, nameSeenAt } },
//   sessions: { "<path>": { stamp, name, nameAt, task } },
// }
//
// `tabs` exists to answer one question: is the label herdr reports the one we
// wrote, or did a human type it? `sessions` is a cache keyed on
// (TASK_VERSION, size, mtime) so a pass normally reads no session file at all.
//
// Writes are atomic (write a temp file, rename over) because a rename can be
// interrupted by herdr shutting down mid-pass.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PLUGIN_DIR } from "./paths.mjs";

export const STATE_VERSION = 2;
const LEGACY_FILE_NAME = ".state.json";

export function statePath(cfg) {
  return join(cfg.stateDir || PLUGIN_DIR, cfg.stateFileName);
}

function emptyState() {
  return { version: STATE_VERSION, tabs: {}, sessions: {} };
}

/** Accept a v1 file (`tasks` cache, no version) and lift it to v2. */
function migrate(parsed) {
  if (!parsed || typeof parsed !== "object") return emptyState();
  const state = emptyState();
  if (parsed.tabs && typeof parsed.tabs === "object") state.tabs = parsed.tabs;
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
 * A lock older than `staleMs` is assumed to belong to a process herdr killed.
 */
export function acquireLock(cfg, staleMs = 30_000) {
  const dir = cfg.stateDir || PLUGIN_DIR;
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock");
  try {
    mkdirSync(lock);
    return { ok: true, lock, release: () => release(lock) };
  } catch (err) {
    if (err?.code !== "EEXIST") return { ok: false, reason: `lock error: ${err?.message}` };
    try {
      if (Date.now() - statSync(lock).mtimeMs > staleMs) {
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
        return { ok: true, lock, release: () => release(lock) };
      }
    } catch {
      return { ok: false, reason: "locked" };
    }
    return { ok: false, reason: "locked" };
  }
}

function release(lock) {
  try {
    rmSync(lock, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
