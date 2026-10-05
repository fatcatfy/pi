# 第5章：工具系统 —— Agent 的手脚是怎么被管住的（修订版 v2）

> **修订说明**：本文件是《第5章-工具系统-Agent的手脚是怎么被管住的.md》的勘误修订版，原文件未改动。核对 1.0.3 源码后修正了以下问题（A 类为会误导核心机制的更正，B 类为名称/路径/数量，C 类为细节）。原文档已经写过 0.99 的 codemode、exposure、嵌套调用（它自称"对照 0.99.1"），本版主要补 0.99.2–1.0.3 的差异：
>
> **A 类：会误导读者形成错误心智模型（必须改）**
> 1. **MCP 工具在核心层的 exposure 是 `deferred`，不是 `codemode`**。原文 §二、§九 称 MCP 扩展"默认把所有工具注册成 `codemode` 暴露"。MCP 的**配置级** `exposure: "codemode"`（默认）在注册时经 `toToolExposure()` 映射为核心 `ToolExposure = "deferred"`（`packages/coding-agent/src/extensions/mcp/tools.ts`）。核心 `codemode` 与 `deferred` 都不声明给模型，唯一区别是"codemode 描述里列不列它"（`ToolExposure` 注释，`packages/coding-agent/src/core/extensions/types.ts`）。
> 2. **`tool_search` 不再靠 `prepareLoadout` 列出可搜到的命名空间**。原文 §二 称 `tool_search`"靠 `prepareLoadout` 在描述里列出当前可搜到哪些命名空间"。实际它没有 `prepareLoadout`，描述是固定的 `TOOL_SEARCH_DESCRIPTION`，刻意不列任何工具或命名空间（`packages/coding-agent/src/extensions/tool-search/tool.ts`）。它用 `Bm25Ranker` 搜 `codemode`/`deferred` 暴露且未激活的工具，命中后 `setActiveTools()` 加载。
> 3. **MCP 服务器后台连接、默认工具不进 codemode 描述**（0.99.2 起，1.0.3 沿用；原文未提）。MCP 在会话启动时后台连接所有启用的服务器；首个 prompt 最多等 10 秒，且只等带 `direct` 工具的服务器。默认（配置 `codemode`）的工具既不在模型声明里，也不在 codemode 描述里——脚本用 `searchTools()` / `describeTool()` / `describeNamespace()` / `ALL_TOOLS` 现查。证据 `docs/mcp.md`、`extensions/mcp/index.ts`。
>
> **B 类：名称/路径/数量与当前源码不符**
> 4. **声明 `constrainedSampling` 的内置工具是 5 个**（`read` / `bash` / `powershell` / `edit` / `write`），不是原文 §一 说的 read/edit/bash 三个。证据 `test/builtin-tool-strict-mode.test.ts`、`core/tools/{read,bash,powershell,edit,write}.ts`。
> 5. **codemode 的能力远不止"用 `tools.*` 调工具"**。原文 §九 只写了一句。1.0.x 的 codemode 脚本还有 `models.*`（分类器 / 图像模型）、`store()`/`load()`、`searchTools()`/`describeTool()`/`describeNamespace()`/`ALL_TOOLS`、`text()`/`image()`/`console`/`exit()`/`return`、首行 `// @options: {...}`；受 `codemode.mode` 与 `codemode.inlineBudget` 设置控制。证据 `docs/codemode.md`、`extensions/codemode/tool.ts`。
> 6. **codemode 沙箱在独立包 `packages/codemode`**（`@earendil-works/pi-codemode`）。它是 QuickJS(WASM) 沙箱，导出 `CodemodeSandbox`、`parseCodemodeSource`、`CODEMODE_SOURCE_GRAMMAR`、`loadQuickJSWasm`、`renderDeclarations` 等；coding-agent 侧经 `extensions/codemode/worker.ts` + `execute.ts` 集成。原文 §四/§九 未指明实现包。
>
> **C 类：细节**
> 7. 原文 §十（方法论）称框架兜底用 `String(error)`，实际是 `error instanceof Error ? error.message : String(error)`（`packages/agent/src/agent-loop.ts`；§六 的代码示例本就写对了，仅 §十 的行文需更正）。
> 8. 原文 §十一 索引"对照 0.99.1"已过期，本版对照 **1.0.3**；下列大机制（exposure 模型、codemode、嵌套调用、MCP）在 1.0.3 仍成立。
>
> **经核实仍正确（未改）**：三层类型（`Tool` / `AgentTool` / `ToolDefinition`）、五步管道与 `prepareToolCall` / `executePreparedToolCall` / `finalizeExecutedToolCall` / `createErrorToolResult`、`runToolCall`（嵌套调用入口）、`NestedToolCallRunner` / `NESTED_CALL_LIMITS`、并行三阶段与"一票否决"、Operations 抽象（含 PowerShell 与 Bash 共用 `createLocalShellOperations`）、`truncate.ts` / `output-accumulator.ts`、`builtInExtensions` 与 `builtin:<name>` / `replaceable` 语义。本版逐条回源码复核，无「待核实」项。

第 3 章讲 Agent Loop 时，我们追踪了"模型决定调用 read 工具"到"工具结果回到模型面前"这段旅程。但当时把它当黑盒跳过了——只说了"Loop 执行工具"，没说具体怎么执行的。

这一章就来打开这个黑盒。

当模型的回复里出现了这样一条指令：

```json
{ "type": "toolCall", "id": "call_abc123", "name": "read", "arguments": { "path": "src/main.ts" } }
```

从这条指令到文件内容回到模型面前，中间经历了什么？

你的第一反应可能是：找到 read 工具，读文件，把内容塞进消息，完事。但现实中没这么简单——模型可能传了错误类型的参数（`path: 12345` 而不是 `"src/main.ts"`），模型可能要求执行危险命令（`rm -rf /`），工具执行时可能抛异常（文件不存在）。

Pi 用一条**五步管道**来解决这些问题：参数预处理 → Schema 验证 → 权限拦截 → 工具执行 → 结果后处理。每一步都有明确的职责，每一步的错误都不会"炸掉"整个循环。

但在讲管道之前，得先搞清楚一个更基础的问题：**工具到底是怎么定义的？** 为什么 Pi 要设计三层类型来描述"一个工具"？

---

## 一、三层类型：为什么"一个工具"要分三层来定义？

### 第一层：Tool——一张"名片"

打开 `packages/ai/src/types.ts`，你会看到工具的最底层定义：

```typescript
// packages/ai/src/types.ts —— Tool
export interface Tool<TParameters extends TSchema = TSchema> {
    name: string;            // 工具名，如 "read"、"bash"
    description: string;     // 给 LLM 看的工具描述
    parameters: TParameters; // 参数的 JSON Schema（用 TypeBox 定义）
    constrainedSampling?: false | ConstrainedSamplingConfig; // 0.99 起：可选的 provider 侧约束采样
}
```

三个基础字段加一个可选的 `constrainedSampling`（0.99 起新增）。工具就是一个有名字、有描述、有参数 Schema 的东西。

这个接口住在 `pi-ai` 层——纯模型适配层。它唯一关心的事情是：**怎么把工具的信息告诉模型。** `name` 和 `description` 会出现在发给模型的 API 请求里，`parameters` 告诉模型"你可以传哪些参数"。

`constrainedSampling` 是 0.99 起给模型适配层加的一个"提示"：它让支持该能力的 API 用 JSON Schema 或语法（grammar）去**约束模型生成参数的格式**。内置的 5 个工具（read / bash / powershell / edit / write）都声明了 `{ type: "json_schema", strict: "prefer" }`（见 `packages/coding-agent/test/builtin-tool-strict-mode.test.ts`），意思是"如果这个模型支持，就尽量按 Schema 生成参数，别给我产出格式不对的 JSON"。注意它只是"偏好"，不是硬保证——所以后面 §三 的 Schema 验证依然不能省。

在这个层面，工具只是**一张名片**。能描述自己，但不能执行任何操作。

### 第二层：AgentTool——加上了"执行能力"

Agent Loop 要执行工具调用，光有名片不够。它需要知道**怎么执行**这个工具、这个工具**能不能并行执行**、参数格式要不要**预处理**。

于是 `pi-agent-core` 层在 Tool 基础上扩展了 `AgentTool`：

```typescript
// packages/agent/src/types.ts —— AgentTool
export interface AgentTool<TParameters, TDetails>
    extends Tool<TParameters>          // 继承 Tool 的四个字段
{
    label: string;                     // 给人看的标签（不同于给 LLM 的 description）
    prepareArguments?: (args: unknown) => Static<TParameters>;  // 兼容性垫片
    outputSchema?: TSchema;            // 0.99 起：声明 structuredContent 的结构（见 §八）
    execute: (                         // 执行函数
        toolCallId: string,
        params: Static<TParameters>,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<TDetails>,
    ) => Promise<AgentToolResult<TDetails>>;
    replay?: "never" | "safe";         // 0.99 起：结果未知时的恢复策略
    executionMode?: ToolExecutionMode; // "sequential" | "parallel"
}
```

从 Tool 到 AgentTool，新增的字段每个都有明确用途：

- **`label`**：模型看到的是 `name`（"read"），UI 看到的是 `label`（"读取文件"）
- **`prepareArguments`**：兼容层，处理不同模型输出的参数怪癖（后面详讲）
- **`outputSchema`**（0.99 起）：声明"成功结果里的 `structuredContent` 长什么样"，给程序化调用者（如 codemode 脚本）用
- **`execute`**：真正干活的函数——模型说"读文件"，这个函数去读
- **`replay`**（0.99 起）：当工具产生了副作用、但结果未知（比如进程被中断）时的恢复策略，`"safe"` 表示可以安全重放
- **`executionMode`**：标记这个工具能否和其他工具并行执行

`execute` 返回的 `AgentToolResult` 在 0.99 也扩了：除了 `content`（给模型看）和 `details`（给 UI 看的元数据，现在是**必需**字段），新增了 `structuredContent?`（给程序化调用者）、`usage?`（工具自身的 token 用量），以及 `isError?: boolean`——**工具可以直接 return 一个 `isError: true` 的结果来报告失败，而不必抛异常**。这一点是本章 §六 的重点。

### 第三层：ToolDefinition——产品层再加东西

到了 `pi-coding-agent` 层（产品运行层），工具还需要更多能力：自定义渲染（read 工具在终端里怎么显示？edit 工具怎么展示 diff？）、提示词注入（有些工具需要在系统提示词里加一段使用指南）。

于是出现了第三层 `ToolDefinition`（定义在 `packages/coding-agent/src/core/extensions/types.ts`）。它的 `execute` 函数比 `AgentTool` 多了一个参数——`ctx: ExtensionToolContext`，让工具执行时可以访问当前会话状态，甚至**调用别的工具**：

```
AgentTool.execute:     (toolCallId, params, signal, onUpdate) => ...
ToolDefinition.execute: (toolCallId, params, signal, onUpdate, ctx) => ...
                                                                   ^^^
                                     多了 ExtensionToolContext（会话上下文 + executeTool）
```

> **0.99 变更**：第 5 个参数从笼统的 `ExtensionContext` 收窄成了 `ExtensionToolContext`。后者在会话上下文之上多了 `tools`（可调用的工具列表）和 `executeTool(name, args, options)`——用它可以跑通和模型发起调用完全一样的管道（校验、钩子、权限）。这就是 §四 要讲的"嵌套工具调用"。

ToolDefinition 还新增了一大批 UI 与编排相关字段：`promptSnippet`（系统提示词片段）、`promptGuidelines`（提示词准则条目）、`renderCall` / `renderResult`（调用时与结果时的渲染）、`renderShell` 等。

**0.99 起**它又多了一组描述"这个工具该怎么被模型看见"的字段——`exposure`、`namespace`、`annotations`、`defaultActive`、`prepareLoadout`。这五个字段推翻了本章早期版本隐含的一个前提："注册了就会被模型看见"。它们值得单独用一节来讲，就是接下来的 §二。

### 桥接两层：wrapToolDefinition

Agent Loop 只认识 `AgentTool`，但产品层的工具都是 `ToolDefinition`。谁来把 ToolDefinition 变成 AgentTool？

答案是一个只有十几行的包装器函数：

```typescript
// packages/coding-agent/src/core/tools/tool-definition-wrapper.ts —— wrapToolDefinition
export function wrapToolDefinition(definition, ctxFactory?) {
    return {
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: definition.parameters,
        outputSchema: definition.outputSchema,           // 0.99 起透传
        constrainedSampling: definition.constrainedSampling,
        prepareArguments: definition.prepareArguments,
        executionMode: definition.executionMode,
        // 关键：重写 execute，缺失时用闭包里的 ctxFactory 补出 ExtensionToolContext
        execute: (toolCallId, params, signal, onUpdate, ctx?) =>
            definition.execute(
                toolCallId, params, signal, onUpdate,
                ctx ?? ctxFactory?.(toolCallId, signal),
            ),
    };
}
```

注意最后几行。AgentTool 的 `execute` 对外只声明 4 个参数，但 ToolDefinition 的需要 5 个。包装器做了两手准备：**要么运行时直接把 `ctx` 传进来（第 5 个参数），要么用 `ctxFactory` 现场造一个。** 而 `ctxFactory` 的签名也变了——0.99 起是 `(toolCallId, signal) => ExtensionToolContext`，能拿到这次调用的 id 和取消信号，构造出带 `executeTool` 的真实上下文。**Agent Loop 依然不知道这层上下文的存在**：它调 `execute` 时只传 4 个参数，由会话运行时（在需要时）补上第 5 个。

### 为什么非要分三层？

把所有字段塞进一个 `Tool` 接口，加几个可选字段不就行了？

不行。原因是**每层有独立的依赖范围**。`pi-ai` 层的 `Tool` 接口只依赖 TypeBox 的 `TSchema`。如果在这个接口里加了 `renderCall`（返回终端 UI 组件），`pi-ai` 就得依赖终端 UI 渲染库。但 `pi-ai` 是纯模型适配层——它的工作只是"把工具信息格式化成 API 请求"，不应该知道终端 UI 长什么样。

三层递进的本质是：**每一层只加自己这个层级需要的能力，不越界。** `Tool` 管"我能描述自己"，`AgentTool` 管"我能被执行"，`ToolDefinition` 管"我能被展示和扩展"。

---

## 二、【新】工具暴露模型：注册了不代表模型看得见

### 问题：工具太多，模型装不下

回到 §一 的三层类型，我们讲了"注册一个工具"要做的事。但你有没有注意到一个隐含前提：**注册了工具，模型就看得见它？**

在早期版本里确实是这样——注册即声明。但工具一多就出问题了：MCP 服务器一接就是几十上百个工具，全塞进请求里，上下文预算爆炸；有些工具只该给脚本用（codemode），不该让模型直接调；有些工具模型根本不需要知道。

### 答案：ToolExposure——五种暴露方式

0.99 起，`ToolDefinition` 多了一个 `exposure?: ToolExposure` 字段，默认 `"direct"`。它决定了**模型怎么接触到这个工具**，一共五种取值（定义在 `packages/coding-agent/src/core/extensions/types.ts`）：

| 取值 | 含义 | 典型用途 |
|------|------|---------|
| `direct` | 激活时声明给模型，也可被其他工具调用 | 内置的 read/bash/edit 等 |
| `model-only` | 激活时声明给模型，但**不能被其他工具调用** | 编排/交互类工具，如 `codemode`、`tool_search` |
| `codemode` | 注册即可被 codemode 脚本调用，且 codemode 描述会列出它；不主动声明给模型 | 想让脚本直接看到、但不必让模型直接调的工具 |
| `deferred` | 同 codemode，但 codemode 描述里也不列出；`tool_search` 能搜到它 | MCP 工具默认映射到此（配置里的 `codemode` 经 `toToolExposure()` 变成 `deferred`） |
| `hidden` | 注册了但谁都够不着，激活也无效 | 服务器下线后把工具"冻结"掉 |

配套还有几个字段：

- **`namespace?: ToolNamespace`**：给一组相关工具分组（比如同一个 MCP 服务器的工具共享一个 `mcp__<server>` 命名空间），codemode 描述里按组陈列
- **`annotations?: ToolAnnotations`**：`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`——工具作者给权限扩展的"业务提示"，让权限系统决定哪些调用要确认
- **`defaultActive?: boolean`**：注册时是否自动激活。`direct` 和 `model-only` 默认激活，其余默认不激活；把它设成 `false` 可以要求用户显式点名（`--tools` 或 `defaultTools` 设置）才激活
- **`prepareLoadout?(loadout) => ToolLoadoutChanges`**：活跃工具集合变化时回调，允许工具改写"模型看到的描述"甚至隐藏某些声明

### 工具怎么被模型看见：active → loadout → 声明

那条链路是这样的（实现在 `packages/coding-agent/src/core/agent-session.ts` 的 `_applyToolLoadout` 里）：

1. 会话维护一个**活跃工具名集合**——`direct`/`model-only` 工具注册即进集合，其余默认不进；外部用 `getActiveTools()` / `setActiveTools()` 增删。
2. 活跃集合定下来后，把名字映射成真正的 `AgentTool[]`（`hidden` 排除在外），对每个带 `prepareLoadout` 的工具喂一个 `ToolLoadout`（含 `declared` / `callable` / `registered` 三份名单，以及 `getExposure` / `getNamespace`）。
3. 各工具的 `prepareLoadout` 返回的 `descriptions` 覆盖对应工具的描述（codemode 工具就是这么把自己的描述换成"可调用工具清单"的），`hiddenDeclarations` 则让某些活跃工具的声明**不进请求**。
4. 最终这批工具写进 `agent.state.tools`，随下一次请求声明给模型。

`ToolLoadout` 里三个名单的分工值得记一下：`declared` 是声明给模型的、`callable` 是 `executeTool()` 能调到的（活跃的 direct 工具 + 全部 codemode/deferred 工具）、`registered` 是注册过的全部。三者经常不相等——这正是"注册 ≠ 可见"的体现。

**一个真实例子**：MCP 扩展（`packages/coding-agent/src/extensions/mcp/index.ts`）默认把工具注册为配置里的 `"exposure": "codemode"`；这个值在注册时经 `toToolExposure()`（`packages/coding-agent/src/extensions/mcp/tools.ts`）映射成核心的 `ToolExposure = "deferred"`。这样一来，几十个 MCP 工具既不会撑爆模型请求，也不会挤进 codemode 描述——模型真想用它们，要么让 codemode 脚本用 `searchTools()` / `describeNamespace()` 现查，要么把 MCP 暴露改成 `deferred` 后用 `tool_search` 按需加载。MCP 服务器在会话启动时**后台连接**（0.99.2 起），首个 prompt 最多等 10 秒，且只等带 `direct` 工具的服务器（见 `packages/coding-agent/docs/mcp.md`）。`tool_search` 工具本身是 `model-only` + `defaultActive: false`，它的描述是固定的 `TOOL_SEARCH_DESCRIPTION`——**刻意不列任何工具或命名空间**，这样描述不会随 MCP 服务器连接而变（`packages/coding-agent/src/extensions/tool-search/tool.ts`）。它用 `Bm25Ranker` 搜 `codemode`/`deferred` 暴露且尚未激活的工具，命中后调 `setActiveTools()` 把它们加进活跃集合。

---

## 三、五步管道：工具调用不是"调个函数就完了"

类型定义搞清楚了，现在看工具调用的实际执行过程。

![工具调用五步管道](assets/260702-ch05-five-step-pipeline.svg)

**配图说明**：从 ToolCall 到 ToolResultMessage 的五步垂直管道——prepareArguments→validate→beforeToolCall→execute→afterToolCall。每一步右侧都有失败分支（虚线箭头），但所有失败最终都汇聚成 isError:true 的消息，循环不被异常打断。

### 为什么不能直接调函数？

最简单的处理方式：找到 read 工具 → 读文件 → 把内容塞进 ToolResultMessage → 完事。一行函数调用，很直觉。

但模型的输出并不总是规规矩矩的：

- **参数格式不对**：Edit 工具期望 `edits` 是一个数组，但某些模型会把数组序列化成字符串 `"[{...}]"` 传过来
- **参数类型错误**：Read 工具的 `path` 参数是 string，但模型可能传个数字 `12345`
- **危险操作**：模型要求执行 `rm -rf /`，你的 Agent 真的去执行吗？

这些问题意味着"直接调函数"是不够的。你需要在执行前加几道关卡。

### Pi 的答案：五步管道

```
LLM 输出 ToolCall
    │
    ▼
┌──────────────────────────────────────────────────┐
│ 第 1 步：prepareArguments（参数预处理）           │
│   处理 LLM 的参数怪癖                            │
│   如：把字符串化的数组解析回真正的数组             │
├──────────────────────────────────────────────────┤
│ 第 2 步：validateToolArguments（Schema 验证）     │
│   用 TypeBox Schema 做运行时类型检查              │
│   如：path 是 string，不是 number                │
├──────────────────────────────────────────────────┤
│ 第 3 步：beforeToolCall（前置钩子）              │
│   产品层的权限拦截，可以阻止执行                   │
│   返回 { block: true, reason: "危险命令"}         │
├──────────────────────────────────────────────────┤
│ 第 4 步：tool.execute（实际执行）                 │
│   调用工具的 execute 函数                         │
│   支持 onUpdate 流式进度回调                      │
├──────────────────────────────────────────────────┤
│ 第 5 步：afterToolCall（后置钩子）               │
│   产品层的结果后处理，可以修改返回值               │
│   可以替换 content、details、isError              │
└──────────────────────────────────────────────────┘
    │
    ▼
ToolResultMessage
```

每一步都有明确的职责和退出机制。前 3 步是"准备工作"——任何一步失败都不会执行工具。第 4 步是"真正干活"。第 5 步是"收尾"。我们逐步展开。

> **0.99 变更**：第 2 步的 `validateToolArguments` 已经**从 agent 包迁到了 pi-ai 层**（`packages/ai/src/utils/validation.ts`）。`agent-loop.ts` 现在只是 import 后调用它——因为参数校验和参数 Schema 本来就属于同一层（模型适配层），放在那里更合理。这一迁移也顺带把"类型转换/取值修正"（`Value.Convert`、`coerceWithJsonSchema`）和校验合成了一处。

### 第 1 步：prepareArguments——兼容性垫片

不同模型的 API 在序列化工具参数时有微妙的差异。`prepareArguments` 就是为这些差异准备的兼容层。

比如 Edit 工具期望 `edits` 是数组：

```typescript
// 模型实际传来的（某些模型把 JSON 数组序列化成了字符串）
{ edits: "[{\"oldText\":\"hello\",\"newText\":\"world\"}]" }

// 经过 prepareArguments 处理后
{ edits: [{ oldText: "hello", newText: "world" }] }
```

如果工具没定义 `prepareArguments`，参数直接透传。这一步的代码很简单——有就用，没有就跳过。

**为什么不在 Schema 验证里一起处理？** 因为它们关注的事情不同。`prepareArguments` 是"我知道某个模型会犯什么错"的兼容层——只处理特定模型的已知问题。`validateToolArguments` 是"不管谁调我都得验"的安全层——保证参数类型正确。一个是兼容性，一个是正确性，混在一起会让代码很难维护。

### 第 2 步：validateToolArguments——Schema 验证

经过预处理后，参数还要过一道 TypeBox 的运行时类型检查。比如 `path` 定义为 string，但模型传了 number：

```
Before：{ path: 12345 }
After： 验证失败 → 报错 → 不执行工具
```

验证错误会被 `prepareToolCall` 的 try-catch 捕获，生成一个错误 ToolResultMessage。**工具永远不会收到类型错误的参数。**

顺带一提，0.99 起这一步还会做**宽容的取值修正**（coercion）：`validateToolArguments` 会先把 `null`、字符串化的数字/布尔值按 Schema 类型尽量转换回去（比如把 `"12345"` 转成 `12345`），再跑严格校验。这是给"模型偶尔序列化错"又加了一层保险——但保险只覆盖能安全转换的，转换不了照样报错。

### 第 3 步：beforeToolCall——前置钩子（可阻止执行）

参数验证通过后，在执行之前，产品层还有一次拦截机会。`beforeToolCall` 是一个回调函数，可以检查命令是否危险：

| 返回值 | 效果 |
|--------|------|
| `undefined` | 放行，继续执行工具 |
| `{ block: true, reason: "危险命令" }` | 阻止执行，生成错误 ToolResultMessage |

**注意**：即使工具被阻止，结果仍然是一条正常的 `ToolResultMessage`，只是 `isError: true`。模型会看到这条错误消息，知道命令被拒绝了，然后决定下一步怎么做（换一个命令，或者跟用户解释为什么不能执行）。**整个过程不会抛异常，不会打断循环。**

### 第 4 步：tool.execute——实际执行

前 3 步都通过后，工具的 `execute` 函数被真正调用。回头看一下它的签名：

```typescript
execute: (toolCallId, params, signal, onUpdate) => Promise<AgentToolResult>
```

四个参数——`toolCallId` 是这次调用的 ID，`params` 是验证过的参数，`signal` 是用于取消的 AbortSignal（用户按 Ctrl+C 时触发）。第四个 `onUpdate` 是什么？

**它解决的是"长任务的进度感知"问题。** 假设 Bash 工具要跑一个 30 秒的命令——如果只有"开始执行"和"执行完成"两个时刻能向外界报告，用户在这 30 秒里只能盯着加载动画。`onUpdate` 让工具能**边执行边向外推消息**：Bash 工具每 100ms 推送一次当前的终端输出，Grep 工具每找到一批匹配就推送一次，Read 工具读取大文件时可以分段报告进度。这些推送被包装成 `tool_execution_update` 事件，最终流向 UI。

简单说：**没有 `onUpdate`，工具执行就是黑盒；有了它，工具执行是"可观察的"。** 这是工具能向用户实时汇报进度的关键机制。

但有个边角问题需要处理。工具的 `execute` 是异步函数，它 `return` 之后，内部可能还有没结束的异步操作——比如 Bash 工具的子进程在主命令返回后还在异步打印最后几行日志。如果这些延迟回调还往 `onUpdate` 推数据，就会污染一个**已经结束**的工具调用，让 UI 上下文错乱。Pi 用一个 `acceptingUpdates` 标志位解决：`execute` 一旦返回（或抛异常），立即把标志位关掉，之后所有 `onUpdate` 调用一律静默丢弃。这是工程上的防御性细节，不复杂，但必须要有。

`onUpdate` 推出的消息最终流向哪里？这个问题很重要——它是下一章"消息系统"的核心议题，那里会展开。这里只需要记住：工具执行不是黑盒，进度可观察。

如果 `tool.execute()` 抛出异常怎么办？别担心，§六 会详细讲这是怎么处理的——剧透一句：异常会被翻译成一条 `isError: true` 的消息发给模型。而且 0.99 起，工具**不必**靠抛异常来报错，直接 `return { isError: true, content: [...], details: {...} }` 就行，框架同样把它当作错误结果。

### 第 5 步：afterToolCall——后置钩子（可修改结果）

工具执行完毕后，产品层还有一次修改结果的机会。`afterToolCall` 可以做这些事情：

| 场景 | 做什么 | 怎么做 |
|------|--------|--------|
| 脱敏 | 把工具返回的敏感信息替换掉 | 返回 `{ content: [{type:"text", text:"[已脱敏]"}] }` |
| 审计 | 记录工具调用的详细信息 | 读取 result，写日志，返回 `undefined`（不改结果） |
| 修错 | 把工具的错误结果修正为正常结果 | 返回 `{ isError: false, content: [...] }` |
| 早停 | 让 Agent 在当前批次后停止 | 返回 `{ terminate: true }` |

合并语义是字段级覆盖——提供了就替换，没提供就保留原值。0.99 起多了一条细节：`structuredContent` 也参与覆盖，但**如果你只替换了 `content` 却没带 `structuredContent`，后者会被丢弃**——因为新的文本内容和旧的机器可读结果可能对不上。想保留就得一起返回。

### 管道的终点：ToolResultMessage

五步走完，不管中间出了什么状况，最终产物都是一条 `ToolResultMessage`：

```typescript
{
    role: "toolResult",
    toolCallId: "call_abc123",      // 关联到原始 ToolCall
    toolName: "read",
    content: [{ type: "text", text: "1│ import { Agent }..." }],
    details: { language: "typescript" },  // 给 UI 的元数据
    usage: { input: 0, output: 0, totalTokens: 0, ... }, // 0.99 起：工具自身的用量（可选）
    nestedCalls: { calls: [...], complete: true },       // 0.99 起：该工具发起的嵌套调用记录（可选）
    isError: false,                  // 是否为错误结果
    timestamp: 1700000000000,
}
```

0.99 起这条消息多了两个字段：`usage`（工具执行本身的 token 用量）和 `nestedCalls`（§四 要讲的嵌套调用记录）。注意 `nestedCalls` **只保留在会话记录里，不会发给模型**。

这条消息会被追加到对话历史中，在下一轮循环里作为上下文发给模型。模型看到"文件内容是这样的"，然后决定下一步——可能要编辑，可能要再读别的文件，可能直接回答用户。

**所有错误最终都变成了同一种东西：一条 `isError: true` 的 ToolResultMessage。** 模型看到错误消息，知道出错了，然后自己决定怎么处理。这个设计为什么是最佳实践？§六 会详细展开。

---

## 四、【新】嵌套工具调用：一个工具调用另一个工具

### 问题：工具想调用工具

前面讲的都是"模型发起一次工具调用"。但 0.99 起多了一种玩法：**工具自己也想调用别的工具。** 最典型的是 `codemode`——模型让它写一段 JavaScript，这段脚本里 `await tools.read(...)`、`await tools.grep(...)`，一个调用里套了若干个工具调用。

这种"工具调工具"就是**嵌套工具调用**。它不能简单地直接调 `tool.execute()`——那样会绕过参数校验、`beforeToolCall`/`afterToolCall` 钩子和权限检查，等于开了个后门。它要的是"走一遍和模型发起调用完全一样的管道"。

### 答案：runToolCall + ctx.executeTool

Agent 内核导出了 `runToolCall(toolCall, options)`（在 `packages/agent/src/agent-loop.ts`）。它把一次工具调用完整地跑过五步管道（准备参数 → 校验 → `beforeToolCall` → 执行 → `afterToolCall`），**但不发事件、不追加消息**，只返回一个 `AgentToolCallOutcome`。工具开发者不用直接碰它——通过会话上下文更顺手：

```typescript
// ExtensionToolContext 上的方法（packages/coding-agent/src/core/extensions/types.ts）
executeTool(name: string, args: unknown, options?: ExecuteToolOptions): Promise<AgentToolCallOutcome>;
```

`ctx.executeTool()` 就是"以当前工具的名义，调用另一个工具"。它有几个约定值得记住：

- **调用 id 形如 `<父调用 id>/<n>`**，`<n>` 从 1 递增，保证唯一。
- **事件带 `parentToolCallId`**：`tool_execution_start/_update/_end` 都会带上发起它的那次调用的 id，UI 据此把嵌套调用挂到父调用下面显示。
- **不进对话记录**：嵌套调用的工具结果**不会**作为 `ToolResultMessage` 进入 transcript。只有它的父调用（如 codemode）的结果会被记录，并在其 `nestedCalls` 字段里保留一份**有界**的嵌套调用摘要（条数、参数大小、耗时、状态、错误都有上限，见 `packages/coding-agent/src/core/nested-tool-calls.ts` 的 `NESTED_CALL_LIMITS`）。
- **永不因工具失败而 reject**：未知工具、校验失败、被拦截、抛异常，统统以 `isError: true` 的结果返回——和模型发起的调用一个语义。

### 嵌套结果怎么交回给脚本

codemode 脚本拿到的嵌套结果，规则是（见 `extensions/codemode/tool.ts` 的注释）：

1. **声明了 `outputSchema` 的工具** → 解析成它的 `structuredContent`（连错误结果里的 `structuredContent` 也算，MCP 工具因此能拿到完整的 `CallToolResult`）。
2. **其他工具** → 解析成它的文本 `content`，拼成一个字符串。
3. **失败/被拦/参数非法的调用** → 在脚本里 `reject` 一个 Error，Error 里带工具的错误文本。

这样脚本层面既能拿到结构化的机器结果（有 schema 时），也能拿到人类可读文本（没 schema 时）。`structuredContent` 的价值也正在这里——它就是给这类**程序化调用者**（而不是模型）准备的。

---

## 五、并行 vs 串行：一个批次的工具不是"一起跑就完了"

![并行 vs 串行 三阶段设计](assets/260702-ch05-parallel-sequential.svg)

**配图说明**：顶部"一票否决"决策——只要有一个工具声明 sequential，整批串行。左侧绿色三阶段（顺序准备→并行执行→有序事件），右侧黑色瀑布式串行。底部解释"为什么准备阶段必须顺序"和"何时用串行"。

### 模型经常一次调用多个工具

Agent Loop 的内层循环中，模型的一次回复可能包含多个 ToolCall：

```
assistantMessage.content = [
    { type: "text", text: "我来查一下文件" },
    { type: "toolCall", id: "call_1", name: "read", arguments: {path: "a.ts"} },
    { type: "toolCall", id: "call_2", name: "grep", arguments: {pattern: "TODO"} },
    { type: "toolCall", id: "call_3", name: "find", arguments: {pattern: "*.test.ts"} },
]
```

三个 ToolCall，都是只读操作。直觉告诉我们应该并行执行——用 `Promise.all` 一起跑，省时间。

### 但并行不是无脑 Promise.all

如果三个 ToolCall 中有两个是 edit（修改同一个文件），并行执行就会互相覆盖：

```
ToolCall 1: edit { path: "app.ts", oldText: "v1", newText: "v2" }
ToolCall 2: edit { path: "app.ts", oldText: "v3", newText: "v4" }
                     ^^^^^^^^
                     同一个文件！并行执行 → ToolCall 1 的修改被 ToolCall 2 覆盖
```

所以 Pi 需要一种机制来判断"哪些工具能并行，哪些必须串行"。

### Pi 的调度策略：一票否决

Pi 的策略很简单——**只要有一个工具标记为 sequential，整个批次都串行执行**：

```typescript
// 检查是否有串行工具
const hasSequentialToolCall = toolCalls.some(
    (tc) => tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
);

// 有串行工具 → 整批串行；没有 → 并行
if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(...);
}
return executeToolCallsParallel(...);
```

**为什么一票否决而不是只串行冲突的工具？** 因为"哪些工具会冲突"很难精确判断。edit 和 edit 操作不同文件就可以并行？万一它们编辑的文件有依赖关系呢？Pi 选择了保守策略：**宁可多等，不可出错。**

### 并行执行的三阶段设计

当判定可以并行时，Pi 不是简单地 `Promise.all` 跑完就完——它把执行分成了三个阶段：

```
阶段 1 - 准备（顺序执行）：
  ToolCall 1: emit_start → prepareArguments → validate → beforeToolCall
  ToolCall 2: emit_start → prepareArguments → validate → beforeToolCall
  ToolCall 3: emit_start → prepareArguments → validate → beforeToolCall
  // 准备阶段必须顺序，因为 beforeToolCall 可能有副作用（如修改全局状态）

阶段 2 - 执行（并行）：
  ToolCall 1: execute ────────────────┐
  ToolCall 2: execute ───────────────┤ Promise.all
  ToolCall 3: execute ───────────────┘
  // 只有 tool.execute() 并行

阶段 3 - 事件发送（有序）：
  ToolCall 2: emit_end    ← 先完成的先发 tool_execution_end
  ToolCall 1: emit_end
  ToolCall 3: emit_end
  ToolCall 1: emit_result ← 但 ToolResultMessage 按调用顺序发
  ToolCall 2: emit_result
  ToolCall 3: emit_result
```

为什么这么设计？因为**准备阶段可能有副作用**（beforeToolCall 可能修改共享状态），必须顺序执行。而**结果消息的顺序模型依赖调用顺序**（模型先要求 read 再要求 grep，消息就得按这个顺序排列），所以 ToolResultMessage 必须有序。只有 `tool.execute()` 这一步真正并行。

> 还有一个细节：0.99 的 8 个内置工具（read/bash/powershell/edit/write/grep/find/ls，见 `packages/coding-agent/src/core/tools/index.ts` 的 `ToolName`）**都没有显式声明 `executionMode`**，默认全部 `"parallel"`（`ToolExecutionMode` 类型定义在 `packages/agent/src/types.ts`，运行时在 `agent-loop.ts` 的 `executeToolCalls` 里判断是否 `"sequential"`，未显式声明即按并行处理）。那 Edit 工具怎么保证文件安全？答案是工具内部的 `withFileMutationQueue`（文件变更队列，`file-mutation-queue.ts`）——Edit 在 `edit.ts` 的 `execute` 里调用了它，确保对**同一个文件**的编辑操作串行化。这是工具自己做的第二道防线，无需依赖外层 `executionMode` 声明。**扩展工具如果需要串行，可以显式声明 `executionMode: "sequential"`**（嵌套调用也会遵守这个规则）。

---

## 六、永不抛出：工具出错也是一条消息

前面 §三 的五步管道里，每一步出错都被编码成了 `isError: true` 的 ToolResultMessage。看起来错误已经被处理了。

但你可能会问：万一 `tool.execute()` 内部抛了一个未捕获的异常呢？工具开发者写代码时什么情况都可能发生——文件不存在、权限拒绝、命令超时、JSON 解析失败。这些异常如果不处理，就会一路穿透管道，打断 Agent Loop。

这一节就来回答：**工具执行出错时，Pi 是怎么处理的？为什么这种处理方式是"最佳实践"？**

### 0.99 的错误语义：两条路，同一种结果

先说 0.99 起最重要的一个变化：**工具报告失败不必再抛异常了。** `AgentToolResult` 新增了 `isError?: boolean`，工具可以直接返回 `{ isError: true, content: [...], details: {...} }`——框架把它当作错误结果，同时**保留 `details` 和 `structuredContent`**（这些对 UI 和程序化调用者还有用）。

回看 `executePreparedToolCall`（`packages/agent/src/agent-loop.ts`）里判定错误的那一行：

```typescript
const result = await prepared.tool.execute(...);
acceptingUpdates = false;
await Promise.all(updateEvents);
return { result, isError: result.isError === true };   // 工具自己声明的 isError 也算数
```

也就是说，错误的判定来自两处：工具返回的 `isError: true`，或 `execute` 抛出的异常（被 catch 兜住）。**两条路，最终都汇成同一种产物。**

### 为什么改成"可预期的失败不走异常"？

要让一个工具"文件读不到就报错"，早期只能 `throw`。但很多失败其实是**可预期的正常业务结果**——命令退出码非零、grep 没匹配到、edit 的 oldText 不存在，这些是"工具跑完了，结果就是失败"，不是"程序出了岔子"。

用异常表达它们有三个坏处：

1. **丢失上下文**。异常一旦被 catch 兜成消息，工具的 `details`（比如 diff、退出码、截断信息）全没了——框架只能拿到 `error.message`。
2. **控制流不自然**。用 `try/catch` 包住正常业务分支，是可读性上的坏味道。
3. **语义混淆**。"命令退出码是 1"和"工具框架崩了"被涂成同一种东西。

所以 0.99 把"可预期的失败"和"意外异常"分开：**能预料到的失败，直接 `return { isError: true }`，并带上完整的 `details`/`structuredContent`；真正意外、拦不住的异常，才交给框架兜底。** 这就是下面 Bash 工具改造的核心。

### 错误的统一出口：多种错误，1 种产物

回看整个五步管道，工具调用的每一步都可能出错。但你会发现一个惊人的规律：**不管哪一步出错，最终产物都是同一种东西——一条 `isError: true` 的 ToolResultMessage。**

| 哪一步出错 | 怎么处理 | 最终产物 |
|-----------|---------|---------|
| 工具未找到 | 直接返回错误结果，不进入管道 | `ToolResultMessage { isError: true, content: "Tool xxx not found" }` |
| prepareArguments 抛异常 | 被 try-catch 捕获 | `ToolResultMessage { isError: true, content: 异常信息 }` |
| Schema 验证失败 | 被 try-catch 捕获 | `ToolResultMessage { isError: true, content: 验证错误描述 }` |
| beforeToolCall 阻止 | 返回阻止结果 | `ToolResultMessage { isError: true, content: 阻止原因 }` |
| **工具自己 `return { isError: true }`**（0.99 起） | 由 executePreparedToolCall 透传 | `ToolResultMessage { isError: true, content, details, structuredContent }` |
| **tool.execute 抛异常** | 被 executePreparedToolCall 的 try-catch 捕获 | `ToolResultMessage { isError: true, content: 异常信息 }` |
| afterToolCall 抛异常 | 被 finalizeExecutedToolCall 的 try-catch 捕获 | `ToolResultMessage { isError: true, content: 异常信息 }` |

注意表格的右列——**所有错误的最终形态都是 ToolResultMessage**。没有一种错误会以"抛异常"的形式逃出管道。

### 关键代码：tool.execute 的防护

`executePreparedToolCall()` 包住了 `tool.execute()` 这个最容易出错的环节：

```typescript
// packages/agent/src/agent-loop.ts —— executePreparedToolCall
async function executePreparedToolCall(prepared, signal, onUpdate) {
    const updateEvents: Promise<void>[] = [];
    let acceptingUpdates = true;          // 工具 Promise settle 后关闭

    try {
        const result = await prepared.tool.execute(
            prepared.toolCall.id,
            prepared.args,
            signal,
            (partialResult) => {
                if (!acceptingUpdates) return;     // settle 后的孤儿回调直接忽略
                updateEvents.push(Promise.resolve(onUpdate(partialResult)));
            },
        );
        acceptingUpdates = false;
        await Promise.all(updateEvents);
        return { result, isError: result.isError === true };   // 工具自报的 isError 也算

    } catch (error) {
        acceptingUpdates = false;
        // 关键：先等所有进度事件发完，再把异常编码成消息
        await Promise.all(updateEvents);
        return {
            result: createErrorToolResult(
                error instanceof Error ? error.message : String(error)
            ),
            isError: true,
        };
    } finally {
        acceptingUpdates = false;          // 兜底：无论如何都关闭闸门
    }
}
```

这段代码做三件事：

**1. 异常被 catch，不穿透**。`tool.execute()` 抛什么异常都会被这里的 catch 接住——文件不存在的 `ENOENT`、权限拒绝的 `EACCES`、命令超时的 `TIMEOUT`、JSON 解析失败的 `SyntaxError`，统统在这里止步。

**2. 异常被"翻译"成正常结果**。catch 块里调用 `createErrorToolResult(error.message)`。注意 0.99 起这个函数**只返回 `{ content, details }`，不再自己写 `isError`**——错误标记由调用方统一给出，这样"是不是错误"就有了唯一、明确的判断点：

```typescript
// packages/agent/src/agent-loop.ts —— createErrorToolResult
function createErrorToolResult(message: string): AgentToolResult<any> {
    return {
        content: [{ type: "text", text: message }],
        details: {},
    };
}
```

**3. 进度事件先发完，再编码错误**。catch 块里的 `await Promise.all(updateEvents)` 保证工具执行过程中已经发出的 `tool_execution_update` 事件全部送达后，才发出错消息。否则事件乱序，UI 会看到"工具先报错，再吐出最后一行进度"的诡异画面。

### 异常 → 消息：编码前后对比

下面这个对比能让你看清"异常被翻译成消息"的本质：

```
工具抛出的原始异常（catch 之前）：        编码后的 ToolResultMessage（catch 之后）：
Error: ENOENT: no such file or dir       {
  → 一路穿透管道                            role: "toolResult",
  → 打断 Agent Loop                         toolCallId: "call_abc",
  → 事件序列不完整，UI 卡死                  toolName: "read",
                                            content: [{
                                              type: "text",
                                              text: "ENOENT: no such file or dir"
                                            }],
                                            isError: true   ← 框架判定的错误标记
                                          }
                                          → 追加到对话历史
                                          → 下一轮发给模型
                                          → 模型看到后自己决定怎么办
```

异常和消息的区别不在于"内容是什么"——两者描述的是同一件事——而在于**接收者是谁**。异常的接收者是调用栈（外层框架），它会打断循环；消息的接收者是模型，它会消化错误然后继续。Pi 选择了把异常翻译成消息，让"工具出错"成为模型可见的、可处理的正常信息流。

（如果错误来自工具自己的 `return { isError: true }`，过程更直接——它本来就长这样，`isError` 由工具声明、框架照单全收。）

### 为什么"伪装成消息"是最佳处理方式？

你可能会想：异常抛出去给外层统一处理不也行吗？为什么要费劲翻译成一条"长得像正常结果"的消息？

答案的核心是：**让模型自己决定下一步，比框架替它决定更好。**

考虑这几种真实的工具错误场景：

| 错误场景 | 模型看到错误消息后的合理反应 |
|---------|---------------------------|
| `read("/path/a.ts")` 报"文件不存在" | 模型可能先 `ls` 看看目录里有什么，找到正确文件名再读 |
| `edit` 报"oldText 在文件中找不到匹配" | 模型可能先 `read` 文件查看实际内容，调整 oldText 后重试 |
| `bash("npm run build")` 报"模块未找到" | 模型可能 `npm install` 后再 build |
| `bash("rm -rf /")` 被 beforeToolCall 阻止 | 模型看到阻止原因，换一种安全的写法或向用户解释 |

每种场景下，**正确的下一步动作都不同，而且只有模型有足够的上下文判断该走哪条路**。框架不知道"文件不存在"是因为路径写错了还是因为应该换个文件；模型知道——它知道自己刚才想干什么，知道项目的文件结构（前面的 read/grep 结果都在对话历史里），知道用户的真实意图。

如果框架直接抛异常打断循环，等于放弃了模型的所有自我纠错能力——用户只能在 Agent 崩溃后手动重启。但如果把错误编码成消息发给模型，模型就有机会像上面的表格那样**自己想出补救方案**。这是 Agent 比传统脚本程序更"智能"的关键之一：错误不会终止流程，而是成为下一步决策的输入。

**所以，Pi 的工具错误处理哲学可以总结成一句：错误信息是给模型的反馈，不是给框架的终止信号。**

### 关键细节：错误描述越具体，模型纠错能力越强

到这里你可能会产生一个误解——"反正框架会把异常编码成消息，那我工具内部随便 throw 个 `Error("failed")` 不就行了？"

**绝对不行。** 错误消息的内容直接决定模型能不能纠错。比较下面两种情况：

```
模糊错误（不可取）：                      具体 error.message（推荐）：
{                                        {
  content: [{ text: "Read failed" }]       content: [{
  isError: true                              text: "Offset 200 is beyond end of file (100 lines total)"
}                                          }]
                                           isError: true
                                         }
```

模型看到 "Read failed"，只能盲目重试或放弃；看到 "Offset 200 is beyond end of file (100 lines total)"，能立刻明白"哦，文件只有 100 行，我 offset 给错了"，下次直接给 `offset: 50` 就成了。**具体的错误描述等于给模型一份"怎么改才对"的提示**。

### Pi 的真实做法：两层错误处理，分层负责

回源码看 Pi 自己的工具是怎么做的：能预料的失败，工具直接返回错误结果；真正意外的异常，才交给框架兜底。

**Read 工具**（`packages/coding-agent/src/core/tools/read.ts`）——越界时仍然抛异常（这属于"参数用法不对"的意外），但描述写得极其具体：

```typescript
if (startLine >= allLines.length) {
    throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
}
```

**Edit 工具**（`packages/coding-agent/src/core/tools/edit.ts`）——附上文件路径和原始错误：

```typescript
throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
```

**Bash 工具**（`packages/coding-agent/src/core/tools/bash.ts`）——0.99 改成了"可预期失败不走异常"的教科书案例。**非零退出码不再抛异常**，而是返回带 `isError: true` 的结果，并把退出码、耗时、输出一并塞进 `structuredContent`：

```typescript
// 命令执行完成，退出码非零：这是"预期内的失败"，不是异常
if (exitCode !== 0) {
    return {
        content: [{ type: "text", text: appendStatus(outputText, `Command exited with code ${exitCode}`) }],
        details,
        structuredContent: {           // 0.99 起新增：给程序化调用者的机器可读结果
            output: fullOutput.content,
            truncated: fullOutput.truncated,
            exit_code: exitCode,
            wall_time_seconds: wallTimeSeconds,
        },
        isError: true,                 // ← 直接声明失败，details 与结构化结果都保住了
    };
}
return { content: [{ type: "text", text: outputText }], details, structuredContent };
```

只有"中止（aborted）"和"超时（timeout:）"这类真正意外的情况，Bash 才继续 `throw`，交给框架兜底：

```typescript
} catch (err) {
    const snapshot = await finishOutput();              // 先把已经输出的内容固定下来
    const { text } = formatOutput(snapshot, "");
    if (err instanceof Error && err.message === "aborted") {
        throw new Error(appendStatus(text, "Command aborted"));
        //                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
        //                  重新包装：附上"中止前的输出" + "中止状态"
    }
    if (err instanceof Error && err.message.startsWith("timeout:")) {
        const timeoutSecs = err.message.split(":")[1];
        throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
    }
    throw err;    // ← 关键：识别不了的异常，原样抛出，交给框架兜底
}
```

这就形成了 0.99 的错误处理分工：

```
第一层（工具主动，两条路）：
  ├── 可预期的失败 → return { isError: true, ... }，带上 details / structuredContent
  └── 意外的异常   → throw Error(具体描述)，附上"为什么失败、怎么改才对"的线索

第二层（框架兜底，被动）：executePreparedToolCall 的 catch
  └── 只在工具抛异常时生效
  └── 不创造新的错误描述，只把 error.message 原样透传给模型
  └── 目的：保证任何异常都不会穿透到 Agent Loop
```

`executePreparedToolCall` 里的兜底 catch 用的就是工具自己抛的 `error.message`：

```typescript
} catch (error) {
    return {
        result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
        //                                                   ^^^^^^^^^^^^^^^^
        //                              工具内部包装好的具体描述，框架不动它，只搬运
        isError: true,
    };
}
```

`createErrorToolResult` 不做任何"统一描述"——工具写的 message 是什么，模型就看到什么。**所以工具内部包装得越具体，模型看到的错误信息就越有用。**

### 写自定义工具时的最佳实践

0.99 起，自定义工具的 `execute` 应该区分"可预期失败"和"意外异常"：

```typescript
execute: async (id, params, signal, onUpdate) => {
    // 第 1 步：可预期的失败，直接返回错误结果，保留 details
    if (fileMissing) {
        return {
            content: [{ type: "text", text: `文件 ${path} 不存在，目录下有 [b.ts, c.ts]` }],
            details: { path },
            isError: true,
        };
    }
    try {
        // ... 业务逻辑
        return { content: [...], details: {...} };
    } catch (err) {
        // 第 2 步：识别已知的意外类型，重新包装成具体描述
        if (err instanceof MyKnownError) {
            throw new Error(`具体的描述：${err.message}。建议的修复方法...`);
        }
        // 第 3 步：实在识别不了的异常，原样抛出，让框架兜底
        throw err;
    }
}
```

**三个关键原则**：

1. **可预期的失败优先用 `return { isError: true }`**：这能保住 `details` 和 `structuredContent`，控制流也更自然。
2. **意外异常一定要包装**：附上"是什么错、为什么、怎么办"的线索。比如"文件不存在"比"操作失败"强 10 倍；"文件 /a.ts 不存在，目录下有 [b.ts, c.ts]"比"文件不存在"又强 10 倍。
3. **识别不了的不要硬编码描述**：直接 `throw err`，让框架兜底 catch 把 `err.message` 透传出去。**不要写 `throw new Error("操作失败")` 这种笼统描述**——那等于把所有未知错误都涂成同一种颜色，模型无法区分。

**这就是"错误即消息"的两层保障**：可预期的失败由工具自己声明 `isError: true`，意外的异常由框架兜底 catch 接管翻译成 `isError: true` 的消息。无论哪条路，错误描述本身都要尽量具体；只有真的无从识别时，才让 `err.message` 原样透传给模型。

### 一句话总结

工具执行出错时，Pi 不抛异常打断循环，而是把错误编码成一条 `isError: true` 的 ToolResultMessage 发给模型。0.99 起有两条产生错误的路：**可预期的失败由工具自己 `return { isError: true }`**（保住 `details`/`structuredContent`），**意外的异常由框架兜底 catch 把 `error.message` 透传**。模型拿到具体的错误信息后，自己决定下一步——重试、换路径、向用户解释。这就是为什么 Pi 的 Agent Loop 能在工具频繁失败的真实场景下保持稳定运行。

---

## 七、【进阶】Operations 抽象：工具执行不等于系统调用

> 这一节属于软件工程的实现技巧，和 Agent 本身关系不大。如果你只关心 Agent 的运行机制，可以跳过。

### 问题：工具代码写死了系统调用

Read 工具要读文件，最直觉的写法：

```typescript
const content = fs.readFileSync(path, "utf-8");
```

但如果你想**在测试中 Mock 文件系统**呢？如果你想让工具**通过 SSH 读远程文件**呢？如果你想让工具**在 Docker 容器里执行**呢？

`fs.readFileSync` 是写死的——它只认本地文件系统。想换执行环境，就得改工具代码。

### 解法：工具不直接调系统 API，而是调接口

Pi 的每个工具都不直接调用 `fs`、`child_process` 等系统 API。它定义一个最小化的接口，工具只依赖接口，不依赖具体实现。

以 Read 工具为例：

```typescript
export interface ReadOperations {
    readFile: (absolutePath: string) => Promise<Buffer>;
    access: (absolutePath: string) => Promise<void>;
    detectImageMimeType?: (absolutePath: string) => Promise<string | null>;
}
```

Read 工具的 execute 函数里，所有文件操作都通过 `ops` 对象调用：

```typescript
execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    const ops = options?.operations ?? defaultReadOperations;
    await ops.access(absolutePath);        // 通过接口检查权限
    const buffer = await ops.readFile(absolutePath);  // 通过接口读文件
    // ...
}
```

**关键区别：**

```
直接调 fs（硬编码）：               通过 Operations 接口（可替换）：
┌──────────────────────┐            ┌──────────────────────┐
│ Read 工具             │            │ Read 工具             │
│ fs.readFile(path)    │            │ ops.readFile(path)   │
│ 只能读本地文件        │            │ 本地 / SSH / Mock     │
│ 测试必须创建真实文件   │            │ 注入什么就调什么      │
└──────────────────────┘            └──────────────────────┘
```

Operations 在**工具创建时**被闭包捕获。后续每次执行都用同一套实现。不同环境注入不同的 Operations 实现，工具代码一行不用改：

```typescript
// 本地执行（默认）
const tool = createReadToolDefinition(cwd);  // 用 defaultReadOperations

// 单元测试（Mock）
const tool = createReadToolDefinition(cwd, {
    operations: {
        readFile: () => Buffer.from("mock file content"),  // 不需要创建真实文件
        access: () => {},  // 不抛异常就是文件存在
    }
});

// 远程执行（SSH，假设）
const tool = createReadToolDefinition(cwd, {
    operations: {
        readFile: (path) => sshExec(`cat ${path}`),
        access: (path) => sshExec(`test -r ${path}`),
    }
});
```

### 每个工具定义自己需要的最小接口

一个有趣的细节：**接口是按工具需求裁剪的，不是大一统的。**

| 工具 | 接口 | 方法 |
|------|------|------|
| Read | `ReadOperations` | `readFile`, `access`（另含可选 `detectImageMimeType`） |
| Write | `WriteOperations` | `writeFile`, `mkdir` |
| Edit | `EditOperations` | `readFile`, `writeFile`, `access` |
| Bash | `BashOperations` | `exec` |
| PowerShell | `PowerShellOperations` | `exec`（与 Bash 共用 `createLocalShellOperations` 实现） |
| Grep | `GrepOperations` | `isDirectory`, `readFile` |
| Find | `FindOperations` | `exists`, `glob` |
| Ls | `LsOperations` | `exists`, `stat`, `readdir` |

Read 工具不需要写文件，所以 `ReadOperations` 没有 `writeFile`。Grep 工具只需要判断路径和读文件内容来显示上下文，所以它的接口最精简。**每个工具只声明自己需要的方法，不多不少。** 0.99 新增的 PowerShell 工具（`PowerShellOperations`）和 Bash 共用同一套 `createLocalShellOperations` 实现，只是换了个 shell。

> 代码来源（均在 `packages/coding-agent/src/core/tools/`）：`read.ts` 的 `ReadOperations` / `write.ts` 的 `WriteOperations` / `edit.ts` 的 `EditOperations` / `bash.ts` 的 `BashOperations` / `powershell.ts` 的 `PowerShellOperations` / `grep.ts` 的 `GrepOperations` / `find.ts` 的 `FindOperations` / `ls.ts` 的 `LsOperations`

---

## 八、【新】结构化输出与共享输出层

### 问题：一份结果，两类消费者

前面的 §四 我们看到 codemode 脚本更想要"机器可读"的结果，而模型只认文本。Bash 工具的例子也暴露了这点：模型看 `Command exited with code 1` 就够了，脚本却想直接拿到 `exit_code: 1` 去做判断。

一份结果，两类消费者——这就是 0.99 加 `outputSchema` + `structuredContent` 的动机。

### 契约：outputSchema 声明结构，structuredContent 才是内容

两个字段的分工是：

- **`outputSchema`**（`ToolDefinition` / `AgentTool` 的字段，一个 JSON Schema）：声明"成功结果里的 `structuredContent` 长什么样"。**声明了它的工具就应当总是返回 `structuredContent`**。
- **`structuredContent`**（`AgentToolResult` 的字段）：机器可读的实际结果。**它不会发给模型**——`content` 才是模型面对的结果，`structuredContent` 是给程序化调用者（codemode 脚本、`tool_result` 处理器等）的。

以 Bash 工具为例（`packages/coding-agent/src/core/tools/bash.ts`），它声明了 `bashOutputSchema`：

```typescript
const bashOutputSchema = Type.Object({
    output: Type.String({ description: "Combined stdout and stderr, up to 1 MiB..." }),
    truncated: Type.Boolean({ description: "Whether `output` omits part of the command output" }),
    full_output_path: Type.Optional(Type.String({ description: "Temp file with the full output, when truncated" })),
    exit_code: Type.Number(),
    wall_time_seconds: Type.Number(),
});
```

于是它成功时返回 `{ content, details, structuredContent }`，失败（非零退出码）时返回带 `isError: true` 的同类结构——**错误结果里的 `structuredContent` 照样保留**（回顾 §六）。模型看到的是人话，脚本拿到的是字段。

有个容易踩的坑：`beforeToolCall` / `afterToolCall` 钩子或 `tool_result` 事件里，**如果你替换了 `content` 却没带上 `structuredContent`，后者会被丢弃**——因为新的文本和旧的机器结果可能已经对不上了（§三 已提过）。

### 共享输出层：truncate 与 output-accumulator

输出一长就得截断，但截断逻辑不该每个工具各写一遍。0.99 把它抽成了两个共享实现，都在 `packages/coding-agent/src/core/tools/`：

- **`truncate.ts`**：纯函数式的截断工具集——`DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`（2000 行 / 50KB）、`truncateHead`（保留头部，Read 用）、`truncateTail`（保留尾部，Bash 用）、`truncateLine`、`truncateMiddle`、`formatSize`。所有工具的"输出超限"提示都基于它。
- **`output-accumulator.ts`**：类 `OutputAccumulator`，给流式输出用——增量累积文本、只保留一段有界的内存尾部、用流式 UTF-8 解码器避免半个字符，超限时把完整输出落到临时文件（`readFullOutput()` 之后能按首尾各取一半再加省略标记读回）。Bash 工具就是用它一边收子进程输出、一边给 `onUpdate` 推快照的。

抽成共享层的好处很直接：**所有工具用同一套截断阈值和提示措辞**，模型看到的"截断告示"格式统一；新增工具不必重新发明轮子，直接 import 即可。

---

## 九、【新】内置扩展：codemode / tool-search / mcp / llama.cpp

0.99 起，一些"产品级能力"不再写死在核心里，而是做成**内置扩展**（built-in extension）。它们列在 `packages/coding-agent/src/extensions/index.ts` 的 `builtInExtensions`：

| 扩展 | 提供什么 | 暴露方式 |
|------|---------|---------|
| `codemode` | 让模型写 JavaScript 脚本，用 `tools.*` 调用其他工具（即 §四 的嵌套调用）；脚本还可用 `models.*`、`store()`/`load()`、`searchTools()`/`describeTool()`/`describeNamespace()`/`ALL_TOOLS`、`text()`/`image()`/`console`/`exit()`/`return` 和首行 `// @options:`，受 `codemode.mode`、`codemode.inlineBudget` 设置控制 | `model-only`，`defaultActive: false` |
| `tool-search` | `tool_search` 工具：BM25 搜索未声明给模型的工具（`codemode`/`deferred` 暴露），命中的加入活跃集合 | `model-only`，`defaultActive: false` |
| `mcp` | 连接 `mcp.json` 与 `pi.registerMcpServer()` 的服务器（后台连接），工具注册成 `mcp__<server>__<tool>` | 配置级 `exposure` 默认 `codemode`（注册时映射为核心 `deferred`），可选 `codemode`/`deferred`/`direct`/`hidden` |
| `llama.cpp` | 管理本地 llama.cpp router 的模型（`/llama` 命令） | 提供 provider，无工具 |

### 命名与启停：builtin:<name>

内置扩展的命名统一是 `builtin:<name>`。它**像文件一样的扩展资源**：默认加载，`pi config` 会列出；可以在 `extensions` 设置里用 `-builtin:<name>` 禁用它，或用 `--no-extensions` 一次性关掉全部扩展；`-e builtin:<name>` 则显式加载它。它对启动的 Extensions 列表隐藏，并在项目信任解析之后才加载——因此**内置扩展不能处理 `project_trust` 事件**（那是加载前就要定的事）。

其中 `codemode`、`tool-search`、`mcp` 三个还带 `replaceable: true`：如果你自己的扩展注册了同名工具或命令（比如 `codemode`、`tool_search`、`/mcp`），它会**替换**掉内置的那个，而不是报命名冲突。

### 它们和前面几节的呼应

- `codemode` 的 `exposure: "model-only"` + `defaultActive: false` + `prepareLoadout`，正是 §二 那套暴露模型的活例子：注册不等于可见，得显式激活，且它的描述由 `prepareLoadout` 动态生成（列出当前可调用的工具）。它用 `ctx.executeTool()`（§四）跑嵌套调用。它的沙箱在独立包 `packages/codemode`（`@earendil-works/pi-codemode`）——一个 QuickJS（编译到 WebAssembly）虚拟机，导出 `CodemodeSandbox`、`parseCodemodeSource`、`CODEMODE_SOURCE_GRAMMAR`、`loadQuickJSWasm`、`renderDeclarations` 等；coding-agent 侧经 `extensions/codemode/worker.ts` + `execute.ts` 集成，沙箱在首次调用时才加载。
- `tool-search` 是"按需加载工具"的入口：它只搜 `codemode`/`deferred` 暴露的工具，命中后用 `setActiveTools()` 把它们加进活跃集合——**工具从"注册但不可见"变成"声明给模型"，正是通过这一步**（§二 的链路）。
- `mcp` 把外部服务器的几十上百个工具默认注册成核心的 `deferred` 暴露（配置里写 `codemode`），既避免撑爆模型请求，也不挤进 codemode 描述；服务器在会话启动时后台连接，首个 prompt 只等带 `direct` 工具的服务器。它也会自动激活 `codemode` 或 `tool_search` 来保证这些工具"够得着"。
- `llama.cpp` 与工具系统关系最弱——它只是注册了一个 provider，这里列出来是为了让你知道"内置扩展"这个类别下都有谁。

也就是说：**这一章讲的所有机制（暴露、loadout、嵌套调用、按需加载），在 Pi 自己的内置扩展里都被用上了。** 想学怎么用，读这四个扩展的源码就够了。

---

## 十、方法论提炼

回顾整个工具系统，有六个设计模式值得在自己的 Agent 项目中复用：

**1. 分层接口递进法**：基础层只管"能描述"（Tool），运行时层加"能执行"（AgentTool），产品层加"能展示和扩展"（ToolDefinition）。通过包装器桥接层间差异。

**2. 管道+钩子模式**：核心流程是一条管道（prepare → validate → execute），管道前后各有一个钩子（before/after），可以拦截或修改。管道内的每一步出错都不抛异常，统一编码为正常消息。

**3. 错误即消息原则**：工具执行的每一步出错，都统一编码成一条 `isError: true` 的 ToolResultMessage 发给模型。0.99 起有两条产生错误的路：可预期的失败由工具自己 `return { isError: true }`，未知异常由框架 `error instanceof Error ? error.message : String(error)` 兜底。绝不让原始异常穿透打断 Agent Loop。

**4. Operations 抽象法**：工具不直接调用系统 API，而是通过最小化的 Operations 接口间接调用。测试可以 Mock，远程可以 SSH，不改工具代码。

**5. 暴露与声明分离**：注册 ≠ 模型可见。用 `exposure` / `namespace` / `defaultActive` / `prepareLoadout` 控制"工具怎么被模型看见"，用 `getActiveTools()` / `setActiveTools()` 管理活跃集合。工具多起来时，这是保护上下文预算的关键。

**6. 结构化输出契约**：`outputSchema` 声明结构，`structuredContent` 承载机器可读结果，与面向模型的 `content` 分离；连错误结果也保留结构化内容。同一个工具，同时服务模型和程序化调用者。

---

## 十一、收尾

回到开场的问题："当模型说'读取这个文件'，到底发生了什么？"

现在你有完整答案了：

```
前提：read 是 direct 暴露的活跃工具 → 已随请求声明给模型（§二）
    │
模型输出 ToolCall { name: "read", arguments: { path: "src/main.ts" } }
    │
    ├── 第 1 步：prepareArguments 处理模型怪癖
    ├── 第 2 步：validateToolArguments 做 Schema 验证（pi-ai 层）
    ├── 第 3 步：beforeToolCall 检查权限
    ├── 第 4 步：tool.execute 通过 Operations 接口读文件
    │              └── ops.readFile() → 不直接调 fs
    └── 第 5 步：afterToolCall 做结果后处理
    │
    ▼
ToolResultMessage { content: 文件内容, structuredContent?, isError: false }
    │
    ▼ 追加到对话历史，下一轮发给模型
```

工具不是简单的函数调用，而是一条受控管道。而且"工具能不能被模型调用"本身也有一层筛选——参数验证挡住垃圾数据，钩子拦截住危险操作，暴露模型决定谁可见，Operations 抽象让同一份代码既能本地跑也能远程跑。所有工具错误——从参数验证失败到 execute 抛出的未知异常——都被翻译成一条 `isError: true` 的 ToolResultMessage 发给模型，让模型自己决定下一步，循环永远不会因为工具出错而崩（0.99 起可预期的失败也可以由工具直接 `return { isError: true }`）。

但还有一个问题：工具执行时发出的 `tool_execution_start`、`tool_execution_update`、`tool_execution_end` 事件，到底是谁在监听？Agent 内核为什么完全不需要知道 UI 的存在？

下一章，我们打开 Agent 的"记忆系统"——消息系统。不，等等——在那之前，还有一个更基础的问题：这些消息到底长什么样？工具结果消息、模型回复消息、用户输入消息，它们的结构是什么？Agent 内部的消息和发给模型的消息一样吗？

---

> **本章关键源码索引**（均为「符号名 + 文件路径」，对照 1.0.3）：
> - `packages/ai/src/types.ts` — `Tool`（第一层，含 `constrainedSampling`）、`ToolCall`、`ToolResultMessage`（含 `usage` / `nestedCalls` / `NestedToolCalls`）
> - `packages/agent/src/types.ts` — `AgentTool`（第二层，含 `outputSchema` / `replay`）、`AgentToolResult`（含 `structuredContent` / `usage` / `isError?`）、`ToolExecutionMode`
> - `packages/coding-agent/src/core/extensions/types.ts` — `ToolDefinition`（第三层，含 `exposure` / `namespace` / `annotations` / `defaultActive` / `prepareLoadout`）、`ToolExposure`、`ToolNamespace`、`ToolAnnotations`、`ToolLoadout` / `ToolLoadoutChanges`、`ExtensionToolContext`（含 `executeTool`）
> - `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts` — `wrapToolDefinition`（包装器）、`ToolContextFactory`
> - `packages/ai/src/utils/validation.ts` — `validateToolArguments`（第 2 步，已迁至 pi-ai 层）、`validateToolCall`
> - `packages/agent/src/agent-loop.ts` — `prepareToolCall`（前 3 步）、`executePreparedToolCall`（第 4 步 + 兜底 catch，`isError: result.isError === true`）、`finalizeExecutedToolCall`（第 5 步）、`createErrorToolResult`、`runToolCall`（嵌套调用入口）、`executeToolCalls` / `executeToolCallsSequential` / `executeToolCallsParallel`
> - `packages/coding-agent/src/core/agent-session.ts` — `_applyToolLoadout` / `setActiveToolsByName` / `_getCallableTools`（活跃工具与 loadout）
> - `packages/coding-agent/src/core/nested-tool-calls.ts` — `NestedToolCallRunner`、`NestedCallRecorder`、`NESTED_CALL_LIMITS`
> - `packages/coding-agent/src/core/tools/bash.ts` — `createShellToolDefinition`（非零退出返回 `isError: true` + `structuredContent`）、`bashOutputSchema`、`BashOperations`、`createLocalShellOperations`
> - `packages/coding-agent/src/core/tools/read.ts` — `ReadOperations`、越界抛错附文件总行数
> - `packages/coding-agent/src/core/tools/edit.ts` — `EditOperations`、`withFileMutationQueue` 的调用处
> - `packages/coding-agent/src/core/tools/index.ts` — `ToolName` / `allToolNames`（8 个内置工具，含 `powershell`）
> - `packages/coding-agent/src/core/tools/truncate.ts` — `truncateHead` / `truncateTail` / `truncateLine` / `truncateMiddle` / `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`
> - `packages/coding-agent/src/core/tools/output-accumulator.ts` — `OutputAccumulator` / `readFullOutput`
> - `packages/coding-agent/src/extensions/index.ts` — `builtInExtensions`
> - `packages/coding-agent/src/extensions/codemode/tool.ts` — `createCodemodeToolDefinition`（`model-only` + `prepareLoadout`）
> - `packages/coding-agent/src/extensions/tool-search/tool.ts` — `createToolSearchToolDefinition` / `Bm25Ranker`（按需加载工具）
> - `packages/coding-agent/src/extensions/mcp/index.ts` — MCP 工具注册与曝光（`mcp__<server>__<tool>`）
> - `packages/coding-agent/src/extensions/mcp/tools.ts` — `toToolExposure`（配置 `codemode` → 核心 `deferred`）、`createMcpToolDefinition`、`createMcpToolName`
> - `packages/codemode/src/index.ts` — `CodemodeSandbox`（QuickJS/WASM 沙箱）、`parseCodemodeSource`、`CODEMODE_SOURCE_GRAMMAR`、`loadQuickJSWasm`、`renderDeclarations`、`toCodemodeIdentifier`
> - `packages/coding-agent/src/extensions/codemode/worker.ts` / `execute.ts` — coding-agent 与 codemode 沙箱的集成
> - `packages/coding-agent/docs/codemode.md` — codemode 脚本参考（globals、`store()`、`models`、限制）
> - `packages/coding-agent/docs/mcp.md` — MCP 配置、`/mcp` 命令、后台连接与 exposure
