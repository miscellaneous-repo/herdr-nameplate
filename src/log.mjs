// log.mjs — a pass-scoped logger that never throws.
//
// herdr runs one process per event and nobody reads stdout, so the only useful
// sink is a file. Logging must never be the reason a pass fails: every write is
// wrapped, and the file is emptied (not rotated) once it passes its budget.

import { appendFileSync, existsSync, mkdirSync, statSync, truncateSync } from "node:fs";
import { dirname, join } from "node:path";
import { PLUGIN_DIR } from "./paths.mjs";

export function logPath(cfg) {
  return cfg.logFile || join(cfg.stateDir || PLUGIN_DIR, cfg.logFileName);
}

/**
 * @param {object} cfg      effective config
 * @param {object} options  { verbose: boolean, stream: writable, quiet: boolean }
 */
export function createLogger(cfg, options = {}) {
  const lines = [];
  const stream = options.stream || process.stdout;
  const verbose = Boolean(options.verbose);
  const path = logPath(cfg);

  return {
    path,
    /** Record a line for the log file, and echo it when running interactively. */
    add(line) {
      const text = String(line);
      lines.push(text);
      if (verbose && !options.quiet) {
        try {
          stream.write(`${text}\n`);
        } catch {
          /* ignore */
        }
      }
    },
    flush() {
      if (!lines.length) return;
      try {
        mkdirSync(dirname(path), { recursive: true });
        if (existsSync(path) && statSync(path).size > cfg.logMaxBytes) truncateSync(path, 0);
        appendFileSync(path, `[${new Date().toISOString()}] ${lines.join(" | ")}\n`);
      } catch {
        /* logging must never break a pass */
      }
      lines.length = 0;
    },
  };
}
