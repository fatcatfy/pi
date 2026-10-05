# 第7章：事件驱动 —— Agent 的神经系统（修订版 v2）

> **修订说明**：本文件是《第7章-事件驱动-Agent的神经系统.md》的勘误修订版，原文件未改动。对照 1.0.3 源码与 `packages/coding-agent/CHANGELOG.md` 核对后，修正了以下问题：
>
> **A 类：版本归属整体错位（会误导读者形成错误心智模型，必须改）**
> 1. **原文把多个能力都写成"0.99 新增"，实际分属 0.86.0 / 0.87.0 / 0.99.0。** 概览：`turn_end` / `agent_before_settle` 动作化边界、`context_with_system` 事件、`finishTurn` 取代 `shouldStopAfterTurn`、`ExtensionRunner.emit()` 不再接受 `turn_end`——这些全部是 **0.87.0** 的破坏性变更（见 `packages/coding-agent/CHANGELOG.md` 的 0.87.0 Breaking Changes，以及 `packages/agent/CHANGELOG.md` 的 0.87.0）。
> 2. **`cache_warming_decision` 是 0.86.0，不是 0.99**（0.86.0 Added，随 cost-aware prompt-cache warming 一起引入）。
> 3. **`pi.on` 返回注销函数、派发使用快照是 0.86.0，不是 0.99**（0.86.0 Added：`Added an unsubscribe function from pi.on() ... Handlers added or removed during a dispatch apply to later dispatches, not the current one`）。
> 4. **`message_end` 可返回替换消息是 0.71.0，不是 0.99**（0.71.0：`message_end` extension result support，issue #3982）。
> 5. **`user_bash` 本身早于 0.99**；0.86.0 起改为 **fail-closed**（handler 抛错或返回非法对象会中止命令，不再回退本地执行）。
> 6. **`provider_stream_event` 与 `ctx.executeTool()` 的 `parentToolCallId` 才是 0.99.0 的新增**——原文这两处的版本归属正确，保留。
>
> **B 类：示例/正文中的事实性错误**
> 7. **`session.subscribe` 的 listener 没有 `signal` 参数**。`AgentSessionEventListener = (event: AgentSessionEvent) => void`，`AgentSession._emit` 只用 `l(event)` 调用。原文 §3.1 示例写成 `(event, signal)` 是错的，第二个参数恒为 `undefined`。（内核层 `Agent.subscribe` 才额外传 `signal`，别与它混为一谈。）
> 8. **`ExtensionContext` 上 `hasUI` / `scopedModels` / `isProjectTrusted` / `shutdown` 都不是 0.99 新增**，原文的"★ 0.99 新增"标记已删除。其中 `ctx.scopedModels` 见 0.83.0，`ctx.isProjectTrusted()` 见 0.79.1。
>
> **C 类：其他**
> 9. 源码索引版本由"对齐 Pi 0.99.1"更新为"对齐 Pi 1.0.3"。`ExtensionEvent`（32 个成员）、`ExtensionAPI.on`（41 个重载）、内核 `AgentEvent`（10 种）经复核未变，保留。
>
> 本文引用一律「符号名 + 文件路径」，不写行号。

前六章里，有一个东西反复出现但我们始终没深入——**事件**。

第 3 章说"Agent Loop 每做一步都发事件让 UI 实时更新"。第 5 章说"工具执行时发出 `tool_execution_start`、`tool_execution_update`、`tool_execution_end` 事件"。第 6 章里事件到处携带 `AgentMessage`。

但我们始终没回答：事件到底是怎么从 Agent 内部传到外部的？谁在监听？为什么 Agent 发完事件后对一类监听器"等"，对另一类"不等"？

这一章就打开 Agent 的"神经系统"。

> **本章最重要的一句话：Pi 有两套并行的监听机制——`session.subscribe`（只读观察，Agent 不等你）和扩展系统的 `pi.on`（能拦截、能改写，Agent 会等你）。** 它们共享同一批事件源，但"Agent 等不等你的 listener"是两者最根本的分水岭。如果你只学一套，一定会踩"代码写了却静默不生效"的坑。

> 本章起为进阶章节。前六章建立了对 Pi-Agent 运行机制的整体理解，从这里开始深入工程化议题。

---

## 一、为什么需要事件系统？

### 一个直觉：从外卖追踪说起

你在美团上点了一份外卖。下单后，App 会给你推送一连串状态更新："商家已接单" → "骑手已取餐" → "骑手距你 500 米" → "已送达"。每一个状态更新就是一个**事件**——它告诉你"发生了一件事"。你不需要一直盯着骑手的位置看，只需要在收到事件时看一眼。

Pi-Agent 的事件就是这个意思：Agent 运行过程中不断产生"发生了某事"的快照——消息开始了、消息更新了、工具开始执行了——然后把这些快照推给所有关心它的人。

### 不用事件会怎样？

假设你要给 Agent 加一个"工具调用日志"功能：每次调工具时打印一行 `[LOG] 调用了 read，参数：main.ts`。

**不用事件系统**：你得改 Agent 源码，在 `tool.execute()` 前后各加一行 `console.log`。然后 Pi 更新了，你 merge 上游代码时发现冲突——你加的日志和上游新增的逻辑撞在一起了。手动解决冲突，下周又更新，又冲突……

**用事件系统**：

```typescript
session.subscribe((event) => {
    if (event.type === "tool_execution_end") {
        console.log(`[LOG] 调用了 ${event.toolName}，结果：${event.isError ? "失败" : "成功"}`);
    }
});
```

六行代码。不碰 Agent 一行源码。Agent 更新你只需要 `npm update`，日志逻辑不受影响。

这就是事件驱动最核心的价值：**把"发生了什么"和"谁关心什么"彻底分离。** Agent 只管发事件，它不知道也不关心谁在听。

### 发布-订阅 vs 直接调用

用编程术语说，事件驱动实现的是**发布-订阅模式**。和直接函数调用做个对比：

```
直接调用（打电话）：
  Agent ──调用──→ 终端渲染
       ──调用──→ 文件存储
       ──调用──→ 日志记录
  Agent 需要知道所有消费者的存在，每加一个新功能就要改 Agent

发布-订阅（广播）：
  Agent ──emit事件──→ 📡 事件总线
                          ├──→ 终端渲染（订阅了）
                          ├──→ 文件存储（订阅了）
                          ├──→ 日志记录（订阅了）
                          └──→ （新功能只需订阅，Agent 不需要知道）
```

一句话：**直接调用是"我亲自找你"；发布-订阅是"我对着空气喊了一声，谁听到算谁的"。** Pi 的事件系统就是发布-订阅——Agent 发出事件，关心它的人各自订阅、各自处理。但 Pi 有一个关键特点：**它有两条订阅管道**，而且两条的能力很不一样。这正是本章要讲的核心，下一节就铺开。

---

## 二、两条管道的全貌：从事件源到两类监听器

这一节把 Pi 事件体系的全景铺开——**2.1 看事件源，2.2 认识两条管道并讲清它们的核心差别**。后面第三、四节会分别深入两条管道的用法和源码。

### 2.1 事件源：10 种 AgentEvent

Agent 内核层定义了 10 种 `AgentEvent`（`packages/agent/src/types.ts`），它们构成了 Agent 运行的完整"脉搏"：

![10 种事件 4 层嵌套](assets/260702-ch07-event-nesting.svg)

**配图说明**：从外到内 4 层嵌套——Agent（Trace）→ Turn → Message → Tool Execution。每层都是"开始 → 更新（×N）→ 结束"配对。注意 Turn 2 没有 ToolCall 所以没有 Layer 4 嵌套。底部图例标注每层的事件数（2+2+3+3=10 种）。

```typescript
export type AgentEvent =
  // 第1层：Agent 生命周期（整个运行）
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }

  // 第2层：Turn 生命周期（一轮模型调用 + 工具执行）
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }

  // 第3层：Message 生命周期（一条消息）
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }

  // 第4层：Tool Execution 生命周期（一次工具执行）
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

10 种看着不少，但规律很清楚——它们是 **4 层嵌套的生命周期**，每层都有"开始→更新→结束"的配对：

```
Agent 运行
├── agent_start ───────────────────── Agent 开始
│
├── Turn 1（第3章讲过：一次模型调用 + 它触发的工具执行）
│   ├── turn_start ────────────────── Turn 开始
│   │
│   ├── Message（LLM 的响应）
│   │   ├── message_start
│   │   ├── message_update ×N ────── 流式增量（逐 token 更新）
│   │   └── message_end
│   │
│   ├── Tool Execution（工具执行）
│   │   ├── tool_execution_start
│   │   ├── tool_execution_update ×N  工具进度（如 Bash 的输出）
│   │   └── tool_execution_end
│   │
│   └── turn_end ──────────────────── Turn 结束
│
├── Turn 2 ...
│
└── agent_end ──────────────────────── Agent 结束
```

回忆第 3 章的概念：**一个 Turn = 一次模型调用 + 这次调用触发的所有工具执行。** turn_start 到 turn_end 之间，模型被调用了恰好一次。

> **这 10 种是事件源，是两条管道的共同水源。** 两类监听器都消费这同一批事件——管道 A 直接收，管道 B 收翻译版。所以这 10 种不属于任何一条管道，是它们共享的源头。两条管道具体是什么、差别在哪，下一节展开。

### 2.2 两条管道：subscribe 与扩展 pi.on

Pi 的事件有两条订阅管道，它们喂的是同一个事件源，但能力差很多。这一节先把两条管道介绍清楚，再讲它们的核心差别。后面第三、四节会分别深入。

**管道 A：`session.subscribe`**

你在**外部脚本**里注册监听器（Web 服务器、CLI 工具）。拿到 `session` 对象后调 `session.subscribe(listener)`，事件就会流进你的 listener。

它的特点是**只能看，不能改**——listener 没有返回值（或者说返回了也被丢弃），Agent 不会因为你的监听器改变任何行为。典型用途：流式渲染、打日志、把事件转发给浏览器。

**管道 B：扩展系统的 `pi.on`**

你把代码写进一个**扩展**（一段被框架加载的插件），在里面调 `pi.on("事件名", handler)`。handler 带返回值，Agent 会读。

它的特点是**能改** Agent 的行为——handler 可以返回 `{ block: true }` 拦掉一次工具调用，可以返回新的消息列表改写给 LLM 的上下文。典型用途：安全策略、审计、注入动态信息。

**核心差别：Agent 对 B 等，对 A 不等**

两条管道最关键的差别不在返回值，而在 Agent 等不等你：

- 管道 B 的 handler，Agent 会**等它返回**。因为 Agent 要读返回值才能决定下一步——你说拦，它才拦。源码里这行带 `await`：

```typescript
await this._emitExtensionEvent(event);   // 扩展：等。Agent 要读 handler 的返回值
```

- 管道 A 的 listener，Agent **不等**。通知完就继续，listener 返回什么 Agent 都不读。源码里这行不带 `await`，而且 `_emit` 本身就是个同步函数：

```typescript
this._emit(event);                        // subscribe：不等。同步调用，返回值丢弃
```

因果关系很直接：扩展要读返回值，所以必须等；subscribe 不读返回值，等了也没用。"能改 Agent 行为"是"等 + 读返回值"的结果，不是单独赋予的能力。

![两条管道](assets/260702-ch07-two-pipelines.svg)

**配图说明**：同一个事件源分流到两条管道——左管道 A（subscribe，只读广播，Agent 不等），右管道 B（扩展 pi.on，能拦截改写，Agent 等你回话）。两条管道喂的是同一个事件，但 Agent 对一个等、对另一个不等。

**容易搞混的两个事件名：`tool_call` 与 `tool_execution_start`**

这两个名字像，但走不同管道、发生在不同时刻：

```
LLM 决定调一个工具
   │
   ▼  管道 B：tool_call（执行前）
   │   扩展可以 return { block: true } 拦掉它；一旦 block，下面都不发生
   │   注意：tool_call 不是 2.1 那 10 种之一，是 SDK 在执行前主动触发的扩展独占事件
   │
   ▼  （没被拦）tool.execute() 开跑
   │
   ▼  管道 A + B 都收到：tool_execution_start（已开跑，拦不住了）
   │   这是 2.1 那 10 种之一，由 Agent 内核发出，两条管道都收
   │
   ▼  tool_execution_end
```

`tool_call` 是执行前的安检门（能拦，管道 B 独占），`tool_execution_start` 是开跑后的广播（拦不了，两条管道都收）。管道 A 根本收不到 `tool_call`——你在 `subscribe` 里写 `if (event.type === "tool_call")` 不会报错，但这个分支永远命中不了。

除了 `tool_call`，扩展还能在另外几个"Agent 要停下来读返回值"的位置介入，管道 A 一律收不到。**近几个版本这批决策点大幅扩容**：最早只有 4 个（`input`、`before_agent_start`、`context`、`tool_result`）；`message_end`、`user_bash` 更早就存在，0.86.0 起多了 `cache_warming_decision`，0.87.0 起多了 `context_with_system`、动作化的 `turn_end` / `agent_before_settle`，0.99.0 起又多了 `provider_stream_event`。它们加起来，才是管道 B 能干预 Agent 的全部入口（4.5、4.6、4.7 会逐条列出）。

> **一个细节：工具进度更新可以不等。** 生命周期事件（start/end 这类低频、不能错的）Agent 会逐个等扩展处理完。但工具执行时会刷出大量进度（Bash 每一行输出都是一个 `tool_execution_update`），逐个等会卡住 Agent。Pi 对这类高频事件开了口子——先攒着，最后一次性等完。原则是：越重要的事件等得越严格。

`tool_call` 是"安检门"（执行前，能拦，管道 B 独占），`tool_execution_start` 是"已经开跑的广播"（拦不了，两条管道都收）。被 `tool_call` 拦掉的调用，根本不会触发 `tool_execution_*`。**它们是同一个时刻的两面，但只有 `tool_call` 能动手。** 这个例子也印证了 2.1 末尾的话：10 种内核事件是共同水源，而扩展独占事件（如 tool_call）是另一批，由 SDK 在决策点触发。

---

## 三、管道 A：session.subscribe

2.2 介绍了管道 A 的特点：Agent 不等它，所以它只能看、不能改。这一节落到源码，看清"不等"和"只能看"是怎么实现的。

### 3.1 怎么用：注册、签名、注销

```typescript
// 注册：传入一个 listener，返回一个注销函数
const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
        process.stdout.write(event.assistantMessageEvent.delta);   // 流式打字
    }
});

// 不用了就调注销函数
unsubscribe();
```

listener 的签名是关键：

```typescript
type AgentSessionEventListener = (event: AgentSessionEvent) => void;
//                            注意返回值：void ↑↑↑↑
```

另外，listener 只收到 `event` 一个参数——内核层的 `agent.subscribe` 才额外传 `signal`，而 `AgentSession._emit` 只用 `l(event)` 调用它，第二个参数恒为 `undefined`，别与内核层混用。

**返回值是 `void`**——就算你在 listener 里 `return { block: true }`，Agent 也不读、不用。这是管道 A"只能看不能改"在类型层面的体现，也是和管道 B 最根本的差别。

### 3.2 "不等"对管道 A 意味着什么

Agent 对 subscribe 监听器"通知一声就走"，不等你。落到实战，这个"不等"带来三个直接后果：

- **你可以在监听器里干异步重活**（比如 `await` 一个慢请求），**不会**拖慢 Agent——Agent 早就走下一步了，你的请求在后台慢慢跑。
- 但也正因为不等，**你的异步结果传不回去**——Agent 已经发下一个事件了，不在乎你算出了什么。
- 所以管道 A 适合"我慢慢干我的，不打扰 Agent"的场景：写日志、推 SSE、更新外部状态。**不适合**需要"先等我处理完再继续"的场景——那必须走管道 B。

**一个隐藏的坑**：因为不等，async 监听器里的错误不会冒泡到 Agent。如果你在 async 监听器里 `await` 一个会失败的操作，失败会被悄悄吞掉，你连错在哪都不知道。**务必在 async 监听器里自己 try-catch**——Agent 不会替你兜底。

### 3.3 管道 A 能收到哪些事件

管道 A 收到的是 `AgentSessionEvent`，它的定义就在 `agent-session.ts`：

```typescript
export type AgentSessionEvent =
    // 内核 10 种事件（agent_end 除外）原样带过来，工具执行三类还带上 parentToolCallId
    | WithParentToolCallId<Exclude<AgentEvent, { type: "agent_end" }>>
    // agent_end 被 Session 层加宽：多了 willRetry
    | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
    | { type: "agent_settled" }
    | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
    | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
    | { type: "entry_appended"; entry: SessionEntry }
    | { type: "session_info_changed"; name: string | undefined }
    | { type: "thinking_level_changed"; level: ThinkingLevel }
    | { type: "compaction_end"; /* ...result/aborted/willRetry */ }
    | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
    | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
    | { type: "summarization_retry_scheduled"; /* ... */ }
    | { type: "summarization_retry_attempt_start"; /* branchSummary 或 compaction */ }
    | { type: "summarization_retry_finished" }
    | { type: "bash_execution_update"; id?: string; delta: string };
```

两个要点（都是当前 1.0.3 的形态）：

1. **`agent_end` 被 Session 层加宽了**：内核 `AgentEvent.agent_end` 只有 `{ messages }`，Session 层把它扩成 `{ messages, willRetry }`。`willRetry` 表示"这轮结束后还会自动重试"，订阅方据此决定要不要急着收尾。**内核与 Session 层的 `agent_end` 不是同一个形状**，别混为一谈。
2. **嵌套工具调用事件带 `parentToolCallId`**（0.99.0 引入）：`WithParentToolCallId` 给工具执行三类事件（`tool_execution_start` / `tool_execution_update` / `tool_execution_end`）补上可选的 `parentToolCallId`。当一次调用是由别的工具经 `ctx.executeTool()` 发起时（例如 codemode 脚本），这个字段标记它的"父调用"，UI 才能把嵌套调用挂到正确的树上（扩展侧的 `tool_call` / `tool_result` 事件同样带这个字段）。

产品级事件（Session 层独有，内核不知道这些概念）几个典型的：

| 事件 | 什么时候触发 | 典型用途 |
|------|------------|---------|
| `agent_settled` | 一次 `prompt()` 彻底跑完（含重试/压缩/队列全部处理完） | 可靠的结束信号：写库收尾、推 SSE done |
| `compaction_start` / `compaction_end` | 上下文窗口快满时，自动压缩历史（第9章详讲） | UI 显示"正在压缩..."提示 |
| `auto_retry_start` / `auto_retry_end` | LLM 调用失败，自动重试 | UI 显示重试次数、告警 |
| `summarization_retry_scheduled` / `..._attempt_start` / `summarization_retry_finished` | 摘要（compaction / branch summary）调用失败后重试 | UI 显示摘要重试 |
| `queue_update` | steering / followUp 消息队列变化 | UI 更新"排队中"状态 |
| `entry_appended` | 一条 Session 结构性 entry 被写入（自定义 entry、上下文编辑等） | 增量落库 / 刷新树视图 |
| `bash_execution_update` | 用户在 `!` / `!!` bash 执行中产生输出增量 | 实时回显用户命令输出 |
| `session_info_changed` | 会话名称等元信息变化 | UI 刷新标题 |
| `thinking_level_changed` | 切换思考深度 | UI 联动显示 |

加上内核的 10 种生命周期事件，就是管道 A 能收到的全部。

但管道 A **收不到**管道 B 独占的那些决策点（`input`/`before_agent_start`/`context`/`context_with_system`/`tool_call`/`tool_result`/`message_end`/`cache_warming_decision`/`turn_end`/`agent_before_settle`/`user_bash` 等）——Agent 内核根本没有这些 type，它们是 SDK / Session 在决策点主动调用扩展系统时产生的，只能走管道 B（4.5、4.6、4.7 会列全）。

### 3.4 什么时候用管道 A

一句话：**纯观察、不改 Agent 行为、不需要 Agent 等你的场景。** 典型用途——流式渲染（TUI 逐 token 打字）、日志记录、SSE 转发给浏览器、统计 token 用量。这些场景的共同点是"Agent 干它的，我在旁边看一眼、或慢慢做我自己的事"，不需要 Agent 配合。

> 💡 **落库 / 审计 / 日志也是「纯观察」，首选管道 A**。因为管道 A 不 `await` 你的监听器——你在里面 `await db.insert()`，派发方 `_emit` 调一下就走（2.2 讲的"不读返回值"），I/O 在后台跑，Agent 不被拖慢。
>
> 只有当你要存的数据来自 `tool_call` / `tool_result` / `context` 等**管道 A 收不到的决策点**时，才被迫走管道 B——但管道 B 的 handler 被 `await`（2.2 讲的"Agent 等你"），落库必须 **fire-and-forget**：handler 里把数据推进队列后立刻返回，真正的写库交给独立 worker 异步处理，别让 `await` 链绑住 Agent 主循环。
>
> 一个易踩的坑：`message_end` 看着像"一条消息存一笔"的好时机，但它一轮 `prompt()` 会触发多次（每条 assistant 消息结束都发，含中间要调工具的那些）。拿它当整轮收尾会重复落库 / 重复推 done。整轮的可靠收尾用 `agent_settled`——它每 prompt 只发一次。

---

## 四、管道 B：扩展系统 pi.on

这一节是本章的重头戏。管道 B 的能力远超管道 A——它能拦截工具、改写上下文、替换系统提示词。这些能力的源头，是 SDK 在关键决策点**停下来等扩展的返回值**（2.2 讲的"Agent 等"）。

### 4.1 怎么用：写扩展、挂载、注册

管道 B 的代码不在"外部脚本"里，而是写在**扩展**里——一个接收 `pi` 对象的工厂函数：

```typescript
// 一个扩展：框架启动时调它，把遥控器 pi 传进来
function myGuardExtension(pi) {
    // 用 pi.on 盯住"工具调用前"这个事件
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName === "delete_table") {
            return { block: true, reason: "生产环境禁止删除操作" };   // ← 有返回值，能拦
        }
        return undefined;   // 放行
    });
}
```

挂载通过 `DefaultResourceLoader` 的 `extensionFactories`：

```typescript
const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    extensionFactories: [myGuardExtension],   // ← 你的扩展塞这儿
});
await loader.reload();

const { session } = await createAgentSession({ /* ..., */ resourceLoader: loader });
```

注意两个关键点：
- **handler 有返回值**（`return { block: true }`）——这是管道 B 能干预 Agent 的根本，也是"Agent 必须等你"的原因（要读返回值）。
- **handler 多一个 `ctx` 参数**——扩展上下文，能力比管道 A 的 `event + signal` 强（见 4.4）。

### 4.2 源码：pi.on 只是往 Map 里 push（并返回注销函数）

管道 B 的注册实现极简。`pi.on` 做的事就是往一个 Map 里塞 handler——**0.86.0 起它还返回一个注销函数**：

```typescript
// packages/coding-agent/src/core/extensions/loader.ts —— createExtensionAPI 里
on(event: string, handler: HandlerFn): () => void {
    assertActive();
    const registeredHandler: HandlerFn = (...args) => handler(...args);
    const list = extension.handlers.get(event) ?? [];   // 取出该事件的 handler 列表
    list.push(registeredHandler);                        // 塞进去
    extension.handlers.set(event, list);                 // 放回

    return () => {                                        // ← 注销函数
        const handlers = extension.handlers.get(event);
        if (!handlers) return;
        const handlerIndex = handlers.indexOf(registeredHandler);
        if (handlerIndex === -1) return;
        handlers.splice(handlerIndex, 1);
        if (handlers.length === 0) extension.handlers.delete(event);
    };
},
```

每个扩展对象内部有一个 `handlers: Map<事件名, handler[]>`。`pi.on("tool_call", h)` 就是在 `"tool_call"` 这个 key 下追加 `h`，返回值可以拿来注销。派发时遍历这个 Map。

> **一个 0.86.0 的细节：派发用的是快照。** `ExtensionRunner` 每次派发前都调 `snapshotEventHandlers()`，对每个扩展取 `ext.handlers.get(event)?.slice()`——即先复制当前 handler 列表再遍历。所以 handler 在派发**过程中**调 `pi.on` 新增、或调注销函数移除，**只对后续派发生效**，不影响正在进行的这一轮。

### 4.3 源码：extensionRunner 的几条派发路径

真正的差别在派发。`ExtensionRunner`（`packages/coding-agent/src/core/extensions/runner.ts`）把派发分成几类方法，对应"通知型"和"决策型"事件——但**大多数都 await handler**（这是管道 B"Agent 等你"的实现）。派发前一律先 `snapshotEventHandlers()` 取快照（见 4.2）。

**路径 1：通知型 `emit()`**——处理 `message_update`、`turn_start` 等只读事件：

```typescript
// ExtensionRunner.emit
async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
    const ctx = this.createContext();
    let result: SessionBeforeEventResult | undefined;
    for (const { ext, handlers } of snapshotEventHandlers(this.extensions, event.type)) {
        for (const handler of handlers) {
            try {
                const handlerResult = await handler(event, ctx);   // ★ await 每个 handler
                // 一般忽略返回值；session_before_* 例外，读 cancel
                if (this.isSessionBeforeEvent(event) && handlerResult) {
                    result = handlerResult;
                    if (result.cancel) return result;              // ★ cancel 短路
                }
            } catch (err) {                                        // ★ try-catch 隔离
                this.emitError({ extensionPath: ext.path, event: event.type, error: ... });
            }
        }
    }
    return result;
}
```

特征：**串行 await、try-catch 隔离、忽略返回值（`session_before_*` 读 `cancel`）**。注意即便忽略返回值，仍然 await——这是为了"同步屏障"（等扩展处理完才发下一个事件，保证状态一致）。这条路径处理的是 2.1 那 10 种内核事件翻译过来的一部分，以及一批 `session_*` / `ui_prompt_*` / `model_select` 等生命周期事件。

**路径 2：决策型 `emitToolCall()`**——处理 `tool_call` 拦截：

```typescript
// ExtensionRunner.emitToolCall
async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    const ctx = this.createContext();
    let result: ToolCallEventResult | undefined;
    for (const { handlers } of snapshotEventHandlers(this.extensions, "tool_call")) {
        for (const handler of handlers) {
            const handlerResult = await handler(event, ctx);   // ★ await + 读返回值
            if (handlerResult) {
                result = handlerResult as ToolCallEventResult;
                if (result.block) {
                    return result;                              // ★ block 立即短路
                }
            }
            // 注意：这里没有 try-catch！这是刻意的 fail-closed 设计——
            // 扩展在 tool_call 里崩了，宁可拦掉工具也不放行（安全优先）
        }
    }
    return result;
}
```

特征：**await + 读返回值 + `block` 短路 + 无 try-catch**。`tool_call` 是所有派发方法里唯一不包 try-catch 的——扩展抛错会冒泡（调用方 `AgentSession._beforeToolCall` 会把它包成 "Extension failed, blocking execution" 再抛），导致这次工具调用被 block（fail-closed：宁可错杀，不放行可能危险的操作）。

**路径 3：链式 transform / 决策型 `emitXxx()`**——还有一批决策事件各有专属方法，每个 handler 接收上一个的输出继续改。比如：

- `emitContext()`：**两个阶段**。先跑 `context` handler——handler 只看到**不含 system 的消息**，改完由 Pi 把 prompt 与工具声明还原回去；紧接着跑 `context_with_system` handler——拿到**含 system 的完整 transcript**，返回值原样采用（"屏蔽 system + 事后还原"与 `context_with_system` 都是 0.87.0 定型，见 4.6）。返回 `AgentMessage[]`。
- `emitToolResult()`：链式修改工具结果，返回 `ToolResultEventResult | undefined`。
- `emitMessageEnd()`：链式替换消息，返回 `AgentMessage | undefined`（0.71.0 起即可替换，见 4.6）。
- `emitBeforeAgentStart()`：链式覆盖系统提示词 + 收集注入消息，返回 `BeforeAgentStartEventResult`。
- `emitInput()`：链式改写用户输入，`action: "handled"` 短路。
- `emitCacheWarmingDecision()`：干预缓存预热决策，返回 `CacheWarmingAction`（0.86.0 新增，见 4.6）。
- `emitUserBash()`：接管用户 `!` / `!!` 命令的执行，返回 `UserBashEventResult`（早已有；0.86.0 起改为 fail-closed，见 4.6）。

这批方法和 `emitToolCall` 一样 await + 读返回值，但**基本都包 try-catch**（错误转发 `emitError`）。只有 `emitToolCall` 完全没有 try-catch；`emitUserBash` 虽会捕获并上报错误，但随后把错误重新抛出。

**路径 4：动作化边界 `emitBoundary()`**——`turn_end` 和 `agent_before_settle` **不再走 `emit()`**：`emit()` 的事件类型 `RunnerEmitEvent` 明确把 `TurnEndEvent` / `AgentBeforeSettleEvent` 排除掉了。Host（`AgentSession`）改用 `emitBoundary(baseEvent, buildContext)` 派发，让 handler 能返回 `{ entries, continue }` 边写历史边续跑。这是 0.87.0 的破坏性变更，详见 4.7。

### 4.4 ctx：扩展上下文

handler 签名 `(event, ctx)` 里的 `ctx` 是 `ExtensionContext`（`packages/coding-agent/src/core/extensions/types.ts`），能力远强于管道 A 的 `event + signal`：

```typescript
interface ExtensionContext {
    ui: ExtensionUIContext;                  // select/confirm/input/notify 等 UI 能力
    mode: "tui" | "rpc" | "json" | "print";  // 当前运行模式
    hasUI: boolean;                          // 是否具备可弹窗的 UI（TUI/RPC 为 true）
    cwd: string;                             // 工作目录
    sessionManager: ReadonlySessionManager;  // ★ 只读！能读历史但不能直接写
    modelRegistry: ModelRegistry;            // 模型注册表
    model: Model<any> | undefined;           // 当前模型
    scopedModels: readonly ScopedModel[];    // 本会话可选模型快照（--models / enabledModels）
    thinkingLevel?: ThinkingLevel;
    isIdle(): boolean;                       // Agent 是否空闲
    isProjectTrusted(): boolean;             // 项目信任是否生效
    signal: AbortSignal | undefined;         // 中断信号
    abort(): void;                           // 主动中断
    hasPendingMessages(): boolean;           // 是否有排队消息
    shutdown(): void;                        // 所有上下文可用：优雅退出 pi
    getContextUsage(): ContextUsage | undefined;
    compact(options?): void;                 // 触发上下文压缩
    getSystemPrompt(): string;               // 读系统提示词
}
```

一个**容易踩的坑**：`sessionManager` 是 `ReadonlySessionManager`——能读会话历史（`getEntries()`），但**不能直接写**。扩展要写 session 得走 `pi.sendMessage()` / `pi.appendEntry()` 等 action 方法，或在命令上下文（`ExtensionCommandContext`，能力更全）里操作。

### 4.5 扩展独占事件的触发位置

管道 B 独占的事件，触发方式分两种：一部分由 `AgentSession._emitExtensionEvent` 翻译内核事件时派发（如 `message_end` / `start` / `update`），另一部分由 SDK / Session 在**各自的决策点**主动调用 `extensionRunner.emitXxx()`。**当下（1.0.3）管道 B 独占、且会读 handler 返回值的决策点至少有 11 个**（`input` / `before_agent_start` / `context` / `context_with_system` / `tool_call` / `tool_result` / `message_end` / `cache_warming_decision` / `turn_end` / `agent_before_settle` / `user_bash`），另有 `provider_stream_event` 等只读观察事件；它们并非同一次加入，所属版本见下表。它们的触发位置集中在几个文件：

| 扩展独占事件 | 触发符号 / 位置 | 挂在哪个内核 hook 上 |
|---|---|---|
| `tool_call`（执行前）| `AgentSession._beforeToolCall` | `agent.beforeToolCall` |
| `tool_result`（执行后）| `AgentSession._afterToolCall` | `agent.afterToolCall` |
| `input`（用户输入后）| `AgentSession._runInputHandlers` | `sendUserMessage` 流程，skill/template 展开前 |
| `before_agent_start`（开跑前）| `AgentSession`（`emitBeforeAgentStart` 调用点）| `sendUserMessage` 流程，`agent.run` 前 |
| `context`（发 LLM 前）| `ExtensionRunner.emitContext` ← `agent.transformContext`（`sdk.ts` 装配）| `agent.transformContext` |
| `context_with_system`（0.87，紧接 `context` 之后）| 同上，`emitContext` 的第二段循环 | `agent.transformContext` |
| `before_provider_request`（HTTP 发出前）| `ExtensionRunner.emitBeforeProviderRequest` ← `onPayload`（`sdk.ts`）| `onPayload` 回调 |
| `before_provider_headers`（请求头组装后、发 HTTP 前）| `ExtensionRunner.emitBeforeProviderHeaders` ← `transformHeaders`（`sdk.ts`）| `transformHeaders` 回调 |
| `after_provider_response`（收到响应）| `ExtensionRunner.emit` ← `onResponse`（`sdk.ts`）| `onResponse` 回调 |
| `provider_stream_event`（0.99，解析事件归一化前）| `ExtensionRunner.emit` ← `onProviderStreamEvent`（`sdk.ts`）| `onProviderStreamEvent` 回调 |
| `cache_warming_decision`（0.86）| `ExtensionRunner.emitCacheWarmingDecision` ← `CacheWarmer` 的 `decide` 回调 | 无内核 hook（`CacheWarmer` 内部）|
| `user_bash`（早已有；0.86 起 fail-closed，用户 `!`/`!!` 命令）| `ExtensionRunner.emitUserBash` ← `interactive-mode.ts` / `rpc-mode.ts` | 无内核 hook |
| `message_end`（0.71 起可返回替换消息）| `ExtensionRunner.emitMessageEnd` ← `AgentSession._emitExtensionEvent` | 内核 `message_end`（见 4.6）|
| `turn_end` / `agent_before_settle`（0.87，动作化边界）| `ExtensionRunner.emitBoundary` ← `AgentSession._dispatchTurnEndBoundary` / `_runBeforeSettleBoundary` | `agent.finishTurn` 与 settle 前流程（见 4.7）|

这张表回答了 2.2 那个"管道 A 为什么收不到这些"的问题：**它们 Agent 内核根本没有这些 type，是 SDK / Session 在上述位置主动调用 `extensionRunner.emitXxx()` 的产物。** 管道 A 监听的是 `_emit`（被 `_handleAgentEvent` 调用），自然听不到这些。

### 4.6 几个关键介入点（跨 0.71 / 0.86 / 0.87 / 0.99）

前面表格里的几个关键介入点并非同一次加入，值得单独说清楚——它们把"扩展能干什么"往前推了一大步。

**`context_with_system`：改完整 transcript 的第二次机会。**
`context` 只给 handler 看不含 system 的消息（prompt 和工具声明由 Pi 保管、事后还原），这保护了缓存前缀，但也意味着你没机会动 system 消息。0.87 加了第二段：`context_with_system` 在**所有 `context` handler 跑完、Pi 还原完 prompt/工具状态之后**运行，拿到的是**含 system 的完整 transcript**，且返回值**原样采用**（不还原）。想要完全接管 prompt 和工具声明时就用它。见 `ContextWithSystemEvent`（`types.ts`）与 `emitContext` 第二段（`runner.ts`）。

**`message_end`：handler 可以返回替换消息，从而改写历史。**
内核在一条消息定稿后发 `message_end`。0.71.0 起它在扩展侧不只能观察——`emitMessageEnd()` 收集 handler 返回的 `MessageEndEventResult.message`，**用替换消息改写定稿内容**（替换必须保持原 role，否则报错并跳过）。`AgentSession._emitExtensionEvent` 拿到替换后调 `_replaceMessageInPlace()` 原地改写消息对象，这样 agent 状态、后续 turn/agent 事件、监听器、以及 `SessionManager` 的持久化都保持一致。用途：脱敏、裁剪超长输出、修正格式。

**`provider_stream_event`：观察 provider 归一化前的解析事件。**
这是最底层的一手数据：provider 适配器刚解析出、还没被 Pi 归一化的流事件，`emit({ data, provider, api, model })` 原样交给 handler。见 `ProviderStreamEvent`（`types.ts`）与 `handleProviderStreamEvent`（`sdk.ts`）。它是**只读观察**（handler 无返回值被采用），适合做 trace、日志、适配器调试。

**`cache_warming_decision`（0.86.0）：让扩展决定"要不要预热提示缓存"。**
Pi 会估算下一次请求复用前缀的概率，决定是否提前把缓存焐热（`warm` / `stop`）。`emitCacheWarmingDecision()` 把决策交给扩展：handler 返回 `{ action }`，**最后一个非 undefined 的覆盖生效**；扩展抛错则回退到 Pi 自己的决策（fail-safe）。见 `CacheWarmingDecisionEvent`（`cache-warmer.ts`）。

**`user_bash`：接管用户 `!` / `!!` 命令的执行。**
该事件本身早已存在；0.86.0 起改为 fail-closed——handler 抛错或返回非法对象会中止命令，不再回退本地执行。用户在交互里敲 `!command` 时，若扩展注册了 `user_bash` handler，可以返回 `{ operations }` 换一套执行实现，或直接返回 `{ result }` 表示"我来执行、结果给你"。见 `UserBashEventResult`（`types.ts`）。

### 4.7 动作化边界与 finishTurn：从"能读"到"能写"

这一节是 0.87 在管道 B 上最大的一次能力升级。

**先从内核侧说：`finishTurn` 取代了旧的 `shouldStopAfterTurn`。**
内核的 `AgentLoopConfig` 现在有一个 `finishTurn` 钩子（类型 `FinishTurn`，见 `packages/agent/src/types.ts`）。它在**assistant 消息与它的工具结果全部定稿之后、`turn_end` 之前**被调用（调用点 `agent-loop.ts`），返回 `{ action: "end" | "continue" }`：

```typescript
// agent-loop.ts（正常轮）
const decision = await config.finishTurn?.(lastCompletedTurn, signal);
await emit({ type: "turn_end", message, toolResults });
if (decision?.action === "end") {
    await emit({ type: "agent_end", messages: newMessages });
    return;
}
explicitContinuation = decision?.action === "continue";
```

`continue` 表示"确保再发起一次 provider 请求"（工具结果 / steering / followUp 的调度可以满足它，不额外多请求一次）；`end` 表示直接收尾。**注意它对正常、错误、中止三种响应都会运行**——出错/中止分支（`agent-loop.ts` 里 `stopReason` 为 `error`/`aborted` 时）也会先 `await config.finishTurn?.(...)` 再发 `turn_end` / `agent_end`，只是那个分支不读返回值（错误/中止仍是硬退出）。

**再看扩展侧：`turn_end` / `agent_before_settle` 两个"动作化边界"。**
旧的 `turn_end` 只是通知：扩展看得到这一轮结束了，却不能在"历史已经定稿、但这一轮还没彻底翻篇"的位置动手。0.87 把它和 `agent_before_settle` 变成**边界事件**，二者都继承 `BoundaryState`，handler 可以返回 `BoundaryResult`：

```typescript
// packages/coding-agent/src/core/extensions/types.ts
export interface BoundaryState {
    entries: SessionBoundaryDraft[];   // 已追加的结构性 entry（可继续追加）
    continue: boolean;                 // 是否要求再续跑一轮
    context: BoundaryContextPreview;   // 追加后上下文的预览（含 canContinue）
    outcome: AgentActivityOutcome;     // "completed" | "aborted" | "error"
}
export type BoundaryResult = { entries?: SessionBoundaryDraft[]; continue?: boolean };

export interface TurnEndEvent extends BoundaryState {
    type: "turn_end";
    turnIndex: number;
    message: AgentMessage;
    toolResults: ToolResultMessage[];
    messageEntryId: string;            // 本轮 assistant 消息已持久化的 entry id
    toolResultEntryIds: string[];
}
```

这就是"边写历史边续跑"：handler 返回 `{ entries, continue: true }`，就能往会话里**持久化结构性 entry**（自定义 entry、上下文编辑、消息等，见 `SessionBoundaryDraft`）**并确保再发起一次 provider 请求**，而不是只能读。

**破坏性变更（必须知道）**：`ExtensionRunner.emit()` 现在**不接受 `turn_end`**——`RunnerEmitEvent` 的排除列表里明确含 `TurnEndEvent` 和 `AgentBeforeSettleEvent`。Host 集成改用 `emitBoundary(baseEvent, buildContext)`：

```typescript
// ExtensionRunner.emitBoundary —— 逐 handler 累积 entries / continue，每步重建 context 预览
const handlerResult = (await handler(event, ctx)) as BoundaryResult | undefined;
if (handlerResult?.entries !== undefined) entries = handlerResult.entries;
if (handlerResult?.continue !== undefined) shouldContinue = handlerResult.continue;
```

对应地，`AgentSession` 侧的接线也换了：它把 dispatcher 挂在内核 `finishTurn` 上（`_installAgentBoundaryHooks`），在 `finishTurn` 里调 `AgentSession._dispatchTurnEndBoundary` 派发 `turn_end` 边界；`agent_before_settle` 则在 settle 前由 `AgentSession._runBeforeSettleBoundary` 派发。若某个 `turn_end` handler 要求续跑，wrapper 返回 `{ action: "continue" }` 交给内核。于是 `turn_end` 边界其实是在内核 `finishTurn` 里、`turn_end` **内核事件**发出之前就跑完了的（`_boundaryDispatchedMessages` 负责避免重复派发）。

### 4.8 什么时候用管道 B

一句话：**需要改变 Agent 行为的场景。** 拦截危险工具调用、改写发给 LLM 的上下文、替换系统提示词、修改工具返回值、过滤用户输入、过滤/替换消息、在边界处写历史并续跑——这些"干预"类需求，管道 A 做不到（不等你就意味着返回值丢弃），只能写扩展走管道 B。

---

## 五、实战：四个场景，各走哪条管道

理解了两条管道的机制，就能判断每个需求该用哪条。下面四个场景覆盖最常见的集成需求，**按管道分组**——这是本章最重要的实战判断。

### 5.1 管道 A 实战组（session.subscribe，只读观察、Agent 不等）

#### 场景1：实时观测 Agent 在干什么

```typescript
session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
        console.log(`🔧 ${event.toolName}(${JSON.stringify(event.args).slice(0, 50)})`);
    }
    if (event.type === "tool_execution_end") {
        console.log(`   └─ ${event.isError ? "❌ 失败" : "✅ 成功"}`);
    }
});
```

**为什么走管道 A**：纯观察，不改变 Agent 行为。Agent 不等你也无所谓——你要做的只是"看到事件、打印一行"，同步即可完成。Pi 的 TUI 本身就是通过订阅事件实现的观测面板——你看到的所有终端输出都来自管道 A 的消费。

#### 场景2：流式转发到 Web 前端（SSE）

```typescript
// 服务端
session.subscribe((event) => {
    if (event.type === "message_update") {
        res.write(`data: ${JSON.stringify({ type: "delta", text: extractText(event.message) })}\n\n`);
    }
    if (event.type === "agent_end") {
        res.end();
    }
});
```

**为什么走管道 A**：纯转发，不改 Agent。Agent 运行在服务器上，用户通过浏览器访问，订阅事件流通过 SSE 推给浏览器——这就是 Web 集成的核心。

### 5.2 管道 B 实战组（扩展 pi.on，能干预、Agent 等你）

#### 场景3：工具调用拦截

```typescript
function guardExtension(pi) {
    pi.on("tool_call", async (event) => {
        if (event.toolName === "delete_table") {
            return { block: true, reason: "生产环境禁止删除操作" };
        }
        return undefined;   // 放行
    });
}
// 挂载：extensionFactories: [guardExtension]
```

**为什么必须走管道 B**：要拦截、要返回 `{ block: true }`——管道 A 的 listener 不被等、返回值被丢弃，根本拦不住。而且 `tool_call` 这个事件**只在管道 B 派发**，管道 A 收不到。第 5 章讲的五步管道中第 3 步 `beforeToolCall`，底层就是这条管道实现的。

#### 场景4：上下文预处理

```typescript
function contextExtension(pi) {
    pi.on("context", async (event) => {
        // 在 LLM 调用前，往消息列表里注入当前时间
        return { messages: [{ role: "user", content: `当前时间：${new Date()}` }, ...event.messages] };
    });
}
```

**为什么必须走管道 B**：要改写发给 LLM 的消息列表——这是"改变 Agent 行为"，必须返回新列表让 Agent 采用（Agent 会等你返回）。第 6 章讲的 `transformContext` 钩子是同一条管道的实现（内核层的 `transformContext` 配置项和扩展层的 `context` hook 是同一件事的两面，一个走配置、一个走扩展）。

### 5.3 怎么选管道？一句话判断

> **你的代码要不要改变 Agent 的行为？**
> - 要（拦截、改参数、改消息、存状态）→ 写扩展，走**管道 B（`pi.on`）**。Agent 会等你、读你的返回值。
> - 不要（打日志、推前端、记统计）→ 用 **管道 A（`subscribe`）** 更轻。Agent 不等你、不读返回值。

### 5.4 小结

这四个场景的共同点是：**都不需要修改 Agent 内核。** 无论走哪条管道，新增功能都只是"挂一段自己的代码"。

事件驱动架构的真正威力不是"通知机制"（那只是管道 A），而是**开放扩展机制**——尤其是管道 B，它让第三方在不碰内核源码的前提下，能拦截、能改写、能干预。两条管道合起来，才构成 Pi 完整的"神经系统"。

---

## 六、总结：两条管道

Pi 的事件系统有一条核心分叉：**Agent 对扩展等、对 subscribe 不等**。这个差别决定了两条管道的全部行为。

**管道 A（`session.subscribe`）** —— Agent 不等你的监听器，返回值丢弃。所以你只能观察（渲染、日志、转发），改不了 Agent 的行为。它轻量、注册简单，适合在外部脚本里用。async 监听器的错误不会被 Agent 捕获，要自己 try-catch。

**管道 B（扩展 `pi.on`）** —— Agent 等你的 handler 返回，读返回值。所以你能干预 Agent 的下一步：拦工具、改上下文、换提示词。它还独占一大批决策点事件（`input`/`before_agent_start`/`context`/`context_with_system`/`tool_call`/`tool_result`/`message_end`/`cache_warming_decision`/`turn_end`/`agent_before_settle`/`user_bash` 等；它们并非一次加入——`message_end` 可追溯到 0.71.0，`cache_warming_decision` 与 `user_bash` 的 fail-closed 语义是 0.86.0，`context_with_system` 与动作化的 `turn_end` / `agent_before_settle` 是 0.87.0，`provider_stream_event` 才是 0.99.0），管道 A 收不到。写法上是把代码塞进扩展、挂到 loader；`pi.on` 现在返回注销函数。扩展 handler 的异常多数被框架隔离（单个扩展崩了不连累别人），但 `tool_call` 是例外——它不隔离，扩展出错就拦掉工具（fail-closed：宁可错杀，不放行危险操作）；而 `cache_warming_decision` 出错则回退到 Pi 自己的决策（fail-safe）。

判断用哪条管道，只问一句：**你的代码要不要改变 Agent 的行为**——要，写扩展走管道 B（Agent 会等你）；不要，`subscribe` 走管道 A（Agent 不等你）。

---

## 七、下一站

本章我们看到，事件系统让 Agent 和外部世界彻底解耦——UI、日志、持久化、扩展，全部通过订阅事件工作。两条管道（subscribe + pi.on）合起来，覆盖了从"纯观察（不等）"到"深度干预（等+返回值）"的全部需求。

但有一个和事件密切相关的机制我们只提了一句：**`transformContext`**（管道 B 的 `context` hook 在内核层的对应物）。第 6 章讲消息系统时说它在 `convertToLlm` 之前执行，负责裁剪旧消息、注入外部上下文。当对话越来越长，消息越来越多，最终会超出模型的上下文窗口。这时候 `transformContext` 需要做一件更激进的事——**压缩对话历史**。

接下来两章我们就打开 Pi 的上下文工程全貌。第 8 章先讲全景——从输入侧的工具输出截断、系统提示词组装，到历史侧的 Compaction 与分支摘要，让你看清 Pi 在多个环节布置的防线；第 9 章再深入其中最核心的压缩算法（Compaction），看 Pi 怎么在上下文窗口快满时把 50 轮对话压缩成一段结构化摘要，让 Agent 继续"记住"之前发生了什么。

---

> **本章关键源码索引**（对齐 Pi 1.0.3；一律「符号名 + 文件」，不含行号）：
> - `packages/agent/src/types.ts` — `AgentEvent`（10 种事件源）、`FinishTurn` / `AgentTurnDecision`（`finishTurn` 钩子类型）
> - `packages/agent/src/agent.ts` — `Agent.processEvents`（内核同步屏障）、`Agent.subscribe` 与 `listeners`
> - `packages/agent/src/agent-loop.ts` — `AgentEventSink`（emit 签名）、`executePreparedToolCall`（update 聚合与闸门）、`finishTurn` 调用点
> - `packages/coding-agent/src/core/agent-session.ts` — `AgentSessionEvent`（Session 层事件）、`_emit`（管道 A 实体，**同步不等**）、`_handleAgentEvent`（两条管道的分叉点）、`AgentSession.subscribe`、`_emitExtensionEvent`（翻译 / 触发管道 B）、`_beforeToolCall` / `_afterToolCall`、`_runInputHandlers`、`_installAgentBoundaryHooks` / `_dispatchTurnEndBoundary` / `_runBeforeSettleBoundary`（动作化边界）
> - `packages/coding-agent/src/core/extensions/types.ts` — `ExtensionEvent`（顶层联合，32 个成员）、`ExtensionAPI.on`（41 个重载）、`ExtensionHandler`、`ExtensionContext`、`TurnEndEvent` / `BoundaryState` / `BoundaryResult`、`MessageEndEventResult`
> - `packages/coding-agent/src/core/extensions/loader.ts` — `createExtensionAPI` 的 `on` 实现（push + 返回注销函数）
> - `packages/coding-agent/src/core/extensions/runner.ts` — `emit`（通知型，try-catch 隔离）、`emitToolCall`（决策型，★无 try-catch）、`emitContext`（`context` + `context_with_system` 两段）、`emitBoundary`（`turn_end` / `agent_before_settle`）、`emitMessageEnd`、`emitCacheWarmingDecision`、`emitUserBash`、`createContext`、`snapshotEventHandlers`
> - `packages/coding-agent/src/core/cache-warmer.ts` — `CacheWarmingDecisionEvent` / `CacheWarmingAction`
> - `packages/coding-agent/src/core/sdk.ts` — `transformContext` → `emitContext`、`onPayload`、`transformHeaders`、`onResponse`、`onProviderStreamEvent` 的回调装配
> - `packages/coding-agent/src/modes/interactive/interactive-mode.ts` / `modes/rpc/rpc-mode.ts` — `emitUserBash` 触发点
