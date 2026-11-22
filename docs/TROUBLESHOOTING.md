# 故障排查

先跑 `herdr-automatic-rename doctor`（或 `node bin/ar.mjs doctor`）。它不写任何东西，会打印每个 tab 的现状、目标、来源和原因，以及实际读到的配置、state 路径、herdr / node 版本与配置警告。

## 标签完全不改

1. `herdr plugin list`：插件是否 `enabled`？路径是否指向当前仓库？
2. `herdr plugin log list --plugin herdr-automatic-rename-win --limit 20`：有没有 `exit_code` 非 0？
3. `node bin/ar.mjs doctor`：如果每行都是 `hand-renamed`，说明这些 tab 被人改过名，`reset` 一下：
   ```powershell
   node bin/ar.mjs reset
   ```
4. `config.json` 里 `enabled` 是不是 `false`？环境变量 `HERDR_AUTOMATIC_RENAME_DISABLE` / `AR_DISABLE` 是否为 `1`？

## 标签还是「目录 › 名字」，但我只想要「在做什么」

```json
{ "tabContext": false, "showBranch": false }
```

写进 `%APPDATA%\herdr\plugins\config\herdr-automatic-rename-win\config.json`。确认 doctor 末尾的 `config:` 一行指向这个文件——如果不是，说明你在别处也有一份 `config.json`（插件根目录的那份优先级更高）。

## 我刚改完名，过一会儿又被改回去

0.2.1 之前：新建 tab 后 3 秒内改名，`tab.created` 那趟还没有我们的记录，会把 label 当成自己写的。现在没有记录、又不是数字默认名/不含 `›` 的标签一律按手改处理。若仍被改，跑 `doctor` 看 `source`：

- `session-name` / `session-task`：说明是 `/name` 或会话内容在驱动。想固定名字，用 `/name`（它会盖过摘要）；
- `program` / `agent-*`：说明这个 tab 在 state 里没有手改记录，`reset` 之后第一次见到的 label 就是它自己的。

## 标签一直不变 / 停在旧名字

先看 `doctor`：如果 `reason` 是 `frozen`，这是 `autoMode: "once"` 的正常行为——第一轮完成后标签就定稿了。想让它继续跟着对话变，把配置改成 `"autoMode": "follow"`；或者对单个 tab 执行 `node bin/ar.mjs reset <tab-id>` 重新交给插件（会重新命名并再次冻结）。

`state.json` 里按 `(TASK_VERSION, 文件大小, mtime)` 缓存了会话摘要。如果会话文件没变，标签就不会重算。改了提取逻辑要加 `TASK_VERSION`；只是想让某个 tab 重算，`reset` 它。

另一种情况：`/name` 不产生 herdr 事件，所以标签要等下一趟对账才更新。切一下 tab，或者 `node bin/ar.mjs startup`。

## `doctor` 说 `skip: locked` / 日志里全是 locked

有另一个进程持锁超过 30 秒（通常是 herdr 被挂起时留下了锁目录）。删掉它：

```powershell
Remove-Item "$env:APPDATA\herdr\plugins\config\herdr-automatic-rename-win\.lock" -Recurse -Force
```

## 标签里出现 `' }; $out } }` 之类的脚本碎片

这是 0.1.0 的 bug：把 `pwsh -NoExit -Command <prompt hook>` 的脚本正文当成了程序名。0.2.0 只对 POSIX shell 且参数像路径时启用该启发式。升级即可。

## pi tab 显示成 `pwsh` 而不是 agent 名

说明 `pane process-info` 没查到，或命令行里没有可识别的 agent 标记。检查：

```powershell
herdr pane process-info --pane <pane_id>
```

看 `foreground_processes[].argv` 里有没有 `pi-coding-agent` 或 `…/prefix/pi`。都没有的话，把实际命令行加到 `src/naming.mjs` 的 `CMDLINE_AGENTS`，或给 `programAliases` 加映射。

## 配置不生效

优先级：herdr 插件配置目录 < 插件根目录。`HERDR_AUTOMATIC_RENAME_CONFIG`（旧 `AR_CONFIG`）一旦设置就**只用它**。

`doctor` 会打印 `config: a + b`（读了两个文件，后者覆盖前者）或单个路径。未知键不会被应用，只会在 `config warning:` 里出现。

## 中文被截得很难看

`truncate()` 按终端格数算（中文 2 格），并在超宽时留一格放 `…`。觉得太短就调 `maxTitleLen` / `maxContextLen` / `maxBranchLen` / `maxNameLen`；`maxTotalLen` 是最后一道闸。

## state 文件在哪 / 能不能删

`%APPDATA%\herdr\plugins\config\herdr-automatic-rename-win\state.json`。

删掉只会丢失「哪些 tab 被手工改过名」和会话摘要缓存，下一趟会重建。升级自 0.1.0 时，插件根目录的旧 `.state.json` 会被读一次并迁移，之后可以删。

## 如何完全静音

```powershell
herdr plugin disable herdr-automatic-rename-win
```

或临时：`HERDR_AUTOMATIC_RENAME_DISABLE=1`。
