# 10 - 构建与运行

本篇说明环境要求、安装构建、从源码运行、测试、评估、独立二进制构建与发布流程，以及最终用户使用 `pi` CLI 的四种运行模式。

[← 返回目录](Home.md) | 上一节：[09-依赖关系](09-dependencies.md)

---

## 1. 环境要求

- **Node.js ≥ 22.19.0**（所有包 `engines` 字段强制；SQLite 后端与部分工具依赖 Node 22+ 内置模块）
- npm（随 Node 附带）；构建 Bun 二进制另需 [Bun](https://bun.sh)
- 操作系统：Linux / macOS / Windows（含 Termux/Android、tmux 等场景，见 `packages/coding-agent/docs/` 下各平台文档）

## 2. 开发环境搭建

```bash
git clone https://github.com/earendil-works/pi-mono
cd pi-mono
npm install --ignore-scripts   # 安装依赖，不执行生命周期脚本（供应链约定）
npm run build                  # 刷新模型数据后构建所有包
```

根 [package.json](../package.json) 的 `build` 脚本按依赖顺序逐包构建：

```
chord → tui → telemetry → ai → agent → session-backends/sqlite-node
      → protocol → client → server → coding-agent
```

常用变体：

| 命令 | 说明 |
|------|------|
| `npm run build:offline` | 不联网刷新模型数据，用现有快照重建（`pi-ai` 内部为 `check:model-data` + `tsgo`） |
| `npm run check` | Biome lint/format + 依赖固定检查 + TS 导入检查 + 入口图检查 + shrinkwrap 校验 + 全仓类型检查 + 浏览器冒烟 |
| `npm run clean` | 清理所有包 `dist/` |
| `npm run generate:models` | 重新生成 `models.generated.ts` / 图片模型数据（禁止手改生成文件） |

> `npm run check` 在每次代码变更后必须通过（含 warning/info）；这是提交前的硬门槛。

## 3. 从源码运行

```bash
./pi-test.sh              # 任意目录可执行，pi 保留调用者 cwd
./pi-test.sh --no-env     # 额外清除所有 provider API key 环境变量
```

`pi-test.sh` 内部用 `tsx` 直接运行 `packages/coding-agent/src/cli.ts`，无需预构建（chord 等包 exports 暴露了 `source` 路径支持源码直连）。

认证：`export ANTHROPIC_API_KEY=sk-ant-...` 等环境变量，或启动后在交互模式执行 `/login` 选择订阅（Claude Pro/Max、ChatGPT Plus/Pro、GitHub Copilot）或 API key 登录。

## 4. 测试

| 命令 | 用途 |
|------|------|
| `./test.sh` | **推荐入口**。在隔离 HOME/临时目录、无 API key 的环境下跑全部非 LLM 测试 |
| `npm test` | 全部测试（含 e2e；当 endpoint/auth 环境变量存在时会激活 e2e） |
| `npm run test:scripts` | 根 `scripts/*.test.mjs`（node:test） |
| 指定测试（vitest 包） | `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`（包目录下执行） |
| 指定测试（tui 包） | `node --test test/specific.test.ts`（node:test） |

`./test.sh` 的隔离措施（见 [test.sh](../test.sh)）：全新 `$HOME`、`XDG_*` 指向临时目录、清空的 git/npm 配置、`PI_NO_LOCAL_LLM=1`，测试结束只删除带属主标记的临时目录。

**TUI 交互测试**（tmux 驱动，见 [AGENTS.md](../AGENTS.md)）：

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p      # 捕获启动画面
tmux send-keys -t pi-test "your prompt" Enter
tmux kill-session -t pi-test
```

`packages/coding-agent/test/` 下的测试全部基于 faux provider 与本地 harness（`test-harness.ts`），**不使用真实 provider API、key 或付费 token**。

## 5. 行为化评估（Evals）

```bash
npm run eval -- --provider openai --model gpt-5.6-sol
PI_PROVIDER=anthropic PI_MODEL=claude-opus-4-6 npm run eval
```

需要真实模型与凭据，产物落在被 git 忽略的 `.eval/` 目录（含会话 JSONL，可能含 prompt 与源码）。详见 [08-辅助包 §3](08-supporting-packages.md#3-earendil-workspi-evalspackagesevals)。

## 6. 独立二进制构建

```bash
# coding-agent 包内：构建 Bun 编译单文件可执行（含全部上游依赖重建）
npm --prefix packages/coding-agent run build:binary

# 从 GitHub release 源码包构建官方二进制
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"

# 本地发布演练：在仓库外构建隔离 npm/Bun 安装并冒烟
npm run release:local -- --out /tmp/pi-local-release --force
```

Bun 二进制约束：`bun build --compile` 打包 `src/bun/cli.ts` + `src/utils/image-resize-worker.ts`，随包分发 theme JSON、export-html 模板、photon WASM 等资产（`copy-binary-assets` 脚本）。

## 7. 发布流程（维护者）

锁步版本：所有包一个版本，`patch` = 修复+新增，`minor` = 破坏性变更，无 major。

1. 确认 `main` 最新提交已跑过 `/cl` prompt 审计并更新各包 `CHANGELOG.md` 的 `[Unreleased]` 段；
2. 本地冒烟（`npm run release:local`，Node/Bun 双通道：`--help`、`--version`、`--list-models`、`-p` 提示词、tmux 交互模式）；
3. 执行发布脚本（需放行 lockfile 变更并临时解除 npm 发布龄限制）：

```bash
PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch   # 或 release:minor
```

脚本会：升版本 → 更新 changelog → 重建产物 → `npm run check` → 提交 `Release vX.Y.Z` → 打 tag → 补下轮 `[Unreleased]` 段 → 推送 `main` 与 tag。**tag 推送后不要重跑同版本发布脚本**。

4. CI（`.github/workflows/build-binaries.yml`）完成 npm trusted publishing（OIDC，无本地 `npm publish`/OTP），验证全部包可解析到精确版本后把 release 标记写入 R2；`pi.dev/api/latest-version` 只认这个标记。

## 8. 终端用户使用 `pi`

安装（二选一）：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
curl -fsSL https://pi.dev/install.sh | sh
```

`pi` 提供四种运行模式：

| 模式 | 命令形态 | 说明 |
|------|----------|------|
| 交互模式 | `pi` | 全屏 TUI：编辑器、消息流、`/命令`（`/model` Ctrl+L、`/login`、`/sessions`、`/export` 等）、消息队列 |
| Print / JSON | `pi -p "prompt"`、`pi --json` | 非交互单轮输出 / JSON 流（进程集成） |
| RPC | `pi --rpc` | 挂载 [RPC 协议栈](07-rpc-stack.md)，作为 Session worker 供外部呈现端驱动 |
| SDK | `createAgentSession()` | 嵌入自有应用，见 [05-pi-coding-agent §SDK](05-package-coding-agent.md) |

默认给模型四个工具：`read` / `write` / `edit` / `bash`。能力扩展通过 Extensions（TypeScript）、Skills、Prompt Templates、Themes 与 Pi Packages（npm/git 分发）完成，配置位于 `~/.pi/agent/`（`settings.json`、`models.json`、`extensions/`、`skills/` 等）。

容器化：Pi 无内置权限系统，默认继承启动用户的全部权限；需要强隔离时用 Gondolin 微 VM 扩展、Docker 或 OpenShell（见 `packages/coding-agent/docs/containerization.md`）。

## 9. 常用开发命令速查

```bash
npm install --ignore-scripts     # 安装
npm run build                    # 全量构建（含模型数据刷新）
npm run build:offline            # 离线重建
npm run check                    # lint + format + 类型 + 一致性检查（提交门槛）
./test.sh                        # 隔离环境跑非 LLM 测试
./pi-test.sh                     # 源码直跑 pi
npm run eval -- --provider X --model Y   # 行为评估
npm run profile:tui / profile:rpc        # 性能剖析
npm run release:local            # 本地发布演练
```

调试：交互模式隐藏命令 `/debug` 会把渲染后的 TUI 行（含 ANSI）与最近发给 LLM 的消息写入 `~/.pi/agent/pi-debug.log`。
