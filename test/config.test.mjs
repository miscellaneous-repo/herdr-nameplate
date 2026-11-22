// config.test.mjs — defaults, precedence, and the validation that must never throw.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, configCandidates, loadConfig } from "../src/config.mjs";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "ar-config-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const writeConfig = (path, value) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
};

test("config: no file means defaults, and stateDir points at herdr's config directory", () => {
  const box = sandbox();
  try {
    const cfg = loadConfig({ APPDATA: box.dir, USERPROFILE: "C:\\Users\\x" });
    assert.equal(cfg.tabContext, DEFAULTS.tabContext);
    assert.equal(cfg.sessionName, true);
    assert.match(cfg.stateDir, /plugins[\\/]config[\\/]herdr-automatic-rename-win$/);
    assert.deepEqual(cfg.warnings, []);
  } finally {
    box.done();
  }
});

test("config: candidates put herdr's config dir before the plugin root", () => {
  const list = configCandidates({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" });
  assert.equal(list.length, 2);
  assert.match(list[0], /AppData[\\/]Roaming[\\/]herdr[\\/]plugins[\\/]config/);
  assert.match(list[1], /herdr-automatic-rename-win[\\/]config\.json$/);
});

test("config: HERDR_PLUGIN_CONFIG_DIR moves the per-plugin directory", () => {
  const box = sandbox();
  try {
    const cfg = loadConfig({ APPDATA: "C:\\nope", HERDR_PLUGIN_CONFIG_DIR: box.dir });
    assert.equal(cfg.stateDir, box.dir);
  } finally {
    box.done();
  }
});

test("config: an explicit file is merged over the defaults", () => {
  const box = sandbox();
  try {
    const file = join(box.dir, "config.json");
    writeConfig(file, { tabContext: false, showBranch: false, maxNameLen: 30 });
    const cfg = loadConfig({ HERDR_AUTOMATIC_RENAME_CONFIG: file });
    assert.equal(cfg.tabContext, false);
    assert.equal(cfg.showBranch, false);
    assert.equal(cfg.maxNameLen, 30);
    assert.equal(cfg.configPath, file);
    assert.equal(cfg.sessionTask, true); // untouched default survives
  } finally {
    box.done();
  }
});

test("config: the old AR_CONFIG name still works", () => {
  const box = sandbox();
  try {
    const file = join(box.dir, "config.json");
    writeConfig(file, { hideShell: true });
    const cfg = loadConfig({ AR_CONFIG: file });
    assert.equal(cfg.hideShell, true);
  } finally {
    box.done();
  }
});

test("config: unknown keys and wrong types are warnings, not failures", () => {
  const box = sandbox();
  try {
    const file = join(box.dir, "config.json");
    writeConfig(file, { tabContex: false, maxNameLen: "wide", shellPrograms: "pwsh", programAliases: { CLX: "hn" } });
    const cfg = loadConfig({ HERDR_AUTOMATIC_RENAME_CONFIG: file });
    assert.equal(cfg.tabContext, DEFAULTS.tabContext); // typo ignored
    assert.equal(cfg.maxNameLen, DEFAULTS.maxNameLen); // bad type ignored
    assert.deepEqual(cfg.programAliases, { clx: "hn" });
    assert.equal(cfg.warnings.length, 3);
    assert.ok(cfg.warnings.some((w) => w.includes("tabContex")));
  } finally {
    box.done();
  }
});

test("config: a broken file is reported and the plugin still runs", () => {
  const box = sandbox();
  try {
    const file = join(box.dir, "config.json");
    writeConfig(file, "{ not json");
    const cfg = loadConfig({ HERDR_AUTOMATIC_RENAME_CONFIG: file });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.warnings.length, 1);
    assert.match(cfg.warnings[0], /config unreadable/);
  } finally {
    box.done();
  }
});

test("config: environment switches override the file", () => {
  const box = sandbox();
  try {
    const file = join(box.dir, "config.json");
    writeConfig(file, { enabled: true, dryRun: false });
    const cfg = loadConfig({
      HERDR_AUTOMATIC_RENAME_CONFIG: file,
      HERDR_AUTOMATIC_RENAME_DISABLE: "1",
      HERDR_AUTOMATIC_RENAME_DRY_RUN: "1",
      HERDR_AUTOMATIC_RENAME_TAB: "w6:t2",
    });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.dryRun, true);
    assert.equal(cfg.onlyTab, "w6:t2");
  } finally {
    box.done();
  }
});

test("config: CLI overrides beat both file and environment", () => {
  const box = sandbox();
  try {
    const file = join(box.dir, "config.json");
    writeConfig(file, { dryRun: false });
    const cfg = loadConfig({ HERDR_AUTOMATIC_RENAME_CONFIG: file, HERDR_AUTOMATIC_RENAME_DRY_RUN: "1" }, { dryRun: false });
    assert.equal(cfg.dryRun, false);
  } finally {
    box.done();
  }
});

test("config: autoMode only accepts once or follow", () => {
  const box = sandbox();
  try {
    const dir = join(box.dir, "herdr", "plugins", "config", "herdr-automatic-rename-win");
    writeConfig(join(dir, "config.json"), { autoMode: "follow" });
    const cfg = loadConfig({ APPDATA: box.dir, USERPROFILE: "C:\\Users\\x" });
    assert.equal(cfg.autoMode, "follow");
    assert.deepEqual(cfg.warnings, []);

    writeConfig(join(dir, "config.json"), { autoMode: "always" });
    const bad = loadConfig({ APPDATA: box.dir, USERPROFILE: "C:\\Users\\x" });
    assert.equal(bad.autoMode, "once");
    assert.equal(bad.warnings.length, 1);
    assert.match(bad.warnings[0], /autoMode/);
  } finally {
    box.done();
  }
});
