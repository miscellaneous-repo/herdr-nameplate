# 设计说明

## 约束

herdr 插件是**进程级**的：每个事件 spawn 一次 `node bin/ar.mjs <event>`，进程之间没有共享内存，herdr 也不读 stdout。由此推出三条硬约束：

1. **一趟必须能独立完成**：拿不到上一趟的内存，只能读 state 文件与 herdr 快照。
2. **不能抛异常**：抛了只会进 herdr 的插件日志，用户看不到；错误写进自己的日志文件。
3. **必须幂等**：改名会再次触发 `tab.renamed`，如果一趟的结果依赖「改过几次」，就会抖动。

## 一趟对账

```
herdr event
   └─ node bin/ar.mjs <event>
        ├─ loadConfig()                 两层 config + 环境变量 + CLI
        ├─ acquireLock()                目录锁；抢不到就退出（skip: locked）
        ├─ herdr api snapshot           一次，拿 tabs/panes/workspaces/agents
        ├─ for each tab
        │    ├─ 读 state 判断是否手工改名
        │    ├─ git -C <cwd> rev-parse  有 cwd 才算；可关
        │    ├─ resolveSession()        尾读会话 jsonl（有缓存）
        │    ├─ computeLabel()          纯函数，按优先级取第一个成立的
        │    ├─ 需要时 pane process-info 只有廉价来源不成立才查，有上限
        │    └─ 与现状不同才 tab rename
        └─ saveState()                  原子写
```

选择「每事件全量对账」而不是增量状态机，是因为 herdr 的事件并不覆盖所有变化（没有「前台命令变化」事件），增量状态机迟早会漂移；全量的代价只是一次 snapshot 与几次 `git`，换来的是任何时刻中断都不会留下不一致。

## 模块边界

| 模块 | 知道什么 | 不知道什么 |
|---|---|---|
| `paths` | 自己在哪个目录、herdr 配置目录在哪 | 配置内容 |
| `config` | 默认值、合并顺序、校验 | herdr、文件系统之外的东西 |
| `state` | state 结构、迁移、原子写、锁 | 标签怎么算 |
| `herdr` | 怎么调 herdr CLI、返回什么形状 | 命名规则 |
| `naming` | 命名优先级与拼装（**纯函数**）| 文件、进程、herdr |
| `task` | 会话 jsonl 怎么读、怎么压缩成一行（**纯函数**）| 配置从哪来、herdr |
| `reconcile` | 把上面几件事编排成一趟 | 具体规则、具体传输 |
| `main` | 参数、动作、输出 | 编排细节 |

纯函数模块（`naming` / `task` / `text`）不 import `fs`，所以可以用构造好的输入穷举边界；这也是测试不需要真 herdr 的原因。

## 状态

```jsonc
{
  "version": 3,
  "tabs": {
    "w6:t2": {
      "label": "自建商店项目修复 bug",  // 我们上次写进去的标签
      "source": "session-name",          // 哪个来源算出来的（排查用）
      "provenance": "auto",              // auto = 我们起的；manual = 人改的，永远不动
      "frozen": true,                    // once 模式下已定稿，不再跟着对话变
      "ownName": "worker-dst-2",         // herdr 的原生 tab 名，改名后仍记得
      "nameSeenAt": "2026-11-22T14:00:27.171Z" // 上次见到的 /name 时间
    }
  },
  "sessions": {
    "C:\\Users\\x\\.pi\\sessions\\…jsonl": {
      "stamp": "10:12345:1700000000000", // TASK_VERSION:size:mtime
      "name": "", "nameAt": "", "task": "…", "completed": true
    }
  }
}
```

- **原子写**：写 `<path>.<pid>.tmp` 再 `renameSync`，断电不会留下半个 JSON。
- **v1 → v2 → v3**：v1 的 `tasks` 直接当 `sessions`；v2 的 tab 补 `provenance`（`manual` 布尔字段优先）与 `frozen`（有标签就算已定稿）；stamp 里带 `TASK_VERSION`，逻辑变了旧条目自然失效。
- **上限**：`cacheMaxSessions`（200）超过后按插入顺序删掉最旧的一半。
- **位置**：默认在 herdr 的插件配置目录，因为插件根目录会在 `herdr plugin update` 时被整体替换。

## 自动命名状态机（`autoMode`）

```
            首轮未完成            首轮完成 + 读到有意义的名字
  占位名 ───────────────► 任务名 ─────────────────────────► frozen
  (program/agent)          (session-name/task/title)          │
                                                               │ 手工 rename / 新 /name
                                                               ▼
                                                          manual（永久）
```

- `once`（默认）：只有 `MEANINGFUL` 来源（`session-name`、`session-task`、`agent-title`）才允许冻结；程序名只是占位符。
- `follow`：不设 `frozen` 限制，每趟按最新会话重算。
- 两种模式都受「不许退化」约束：`SOURCE_RANK` 分数低的来源不能覆盖分数高的旧标签，除非当前还是数字默认名或标签已经漂移。
- `completed` 来自会话记录：pi 的 `stopReason`、Claude 的 `message.stop_reason`（`tool_use` 一类不算完成），或 `type:"result"`。

## 手工改名的判定

herdr 的 tab 没有时间戳、没有 revision，只有一个当前 label。所以「这个 label 是谁写的」只能靠我们自己的记忆：

```
没有记录（新 tab / state 丢过）
  ├─ label 是数字（herdr 默认） → 我们的，可以改
  ├─ label 含分隔符 ›          → 像我们的，可以改
  └─ 其它                      → 当你手改的，记下来，不动

有记录
  recorded.label === tab.label          → 是我们写的，可以继续改
  recorded.label !== tab.label          → 不是我们写的
     ├─ /name 的 timestamp > nameSeenAt → 是你刚 /name 的，覆盖
     └─ 否则                            → hand-renamed，永远别碰
```

第一条分支是 0.2.1 补的：`tab.created` 事件有约 3 秒防抖，新建 tab 后立刻改名时我们还没有任何记录，旧逻辑会把 label 当成自己写的、下一趟改回 `pwsh`。

`/name` 记录会滚出尾读窗口（长会话可达数 MB），所以 `readSessionName` 在「有缓存名」或「刚换过 `TASK_VERSION`」时全文扫一次，并把名字粘在 state 里。

两条通道（`/name` 与 UI 改名）因此是同级：谁后发生听谁的。代价是「手工改的名字恰好等于目标名」无法区分——没有时间戳就没有办法。

## 事件风暴

herdr 在切 tab、agent 状态变化时会连发多个事件。`state.mjs` 的 `acquireLock` 用 `mkdir` 的原子性做互斥（Windows 上同样可靠），目录锁超过 30 秒视为上一个进程已死、强制接管。抢不到锁的进程立刻退出，不排队——反正下一个事件马上就来。

## 失败面

| 失败 | 处理 |
|---|---|
| `herdr api snapshot` 失败 | 整趟失败，写日志，退出码 0 |
| `git` 失败（不是仓库） | 分支段为空，不影响其他段 |
| `pane process-info` 失败 | 记 `errors[]`，该 tab 用兜底来源 |
| 会话文件读不了 | 记 `errors[]`，该 tab 退回终端标题/程序名 |
| `tab rename` 失败 | 记 `errors[]`，不写 state（下一趟重试） |
| state 写失败 | 记 `errors[]`，标签已经改了（下一次对账修正） |
| 配置文件坏 | `warnings`，用默认值继续 |
