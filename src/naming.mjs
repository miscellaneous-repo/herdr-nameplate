// naming.mjs — pure name computation. String in / string out, no herdr and no
// filesystem, so the whole rule set is unit-testable (see test/naming.test.mjs).
//
// A tab is named "<context> › <branch> › <activity>", any part of which may be
// empty.  activity = the agent's task when it reports one, else the foreground
// program, else a shell name, else nothing.

import { scrub, truncate, displayWidth, stripLeadingGlyphs, stripTrailingGlyph } from "./text.mjs";

const WIN_EXT = /\.(exe|cmd|bat|com)$/i;

/** Basename of a path, without a Windows executable extension. */
export function programName(argv0) {
  if (!argv0) return "";
  const base = String(argv0).split(/[\\/]/).pop() || "";
  return base.replace(WIN_EXT, "");
}

/** Lowercase, for every case-insensitive comparison in this module. */
function lc(s) {
  return String(s || "").toLowerCase();
}

// Shells that take "the script to run" as a bare positional argument. PowerShell is
// deliberately absent: herdr starts it as `pwsh -NoExit -Command <prompt hook>` and a
// `-Command` payload is script text, not a program name.
const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const PATH_LIKE = /[\\/]|\.(sh|bash|zsh|fish|py|ps1|cmd|bat|exe|mjs|cjs|js)$/i;

/**
 * Resolve a program to the name shown in the tab.
 * Returns { name, isShell, isIgnored }.
 *
 * `argv` matters only for POSIX shells: an agent started through a Git-Bash shim
 * arrives as `sh.exe /e/.../prefix/pi`, so the shim's path is the real program.
 */
export function classifyProgram(program, cfg, argv = []) {
  const p = lc(programName(program));
  if (!p) return { name: "", isShell: true, isIgnored: false };
  if (cfg.programAliases[p]) return { name: cfg.programAliases[p], isShell: false, isIgnored: false };
  if (cfg.ignoredPrograms.includes(p)) return { name: "", isShell: true, isIgnored: true };

  const shellLike = cfg.shellPrograms.includes(p) || POSIX_SHELLS.has(p) || ["pwsh", "powershell", "cmd"].includes(p);
  if (shellLike) {
    if (POSIX_SHELLS.has(p) && Array.isArray(argv)) {
      const arg = argv.find((a, i) => i > 0 && typeof a === "string" && !a.startsWith("-") && PATH_LIKE.test(a));
      const inner = arg ? programName(String(arg).split(/\s+/)[0]) : "";
      if (inner) return { name: cfg.programAliases[lc(inner)] || lc(inner), isShell: false, isIgnored: false };
    }
    return { name: cfg.hideShell ? "" : cfg.shellName, isShell: true, isIgnored: false };
  }
  return { name: p, isShell: false, isIgnored: false };
}

// Programs whose command line gives away the agent even when argv[0] is a plain
// interpreter. `node .../pi-coding-agent/dist/bundle/cli.js` must read "pi", not
// "node"; the same holds for npm-fronted claude/codex installs.
const CMDLINE_AGENTS = [
  [/pi-coding-agent/i, "pi"],
  // npm-global and git-bash shims: ".../prefix/pi --model ...", "sh.exe /e/.../prefix/pi"
  [/[\\/]pi(?:\.exe|\.cmd|\.ps1|\.mjs)?(?:\s|$)/i, "pi"],
  [/claude-code|@anthropic-ai[\\/]claude|[\\/]claude(?:\.exe|\.cmd)?(?:\s|$)/i, "claude"],
  [/codex-cli|@openai[\\/]codex|[\\/]codex(?:\.exe|\.cmd)?(?:\s|$)/i, "codex"],
  [/gemini-cli|@google[\\/]gemini|[\\/]gemini(?:\.exe|\.cmd)?(?:\s|$)/i, "gemini"],
];

/** The agent a foreground command line belongs to, or "". */
export function agentFromCmdline(argv) {
  const line = Array.isArray(argv) ? argv.join(" ") : "";
  if (!line) return "";
  for (const [re, name] of CMDLINE_AGENTS) if (re.test(line)) return name;
  return "";
}

/** The directory part of a label, or "" when it adds nothing. */
export function contextDir(cwd, workspaceLabel, cfg, home) {
  if (!cfg.tabContext) return "";
  let dir = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!dir) return "";
  if (home && dir.toLowerCase() === home.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()) return "";
  const base = dir.split("/").pop() || "";
  if (!base) return "";
  // a directory that repeats its workspace says nothing new
  if (workspaceLabel && lc(base) === lc(workspaceLabel)) return "";
  return truncate(base, cfg.maxContextLen);
}

/**
 * The branch part. `branch` must already be a bare branch name ("" when the cwd
 * is not a repo, or when HEAD is detached).
 */
export function branchLabel(branch, cfg) {
  if (!cfg.showBranch) return "";
  const b = scrub(branch);
  if (!b || b === "HEAD") return "";
  if (cfg.defaultBranches.includes(lc(b))) return "";
  return truncate(b, cfg.maxBranchLen);
}

/** The task an agent reports in its terminal title, or "" when it reports none. */
export function taskFromTitle(title, ctx) {
  if (!ctx.cfg.agentTitles) return "";
  let t = stripTrailingGlyph(stripLeadingGlyphs(title || ""));
  if (!t) return "";
  // a bare number is herdr's own label handed back, not a task
  if (/^\d+$/.test(t)) return "";

  const refused = new Set([
    ...ctx.cfg.titleIgnore.map(lc),
    lc(ctx.kind || ""),
    lc(`${ctx.kind || ""} code`),
    lc(`${ctx.kind || ""} cli`),
  ]);
  if (ctx.dirName) refused.add(lc(ctx.dirName));

  const saysNothing = (s) => {
    const lower = lc(s);
    if (!lower) return true;
    if (refused.has(lower)) return true;
    // short titles are usually a status ("ready") rather than a task
    if (lower.replace(/\s+/g, "").length < ctx.cfg.minTaskLen && displayWidth(s) < 4) return true;
    return false;
  };

  // A title often carries the agent's own mark in front of a separator:
  // "\u03c0 - workflow", "\u2733 - Squash merge command". The part left of a spaced
  // separator is the agent's mark, so only the remainder is weighed -- and when
  // that remainder says nothing either, the whole title says nothing. A spaced
  // separator is required on purpose: "codex-cli" is one word, not a mark plus
  // a task.
  const sep = t.match(/^(.{1,6}?)\s+[-\u2013\u2014:|\u00b7]\s+(.+)$/u);
  if (sep && sep[2]) {
    const rest = sep[2];
    return saysNothing(rest) ? "" : truncate(rest, ctx.cfg.maxTitleLen);
  }

  return saysNothing(t) ? "" : truncate(t, ctx.cfg.maxTitleLen);
}

/**
 * Compose the three parts. Returns "" when there is no activity at all: a tab
 * with nothing to say keeps herdr's own label.
 */
export function compose(ctx, branch, activity, cfg) {
  const parts = [ctx, branch, activity].filter((p) => p && p.length);
  if (!parts.length) return "";
  const out = scrub(parts.join(cfg.contextSep));
  return out.length > cfg.maxTotalLen ? truncate(out, cfg.maxTotalLen) : out;
}

/**
 * Compute the label for one tab.
 *
 * input = {
 *   cwd, workspaceLabel, branch,
 *   agent: { kind, title } | null,
 *   foreground: { argv0, argv } | null,
 * }
 */
export function computeLabel(input, cfg, home) {
  const ctx = contextDir(input.cwd, input.workspaceLabel, cfg, home);
  const branch = branchLabel(input.branch, cfg);

  const dirName = String(input.cwd || "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "";

  // agent tabs are named after the task when one is reported
  if (input.agent) {
    // The human named this session themselves (`/name`, `--name`). That is a
    // finished label, not a fragment: it is used verbatim, without the
    // `context › branch ›` scaffolding and without condensing.
    if (cfg.sessionName !== false && input.agent.sessionName) {
      const label = truncate(scrub(input.agent.sessionName), cfg.maxNameLen);
      if (label) return { label, source: "session-name", ctx, branch, activity: label, sessionName: label };
    }

    // The agent's own transcript is the truest answer to "what is this
    // conversation doing": a pi title is often just "π - <directory>".
    if (cfg.sessionTask !== false && input.agent.sessionTask) {
      const activity = truncate(scrub(input.agent.sessionTask), cfg.maxTitleLen);
      if (activity) return { label: compose(ctx, branch, activity, cfg), source: "session-task", ctx, branch, activity };
    }

    let task = taskFromTitle(input.agent.title, { cfg, kind: input.agent.kind, dirName });
    // a task that begins with the directory it lives in repeats the label's own
    // context part ("Herdr › Herdr fleet mgr handoff")
    if (task && ctx) {
      const prefix = new RegExp(`^${ctx.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\u00b7-]?\\s*`, "i");
      const peeled = task.replace(prefix, "");
      if (peeled && peeled !== task) task = peeled;
    }
    if (task) return { label: compose(ctx, branch, task, cfg), source: "agent-title", ctx, branch, activity: task };

    // No task reported (idle agent, or a title that only repeats the directory).
    // herdr knows the tab's own name — "worker-dst-1" says far more than "pi",
    // and it keeps sibling tabs from all reading "workflow › pi".
    if (cfg.agentNameFallback !== false) {
      const own = scrub(input.agent.name || "");
      if (own && !/^\d+$/.test(own) && displayWidth(own) >= 3) {
        const activity = truncate(own, cfg.maxNameLen);
        return { label: compose(ctx, branch, activity, cfg), source: "agent-name", ctx, branch, activity };
      }
    }
  }

  const fg = input.foreground;
  if (fg && (fg.argv0 || fg.argv)) {
    // an agent hidden behind a plain interpreter or a shell shim keeps its name
    const hinted = agentFromCmdline(fg.argv);
    if (hinted) {
      const name = truncate(cfg.programAliases[hinted] || hinted, cfg.maxNameLen);
      return { label: compose(ctx, branch, name, cfg), source: "agent-cmdline", ctx, branch, activity: name };
    }
    const { name, isIgnored } = classifyProgram(fg.argv0, cfg, fg.argv);
    if (isIgnored) return { label: compose(ctx, branch, cfg.hideShell ? "" : cfg.shellName, cfg), source: "ignored-program", ctx, branch, activity: cfg.shellName };
    if (name) {
      // do not repeat the directory in the activity slot
      const activity = ctx && lc(name) === lc(ctx) ? "" : truncate(name, cfg.maxNameLen);
      return { label: compose(ctx, branch, activity, cfg), source: input.agent ? "agent-program" : "program", ctx, branch, activity };
    }
  }

  // no process information (process-info failed, or a pane we did not look up)
  if (input.agent) {
    const name = truncate(cfg.programAliases[input.agent.kind] || input.agent.kind, cfg.maxNameLen);
    return { label: compose(ctx, branch, name, cfg), source: "agent-kind", ctx, branch, activity: name };
  }

  // bare prompt
  const shell = cfg.hideShell ? "" : cfg.shellName;
  return { label: compose(ctx, branch, shell, cfg), source: "shell", ctx, branch, activity: shell };
}