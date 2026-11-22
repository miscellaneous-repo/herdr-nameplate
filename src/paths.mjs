// paths.mjs — where things live. The single place that knows about the plugin
// root, herdr's per-plugin config directory, and the user's home.
//
// Keeping this in one module is what makes the package relocatable: herdr may
// run it from a checkout (herdr plugin link), from a clone under
// %APPDATA%\herdr\plugins\github-installations\…, or from a global npm install,
// and every one of those must find the same config and state.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the plugin root (the directory holding herdr-plugin.toml). */
export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The plugin id, read from the manifest so the config directory is the same
 * however the plugin was installed: a linked checkout, an npm global install,
 * or a `herdr plugin install` checkout (whose directory is just `checkout`).
 */
function manifestId() {
  try {
    const text = readFileSync(join(PLUGIN_DIR, "herdr-plugin.toml"), "utf8");
    const match = /^\s*id\s*=\s*"([^"]+)"/m.exec(text);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

export const PLUGIN_ID = manifestId() || PLUGIN_DIR.split(/[\\/]/).pop() || "herdr-nameplate";

/** %APPDATA% on Windows, $XDG_CONFIG_HOME elsewhere. */
export function configRoot(env = process.env) {
  if (env.APPDATA) return join(env.APPDATA, "herdr");
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "herdr");
  // A Windows process started without APPDATA (service, scheduled task): use the
  // documented profile layout rather than silently moving state to ~/.config.
  if (env.USERPROFILE) return join(env.USERPROFILE, "AppData", "Roaming", "herdr");
  if (env.HOME) return join(env.HOME, ".config", "herdr");
  return "";
}

/**
 * herdr's per-plugin config directory. herdr exports HERDR_PLUGIN_CONFIG_DIR to
 * plugin commands; when it is absent (running from a shell, or a unit test) the
 * documented convention is used instead.
 */
export function pluginConfigDir(env = process.env) {
  if (env.HERDR_PLUGIN_CONFIG_DIR) return env.HERDR_PLUGIN_CONFIG_DIR;
  const root = configRoot(env);
  return root ? join(root, "plugins", "config", PLUGIN_ID) : PLUGIN_DIR;
}

/** Legacy location (before v0.2): state and log lived next to the code. */
export function legacyStateFile(cfg) {
  return join(PLUGIN_DIR, cfg.stateFileName);
}

export function exists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
