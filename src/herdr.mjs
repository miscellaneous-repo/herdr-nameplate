// herdr.mjs — the only module that runs external commands. Everything else
// works on plain objects, which keeps the rules testable and the failures
// concentrated in one place.

import { execFileSync } from "node:child_process";

export function makeHerdr(cfg, deps = {}) {
  const bin = cfg.herdrBin || "herdr";
  const run = deps.run || ((args) => execFileSync(bin, args, { encoding: "utf8", timeout: cfg.timeoutMs, windowsHide: true }));

  return {
    /** Live snapshot: { tabs, panes, workspaces, agents }. */
    snapshot() {
      const raw = run(["api", "snapshot"]);
      const parsed = JSON.parse(raw);
      const snap = parsed?.result?.snapshot ?? parsed?.snapshot;
      if (!snap) throw new Error("unexpected snapshot shape");
      return snap;
    },

    /** { foreground_processes: [{ argv0, argv, cwd }], shell_pid } */
    processInfo(paneId) {
      const raw = run(["pane", "process-info", "--pane", paneId]);
      const parsed = JSON.parse(raw);
      return parsed?.result?.process_info ?? null;
    },

    renameTab(tabId, label) {
      return run(["tab", "rename", tabId, label]);
    },

    currentPane() {
      const raw = run(["pane", "current"]);
      const parsed = JSON.parse(raw);
      return parsed?.result?.pane?.pane_id ?? null;
    },
  };
}