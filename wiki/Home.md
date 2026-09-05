# Pi Monorepo Code Wiki

本 Wiki 是对 [pi-mono 仓库](https://github.com/earendil-works/pi-mono) 的结构化代码文档，覆盖项目整体架构、各模块职责、关键类与函数、依赖关系以及运行方式。

> 生成时间：2026-09-04，基于仓库当时版本（各包版本 0.84.x）。

## 项目简介

Pi 是一个**自可扩展（self-extensible）的 AI 编码代理（coding agent）项目**，核心产品是交互式终端编码代理 CLI `pi`。整个系统构建在一组分层清晰的 npm workspace 包之上：底层是统一的多 Provider LLM API 与终端 UI 库，中层是通用 Agent 运行时与 Harness（会话/分支/压缩），上层是面向用户的编码代理 CLI，并通过独立的协议栈支持多进程/多呈现端（TUI、WebUI、RPC 客户端）架构。

## 文档目录

| 文档 | 内容 |
|------|------|
| [01-整体架构](01-architecture-overview.md) | 分层架构图、数据流、运行模式、目录结构 |
| [02-pi-ai 包](02-package-ai.md) | 统一多 Provider LLM API：消息类型、Provider、API 适配层、认证 |
| [03-pi-agent-core 包](03-package-agent.md) | Agent 运行时：Agent Loop、Agent 类、AgentHarness、Session 存储 |
| [04-pi-tui 包](04-package-tui.md) | 终端 UI 库：组件模型、差分渲染、布局、编辑器 |
| [05-pi-coding-agent 包](05-package-coding-agent.md) | 编码代理 CLI：启动流程、核心模块、工具、扩展系统、运行模式 |
| [06-chord 包](06-package-chord.md) | 应用组合运行时：facets、services、复制状态、插件加载 |
| [07-RPC 协议栈](07-rpc-stack.md) | pi-protocol / pi-client / pi-server：消息格式、CBOR、连接管理 |
| [08-辅助包](08-supporting-packages.md) | pi-telemetry、sqlite 会话后端、pi-evals |
| [09-依赖关系](09-dependencies.md) | 包间依赖图、版本策略、供应链约束 |
| [10-构建与运行](10-build-and-run.md) | 环境要求、安装、构建、测试、发布流程 |

## 包清单速览

| 包名 | 目录 | 职责 |
|------|------|------|
| `@earendil-works/pi-ai` | `packages/ai` | 统一多 Provider LLM API（OpenAI、Anthropic、Google、Bedrock 等 30+ Provider） |
| `@earendil-works/pi-agent-core` | `packages/agent` | Agent 运行时：工具调用、状态管理、事件流、会话/分支/压缩 |
| `@earendil-works/pi-tui` | `packages/tui` | 差分渲染终端 UI 库 |
| `@earendil-works/pi-coding-agent` | `packages/coding-agent` | 交互式编码代理 CLI（`pi` 命令） |
| `@earendil-works/chord` | `packages/chord` | 独立的应用组合运行时（services、复制状态、RPC、插件） |
| `@earendil-works/pi-protocol` | `packages/protocol` | RPC 协议：信封格式、CBOR 编码、字节流分帧 |
| `@earendil-works/pi-client` | `packages/client` | 传输无关的 RPC 客户端 |
| `@earendil-works/pi-server` | `packages/server` | 本地 RPC 服务器（Session 路由与多呈现端挂载） |
| `@earendil-works/pi-telemetry` | `packages/telemetry` | 厂商中立遥测契约与类型化 schema 工具 |
| `@earendil-works/pi-session-backend-sqlite-node` | `packages/session-backends/sqlite-node` | Node `node:sqlite` 会话存储后端 |
| `@earendil-works/pi-evals` | `packages/evals` | 基于 vitest-evals 的行为化评估框架 |

## 快速上手（开发者）

```bash
npm install --ignore-scripts   # 安装依赖（不执行生命周期脚本）
npm run build                  # 刷新模型数据并构建所有包
npm run check                  # Lint、格式化与类型检查
./test.sh                      # 运行测试（无 API key 时跳过 LLM 相关测试）
./pi-test.sh                   # 从源码运行 pi（可在任意目录执行）
```

详见 [10-构建与运行](10-build-and-run.md)。
