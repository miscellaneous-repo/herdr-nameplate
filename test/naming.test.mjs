// naming.test.mjs — pure rule tests. No herdr, no filesystem.
import test from "node:test";
import assert from "node:assert/strict";
import {
  programName, classifyProgram, contextDir, branchLabel, taskFromTitle, compose, computeLabel,
} from "../src/naming.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { truncate, scrub, displayWidth, stripLeadingGlyphs } from "../src/text.mjs";

const cfg = (over = {}) => ({ ...DEFAULTS, programAliases: { ...DEFAULTS.programAliases }, ...over });
const HOME = "C:\\Users\\Ernesto";

test("text: scrub collapses controls and space runs", () => {
  assert.equal(scrub("  a\u0007b   c  "), "a b c");
});

test("text: truncate is width aware and honours CJK", () => {
  assert.equal(truncate("abcdef", 10), "abcdef");
  assert.equal(truncate("abcdefghij", 5), "abcd\u2026");
  // five CJK chars = 10 cells, so a 6-cell budget fits two plus ellipsis
  assert.equal(truncate("\u542f\u542f\u542f\u542f\u542f", 6), "\u542f\u542f\u2026");
  assert.equal(displayWidth("\u4e2d\u6587"), 4);
});

test("text: stripLeadingGlyphs removes the agent spinner, keeps letters", () => {
  assert.equal(stripLeadingGlyphs("\u2733 Herdr \u8230"), "Herdr \u8230");
  // \u03c0 is a letter, so it survives here; the "<mark> - <task>" split happens
  // in taskFromTitle, which knows what a mark looks like in context.
  assert.equal(stripLeadingGlyphs("\u03c0 - workflow"), "\u03c0 - workflow");
});

test("programName strips the path and the Windows extension", () => {
  assert.equal(programName("E:\\Application\\Build\\Nodejs\\node.exe"), "node");
  assert.equal(programName("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), "powershell");
  assert.equal(programName(""), "");
});

test("classifyProgram: shells, ignored programs, aliases, plain programs", () => {
  const c = cfg();
  assert.equal(classifyProgram("pwsh.exe", c).isShell, true);
  assert.equal(classifyProgram("ls.exe", c).isIgnored, true);
  assert.equal(classifyProgram("nvim.exe", c).name, "nvim");
  const aliased = { ...c, programAliases: { nvim: "v" } };
  assert.equal(classifyProgram("nvim.exe", aliased).name, "v");
  // a pwsh started with a script payload is still just a shell, not a wrapper
  const herdrPrompt = "if ($null -eq $global:__HerdrOriginalPrompt) { $out = @() -join ' '; $esc = [string][char]27; $out += $esc + ']9;9;' + $loc + $esc + '\' }; $out";
  assert.equal(classifyProgram("pwsh.exe", c, ["pwsh.exe", "-NoExit", "-Command", herdrPrompt]).name, "pwsh");
  // a POSIX shim running a real path names the path
  assert.equal(classifyProgram("sh.exe", c, ["sh.exe", "/e/Application/Build/Nodejs/prefix/pi", "--model", "x"]).name, "pi");
  // ...but a free-form argument is not a program name
  assert.equal(classifyProgram("sh.exe", c, ["sh.exe", "if", "then"]).name, "pwsh");
  // hideShell suppresses the shell name entirely
  assert.equal(classifyProgram("pwsh.exe", { ...c, hideShell: true }).name, "");
});

test("contextDir skips home, skips a directory that repeats its workspace, truncates", () => {
  const c = cfg();
  assert.equal(contextDir("G:\\Herdr\\workflow", "", c, HOME), "workflow");
  assert.equal(contextDir("C:\\Users\\Ernesto", "", c, HOME), "");
  assert.equal(contextDir("G:\\Herdr\\workflow", "workflow", c, HOME), "");
  assert.equal(contextDir("G:\\Herdr\\Workflow", "workflow", c, HOME), "", "case-insensitive");
  assert.equal(contextDir("G:\\a\\verylongdirectoryname", "", c, HOME), "verylongdir\u2026");
  assert.equal(contextDir("G:\\x", "", { ...c, tabContext: false }, HOME), "");
});

test("branchLabel hides the default branches and truncates the rest", () => {
  const c = cfg();
  assert.equal(branchLabel("main", c), "");
  assert.equal(branchLabel("master", c), "");
  assert.equal(branchLabel("MAIN", c), "");
  assert.equal(branchLabel("feature/tab-naming", c), "feature/tab\u2026");
  assert.equal(branchLabel("", c), "");
  assert.equal(branchLabel("HEAD", c), "");
  assert.equal(branchLabel("dev", { ...c, showBranch: false }), "");
});

test("taskFromTitle accepts a real task, refuses anything that names the agent", () => {
  const c = cfg();
  const dirName = "workflow";
  const task = (title, kind = "claude") => taskFromTitle(title, { cfg: c, kind, dirName });
  assert.equal(task("Squash merge command"), "Squash merge command");
  assert.equal(task("\u2733 Squash merge command"), "Squash merge command");
  assert.equal(task("claude"), "", "the agent kind is not a task");
  assert.equal(task("Claude Code"), "", "kind + code is not a task");
  assert.equal(task("workflow"), "", "the directory name is not a task");
  assert.equal(task("42"), "", "a bare number is herdr's own label");
  assert.equal(task(""), "");
  // "<mark> - <directory>" names the agent and the place, not the work
  assert.equal(task("\u03c0 - workflow", "pi"), "");
  // ... but the same shape around a real task keeps the task
  assert.equal(task("\u2733 - Squash merge command"), "Squash merge command");
});

test("compose joins the non-empty parts and clamps the total", () => {
  const c = cfg();
  assert.equal(compose("workflow", "feat", "claude", c), "workflow \u203a feat \u203a claude");
  assert.equal(compose("", "", "claude", c), "claude");
  assert.equal(compose("workflow", "", "", c), "workflow");
  const long = compose("averylongdirectory", "featurebranch", "averylongprogramname", {
    ...c, maxContextLen: 40, maxBranchLen: 40, maxNameLen: 40, maxTotalLen: 20,
  });
  assert.ok(displayWidth(long) <= 20, `expected <=20 cells, got ${long}`);
});

test("computeLabel: agent task wins over the program name", () => {
  const c = cfg();
  const out = computeLabel({
    cwd: "G:\\Herdr\\workflow", workspaceLabel: "", branch: "feat-x",
    agent: { kind: "claude", title: "Squash merge command" },
    foreground: { argv0: "C:\\bin\\claude.exe" },
  }, c, HOME);
  assert.equal(out.label, "workflow \u203a feat-x \u203a Squash merge command");
  assert.equal(out.source, "agent-title");
});

test("computeLabel: a session name the human typed is used verbatim", () => {
  const c = cfg();
  const out = computeLabel({
    cwd: "G:\\Herdr\\workflow", workspaceLabel: "", branch: "feat-x",
    agent: { kind: "pi", title: "", sessionName: "\u8fc1\u79fb herdr \u63d2\u4ef6", sessionTask: "\u4fee\u4e00\u4e2a bug" },
    foreground: null,
  }, c, HOME);
  // no context, no branch, no condensing: exactly what /name says
  assert.equal(out.label, "\u8fc1\u79fb herdr \u63d2\u4ef6");
  assert.equal(out.source, "session-name");
});

test("computeLabel: a session name wins over the transcript heuristic", () => {
  const c = cfg({ tabContext: true, showBranch: true });
  const out = computeLabel({
    cwd: "G:\\Herdr\\workflow", workspaceLabel: "", branch: "feat-x",
    agent: { kind: "claude", title: "Squash merge command", sessionName: "\u6211\u7684\u6807\u7b7e", sessionTask: "\u4fee bug" },
    foreground: null,
  }, c, HOME);
  assert.equal(out.label, "\u6211\u7684\u6807\u7b7e");
  assert.equal(out.source, "session-name");
});

test("computeLabel: sessionName:false keeps the heuristic", () => {
  const c = cfg({ sessionName: false });
  const out = computeLabel({
    cwd: "G:\\Herdr\\workflow", workspaceLabel: "", branch: "",
    agent: { kind: "claude", title: "Squash merge command", sessionName: "\u6211\u7684\u6807\u7b7e" },
    foreground: null,
  }, c, HOME);
  assert.equal(out.label, "workflow \u203a Squash merge command");
  assert.equal(out.source, "agent-title");
});

test("computeLabel: an agent with no task falls back to its program", () => {
  const c = cfg();
  const out = computeLabel({
    cwd: "G:\\Herdr\\workflow", workspaceLabel: "", branch: "",
    agent: { kind: "pi", title: "\u03c0 - workflow" }, // title == directory -> refused
    foreground: { argv0: "E:\\Application\\Build\\Nodejs\\node.exe", argv: ["node", "E:/x/@earendil-works/pi-coding-agent/dist/bundle/cli.js"] },
  }, c, HOME);
  assert.equal(out.label, "workflow \u203a pi");
  assert.equal(out.source, "agent-cmdline");
});

test("computeLabel: without process info an agent tab names its kind", () => {
  const c = cfg();
  const out = computeLabel({
    cwd: "G:\\Herdr\\workflow", workspaceLabel: "", branch: "",
    agent: { kind: "codex", title: "" }, foreground: null,
  }, c, HOME);
  assert.equal(out.label, "workflow \u203a codex");
  assert.equal(out.source, "agent-kind");
});

test("computeLabel: a bare prompt names the shell, hideShell names nothing", () => {
  const c = cfg();
  const shell = computeLabel({
    cwd: "G:\\Herdr\\workflow", workspaceLabel: "", branch: "", agent: null,
    foreground: { argv0: "C:\\pwsh.exe" },
  }, c, HOME);
  assert.equal(shell.label, "workflow \u203a pwsh");
  const hidden = computeLabel({
    cwd: "G:\\Herdr\\workflow", workspaceLabel: "", branch: "", agent: null,
    foreground: { argv0: "C:\\pwsh.exe" },
  }, { ...c, hideShell: true }, HOME);
  assert.equal(hidden.label, "workflow");
});

test("computeLabel: an ignored throwaway command holds the tab at the shell name", () => {
  const c = cfg();
  const out = computeLabel({
    cwd: "G:\\Herdr\\workflow", workspaceLabel: "", branch: "", agent: null,
    foreground: { argv0: "C:\\Windows\\System32\\ls.exe" },
  }, c, HOME);
  assert.equal(out.label, "workflow \u203a pwsh");
  assert.equal(out.source, "ignored-program");
});