// task.mjs — "what is this conversation about", read from the agent's own session
// file. No herdr, no config: path in, task string out.
//
// Both agents we care about append a JSONL transcript and both put the human's
// words in a "user" record, so one extractor covers them:
//
//   pi     {"type":"message","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
//   claude {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
//
// Claude additionally writes a session title it generated itself:
//
//   {"type":"ai-title","aiTitle":"Herdr 舰队 mgr 交接","sessionId":"…"}
//
// That is already "what this conversation is about", so it wins over the last
// prompt (which is often just "按照你的推荐来"). pi has no such record, so for pi
// the last human message is condensed instead; an undo/redo record carries the
// same prompt and is used if no message record is in reach.
//
// A session the human named (`/name`, `--name`, `pi.setSessionName()`) records it:
//
//   {"type":"session_info","name":"迁移 herdr 插件","timestamp":"…"}
//
// That is the human's own words, so it is applied verbatim (no condensing) and
// beats both the heuristics and an older manual tab rename.
//
// Only the tail is read. A session file grows to megabytes and the interesting
// records are always near the end.

import { closeSync, openSync, fstatSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { displayWidth } from "./text.mjs";

const DEFAULT_TAIL_BYTES = 64 * 1024;
// Bump when the extractor or the condenser changes: cached tasks in the state
// file are keyed on the stamp, and an unchanged session would otherwise keep
// serving the label an older version produced.
export const TASK_VERSION = 9;
// A wide tail is only tried when the narrow one holds no human text: a long
// stretch of tool results can push the last prompt megabytes back.
const TAIL_TRIES = [1, 4, 16];
// The session opener is read once from the head; it is the fallback when every
// recent message is only a follow-up to the previous answer.
const HEAD_BYTES = 64 * 1024;

/** Fold a path the way Claude Code names its project directory: G:\Herdr -> G--Herdr. */
export function claudeProjectDirName(cwd) {
  return String(cwd || "").replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Where the transcript for an agent session lives.
 * session = { kind: "path"|"id", value, cwd, agent } as herdr reports it.
 */
export function sessionFile(session, home = "") {
  if (!session || !session.value) return "";
  if (session.kind === "path") return session.value;
  if (session.kind === "id" && home && session.cwd) {
    return join(home, ".claude", "projects", claudeProjectDirName(session.cwd), `${session.value}.jsonl`);
  }
  return "";
}

/** Human text of one "user" record, or "". Tool results ride in user records too. */
function userRecordText(rec) {
  const content = rec.message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  // a tool result is stored as a "user" message; that is not a task
  if (content.some((p) => p && (p.type === "tool_result" || p.type === "toolResult" || p.type === "image"))) {
    return "";
  }
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join(" ")
    .trim();
}

/**
 * Pull the session title, the name the human gave it, and the recent human
 * messages out of a chunk of JSONL. Returns { name, title, prompt, prompts } —
 * `prompts[0]` is the newest, `prompt` is kept for callers that only want one.
 */
export function scanTail(chunk) {
  const lines = String(chunk).split("\n");
  let name = "";
  let nameAt = "";
  let title = "";
  const prompts = [];
  let undo = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    // the first line of a tail read is almost always a fragment
    if (!line || !line.startsWith("{")) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    if (!name && rec.type === "session_info" && typeof rec.name === "string") {
      name = rec.name.trim();
      nameAt = typeof rec.timestamp === "string" ? rec.timestamp : "";
    }
    if (!title && rec.type === "ai-title" && typeof rec.aiTitle === "string") {
      title = rec.aiTitle.trim();
    }
    if (prompts.length < 8 && rec.message && rec.message.role === "user" && !rec.isMeta && !rec.isCompactSummary) {
      const text = userRecordText(rec);
      if (text && prompts[0] !== text) prompts.push(text);
    }
    if (!undo && rec.type === "custom" && rec.customType === "pi-undo-redo" && rec.data) {
      undo = typeof rec.data.prompt === "string" ? rec.data.prompt.trim() : "";
    }
    if (name && title && prompts.length >= 8) break;
  }
  if (!prompts.length && undo) prompts.push(undo);
  return { name, nameAt, title, prompt: prompts[0] || "", prompts };
}

/** Text of the last human message in a chunk of JSONL, or "". */
export function lastUserText(chunk) {
  return scanTail(chunk).prompt;
}

/**
 * The first human message in the file — what opened the session. Forward scan;
 * a non-JSON line (fragment or header) is just skipped.
 */
export function scanHead(chunk) {
  for (const line of String(chunk).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let rec;
    try {
      rec = JSON.parse(t);
    } catch {
      continue;
    }
    if (rec && rec.message && rec.message.role === "user") {
      const text = userRecordText(rec);
      if (text) return text;
    }
  }
  return "";
}

/**
 * Whether a raw message condenses into something worth calling a label. Used to
 * decide whether a narrow tail read is enough.
 */
function looksUsable(text) {
  const label = condenseTask(text, 200);
  return Boolean(label) && displayWidth(label) >= 12 && !REACTION.test(label);
}

/** Read the tail (and the head) of a session file:
 * { name, nameAt, title, prompt, prompts, firstPrompt }. */
export function readSessionInfo(file, opts = {}) {
  const tailBytes = opts.tailBytes || DEFAULT_TAIL_BYTES;
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    let firstPrompt = "";
    try {
      const hTake = Math.min(HEAD_BYTES, size);
      const hbuf = Buffer.allocUnsafe(hTake);
      readSync(fd, hbuf, 0, hTake, 0);
      firstPrompt = scanHead(hbuf.toString("utf8"));
    } catch {
      firstPrompt = "";
    }
    for (const factor of TAIL_TRIES) {
      const take = Math.min(tailBytes * factor, size);
      if (take <= 0) break;
      const buf = Buffer.allocUnsafe(take);
      readSync(fd, buf, 0, take, size - take);
      const info = scanTail(buf.toString("utf8"));
      // Widen the window only when this one holds nothing a label could come
      // from: a tail full of tool results can put the last real prompt far back.
      if (info.name || info.title || (info.prompt && looksUsable(info.prompt))) return { ...info, firstPrompt };
      if (take === size) return { ...info, firstPrompt };
    }
    return { name: "", nameAt: "", title: "", prompt: "", prompts: [], firstPrompt };
  } catch {
    return { name: "", nameAt: "", title: "", prompt: "", prompts: [], firstPrompt };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Read the tail of a session file and pull the last human message out of it. */
export function readLastUserText(file, opts = {}) {
  return readSessionInfo(file, opts).prompt;
}

/**
 * The last `/name` in the whole session file.
 *
 * `/name` is a property of the session, not of its tail: in a long session the
 * `session_info` record can sit megabytes before the end. The tail scan above
 * stays the fast path; this is the fallback for sessions that are known (or
 * suspected) to have a name. Returns { name, nameAt }.
 */
export function readSessionName(file, opts = {}) {
  try {
    const st = statSync(file);
    const maxBytes = opts.maxBytes || 64 * 1024 * 1024;
    if (!st.isFile() || st.size > maxBytes) return { name: "", nameAt: "" };
    const text = readFileSync(file, "utf8");
    let name = "";
    let nameAt = "";
    for (const line of text.split("\n")) {
      if (!line.includes('"session_info"')) continue;
      try {
        const rec = JSON.parse(line);
        if (rec?.type !== "session_info" || typeof rec.name !== "string") continue;
        const value = rec.name.trim();
        if (!value) continue;
        name = value;
        nameAt = typeof rec.timestamp === "string" ? rec.timestamp : "";
      } catch {
        // a torn line at the tail boundary is not fatal
      }
    }
    return { name, nameAt };
  } catch {
    return { name: "", nameAt: "" };
  }
}

/** Cheap change stamp, so a pass can skip re-reading an unchanged session. */
export function sessionStamp(file) {
  try {
    const st = statSync(file);
    return `${TASK_VERSION}:${st.size}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    return "";
  }
}

// Words that carry no task: "你帮我看看这个能不能…" is about the "能不能".
const LEADING_FILLER = [
  /^\s*(你好|hi|hello)[,，。!！\s]*/i,
  /^\s*(麻烦你?|请你?|帮我|帮忙|你帮我|能否|可以帮我)[\s,，]*/,
  // "按照你的说法，你要去掉一个字段" -> "你要去掉一个字段"
  /^\s*(?:按照|根据|就按|按你|按我)[^，,。！？!?]{0,14}[，,]\s*/,
  // "那我现在有个问题：这两个…" -> "这两个…"
  /^\s*(?:那|那么)?我(?:现在|这里)?有(?:个|一个)?(?:小)?问题[，,:：]\s*/,
  // "第一个问题，默认的位数就改…" -> "默认的位数就改…"
  /^\s*第(?:一|二|三|1|2|3)(?:个)?(?:问题|点)[，,:：]\s*/,
];

// A first line that is only a greeting or a bare acknowledgement is not a task.
const NOISE = /^(ok|okay|yes|no|y|n|继续|好的?|行|可以|嗯+|test|测试一下?|thanks?|谢谢)$/i;

/**
 * Turn a raw user message into a short label: first sentence, no markdown, no
 * trailing punctuation, cut on a word boundary where possible.
 */
// A reply that only reacts to the previous turn describes no task of its own.
const DISCOURSE = /^(也就是说|那么|然后|所以|但是|不过|其实|另外|还有|好的?|嗯+|就是说|明白|懂了|收到|继续|是的|对|嗯嗯)[\s,，、:：]*/;

export function condenseTask(text, maxWidth = 28) {
  let t = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    // task-list checkboxes: "- [ ] openBot"
    .replace(/\[[ xX]\]\s*/g, "")
    .replace(/^[\s>#*\-+]+/gm, "")
    // a bare "1" line is an option number the human pasted, not a task
    .replace(/^\s*\d+\s*$/gm, "")
    .replace(/^\s*\d+[.)\u3001]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  // a pasted path or a long stack trace says nothing useful in 28 columns
  if (/^[A-Za-z]:\\/.test(t) && !/\s/.test(t.slice(0, 4))) {
    const base = t.split(/[\\/]/).filter(Boolean).pop() || "";
    t = base;
  }
  // Peel the front matter off in passes: a message can open with filler, then a
  // connective, then another frame ("帮我看看，也就是说，按照你的说法，…").
  for (let i = 0; i < 4; i++) {
    const before = t;
    for (const re of LEADING_FILLER) t = t.replace(re, "");
    if (DISCOURSE.test(t)) t = t.replace(DISCOURSE, "");
    t = t.trim();
    if (t === before) break;
  }
  if (!t || NOISE.test(t)) return "";

  // first sentence (or paragraph), then a hard cut on the display-width budget
  const para = (t.split(/[\n。；;!！?]/)[0] || t).trim();
  const cand = para.replace(/[，,、.:：\s]+$/, "");
  if (!cand) return "";
  const width = displayWidth(cand);
  if (width <= maxWidth) return cand;
  let out = "";
  let w = 0;
  for (const ch of cand) {
    const cw = displayWidth(ch);
    if (w + cw > maxWidth - 1) break;
    out += ch;
    w += cw;
  }
  return `${out.replace(/[，,、.:：\s]+$/, "")}…`;
}

// A label that only reacts to the previous turn says nothing about the session.
const REACTION =
  /^(?:我?理解|明白|懂了?|好的?|行|可以|嗯+|是的?|对|继续|谢谢|ok|收到|没问题|你说得对)/i;

// A follow-up question reacts to the last answer instead of stating a task.
const QUESTIONISH = /[?？]\s*$|吗[。！!？?]?\s*$|^(?:是不是|对吧)|(?:能不能|可不可以|好不好|行不行|是不是|对不对)/;
// An opener that reads like an instruction ("去把…清理一下") is a good topic.
const TASKY = /^(?:去|帮|请|把|将|写|做|改|加|删|查|看|读|清理|整理|部署|配置|实现|升级|移植|迁移|排查|调研|恢复|安装|卸载|替换|优化|重构|完成|创建|新建|执行|跑|修|补|接)/;

/**
 * The one label for a session: the title the agent wrote for itself if there is
 * one, else the newest human message that reads like a task rather than a
 * reaction or a follow-up question; when the recent turns are all follow-ups,
 * fall back to what opened the session.
 */
export function pickTask(info, maxWidth = 28) {
  const title = condenseTask(info?.title || "", maxWidth);
  if (title) return title;
  const prompts = info?.prompts || (info?.prompt ? [info.prompt] : []);
  const candidates = [];
  for (const raw of prompts) {
    const label = condenseTask(raw, maxWidth);
    if (label && !candidates.includes(label)) candidates.push(label);
  }
  const goods = candidates.filter((c) => displayWidth(c) >= 12 && !REACTION.test(c));
  const solid = goods.find((c) => !QUESTIONISH.test(c));
  if (solid) return solid;
  const first = condenseTask(info?.firstPrompt || "", maxWidth);
  if (first && displayWidth(first) >= 8 && !REACTION.test(first) && TASKY.test(first)) return first;
  return goods[0] || candidates[0] || "";
}
