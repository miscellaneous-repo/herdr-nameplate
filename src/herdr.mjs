// herdr.mjs — the only module that runs herdr. Everything else works on plain
// objects, which keeps the rules testable and the process failures in one place.

import { execFileSync } from "node:child_process";

/**
 * @param {object} cfg      effective config (herdrBin, timeoutMs)
 * @param {object} deps     { run(args) } for tests
 */
export function createHerdrClient(cfg, deps = {}) {
  const bin = cfg.herdrBin || "herdr";
  const run =
    deps.run ||
    ((args) => {
      try {
        return execFileSync(bin, args, {
          encoding: "utf8",
          timeout: cfg.timeoutMs,
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
          // stderr is not useful for a CLI call that either parses or fails
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch (err) {
        // execFileSync's ENOENT message is the opaque "spawnSync herdr ENOENT";
        // say what to do about it instead.
        if (err?.code === "ENOENT") throw new Error(`herdr not found (${bin}); put herdr on PATH or set herdrBin in config.json`);
        throw err;
      }
    });

  const parse = (raw, what) => {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`herdr ${what} returned non-JSON output`);
    }
  };

  return {
    /** Live state: { tabs, panes, workspaces, agents }. */
    snapshot() {
      const parsed = parse(run(["api", "snapshot"]), "api snapshot");
      const snap = parsed?.result?.snapshot ?? parsed?.snapshot;
      if (!snap) throw new Error("herdr api snapshot: unexpected shape");
      return snap;
    },

    /**
     * Foreground processes of one pane. herdr has no "foreground changed" event
     * and does not include process info in the snapshot, so this is the only way
     * to see the program running in a pane.
     */
    processInfo(paneId) {
      const parsed = parse(run(["pane", "process-info", "--pane", paneId]), "pane process-info");
      return parsed?.result?.process_info ?? null;
    },

    renameTab(tabId, label) {
      run(["tab", "rename", tabId, label]);
    },

    /** The pane the CLI was invoked from, if any. */
    currentPane() {
      try {
        const parsed = parse(run(["pane", "current"]), "pane current");
        return parsed?.result?.pane?.pane_id ?? null;
      } catch {
        return null;
      }
    },
  };
}

/** Detect the installed herdr CLI. Returns { ok, version, error }. */
export function herdrVersion(cfg, deps = {}) {
  const bin = cfg?.herdrBin || "herdr";
  const run =
    deps.run ||
    ((args) =>
      execFileSync(bin, args, {
        encoding: "utf8",
        timeout: cfg?.timeoutMs || 8000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }));
  try {
    const out = String(run(["--version"])).trim();
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return { ok: true, version: m ? m[1] : out, error: "" };
  } catch (err) {
    return { ok: false, version: "", error: String(err?.message || err) };
  }
}
