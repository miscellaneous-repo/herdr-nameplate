// config.mjs — defaults + config.json loader.
//
// Status: P1 port. Numbering ([N] prefixes), workspace naming and pane-border
// topics are deliberately absent; see README "P1 scope".

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULTS = {
  // master switches
  enabled: true,
  dryRun: false,

  // naming halves
  nameTabs: true,
  tabContext: true, // show the directory
  showBranch: true, // show the git branch

  // Name an agent tab after what its conversation is about, read from the agent's
  // own session file. `sessionTailBytes` bounds the read; the last human message
  // is always near the end.
  sessionTask: true,
  // A name the human gave the session (`/name`, `-n/--name`) is applied verbatim.
  sessionName: true,
  sessionTailBytes: 65536,
  agentTitles: true, // name an agent tab after the task in its terminal title

  // per-part budgets. Each part carries its own, so the whole is bounded by
  // construction and there is no global budget to keep in step with them.
  maxNameLen: 20, // program name / agent fallback
  maxContextLen: 12, // directory
  maxBranchLen: 12, // branch
  maxTitleLen: 28, // agent task
  minTaskLen: 7, // a shorter task says nothing; fall back to the program
  maxTotalLen: 60, // last-resort clamp so a narrow sidebar never overflows

  contextSep: " \u203a ", // " › "

  // shells and throwaway commands hold the tab steady instead of flickering.
  hideShell: false,
  // when an agent reports no usable task title, fall back to the tab's own herdr
  // name ("worker-dst-1") instead of the bare agent kind ("pi")
  agentNameFallback: true,
  shellName: "pwsh",
  shellPrograms: ["pwsh", "powershell", "cmd", "conhost", "bash", "zsh", "fish", "nu", "wsl", "OpenConsole"],
  ignoredPrograms: ["ls", "dir", "cat", "type", "echo", "cd", "pwd", "cls", "clear", "which", "where", "head", "tail", "wc", "cp", "mv", "rm", "del", "mkdir", "touch", "git"], // "git" removed below by default; see NOTE

  // exact program renames: { "clx": "hn" }
  programAliases: {},

  // a branch equal to one of these adds nothing to the tab
  defaultBranches: ["main", "master"],

  // titles that name the agent rather than its work
  titleIgnore: [
    "claude code", "codex cli", "gemini cli", "cursor agent", "aider",
    "chatgpt", "openai codex", "copilot", "qwen code",
  ],

  // derived: a title is also refused when it equals the agent kind, the agent
  // kind plus "code"/"cli", or the pane's own directory name.

  // safety rails
  maxProcessLookups: 16, // per pass
  herdrBin: "", // "" = use `herdr` from PATH
  timeoutMs: 8000, // per herdr call
  stateFileName: ".state.json",
  logFileName: "last-run.log",
  logMaxBytes: 128 * 1024,
};

// NOTE: git is a *transient* program, not an ignored one: "git" alone means the
// user is reading status and will return to the prompt. Keeping it in
// ignoredPrograms would hold the tab at "pwsh". Drop it here so the default
// behaves like the original's IGNORED_PROGRAMS (which has no git either).
DEFAULTS.ignoredPrograms = DEFAULTS.ignoredPrograms.filter((p) => p !== "git");

/**
 * Where a user config.json may live, lowest precedence first.
 *
 * herdr hands every plugin a config directory of its own
 * (%APPDATA%/herdr/plugins/config/<id>), which is where a user expects to put
 * settings; the plugin root is also honoured so a checkout can carry its own
 * config.json while developing.
 */
export function configCandidates(env = process.env) {
  const out = [];
  const appData = env.APPDATA || (env.USERPROFILE ? join(env.USERPROFILE, "AppData", "Roaming") : "");
  const id = PLUGIN_DIR.split(/[\\/]/).pop();
  if (env.HERDR_PLUGIN_CONFIG_DIR) out.push(join(env.HERDR_PLUGIN_CONFIG_DIR, "config.json"));
  else if (appData) out.push(join(appData, "herdr", "plugins", "config", id, "config.json"));
  out.push(join(PLUGIN_DIR, "config.json"));
  return out;
}

export function loadConfig(env = process.env, overrides = {}) {
  const candidates = env.AR_CONFIG ? [env.AR_CONFIG] : configCandidates(env);
  const read = [];
  let user = {};
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch (err) {
      throw new Error(`config unreadable: ${p}: ${err.message}`);
    }
    if (parsed && typeof parsed === "object") {
      user = { ...user, ...parsed };
      read.push(p);
    }
  }
  const configPath = read.length ? read.join(" + ") : candidates[candidates.length - 1];
  const cfg = { ...DEFAULTS, ...user, ...overrides };

  if (env.AR_DISABLE === "1") cfg.enabled = false;
  if (env.AR_DRY_RUN === "1") cfg.dryRun = true;
  if (env.AR_ONLY_TAB) cfg.onlyTab = env.AR_ONLY_TAB;
  if (env.AR_LOG) cfg.logFile = env.AR_LOG;

  // normalise the lists so a config file can replace them wholesale
  for (const key of ["shellPrograms", "ignoredPrograms", "defaultBranches", "titleIgnore"]) {
    if (!Array.isArray(cfg[key])) cfg[key] = DEFAULTS[key];
    cfg[key] = cfg[key].map((s) => String(s).toLowerCase());
  }
  if (!cfg.programAliases || typeof cfg.programAliases !== "object") cfg.programAliases = {};

  return { ...cfg, configPath };
}

export function homeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || "";
}
