# 09 - 依赖关系

本篇梳理 monorepo 内 11 个工作区包的依赖层次、各包的外部依赖、版本策略与供应链约束。数据来源于各包 `package.json`（版本 0.84.4 时点）。

[← 返回目录](Home.md) | 上一节：[08-辅助包](08-supporting-packages.md) | 下一节：[10-构建与运行](10-build-and-run.md)

---

## 1. 分层依赖图

npm workspaces 定义在根 [package.json](../package.json)：`packages/*`、`packages/session-backends/*` 及若干示例扩展目录。内部依赖按层次组织如下（箭头 = "依赖于"）：

```
第 4 层（应用）
    ┌───────────────────────┐      ┌────────────────────┐
    │  pi-coding-agent      │      │  pi-evals (私有)   │
    │  (CLI 应用，汇聚一切) │      │  (devDeps: ai,     │
    └──┬────────────────────┘      │   coding-agent)   │
       │                           └───────┬────────────┘
       │                                   │
第 3 层（组合/传输）                        │
    │  ┌────────────────┐  ┌────────────┐  │
    │  │ pi-server      │  │ pi-client  │  │
    │  │ (RPC 服务器)   │  │ (RPC 客户端)│ │
    │  └─┬──────┬───────┘  └──┬────┬────┘  │
    │    │      │             │    │       │
    │    │  ┌───┴─────────────┘    │       │
    │    │  │ pi-protocol (协议)   │       │
    │    │  └──────────────────────┘       │
    │    │                                 │
第 2 层（运行时）                          │
    │  ┌─────────────────────────────┐     │
    │  │ pi-agent-core (Agent 运行时) │◄────┘
    │  └──┬──────────┬───────────────┘
    │     │          │
    │     │  ┌──────────────────────────┐  ┌───────────────────────────────┐
    │     │  │ pi-session-backend-      │  │ sqlite-node 直接依赖 ai 与    │
    │     │  │ sqlite-node → agent-core │  │ agent-core（与会话层平行挂靠）│
    │     │  └──────────────────────────┘  └───────────────────────────────┘
    │     │
第 1 层（能力）                    │
    │  ┌─────────────────┐        │
    │  │ pi-ai (LLM API) │◄───────┤
    │  └─────────────────┘        │
    │                             │
第 0 层（基础，无内部依赖）         │
    ┌──────────┐ ┌────────────┐ ┌───────────┐
    │ chord    │ │ telemetry  │ │ pi-tui    │
    └──────────┘ └────────────┘ └───────────┘
```

要点：

- **三个零内部依赖的基座**：`chord`（应用组合运行时）、`pi-telemetry`（遥测契约）、`pi-tui`（终端 UI）。它们可以被任何上层安全引用。
- **两条纵向主线**：
  1. *Agent 主线*：`chord + pi-ai + pi-telemetry → pi-agent-core → pi-coding-agent`；
  2. *RPC 主线*：`chord → pi-protocol → pi-client / pi-server → pi-coding-agent`。
- `pi-coding-agent` 是唯一的**汇聚点**（同时依赖 6 个内部包），其余包保持窄接口。
- `pi-evals` 为私有包，仅以 devDependencies 引用 `pi-ai` 与 `pi-coding-agent`，不属于运行时依赖闭包。

## 2. 各包依赖明细

### 2.1 内部依赖矩阵

| 包 | 内部依赖（dependencies） |
|----|--------------------------|
| `chord` | — |
| `pi-telemetry` | — |
| `pi-tui` | — |
| `pi-ai` | `pi-telemetry` |
| `pi-agent-core` | `chord`、`pi-ai`、`pi-telemetry` |
| `pi-protocol` | `chord` |
| `pi-client` | `chord`、`pi-protocol` |
| `pi-server` | `chord`、`pi-agent-core`、`pi-protocol` |
| `pi-session-backend-sqlite-node` | `pi-ai`、`pi-agent-core` |
| `pi-coding-agent` | `chord`、`pi-agent-core`、`pi-ai`、`pi-client`、`pi-protocol`、`pi-tui` |
| `pi-evals`（私有） | （devDependencies）`pi-ai`、`pi-coding-agent` |

### 2.2 外部运行时依赖

| 包 | 外部依赖（全部精确固定版本） | 用途 |
|----|------------------------------|------|
| `chord` | `esbuild` | 插件/扩展打包 |
| `pi-tui` | `get-east-asian-width`、`marked` | 东亚字符宽度计算；Markdown 解析 |
| `pi-ai` | `@anthropic-ai/sdk`、`openai`、`@google/genai`、`@aws-sdk/client-bedrock-runtime`、`@smithy/node-http-handler` | 各 Provider 官方 SDK（Anthropic/OpenAI/Google/Bedrock） |
| | `http-proxy-agent`、`https-proxy-agent` | 代理支持 |
| | `partial-json` | 流式部分 JSON 解析 |
| | `typebox` | schema/类型校验 |
| `pi-agent-core` | `diff`、`ignore`、`typebox`、`yaml` | 文本 diff；gitignore 语义；schema；YAML（skills/prompt 模板） |
| `pi-protocol` | `typebox` | 协议 schema |
| `pi-client` / `pi-server` | —（仅 chord 内部依赖） | — |
| `pi-session-backend-sqlite-node` | —（用 Node 内置 `node:sqlite`） | — |
| `pi-coding-agent` | `chalk`、`cross-spawn`、`diff`、`grok-mermaid`、`highlight.js`、`hosted-git-info`、`ignore`、`jiti`、`minimatch`、`proper-lockfile`、`semver`、`typebox`、`undici`、`yaml` | 终端着色、跨平台 spawn、Mermaid 渲染、代码高亮、git URL 解析、TS 扩展实时加载、glob、文件锁、版本比较、HTTP、配置解析 |
| | `@silvia-odwyer/photon-node`（WASM 图像处理）、可选 `@mariozechner/clipboard` | 图片缩放 worker；原生剪贴板 |
| `pi-evals` | （dev）`vitest-evals`、`vitest` | 评估框架 |

值得注意的**刻意选择**：

- `pi-ai` 只对四家需要复杂签名/握手协议的 Provider 引入官方 SDK，其余 30+ Provider 一律直接走 HTTP（见 [02-pi-ai](02-package-ai.md)）。
- `pi-protocol` / `pi-client` / `pi-server` 无任何外部运行时依赖，CBOR 编解码为自研实现（见 [07-RPC 协议栈](07-rpc-stack.md)）。
- SQLite 后端零第三方依赖，绑定 Node 22+ 内置 `node:sqlite`。
- 根 devDependencies 提供 monorepo 工具链：`@biomejs/biome`（lint/format）、`@typescript/native-preview`（tsgo，原生 TS 编译器）、`typescript`、`esbuild`、`husky`（pre-commit）、`shx`、`tsx`（源码直跑）。

## 3. 循环依赖控制

仓库用脚本在 `npm run check` 中强制约束依赖结构：

| 检查 | 脚本 | 约束 |
|------|------|------|
| `check:pinned-deps` | [scripts/check-pinned-deps.mjs](../scripts/check-pinned-deps.mjs) | 直接外部依赖必须精确固定版本 |
| `check:ts-imports` | [scripts/check-ts-relative-imports.mjs](../scripts/check-ts-relative-imports.mjs) | TS 文件必须使用带扩展名的相对导入（ESM 规范） |
| `check:entry-graphs` | [scripts/check-entry-graphs.mjs](../scripts/check-entry-graphs.mjs) | 包入口导出图一致性 |
| `check:shrinkwrap` / `check:install-lock:coding-agent` | [scripts/generate-coding-agent-*.mjs](../scripts/) | 发布产物锁文件与 lockfile 同步 |
| `check:browser-smoke` | [scripts/check-browser-smoke.mjs](../scripts/check-browser-smoke.mjs) | 浏览器兼容冒烟（无 Node 专属 API 泄漏到中立包） |
| `tsgo --noEmit` | — | 全仓库类型检查 |

分层规则（由架构保证、由 review 维持）：第 0 层包之间互不引用；`pi-ai` 不得引用 agent/coding-agent；`pi-protocol` 不依赖 `pi-ai`/`pi-agent-core`（协议层对业务类型无感知，通过 chord 的 JSON/CBOR 序列化边界传输）。

## 4. 版本策略

- **锁步版本（lockstep）**：所有包共享同一版本号（0.84.x），每次发布一起更新。`patch` = 修复 + 新增，`minor` = 破坏性变更，不做 major。
- **内部依赖用范围版本**：`^0.84.4`，由 workspace 解析到本地源，发布后可解析到同批 npm 版本。
- **外部依赖精确固定**：配合根 `.npmrc` 的 `save-exact=true`，杜绝 `^` 引入不可预期的次要升级。
- **版本同步脚本**：`npm run version:patch/minor/major` 会遍历 workspace 改版本，再跑 [scripts/sync-versions.js](../scripts/sync-versions.js) 对齐内部依赖范围，最后 `npm install --package-lock-only --ignore-scripts` 刷新 lockfile。

## 5. 供应链约束

仓库把 npm 依赖变更视同已评审的代码变更（见根 [README](../README.md) 与 [AGENTS.md](../AGENTS.md)）：

1. **精确固定 + 发布龄**：直接外部依赖固定精确版本；`.npmrc` 设 `min-release-age=2`，避免 npm 解析时选中发布不足两天的版本。
2. **lockfile 为准**：`package-lock.json` 是依赖唯一事实来源。pre-commit 钩子默认拦截 lockfile 提交，需 `PI_ALLOW_LOCKFILE_CHANGE=1` 显式放行。
3. **禁用生命周期脚本**：本地 `npm install --ignore-scripts` / `npm ci --ignore-scripts`；CI 同样如此，并有定时任务跑 `npm audit --omit=dev` 与 `npm audit signatures --omit=dev`。
4. **发布锁文件**：`@earendil-works/pi-coding-agent` 发布时附带 `npm-shrinkwrap.json`（由根 lockfile 生成，脚本含生命周期脚本 allowlist——新增带 install 脚本的依赖会直接挂掉检查，直到人工评审加入 allowlist）。
5. **发布冒烟**：`npm run release:local` 在仓库外构建隔离的 npm/Bun 安装并冒烟，见 [10-构建与运行](10-build-and-run.md)。

## 6. 依赖视角的演进方向

- `pi-server` / `pi-client` / `pi-protocol` 标注为实验性（experimental server package），支撑 [coding-agent 的多进程架构](05-package-coding-agent.md)（Session worker 进程 + 呈现端进程）。
- SQLite 会话后端位于 `packages/session-backends/` 命名空间下，暗示未来可能出现更多可插拔后端（JSONL 默认实现仍在 `pi-agent-core` 内）。
- `chord` 的 `exports` 同时暴露 `source`（`./src/index.ts`）与 `dist` 路径，允许 monorepo 内源码直连（配合 `tsx` 直跑，无需先构建）。
