// state.test.mjs — the memory file: migration, atomic writes, and the pass lock.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_VERSION, acquireLock, clearTabs, loadState, saveState, statePath } from "../src/state.mjs";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "ar-state-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const cfg = (dir) => ({ stateDir: dir, stateFileName: "state.json" });

test("state: a missing file loads as an empty v2 state", () => {
  const box = sandbox();
  try {
    const { state, path, migratedFrom } = loadState({ ...cfg(box.dir), legacyStateFile: join(box.dir, "absent.json") });
    assert.equal(state.version, STATE_VERSION);
    assert.deepEqual(state.tabs, {});
    assert.deepEqual(state.sessions, {});
    assert.equal(path, join(box.dir, "state.json"));
    assert.equal(migratedFrom, "");
  } finally {
    box.done();
  }
});

test("state: save then load round-trips, and leaves no temporary file behind", () => {
  const box = sandbox();
  try {
    const state = { version: STATE_VERSION, tabs: { "w1:t1": { label: "a", source: "program", ownName: "1", nameSeenAt: "" } }, sessions: {} };
    saveState(cfg(box.dir), state);
    const loaded = loadState(cfg(box.dir));
    assert.deepEqual(loaded.state, state);
    assert.deepEqual(readdirSync(box.dir), ["state.json"]);
  } finally {
    box.done();
  }
});

test("state: a v1 file (tasks, no version) is lifted onto sessions", () => {
  const box = sandbox();
  try {
    writeFileSync(
      join(box.dir, "state.json"),
      JSON.stringify({ tabs: { "w1:t1": { label: "old", writtenBy: true } }, tasks: { "C:\\a.jsonl": { stamp: "1:2:3", task: "hello" } } }),
    );
    const { state } = loadState(cfg(box.dir));
    assert.equal(state.version, STATE_VERSION);
    assert.equal(state.sessions["C:\\a.jsonl"].task, "hello");
    assert.equal(state.tabs["w1:t1"].label, "old");
  } finally {
    box.done();
  }
});

test("state: a corrupt file degrades to empty instead of throwing", () => {
  const box = sandbox();
  try {
    writeFileSync(join(box.dir, "state.json"), "{ nope");
    const { state } = loadState(cfg(box.dir));
    assert.deepEqual(state.tabs, {});
  } finally {
    box.done();
  }
});

test("state: clearTabs forgets one tab, or all of them", () => {
  const box = sandbox();
  try {
    const state = { version: STATE_VERSION, tabs: { "w1:t1": { label: "a" }, "w1:t2": { label: "b" } }, sessions: {} };
    saveState(cfg(box.dir), state);
    assert.equal(clearTabs(cfg(box.dir), "w1:t1"), 1);
    assert.deepEqual(Object.keys(loadState(cfg(box.dir)).state.tabs), ["w1:t2"]);
    assert.equal(clearTabs(cfg(box.dir), ""), 1);
    assert.deepEqual(loadState(cfg(box.dir)).state.tabs, {});
  } finally {
    box.done();
  }
});

test("state: the lock is exclusive and released", () => {
  const box = sandbox();
  try {
    const first = acquireLock(cfg(box.dir));
    assert.equal(first.ok, true);
    const second = acquireLock(cfg(box.dir));
    assert.equal(second.ok, false);
    assert.equal(second.reason, "locked");
    first.release();
    const third = acquireLock(cfg(box.dir));
    assert.equal(third.ok, true);
    third.release();
    assert.equal(existsSync(join(box.dir, ".lock")), false);
  } finally {
    box.done();
  }
});

test("state: a lock older than the stale window is taken over", () => {
  const box = sandbox();
  try {
    const lock = join(box.dir, ".lock");
    mkdirSync(lock);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const got = acquireLock(cfg(box.dir), 30_000);
    assert.equal(got.ok, true);
    got.release();
  } finally {
    box.done();
  }
});

test("state: the pre-0.2 file next to the code is picked up once", () => {
  const box = sandbox();
  try {
    const legacy = join(box.dir, "legacy.json");
    writeFileSync(legacy, JSON.stringify({ tabs: { "w1:t1": { label: "old" } } }));
    const loaded = loadState({ ...cfg(box.dir), legacyStateFile: legacy });
    assert.equal(loaded.migratedFrom, legacy);
    assert.equal(loaded.state.tabs["w1:t1"].label, "old");
  } finally {
    box.done();
  }
});

test("state: statePath honours stateFileName", () => {
  assert.equal(statePath({ stateDir: "C:\\x", stateFileName: "s.json" }), join("C:\\x", "s.json"));
});

test("state: the saved file is valid JSON with a trailing newline", () => {
  const box = sandbox();
  try {
    saveState(cfg(box.dir), { version: STATE_VERSION, tabs: {}, sessions: {} });
    const raw = readFileSync(join(box.dir, "state.json"), "utf8");
    assert.ok(raw.endsWith("\n"));
    assert.doesNotThrow(() => JSON.parse(raw));
  } finally {
    box.done();
  }
});
