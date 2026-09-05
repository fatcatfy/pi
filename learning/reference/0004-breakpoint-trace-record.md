# 断点链路实测记录（CDP）

> 一次真实运行：`pi -p "Summarize this repo" --model deepseek-v4-flash`
> 认证：`DEEPSEEK_API_KEY` 环境变量注入（DeepSeek）
> 方法：`node --import tsx --inspect-brk cli.ts`，CDP 直连，逐点恢复执行并按需求值
> 原始数据：`learning/.tmp/pi-cdp-trace.jsonl`（本文件为整理后的完整呈现）

---

## 0. 环境与工具

- 沙箱无 VS Code，改用 Chrome DevTools Protocol（CDP）连接 Node inspector。
- 断点脚本：`learning/.tmp/pi-cdp-trace.mjs`
- 关键坑：esbuild 会把编译产物压缩成 **3~10 个超长行**，V8 的「行断点」会整体落到模块顶部（作用域只有 `module/global`，所有变量 ReferenceError）。
  - **解法**：从 `Debugger.getScriptSource` 提取内联 base64 sourcemap，用 `generatedPositionFor(..., LEAST_UPPER_BOUND)` 把「源码 行:列」映射成「压缩后代码 精确 line:column」，再在该列打断点。
  - 断点必须打在**函数体内首条语句**：打在函数声明行时参数尚未绑定，同样 ReferenceError。

---

## 1. 断点绑定映射（源码 → 生成代码列）

| 断点 | 源码位置 | sourcemap 生成位置 | V8 实际解析位置 |
|---|---|---|---|
| BP1 | `cli.ts:27:1` | gen `2:877` | `2:877` |
| BP2 | `main.ts:676:1` | gen `3:11136` | `3:11136` |
| BP3 | `main.ts:753:1` | gen `3:12958` | `3:12985` |
| BP4 | `agent-session-services.ts:138:1` | gen `1:1468` | `1:1478` |
| BP5 | `agent-session-runtime.ts:431:1` | gen `1:8741` | `1:8741` |
| BP6 | `agent-session.ts:1160:2` | gen `1:18083` | `1:18111` |
| BP7 | `agent-session.ts:1108:9` | gen `1:17357` | `1:17362` |
| BP8 | `agent-loop.ts:104:1` | gen `1:1075` | `1:1093` |
| BP9 | `agent-loop.ts:287:1` | gen `1:4749` | `1:4770` |
| BP10 | `agent-loop.ts:306:24` | gen `1:5140` | `1:5140` |
| BP11 | `agent-loop.ts:416:1` | gen `1:7411` | `1:7444` |

> V8 实际解析列在少数情况下比 sourcemap 目标列略靠后（向前就近），但都落在目标语句上，命中时作用域正确（`local:<fn>`）。

---

## 2. 各断点完整输出

### BP1 · CLI 入口 — `cli.ts:27` `main(process.argv.slice(2))`

作用域：`[module:, global:]`（模块顶层）

```json
["-p","Summarize this repo","--model","deepseek-v4-flash"]
```

原始 `process.argv` 去掉前两项后原样透传进 `main(args)`。

---

### BP2 · 主流程开始 — `main.ts:676` `resetTimings();`

函数作用域：`local:main` —— 参数已绑定。

```json
{"parsed":["-p","Summarize this repo","--model","deepseek-v4-flash"],"argCount":4}
```

`args` 已解析为合法参数数组，共 4 项。

---

### BP3 · 模式判定 — `main.ts:753`

```json
{"appMode":"print"}
```

非 TTY（stdin 非交互）+ `-p` → `resolveAppMode` 判定为 **print 模式**（`appMode === "print"`，故 `shouldTakeOverStdout = true`）。

---

### BP4 · 服务组装 — `agent-session-services.ts:138`

```json
{
  "fn": "createAgentSessionServices",
  "hasOpts": true,
  "models": false,
  "settings": false
}
```

`options` 对象已传入，但 `modelsProvider` / `settingsProvider` 此刻尚未实例化——服务按需（惰性）创建。

---

### BP5 · Runtime 创建 — `agent-session-runtime.ts:431`

```json
{"fn":"createAgentSessionRuntime","hasCreateRuntime":true,"cwd":"/workspace"}
```

Runtime 已绑定工作目录 `/workspace` 与传入的 `createRuntime` 工厂。

---

### BP6 · 消息发送 — `agent-session.ts:1160` `prompt()`

函数作用域：`local:prompt`。

```json
{"method":"prompt","text":"Summarize this repo","hasOptions":true}
```

用户输入原样进入 prompt 预处理阶段（skill 展开、扩展钩子在此之后）。

---

### BP7 · 进入 Agent — `agent-session.ts:1108` `this.agent.prompt(messages)`

函数作用域：`local:_runAgentPrompt`。

```json
[
  {
    "role": "user",
    "contentTypes": ["text"],
    "ts": 1788629691692
  }
]
```

`messages` 已构造为 `AgentMessage[]`：1 条 user 消息、单 text 内容。跨入 pi-agent-core。

---

### BP8 · Agent 核心循环入口 — `agent-loop.ts:104` `runAgentLoop`

```json
{"fn":"runAgentLoop","promptCount":1,"msgCountPre":0,"toolCount":4}
```

首次进入：1 条 prompt、无历史上下文、已注入 **4 个内置工具**。

---

### BP9 · LLM 调用边界（每轮）— `agent-loop.ts:287` `streamAssistantResponse`

共命中 **4 轮**，`context.messages` 数量递增：

```json
{"fn":"streamAssistantResponse","msgCount":1,"hasTools":true}   // 第 1 轮
{"fn":"streamAssistantResponse","msgCount":4,"hasTools":true}   // 第 2 轮
{"fn":"streamAssistantResponse","msgCount":7,"hasTools":true}   // 第 3 轮
{"fn":"streamAssistantResponse","msgCount":10,"hasTools":true}  // 第 4 轮
```

> 每轮模型往返后，messages 累加 +3：1 条 assistant 输出 + 2 条 toolResult。

---

### BP10 · LLM 上下文就绪（每轮）— `agent-loop.ts:306` `streamFunction(config.model, llmContext, …)`

```json
{"model":"deepseek-v4-flash","llmMsgCount":1,"toolCount":4,"systemPromptLen":14822}
{"model":"deepseek-v4-flash","llmMsgCount":4,"toolCount":4,"systemPromptLen":14822}
{"model":"deepseek-v4-flash","llmMsgCount":7,"toolCount":4,"systemPromptLen":14822}
{"model":"deepseek-v4-flash","llmMsgCount":10,"toolCount":4,"systemPromptLen":14822}
```

真正发送给模型的 `llmContext`：模型 `deepseek-v4-flash`、4 个工具、系统提示 14822 字符，每轮消息数随上下文累积递增到 13。

---

### BP11 · 工具执行（每轮）— `agent-loop.ts:416` `executeToolCalls`

共命中 4 轮，每次 2 个工具调用：

```json
{"fn":"executeToolCalls","toolCallCount":2,"toolNames":["bash","read"]}   // 第 1 轮
{"fn":"executeToolCalls","toolCallCount":2,"toolNames":["read","bash"]}   // 第 2 轮
{"fn":"executeToolCalls","toolCallCount":2,"toolNames":["bash","read"]}   // 第 3 轮
{"fn":"executeToolCalls","toolCallCount":2,"toolNames":["bash","bash"]}   // 第 4 轮
```

模型用 `bash` 调研仓库结构、`read` 读取文件内容，共 **8 次工具调用**，最终完成仓库总结。

---

## 3. 完整链路结论

```
cli.ts 原始 argv (BP1)
  → main() 解析参数 (BP2)
  → 模式判定 print (BP3)
  → 服务组装 (BP4)
  → Runtime 创建 (BP5)
  → session.prompt() (BP6)
  → agent.prompt(messages) (BP7)
  → runAgentLoop 入口 (BP8)
  ├─ 本轮 ①: streamAssistantResponse (BP9/BP10) → executeToolCalls (BP11) [bash, read]
  ├─ 本轮 ②: ... [read, bash]
  ├─ 本轮 ③: ... [bash, read]
  └─ 本轮 ④: ... [bash, bash]
  → 决策完成 → 输出最终答案 → 进程退出 (code=0)
```

- 模型调用 **4 轮**
- 工具调用 **8 次**（bash/read 交替）
- 认证走环境变量凭据路径（文档断点 #13 对应的「环境变量」分支）：`DEEPSEEK_API_KEY`（见 `packages/ai/src/providers/deepseek.ts:11`）
- `pi` 正常退出（`code=0`），调试器由脚本监测到 finished 标记后断开