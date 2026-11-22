// version.mjs — the one version number the package reports. It is read from
// package.json so `--version`, `doctor` and the manifest test never disagree.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_DIR } from "./paths.mjs";

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();
