# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-11-23

The first release meant to be installed by strangers.

### Added

- `herdr-automatic-rename` CLI (`--version`, `--help`, `--dry-run`, `--tab`,
  `--json`), installable from npm with a `bin` entry point.
- `doctor` reports the config files actually read, the state path, detected
  herdr and node versions, and any config warnings.
- Config validation: unknown keys and wrong types become warnings instead of
  silently doing nothing or throwing.
- Three example configs under `examples/`.

### Changed

- **Runtime state moved** from `<plugin>/.state.json` to herdr's per-plugin
  config directory (`%APPDATA%\herdr\plugins\config\herdr-automatic-rename-win\state.json`),
  because `herdr plugin update` replaces the plugin directory. An old file next
  to the code is read once and migrated.
- Configuration is now read from herdr's plugin config directory first and the
  plugin root second (the root file wins); `AR_CONFIG` still means "only this
  file". `HERDR_AUTOMATIC_RENAME_CONFIG` is the new name, `AR_CONFIG` remains.
- Environment variables gained a `HERDR_AUTOMATIC_RENAME_*` spelling; all old
  `AR_*` names still work.
- The manifest and `package.json` share one version; a test enforces it.
- Internal modules split into `paths`, `version`, `config`, `log`, `state`,
  `herdr`, `naming`, `task`, `text`, `reconcile`, `main`.

### Fixed

- Two events arriving in the same millisecond no longer both run a pass; the
  second exits with `skip: locked`.
- A `state.json` write interrupted by shutdown no longer leaves a half-written
  file (temp file + rename).
- A failing `git` or `pane process-info` call is recorded per tab instead of
  aborting the pass.

## [0.1.0] — 2026-11-22

First working Windows port.

### Added

- Tab naming from directory, git branch and foreground program, driven by 12
  herdr events plus a startup pass.
- `session-task`: "what is this conversation doing" read from pi / Claude Code
  transcripts (tail read, width-aware condensing, reaction and follow-up
  filtering, opener fallback).
- `session-name`: names given with pi's `/name` are used verbatim.
- Hand-rename protection: a label we did not write is left alone; `reset` opts
  a tab back in.
- `doctor` dry pass and `reset` action.
