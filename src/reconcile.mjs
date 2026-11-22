// reconcile.mjs — one idempotent pass over every tab.
//
// A pass is a pure-ish function of (snapshot, state, config): it computes what
// every label should be and only writes when the answer differs from what herdr
// already shows. That is what makes it safe to run on every event:
//
//   * overlapping events collapse into one pass (see state.acquireLock);
//   * a rename re-fires tab.renamed, and the next pass finds the label already
//     correct and stops — no rename loop, no "a › b › a › b" growth;
//   * a label that is not the one we last wrote is treated as hand-typed and
//     left alone, unless the session carries a newer /name (see below);
//   * `pane process-info` is a process spawn per tab, so it is only called for
//     tabs whose label the cheap pass could not settle, and capped per pass.

import { execFileSync } from "node:child_process";
import { computeLabel } from "./naming.mjs";
import { createHerdrClient } from "./herdr.mjs";
import { homeDir } from "./config.mjs";
import { TASK_VERSION, pickTask, readSessionInfo, readSessionName, sessionFile, sessionStamp } from "./task.mjs";
import { acquireLock, loadState, saveState } from "./state.mjs";

const ISO = /^\d{4}-\d{2}-\d{2}T/;

/** herdr numbers new tabs "1", "2", … — the only label we may overwrite blind. */
function isDefaultLabel(label) {
  return /^\d+$/.test(String(label || ""));
}

/** True when `a` is a timestamp that is newer than `b` (both may be ""). */
function isNewer(a, b) {
  if (!a) return false;
  if (!ISO.test(a)) return false;
  if (!b) return true;
  return a > b;
}

/** Branch of the repo containing `cwd`; "" when not a repo or detached. */
export function gitBranch(cwd, cfg, deps = {}) {
  if (!cfg.showBranch || !cwd) return "";
  const run =
    deps.git ||
    ((args) =>
      execFileSync("git", args, {
        encoding: "utf8",
        timeout: cfg.timeoutMs,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }));
  try {
    const out = String(run(["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return !out || out === "HEAD" ? "" : out;
  } catch {
    return "";
  }
}

/**
 * "What is this conversation doing" and "what did the human call it", both from
 * the agent's own transcript: the `session_info` record written by `/name`, then
 * the title the agent wrote for itself (Claude's `ai-title`), else the last human
 * message that reads like a task.
 *
 * Cached by (TASK_VERSION, size, mtime) so a pass normally reads no file at all.
 * Returns { name, nameAt, task }.
 */
export function resolveSession(cfg, pane, state, home, deps = {}) {
  const none = { name: "", nameAt: "", task: "" };
  if (cfg.sessionTask === false && cfg.sessionName === false) return none;
  const sess = pane.agent_session;
  if (!sess || !sess.value) return none;
  const file = sessionFile({ kind: sess.kind, value: sess.value, cwd: pane.cwd }, home);
  if (!file) return none;

  const stamp = (deps.sessionStamp || sessionStamp)(file);
  if (!stamp) return none;

  state.sessions = state.sessions || {};
  const cached = state.sessions[file];
  if (cached && cached.stamp === stamp) {
    return { name: cached.name || "", nameAt: cached.nameAt || "", task: cached.task || "" };
  }

  const info = (deps.readSessionInfo || readSessionInfo)(file, { tailBytes: cfg.sessionTailBytes });
  const task = cfg.sessionTask === false ? "" : pickTask(info, cfg.maxTitleLen);
  // `/name` is a property of the whole session, not of its last few KB. Once we
  // have seen one, keep it even after it scrolls out of the tail window; only a
  // newer session_info record (a later /name) may replace it. When the tail has
  // no name but we expect one (a cached name, or a cache written by an older
  // TASK_VERSION), scan the whole file once and take the last record.
  const versionChanged = Boolean(cached) && !String(cached.stamp || "").startsWith(`${TASK_VERSION}:`);
  let name = String(info?.name || "").trim();
  let nameAt = String(info?.nameAt || "").trim();
  if (!name && (cached?.name || versionChanged)) {
    const full = (deps.readSessionName || readSessionName)(file);
    if (full?.name) {
      name = String(full.name).trim();
      nameAt = String(full.nameAt || "").trim();
    } else if (cached?.name) {
      name = String(cached.name).trim();
      nameAt = String(cached.nameAt || "").trim();
    }
  }
  if (cfg.sessionName === false) {
    name = "";
    nameAt = "";
  }

  state.sessions[file] = { stamp, name, nameAt, task };

  // A long-lived machine accumulates one entry per session; drop the oldest half
  // once past the cap. Object key order is insertion order, so this is FIFO.
  const keys = Object.keys(state.sessions);
  const max = cfg.cacheMaxSessions || 200;
  if (keys.length > max) for (const k of keys.slice(0, keys.length - Math.floor(max / 2))) delete state.sessions[k];

  return { name, nameAt, task };
}

/**
 * One full pass.
 * Returns { renames: [{tabId, from, to, source}], skipped: [...], errors: [...] }.
 * With `dryRun`, `to` is what would have been written and nothing is.
 */
export function reconcile(cfg, deps = {}) {
  const herdr = deps.herdr || createHerdrClient(cfg, deps);
  const home = homeDir(deps.env || process.env);
  const snap = herdr.snapshot();

  const tabs = (snap.tabs || []).filter((t) => !cfg.onlyTab || t.tab_id === cfg.onlyTab);
  const panes = snap.panes || [];
  const workspaces = new Map((snap.workspaces || []).map((w) => [w.workspace_id, w]));
  const agentNames = new Map((snap.agents || []).map((a) => [a.pane_id, a.name || ""]));

  const loaded = deps.state ? { state: deps.state, migratedFrom: "", fresh: false } : loadState(cfg);
  const state = loaded.state;
  const result = { renames: [], skipped: [], errors: [] };
  let lookups = 0;

  // The very first pass on a machine adopts every tab, the way an install is
  // expected to. Later, `reset` sets state.adoptUnknown so the user can hand the
  // tabs back. In between, a label we never wrote is treated as a human's.
  const adoptUnknown = (Boolean(state.adoptUnknown) || loaded.fresh) && !cfg.onlyTab;
  if (adoptUnknown && !cfg.dryRun) state.adoptUnknown = false;

  for (const tab of tabs) {
    const pane = panes.find((p) => p.tab_id === tab.tab_id && (tab.pane_count === 1 || p.focused));
    if (!pane) {
      result.skipped.push({ tabId: tab.tab_id, reason: "no pane" });
      continue;
    }

    // A tab whose label is not the one we last wrote was renamed by hand in
    // herdr. That label wins over every heuristic — but not over a /name typed
    // after our last pass, which is how the two manual channels stay peer-level.
    const recorded = state.tabs[tab.tab_id];

    const ws = workspaces.get(tab.workspace_id);
    const branch = gitBranch(pane.cwd, cfg, deps);

    // herdr reports an agent name only sometimes; the tab's own label is the same
    // thing for panes it left unnamed. A label we wrote carries the separator, so
    // it is never fed back in. Once we rename "worker-dst-1" to
    // "workflow › worker-dst-1" the label no longer looks like a bare name, so the
    // name we resolved last time is remembered in the state file.
    const remembered = recorded && recorded.label === tab.label ? recorded.ownName || "" : "";
    const ownName =
      agentNames.get(pane.pane_id) ||
      remembered ||
      (tab.label && !tab.label.includes(cfg.contextSep.trim()) ? tab.label : "");

    let sessionTask = "";
    let sessionName = "";
    let sessionNameAt = "";
    if (pane.agent) {
      try {
        const resolved = resolveSession(cfg, pane, state, home, deps);
        sessionTask = resolved.task;
        sessionName = resolved.name;
        sessionNameAt = resolved.nameAt;
      } catch (err) {
        result.errors.push({ tabId: tab.tab_id, where: "session", message: String(err?.message || err) });
      }
    }

    const agent = pane.agent
      ? {
          kind: pane.agent,
          title: pane.terminal_title_stripped || pane.terminal_title || "",
          name: ownName,
          sessionTask,
          sessionName,
        }
      : null;

    const labelDrifted = Boolean(recorded && recorded.label && recorded.label !== tab.label);
    // `/name` can only outrank a manual label when we know which human edit came
    // last, i.e. when the tab has a record. Without one there is no ordering to
    // compare, and the label already on screen wins.
    const nameIsNewer =
      Boolean(sessionName) && Boolean(recorded) && isNewer(sessionNameAt, recorded?.nameSeenAt || "");
    // A tab we have never named is only ours to name while it still carries
    // herdr's numeric default or a label shaped like one of ours. Anything else
    // was typed by a human (or another plugin) before our first pass — most
    // commonly a tab renamed in the second between its creation and the
    // debounced `tab.created` event.
    const oursLooking = String(tab.label || "").includes(String(cfg.contextSep).trim());
    const looksManual =
      Boolean(recorded?.manual) ||
      labelDrifted ||
      (!recorded && !isDefaultLabel(tab.label) && !oursLooking);
    const handNamed =
      looksManual && !nameIsNewer && !adoptUnknown && state.adoptOnly !== tab.tab_id;

    // Settle the cheap answer first: when the transcript or the agent title
    // already names the tab, the process table cannot improve on it, and each
    // process-info call is a herdr spawn.
    const base = { cwd: pane.cwd, workspaceLabel: ws?.label || "", branch, agent, foreground: null };
    const cheap = computeLabel(base, cfg, home);
    const settled = ["session-name", "session-task", "agent-title", "agent-name"].includes(cheap.source);

    let foreground = null;
    if (!settled && cfg.nameTabs && !handNamed && lookups < cfg.maxProcessLookups) {
      lookups += 1;
      try {
        const info = herdr.processInfo(pane.pane_id);
        const fg = info?.foreground_processes?.[0];
        if (fg) foreground = { argv0: fg.argv0 || fg.argv?.[0] || "", argv: fg.argv || [] };
      } catch (err) {
        result.errors.push({ tabId: tab.tab_id, where: "process-info", message: String(err?.message || err) });
      }
    }

    let computed;
    try {
      computed = settled ? cheap : computeLabel({ ...base, foreground }, cfg, home);
    } catch (err) {
      result.errors.push({ tabId: tab.tab_id, where: "naming", message: String(err?.message || err) });
      continue;
    }

    if (handNamed) {
      // Keep `label` as the last thing we wrote: the mismatch is what marks the
      // tab as hand-named on later passes. `nameSeenAt` still advances so an old
      // /name cannot resurface as "newer" and overwrite the human's label.
      state.tabs[tab.tab_id] = {
        label: recorded?.label || "",
        source: "manual",
        manual: true,
        ownName,
        nameSeenAt: sessionNameAt || recorded?.nameSeenAt || "",
      };
      result.skipped.push({ tabId: tab.tab_id, reason: "hand-renamed", label: tab.label });
      continue;
    }

    const target = computed.label;
    if (!target) {
      result.skipped.push({ tabId: tab.tab_id, reason: "nothing to say", label: tab.label });
      continue;
    }
    if (target === tab.label) {
      result.skipped.push({ tabId: tab.tab_id, reason: "already correct", label: tab.label });
      state.tabs[tab.tab_id] = {
        label: target,
        source: computed.source,
        ownName,
        nameSeenAt: sessionNameAt || recorded?.nameSeenAt || "",
      };
      continue;
    }

    if (!cfg.dryRun) {
      try {
        herdr.renameTab(tab.tab_id, target);
      } catch (err) {
        result.errors.push({ tabId: tab.tab_id, where: "rename", message: String(err?.message || err) });
        continue;
      }
      state.tabs[tab.tab_id] = {
        label: target,
        source: computed.source,
        ownName,
        nameSeenAt: sessionNameAt || recorded?.nameSeenAt || "",
      };
    }
    result.renames.push({ tabId: tab.tab_id, from: tab.label, to: target, source: computed.source });
  }

  // Closed tabs otherwise sit in the state file forever and a recycled tab id
  // would inherit a stale "hand-renamed" mark.
  if (!cfg.dryRun && !cfg.onlyTab) {
    const live = new Set(tabs.map((t) => t.tab_id));
    for (const id of Object.keys(state.tabs)) if (!live.has(id)) delete state.tabs[id];
  }
  if (!cfg.dryRun && (!cfg.onlyTab || cfg.onlyTab === state.adoptOnly)) delete state.adoptOnly;

  if (deps.persistState !== false) {
    try {
      saveState(cfg, state);
    } catch (err) {
      result.errors.push({ where: "state", message: String(err?.message || err) });
    }
  }
  return result;
}

/** Wrap a pass in the plugin lock. Concurrent events collapse into one pass. */
export function reconcileLocked(cfg, deps = {}) {
  const lock = acquireLock(cfg);
  if (!lock.ok) return { renames: [], skipped: [], errors: [], locked: lock.reason };
  try {
    return reconcile(cfg, deps);
  } finally {
    lock.release();
  }
}
