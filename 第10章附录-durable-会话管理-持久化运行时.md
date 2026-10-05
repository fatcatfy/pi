# 第10章附录：durable 会话管理 —— 持久化运行时

> **定位**：本文是[第10章：会话管理](第10章-会话管理-对话的存储恢复与分叉-修订版-v2.md)的配套文档。主文档讲 **coding-agent 主线**的会话管理（`SessionManager`：同步、直写 JSONL、单 leaf、11 种 `SessionEntry`）；本篇讲 **`@earendil-works/pi-durable`** 的会话管理。两者是**不同层级**的两套实现，**不要混用**——完整对照见 §十二。
>
> **版本与状态**：`@earendil-works/pi-durable` 1.0.3。包 README 顶部明确标注 **Experimental**："The API changes without notice between releases." 本文随源码漂移，引用一律用「符号名 + 文件路径」，不写行号。
>
> **包内分层提醒**：durable 自身还分两层——底层的 `Session`（`packages/durable/src/session/session.ts`，负责提交、事务、观察、绑定存储）和上层的 `Harness`（在 `Session` 之上跑 agent、扩展、任务）。日常用的是 `Harness`；`session/session.ts` 是更底的一层。

---

## 一、它是什么

`@earendil-works/pi-durable`（`packages/durable/**`）是一个 **durable agent harness**（持久化 agent 运行时）。README 的开篇承诺是：

> 对话、模型轮次、工具调用以及你自己的状态，都在**被展示之前先提交到存储**；如果进程在一轮中途死掉，重新打开存储会从断点接着跑。

它建在两个包上：

- `@earendil-works/pi-ai`（`packages/ai`）—— 模型访问；
- `@earendil-works/chord`（`packages/chord`）—— 文档状态（`replicatedState`、Chord ops、`Context`）。

它自己的直接依赖只有四个（`packages/durable/package.json`）：`@earendil-works/chord`、`@earendil-works/pi-ai`、`diff`、`typebox`。

### 和 coding-agent 主线的层级关系（先记住）

| 层级 | coding-agent 主线 | durable |
|---|---|---|
| 包 | `@earendil-works/pi-coding-agent` | `@earendil-works/pi-durable` |
| 运行时（打开存储 + 跑 agent） | `AgentSession` / `AgentSessionRuntime` | **`Harness`** |
| 会话存储 / 转录 | `SessionManager` | `Conversation` + `Storage` |

**durable 平级于 coding-agent 的运行时层**（`AgentSession` / `AgentSessionRuntime`），**不是**平级于 `SessionManager`。`SessionManager` 只对应 durable 的转录/存储部分（`Conversation` + `Storage`）。

> **命名冲突提醒**：`Session` 这个名字在本仓库至少出现三处，含义都不同——coding-agent 的 `AgentSession`（运行时）、durable 底层的 `Session`（`session/session.ts`）、以及 agent-core 曾有、1.0.0 已删除的 `Session`。读代码先认清"这是哪个包的"。

---

## 二、核心模型

durable 的十个核心概念（README「Concepts」段）：

- **Harness** —— 一个打开的存储 + 在其上跑 agent 的机制。所有变更走**一条原子提交线**；提交被存储之前，任何东西都不对外展示。
- **Conversation** —— 一条转录（transcript）。`root()` 首次使用时创建根 conversation，还可创建更多并对它们 fork。`Conversation` 句柄**不带状态**，按 `id` 比较。
- **Entry** —— 一条不可变的转录记录，例如用户消息（`pi.user`）、模型响应（`pi.assistant`）、工具结果（`pi.tool-result`）、系统提示变更（`pi.system`）、一次重置（`pi.reset`），或你自己的 kind。**模型只看到"最新一次 reset 之后"的 entry。**
- **Commit** —— 一次原子写。`conversation.commit((tx) => ...)` 可以在一次提交里同时追加 entry、编辑 document、创建 task；要么全部落盘，要么全部不落。
- **Document** —— 与转录一起存放的、typed JSON 状态，在 commit 里修改。内建的几个：每个 conversation 的 agent 选择（`pi.agent`）、面向 provider 的会话身份（`pi.provider`）、正在跑的生成与工具（`pi.live`）、排队的提交（`pi.inbox`）、花费（`pi.usage`）。
- **Task** —— 一个 **durable state machine**，每一步都存 checkpoint，重启后从上个 checkpoint 继续。每个 task 都有 owner：它所属的 conversation，或另一个 task。Harness 把"回答"跑成内建 task：`pi.generation` 调用模型、拥有它工具调用的 `pi.tool` task、等待它们，再把这一轮交给下一次 generation。
- **Submission** —— 你交给 conversation 的东西（用户输入，或一条要写入的 entry），可以 `.wait()` 它。
- **Turn / run** —— 一个 turn 是一次模型响应及其工具调用；一个 run 是从一次输入到最终答案之间的若干 turn。conversation 在 run 进行期间是 **busy** 的。
- **Extension** —— 一个具名 bundle：tools、system prompt sections、hooks、wrappers、tasks。
- **Registry** —— 本进程安装的扩展集合，运行期间可变；新工作用新状态。
- **Agent** —— conversation 运行时用的东西：模型、思考级别、选中的扩展、工具、指令、工作目录。它按 conversation 存成一个 document（`pi.agent`，存的是**名字**），每次使用时再对着 registry 解析。

> **实现**：概念与 API 见 `packages/durable/README.md`；类型与装配见 `packages/durable/src/types.ts`、`packages/durable/src/harness/harness.ts`、`packages/durable/src/entries.ts`、`packages/durable/src/documents.ts`、`packages/durable/src/tasks.ts`。

---

## 三、一次输入的生命周期

README 给了一张精确的图——一次输入从提交到回答，落成了哪些 entry 与 task：

```text
submit(input) → pi.user
  pi.generation → pi.system (only if the prompt or tools changed), pi.assistant (tool calls)
    pi.tool × n → pi.tool-result × n   (owned by the generation, which waits for them)
  pi.generation → pi.assistant (answer) → submission done
```

用 Quick Start 走一遍：

```typescript
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;
const models = createModels();
models.setProvider(openaiProvider()); // reads OPENAI_API_KEY

const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
const root = await harness.root(context, { agent: { model: { provider: "openai", modelId: "gpt-6-sol" } } });

const submission = await root.submit({ type: "input", content: "What is the capital of France?" }, context);
const settled = await submission.wait(context);
if (settled.status === "done" && settled.type === "input") {
	const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	console.log(answer?.model?.[0]);
}
await harness.close(context);
```

发生了什么：

- `Harness.open()` 在一个存储后端上**打开一个 Session**；`MemoryStorage` 全部放内存。
- `root()` 返回根 conversation，首次使用时按给定 agent 选择创建。
- `submit()` **durable 地接纳**你的输入并返回一个 `Submission`；一个内建 generation task 调用模型并追加答案。
- `wait()` 在输入被回答（`done`）或失败（`unanswered`，带原因）时 resolve。

每一个异步调用都接收一个 Chord `Context`（携带取消）。`BACKGROUND_CONTEXT` 永不取消；取消一次 wait 只取消这次 wait，**绝不取消工作本身**。

> **与主线对照**：主线的"一次用户输入 → 一条 `message` entry → LLM 调用"在 durable 里被拆成了 `pi.user` + `pi.generation`（task）+ `pi.assistant`，其中 generation 与每个工具调用都是**可恢复的 task**。这是两者最本质的差别。

---

## 四、持久化与恢复（本章主线的对应物）

### 打开与恢复

```typescript
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const harness = await Harness.open(await openNodeSqliteStorage("./session.sqlite"), { models, registry }, context);
const root = await harness.root(context); // 与上次同一个 root
harness.resume(); // 继续上一个进程没跑完的任何 run
```

- 被崩溃或关闭打断的工作**保持 pending**。`resume()` 启动 task 调度器；`submit()` 或 `wait()` 也会启动它。
- 每个 conversation 在 `pi.provider` 里存一个**持久 UUIDv7**，作为 provider 的 `sessionId` 转发给 pi-ai，用于 prompt-cache 与会话亲和。它**跨 reopen / 重试 / reset / 压缩 / 换模型保留**；child 或 fork 拿到**新的**身份。

### 幂等提交

```typescript
const submission = await root.submit({ type: "input", content: "Hello", requestId: "greeting-1" }, context);
// 重启后用同一个 requestId：找到的是同一个 submission
const again = await root.submit({ type: "input", content: "Hello", requestId: "greeting-1" }, context);
// again.id === submission.id
```

`harness.submission(id)` 按 ID 重新获取一个 submission（例如重启后 `wait` 它）。

### 崩溃窗口

- **部分答案与工具输出**默认**最多每 100 ms 提交一次**，所以一次崩溃最多丢这个窗口。`settings.progress` 改间隔（远端存储的宿主可以调大，如 `{ partialIntervalMs: 500, outputIntervalMs: 500 }`）。
- **工具调用**：它的意图在 `execute()` 之前就已提交。进程在调用中途死掉时，只有声明了 `replay: "safe"` 的工具会在重开后**重跑**；否则模型收到一个 `interrupted` 错误结果，附带已经提交的输出。

> **与主线对照**：主线的 `SessionManager` 靠"每次 append 同步写 JSONL + 左到右重放"实现恢复，没有幂等提交、没有 checkpoint、没有进度节流。durable 的恢复是**任务级**的：每个 task 每步存 checkpoint，重启从 checkpoint 继续，而不是从头重放。

---

## 五、转录结构：Entry、reset 与 compaction

### Entry 类型

内建 kind（`packages/durable/src/entries.ts`）：

| kind | 含义 | 主线对应物 |
|---|---|---|
| `pi.user` | 用户输入 | `message`（user） |
| `pi.assistant` | 模型响应（含工具调用） | `message`（assistant） |
| `pi.tool-result` | 工具结果 | `message`（toolResult） |
| `pi.system` | 系统提示变更（位置型） | 无（主线用 `model_change` 等状态条目） |
| `pi.reset` | 一次上下文重置 | 无 |
| `pi.compaction` | 压缩摘要 + 首个保留 entry | `compaction`（`firstKeptEntryId` + `summary`） |

此外可以用 `tx.entry(SomeEntry, ...)` 追加**自定义 kind**（如 `app.note`）。

**reset 语义**：`reset()` 开启一个新上下文——模型不再看到更早的 entry，但它们**留在存储里**：

```typescript
await root.reset(undefined, context);                                  // 从零开始
await root.reset("We were fixing the flaky login test. Continue.", context); // 从一条 handoff 注记开始
```

busy 时 reset 会被排队（像一次 write）；在工具轮中放置时，当前 run 结束。工具也可以请求同样的效果：`control: { handoff: "..." }`。

### compaction

Compaction **缩小模型看到的内容**：把更早的 entry 摘要化，追加一条 `pi.compaction`（持有摘要，并指向它保留的第一个 entry）。更早的 entry 仍在存储里。

- **手动**：`root.compact("Keep the failing test names", context)`，返回一个 task id；可用 `harness.waitForTask(id, context)` 等它，再取 `outcome.result.submissionId` 对应的 submission。
- **自动**（受 `settings.compaction` 控制）：`enabled` / `reserveTokens` / `keepRecentTokens` / `backgroundTokens`。当 provider 因上下文过长拒绝请求时，generation 也会压缩并重试一次。
- 若一个摘要会切在当前上下文起点之前，它被放置时会 settle 成 `stale`；多个在飞时，**最靠后的切点生效**。摘要的花费计入 `pi.usage`。`CompactionTask` 上的 `beforeCompact` hook 可以拒绝或提供自己的摘要。
- 正在跑的压缩列在 `docs["pi.live"].compactions`（含 reason、attempt、retry backoff）。

### 系统提示与 prompt cache

系统提示由所选扩展的 **sections** 按顺序在每次请求前渲染。sections 与工具变更作为**位置型 system entry** 存进转录；因此**只重发变更的部分**，保持 provider 的 prompt cache 是热的。反过来，一个每次返回都不同的 section（比如当前时间）会破坏这个优化。

> **与主线对照**：主线把"压缩"存成 `compaction` 条目（`firstKeptEntryId` + `summary` + `tokensBefore`），把"系统提示/工具变更"隐式地靠模型/思考级别条目表达；durable 显式引入 `pi.system` 位置型 entry 与 `pi.reset`，并把 system prompt 的"只发变更"做成了一等目标。

---

## 六、文档：与转录一起提交的状态

**Document** 是与转录一起提交的 typed JSON。自己定义一个：

```typescript
import { defineDoc } from "@earendil-works/pi-durable";

const Todos = defineDoc<{ items: string[] }>({
	kind: "app.todos",
	version: 1,
	scope: "conversation",   // 或 "session"
	history: "latest",       // 或 "rewindable"（可配合 snapshotAsOf() 读旧值）
	fork: "initial",         // fork 起点："initial" | "current" | "asOf"
	initial: () => ({ items: [] }),
});

await root.commit(async (tx) => {
	(await tx.doc(Todos, root.id)).items.push("write docs");
}, context);
console.log(await harness.snapshot(Todos, root.id, context));
```

内建文档：`pi.agent`（agent 选择）、`pi.provider`（会话身份）、`pi.live`（在跑的生成/工具）、`pi.inbox`（排队提交）、`pi.usage`（花费）。

- `harness.watchDoc()` / `harness.documentState()` 观察单个文档，像 view 一样。
- `HarnessOptions.conversationCreated(tx, conversation)` 在每个"创建/ fork conversation"的 commit 里跑，所以每个 conversation 都能拿到你的文档；`createConversation()` / `fork()` / `root()` 的 `init` 在同一次 commit 里写每调用数据。

> **与主线对照**：主线把状态变量（模型、思考级别）**节点化**成 entry（`ModelChangeEntry`），回退时靠路径遍历自动回退；durable 把状态放进**文档**（`pi.agent` 等），与转录在**同一次原子 commit** 里更新。一个走"路径重放"，一个走"事务提交"。

---

## 七、任务系统：可恢复的状态机

这是 durable 相对主线最独特的一层。**Task 是 durable state machine，每一步保存 checkpoint**；重启后从上个 checkpoint 继续，而不是从头重放代码。

内建任务：`pi.generation`（调模型）、`pi.tool`（每次工具调用一个）、`pi.compaction`。

一个 task 的提交状态（`harness.taskGraph()` 里能看到）：

| 状态 | 含义 |
|---|---|
| `pending` | 已创建，尚未运行（重启后原本 `running` 的会显示为 `pending`，直到再次运行） |
| `running` | 正在执行 |
| `waiting` | 不跑代码，等它的子任务；带 `on`（等谁）与 `policy`（`allSettled` / `failFast`） |
| `completing` | 自身结果已定，但要等它拥有的工作做完才真正 terminal |

- **waiting**：`allSettled` 等 `on` 里全部完成；`failFast` 时第一个失败的子任务会 abort 其余。`on` 也可以点名别的 task。
- **finishing**：一个 task 完成时若它拥有的工作还在跑，就是 `completing`——结果已决定，但要等那份工作做完才 terminal、`waitForTask()` 才返回。失败或 abort 的结果会先 abort 那份工作。
- **aborting 自底向上**：abort 一个 task 会先 abort 它拥有的工作，它自己的 abort handler 等那份工作做完才启动，所以每个 task 只负责撤销自己的 effects。
- **`background: true`** 是一个**边界**：它拥有的工作能挺过父级 abort，也不让父级保持 busy；`root.abort(context, { background: true })` 可以连它一起 abort。

自定义 task 的骨架（`pay` / `decide` 两阶段）：

```typescript
pay: async (task, runtime, context) => {
	await runtime.commit(async (tx) => {
		const payments = [];
		for (const card of task.input.cards) {
			payments.push(await tx.createTask(Payment, { card }, { ownership: { kind: "task", taskId: task.id } }));
		}
		// 每笔都完成后在 `decide` 里继续；第一个失败会 abort 其余
		return { status: "waiting", checkpoint: { phase: "decide", payments }, on: payments, policy: "failFast" };
	}, context);
},
decide: async (task, runtime, context) => {
	const outcomes = await runtime.outcomes(task.state.checkpoint.payments, context);
	// ...提交 checkout 自己的结果
},
```

> **与主线对照**：主线**没有** task 这一层——工具调用是同步调用，没有 checkpoint、没有 owner、没有 wait 图。durable 把"agent 干活"整体建成任务图，这也是它能做到"中断续跑 + 子代理归属 + 可观测任务面板"的原因。

---

## 八、子代理与子任务

conversation 可以被一个 task **拥有**（`ownership`）。子代理工具在 `api.commit()` 里创建子 conversation，再用 `api.conversation(id)` 驱动它：

```typescript
execute: async (args, api, context) => {
	const child = await api.commit(async (tx) => {
		// ownership 索引记住了子 conversation，重跑会复用同一个
		const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
		if (existing !== undefined) return existing.id;
		// 起始 agent 是本 conversation agent 的副本：模型、扩展、工具、cwd
		const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
		await configure(tx, created.id, { model: haiku, extensions: { remove: [Subagent] } });
		return created.id;
	}, context);
	await api.details({ conversationId: child }, context); // 让 UI 能挂到子 conversation
	const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
	const settled = await (await (await api.conversation(child, context))!.submit(request, context)).wait(context);
	return { content: [{ type: "text", text: settled.status }] };
},
```

归属规则：

- abort 这次调用会 abort 子 conversation；调用失败（`execute()` 抛错，或崩溃打断了一个非 replay-safe 的调用）也一样。
- 父级要等子级 idle 才算 idle。
- `{ background: true }` 创建的 task 是边界：它拥有的工作能挺过父级 abort，也不让父级 busy。

README 的两个产品级范式：`test/examples/22-subagent-foreground.ts`（前台子代理，UI 把子事件缩进挂在调用下）、`test/examples/23-subagent-background.ts`（持久子代理：spawn / steer / stop / list，答案经后台 reporter task 回投给父级，`requestId` 防重启重复）。

---

## 九、可观测：UI 只需要看已提交状态

**一切 UI 需要的东西都是已提交状态。**

```typescript
const view = await root.viewState(context);   // 结构化视图，只读 Chord state
view.subscribe((value) => {
	// value.entries：当前生效的转录
	// value.docs["pi.live"]：在跑的 generation（流式 partial、retry、deferred）与工具调用（output、details）
	// value.docs["pi.inbox"] / ["pi.usage"] / ["pi.agent"] / ["pi.provider"]
	render(value);
});
// 之后：view.dispose();
```

- **`viewState()`** —— conversation 的结构化视图，任何触及它的 commit 之后更新。
- **`watch()`** —— 同样的视图，但**带每次提交精确的 Chord operations**，一次一个回调（适合发给远程客户端去 apply）。
- **`watchEvents()`**（Experimental）—— coding-agent 风格的事件流（`message_start` / `message_update` / `tool_execution_start`…），从 commit 派生，一个 commit 一批，带 delta（文本/思考追加、工具参数追加、输出 trim+append）；落后超过 100 批就收到新的 `snapshot`。
- **`taskGraph()`** —— 整个 Session 的活任务图（owner edge、状态、background/abort 标记、拥有的 conversation）；`watchTaskGraph()` 是它的 watch 版。
- **`harness.usage()`** —— 整个 Session 的 token 与花费总计（按 `provider/model` 与 tool 名）。

慢消费者语义：一个落后的 watch **最多保留 100 个未投递帧**，超过后用一个"最新完整视图"取代待发帧；**晚加入或重连的客户端从当前视图开始，不重放**。

> **与主线对照**：主线没有"结构化可订阅状态"这一层——UI 直接读 `SessionManager` 的树。durable 把"给 UI 的状态"做成 `viewState()`/`watch()` 的一等产物，coding-agent 的实验区正是把 `viewState()` 当作 Transcript service 暴露出去。

---

## 十、配置：settings、env 与 per-conversation agent

### settings（不存储，每次读）

```typescript
const harness = await Harness.open(storage, {
	models, registry,
	settings: {
		extensions: [CodingTools, Coding],       // 默认选中；缺省即"所有已安装扩展"
		stream: { timeoutMs: 120_000 },
		retry: { maxRetries: 3 },
		compaction: { reserveTokens: 16384 },
		progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
		toolExecution: "parallel",
		get followUpMode() { return userSettings.followUpMode; }, // getter ⇒ 实时
	},
}, context);
```

settings 是跨 conversation 共享的**运行策略**，每次使用都重新读取、**从不存储**；用 getter 可以让它跟着设置文件实时变化。

### env（每次调用构建）

`env` 为每个工具调用、section 渲染构造执行环境；它拿到 conversation 的 ID、agent 的 `cwd` 和已提交的读取，所以一个函数可以做到"每个 conversation 一个目录"或"每个 conversation 一个容器"：

```typescript
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const harness = await Harness.open(storage, {
	models, registry,
	env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
}, context);
```

每次调用一个新环境对象没问题：`edit` / `write` 按环境的 `id` + 路径串行化对同一文件的修改；自定义 `ExecutionEnv` 设好 `id`，相等的 id 就代表"同一批文件、同一批路径"。宿主也可以直接用环境（`openBinaryReader()` / `openDirReader()` / `exec()`）。

### per-conversation agent

每个 conversation 把"用什么跑"存在 `pi.agent` 里；`configure()` 一次提交改它：

```typescript
await root.configure({ model: { provider: "openai", modelId: "gpt-6-sol" }, cwd: "/work/repo" }, context);
await root.configure({ tools: null }, context);          // null ⇒ 清回宿主默认
const agent = await root.agent(context);                  // 解析后的：模型、扩展、工具、sections、cwd
```

扩展和工具以**对象**传入、以**名字**存储，所以存储的名字能比代码活得久：扩展被卸载后，选中它的 conversation 暂时拿不到它，直到它被重新安装。

> **与主线对照**：主线的 `model` / `thinkingLevel` 是**转录里的 entry**，随路径回退；durable 是 `pi.agent` **文档**，`configure()` 一次原子提交，且能按 conversation 各自不同。

---

## 十一、存储后端

| 后端 | 导入 | 语义 |
|---|---|---|
| Memory | 包根 `MemoryStorage` | 什么都不持久化 |
| SQLite | `openNodeSqliteStorage(file)`（`@earendil-works/pi-durable/storage/sqlite/node`） | 一个数据库文件；WAL + `synchronous = NORMAL`——**提交能挺过进程崩溃**，最新一次提交在断电/宿主故障时可能丢 |
| JSONL | `openNodeJsonlStorage(dir, context)`（`@earendil-works/pi-durable/storage/jsonl/node`） | 一个目录里的 append-only 文件；`{ fsync: true }` 在每个 commit marker 前 flush |

- **一个进程同一时刻独占一个 storage**；**没有跨进程锁**。
- 可移植的 SQLite / JSONL 核心（`/storage/sqlite`、`/storage/jsonl`）不依赖 Node API，可在 Bun 或 Cloudflare Durable Objects 上跑，只要能提供异步 `SqliteDatabase` 门面或 `@earendil-works/pi-durable/env` 的 `FileSystem`。
- 自定义后端可用共享的一致性测试：`registerStorageConformance()`（环境则用 `registerEnvConformance()`），都在 `@earendil-works/pi-durable/testing`。

> **与主线对照**：主线的 `SessionManager` **只有 JSONL 一档**、无接口、无一致性测试；durable 提供 Memory / SQLite / JSONL 三档**可替换后端**，并给自定义后端一套 conformance suite。

---

## 十二、与 coding-agent 主线的完整对照

| 维度 | coding-agent `SessionManager` | durable `Harness` |
|---|---|---|
| **所在** | `packages/coding-agent`（产品主线） | `packages/durable`（独立包，Experimental） |
| **包级平级对象** | `@earendil-works/pi-coding-agent` | `@earendil-works/pi-durable` |
| **运行时平级对象** | `AgentSession` / `AgentSessionRuntime` | `Harness` |
| **存储/转录平级对象** | `SessionManager` | `Conversation` + `Storage` |
| **API 风格** | 同步（`appendFileSync` 等） | 异步 + 事务 `commit((tx) => ...)` |
| **最小提交单位** | 一条 entry 同步 append | 一次原子 commit（entries + docs + tasks 一起） |
| **转录结构** | append-only 树（`parentId` + 单 `leafId`） | conversation 的 entry 序列（`pi.reset` 划上下文） |
| **状态变量** | 节点化 entry（`model_change` 等） | document（`pi.agent` / `pi.provider` / …） |
| **分支模型** | 单 leaf；`branch` / `branchWithSummary` | `createConversation` / `fork(entryId)` / ownership |
| **任务/子代理** | 无内建 task（子代理是另一层机制） | 一等 `Task`，checkpoint、waiting、owner 归属、background 边界 |
| **崩溃恢复** | 重放 JSONL | task 从 checkpoint 续跑；幂等 `requestId`；进度 100 ms 节流 |
| **可观测** | 直接读树 | `viewState()` / `watch()` / `watchEvents()` / `taskGraph()` |
| **存储后端** | 仅 JSONL（+ `inMemory()` 纯内存） | Memory / SQLite / JSONL（可替换，附一致性测试） |
| **是否随包发布** | 是 | 是（独立包），但**不被 coding-agent 依赖** |

### 怎么选

1. **只是普通用 Pi coding agent** —— 你用的是主线 `SessionManager`，durable **不参与**（它不在 coding-agent 的依赖里；coding-agent 只在源码-only 的实验区用到它）。
2. **要"可替换的持久化后端 / 事务提交 / 中断续跑 / 子代理归属 / 任务面板"** —— 用 durable，但要接受：Experimental、API 会变、与主线**不是**同一套类型（`Conversation`/`Entry` vs `SessionManager`/`SessionEntry`），互通必须自己写适配层。
3. **想做 coding-agent 的实验版 client/server** —— 参考 `packages/coding-agent/src/experimental/`：`session-worker.ts`（`Harness.open(openNodeSqliteStorage(...))`）、`services/**`（把 `Conversation.viewState()` 当 `ReplicatedState` 暴露）。注意这套要 `PI_EXPERIMENTAL=1` 启用，且不随包发布。

---

## 十三、关键源码索引

引用一律用「符号名 + 文件路径」，不写行号。

> - `packages/durable/README.md` —— 概念、API、存储、示例的权威说明
> - `packages/durable/src/harness/harness.ts` —— `Harness`（`open` / `root` / `resume` / `createConversation` / `submission` / `taskGraph` / `usage` / `snapshot`）
> - `packages/durable/src/harness/generation.ts` —— 内建 `pi.generation` 任务
> - `packages/durable/src/harness/tool.ts` —— 内建 `pi.tool` 任务、`defineTool`、`replay: "safe"`
> - `packages/durable/src/harness/compaction.ts` —— `pi.compaction` 任务、`beforeCompact` hook
> - `packages/durable/src/harness/agent.ts` / `prompt.ts` / `registry.ts` —— per-conversation agent、system sections、扩展注册表
> - `packages/durable/src/harness/view.ts` / `events.ts` / `live.ts` / `inbox.ts` / `usage.ts` / `provider.ts` —— `viewState` / `watchEvents` / `pi.live` / `pi.inbox` / `pi.usage` / `pi.provider`
> - `packages/durable/src/harness/task-graph.ts` / `scheduler.ts` / `submissions.ts` —— 任务图、调度、submit/wait
> - `packages/durable/src/session/session.ts` / `transaction.ts` / `forks.ts` / `observation.ts` —— 底层 Session、提交事务、fork、观察
> - `packages/durable/src/storage/memory.ts` —— `MemoryStorage`
> - `packages/durable/src/storage/sqlite/storage.ts` / `database.ts` / `node.ts` —— SQLite 后端与可移植核心
> - `packages/durable/src/storage/jsonl/storage.ts` / `node.ts` —— JSONL 后端
> - `packages/durable/src/tools/index.ts` —— `read` / `write` / `edit` / `bash` 与 `CodingTools`
> - `packages/durable/src/env/node.ts` —— `NodeExecutionEnv`
> - `packages/durable/src/testing/index.ts` —— `registerStorageConformance` / `registerEnvConformance`
> - `packages/durable/src/entries.ts` / `documents.ts` / `tasks.ts` —— Entry / Document / Task 类型与 `defineDoc`
> - `packages/durable/test/examples/` —— 00–31 号可运行示例（14 起是完整 agent 示例；22/23/24 是子代理与子任务）
> - `packages/durable/docs/spec.md` —— 规范（normative specification）；`docs/pico-v5-handoff.md` 是实现计划；`docs/pico-v5-chord-usage.md` 是它对 Chord 的用法
