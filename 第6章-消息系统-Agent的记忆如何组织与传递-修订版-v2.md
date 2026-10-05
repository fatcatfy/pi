# 第6章：消息系统 —— Agent 的记忆如何组织与传递（修订版 v2）

> **修订说明**：本文件是《第6章-消息系统-Agent的记忆如何组织与传递.md》的勘误修订版，原文件未改动。核对 1.0.3 源码后修正了以下问题：
>
> **A 类：版本归属错误（必须改）**
> 1. **transcript 化不是 0.99，是 0.86.0。** 原文 §二/§五/§六/§七/§八/§九/§十 把「`SystemMessage` 成为 `Message` 正式成员」「provider 入参由 `Context` 改为 `TranscriptContext`」「`normalizeContext` 折叠系统提示词与工具」「`convertToLlm` 的 `case "system"` 透传分支」一律记为「0.99 新增」。这四件事都在 **0.86.0**（`packages/ai/CHANGELOG.md`：Changing 条目「Changed provider-facing `ProviderStreams` and `StreamFunction` inputs from `Context` to normalized `TranscriptContext` values」与 Added 条目「Added transcript-backed mid-conversation system prompt and tool changes」）。本文档已全部改为 0.86.0。
> 2. **`ToolCall.arguments` 收紧为 `JsonObject`、`ToolResultMessage` 变条件类型、`JsonValue` 数组只读，也是 0.86.0**（同版本 Breaking Changes），不是 0.99。原文 §二「0.99 的三处收紧」已按真实版本拆开。
> 3. **`ThinkingContent.redacted` 远比 0.99 早**（`packages/ai/CHANGELOG.md` 0.55.x 之前就有），不再挂在 0.99 / 0.86 名下。
> 4. **`StopReason` 的 `pending` 是 0.83.0、`deferred` 是 0.84.0**（`packages/ai/CHANGELOG.md`），不是 0.99。
> 5. `AssistantMessage.thinkingLevel`（0.99.0）、`ToolResultMessage.nestedCalls`（0.99.0，coding-agent）确为 0.99，保留。`ToolCall.namespace` 的引入版本在 changelog 中无明确记录，正文不再标注版本（标「待核实」）。
>
> **B 类：符号/路径与当前源码不符**
> 6. **不再有 `packages/agent/src/harness/messages.ts`。** agent 包 1.0.0 删除了实验 harness（`AgentHarness`、sessions、`/harness/*` 子路径导出等），`@earendil-works/pi-agent-core` 现在只剩 `Agent`、agent loop、proxy stream 与 types（`packages/agent/CHANGELOG.md` 1.0.0 Breaking Changes）。原文 §五 结尾与 §十一 索引里的「harness 同名副本」条目已删除。
> 7. **§五 管道图把 `normalizeContext` 描述成「在 agent 循环里把 systemPrompt/tools 折进首条 system 消息」不准确。** `streamAssistantResponse` 实际调用的是 `normalizeContext({ messages: llmMessages })`，没有传 `systemPrompt` / `tools`，因此这一步在该调用点只做 brand。提示词与工具声明在更早的 `declareToolChanges()` 就以 system 消息写进 transcript；「折叠」只发生在公开入口（`Context` 仍携带 `systemPrompt` / `tools` 时）。正文已据此改写。
> 8. §二 的「Pi v0.80.2 时代 `Message` 只有三种」改为「0.86.0 之前」——0.86.0 才加入 transcript system 消息（0.80.2 的具体形态本次未逐一回溯，故不再点名该版本）。
>
> **C 类：细节澄清**
> 9. **自定义消息转 `user` 会产生连续 user。** 原文 §五 用「不能连续出现两个 `assistant`」解释为什么都转成 user，方向对但没点破代价：一条自定义消息紧跟在 user 消息之后时会形成连续 user（0.87.0 的 append-only 上下文编辑 / 会话投影、多次 submit 未产生 assistant 也会）。`convertToLlm` 不合并相邻 user，Pi 只在 provider 转换层合并连续 `toolResult`。正文补了一句据实说明。
> 10. `docs/message-types.md` 里的 `SystemMessage.replace` 字段与 `ToolCall.arguments: Record<string, any>` 与真实 `packages/ai/src/types.ts` 不一致（真实类型无 `replace`，`arguments` 是 `JsonObject`），以源码为准；本章正文未引用该文档，不受影响。
> 11. §四「Web UI 注册 `user-with-attachments` / `artifact`」在本仓库内找不到对应注册点，标「待核实」。
>
> **D 类：1.0.3 复核仍正确（未改）**
> 12. `Message` / `AssistantMessage` / `ToolCall` / `Context` / `TranscriptContext` / `ToolResultMessage`（`packages/ai/src/types.ts`）、`AgentMessage` / `CustomAgentMessages`（`packages/agent/src/types.ts`）、`defaultConvertToLlm`（`packages/agent/src/agent.ts`，只过滤四种标准 role）、coding-agent `convertToLlm`（`packages/coding-agent/src/core/messages.ts`）、`normalizeContext` 与回放函数（`packages/ai/src/utils/transcript.ts`）、`declareToolChanges` / `streamAssistantResponse`（`packages/agent/src/agent-loop.ts`）、`excludeFromContext` 过滤——均与源码一致。
> 13. 1.0.0 删掉的只是 agent 包 harness；本章主体（ai + agent + coding-agent 消息层）未受该结构性删除影响。
> 14. 在 coding-agent 层，喂给 agent loop 的 `context.messages` 由 `SessionManager` 投影产出（`buildSessionProjection()` / `buildSessionContext()`，`packages/coding-agent/src/core/session-manager.ts`）。0.87.0 起 `SessionManager` 是 provider context 的唯一权威：直接赋值 `session.agent.state.messages` 不再改变后续请求历史，须经 `appendContextEdit()` 等追加式编辑（不改原始历史）。本章讲的是 agent 循环内部的消息变换管道，不涉及这层归属；会话存储与分叉见第 10 章。

第 5 章我们学了工具系统——模型说"读文件"，Agent Loop 通过五步管道执行 read 工具，最终产生一条 `ToolResultMessage`。但你有没有注意到：我们一直在说"消息"这个词，却从来没拆开看过它到底长什么样。

UserMessage、AssistantMessage、ToolResultMessage——这几个名字反复出现在前五章里。第 3 章说"消息在 Loop 中流转"，第 4 章说"消息发给模型"，第 5 章说"工具结果是一条消息"。（其实底层还有第四种——`SystemMessage`，只是它一直躲在"系统提示词"这个说法背后，本章会把它请到台前。）

但消息到底是什么？它的数据结构长什么样？Agent 内部的消息和发给模型的消息一样吗？

这一章就来回答这些问题。你会看到 Pi 消息系统最核心的设计——**两层消息**：Agent 内部用丰富的格式自由表达，到了 LLM 边界翻译回严格的标准格式。

---

## 一、开场：一条 Bash 命令的消息之旅

先从一个具体场景说起。

你在 Pi 的终端里输入了一条 Bash 命令 `!ls -la`，回车执行。命令跑完了，输出了一堆文件列表。

这条命令的信息，在 Pi 内部会变成一条 **BashExecutionMessage**——它有 `command` 字段记录命令原文、`output` 字段记录输出内容、`exitCode` 字段记录退出码。这些结构化字段让 UI 可以用专用渲染器漂亮地展示终端输出。

但问题来了：当 Agent Loop 准备调用 LLM 时，LLM 的 API 根本不认识什么 `BashExecutionMessage`。它只认识四种消息格式：`system`（系统指令）、`user`（用户说的）、`assistant`（AI 回的）、`toolResult`（工具返回的）。BashExecutionMessage 不属于这四种中的任何一种。

那这条消息是怎么被 LLM 看到的？中间经历了什么变化？

这一章我们就跟着这条 BashExecutionMessage，从它的诞生走到 LLM 看到它的那一刻。

---

## 二、第一层：LLM 认识的消息有四种

在了解消息怎么变换之前，先搞清楚"变换的目标"长什么样。LLM 能理解的消息格式，在 Pi 里叫做 **Message** 类型，定义在最底层的 `packages/ai/src/types.ts` 里。

它只有四个成员：

```
Message 联合类型（LLM 标准格式）
│
├── SystemMessage      ← 系统指令：提示词 + 工具声明（0.86.0 起成为 Message 的正式成员）
├── UserMessage        ← 用户说的话 / 发的图片
├── AssistantMessage   ← LLM 的回复（含思考、工具调用）
└── ToolResultMessage  ← 工具执行后的结果
```

> **版本提醒**：0.86.0 之前 `Message` 只有 `user` / `assistant` / `toolResult` 三种；**0.86.0 起 `SystemMessage` 被提升为 `Message` 联合类型的正式成员**，系统提示词和工具声明也从"请求级参数"搬进了 transcript。这是本章相对旧版最大的改动，后面 §五、§七 会反复用到它。

### 每种消息的具体数据结构

**SystemMessage**——系统指令的载体。它是 0.86.0 引入的成员，也是理解本章后续所有机制的关键：

```typescript
{
    role: "system",
    content: string | TextContent[],       // 指令文本：首条是基础提示词，后续是追加指令
    sections?: Record<string, string | null>, // 命名提示词片段：后续消息按名字替换，null 表示删除
    toolsAdded?: Tool[],                   // 从这一刻起可用的工具完整定义
    toolsRemoved?: ToolReference[],        // 从这一刻起不再可用的工具
    timestamp: number
}
```

`SystemMessage` 的语义要分两种情况看：**如果它是 transcript 的第一条，它就是"当前系统提示词 + 初始工具集"**；**如果它出现在对话中途，它是一条"增量补丁"**——`content` 追加指令、`sections` 按名字增删片段、`toolsAdded` / `toolsRemoved` 改变工具集。把全部 system 消息按顺序"回放"一遍，就得到当前态（这正是 §七 的主角）。

**UserMessage**——最简单的一种，用户输入：

```typescript
{
    role: "user",
    content: string | (TextContent | ImageContent)[],  // 纯文本或内容块数组
    timestamp: number                                    // Unix 毫秒时间戳
}
```

content 可以是一个纯字符串，也可以是一个内容块数组。这意味着用户消息既能发文字，也能发图片。

**AssistantMessage**——LLM 的回复，字段最多：

```typescript
{
    role: "assistant",
    content: (TextContent | ThinkingContent | ToolCall)[],  // 三种内容块
    api: Api,                   // 使用的 API 类型（如 "anthropic-messages"）
    provider: ProviderId,       // 提供商（如 "anthropic"）
    model: string,              // 模型名（如 "claude-sonnet-4-6"）
    usage: Usage,               // token 用量统计
    stopReason: StopReason,     // 停止原因：pending/stop/length/toolUse/error/aborted/deferred
                                // （第3章讲的 5 种之外，pending 于 0.83.0、deferred 于 0.84.0 加入）
    thinkingLevel?: ModelThinkingLevel, // 本轮请求的思考等级（Agent Loop 记录，0.99.0 新增）
    errorMessage?: string,      // 错误信息
    timestamp: number
}
```

这里最值得关注的是 content 字段——它不是字符串，而是一个**内容块数组**，可以包含三种东西：

```
AssistantMessage 的 content 内容块
│
├── TextContent       ← 普通文本
│     { type: "text", text: "..." }
│
├── ThinkingContent   ← 思考过程（第3章讲过，模型"在想"但不直接告诉用户的部分）
│     { type: "thinking", thinking: "...", redacted?: true }  // redacted: 被安全过滤
│
└── ToolCall          ← 工具调用（第5章讲过，触发五步管道的入口）
      { type: "toolCall", id: "...", name: "read",
        arguments: { path: "..." },   // 0.86.0 起收紧为 JSON 兼容值（JsonObject）
        namespace?: "..." }           // 命名空间工具（OpenAI Responses）
```

**一条助手消息可能同时包含文本和工具调用。** 比如 LLM 一边说"让我帮你看看这个文件"，一边发出一个 Read 工具调用——这两个内容会放在同一个 AssistantMessage 的 content 数组里。第 3 章讲的"模型回复中包含 ToolCall"就是这个结构。

> **收紧细节（版本分属三处）**：① `ToolCall.arguments` 从 `Record<string, any>` 收紧为 `JsonObject`——工具参数必须是 JSON 兼容值，不能再塞函数或类实例；`ToolResultMessage.details` 同样被限制为 JSON 兼容值，`JsonValue` 数组改为只读。这组收紧是 **0.86.0** 的 Breaking Changes。② `ThinkingContent` 新增 `redacted`，标记这段思考被安全过滤器改写成了不透明密文（密文存在 `thinkingSignature` 里，供下一轮回传）——该字段在 0.55.x 之前就已存在，不属于近期变化。③ `ToolCall` 新增 `namespace`，用于 OpenAI Responses 里动态加载/命名空间化的工具；其引入版本 changelog 未明确记录（待核实）。另外 `AssistantMessage` 现在会记住 `thinkingLevel`——本轮请求用的是哪一档思考等级（**0.99.0** 新增），方便回放和排查。

> **进阶细节**：content 块里还有一些 `*Signature` 字段（`textSignature`、`thinkingSignature` 等），是某些 Provider（OpenAI、Google）要求的不透明签名 ID，下一轮请求必须原样回传。被安全过滤器编辑过的内容密文也存在这里。日常理解不需要深究，知道它是"Provider 之间的上下文连续性机制"即可。

**ToolResultMessage**——工具执行的结果（第 5 章的五步管道终点产物）：

```typescript
// 0.86.0 起：ToolResultMessage 是一个条件类型，details 必须是 JSON 兼容值
type ToolResultMessage<TDetails = JsonValue> =
    IsJsonCompatible<TDetails> extends true
        ? {
              role: "toolResult",
              toolCallId: string,                     // 对应哪个 ToolCall
              toolName: string,                       // 工具名
              content: (TextContent | ImageContent)[],// 结果内容
              details?: JsonRepresentation<TDetails>, // 结构化详情（给 UI 看的）
              usage?: Usage,                          // 工具自身的 token 用量（不计入主上下文）
              nestedCalls?: NestedToolCalls,          // 工具内部再调工具的记录（不给模型看）
              isError: boolean,                       // 是否执行失败（第5章的"永不抛出"产物）
              timestamp: number
          }
        : never;                                      // details 不是 JSON 兼容值 → 类型直接为 never
```

ToolResultMessage 通过 `toolCallId` 字段和 AssistantMessage 里的 ToolCall 对应起来。第 3 章提到的"工具结果必须精准关联回调用请求"就是靠这个字段。`details` 字段携带结构化信息给 UI 渲染用，LLM 通常不需要看这个字段。

> **两处变化（版本不同）**：① `ToolResultMessage` 从普通接口变成了**条件类型**——`details` 被约束为 `JsonRepresentation<TDetails>`，如果类型参数不是 JSON 兼容值，整个类型会塌缩成 `never`，在编译期就拦住"往工具结果里塞不可序列化对象"的写法。这是 **0.86.0** 的 Breaking Changes。② 新增 `nestedCalls`（`NestedToolCalls`），记录"一个工具在执行过程中又调用了哪些工具"——这是 **0.99.0** 为 codemode 这类"模型写脚本在里面并行调工具"的场景做可观测化用的（见 `packages/coding-agent/CHANGELOG.md`），只进 session 记录，**不发给模型**（结果不记录，`complete: false` 表示有调用被丢弃或未跑完）。另外 `usage` 记录工具自身的 token 消耗，不参与主上下文计费。

### 一个完整的对话示例

把这四种消息串起来，一个典型的对话片段长这样：

```
messages 数组：
│
├── [0] SystemMessage
│       role: "system"
│       content: "你是 Pi，一个终端编码 Agent……"   ← 系统提示词
│       toolsAdded: [read, write, edit, bash]     ← 初始工具声明
│
├── [1] UserMessage
│       role: "user"
│       content: "帮我看看 auth.ts"
│
├── [2] AssistantMessage
│       role: "assistant"
│       content: [
│           { type: "text", text: "让我帮你看看这个文件" },
│           { type: "toolCall", id: "tc_001", name: "read", arguments: { path: "auth.ts" } }
│       ]
│       stopReason: "toolUse"     ← 第3章讲过：调了工具，循环继续
│
├── [3] ToolResultMessage
│       role: "toolResult"
│       toolCallId: "tc_001"      ← 和上面的 id 对应
│       content: [{ type: "text", text: "import { auth } from '...' ..." }]
│       isError: false            ← 第5章讲过：正常结果
│
└── [4] AssistantMessage
        role: "assistant"
        content: [{ type: "text", text: "auth.ts 是一个认证模块..." }]
        stopReason: "stop"        ← 没调工具，循环结束
```

这就是 LLM 能理解的世界——系统说了什么（[0]）、用户说了什么、AI 回了什么、工具返回了什么，就这么四种。（[0] 这条 system 消息正是 0.86.0 的变化：以前它是紧挨在请求旁边的两个参数，现在它坐在 messages 数组的第一位。）

---

## 三、矛盾：Agent 里的消息不止四种

好，现在回到开头的场景。你执行了 `!ls -la`，Pi 内部需要记录这次执行的信息。

这里其实藏着一个更普遍的问题：**Agent 内部除了"LLM 对话"这件事，还有大量功能性数据要管理**——Bash 命令的执行记录、上下文被压缩后的摘要、Git 分支切换的记录、用户上传的附件元信息……

这些功能性数据有**两个独立的读者**，两个读者的需求是冲突的：

- **UI 端**需要结构化字段——Bash 执行要分别拿到 `command`、`output`、`exitCode`、`cancelled`、`truncated`，才能在终端里漂亮地渲染（命令用高亮、输出用等宽字体、退出码用颜色标识）
- **LLM 端**只需要看一段扁平文本——"用户执行了 `ls -la`，输出是 `file1.txt\nfile2.txt\n...`"，这一段文本塞进 `UserMessage.content` 就够用了

冲突点在哪？**如果为了 LLM 把字段提前拍扁存进 `UserMessage`，UI 就再也拿不回结构化数据了**——你已经搅成一锅粥。反过来，如果只存结构化的自定义消息、不进 LLM 上下文，那 LLM 就会失忆——下一轮它不知道用户刚才执行了什么。

Pi 的设计是**两边都不妥协**：**以结构化的形式存进 `context.messages`**（满足 UI/持久化），**在调用 LLM 的边界上做一次翻译**（满足 LLM）。这样 UI 永远有完整的结构化数据可用，LLM 也能看到它需要的扁平版本。翻译是在最后一刻发生的、有损的、单向的——损失掉的结构化字段，UI 早就用过了，无所谓。

**Pi 的解法是：允许应用自定义消息类型。** `pi-agent-core` 在 AgentMessage 联合类型里预留了一个扩展点（叫 `CustomAgentMessages`，下一节会展开它的实现原理），应用通过 TypeScript 的声明合并往里加自己的消息类型。每个应用只注册自己需要的——核心包零依赖，应用层全栈类型安全。

以 pi 自带的 coding-agent 为例，它在 [packages/coding-agent/src/core/messages.ts](repo/packages/coding-agent/src/core/messages.ts) 里定义了 4 种自定义消息：

```
coding-agent 的自定义消息类型
│
├── BashExecutionMessage       ← Bash 命令执行记录
├── CustomMessage              ← 扩展注入的通用消息
├── BranchSummaryMessage       ← 分支切换时的摘要
└── CompactionSummaryMessage   ← 上下文压缩后的摘要
```

每种都有自己的结构化字段。以 BashExecutionMessage 为例：

```typescript
{
    role: "bashExecution",
    command: string,          // 命令原文："ls -la"
    output: string,           // 输出内容："file1.txt\nfile2.txt\n..."
    exitCode: number | undefined,  // 退出码：0
    cancelled: boolean,       // 是否被取消
    truncated: boolean,       // 输出是否被截断
    fullOutputPath?: string,  // 截断时的完整输出文件路径
    timestamp: number,
    excludeFromContext?: boolean  // 是否排除在 LLM 上下文之外
}
```

结构化字段全保留下来了。但这里要停下来强调一下——**自定义消息不只是"翻译给 LLM 用的中间格式"那么简单，它本身带来了三个独立的能力**：

**1. UI 专用渲染**。UI 根据 `role` 字段做分派——`bashExecution` 用终端样式渲染、`compactionSummary` 用摘要卡片渲染，命令、输出、退出码各占一行，互不干扰。如果没有自定义消息，UI 只能拿到一段扁平文本，所有渲染花样都得退回到"全是大段文字"。

**2. 持久化恢复**。session 文件存的是完整的结构化数据。下次启动 Agent 时，UI 能精确还原上次的渲染状态——退出码仍然有颜色、命令仍然高亮、截断标识仍然在。如果只存翻译后的扁平文本，这些信息重启后就永久丢失了。

**3. 精细化可见性控制**。因为自定义消息有自己的 `role`，可以在 `convertToLlm` 翻译时做特殊处理——比如给它加一个 `excludeFromContext = true` 字段，LLM 就完全看不到这条消息，但 UI 照常渲染。**标准消息做不到这一点**——一旦进了 `messages` 数组，convertToLlm 就一定会翻译它发给 LLM，没有"对 UI 可见但对 LLM 不可见"的余地。

所以后面 §五 讲到 `convertToLlm` 翻译、§八 讲到 `excludeFromContext` 过滤时，请记住：**这两件事不是自定义消息带来的"麻烦"，恰恰相反——它们是自定义消息赋予的能力**。翻译是为了让 LLM 看到扁平版本，过滤是为了让某些消息对 LLM 隐身。没有自定义消息，这两件事都做不了。

但这里有个根本性的问题：**Message 联合类型是封闭的——只有 SystemMessage、UserMessage、AssistantMessage、ToolResultMessage 四种。** 这 4 种自定义消息不属于 Message 类型。那它们怎么被 Agent 系统接受并处理的？

---

## 四、第二层：AgentMessage —— 内富外严的双层设计

这就是 Pi 消息系统的核心设计：**不用一种格式打天下，而是用两层——内层丰富、外层严格。**

![两层消息——内富外严的双层设计](assets/260702-ch06-two-layer-messages.svg)

**配图说明**：顶部 AgentMessage 联合类型一分为二——左支 Message（4 种标准：system / user / assistant / toolResult）、右支 CustomAgentMessages（4 种扩展）。中间红色虚线是 convertToLlm() 翻译边界。底部 LLM 只看到 4 种标准消息，自定义消息要么被过滤、要么被翻译成 UserMessage。

### AgentMessage 联合类型

在 `packages/agent/src/types.ts` 里，`AgentMessage` 有一行关键定义：

```typescript
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

翻译成人话：**AgentMessage = LLM 标准消息 + 自定义消息。** 它是 Message（四种标准格式）和 CustomAgentMessages（自定义扩展）的联合类型。

用一张图看最清楚：

```
AgentMessage（Agent 内部使用的消息格式）
│
├── Message（可直接发送给 LLM 的标准消息）
│   │
│   ├── SystemMessage        ← role: "system"
│   ├── UserMessage          ← role: "user"
│   ├── AssistantMessage     ← role: "assistant"
│   └── ToolResultMessage    ← role: "toolResult"
│
└── CustomAgentMessages（仅 Agent 内部使用的扩展消息）
    │
    ├── BashExecutionMessage      ← role: "bashExecution"
    ├── CustomMessage             ← role: "custom"
    ├── BranchSummaryMessage      ← role: "branchSummary"
    └── CompactionSummaryMessage  ← role: "compactionSummary"
```

Agent 内部的 `context.messages` 数组里放的是 `AgentMessage[]`——它可以混合存放标准和自定义消息。一条消息到底是标准还是自定义的，看 `role` 字段就能判断。

### CustomAgentMessages：默认为空的扩展点

关键在 `CustomAgentMessages` 这个接口：

```typescript
export interface CustomAgentMessages {
    // Empty by default - apps extend via declaration merging
    // 默认为空 - 应用通过声明合并扩展
}
```

注意：**这个接口在核心包（pi-agent-core）里是空的。** 核心包完全不知道有什么 BashExecutionMessage、CompactionSummaryMessage 这些东西。它只提供了一个"插槽"，让应用层往里插。

### 声明合并：类型安全的扩展魔法

应用层怎么"插"？靠 TypeScript 的**声明合并**（Declaration Merging）。coding-agent 通过 `declare module` 语法把自己的 4 种消息类型"注入"进去：

```typescript
declare module "@earendil-works/pi-agent-core" {
    interface CustomAgentMessages {
        bashExecution: BashExecutionMessage;
        custom: CustomMessage;
        branchSummary: BranchSummaryMessage;
        compactionSummary: CompactionSummaryMessage;
    }
}
```

这段代码的效果是：**编译器自动把这 4 种类型加入 AgentMessage 联合类型。** 以后在 coding-agent 项目里，`AgentMessage` 就变成了 **8 种消息的联合（4 种标准 + 4 种自定义）**，TypeScript 会帮你做完整的类型检查。

**为什么不直接用继承或者泛型？** 因为继承需要修改基类——你改不了 `pi-agent-core` 包。泛型需要到处传参数——每个用到 `AgentMessage` 的函数签名都要加泛型参数。声明合并的好处是：**核心包完全不知道扩展的存在（零依赖），扩展包却能获得完整的类型安全。**

不同的应用可以有不同的自定义消息。比如 Web UI 就注册了自己的消息类型（`user-with-attachments`、`artifact`）（待核实：本仓库内找不到对应注册点）。**每个应用只看到自己需要的消息类型。**

---

## 五、转换边界：convertToLlm —— 一切自定义消息终将变成 User

现在我们知道 Agent 内部用 8 种消息类型自由表达。但每次调用 LLM 时，LLM 只接受 4 种标准格式。怎么办？

**答案是：在调用 LLM 之前的最后一刻，做一次翻译。** 这个翻译器就是 `convertToLlm` 函数。

### 翻译发生在什么时候？

在 `streamAssistantResponse` 函数里（第 3 章讲过的"调用模型"那一步，位于 `packages/agent/src/agent-loop.ts`），翻译发生的时机非常精确：

```
每次 LLM 调用前的消息处理管道：

context.messages: AgentMessage[]        ← Agent 内部的消息（最多 8 种类型）
        │
        ▼
[1] transformContext (可选)             ← AgentMessage[] → AgentMessage[]
        │                                  裁剪旧消息、注入外部上下文
        ▼
[2] convertToLlm (必须)                 ← AgentMessage[] → Message[]
        │                                  自定义消息翻译成标准格式
        ▼
[3] normalizeContext (必须)             ← { messages } → TranscriptContext
        │                                  此处只打 brand（未传 systemPrompt/tools，
        │                                  故不折叠；折叠只发生在公开入口）
        ▼
llmContext: TranscriptContext           ← provider 唯一接受的输入
        │                                  messages 里是 4 种标准消息
        ▼
streamFunction(model, llmContext, ...)  ← 调用 LLM（第4章讲过）
```

注意顺序：**先 transformContext（同层变换），再 convertToLlm（跨层翻译），最后 normalizeContext（规范化 + 加 brand）。** 前两步为什么分开，后面会讲；第三步是 0.86.0 才补上的。这里要澄清一点：agent 循环调用的是 `normalizeContext({ messages: llmMessages })`，并没有传 `systemPrompt` / `tools`——提示词和工具声明早在 `declareToolChanges()`（见 §七）里就以 system 消息写进了 transcript，所以这一步在该调用点只负责打 brand；真正的"折叠"发生在公开入口（`Models.stream()` 等入口仍收到携带 `systemPrompt` / `tools` 的 `Context` 时）。

### 转换规则：所有自定义消息都变成 User

coding-agent 层的 `convertToLlm` 核心逻辑是一个 switch 语句，按 `role` 字段分派处理：

| role | 怎么处理 |
|------|---------|
| `"system"` | 直接透传（0.86.0 新增此分支） |
| `"user"` | 直接透传，不做任何修改 |
| `"assistant"` | 直接透传 |
| `"toolResult"` | 直接透传 |
| `"bashExecution"` | `excludeFromContext=true` → 过滤掉；否则 → 转换成 UserMessage |
| `"custom"` | 转换成 UserMessage |
| `"branchSummary"` | 转换成 UserMessage（加 XML 标签包裹） |
| `"compactionSummary"` | 转换成 UserMessage（加 XML 标签包裹） |

关键洞察：**所有自定义消息都被转换成了 `user` 角色的消息；四种标准消息（含 0.86.0 新增的 `system`）则原样透传。**

为什么都变成 `user`？因为 LLM API 对角色顺序有严格要求——对话格式是 `user → assistant → user → ...` 交替的，不能连续出现两个 `assistant`。自定义消息本质上是"系统注入的信息"（Bash 执行结果、压缩摘要、分支摘要），放在 `user` 角色中最安全。**代价是可能产生连续 user**：一条自定义消息紧跟在 user 消息之后（0.87.0 的追加式上下文编辑 / 会话投影、多次 submit 未产生 assistant 也会造成这种情况）时，转换结果就是两条相邻 user。`convertToLlm` 不合并相邻 user——Pi 只在 provider 转换层合并连续 `toolResult`。

### 别搞混：两层各有一个 convertToLlm

`convertToLlm` 这个名字在源码里出现了两次，分属两个不同的层，理解本章时必须分清——旧版教程在这一点上容易含糊，这里专门澄清：

- **agent 层的默认实现 `defaultConvertToLlm`（`packages/agent/src/agent.ts`）**：它只做一件事——把四种标准 role（`system` / `user` / `assistant` / `toolResult`）过滤出来，其余的一律丢掉。核心包不知道有任何自定义消息，所以这个默认实现在自定义消息面前会"失忆"。
- **coding-agent 层覆写的 `convertToLlm`（`packages/coding-agent/src/core/messages.ts`）**：这才是前面那张转换规则表的来源。它认得 4 种自定义消息，把它们翻译成 `UserMessage`，同时让四种标准消息原样透传（其中 `case "system"` 是 0.86.0 新增的直接透传分支）。

换句话说：**核心包给的是"标准消息过滤器"，应用层把它换成了"自定义消息翻译器"。** 这正是 §四 讲的声明合并的落地方式——核心包零依赖，应用层全权负责翻译。（1.0.0 起 agent 包已删除实验 harness，不再存在 harness 版的 `messages.ts` 副本。）

### 最后一步：normalizeContext 与 TranscriptContext

翻译产出的还只是裸的 `Message[]`，不能直接交给 provider。0.86.0 起，所有 provider 函数的入参类型是 **`TranscriptContext`**——一个带 brand 的类型，**只有 `normalizeContext()` 能产出它**，这样"手写的 `Context` 不可能绕过规范化直接喂给 provider"。

`normalizeContext(context)` 的折叠规则很短：

```typescript
// packages/ai/src/utils/transcript.ts
export function normalizeContext(context: Context): TranscriptContext {
    const initialMessage = createInitialSystemMessage(context.systemPrompt, context.tools);
    const messages = initialMessage ? [initialMessage, ...context.messages] : context.messages;
    return { messages } as TranscriptContext;
}
```

翻译成人话：**如果调用方用 `Context.systemPrompt` / `Context.tools` 这两个"请求级简写"传了系统提示词和工具集，`normalizeContext` 就把它们折成一条打头的 `SystemMessage`，插到 `messages` 数组最前面**；两者都为空时保持 transcript 原样。折叠完，系统提示词和工具声明就彻底变成了 transcript 里的一条消息——从此"当前系统提示词"不再是某个变量，而是 transcript 的一个可回放属性（§七 展开）。

> **小结**：旧版里系统提示词和工具是"挂在请求上下文旁边的两个字段"；0.86.0 起它们被"收编"进 transcript，`Context.systemPrompt` / `Context.tools` 退化为可选的简写入参，`normalizeContext` 负责在边界处把它们折成 `SystemMessage`。

### 具体例子：BashExecutionMessage 的转换

回到开头的场景。一条 `BashExecutionMessage` 从创建到被 LLM 看到，数据结构发生了这样的变化：

**Before —— BashExecutionMessage（Agent 内部格式）：**

```typescript
{
    role: "bashExecution",
    command: "ls -la",
    output: "total 32\ndrwxr-xr-x  5 user  staff  160 May 30 10:00 .\n...",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 1748568000000
}
```

**After —— UserMessage（LLM 看到的格式）：**

```typescript
{
    role: "user",
    content: [{
        type: "text",
        text: "Ran `ls -la`\n```\ntotal 32\ndrwxr-xr-x  5 user  staff  160 May 30 10:00 .\n...\n```"
    }],
    timestamp: 1748568000000
}
```

变化总结：
- `role`：`"bashExecution"` → `"user"`
- `command`、`output`、`exitCode` 等结构化字段 → 被格式化成一段文本
- 丢失的信息：`cancelled`、`truncated` 等布尔标志被融合进文本描述里，不再是独立字段

其他自定义消息（CompactionSummary、BranchSummary）的转换模式完全一样——把摘要文本用 `<summary>` 标签包裹，前面加一句说明，变成 UserMessage 的 content。

---

## 六、两阶段管道：为什么 transformContext 和 convertToLlm 分开？

![消息处理管道](assets/260702-ch06-message-pipeline.svg)

**配图说明**：横向数据流——AgentMessage[8] → transformContext（同层变换，类型不变）→ convertToLlm（跨层翻译）→ Message[4] → normalizeContext（折成 TranscriptContext 并加 brand）→ 发给 LLM。下方标注 excludeFromContext 过滤分支。

回到管道图，有一个设计细节值得追问：**为什么分两步，而不是一步到位？**

答案是**职责分离**：

- **transformContext** 处理的是 **AgentMessage 级别的操作**：裁剪太旧的消息、注入外部上下文、触发压缩算法。它处理前后都是 `AgentMessage[]`，类型不变。
- **convertToLlm** 处理的是 **跨类型翻译**：把 AgentMessage 翻译成 Message。处理前是 `AgentMessage[]`，处理后是 `Message[]`，类型变了。

（0.86.0 新增的第三步 `normalizeContext` 不参与"变换"，它只负责规范化 + 打 brand，把 `{ messages }` 包装成 provider 唯一接受的 `TranscriptContext`。它和前两步不是替代关系，而是"翻译完之后的收尾"。）

分开的好处是：**你可以只替换其中一个，互不影响。**

- 换了**上下文管理策略**（比如从"删最旧消息"改成"压缩成摘要"），只需要改 `transformContext`——它处理"如何裁剪"的策略。`convertToLlm` 不需要动。
- 换了**应用类型**（比如把 coding-agent 改造成一个 Web 客服 Agent，自定义消息从 `BashExecution`/`CompactionSummary` 变成 `TicketEvent`/`OrderNote` 这类业务消息），只需要改 `convertToLlm`——它处理"如何把自定义消息翻译成 UserMessage"。`transformContext` 不需要动。

这里有一个容易混淆的点要强调：**换了 LLM 提供商（比如从 Claude 换成 GPT），convertToLlm 不需要动**。为什么？因为 `convertToLlm` 的输出是统一的 `Message[]`（4 种标准消息），它已经把"自定义消息 → 标准消息"这件事做完了。再往下，**把 Message 翻译成各家 Provider 的私有格式**是 pi-ai 层（第 4 章讲过）的工作——那一层有自己的翻译器（anthropic-messages、openai-completions 等），跟 convertToLlm 是完全独立的两层。换句话说：**Pi 把"消息类型翻译"和"Provider 协议翻译"放在了两层不同的抽象里，互不干扰**。

---

## 七、系统消息：提示词与工具声明搬进了 transcript（0.86.0 新增）

§二 提到 `SystemMessage` 是 `Message` 的第四种成员，§五 又看到 `normalizeContext` 把系统提示词和工具声明折成了首条 system 消息。这一节专门回答两个问题：**这个搬家为什么发生？搬完之后，怎么读回"当前系统提示词"和"当前工具集"？**

### 从"两个请求参数"到"一条消息"

旧版调用模型时，上下文长这样：`{ systemPrompt, tools, messages }`——提示词和工具是挂在 `messages` 旁边、每次请求随请求走的两个独立参数。

0.86.0 起，provider 只接受 `TranscriptContext`，而 `TranscriptContext` 里**只有 `messages`**。提示词和工具到哪去了？被 `normalizeContext` 折成了一条打头的 `SystemMessage`：提示词进 `content`，工具集进 `toolsAdded`，和普通消息一起躺在 transcript 里。

这个搬家带来两个好处：

- **单一事实源**：一次会话的"系统提示词"不再是一个会漂移的变量，而是 transcript 的一个**可回放属性**——想知道当前是什么，把 system 消息重放一遍即可。
- **可中途演进**：系统提示词和工具集能随对话改变（扩展动态加载工具、注入一段新指令），不必中途重开会话。

### transcript 里的 system 消息是"增量补丁"

关键点：`SystemMessage` 不只是"开场白"。当它出现在对话中途，它是一条**状态变更日志**，四个字段各有分工：

| 字段 | 中途语义 |
|------|---------|
| `content` | 把这段文本**追加**到基础提示词之后（从这一刻起生效） |
| `sections` | 按名字**替换**命名片段；值为 `null` 表示**删除**该片段 |
| `toolsAdded` | 从这一刻起**新增/替换**这些工具的完整定义 |
| `toolsRemoved` | 从这一刻起这些工具**不再可用** |

举个场景：某个扩展在会话进行到一半时加载了一个新工具 `deploy`，同时往提示词里加了一段 `<deploy-policy>...</deploy-policy>` 说明。它不需要改整条提示词，只要往 transcript 追加一条 `{ role: "system", content: "...", sections: { "deploy-policy": "..." }, toolsAdded: [deploy] }` 就够了。

### 回放语义：getCurrentSystemPrompt / getCurrentTools

既然 system 消息是可加法的日志，"当前态"就是把日志从头重放一遍的结果。`packages/ai/src/utils/transcript.ts` 提供了这组回放函数：

- **`getCurrentTools(messages)`**：依次应用每条 system 消息的 `toolsRemoved`（删除）和 `toolsAdded`（写入），得到**当前可用工具集**。先删后加，所以"改定义"等价于"删掉旧的、加进新的"。
- **`getCurrentSystemMessage(messages)`**：把全部 system 消息折叠成**一条代表当前态的消息**——`content` 依次追加、`sections` 按名字增删（`null` 删除）、工具集用 `getCurrentTools` 算出。
- **`getCurrentSystemPrompt(messages)`**：把上一条渲染成**纯文本**——`content` 加上各 `sections` 的值，即"当前系统提示词"。
- **`collapseSystemMessages` / `resolveTranscript`**：给**不支持对话中途 system 消息**的模型准备的兜底——把中途的 system 消息全部回放、压成一条打头的 system 消息，其余丢掉。provider 能力由模型 compat 设置里的 `supportsMidConvoSystemMessages`（由生成的模型目录为已验证模型开启）等开关决定。

这几行代码意义很大：**"当前系统提示词"和"当前工具集"都是派生量，不是存储量。** 会话持久化时只需存 transcript，重启后回放即可精确还原——不需要额外存一份"当前提示词快照"。

### 工具集变更怎么向模型播报

系统提示词变了、工具集变了，模型怎么知道？答案是**在下一次请求前自动产生一条 system 补丁**。这段逻辑在 `packages/agent/src/agent-loop.ts` 的 `declareToolChanges()`：

- `context.tools` 是**运行时能执行的工具**；
- transcript 里 system 消息声明的，是**模型允许调用的工具**；
- 每次请求前比较这两者的差集，把新增/删除写成 `toolsAdded` / `toolsRemoved`，落在一条 system 消息上。

所以"Agent 运行时悄悄换了一套工具、模型却以为还能调旧工具"这种脱节不会发生——**差异会被显式播报给模型**。至于这条 system 消息是"就地发送"还是"回放折进开头"，取决于模型是否支持中途 system 消息（见上面的 `resolveTranscript`）。

> **一句话**：0.86.0 把系统提示词和工具声明从"请求级参数"收编成了"transcript 里的可回放日志"——存储更简单（只存 transcript）、演进更自然（中途打补丁）、来源更唯一（回放即当前态）。

---

## 八、过滤机制：有些消息 LLM 不该看

到目前为止，所有自定义消息最终都变成了 UserMessage 被 LLM 看到。但有些情况下，消息应该只给 UI 看、不给 LLM 看。

### excludeFromContext：一个布尔字段的过滤力

Pi 的 Bash 工具有个功能：当你用 `!!` 前缀执行命令时（比如 `!!secret_cmd`），这条命令的执行结果对 LLM 不可见。

实现方式非常简单——BashExecutionMessage 有一个 `excludeFromContext` 字段。在 convertToLlm 里，检查这个字段：

```typescript
case "bashExecution":
    if (m.excludeFromContext) {
        return undefined;   // 直接返回 undefined，后续被 filter 掉
    }
    // ... 否则正常转换
```

注意：`excludeFromContext = true` 的消息**仍然存在于 `context.messages` 中**。UI 仍然可以看到它、渲染它。只是在调用 LLM 的那一刻，这条消息被"隐身"了。

这就是"UI 能看、LLM 不能看"的机制——一个布尔字段，在翻译边界做过滤，数据本身不需要删除。

### 三种消息可见性级别

综合以上分析，Pi 的消息系统其实有三种可见性级别：

| 可见性级别 | LLM 是否看到 | UI 是否看到 | 实现方式 | 典型消息 |
|-----------|------------|------------|---------|---------|
| 全可见 | 是 | 是 | convertToLlm 正常转换/透传 | 四种标准消息、普通的 BashExecution |
| LLM 不可见 | 否 | 是 | `excludeFromContext = true` | `!!` 前缀的 Bash 执行 |
| 仅持久化 | 否 | 否 | UI 渲染时跳过，convertToLlm 也过滤掉 | Web UI 的 ArtifactMessage |

这里要特别点一句：**标准消息里的 `SystemMessage` 是 LLM 可见的第四类**。它不是"只给 UI 看的幕后台词"，而是经 `convertToLlm` 原样透传、实打实参与模型上下文的——§七 讲的提示词与工具声明，就是靠它送进模型的。

---

## 九、完整数据流：从用户操作到 LLM 看到的消息

把全章内容串起来，一条消息从诞生到被 LLM 看到的完整路径：

```
用户在终端输入 !ls -la
        │
        ▼
[1] 创建消息
    BashExecutionMessage { role: "bashExecution", command: "ls -la", output: "...", ... }
        │
        ▼
[2] 存入 context.messages: AgentMessage[]
    [...原有消息, 新的 BashExecutionMessage]
        │
        ▼
[3] Agent Loop 准备调用 LLM（第3章讲过的内层循环）
    declareToolChanges：比对运行时工具集与 transcript 声明，差异写成 system 补丁
        │
        ▼
[4] transformContext（可选）
    输入/输出都是 AgentMessage[]
    裁剪、注入、压缩（第8章详讲 transformContext、第9章详讲 Compaction）
        │
        ▼
[5] convertToLlm（必须）
    AgentMessage[] → Message[]
    BashExecutionMessage → UserMessage
    system/user/assistant/toolResult → 原样透传
    excludeFromContext → 过滤掉
        │
        ▼
[6] normalizeContext（必须，0.86.0 新增）
    { messages } → TranscriptContext（打上 brand；此处不传 systemPrompt/tools）
        │
        ▼
[7] LLM 收到
    llmContext.messages = [
        { role: "system", content: "你是 Pi……", toolsAdded: [...] },  ← 打头的系统消息
        ...之前的消息,
        { role: "user", content: "Ran `ls -la`\n```\n...\n```" }
    ]
        │
        ▼
[8] LLM 回复
    → 产生新的 AssistantMessage
    → 可能触发工具调用 → ToolResultMessage（第5章的五步管道）
    → 回到 [2]，继续循环
```

**核心规律**：Agent 内部用 8 种消息类型自由表达，但到了 LLM 边界，所有自定义消息都被翻译回 4 种标准格式。这个"内富外严"的设计让 Agent 拥有无限扩展能力，同时永远不破坏 LLM 兼容性。

---

## 十、总结

### 一条主线：数据结构要同时照顾两个读者

回看整章，Pi 的消息系统所有设计都围绕一个朴素的思想——**在设计数据结构时，要同时考虑模型要用的、和功能层面要用的，然后根据需求自定义、用合理的架构把两者组合起来**。

具体到消息系统，这两个"读者"的需求是分裂的：

- **模型这边**只要四种标准消息（System/User/Assistant/ToolResult）——这是 LLM API 协议强制的，不能改
- **功能这边**（UI、持久化、可见性控制）需要丰富的结构化字段——每多一种字段就多一种能力

如果只为模型设计，结构化字段全丢，功能层退化；如果只为功能设计，模型看不懂，对话就断了。Pi 的方案是**两层各管各的**：

| 层 | 关心谁 | 数据形式 | 怎么实现 |
|----|--------|---------|---------|
| **AgentMessage（内层）** | 功能层 | 8 种消息（4 标准 + 4 自定义），字段丰富 | 用联合类型 + 声明合并，让核心包零依赖、应用层全栈类型安全 |
| **Message（外层）** | 模型 | 4 种标准消息，字段精简 | 在 LLM 调用边界做一次 `convertToLlm` 翻译 + `normalizeContext` 规范化，**有损、单向、最后一刻发生** |

这一章的所有具体设计——三层类型递进（Tool → AgentTool → ToolDefinition）、声明合并扩展点、transformContext / convertToLlm / normalizeContext 三段管道、excludeFromContext 可见性控制、系统消息的可回放演进——都是这条主线的具体实现。**主线是"两个读者，两层架构"，实现手段可以千变万化。**

### 把这条主线用到自己的项目里

下次你设计一个对接外部协议的系统（不只是 Agent，可以是任何"对外有协议约束、对内有丰富需求"的场景），可以套用这三步：

**第一步：识别"两个读者"分别要什么。** 协议规定什么（不能改的部分）？功能层需要什么（可以自定义的部分）？把它们列出来，明确各自的需求。

**第二步：以内层结构化为"源"，外层翻译为"流"。** 存储和功能层用原始的、结构化的数据（不丢字段、不拍扁）；到协议边界再做一次有损翻译。**不要为了协议方便而提前拍扁数据**——一旦拍扁，UI 和持久化就再也拿不回结构。

**第三步：用类型系统的扩展点做"核心 + 应用"分层。** 核心包定义协议接口（封闭）、留一个空的扩展插槽；应用包通过声明合并注入自己的具体类型。这样核心包零依赖，应用包全栈类型安全——不需要继承，不需要泛型参数污染。

> 本章讲到的「Tool → AgentTool → ToolDefinition」三层递进（第 5 章）也是同样的思想：每一层只加自己这个层级需要的能力，不越界。识别"分层点"、给每层划清职责边界，是这种设计法的核心。

---

## 十一、下一站

前六章到此结束——你已经建立了对 Pi-Agent 核心机制的完整理解。

> **建议**：在进入进阶章节之前，建议回顾前六章的核心机制（消息系统、工具调用、扩展机制、Agent Loop 等），确认你把各章的知识点串起来了。

从第 7 章开始进入进阶章节。回看前五章，有一个东西反复出现但我们始终没深入：**事件**。第 3 章说"Agent Loop 每做一步都发事件让 UI 实时更新"，第 5 章说"工具执行时发出 `tool_execution_start`、`tool_execution_update`、`tool_execution_end` 事件"。这些事件是怎么从 Agent 内部传到外部的？UI 怎么订阅这些事件？为什么 Agent 发完事件后要"同步等待"监听器处理完？

下一章，我们打开 Agent 的"神经系统"——事件驱动架构。

---

> **本章关键源码索引**（以「符号名 + 文件路径」引用，不标行号；需精确定位时用编辑器搜索符号名）：
> - `Message` / `SystemMessage` / `UserMessage` / `AssistantMessage` / `ToolResultMessage` / `StopReason` / `ToolCall` / `JsonValue` / `JsonRepresentation` / `TranscriptContext` / `Context` — `packages/ai/src/types.ts`
> - `NestedToolCalls` / `NestedToolCallRecord`（`ToolResultMessage.nestedCalls` 的载荷）— `packages/ai/src/types.ts`
> - `normalizeContext` / `createInitialSystemMessage` / `getCurrentSystemMessage` / `getCurrentSystemPrompt` / `getCurrentTools` / `collapseSystemMessages` / `resolveTranscript` — `packages/ai/src/utils/transcript.ts`
> - `contentText` / `getSystemMessageText` — `packages/ai/src/utils/text.ts`
> - `CustomAgentMessages` / `AgentMessage` / `AgentLoopConfig.convertToLlm` — `packages/agent/src/types.ts`
> - `defaultConvertToLlm`（agent 层默认实现，仅过滤四种标准 role）— `packages/agent/src/agent.ts`
> - `streamAssistantResponse` / `declareToolChanges`（转换管道：transformContext → convertToLlm → normalizeContext）— `packages/agent/src/agent-loop.ts`
> - `convertToLlm`（coding-agent 层覆写，含 `case "system"` 透传）/ `BashExecutionMessage.excludeFromContext` / 声明合并 — `packages/coding-agent/src/core/messages.ts`
