// text.mjs — pure string helpers: scrubbing, width-aware truncation.
// No herdr, no filesystem: everything here is testable in isolation.

// C0/C1 control characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Collapse control characters and runs of spaces, then trim. */
export function scrub(s) {
  if (typeof s !== "string") return "";
  return s.replace(CONTROL, " ").replace(/\s{2,}/g, " ").trim();
}

// East-Asian wide / fullwidth ranges: they occupy two terminal cells.
const WIDE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

/** Terminal cell width of a string (no ANSI handling: labels are plain). */
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

/** Cut to at most `max` cells, appending an ellipsis when something was cut. */
export function truncate(s, max) {
  const text = scrub(s);
  if (!max || max <= 0) return text;
  if (displayWidth(text) <= max) return text;
  const budget = Math.max(0, max - 1); // room for the ellipsis
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = WIDE.test(ch) ? 2 : 1;
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return scrub(out).replace(/\s+$/, "") + "\u2026";
}

/** Strip a leading run of non-alphanumerics (spinner glyphs, bullets, "π - "). */
export function stripLeadingGlyphs(s) {
  const text = scrub(s);
  return text.replace(/^[^\p{L}\p{N}]+/u, "");
}

/** Strip a trailing glyph that stands apart as its own word ("Task ✻"). */
export function stripTrailingGlyph(s) {
  return String(s).replace(/\s+[^\p{L}\p{N}]+$/u, "").trim();
}
