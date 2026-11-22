// task.test.mjs — reading "what is this conversation about" out of a transcript.
import test from "node:test";
import assert from "node:assert/strict";

import {
  claudeProjectDirName,
  condenseTask,
  pickTask,
  scanHead,
  scanTail,
  sessionFile,
} from "../src/task.mjs";

const line = (obj) => JSON.stringify(obj);

/** A tail of JSONL as the reader would see it: oldest first. */
function chunk(records) {
  return records.map(line).join("\n");
}

test("sessionFile: a path session is used as is, an id session is mapped", () => {
  assert.equal(sessionFile({ kind: "path", value: "C:\\s.jsonl" }, "C:\\Users\\x"), "C:\\s.jsonl");
  assert.match(
    sessionFile({ kind: "id", value: "abc", cwd: "G:\\Herdr" }, "C:\\Users\\x"),
    /\.claude[\\/]projects[\\/]G--Herdr[\\/]abc\.jsonl$/,
  );
  assert.equal(sessionFile({ kind: "id", value: "abc", cwd: "G:\\Herdr" }, ""), "");
  assert.equal(sessionFile(null, "C:\\Users\\x"), "");
});

test("claudeProjectDirName: everything that is not alphanumeric becomes a dash", () => {
  assert.equal(claudeProjectDirName("G:\\Herdr"), "G--Herdr");
  assert.equal(claudeProjectDirName("G:\\-Temp\\mess"), "G---Temp-mess");
});

test("scanTail: the newest human message wins, tool results are not tasks", () => {
  const tail = chunk([
    { type: "user", message: { role: "user", content: "第一句" } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "第二句" }] } },
  ]);
  assert.deepEqual(scanTail(tail).prompts, ["第二句", "第一句"]);
  assert.equal(scanTail(tail).prompt, "第二句");
});

test("scanTail: an ai-title beats the last prompt, and is reported separately", () => {
  const tail = chunk([
    { type: "user", message: { role: "user", content: "按照你的推荐来" } },
    { type: "ai-title", aiTitle: "Herdr 舰队 mgr 交接" },
  ]);
  const info = scanTail(tail);
  assert.equal(info.title, "Herdr 舰队 mgr 交接");
  assert.equal(info.prompt, "按照你的推荐来");
});

test("scanTail: a pi undo record supplies the prompt when no message is in reach", () => {
  const tail = chunk([
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "好的" }] } },
    { type: "custom", customType: "pi-undo-redo", data: { prompt: "把定时任务分仓库放" } },
    { type: "custom", customType: "pi-undo-redo-redo", data: [] },
  ]);
  assert.equal(scanTail(tail).prompt, "把定时任务分仓库放");
});

test("scanTail: a fragment at the head of the tail is ignored", () => {
  const tail = `{"type":"user","mess${"\n"}${line({
    type: "user",
    message: { role: "user", content: "完整的" },
  })}`;
  assert.equal(scanTail(tail).prompt, "完整的");
});

test("condenseTask: a pasted option number, filler and a frame are peeled off", () => {
  assert.equal(
    condenseTask("1\n也就是说，按照你的说法，你要去掉一个字段。但我有个想法"),
    "你要去掉一个字段",
  );
  assert.equal(condenseTask("那我现在有个问题：这两个基本不怎么更新，你说呢"), "这两个基本不怎么更新，你说呢");
  assert.equal(condenseTask("第一个问题，默认的位数就改成 3 位"), "默认的位数就改成 3 位");
  assert.equal(condenseTask("- [ ] [openBot](https://x/y)"), "openBot");
});

test("condenseTask: a bare acknowledgement is not a task", () => {
  assert.equal(condenseTask("好的"), "");
  assert.equal(condenseTask("嗯嗯"), "");
  assert.equal(condenseTask("继续"), "");
});

test("condenseTask: a long message is cut to the width budget with an ellipsis", () => {
  const out = condenseTask("我那个项目 Life sense service 的服务端其实就是一个 CouchDB", 28);
  assert.ok(out.endsWith("…"), out);
  assert.ok(!out.includes("  "), out);
});

test("pickTask: the agent's own title wins", () => {
  assert.equal(pickTask({ title: "Herdr 舰队 mgr 交接", prompts: ["按照你的推荐来"] }), "Herdr 舰队 mgr 交接");
});

test("pickTask: a reaction is skipped in favour of an older real task", () => {
  const out = pickTask({ prompts: ["我理解了", "去把 Instabox 上的垃圾清理一下"] });
  assert.ok(out.startsWith("去把 Instabox"), out);
});

test("pickTask: nothing to say is an empty string, not a guess", () => {
  assert.equal(pickTask({}), "");
  assert.equal(pickTask({ title: "", prompts: [] }), "");
});

test("scanTail: the newest `session_info` name and its timestamp are picked up", () => {
  const tail = chunk([
    { type: "session_info", timestamp: "2026-11-22T10:00:00.000Z", name: "old name" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "做点事" }] } },
    { type: "session_info", timestamp: "2026-11-22T14:07:10.069Z", name: "标签测试会话" },
  ]);
  const info = scanTail(tail);
  assert.equal(info.name, "标签测试会话");
  assert.equal(info.nameAt, "2026-11-22T14:07:10.069Z");
});

test("scanTail: no session_info means no name", () => {
  const info = scanTail(chunk([{ type: "message", message: { role: "user", content: "hi" } }]));
  assert.equal(info.name, "");
  assert.equal(info.nameAt, "");
});

test("scanHead: the session opener is found with a forward scan", () => {
  const head = chunk([
    { type: "session", version: 3, id: "x" },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "你好" }] } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "去把垃圾清理一下" }] } },
  ]);
  assert.equal(scanHead(head), "去把垃圾清理一下");
});

test("pickTask: when every recent turn is a follow-up question, fall back to the opener", () => {
  const out = pickTask({
    prompts: ["那这样能行吗？", "是不是就不用发 PR 了？"],
    firstPrompt: "去把 Instabox 上的垃圾清理一下",
  });
  assert.ok(out.startsWith("去把 Instabox"), out);
});

test("pickTask: a recent solid statement still beats the opener", () => {
  const out = pickTask({
    prompts: ["你要去掉一个字段。但我有个想法"],
    firstPrompt: "去把 Instabox 上的垃圾清理一下",
  });
  assert.equal(out, "你要去掉一个字段");
});
