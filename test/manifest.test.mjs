// manifest.test.mjs — the herdr manifest and the npm package must agree.
//
// A release that ships a manifest whose version disagrees with package.json is a
// release users cannot tell apart from the previous one, and a manifest without a
// command for an event is a subscription that silently does nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = readFileSync(join(ROOT, "herdr-plugin.toml"), "utf8");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const value = (key) => manifest.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1] || "";

test("manifest: id matches the package name", () => {
  assert.equal(value("id"), pkg.name);
});

test("manifest: version matches package.json", () => {
  assert.equal(value("version"), pkg.version);
});

test("manifest: it is a Windows plugin", () => {
  assert.match(manifest, /^platforms\s*=\s*\[[^\]]*"windows"[^\]]*\]/m);
});

test("manifest: every event has a node command that exists", () => {
  const blocks = manifest.split("[[events]]").slice(1);
  assert.ok(blocks.length >= 10, "expected the tab and pane events");
  for (const block of blocks) {
    const on = block.match(/on\s*=\s*"([^"]+)"/)?.[1];
    assert.ok(on, "event without an `on`");
    const command = block.match(/command\s*=\s*\[([^\]]*)\]/)?.[1] || "";
    assert.match(command, /"node"/, `${on}: command must run node`);
    const script = command.match(/"([^"]+\.mjs)"/)?.[1];
    assert.ok(script, `${on}: command must name a script`);
    assert.ok(existsSync(join(ROOT, script)), `${on}: ${script} does not exist`);
  }
});

test("manifest: the startup hook is declared", () => {
  assert.match(manifest, /^\[\[startup\]\]/m);
});

test("package: the bin target exists and is executable-shaped", () => {
  for (const file of Object.values(pkg.bin)) {
    const full = join(ROOT, file);
    assert.ok(existsSync(full), `${file} does not exist`);
    assert.match(readFileSync(full, "utf8").split("\n")[0], /^#!.*node/, `${file} needs a node shebang`);
  }
});

test("package: everything the manifest needs is published", () => {
  assert.ok(pkg.files.includes("herdr-plugin.toml"));
  assert.ok(pkg.files.includes("bin/"));
  assert.ok(pkg.files.includes("src/"));
});
