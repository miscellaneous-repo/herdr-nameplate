// main.mjs — entry point: argument parsing, logging, actions.

import { appendFileSync, existsSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, PLUGIN_DIR } from "./config.mjs";
import { reconcileLocked, reconcile } from "./reconcile.mjs";

const USAGE = `herdr-automatic-rename-win — tab naming for herdr on Windows

Usage:
  node bin/ar.mjs <event>            one reconcile pass (called by herdr)
  node bin/ar.mjs reset [tab-id]     forget our labels, opt the tab back in
  node bin/ar.mjs doctor [tab-id]    explain what a pass would do

Options:
  --dry-run        print the renames instead of applying them
  --tab <id>       only consider this tab (w6:t2)
  --json           machine-readable output
  --verbose        print the pass summary to stdout
  --help
`;

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") out.flags.dryRun = true;
    else if (a === "--json") out.flags.json = true;
    else if (a === "--verbose" || a === "-v") out.flags.verbose = true;
    else if (a === "--help" || a === "-h") out.flags.help = true;
    else if (a === "--tab") out.flags.tab = argv[++i];
    else if (a.startsWith("--tab=")) out.flags.tab = a.slice(6);
    else out.positional.push(a);
  }
  return out;
}

function logger(cfg, verbose) {
  const lines = [];
  const path = cfg.logFile || join(cfg.stateDir || PLUGIN_DIR, cfg.logFileName);
  return {
    add(line) {
      lines.push(line);
      if (verbose) process.stdout.write(`${line}\n`);
    },
    flush() {
      if (!lines.length) return;
      try {
        if (existsSync(path) && statSync(path).size > cfg.logMaxBytes) truncateSync(path, 0);
        appendFileSync(path, `[${new Date().toISOString()}] ${lines.join(" | ")}\n`);
      } catch {
        /* logging must never break a pass */
      }
    },
  };
}

export async function main(argv, deps = {}) {
  const args = parseArgs(argv);
  if (args.flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const overrides = {};
  if (args.flags.dryRun) overrides.dryRun = true;
  if (args.flags.tab) overrides.onlyTab = args.flags.tab;

  let cfg;
  try {
    cfg = loadConfig(deps.env || process.env, overrides);
  } catch (err) {
    process.stderr.write(`automatic-rename-win: ${err.message}\n`);
    return 1;
  }
  cfg.stateDir = cfg.stateDir || PLUGIN_DIR;

  if (!cfg.enabled) return 0;

  const log = logger(cfg, args.flags.verbose);
  const action = args.positional[0] || "startup";
  const event = { startedAt: Date.now(), event: action };

  let result;
  try {
    if (action === "reset") {
      result = resetTabs(cfg, args.flags.tab);
      log.add(`reset ${args.flags.tab || "all"}: ${result.cleared} tab(s)`);
    } else if (action === "doctor") {
      result = doctorPass(cfg, args.flags.tab, deps);
      if (!args.flags.json) {
        for (const row of result.rows) {
          process.stdout.write(`${row.tabId}  ${JSON.stringify(row.label)}  ->  ${JSON.stringify(row.target)}  (${row.source || "-"}; ${row.reason})\n`);
        }
      }
    } else {
      result = reconcileLocked(cfg, deps);
      if (result.locked) log.add(`skip: ${result.locked}`);
      else {
        log.add(`pass ${action}: ${result.renames.length} rename(s), ${result.skipped.length} skipped, ${result.errors.length} error(s)`);
        for (const r of result.renames) log.add(`${cfg.dryRun ? "would" : "did"} rename ${r.tabId}: ${JSON.stringify(r.from)} -> ${JSON.stringify(r.to)} (${r.source})`);
        for (const e of result.errors) log.add(`error ${e.tabId || e.where}: ${e.message}`);
      }
    }
  } catch (err) {
    process.stderr.write(`automatic-rename-win: pass failed: ${err?.message || err}\n`);
    log.add(`fatal: ${err?.message || err}`);
    log.flush();
    return 0; // an event handler that throws would only spam herdr's plugin log
  }

  event.durationMs = Date.now() - event.startedAt;
  log.add(`done in ${event.durationMs}ms`);
  log.flush();

  if (args.flags.json) process.stdout.write(`${JSON.stringify({ event, result }, null, 2)}\n`);
  else if (args.flags.verbose && result?.renames) {
    for (const r of result.renames) process.stdout.write(`${cfg.dryRun ? "would" : "did"} ${r.tabId}: ${r.from} -> ${r.to}\n`);
  }
  return 0;
}

function resetTabs(cfg, tabId) {
  const path = join(cfg.stateDir, cfg.stateFileName);
  let state = { tabs: {} };
  if (existsSync(path)) {
    try {
      state = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      state = { tabs: {} };
    }
  }
  let cleared = 0;
  for (const id of Object.keys(state.tabs || {})) {
    if (!tabId || id === tabId) {
      delete state.tabs[id];
      cleared += 1;
    }
  }
  writeFileSync(path, JSON.stringify(state, null, 2));
  return { cleared, tabId: tabId || null };
}

function doctorPass(cfg, tabId, deps) {
  const dry = { ...cfg, dryRun: true, onlyTab: tabId || cfg.onlyTab };
  const result = reconcile(dry, { ...deps, persistState: false });
  const rows = [];
  for (const r of result.renames) rows.push({ tabId: r.tabId, label: r.from, target: r.to, source: r.source, reason: "would rename" });
  for (const s of result.skipped) rows.push({ tabId: s.tabId, label: s.label, target: "", source: "", reason: s.reason });
  return { rows, errors: result.errors };
}