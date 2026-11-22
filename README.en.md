# herdr-automatic-rename-win

[中文](README.md) · [Changelog](CHANGELOG.md) · [MIT](LICENSE)

A Windows plugin for **herdr**: every tab names itself after **what the conversation in it is doing**.

The upstream plugin ([qu8n/herdr-automatic-rename](https://github.com/qu8n/herdr-automatic-rename)) declares `platforms = ["linux", "macos"]` and drives everything through bash + jq. This repository keeps its naming semantics and replaces the execution layer with Node — native JSON, no jq, no `IFS`/quoting bugs — plus Windows-specific foreground detection and pi / Claude Code transcript support.

```
主管
自建商店项目修复 bug
LiveSyncService 自建
emby自动观看脚本
NTFY 配置方案讨论 文件权限…
pwsh
```

A label has three parts, any of which may be empty:

| Config | Shape | Example |
|---|---|---|
| default | `directory › branch › activity` | `Herdr › feat-auth › fixes the token refresh` |
| `showBranch: false` | `directory › activity` | `Herdr › fixes the token refresh` |
| `tabContext: false, showBranch: false` | activity only | `fixes the token refresh` |

## Requirements

- Windows 10/11
- herdr ≥ 0.7.1
- Node.js ≥ 20 on `PATH` (herdr runs the plugin with it)

## Install

### A. From GitHub (recommended)

```powershell
herdr plugin install Aquilonar/herdr-automatic-rename-win --ref v0.2.0 -y
herdr plugin enable herdr-automatic-rename-win
```

Update with `herdr plugin update herdr-automatic-rename-win`.

### B. Release zip + script

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

The script checks `herdr`/`node`, copies the plugin to `%LOCALAPPDATA%\herdr-automatic-rename\0.2.0\`, re-links it and runs `doctor`.
Remove with `.\scripts\uninstall.ps1`.

### C. From npm

```powershell
npm install -g herdr-automatic-rename-win
herdr plugin link "$(npm root -g)\herdr-automatic-rename-win" --enabled
```

> The plugin directory **must** be called `herdr-automatic-rename-win`: it locates herdr's per-plugin config directory (`%APPDATA%\herdr\plugins\config\<directory name>`) by its own directory name. Otherwise set `HERDR_PLUGIN_CONFIG_DIR` or `HERDR_AUTOMATIC_RENAME_CONFIG`.

## Where a name comes from

`computeLabel` in `src/naming.mjs`, first match wins (`source` in `doctor --json`):

| # | `source` | Meaning |
|---|---|---|
| 0 | — | a tab you renamed by hand (`hand-renamed`) — never touched again: either the label differs from the one we last wrote, or we have no record of the tab and the label is neither herdr's number nor something shaped like ours |
| 1 | `session-name` | a name **you** gave the session (`/name`, `--name`, `pi.setSessionName()`), used verbatim |
| 2 | `session-task` | **what the conversation is doing**: Claude's `ai-title`, else the newest human message that reads like a task |
| 3 | `agent-title` | the task an agent reports in its terminal title (pi always reports `π - <dir>`, so it never wins) |
| 4 | `agent-name` | the tab's own name (`worker-dst-2`), better than every pi tab reading `pi` |
| 5 | `agent-cmdline` | `pi-coding-agent`, `…/prefix/pi`, `claude`, `codex`, `gemini` in the foreground command line |
| 6 | `agent-program` / `program` | foreground program (a script's name when PowerShell runs `.sh/.ps1/.py`) |
| 7 | `agent-kind` / `shell` | fallback: agent kind, or `pwsh` |

**Directory and branch.** `context` is the `cwd` basename, omitted when it is `$HOME` or repeats the workspace label, truncated to `maxContextLen` (12). `branch` comes from `git -C <cwd> rev-parse --abbrev-ref HEAD`, hides `main`/`master` and detached `HEAD`, truncated to `maxBranchLen` (12). Separator: `contextSep`, default `" › "` (U+203A).

**"What is it doing".** pi's terminal title is useless, so the task is read from the agent's own transcript: pi's `agent_session.value` path, or Claude's `%USERPROFILE%\.claude\projects\<flattened cwd>\<id>.jsonl`. Only the tail is read (64KB, widening to 256KB/1MB when it holds nothing usable) plus 64KB of head for the session opener. `ai-title` wins; otherwise the newest human message that is not a bare acknowledgement or a follow-up question. Records are cached by `(TASK_VERSION, size, mtime)`, so an unchanged session costs no I/O.

## Manual names (two peer channels)

| Channel | How | How it is seen |
|---|---|---|
| pi `/name` | `/name deploy check` in pi | `{"type":"session_info","name":"…","timestamp":"…"}` in the transcript: the tail first; when a cached name exists (or `TASK_VERSION` just changed) and the tail has none, the whole file is scanned once |
| herdr rename | `herdr tab rename w6:t2 deploy-check`, or the UI | the label differs from the one we last wrote ⇒ `hand-renamed`; a tab we have no record of counts as hand-named unless its label is a number or contains `›` (typical for renaming within the 3 s before `tab.created` fires) |

Neither outranks the other: the later change wins. herdr tabs carry no timestamp, so the plugin stores `nameSeenAt` in its state file and compares `/name` timestamps against it.

```powershell
node bin/ar.mjs reset w6:t2     # let one tab back into automatic naming (--tab also works)
node bin/ar.mjs reset           # all tabs
```

## Configuration

Merged lowest → highest:

1. `%APPDATA%\herdr\plugins\config\herdr-automatic-rename-win\config.json`
2. `<plugin root>\config.json`

`HERDR_AUTOMATIC_RENAME_CONFIG` (legacy `AR_CONFIG`) replaces the list. Unknown keys and bad types become warnings in `doctor`; they never stop the plugin. See [`examples/`](examples) for ready-made files, and `src/config.mjs` for every key and its default.

Frequently used keys: `tabContext`, `showBranch`, `sessionTask`, `sessionName`, `maxTitleLen` (28), `maxContextLen` (12), `maxBranchLen` (12), `shellName` ("pwsh"), `hideShell`, `programAliases`, `defaultBranches`, `maxProcessLookups` (16), `timeoutMs` (8000), `herdrBin`.

Environment: `HERDR_AUTOMATIC_RENAME_CONFIG` / `_DISABLE=1` / `_DRY_RUN=1` / `_TAB=<id>` / `_LOG=<path>` / `_STATE_DIR=<dir>`, plus `HERDR_PLUGIN_CONFIG_DIR`; the old `AR_*` names still work.

## Commands

```powershell
herdr-automatic-rename doctor                 # dry run: current label, target, source, reason
herdr-automatic-rename doctor --tab w6:t2
herdr-automatic-rename doctor --json
herdr-automatic-rename reset [--tab w6:t2]
herdr-automatic-rename --version
```

`doctor` never writes anything (no rename, no state) and prints the config files actually read, the state path, herdr and node versions, and config warnings.

## Events

`tab.created` `tab.closed` `tab.renamed` `tab.focused` `tab.moved`, `pane.created` `pane.closed` `pane.exited` `pane.focused` `pane.moved`, `pane.agent_detected`, `pane.agent_status_changed`, plus one `startup` pass.

herdr has no "foreground command changed" event, so every event runs a full idempotent reconcile: a label that already matches is skipped, which is also what stops our own rename (which re-fires `tab.renamed`) from looping. Concurrent events collapse behind a directory lock. One pass = one `api snapshot` + one `git` per repo tab; `pane process-info` is only called for tabs the cheap sources cannot settle, with a per-pass cap.

## Privacy

Reads transcripts only (head and tail), writes only herdr tab labels plus its own state/log files in herdr's plugin config directory. Nothing leaves the machine.

## Known limitations

- No `[N]` prefix (upstream mirrors alt+N into the label).
- No workspace naming, pane border titles, icon table or ssh context.
- "What it is doing" is heuristic: pi writes no session title, so the label is the newest task-like human message and may cover one turn only. Use `/name` for exactness.
- Event-driven, not a live watcher: the label updates when the next event arrives (usually < 1 s).
- Tested on Windows 11 + herdr 0.9.5 + Node 24 only.

## Uninstall

```powershell
herdr plugin disable herdr-automatic-rename-win
herdr plugin unlink  herdr-automatic-rename-win
```

`unlink` keeps your state and config; delete `%APPDATA%\herdr\plugins\config\herdr-automatic-rename-win\` to remove them. Tab labels already written are not restored.

## Development

```powershell
npm test            # node --test, fake herdr, no real herdr needed
npm run doctor      # dry run against the live herdr
npm run pass        # one real pass, verbose
```

Rules live in pure modules (`naming.mjs`, `task.mjs`, `text.mjs`); `reconcile.mjs` only orchestrates. To add a naming source, return `{ label, source: "your-source" }` from `computeLabel` and add a case in `test/naming.test.mjs`. Bump `TASK_VERSION` in `src/task.mjs` whenever the transcript extractor or condenser changes, so cached labels are recomputed.

## License

MIT. Naming semantics and several rules come from [qu8n/herdr-automatic-rename](https://github.com/qu8n/herdr-automatic-rename) (MIT). See [LICENSE](LICENSE).
