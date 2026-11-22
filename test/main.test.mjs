// main.test.mjs — the CLI surface: flags, doctor, reset. No real herdr.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseArgs } from "../src/main.mjs";
import { loadState, saveState, STATE_VERSION } from "../src/state.mjs";

function capture(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  return Promise.resolve(fn())
    .then((code) => ({ code, out: chunks.join("") }))
    .finally(() => {
      process.stdout.write = original;
    });
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "ar-main-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir: dir }));
  return { dir, env: { HERDR_AUTOMATIC_RENAME_CONFIG: join(dir, "config.json"), USERPROFILE: "C:\\Users\\x" }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("cli: parseArgs understands the documented flags", () => {
  const args = parseArgs(["doctor", "--tab", "w6:t2", "--json", "--dry-run", "-v"]);
  assert.deepEqual(args.positional, ["doctor"]);
  assert.equal(args.flags.tab, "w6:t2");
  assert.equal(args.flags.json, true);
  assert.equal(args.flags.dryRun, true);
  assert.equal(args.flags.verbose, true);
  assert.equal(parseArgs(["--tab=w1:t1"]).flags.tab, "w1:t1");
});

test("cli: --version prints the package version", async () => {
  const box = sandbox();
  try {
    const { code, out } = await capture(() => main(["--version"], { env: box.env }));
    assert.equal(code, 0);
    assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
  } finally {
    box.done();
  }
});

test("cli: --help prints usage without touching herdr", async () => {
  const box = sandbox();
  try {
    const { code, out } = await capture(() => main(["--help"], { env: box.env }));
    assert.equal(code, 0);
    assert.match(out, /herdr-automatic-rename/);
    assert.match(out, /doctor/);
  } finally {
    box.done();
  }
});

test("cli: doctor reports rows, config path and versions, and writes nothing", async () => {
  const box = sandbox();
  try {
    const herdr = {
      snapshot: () => ({
        tabs: [{ tab_id: "w1:t1", label: "1", workspace_id: "w1", pane_count: 1, focused: true }],
        panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", cwd: "G:\\Herdr", focused: true, agent: null }],
        workspaces: [{ workspace_id: "w1", label: "Herdr" }],
        agents: [],
      }),
      processInfo: () => ({ foreground_processes: [{ argv0: "C:\\pwsh.exe", argv: [] }] }),
      renameTab: () => {
        throw new Error("doctor must not rename");
      },
    };
    const { code, out } = await capture(() =>
      main(["doctor"], {
        env: box.env,
        herdr,
        git: () => "",
        run: () => "herdr 0.9.5",
      }),
    );
    assert.equal(code, 0);
    assert.match(out, /w1:t1/);
    assert.match(out, /config: /);
    assert.match(out, /herdr:\s+0\.9\.5/);
    assert.equal(existsSync(join(box.dir, "state.json")), false);
  } finally {
    box.done();
  }
});

test("cli: reset clears the remembered labels", async () => {
  const box = sandbox();
  try {
    saveState({ stateDir: box.dir, stateFileName: "state.json" }, {
      version: STATE_VERSION,
      tabs: { "w1:t1": { label: "x" }, "w1:t2": { label: "y" } },
      sessions: {},
    });
    const { code, out } = await capture(() => main(["reset", "--tab", "w1:t1"], { env: box.env }));
    assert.equal(code, 0);
    assert.match(out, /reset w1:t1/);
    const { state } = loadState({ stateDir: box.dir, stateFileName: "state.json" });
    assert.deepEqual(Object.keys(state.tabs), ["w1:t2"]);
  } finally {
    box.done();
  }
});

test("cli: a disabled plugin exits quietly", async () => {
  const box = sandbox();
  try {
    const { code, out } = await capture(() => main(["startup"], { env: { ...box.env, HERDR_AUTOMATIC_RENAME_DISABLE: "1" } }));
    assert.equal(code, 0);
    assert.equal(out, "");
  } finally {
    box.done();
  }
});
