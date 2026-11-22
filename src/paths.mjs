// paths.mjs — where things live. The single place that knows about the plugin
// root, herdr's per-plugin config directory, and the user's home.
//
// Keeping this in one module is what makes the package relocatable: herdr may
// run it from a checkout (herdr plugin link), from a clone under
// %APPDATA%\herdr\plugins\github-installations\…, or from a global npm install,
// and every one of those must find the same config and state.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the plugin root (the directory holding herdr-plugin.toml). */
export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The plugin id. herdr derives it from the directory name for a linked plugin,
 * and it is what both herdr and this plugin use to name the config directory —
 * so renaming the checkout moves the config with it only if this stays in sync.
 */
export const PLUGIN_ID = PLUGIN_DIR.split(/[\\/]/).pop() || "herdr-automatic-rename";

/** %APPDATA% on Windows, $XDG_CONFIG_HOME elsewhere. */
export function configRoot(env = process.env) {
  if (env.APPDATA) return join(env.APPDATA, "herdr");
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "herdr");
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
