# herdr-automatic-rename-win

[English](README.en.md) · [更新日志](CHANGELOG.md) · [MIT](LICENSE)

给 herdr 的 Windows 插件：**每个标签页自动叫出「这个对话在干什么」**。

上游 [qu8n/herdr-automatic-rename](https://github.com/qu8n/herdr-automatic-rename) 声明 `platforms = ["linux", "macos"]`，整套逻辑跑在 bash + jq 上。本仓库保留它的命名语义，把执行层重写成 Node（原生 JSON、无 jq、无 `IFS`/引号问题），并针对 Windows 的前台进程与 pi / Claude Code 的会话记录做了适配。

```
主管
自建商店项目修复 bug
LiveSyncService 自建
emby自动观看脚本
NTFY 配置方案讨论 文件权限…
pwsh
```

标签有三种形态，取决于你开了哪些段：

| 配置 | 形态 | 例子 |
|---|---|---|
| 默认 | `目录 › 分支 › 在干什么` | `Herdr › feat-auth › fixes the token refresh` |
| `showBranch: false` | `目录 › 在干什么` | `Herdr › fixes the token refresh` |
| `tabContext: false, showBranch: false` | 只有「在干什么」 | `fixes the token refresh` |

## 要求

- Windows 10/11
- herdr ≥ 0.7.1
- Node.js ≥ 20（`node` 在 `PATH` 上；herdr 用它启动本插件）

## 安装

三种方式选一种。装好后 herdr 会在每个事件上执行 `node bin/ar.mjs <event>`，工作目录是插件根目录。

### A. 从 GitHub 安装（推荐）

```powershell
herdr plugin install Aquilonar/herdr-automatic-rename-win --ref v0.2.0 -y
herdr plugin enable herdr-automatic-rename-win
```

升级：`herdr plugin update herdr-automatic-rename-win`。

### B. Release 包 + 安装脚本

下载 `herdr-automatic-rename-win-0.2.0.zip` 解压，或直接克隆仓库，然后：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

脚本会检查 `herdr` / `node`、把插件放到 `%LOCALAPPDATA%\herdr-automatic-rename\0.2.0\`、`unlink` 旧链接再 `link` 新路径，最后跑一次 `doctor`。
卸载：`.\scripts\uninstall.ps1`。

### C. 从 npm 安装

```powershell
npm install -g herdr-automatic-rename-win
herdr plugin link "$(npm root -g)\herdr-automatic-rename-win" --enabled
```

npm 安装的目录名就是包名，正好满足下面的目录名要求。

### 本地开发

```powershell
git clone https://github.com/Aquilonar/herdr-automatic-rename-win
cd herdr-automatic-rename-win
npm test
npm run link        # = herdr plugin link . --enabled
```

> **目录名必须是 `herdr-automatic-rename-win`。** 插件用「自己的目录名」定位 herdr 的配置目录（`%APPDATA%\herdr\plugins\config\<目录名>`）。改过名的话用 `HERDR_PLUGIN_CONFIG_DIR` 或 `HERDR_AUTOMATIC_RENAME_CONFIG` 显式指定。

## 名字从哪来

`src/naming.mjs` 的 `computeLabel`，从上往下取第一个成立的（`--json` 里的 `source` 字段就是它）：

| 优先级 | `source` | 来源 |
|---|---|---|
| 0 | — | **你手工改的 tab 名**（`hand-renamed`）：label 不是 herdr 的数字默认值、又不像我们写的样子（含 `›`），或者和我们上次写的不同 ⇒ 当成你改的，一直不动 |
| 1 | `session-name` | **你自己给会话起的名字**：pi 的 `/name xxx`、`--name`，或扩展调 `pi.setSessionName()`，记录在会话 jsonl 的 `session_info.name` 里，**原样**当标签（不拼目录/分支、不做压缩） |
| 2 | `session-task` | **这个对话在干什么**：Claude 自写的 `ai-title`，否则最近一条像任务的人类消息（详见下节） |
| 3 | `agent-title` | agent 上报的终端标题。Claude 会写任务；pi 永远写 `π - <目录>`，所以对 pi 无效 |
| 4 | `agent-name` | tab 自己的名字（`worker-dst-2`），好过让所有 pi tab 都叫 `pi` |
| 5 | `agent-cmdline` | 前台命令行里出现 `pi-coding-agent` / `…/prefix/pi` / `claude` / `codex` / `gemini` ⇒ 认成该 agent |
| 6 | `agent-program` / `program` | 前台程序名；PowerShell 里跑脚本时取 `.sh/.ps1/.py` 的脚本名 |
| 7 | `agent-kind` / `shell` | 兜底：agent 类型，或 `pwsh` |

**位置与分支**

- `context`：`cwd` 的目录名。等于 `$HOME`、或等于所在 workspace 的 label 时省略（不重复说同一件事）；截到 `maxContextLen`（默认 12 列）。
- `branch`：`git -C <cwd> rev-parse --abbrev-ref HEAD`。`main`/`master` 不显示，`HEAD`（detached）视为空；截到 `maxBranchLen`（12）。
- 分隔符 `contextSep`，默认 `" › "`（U+203A）。

### 「在干什么」怎么读出来的

pi 的终端标题没有信息量，所以任务取自 **agent 自己的会话记录**：

| agent | 记录位置 | 标题来源 |
|---|---|---|
| pi | `agent_session.value`（绝对路径，`%PI_CODING_AGENT_DIR%\sessions\…jsonl`） | 无自写标题 ⇒ 最近一条像任务的人类消息；`custom/pi-undo-redo.data.prompt` 兜底 |
| Claude Code | `%USERPROFILE%\.claude\projects\<cwd 变形>\<id>.jsonl`（cwd 中非字母数字全换成 `-`） | `{"type":"ai-title","aiTitle":"…"}` 优先，否则最后一条人类消息 |

只读文件尾部（默认 64KB，没有可用内容就依次试 256KB、1MB），同时读文件头 64KB 把开场白留作兜底。压缩规则（`condenseTask`）：去代码块/链接/复选框/列表号 → 去开头客套（`请你`/`帮我`/`按照…，`/`那我现在有个问题：`）→ 反复剥连接词（`也就是说`/`那么`/`好的`）→ 只留第一句 → 超宽按显示宽度截断加 `…`。挑选规则（`pickTask`）：`ai-title` > 最近一条宽度 ≥ 12 且不是纯附和的 > 第一条不像追问的；近期全是追问时用开场白兜底。

**开销**：按 `(TASK_VERSION, 文件大小, mtime)` 缓存在 state 文件里，会话没变就完全不读盘。

## 自动命名：once / follow

`autoMode` 决定「自动起的名字」还跟不跟着对话变：

| 值 | 行为 |
|---|---|
| `once`（默认） | 先给个占位名（程序名/agent 名），等这个会话**第一次完成**（助手消息的 `stopReason`/`stop_reason` 不是 `tool_use` 一类，或出现 `result` 记录）且读到有意义的名字（`/name`、任务摘要、`ai-title`）时改名，然后**冻结**，之后对话再变也不动它 |
| `follow` | 每次对账都按当前对话更新，适合想让标签实时反映进度的场景 |

冻结是「黏住好名字」而不是「锁死」：你之后手工改 tab 名、或再敲一次 `/name`，仍然会覆盖它（两条同级手动通道）。另外有**不许退化**：`session-name` > `session-task` > `agent-title` > `agent-name` > `agent-cmdline` > `agent-program` > `program` > `agent-kind` > `shell`，一趟读不到会话（比如文件被清理）只会保留旧标签，不会退回 `pwsh`。

## 手动命名（两条同级通道）

| 通道 | 怎么用 | 插件怎么发现 |
|---|---|---|
| pi `/name` | 在 pi 里 `/name 部署检查` | 读 `{"type":"session_info","name":"部署检查","timestamp":"…"}`：先看尾部；有缓存名或刚升过 `TASK_VERSION` 而尾部没有时，全文扫一次最后一条 |
| herdr 改名 | `herdr tab rename w6:t2 部署检查` 或 UI 里改 | state 里记的 label 与 herdr 报的不一致 ⇒ `hand-renamed`；**从没记录过**的 tab，只要 label 不是数字、也不含 `›`，同样算你改的（新建 tab 后 3 秒内改名就是这种情况） |

两者**没有优先级保护**，谁更新得晚算谁的。herdr 的 tab 对象没有时间戳，只有 `session_info` 有 `timestamp`，所以插件把每次用过的 `nameSeenAt` 记在 state 里：

- `/name` 的时间戳比 `nameSeenAt` 新 ⇒ 新指令，覆盖标签；
- label 变了而 `/name` 没变 ⇒ 手工改名，从此刻不再碰；
- 第一次见到某个 tab 时，只有数字默认名 / 像我们写的名字才允许改写，其余一律先记成手改。

想让某个 tab 重新回到自动命名：

```powershell
herdr plugin action invoke herdr-automatic-rename-win.reset   # 全部
node bin/ar.mjs reset w6:t2                                   # 单个（也接受 --tab w6:t2）
```

> 已知歧义：手工改的名字恰好等于插件算出的目标名时，会被记成「我们自己写的」，之后目标变化时被改掉。没有 tab 时间戳就无法彻底区分。

## 配置

配置文件按**低 → 高**优先级合并：

1. `%APPDATA%\herdr\plugins\config\herdr-automatic-rename-win\config.json`（`herdr plugin config-dir herdr-automatic-rename-win` 可查）
2. `<插件根>\config.json`（开发时随代码带配置方便）

设了 `HERDR_AUTOMATIC_RENAME_CONFIG`（旧名 `AR_CONFIG`）就只用它。未知键、类型错误只会进 `doctor` 的警告，不会让插件停工。示例见 [`examples/`](examples)：`config.minimal.json`、`no-context.json`、`full.json`。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dryRun` | `false` | 只算不写 |
| `nameTabs` | `true` | 是否改名（关掉就只观察） |
| `tabContext` | `true` | 标签里带目录名 |
| `showBranch` | `true` | 标签里带 git 分支 |
| `agentTitles` | `true` | 采用 agent 上报的终端标题 |
| `sessionTask` | `true` | 从会话记录推导「在干什么」 |
| `sessionName` | `true` | 采用 `/name` 给的名字（原样） |
| `autoMode` | `"once"` | `once` = 第一轮完成后命名并冻结；`follow` = 一直跟着对话改 |
| `sessionTailBytes` | `65536` | 首次尾读字节数（会试 4×、16×） |
| `maxNameLen` | `20` | 程序名 / 兜底名 / `/name` 的宽度 |
| `maxContextLen` | `12` | 目录段宽度 |
| `maxBranchLen` | `12` | 分支段宽度 |
| `maxTitleLen` | `28` | 任务段宽度 |
| `minTaskLen` | `7` | 短于这个宽度当它没说任务 |
| `maxTotalLen` | `60` | 整条标签上限 |
| `contextSep` | `" › "` | 分隔符 |
| `hideShell` | `false` | 纯 shell 时是否留空 |
| `shellName` | `"pwsh"` | 纯 shell 显示成什么 |
| `shellPrograms` | 见 `src/config.mjs` | 视为 shell 的程序 |
| `ignoredPrograms` | `ls`/`cat`/`cd`… | 一次性命令：保持 shell 名不闪 |
| `programAliases` | `{}` | 程序显示名覆盖，如 `{ "clx": "hn" }` |
| `agentNameFallback` | `true` | 无任务时用 tab 原名而非 agent 类型 |
| `titleIgnore` | 见 `src/config.mjs` | 视为「只是 agent 名」的标题 |
| `defaultBranches` | `["main","master"]` | 不显示的分支 |
| `stateDir` | `""` | state 目录；空 = herdr 插件配置目录 |
| `stateFileName` | `"state.json"` | state 文件名 |
| `logFileName` | `"last-run.log"` | 日志文件名 |
| `logMaxBytes` | `131072` | 日志超过就清空 |
| `cacheMaxSessions` | `200` | 会话缓存上限（超过清最旧一半） |
| `maxProcessLookups` | `16` | 一趟里最多几次 `pane process-info` |
| `timeoutMs` | `8000` | 每次 herdr/git 调用的超时 |
| `herdrBin` | `""` | 空 = 用 `PATH` 上的 `herdr` |

**环境变量**（旧 `AR_*` 名字仍兼容）：

| 变量 | 作用 |
|---|---|
| `HERDR_AUTOMATIC_RENAME_CONFIG` / `AR_CONFIG` | 指定配置文件（独占） |
| `HERDR_AUTOMATIC_RENAME_DISABLE=1` / `AR_DISABLE=1` | 停用 |
| `HERDR_AUTOMATIC_RENAME_DRY_RUN=1` / `AR_DRY_RUN=1` | 干跑 |
| `HERDR_AUTOMATIC_RENAME_TAB=<id>` / `AR_ONLY_TAB` | 只处理一个 tab |
| `HERDR_AUTOMATIC_RENAME_LOG=<path>` / `AR_LOG` | 换日志文件 |
| `HERDR_AUTOMATIC_RENAME_STATE_DIR=<dir>` | 换 state 目录 |
| `HERDR_PLUGIN_CONFIG_DIR=<dir>` | 换 herdr 的插件配置目录 |

## 命令

```powershell
herdr-automatic-rename doctor                 # 干跑：每个 tab 现在叫什么、应该叫什么、为什么
herdr-automatic-rename doctor --tab w6:t2     # 只看一个
herdr-automatic-rename doctor --json          # 机器可读
herdr-automatic-rename reset [w6:t2]         # 忘掉我们的标签，让 tab 重新参与自动命名
herdr-automatic-rename --version
herdr-automatic-rename tab.created --dry-run  # 模拟某个事件（排查用）
```

`doctor` **永不写任何东西**（不改名、不写 state），并会打印实际读到的配置文件、state 路径、herdr 与 node 版本、以及配置警告。

日志默认在 `%APPDATA%\herdr\plugins\config\herdr-automatic-rename-win\last-run.log`，超过 128KB 清空。

## 事件与调度

订阅 `tab.created` `tab.closed` `tab.renamed` `tab.focused` `tab.moved`、`pane.created` `pane.closed` `pane.exited` `pane.focused` `pane.moved` `pane.agent_detected` `pane.agent_status_changed`，外加一次 `startup`（herdr 恢复会话后把名字补回去）。

herdr 没有「前台命令变化」事件，所以每个事件都跑一趟**幂等的完整对账**：算出来的名字与现状相同就跳过（`already correct`），因此我们的 rename 再次触发 `tab.renamed` 也不会形成循环。事件风暴时用目录锁合并，抢不到锁的那趟直接退出（日志 `skip: locked`）。

一趟 = 1 次 `api snapshot` + 每个有 git 目录的 tab 一次 `git`；只有「廉价来源看不出来」的 tab 才额外查 `pane process-info`（有上限）。10 个 tab 约 100–200ms。

## 数据与隐私

- 只**读**会话记录，且只读首尾各几十 KB；不上传、不联网。
- 只写两处：herdr 的 `tab rename`，以及自己的 state / log 文件（都在 herdr 的插件配置目录）。
- 不修改任何 pi / Claude 的会话文件。

## 已知限制

- 没有 `[N]` 序号（上游会把 alt+N 的顺序写进标签）；`tab get` 里的 `number` 仍在。
- 不含 workspace 命名、pane 边框标题（`pane report-metadata`）、图标表、ssh 上下文。
- 「在干什么」是启发式：pi 不写会话标题，取到的是「最近一条像任务的人类消息」，可能只覆盖一轮对话；要精确就在 pi 里 `/name`。
- 纯 shell tab 的名字来自 `pane process-info` 的第一条前台进程；`pwsh -NoExit -Command <hook>` 的脚本正文不会被误当成程序名（只对 POSIX `sh`/`bash`/`zsh`/`fish` 的路径参数做启发）。
- 事件驱动 + 幂等推断，不是实时监听：切 tab、发消息等事件到达后才会更新（通常 < 1s）。
- 只在 Windows 11 + herdr 0.9.5 + Node 24 上实测；`platforms = ["windows"]`。

## 卸载

```powershell
herdr plugin disable herdr-automatic-rename-win
herdr plugin unlink  herdr-automatic-rename-win
```

`unlink` 只解除链接，不删你的 state / 配置；要彻底清掉就删 `%APPDATA%\herdr\plugins\config\herdr-automatic-rename-win\`。npm 全局安装的再 `npm uninstall -g herdr-automatic-rename-win`。

被本插件改过的 tab 名不会自动还原，逐个改回或 `herdr tab rename <id> <name>`。

## 开发

```
herdr-plugin.toml   manifest：1 startup + 12 events + reset/doctor 两个 action
bin/ar.mjs          CLI 入口（薄壳）
src/paths.mjs       插件目录、herdr 配置目录
src/config.mjs      默认值、两层配置合并、白名单校验、环境变量
src/state.mjs       state 结构、v1→v2 迁移、原子写、目录锁
src/herdr.mjs       唯一执行 herdr CLI 的模块
src/reconcile.mjs   一趟对账：快照 → 每 tab 算名字 → 改名；手工改名/`/name` 裁决
src/naming.mjs      纯函数：命名优先级与拼装
src/task.mjs        纯函数：会话 jsonl → 「在干什么」
src/text.mjs        宽度感知的裁剪（CJK 按 2 格）
src/log.mjs         日志
src/main.mjs        CLI
test/*.test.mjs     node:test，假 herdr 驱动，不需要真的 herdr
```

```powershell
npm test          # node --test
npm run doctor    # 干跑
npm run pass      # 真跑一趟（--verbose）
```

设计约定：

- **规则是纯函数**。`naming.mjs` / `task.mjs` / `text.mjs` 不碰 herdr、不碰文件系统，所以规则可以穷举测试；`reconcile.mjs` 只做编排。
- **一次事件一趟对账，且幂等**。任何时候中断都不会留下半个状态：state 原子写（临时文件 + rename），改名本身是幂等的。
- **加一级命名来源**：在 `computeLabel` 的分支里返回 `{ label, source: "你的来源" }`，并在 `test/naming.test.mjs` 加用例；`source` 会出现在 `doctor --json` 里，便于排查。
- **改了 `task.mjs` 的提取/压缩逻辑，就把 `TASK_VERSION` 加一**：会话缓存以它为戳，否则旧缓存会一直服务。

发布：

```powershell
npm test
npm version patch          # 同步 package.json
# 同步 herdr-plugin.toml 的 version（manifest.test.mjs 会检查一致性）
git tag v0.2.1 && git push --tags
gh release create v0.2.1 --generate-notes
npm publish
```

## 许可

MIT。命名语义与部分规则来自 [qu8n/herdr-automatic-rename](https://github.com/qu8n/herdr-automatic-rename)（MIT），见 [LICENSE](LICENSE)。
