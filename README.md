# herdr-automatic-rename-win

herdr 标签页自动改名（Windows 版，P1）。上游 [qu8n/herdr-automatic-rename](https://github.com/qu8n/herdr-automatic-rename) 声明 `platforms = ["linux", "macos"]`，整套逻辑跑在 bash + jq 上；本项目保留它的命名语义，只把执行层换成 **Node**（一次启动约 40–60ms，JSON 原生，不需要 jq，也不需要 `IFS`/引号防护）。

标签名 = **位置 › 分支 › 在干什么**，三段任一可为空（`tabContext`/`showBranch` 可以关掉前两段）：

```
Herdr › 舰队 mgr 交接
workflow › 这两个基本不怎么更新，你说…
.herdr-serve › pwsh
```

“在干什么”优先取自会话记录本身：Claude 会给自己写 `ai-title`，pi 没有标题就用最后一条像任务的人类消息（详见「在干什么」一节）。

## 安装

```powershell
# 链接本地目录（改代码无需重装，只需重新触发事件）
herdr plugin link G:\Herdr\workspace\herdr-automatic-rename-win --enabled

# 启用 / 停用 / 卸载
herdr plugin enable  herdr-automatic-rename-win
herdr plugin disable herdr-automatic-rename-win
herdr plugin unlink  herdr-automatic-rename-win

# 或者用 package.json 里的别名（在项目根目录跑）
npm run link   # = herdr plugin link . --enabled
npm run status
```

换位置时要先 `unlink` 再 `link` 新路径；**目录名必须保持 `herdr-automatic-rename-win`**，否则 `%APPDATA%\herdr\plugins\config\<目录名>` 的配置会找不到。

启用后 herdr 会在每个事件上执行 `node bin/ar.mjs <event>`（工作目录 = 插件根目录）。`platforms = ["windows"]` 在 herdr 0.9.5 上已被接受。

## 目录

| 路径 | 作用 |
|---|---|
| `herdr-plugin.toml` | manifest：1 个 `[[startup]]`、12 个 `[[events]]`、2 个 `[[actions]]` |
| `bin/ar.mjs` | 入口薄壳 |
| `src/config.mjs` | 默认值 + `config.json` 读取 + 环境变量开关 |
| `src/naming.mjs` | **纯函数**：命名规则（无 herdr、无文件系统，全部可单测） |
| `src/herdr.mjs` | 调 `herdr` CLI：`api snapshot` / `pane process-info` / `tab rename` |
| `src/reconcile.mjs` | 一趟完整对账：读快照 → 算名字 → 改名；带 `.lock` 与手工改名保护 |
| `src/task.mjs` | 读会话 jsonl，得出「这个对话在干什么」（无 herdr、无配置，全部可单测） |
| `src/main.mjs` | 参数解析、`reset` / `doctor` 动作、日志 |
| `test/*.test.mjs` | `node:test`，假 herdr 驱动，44 个用例（`npm test`）|
| `package.json` | 只是便捷脚本（`npm test` / `npm run doctor` / `npm run pass` / `npm run link`），插件本身不依赖 node_modules |
| `.state.json` | 运行时状态（我们写过什么、原生的 tab 名叫什么）|
| `last-run.log` | 运行时日志（超 128KB 自动清空）|
| `labels-before.json` | 首次实测前 9 个 tab 的原始名字，需要还原时用 |

## 命名优先级

`src/naming.mjs` 的 `computeLabel`，从上到下取第一个成立的：

| 优先级 | 来源 (`--json` 里的 `source`) | 说明 |
|---|---|---|
| 1 | `session-name` | **你自己起的名**：pi 里 `/name xxx` 写进会话记录的 `session_info.name`，原样当标签（见下一节）|
| 2 | `session-task` | **这个对话在干什么**：会话记录里的 `ai-title`，否则最近一条像任务的人类消息（见下下一节）|
| 3 | `agent-title` | agent 上报的任务标题（Claude 的终端标题等），去掉前导字形、`<标记> - ` 前缀、纯数字、与目录名重复者 |
| 4 | `agent-name` | 以上都没有时用 tab 自己的名字（`worker-dst-2`），好过所有 tab 都叫 `pi` |
| 5 | `agent-cmdline` | 前台命令里含 `pi-coding-agent` / `…/prefix/pi` / claude / codex / gemini ⇒ 直接认成该 agent |
| 6 | `agent-program` / `program` | 前台程序名（PowerShell 里跑脚本时按 `.sh/.ps1/.py/...` 取脚本名） |
| 7 | `agent-kind` / `shell` | 兜底：agent 类型或 `pwsh` |

三段位置的规则：

- **context**：`cwd` 的目录名；等于 `$HOME` 或等于所在 workspace 的 label 时省略；截到 `maxContextLen`（12，与上游 `MAX_CONTEXT_LEN` 一致）。
- **branch**：`git -C <cwd> rev-parse --abbrev-ref HEAD`；`main`/`master` 不出；`HEAD`（detached）视为空；截到 `maxBranchLen`。
- 分隔符 `contextSep = " › "`（U+203A）。

## 手动命名（`session-name`，与手工改名同级）

两种手动通道**地位相同**，都压过所有自动推断（`session-task` 及以下排在第 2–7 位），彼此之间也**没有**优先级保护 —— 谁更新得晚算谁的：

| 通道 | 怎么用 | 插件怎么发现 |
|---|---|---|
| pi 的 `/name` | 在 pi 里提交 `/name 部署检查` | 尾读会话记录里的 `{"type":"session_info","name":"部署检查","timestamp":"…"}`，把 `name` **原样**当标签（只 `scrub` + 截到 `maxNameLen`，不过 `condenseTask`、不拼目录/分支）|
| herdr 手工改名 | `herdr tab rename w6:t2 部署检查`，或在 UI 里改 | `.state.json` 里记的 label 与 herdr 报的 label 不一致（`hand-renamed`）|

裁决用的是「更新时间」：herdr 的 tab 对象没有时间戳，只有 `session_info` 有 `timestamp`，所以插件把每次用过的 `nameSeenAt` 存进 `.state.json`。

- 手工改过名后，`/name` 的时间戳比 `nameSeenAt` 新 ⇒ 当成新指令，覆盖标签（日志 `renamed (session-name)`）。
- `/name` 没变而 label 变了 ⇒ 是手工改名，从此不碰（`hand-renamed`）。

`sessionName: false` 可关掉整条通道，退回「在做什么」那一套。

## 在干什么（`session-task`）

终端标题对 pi 没用（永远是 `π - <目录名>`），所以名字取自会话记录本身。

**从哪读**：`herdr api snapshot` 里 pane 的 `agent_session`。`kind: "path"` 直接用（pi）；`kind: "id"` 拼成 `%USERPROFILE%\.claude\projects\<cwd 里的非字母数字全换成 ->\<id>.jsonl`（Claude）。

**读什么**：只读文件尾部（默认 64KB，没有能当标签的人类消息就依次试到 256KB / 1MB）；同时读文件头 64KB，把会话的开场白留作兑底。

| 来源 | 记录 | 用法 |
|---|---|---|
| Claude 自写标题 | `{"type":"ai-title","aiTitle":"Herdr 舰队 mgr 交接"}` | 直接采用，最贴合「在做什么」|
| 人类消息 | `{"type":"user"|"message","message":{"role":"user","content":…}}` | `ai-title` 缺失时取最近一条，`content` 为字符串或 `[{type:"text"}]` 都支持；带 `tool_result`/`image` 的（工具结果也记为 user）整条跳过 |
| pi 撤销记录 | `{"type":"custom","customType":"pi-undo-redo","data":{"prompt":…}}` | 前面都没命中时的兜底 |

**怎么压缩成一行**（`condenseTask`，`maxTitleLen` 默认 28 列，中文按 2 格）：去代码块/反引号/链接/复选框/列表号/独占一行的数字 → 折叠空白 → 去开头客套（`请你`/`帮我`/`按照…，`/`那我现在有个问题：`）→ 反复剥连接词（`也就是说`/`那么`/`好的`）→ 只留第一句 → 超宽截断加 `…`。

**怎么挑**（`pickTask`）：`ai-title` > 最近一条宽度 ≥ 12 且不是纯附和的（`我理解了`/`好的`/`继续` 这类会跳过，继续往前找）> 第一条能用的。若近期消息全是追问（`…吗？`/`能不能…`，只是接着上一个回答往下聊），改用会话开场白兜底——但要求它像一条指令（`去…`/`帮…`/`清理…`）而非寒暄。

**开销**：按 `文件大小:mtime` 缓存在 `.state.json` 的 `tasks` 里，会话没变就完全不读文件；`.state.json` 超过 200 条会话时清掉最旧的一半。改了提取/压缩逻辑要顺手把 `src/task.mjs` 的 `TASK_VERSION` 加一，否则旧缓存会一直服务。

## 配置

配置目录（低 → 高优先级，后者覆盖前者）：

1. herdr 给插件的配置目录：`%APPDATA%\herdr\plugins\config\herdr-automatic-rename-win\config.json`（`herdr plugin config-dir herdr-automatic-rename-win` 可查）
2. 插件根目录：`<插件>\config.json`（开发时随代码带配置最方便）

`AR_CONFIG=<path>` 设了则只用它。把 `config.example.json` 复制到任一位置改名 `config.json` 即可覆盖默认值，未知键忽略。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 整个插件开关 |
| `dryRun` | `false` | 只算不写 |
| `nameTabs` / `tabContext` / `showBranch` / `agentTitles` | `true` | 四个总开关 |
| `maxNameLen` / `maxContextLen` / `maxBranchLen` / `maxTitleLen` | 20 / 12 / 12 / 28 | 各段宽度（中文按 2 格算）|
| `minTaskLen` | `7` | 任务标题的最小预算 |
| `maxTotalLen` | `60` | 整条标签上限 |
| `contextSep` | `" › "` | 分隔符 |
| `hideShell` / `shellName` | `false` / `"pwsh"` | 纯 shell 时显示成什么 |
| `defaultBranches` | `["main","master"]` | 不显示的分支 |
| `titleIgnore` | 见 `src/config.mjs` | 标题黑名单 |
| `programAliases` | `{ "WindowsTerminal": "wt" }` | 程序改显示名 |
| `agentNameFallback` | `true` | 无任务标题时用 tab 原名而非 agent 类型 |
| `sessionTask` | `true` | 从会话记录取「在做什么」（关掉就退回终端标题/程序名）|
| `sessionName` | `true` | 把 pi `/name` 给的名字原样当标签（压过 `sessionTask`）|
| `sessionTailBytes` | `65536` | 首次尾读字节数，没命中会试 4× 和 16× |
| `maxProcessLookups` | `16` | 一趟里最多查多少次 `pane process-info` |

环境变量：`AR_CONFIG`（指定配置文件）、`AR_DISABLE=1`、`AR_DRY_RUN=1`、`AR_ONLY_TAB=<tab_id>`、`AR_LOG=<path>`。

## 事件

`tab.created` `tab.closed` `tab.renamed` `tab.focused` `tab.moved`、`pane.created` `pane.closed` `pane.exited` `pane.focused` `pane.moved` `pane.agent_detected` `pane.agent_status_changed`、`startup`。

每个事件都跑一趟完整对账（herdr 没有「前台命令变化」事件，所以靠事件 + 幂等推断）。事件密集时用 `.lock` 目录锁合并：抢到锁的跑一趟，其余直接退出（日志里 `skip: locked`）。

## 手工改名保护

`.state.json` 记着每个 tab 上次被我们写成的名字和上次见过的 `/name` 时间（`nameSeenAt`）。裁决顺序：

1. herdr 报的 label 与记录**一致** ⇒ 是我们自己写的，可以继续改名（日志 `already correct` 或直接改）。
2. 不一致，但会话里的 `/name` 比 `nameSeenAt` **更新** ⇒ 当成新的手动指令，覆盖标签。
3. 不一致，`/name` 也没变 ⇒ 是人手工改的，从此不再碰它（日志 `hand-renamed`）。

想让它重新接管：

```powershell
herdr plugin action invoke herdr-automatic-rename-win.reset --tab w6:t2
# 或
node bin/ar.mjs reset --tab w6:t2
```

已知的小歧义：手工改的名字如果恰好等于插件算出来的目标名，会被记成「我们自己写的」，之后目标变化时被改掉。herdr 的 tab 没有时间戳，这一点无法彻底区分。

顺带：`.state.json` 还会记住「herdr 原生 tab 名」（`ownName`），这样我们自己改完名之后，下一趟不会因为标签里已有 `›` 就把名字退化成 `pi`。

## 调试

```powershell
npm test                               # = node --test，44 个用例
node bin/ar.mjs doctor                 # 干跑全部 tab，打印 现名 -> 目标名 (来源)
node bin/ar.mjs doctor --tab w6:t2     # 只看一个
node bin/ar.mjs doctor --json          # 机器可读
node bin/ar.mjs tab.created --dry-run  # 模拟某个事件
herdr plugin log list --plugin herdr-automatic-rename-win --limit 10
Get-Content last-run.log -Tail 20
```

`doctor` 永不写入任何东西（不改名、不写 `.state.json`）。

## 已验证（herdr 0.9.5 / Windows 11）

- `platforms = ["windows"]` 被接受，插件 `link` 成功、事件被派发（`herdr plugin log list` 显示 `exit_code: 0`）。
- 新建 tab ⇒ 自动改名（`ar-dispatch` → `herdr-autom… › pwsh`）。
- 幂等：同一 tab 再跑一趟 ⇒ `already correct`，无抖动、无 `a › b › a › b` 增长。
- 手工改名保护 ⇒ `hand-renamed`，label 保持不变；`reset` 后重新接管。
- `/name` 通道（2026-11-22 实测）：真实会话里 `{"type":"session_info","name":"创建应用及skill","timestamp":"2026-11-22T14:00:27.171Z"}` ⇒ `w6:t8` 从 `snappymail openBot` 改成 `创建应用及skill`（`source: session-name`）；手工改名留下的 `manual-test` 在 `/name` 未变时一直不被覆盖。
- `44` 个单测（`node --test`，`node:test`）全绿。
- 现有 9 个 tab 全部得到稳定标签，包括三种 agent 形态：Claude（`w5:t1`，标题带中文任务）、Git-Bash 包装的 pi（`sh.exe /e/.../prefix/pi`，只能靠命令行认）、纯 shell。

## 已知限制（P1 边界）

- **没有 `[N]` 序号**：上游会把标签改成 `[3] name` 镜像侧边栏的 alt+N 顺序。这里改完名后 herdr 显示的就是纯名字，数字看不到了（`tab get` 里 `number` 仍然保留）。
- 不含 workspace 命名、pane 边框标题（`pane report-metadata`）、图标表、ssh 上下文。
- 一趟约 1s（10 个 tab）：一次 `api snapshot` + 每 tab 一次 `git`，只有「没有 agent 信息」的 tab 才额外查 `pane process-info`；会话记录只在文件变化时才读。事件风暴时靠锁合并，不影响正确性。
- 「在干什么」是启发式：pi 不写会话标题，所以取的是最近一条像任务的人类消息，可能是一句追问（`你要去掉一个字段`）而不是整段主题。Claude 有 `ai-title` 时最准；想要准就在 pi 里 `/name`。
- 纯 shell tab 的名字来自 `pane process-info` 的第一条前台进程；`pwsh -NoExit -Command <prompt hook>` 这种不会误当成脚本名（只对 POSIX `sh`/`bash`/`zsh`/`fish` 的路径参数做启发）。
- 上游的 bug 面（bash 3.2 兼容、`IFS`、引号）在 Node 版不存在，但没有做 1:1 功能对等。

## 还原标签

```powershell
Get-Content labels-before.json | ConvertFrom-Json | ForEach-Object { herdr tab rename $_.tab_id $_.label }
```
