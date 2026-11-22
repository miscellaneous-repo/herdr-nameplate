// reconcile.test.mjs — the pass, driven by a fake herdr. No CLI, no socket.
import test from "node:test";
import assert from "node:assert/strict";
import { reconcile, gitBranch } from "../src/reconcile.mjs";
import { DEFAULTS } from "../src/config.mjs";

function fakeHerdr(state) {
  const calls = { renames: [], processInfo: [] };
  return {
    calls,
    snapshot() {
      return state.snapshot;
    },
    processInfo(paneId) {
      calls.processInfo.push(paneId);
      const found = state.process[paneId];
      if (found instanceof Error) throw found;
      return found ?? null;
    },
    renameTab(tabId, label) {
      calls.renames.push({ tabId, label });
    },
  };
}

const cfg = (over = {}) => ({
  ...DEFAULTS,
  stateDir: ".",
  programAliases: {},
  ...over,
});

const snapshot = (t1Label = "1") => ({
  tabs: [
    { tab_id: "w1:t1", label: t1Label, workspace_id: "w1", pane_count: 1, focused: true },
    { tab_id: "w1:t2", label: "2", workspace_id: "w1", pane_count: 1, focused: false },
  ],
  panes: [
    { pane_id: "w1:p1", tab_id: "w1:t1", cwd: "G:\\Herdr\\workflow", focused: true, agent: null },
    { pane_id: "w1:p2", tab_id: "w1:t2", cwd: "G:\\Herdr\\ops", focused: false, agent: "claude", terminal_title_stripped: "Slice the logs" },
  ],
  workspaces: [{ workspace_id: "w1", label: "Herdr" }],
  agents: [],
});

const processMap = () => ({
  "w1:p1": { foreground_processes: [{ argv0: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", argv: [] }] },
  "w1:p2": { foreground_processes: [{ argv0: "C:\\bin\\claude.exe", argv: [] }] },
});

const agentSnapshot = (label) => ({
  tabs: [{ tab_id: "w1:t2", label, workspace_id: "w1", pane_count: 1, focused: true }],
  panes: [
    {
      pane_id: "w1:p2",
      tab_id: "w1:t2",
      cwd: "G:\\Herdr\\workflow",
      focused: true,
      agent: "pi",
      terminal_title_stripped: "\u03c0 - workflow",
      agent_session: { kind: "path", value: "C:\\sessions\\a.jsonl" },
    },
  ],
  workspaces: [{ workspace_id: "w1", label: "Herdr" }],
  agents: [],
});

const sessionDeps = (info) => ({
  sessionStamp: () => "100:1",
  readSessionInfo: () => ({ name: "", nameAt: "", title: "", prompt: "", prompts: [], firstPrompt: "", ...info }),
  git: () => "",
});

test("pass: a `/name` label is applied verbatim, no context or branch", () => {
  const h = fakeHerdr({ snapshot: agentSnapshot("workflow \u203a pwsh") });
  const out = reconcile(cfg({ tabContext: true, showBranch: true }), {
    herdr: h,
    env: { USERPROFILE: "C:\\Users\\Ernesto" },
    state: { tabs: {} },
    persistState: false,
    ...sessionDeps({ name: "\u6807\u7b7e\u6d4b\u8bd5\u4f1a\u8bdd", nameAt: "2026-11-22T14:07:10.069Z" }),
  });
  assert.deepEqual(h.calls.renames, [{ tabId: "w1:t2", label: "\u6807\u7b7e\u6d4b\u8bd5\u4f1a\u8bdd" }]);
  assert.equal(out.renames[0].source, "session-name");
});

test("pass: a newer `/name` takes over a tab that was renamed by hand", () => {
  const h = fakeHerdr({ snapshot: agentSnapshot("MY NAME") });
  const out = reconcile(cfg(), {
    herdr: h,
    env: { USERPROFILE: "C:\\Users\\Ernesto" },
    state: { tabs: { "w1:t2": { label: "workflow \u203a pi", nameSeenAt: "2026-11-20T00:00:00.000Z" } } },
    persistState: false,
    ...sessionDeps({ name: "\u65b0\u540d\u5b57", nameAt: "2026-11-22T00:00:00.000Z" }),
  });
  assert.deepEqual(h.calls.renames, [{ tabId: "w1:t2", label: "\u65b0\u540d\u5b57" }]);
  assert.equal(out.renames[0].source, "session-name");
});

test("pass: a hand rename sticks while the session name has not changed", () => {
  const h = fakeHerdr({ snapshot: agentSnapshot("MY NAME") });
  const out = reconcile(cfg(), {
    herdr: h,
    env: { USERPROFILE: "C:\\Users\\Ernesto" },
    state: { tabs: { "w1:t2": { label: "workflow \u203a pi", nameSeenAt: "2026-11-22T00:00:00.000Z" } } },
    persistState: false,
    ...sessionDeps({ name: "\u65e7\u540d\u5b57", nameAt: "2026-11-22T00:00:00.000Z" }),
  });
  assert.equal(h.calls.renames.length, 0);
  assert.equal(out.skipped.find((s) => s.tabId === "w1:t2").reason, "hand-renamed");
});

test("pass: a tab renamed before our first pass is treated as hand-named", () => {
  const h = fakeHerdr({ snapshot: snapshot("\u624b\u5de5\u540d"), process: processMap() });
  const state = { tabs: {} };
  const out = reconcile(cfg(), {
    herdr: h, env: { USERPROFILE: "C:\\Users\\Ernesto" }, state, persistState: false, git: () => "",
  });
  assert.equal(h.calls.renames.some((r) => r.tabId === "w1:t1"), false);
  assert.equal(out.skipped.find((s) => s.tabId === "w1:t1").reason, "hand-renamed");
  assert.equal(state.tabs["w1:t1"].manual, true);
});

test("pass: reset opts a hand-named tab back in", () => {
  const h = fakeHerdr({ snapshot: snapshot("\u624b\u5de5\u540d"), process: processMap() });
  const out = reconcile(cfg(), {
    herdr: h,
    env: { USERPROFILE: "C:\\Users\\Ernesto" },
    state: { tabs: {}, adoptUnknown: true },
    persistState: false,
    git: () => "",
  });
  assert.equal(h.calls.renames.some((r) => r.tabId === "w1:t1"), true);
  assert.equal(out.renames.find((r) => r.tabId === "w1:t1").source, "program");
});

test("pass: a manual mark sticks even when the record has no label", () => {
  const h = fakeHerdr({ snapshot: agentSnapshot("MY NAME") });
  const out = reconcile(cfg(), {
    herdr: h,
    env: { USERPROFILE: "C:\\Users\\Ernesto" },
    state: { tabs: { "w1:t2": { manual: true, label: "", nameSeenAt: "2026-11-22T00:00:00.000Z" } } },
    persistState: false,
    ...sessionDeps({ name: "\u65e7\u540d\u5b57", nameAt: "2026-11-22T00:00:00.000Z" }),
  });
  assert.equal(h.calls.renames.length, 0);
  assert.equal(out.skipped.find((s) => s.tabId === "w1:t2").reason, "hand-renamed");
});

test("pass: an old /name cannot resurface over a hand rename", () => {
  const h = fakeHerdr({ snapshot: agentSnapshot("MY NAME") });
  const out = reconcile(cfg(), {
    herdr: h,
    env: { USERPROFILE: "C:\\Users\\Ernesto" },
    // The /name predates the manual rename: nameSeenAt already covers it.
    state: { tabs: { "w1:t2": { label: "workflow \u203a pi", nameSeenAt: "2026-11-22T00:00:00.000Z" } } },
    persistState: false,
    ...sessionDeps({ name: "\u65e7\u540d\u5b57", nameAt: "2026-11-20T00:00:00.000Z" }),
  });
  assert.equal(h.calls.renames.length, 0);
});

test("pass: closed tabs are pruned from the state", () => {
  const h = fakeHerdr({ snapshot: snapshot(), process: processMap() });
  const state = { tabs: { "w9:t9": { label: "gone" } }, sessions: {} };
  reconcile(cfg(), {
    herdr: h, env: { USERPROFILE: "C:\\Users\\Ernesto" }, state, persistState: false, git: () => "",
  });
  assert.equal(Object.hasOwn(state.tabs, "w9:t9"), false);
});

test("pass: a /name that scrolled out of the tail window stays on the tab", () => {
  const h = fakeHerdr({ snapshot: agentSnapshot("MY NAME") });
  const state = {
    tabs: {},
    sessions: {
      "C:\\sessions\\a.jsonl": { stamp: "100:1", name: "\u8001\u540d\u5b57", nameAt: "2026-11-20T00:00:00.000Z", task: "old" },
    },
  };
  // The session grew: stamp changed, the new read sees the task but no longer the name.
  const out = reconcile(cfg(), {
    herdr: h,
    env: { USERPROFILE: "C:\\Users\\Ernesto" },
    state,
    persistState: false,
    sessionStamp: () => "101:1",
    readSessionInfo: () => ({ name: "", nameAt: "", title: "", prompt: "\u7ee7\u7eed\u4fee\u590d\u8fd9\u4e2a\u9879\u76ee", prompts: [], firstPrompt: "" }),
    git: () => "",
  });
  assert.equal(out.renames.length, 0);
  assert.equal(state.sessions["C:\\sessions\\a.jsonl"].name, "\u8001\u540d\u5b57");
});

test("gitBranch: returns the branch, '' on failure", () => {
  const c = cfg();
  assert.equal(gitBranch("G:\\x", c, { git: () => "feat\n" }), "feat");
  assert.equal(gitBranch("G:\\x", c, { git: () => { throw new Error("not a repo"); } }), "");
  assert.equal(gitBranch("G:\\x", c, { git: () => "HEAD\n" }), "");
  assert.equal(gitBranch("", c, { git: () => "feat" }), "");
});

test("pass: renames what is wrong, leaves what is right alone", () => {
  const c = cfg();
  const h = fakeHerdr({
    snapshot: snapshot("workflow \u203a pwsh"), // t1 already reads correctly
    process: processMap(),
  });
  const out = reconcile(c, {
    herdr: h,
    env: { USERPROFILE: "C:\\Users\\Ernesto" },
    state: { tabs: { "w1:t1": { label: "workflow \u203a pwsh", writtenBy: true } } },
    persistState: false,
    git: () => "main",
  });

  // w1:t1 already reads correctly -> skipped, no rename
  // w1:t2 is agent claude with a task -> renamed
  assert.deepEqual(h.calls.renames, [{ tabId: "w1:t2", label: "ops \u203a Slice the logs" }]);
  assert.equal(out.renames.length, 1);
  assert.equal(out.errors.length, 0);
  const t1 = out.skipped.find((s) => s.tabId === "w1:t1");
  assert.equal(t1.reason, "already correct");
});

test("pass: dry run computes labels without calling rename", () => {
  const h = fakeHerdr({ snapshot: snapshot(), process: processMap() });
  const out = reconcile(cfg({ dryRun: true }), {
    herdr: h, env: { USERPROFILE: "C:\\Users\\Ernesto" }, state: { tabs: {} }, persistState: false, git: () => "",
  });
  assert.equal(h.calls.renames.length, 0);
  assert.equal(out.renames.length, 2);
  assert.equal(out.renames[0].to, "workflow \u203a pwsh");
});

test("pass: a tab the user renamed by hand is left alone", () => {
  const h = fakeHerdr({ snapshot: snapshot(), process: processMap() });
  // we previously wrote "workflow › pwsh"; herdr now reads "MY NAME" -> hand-named
  const out = reconcile(cfg(), {
    herdr: h,
    env: { USERPROFILE: "C:\\Users\\Ernesto" },
    state: { tabs: { "w1:t1": { label: "workflow \u203a pwsh", writtenBy: true } } },
    persistState: false,
    git: () => "",
  });
  // w1:t1's label in the snapshot is "1", not our recorded label -> hand-named
  const t1 = out.skipped.find((s) => s.tabId === "w1:t1");
  assert.equal(t1.reason, "hand-renamed");
  assert.equal(h.calls.renames.some((r) => r.tabId === "w1:t1"), false);
});

test("pass: a failing process-info is recorded, the rest of the pass continues", () => {
  const proc = processMap();
  proc["w1:p1"] = new Error("process-info exploded");
  const h = fakeHerdr({ snapshot: snapshot(), process: proc });
  const out = reconcile(cfg(), {
    herdr: h, env: { USERPROFILE: "C:\\Users\\Ernesto" }, state: { tabs: {} }, persistState: false, git: () => "",
  });
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].where, "process-info");
  // the agent tab still gets named
  assert.equal(h.calls.renames.some((r) => r.tabId === "w1:t2"), true);
});

test("pass: --tab limits the pass to one tab", () => {
  const h = fakeHerdr({ snapshot: snapshot(), process: processMap() });
  const out = reconcile(cfg({ onlyTab: "w1:t1" }), {
    herdr: h, env: { USERPROFILE: "C:\\Users\\Ernesto" }, state: { tabs: {} }, persistState: false, git: () => "",
  });
  assert.equal(h.calls.renames.length, 1);
  assert.equal(h.calls.renames[0].tabId, "w1:t1");
  assert.equal(out.skipped.some((s) => s.tabId === "w1:t2"), false);
});

test("pass: nothing to say leaves herdr's label untouched", () => {
  const snap = snapshot();
  snap.panes[0].cwd = "C:\\Users\\Ernesto"; // home: no context
  const h = fakeHerdr({
    snapshot: snap,
    process: { "w1:p1": { foreground_processes: [{ argv0: "C:\\pwsh.exe", argv: [] }] } },
  });
  const out = reconcile(cfg({ hideShell: true }), {
    herdr: h, env: { USERPROFILE: "C:\\Users\\Ernesto" }, state: { tabs: {} }, persistState: false, git: () => "",
  });
  const t1 = out.skipped.find((s) => s.tabId === "w1:t1");
  assert.equal(t1.reason, "nothing to say");
  assert.equal(h.calls.renames.some((r) => r.tabId === "w1:t1"), false);
});