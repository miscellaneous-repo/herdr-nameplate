// reconcile.mjs — one idempotent pass over every tab.
//
// The original shells out to bash once per event; here a single node process
// does the whole pass. Consequences worth knowing:
//   * the pass is idempotent, so overlapping events cost nothing but a rename
//     that was already correct is skipped (which also stops the rename→
//     tab.renamed→reconcile loop);
//   * a tab whose label no longer matches what we last wrote is treated as
//     hand-named and left alone until `reset`;
//   * `pane process-info` is the expensive call, so it is done only for tabs we
//     are actually about to name, and capped per pass.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { computeLabel } from "./naming.mjs";
import { makeHerdr } from "./herdr.mjs";
import { homeDir } from "./config.mjs";
import { pickTask, readSessionInfo, sessionFile, sessionStamp } from "./task.mjs";

const LOCK_STALE_MS = 30_000;

function statePath(cfg) {
  return join(cfg.stateDir || ".", cfg.stateFileName);
}

function loadState(cfg) {
  const p = statePath(cfg);
  if (!existsSync(p)) return { tabs: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed.tabs !== "object") return { tabs: {} };
    return parsed;
  } catch {
    return { tabs: {} };
  }
}

function saveState(cfg, state) {
  const p = statePath(cfg);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, p);
}

/** Branch of the repo containing `cwd`, "" when it is not a repo or is detached. */
export function gitBranch(cwd, cfg, deps = {}) {
  if (!cfg.showBranch || !cwd) return "";
  const run = deps.git || ((args) => execFileSync("git", args, { encoding: "utf8", timeout: cfg.timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }));
  try {
    const out = run(["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
    const b = String(out).trim();
    if (!b || b === "HEAD") return "";
    return b;
  } catch {
    return "";
  }
}

/**
 * "What is this conversation doing" and "what did the human call it" -- both
 * read from the agent's own session file: the `session_info` record the human
 * wrote with `/name`, then the title the agent wrote for itself (Claude:
 * `ai-title`), else its last human message. Cached by (size, mtime) in the state
 * file so a pass usually does no file reads at all.
 * Returns { name, task }.
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
  state.tasks = state.tasks || {};
  const cached = state.tasks[file];
  if (cached && cached.stamp === stamp) {
    return { name: cached.name || "", nameAt: cached.nameAt || "", task: cached.task || "" };
  }

  const info = (deps.readSessionInfo || readSessionInfo)(file, { tailBytes: cfg.sessionTailBytes });
  const task = cfg.sessionTask === false ? "" : pickTask(info, cfg.maxTitleLen);
  const name = cfg.sessionName === false ? "" : String(info?.name || "").trim();
  const nameAt = cfg.sessionName === false ? "" : String(info?.nameAt || "");
  state.tasks[file] = { stamp, name, nameAt, task };

  // do not let the cache grow without bound on a long-lived session
  const keys = Object.keys(state.tasks);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 100)) delete state.tasks[k];
  return { name, nameAt, task };
}

/** Take the plugin's lock; returns "" on success or a reason string. */
function takeLock(cfg, deps = {}) {
  const dir = cfg.stateDir || ".";
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock");
  try {
    mkdirSync(lock);
    return "";
  } catch (err) {
    if (err?.code !== "EEXIST") return `lock error: ${err?.message}`;
    try {
      const age = Date.now() - statSync(lock).mtimeMs;
      if (age > LOCK_STALE_MS) {
        deps.rmdir?.(lock);
        return "";
      }
    } catch {
      return "lock exists";
    }
    return "locked";
  }
}

function releaseLock(cfg, deps = {}) {
  try {
    deps.rmdir(join(cfg.stateDir || ".", ".lock"));
  } catch {
    /* ignore */
  }
}

/**
 * One full pass.
 * Returns { renames: [{tabId, from, to, source}], skipped: [...], errors: [...] }
 * — with `dryRun`, `to` is what would have been written and nothing is.
 */
export function reconcile(cfg, deps = {}) {
  const herdr = deps.herdr || makeHerdr(cfg, deps);
  const home = homeDir(deps.env || process.env);
  const snap = herdr.snapshot();

  const tabs = (snap.tabs || []).filter((t) => !cfg.onlyTab || t.tab_id === cfg.onlyTab);
  const panes = snap.panes || [];
  const workspaces = new Map((snap.workspaces || []).map((w) => [w.workspace_id, w]));
  const agentNames = new Map((snap.agents || []).map((a) => [a.pane_id, a.name || ""]));

  const state = deps.state || loadState(cfg);
  const result = { renames: [], skipped: [], errors: [] };
  let lookups = 0;

  for (const tab of tabs) {
    const pane = panes.find((p) => p.tab_id === tab.tab_id && (tab.pane_count === 1 || p.focused));
    if (!pane) {
      result.skipped.push({ tabId: tab.tab_id, reason: "no pane" });
      continue;
    }

    // Which labels the human typed. We record the label we last wrote, so a tab
    // whose label no longer matches was renamed by hand in herdr. That label is
    // kept -- but not forever: a `/name` newer than the last pass we saw takes
    // the tab over, and re-typing `/name` produces a new timestamp, so the
    // human is never locked out of either channel.
    const recorded = state.tabs[tab.tab_id];

    const ws = workspaces.get(tab.workspace_id);
    const branch = gitBranch(pane.cwd, cfg, deps);
    // herdr records an agent name only sometimes; the tab's own label is the same
    // thing for panes it left unnamed. A label we wrote ourselves carries the
    // separator, so it is never fed back in (no "a › b › a › b" growth).
    // The name we resolved last time has to survive our own rename: once a tab reads
    // "workflow › worker-dst-1" the label no longer looks like a bare herdr name, so
    // without this memory the next pass would collapse it back to "workflow › pi".
    const remembered = recorded && recorded.label === tab.label ? recorded.ownName || "" : "";
    const ownName = agentNames.get(pane.pane_id) || remembered || (tab.label && !tab.label.includes(cfg.contextSep.trim()) ? tab.label : "");
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
        result.errors.push({ tabId: tab.tab_id, where: "session-task", message: String(err?.message || err) });
      }
    }
    const agent = pane.agent
      ? { kind: pane.agent, title: pane.terminal_title_stripped || pane.terminal_title || "", name: ownName, sessionTask, sessionName }
      : null;

    const labelDrifted = Boolean(recorded && recorded.label && recorded.label !== tab.label);
    const nameIsNewer = Boolean(sessionName) && (!recorded?.nameSeenAt || (sessionNameAt || "") > recorded.nameSeenAt);
    const handNamed = labelDrifted && !nameIsNewer;

    // Naming an agent tab rarely needs the process table: herdr already reports the
    // agent and its task, and `process-info` costs one herdr spawn per tab. Ask for
    // it only when the cheap answer is the bare agent kind or a shell name.
    const cheap = computeLabel(
      { cwd: pane.cwd, workspaceLabel: ws?.label || "", branch, agent, foreground: null },
      cfg,
      home,
    );
    const needsForeground = cheap.source !== "agent-title" && cheap.source !== "agent-name" && cheap.source !== "session-name";

    let foreground = null;
    if (cfg.nameTabs && !handNamed && needsForeground && lookups < cfg.maxProcessLookups) {
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
      computed = needsForeground
        ? computeLabel({ cwd: pane.cwd, workspaceLabel: ws?.label || "", branch, agent, foreground }, cfg, home)
        : cheap;
    } catch (err) {
      result.errors.push({ tabId: tab.tab_id, where: "naming", message: String(err?.message || err) });
      continue;
    }

    if (handNamed) {
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
      state.tabs[tab.tab_id] = { label: target, source: computed.source, ownName, nameSeenAt: sessionNameAt };
      continue;
    }

    if (!cfg.dryRun) {
      try {
        herdr.renameTab(tab.tab_id, target);
        state.tabs[tab.tab_id] = { label: target, source: computed.source, ownName, nameSeenAt: sessionNameAt, writtenBy: true };
      } catch (err) {
        result.errors.push({ tabId: tab.tab_id, where: "rename", message: String(err?.message || err) });
        continue;
      }
    }
    result.renames.push({ tabId: tab.tab_id, from: tab.label, to: target, source: computed.source });
  }

  if (deps.persistState !== false) {
    try {
      saveState(cfg, state);
    } catch (err) {
      result.errors.push({ where: "state", message: String(err?.message || err) });
    }
  }
  return result;
}

/** Wrap a pass in the plugin lock. Concurrent events collapse to one pass. */
export function reconcileLocked(cfg, deps = {}) {
  const rmdir = deps.rmdir || ((p) => rmSync(p, { recursive: true, force: true }));
  const lock = takeLock(cfg, { rmdir });
  if (lock) return { renames: [], skipped: [], errors: [], locked: lock };
  try {
    return reconcile(cfg, { ...deps, rmdir });
  } finally {
    releaseLock(cfg, { rmdir });
  }
}