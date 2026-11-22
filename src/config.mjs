// config.mjs — defaults, config loading, and validation.
//
// Everything a user can tune lives in DEFAULTS. A user config.json is merged over
// it, then environment variables, then per-call overrides (CLI flags). The merged
// object is what the rest of the plugin sees, so no module reads process.env on
// its own except through here and paths.mjs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_DIR, pluginConfigDir, exists, legacyStateFile } from "./paths.mjs";

export { PLUGIN_DIR };

export const DEFAULTS = {
  // --- master switches ------------------------------------------------------
  enabled: true,
  dryRun: false,

  // --- what goes into the label --------------------------------------------
  nameTabs: true,
  tabContext: true, // the directory the pane is in
  showBranch: true, // the git branch of that directory
  agentTitles: true, // the task an agent reports in its terminal title

  // Name an agent tab after what its conversation is about, read from the agent's
  // own transcript. `sessionTask` is the heuristic (title / last human message);
  // `sessionName` is a name the human typed (`/name`), applied verbatim.
  sessionTask: true,
  sessionName: true,
  sessionTailBytes: 65536,

  // --- per-part budgets -----------------------------------------------------
  // Each part carries its own budget, so the whole label is bounded by
  // construction and there is no global number to keep in step with them.
  maxNameLen: 20, // program name / agent fallback / /name
  maxContextLen: 12, // directory
  maxBranchLen: 12, // branch
  maxTitleLen: 28, // agent task
  minTaskLen: 7, // a shorter task says nothing; fall back to the program
  maxTotalLen: 60, // last-resort clamp so a narrow sidebar cannot overflow

  contextSep: " \u203a ", // " › "

  // --- programs -------------------------------------------------------------
  // A shell or a throwaway command holds the tab steady instead of flickering.
  hideShell: false,
  shellName: "pwsh",
  shellPrograms: [
    "pwsh",
    "powershell",
    "cmd",
    "conhost",
    "openconsole",
    "bash",
    "zsh",
    "fish",
    "nu",
    "wsl",
  ],
  // Commands that name a transient action rather than a place of work: the tab
  // keeps the shell name while they run and returns to it afterwards.
  ignoredPrograms: [
    "ls",
    "dir",
    "cat",
    "type",
    "echo",
    "cd",
    "pwd",
    "cls",
    "clear",
    "which",
    "where",
    "head",
    "tail",
    "wc",
    "cp",
    "mv",
    "rm",
    "del",
    "mkdir",
    "touch",
  ],
  programAliases: {}, // { "clx": "hn" } — display-name overrides

  // --- agents ---------------------------------------------------------------
  // herdr knows the tab's own name ("worker-dst-1"); it says more than "pi".
  agentNameFallback: true,
  // Titles that name the agent rather than its work.
  titleIgnore: [
    "claude code",
    "codex cli",
    "gemini cli",
    "cursor agent",
    "aider",
    "chatgpt",
    "openai codex",
    "copilot",
    "qwen code",
  ],

  // --- git ------------------------------------------------------------------
  defaultBranches: ["main", "master"], // a branch equal to one of these says nothing

  // --- files ----------------------------------------------------------------
  // Relative paths are resolved against stateDir, which defaults to herdr's
  // per-plugin config directory (see paths.mjs). Never the plugin root: that is
  // replaced on every `herdr plugin update`.
  stateDir: "",
  stateFileName: "state.json",
  logFileName: "last-run.log",
  logMaxBytes: 128 * 1024,
  // sessions whose task was already computed are cached here
  cacheMaxSessions: 200,

  // --- safety rails ---------------------------------------------------------
  maxProcessLookups: 16, // `pane process-info` spawns per pass
  timeoutMs: 8000, // per herdr/git call
  herdrBin: "", // "" = `herdr` from PATH
};

/** Keys a user config.json may set. Anything else is reported, not applied. */
export const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));

const ARRAY_KEYS = ["shellPrograms", "ignoredPrograms", "defaultBranches", "titleIgnore"];
const NUMBER_KEYS = [
  "maxNameLen",
  "maxContextLen",
  "maxBranchLen",
  "maxTitleLen",
  "minTaskLen",
  "maxTotalLen",
  "sessionTailBytes",
  "logMaxBytes",
  "cacheMaxSessions",
  "maxProcessLookups",
  "timeoutMs",
];
const BOOLEAN_KEYS = [
  "enabled",
  "dryRun",
  "nameTabs",
  "tabContext",
  "showBranch",
  "agentTitles",
  "sessionTask",
  "sessionName",
  "hideShell",
  "agentNameFallback",
];

/**
 * Where a user config.json may live, lowest precedence last.
 *
 * 1. herdr's per-plugin config directory — where a user actually looks
 *    (%APPDATA%\herdr\plugins\config\<plugin-id>\config.json)
 * 2. the plugin root — so a checkout can carry its own config while developing
 *
 * `HERDR_AUTOMATIC_RENAME_CONFIG` (or the older `AR_CONFIG`) replaces the list.
 */
export function configCandidates(env = process.env) {
  return [join(pluginConfigDir(env), "config.json"), join(PLUGIN_DIR, "config.json")];
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * Coerce and validate the user's object. Unknown keys and unusable values are
 * collected in `warnings` instead of throwing: a typo must not stop the plugin,
 * and herdr would swallow the error anyway.
 */
function validate(user, warnings) {
  const out = {};
  for (const [key, value] of Object.entries(user)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`unknown config key "${key}" (ignored)`);
      continue;
    }
    if (BOOLEAN_KEYS.includes(key)) {
      if (typeof value === "boolean") out[key] = value;
      else warnings.push(`"${key}" must be true or false (ignored)`);
    } else if (NUMBER_KEYS.includes(key)) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out[key] = Math.floor(n);
      else warnings.push(`"${key}" must be a positive number (ignored)`);
    } else if (ARRAY_KEYS.includes(key)) {
      if (Array.isArray(value)) out[key] = value.map((s) => String(s).toLowerCase()).filter(Boolean);
      else warnings.push(`"${key}" must be an array of strings (ignored)`);
    } else if (key === "programAliases") {
      if (isPlainObject(value)) {
        out[key] = {};
        for (const [k, v] of Object.entries(value)) out[key][String(k).toLowerCase()] = String(v);
      } else warnings.push(`"programAliases" must be an object (ignored)`);
    } else if (key === "contextSep" || key === "shellName" || key === "stateDir" || key === "stateFileName" || key === "logFileName" || key === "herdrBin") {
      if (typeof value === "string") out[key] = value;
      else warnings.push(`"${key}" must be a string (ignored)`);
    } else {
      // any remaining string-typed key
      if (typeof value === "string") out[key] = value;
    }
  }
  return out;
}

/**
 * Load the effective configuration.
 * Returns the merged config plus `configPath` (files actually read) and
 * `warnings` (validation notes, also surfaced by `doctor`).
 */
export function loadConfig(env = process.env, overrides = {}) {
  const warnings = [];
  const explicit = env.HERDR_AUTOMATIC_RENAME_CONFIG || env.AR_CONFIG;
  const candidates = explicit ? [explicit] : configCandidates(env);

  let user = {};
  const read = [];
  for (const path of candidates) {
    if (!exists(path)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      // A broken config must not silently do nothing; surface it as a warning and
      // fall back to defaults so the plugin still works.
      warnings.push(`config unreadable (${path}): ${err.message}`);
      continue;
    }
    if (!isPlainObject(parsed)) {
      warnings.push(`config is not a JSON object (${path})`);
      continue;
    }
    user = { ...user, ...validate(parsed, warnings) };
    read.push(path);
  }

  const cfg = { ...DEFAULTS, ...user };

  // environment switches sit between the file and the command line
  if (env.HERDR_AUTOMATIC_RENAME_DISABLE === "1" || env.AR_DISABLE === "1") cfg.enabled = false;
  if (env.HERDR_AUTOMATIC_RENAME_DRY_RUN === "1" || env.AR_DRY_RUN === "1") cfg.dryRun = true;
  const onlyTab = env.HERDR_AUTOMATIC_RENAME_TAB || env.AR_ONLY_TAB;
  if (onlyTab) cfg.onlyTab = onlyTab;
  const logFile = env.HERDR_AUTOMATIC_RENAME_LOG || env.AR_LOG;
  if (logFile) cfg.logFile = logFile;
  if (env.HERDR_AUTOMATIC_RENAME_STATE_DIR) cfg.stateDir = env.HERDR_AUTOMATIC_RENAME_STATE_DIR;

  // CLI flags win over everything
  Object.assign(cfg, validate(overrides, warnings));

  if (!cfg.stateDir) cfg.stateDir = pluginConfigDir(env);
  if (!cfg.contextSep) cfg.contextSep = DEFAULTS.contextSep;

  // normalise list defaults that a config file may have replaced wholesale
  for (const key of ARRAY_KEYS) {
    if (!Array.isArray(cfg[key])) cfg[key] = DEFAULTS[key];
    if (cfg[key] !== DEFAULTS[key]) cfg[key] = cfg[key].map((s) => String(s).toLowerCase());
  }
  if (!isPlainObject(cfg.programAliases)) cfg.programAliases = {};

  return {
    ...cfg,
    configPath: read.length ? read.join(" + ") : candidates[candidates.length - 1],
    configFiles: read,
    warnings,
  };
}

/** The user's home directory, as herdr reports it in a pane's cwd. */
export function homeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || "";
}

/**
 * Where the state file lives. Moved out of the plugin root in 0.2 (herdr replaces
 * that directory on update), so an old file is reported once and migrated by the
 * caller rather than silently ignored.
 */
export function stateFileCandidates(cfg, env = process.env) {
  const primary = join(cfg.stateDir, cfg.stateFileName);
  const out = [primary];
  const legacy = legacyStateFile({ ...cfg, stateFileName: "state.json" });
  if (legacy !== primary) out.push(legacy);
  return out;
}