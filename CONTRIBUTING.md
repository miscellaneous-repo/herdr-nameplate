# 贡献指南

## 开发

```powershell
git clone https://github.com/Aquilonar/herdr-automatic-rename-win
cd herdr-automatic-rename-win
npm test
npm run link        # 把当前目录链进 herdr，改代码后事件即生效
npm run doctor      # 干跑，看看每个 tab 会被叫什么
```

没有构建步骤：源码就是发布物，Node ≥ 20 直接跑 `.mjs`。

## 提交前

```powershell
npm test            # 必须全绿
node bin/ar.mjs --version
```

## 代码约定

- `src/naming.mjs`、`src/task.mjs`、`src/text.mjs` **不 import `node:fs`**：规则是纯函数，测试才能不依赖真实 herdr 与会话文件。
- 新的命名来源：在 `computeLabel` 里返回 `{ label, source: "你的来源", ctx, branch, activity }`，并在 `test/naming.test.mjs` 加用例。`source` 会出现在 `doctor --json` 里。
- 改了 `task.mjs` 的提取或压缩逻辑：把 `TASK_VERSION` 加一，否则旧缓存会一直服务。
- 新的配置键：加进 `src/config.mjs` 的 `DEFAULTS` 与相应的类型集合（`BOOLEAN_KEYS` / `NUMBER_KEYS` / `ARRAY_KEYS`），并在 README 的配置表里补一行。未知键只会 warning，不会被应用。
- 错误处理：一个 tab 的失败记进 `errors[]`，不要让整趟抛异常；herdr 会吞掉 stderr。
- 字符串截断一律用 `text.mjs` 的 `truncate`（终端格数，CJK 算 2 格）。

## 版本与发布

- `package.json` 与 `herdr-plugin.toml` 的 `version` 必须一致；`test/manifest.test.mjs` 会检查。
- 破坏性变更（state 结构、配置语义）要升 `STATE_VERSION` 或 `TASK_VERSION`，并在 `CHANGELOG.md` 写清迁移方式。
- 发布流程见 README 的「开发」一节。

## 报告问题

请附上：

- `node bin/ar.mjs doctor --json` 的输出（`--json` 不含路径以外的隐私内容，但会包含 cwd 与 tab 名，自行脱敏）；
- `%APPDATA%\herdr\plugins\config\herdr-automatic-rename-win\last-run.log` 的相关几行；
- `herdr --version`、`node --version`、Windows 版本。
