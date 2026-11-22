// main.mjs — CLI entry: argument parsing, logging, the three actions.
//
// herdr spawns `node bin/ar.mjs <event>` for every event it subscribes to, one
// process per event, and ignores stdout. So:
//
//   * a pass must always exit 0 — throwing just spams herdr's plugin log;
//   * anything worth reading later goes to the log file, not stdout;
//   * `doctor` and `reset` are the interactive entry points, and those do print.

import { loadConfig } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { clearTabs, loadState } from "./state.mjs";
import { herdrVersion } from "./herdr.mjs";
import { reconcile, reconcileLocked } from "./reconcile.mjs";
import { VERSION } from "./version.mjs";

const USAGE = `herdr-automatic-rename-win ${VERSION} — tab naming for herdr on Windows

Usage:
  herdr-automatic-rename <event>        one reconcile pass (herdr calls this)
  herdr-automatic-rename doctor         explain what a pass would do
  herdr-automatic-rename reset [tab]    forget our labels, opt the tab back in

Options:
  --dry-run          compute, print, change nothing
  --tab <id>         only consider this tab (e.g. w6:t2)
  --json             machine-readable output
  --verbose, -v      echo the pass summary
  --version, -V      print the version
  --help, -h         print this help

Configuration lives in herdr's plugin config directory:
  %APPDATA%\\herdr\\plugins\\config\\herdr-automatic-rename-win\\config.json
`;

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") out.flags.dryRun = true;
    else if (a === "--json") out.flags.json = true;
    else if (a === "--verbose" || a === "-v") out.flags.verbose = true;
    else if (a === "--help" || a === "-h") out.flags.help = true;
    else if (a === "--version" || a === "-V") out.flags.version = true;
    else if (a === "--tab") out.flags.tab = argv[++i];
    else if (a.startsWith("--tab=")) out.flags.tab = a.slice("--tab=".length);
    else out.positional.push(a);
  }
  return out;
}

/** Print doctor rows in the terse "current -> target (source; reason)" form. */
function printRows(rows) {
  for (const row of rows) {
    const target = row.target ? ` -> ${JSON.stringify(row.target)}` : "";
    const source = row.source || "-";
    process.stdout.write(`${row.tabId}  ${JSON.stringify(row.label)}${target}  (${source}; ${row.reason})\n`);
  }
}

export async function main(argv, deps = {}) {
  const args = parseArgs(argv);
  const env = deps.env || process.env;

  if (args.flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const overrides = {};
  if (args.flags.dryRun) overrides.dryRun = true;
  if (args.flags.tab) overrides.onlyTab = args.flags.tab;

  const cfg = loadConfig(env, overrides);
  if (!cfg.enabled) return 0;

  const action = args.positional[0] || "startup";
  const log = createLogger(cfg, { verbose: args.flags.verbose });
  const startedAt = Date.now();
  const payload = { event: action, version: VERSION };

  try {
    if (action === "reset") {
      const tabId = args.flags.tab || args.positional[1] || "";
      const cleared = clearTabs(cfg, tabId);
      payload.result = { cleared, tabId: tabId || null };
      log.add(`reset ${tabId || "all"}: ${cleared} tab(s)`);
      if (!args.flags.json) process.stdout.write(`reset ${tabId || "all"}: ${cleared} tab(s)\n`);
    } else if (action === "doctor") {
      const dry = { ...cfg, dryRun: true, onlyTab: args.flags.tab || cfg.onlyTab };
      const result = reconcile(dry, { ...deps, persistState: false });
      const rows = [];
      for (const r of result.renames) rows.push({ tabId: r.tabId, label: r.from, target: r.to, source: r.source, reason: "would rename" });
      for (const s of result.skipped) rows.push({ tabId: s.tabId, label: s.label, target: "", source: "", reason: s.reason });
      payload.result = { rows, errors: result.errors };

      if (!args.flags.json) {
        printRows(rows);
        const v = herdrVersion(cfg, deps);
        process.stdout.write(`\nconfig: ${cfg.configPath}\n`);
        for (const w of cfg.warnings) process.stdout.write(`config warning: ${w}\n`);
        process.stdout.write(`state:  ${loadState(cfg).path}\n`);
        process.stdout.write(`herdr:  ${v.ok ? v.version : `not found (${v.error})`}\n`);
        process.stdout.write(`node:   ${process.version}\n`);
        if (result.errors.length) {
          process.stdout.write(`errors: ${result.errors.length}\n`);
          for (const e of result.errors) process.stdout.write(`  ${e.tabId || e.where}: ${e.message}\n`);
        }
      }
    } else {
      const result = reconcileLocked(cfg, deps);
      payload.result = result;
      if (result.locked) log.add(`skip: ${result.locked}`);
      else {
        log.add(`pass ${action}: ${result.renames.length} rename(s), ${result.skipped.length} skipped, ${result.errors.length} error(s)`);
        for (const r of result.renames) {
          log.add(`${cfg.dryRun ? "would" : "did"} rename ${r.tabId}: ${JSON.stringify(r.from)} -> ${JSON.stringify(r.to)} (${r.source})`);
        }
        for (const e of result.errors) log.add(`error ${e.tabId || e.where}: ${e.message}`);
      }
    }
  } catch (err) {
    // An event handler that throws would only spam herdr's plugin log; the file
    // keeps the reason for the next `doctor`.
    log.add(`fatal: ${err?.message || err}`);
    log.flush();
    if (action === "doctor") {
      process.stderr.write(`automatic-rename-win: ${err?.message || err}\n`);
      return 1;
    }
    return 0;
  }

  payload.durationMs = Date.now() - startedAt;
  log.add(`done in ${payload.durationMs}ms`);
  log.flush();

  if (args.flags.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else if (args.flags.verbose && Array.isArray(payload.result?.renames)) {
    for (const r of payload.result.renames) {
      process.stdout.write(`${cfg.dryRun ? "would" : "did"} ${r.tabId}: ${r.from} -> ${r.to}\n`);
    }
  }
  return 0;
}

export { parseArgs, USAGE };
