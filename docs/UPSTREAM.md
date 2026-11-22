# 与上游的关系

上游：[qu8n/herdr-automatic-rename](https://github.com/qu8n/herdr-automatic-rename)（MIT）。

## 为什么要有这个移植

上游的 `herdr-plugin.toml` 写着：

```toml
platforms = ["linux", "macos"]
```

实现是 bash + jq：命名规则在 `naming.sh`（约 1300 行），调度在 `automatic-rename.sh`（约 3200 行），另有约 4000 行测试。Windows 上 herdr 能跑，但这个插件跑不了——没有 bash，也没有 jq。

重写而不是「装个 Git-Bash」的理由：

- bash 版依赖 `IFS`、引号、`printf` 的行为，在 Git-Bash 下与 Linux 仍有差异；
- 每次事件 spawn 一个 bash + 若干 jq，Windows 上启动成本高；
- 规则本身是纯字符串处理，Node 的原生 JSON 与正则更直接，也更容易测。

## 保留了什么

- **标签语义**：`context › branch › activity`，`contextSep = " › "`（U+203A）；
- **截断预算**：`maxContextLen` / `maxBranchLen` 默认 12，与上游 `MAX_CONTEXT_LEN` 一致；
- **手工改名保护**：上游也尊重人手改的名字，并提供 reset 交还；
- **MIT 许可与版权声明**：见 `LICENSE`。

## 故意没做的（P1 边界）

| 上游能力 | 状态 | 原因 |
|---|---|---|
| `[N]` 序号（镜像 alt+N） | 未做 | herdr 的 tab 对象没有稳定的序号语义，写进标签后与侧边栏仍可能不同步 |
| workspace 命名 | 未做 | 需要 `workspace` 级 API 与更多状态 |
| pane 边框标题（`pane report-metadata`） | 未做 | 与 tab 命名是两条独立链路 |
| 图标表 / ssh 上下文 | 未做 | 上游用 bash 的进程树推断，Windows 上需要另找数据源 |
| 20+ 事件 + shell hook | 部分 | herdr 没有「前台命令变化」事件；这里用 12 个事件 + 幂等全量对账替代 |
| transcript 任务标题 | 已做（扩展） | 上游读 `~/.claude/projects`；这里同时支持 pi 的会话 jsonl 与 Claude 的 `ai-title` |

## 与上游行为的差异

1. **agent 识别看命令行**：Windows 上 pi 常是 `sh.exe /e/…/prefix/pi`，进程名只有 `sh`，所以 `agent-cmdline` 是独立的一级。
2. **`/name` 通道**：上游没有；这是 pi 特有的 `session_info` 记录。
3. **配置合并**：上游读 herdr 插件配置目录；这里读两处（herdr 配置目录 < 插件根），因为开发时把配置放在仓库里更方便。
4. **state 位置**：上游放插件根；这里放 herdr 插件配置目录，因为 `herdr plugin update` 会替换插件根。

## 上游值得借鉴的地方

- `naming.sh` 的字符串清洗规则（字形剥离、`<标记> - <任务>` 拆分）—— 这里的 `taskFromTitle` 是它的 Node 版；
- 事件表与 `config.example` 的组织方式；
- 测试覆盖率：上游有约 4000 行测试，这里目前 100 个 `node:test` 用例，主要集中在纯函数、对账流程、配置/状态与 CLI。
