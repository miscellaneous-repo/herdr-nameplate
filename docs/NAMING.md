# 命名规则详解

## 一段标签由三部分组成

```
<context> › <branch> › <activity>
```

`contextSep` 默认是 `" › "`（U+203A，不是 `>`）。三段各自有宽度预算，最后再用 `maxTotalLen` 兜底，所以标签不会因为某一段特别长而挤爆侧边栏。

## context（位置）

1. `cwd` 转成 `/`、去掉尾斜杠，取 basename。
2. 等于 `$HOME`（`HOME` 或 `USERPROFILE`）⇒ 空。
3. 等于所在 workspace 的 label（大小写不敏感）⇒ 空（`Herdr › Herdr` 没有信息量）。
4. 截到 `maxContextLen`，超宽加 `…`。

`tabContext: false` 直接关掉这一段。

## branch（分支）

`git -C <cwd> rev-parse --abbrev-ref HEAD`：

- 不是仓库 / `git` 不在 PATH ⇒ 空；
- `HEAD`（detached）⇒ 空；
- 在 `defaultBranches`（默认 `main`、`master`）里 ⇒ 空；
- 否则截到 `maxBranchLen`。

`showBranch: false` 关掉这一段，也就不再 spawn `git`。

## activity（在干什么）

按优先级：

### 1. `session-name`

会话记录里的 `session_info.name`（pi 的 `/name`、`--name`、`pi.setSessionName()`）。

**原样使用**：只做 `scrub`（去控制字符、折叠空白）+ 截到 `maxNameLen`。不过 `condenseTask`——你写的名字就是成品，不该被「去客套词」改掉。也不拼 context/branch。

### 2. `session-task`

见 README 的「在干什么怎么读出来的」。要点：

- Claude 的 `ai-title` 是 agent 自己写的标题，最准；
- pi 没有标题，取最近一条「像任务」的人类消息；
- 纯附和（`我理解了`、`好的`、`继续`）与追问（`…吗？`、`能不能…`）会跳过；
- 近期全是追问时，用会话开场白兜底，但要求它像指令（`去…`/`帮…`/`清理…`）；
- `condenseTask` 的输出按显示宽度截断（CJK 算 2 格）。

### 3. `agent-title`

agent 上报的终端标题。处理：

- 去掉前导非字母数字（spinner、`✳`、`π` 后的分隔符由下一步处理）；
- `<1-6 字符标记> - <rest>` 形式只留 `rest`；`rest` 也说不清就整条拒绝；
- 纯数字 ⇒ 拒绝（那是 herdr 自己的编号）；
- 等于 agent kind（`pi`）、`<kind> code`、`<kind> cli`、目录名、`titleIgnore` 里的项 ⇒ 拒绝；
- 宽度 < 4 且字符数 < `minTaskLen` ⇒ 拒绝；
- 如果以 context 段开头，把重复的前缀剥掉（`Herdr › Herdr 舰队交接` → `Herdr › 舰队交接`）。

### 4. `agent-name`

tab 的原生名字（`worker-dst-2`、`skill-1`）。只要求：不是纯数字、显示宽度 ≥ 3。

这一级存在的理由：pi 的终端标题永远是 `π - <目录>`，如果直接落到 `agent-kind`，三个 pi tab 会全叫 `pi`。原生 tab 名至少能区分它们。

`agentNameFallback: false` 关掉。

### 5. `agent-cmdline`

`pane process-info` 的 `foreground_processes[0]`，把 `argv` 拼成一行后匹配：

| 正则 | 结论 |
|---|---|
| `pi-coding-agent` | pi |
| `[\\/]pi(\.exe\|\.cmd\|\.ps1\|\.mjs)?(\s\|$)` | pi |
| `claude-code` / `@anthropic-ai/claude` / `[\\/]claude…` | claude |
| `codex-cli` / `@openai/codex` / `[\\/]codex…` | codex |
| `gemini-cli` / `@google/gemini` / `[\\/]gemini…` | gemini |

Windows 上 pi 常常是 Git-Bash 包装：`sh.exe /e/…/prefix/pi --model …`，进程名只有 `sh`，所以必须看命令行。

### 6. `agent-program` / `program`

前台程序名（去路径、去 `.exe`），经 `programAliases` 映射。

**shell 包装器**：`sh`/`bash`/`zsh`/`dash`/`ksh`/`fish` 带一个「像路径」的参数时，用那个参数的 basename 当程序名（`sh.exe /e/…/pi` ⇒ `pi`）。PowerShell **不在此列**：herdr 用 `pwsh -NoExit -Command <prompt hook>` 启动它，`-Command` 后面是脚本正文而不是程序名，曾因此把标签写成 `' }; $out } }`。

`ignoredPrograms`（`ls`/`cat`/`cd`…）⇒ 保持 shell 名，避免按一下回车标签就闪。

### 7. `agent-kind` / `shell`

- 有 agent 但没有进程信息 ⇒ agent kind（`pi`、`claude`…）；
- 普通 shell ⇒ `shellName`（默认 `pwsh`）。

`hideShell: true` 时这一级为空，标签退回只剩 context/branch。

## 宽度与截断

`truncate()` 逐码点累加，CJK 算 2 格，超宽时留 1 格放 `…`。标签是纯文本（不含 ANSI），所以不需要处理转义序列。

## 什么时候会变（autoMode）

| `autoMode` | 行为 |
|---|---|
| `once`（默认） | 首轮未完成时先用程序名/agent 名占位；首轮完成（`stopReason`/`stop_reason` 不是 `tool_use` 一类，或出现 `result`）且算出 `session-name` / `session-task` / `agent-title` 时改名并冻结；此后不再变，直到人工改名或新的 `/name` |
| `follow` | 每趟对账都按最新会话重算，适合想让标签实时反映进度 |

**不许退化**：来源有明确分数（`session-name` 100 > `session-task` 90 > `agent-title` 80 > `agent-name` 70 > `agent-cmdline` 60 > `agent-program` 55 > `program` 50 > `agent-kind` 40 > `shell` 30）。一趟读不到会话（文件被清理、临时锁冲突）只会保留旧标签，不会退回 `pwsh`。当前 label 还是 herdr 的数字默认名、或已经被人改过时，不受这条限制。

## 为什么不用 LLM 取名

讨论过：可以（`ctx.modelRegistry.complete()` + `pi.setSessionName()`），但那需要另一个进程、另一个失败面、以及每次会话的 token 成本。当前方案零网络、零模型、纯本地，且 `/name` 已经给了人工精确控制的入口。要加的话，写端是 pi 扩展，读端（`session_info`）不用改。
