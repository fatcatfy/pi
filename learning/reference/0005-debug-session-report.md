# 断点调试会话完整总结报告

> 主题：在无 VS Code 的沙箱环境中，验证 PI「用户输入 → 模型调用 → 工具执行 → 输出」断点链路的数据
> 日期：2026-09-06 · 环境：远程沙箱（Linux，`CI=true`，无 TTY）
> 关联：[0003-debug-breakpoints.html](0003-debug-breakpoints.html)（速查）· [0004-breakpoint-trace-record.md](0004-breakpoint-trace-record.md)（逐断点完整数据）

---

## 1. 背景与目标

学习材料（`pi-doc.com/setup-and-debug` 第四步）建议在 VS Code 里用「Debug Pi Print Mode」配置打断点，逐点观察链路数据。目标是搞清一次输入如何一路变成 agent 输出，并在关键节点确认中间数据。

**约束**：当前是远程沙箱，没有 VS Code、没有图形调试器，但有真实模型 API（DeepSeek）、有 Node 和完整的仓库源码。必须另辟蹊径在纯命令行环境里做等价的断点 + 逐点取值验证。

---

## 2. 方法：为什么不直接跑 CLI？

如果简单跑 `npx tsx cli.ts -p "..."`，只能看到最终答案，看不到链路内部在每一跳上到底传了什么。要"打断点看数据"，需要一个能**暂停执行流、原地求值、再继续**的机制。

### 选用 CDP（Chrome DevTools Protocol）

Node 原生带 inspector：`node --inspect-brk` 会
- 在入口处暂停，等待调试器；
- 暴露一个 WebSocket 端点（`/json/list`）；
- 通过 `Debugger.*` / `Runtime.*` 命令控制脚本。

于是写了一个独立脚本 `learning/.tmp/pi-cdp-trace.mjs`：
1. `spawn("node", ["--import","tsx","--inspect-brk=127.0.0.1:9333", "cli.ts", "-p","Summarize this repo","--model","deepseek-v4-flash"], ...)`；
2. 连上 inspector WebSocket，监听 `Debugger.scriptParsed` 给目标文件打预定义断点；
3. 每次 `Debugger.paused` 用 `Debugger.evaluateOnCallFrame` 求值表达式，把 `HIT <断点名> => <值>` 逐行写入 JSONL；
4. 用 `Debugger.resume` 继续，直到进程结束，导出 `pi-cdp-trace.jsonl`。

这种方式等价于"手动 F9 命中每个断点、在 Watch 里看变量"，只是把点断点、取值、记录三件事自动化了。

---

## 3. 踩到的两个硬坑（重要，可复用）

### 坑一：esbuild 压缩产物只有 3~10 行，行断点无效

**现象**：断点全部命中，但作用域只有 `module/global`，所有变量 `ReferenceError: xxx is not defined`，暂停位置是"模块顶部"。

**根因**：tsx 基于 esbuild 转译，产物被压缩成极少数超长行（例如 `agent-loop.ts` 压成 3 行、`main.ts` 压成 5 行、`.ts` 源码里的 675 行对应压缩文件的第 3 行）。V8 的"行断点"按 `line` 定位，`line:3` 解析出来就是这一整行的开头（模块 bootstrap），而不是行内 `resetTimings();` 所在的那个字节位置。

**解法**：不要按行打断点，按**精确列**打断点。
- 从 `Debugger.getScriptSource` 提取内联 base64 sourcemap；
- 用 `@jridgewell/trace-mapping` 的 `generatedPositionFor(smap, { source, line, column, bias: LEAST_UPPER_BOUND })` 把「源码 行:列」映射到「压缩后代码 精确 line:column」；
- 用 `Debugger.setBreakpoint({ lineNumber: genLine-1, columnNumber: genColumn })` 打在该列。

打中后作用域恢复为 `local:<fn>`，变量可正常求值。

### 坑二：断点打在函数声明行，参数未绑定

**现象**：能取到数据了，但某些函数（如 `runAgentLoop`、`streamAssistantResponse`、`prompt`）的入参变量报"未定义"。

**根因**：函数声明行先于函数体执行，此时参数还没初始化（且 `appMode` 之类 `let` 变量处于 TDZ）。

**解法**：每个断点的锚点（needle）一律取**函数体内第一条可执行语句**、且该语句要在源码里唯一。例如：
- `main.ts` → `resetTimings();`
- `createAgentSessionServices` → `const cwd = resolvePath(options.cwd);`
- `prompt()` → `const expandPromptTemplates = options?.expandPromptTemplates ?? true;`
- `streamAssistantResponse` → `let messages = context.messages;`

这样命中的瞬间，函数参数已经在作用域内。

---

## 4. 断点链路（11 个点）与实测数据

命令：`pi -p "Summarize this repo" --model deepseek-v4-flash`，`DEEPSEEK_API_KEY` 注入。

| 断点 | 源码位置 | 作用域 | 实测数据（节选） |
|---|---|---|---|
| BP1 | `cli.ts:27` | module | `["-p","Summarize this repo","--model","deepseek-v4-flash"]` |
| BP2 | `main.ts:676` | `local:main` | `{"argCount":4,"parsed":[前 4 项 argv]}` |
| BP3 | `main.ts:753` | `local:main` | `{"appMode":"print"}` |
| BP4 | `services.ts:138` | `local:createAgentSessionServices` | 服务惰性创建，`models:false, settings:false` |
| BP5 | `runtime.ts:431` | `local:createAgentSessionRuntime` | `{"cwd":"/workspace","hasCreateRuntime":true}` |
| BP6 | `agent-session.ts:1160` | `local:prompt` | `{"text":"Summarize this repo","hasOptions":true}` |
| BP7 | `agent-session.ts:1108` | `local:_runAgentPrompt` | 1 条 user 消息，`contentTypes:["text"]` |
| BP8 | `agent-loop.ts:104` | `local:runAgentLoop` | `{"promptCount":1,"msgCountPre":0,"toolCount":4}` |
| BP9 | `agent-loop.ts:287` | `local:streamAssistantResponse` | 4 轮：`msgCount` 1 → 4 → 7 → 10 |
| BP10 | `agent-loop.ts:306` | `local:streamAssistantResponse` | 4 轮：`llmMsgCount` 逐轮递增，`systemPromptLen:14822` |
| BP11 | `agent-loop.ts:416` | `local:executeToolCalls` | 4 轮：[bash,read] → [read,bash] → [bash,read] → [bash,bash] |

**链路全景（本次真实运行）**：

```
cli.ts 原始 argv (BP1)
  → main() 解析 (BP2) → 模式判定 print (BP3)
  → 服务组装 (BP4) → Runtime (BP5)
  → prompt() (BP6) → agent.prompt(messages) (BP7)
  → runAgentLoop (BP8)
     ├ 轮1: model call (BP9/10) → executeToolCalls (BP11) [bash, read]
     ├ 轮2: ... [read, bash]
     ├ 轮3: ... [bash, read]
     └ 轮4: ... [bash, bash]
  → 输出答案 → 退出 (code=0)
```

关键数字：**4 轮模型调用、8 次工具调用**。每轮模型往返后上下文累加 +3（1 assistant + 2 toolResult），最终 `llmContext` 消息数到 13。这直接印证了前置课程 02（async/await 与 Agent Loop 的多轮机制）和 04（tool calling / context window）讲的内容。

---

## 5. 结果与结论

1. **链路完全打通并带真实模型验证**：从 `process.argv` 到最终答案，11 个断点全部命中、数据完整、作用域正确。
2. **解决了沙箱无调试器的问题**：CDP + 精确列断点，实现"纯命令行等价断点调试"，产物可自动化、可回放（JSONL 保留每次命中结果）。
3. **认证走环境变量路径**：DeepSeek key 通过 `DEEPSEEK_API_KEY` 注入（`packages/ai/src/providers/deepseek.ts:11`），即文档中"环境变量凭据"分支。
4. **模型真实干活**：为回答"Summarize this repo"，agent 主动执行 8 次 bash/read 工具调用再汇总，完整展现了"思考 → 工具 → 再思考"的循环。

---

## 6. 产出物清单

| 文件 | 说明 |
|---|---|
| `learning/.tmp/pi-cdp-trace.mjs` | CDP 断点追踪脚本（可复跑） |
| `learning/.tmp/pi-cdp-trace.jsonl` | 逐断点命中数据（原始记录） |
| `learning/reference/0004-breakpoint-trace-record.md` | 每个断点的完整输出整理 |
| `learning/reference/0003-debug-breakpoints.html` | 断点观察表（新增第 6 节速查 + 指向完整记录的链接） |

---

## 7. 可复用经验

- **在无 GUI/图形调试器的环境里调试 Node 链路**：启动 `node --inspect-brk`，用 CDP 的 `setBreakpoint(精确 line:column)` + `evaluateOnCallFrame` + `resume` 即可复现 VS Code 的断点体验，且天然可自动化。
- **tsx/esbuild 产物压缩时**：别用行断点，必须配合内联 sourcemap 求精确列；断点锚点选"函数体内首条唯一语句"。
- **断点脚本敢用真实模型调用**：整条链路带真实 API 跑一次，比任何纸质流程图都能证明"数据真在那儿流动"。

---

*下一步候选（对齐前一课候选）：深入 `0003` 工具调用——在 `executeToolCallsParallel`（`agent-loop.ts`）里断点看 read/write/bash 各自的执行与 `before/afterToolCall` 钩子。*