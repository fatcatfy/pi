# 08 - 辅助包：pi-telemetry / sqlite 会话后端 / pi-evals

本篇覆盖三个支撑性包：遥测契约（`packages/telemetry`）、SQLite 会话存储后端（`packages/session-backends/sqlite-node`）与行为化评估框架（`packages/evals`）。它们不处于请求主链路上，但分别解决了可观测性、持久化替代后端与质量评估三个工程问题。

[← 返回目录](Home.md) | 上一节：[07-RPC 协议栈](07-rpc-stack.md) | 下一节：[09-依赖关系](09-dependencies.md)

---

## 1. @earendil-works/pi-telemetry（packages/telemetry）

### 1.1 定位

厂商中立的遥测契约包。它只定义"遥测长什么样"，不绑定任何后端：

- 显式、基于回调的 `TelemetryContext` / `TelemetrySpan` 契约；
- 共享的 `NOOP_TELEMETRY_CONTEXT`（禁用遥测时的零开销实现）；
- 参考实现 `InMemoryTelemetryContext`（进程内捕获，用于测试与本地诊断）；
- 可序列化的 schema 定义与 TypeScript 类型推导工具；
- 适配器一致性测试套件（`/testing` 子路径）。

**刻意不提供**：exporter、全局 current-span 状态、对 OpenTelemetry/Sentry 等后端的依赖。应用可以自带适配器把这些通用概念桥接到任意后端。

### 1.2 核心概念

| 概念 | 含义 |
|------|------|
| Span | 一次带计时的操作记录（如"加载账号"、"发起 LLM 请求"） |
| 父子 Span | 操作嵌套形成树，展示时间花在哪里 |
| Attribute | 挂在 span 上的命名事实，如 `provider: "openai"` |
| Event | span 生命周期中的某次瞬时事件（无时长），可带属性 |
| Status | 结果：`ok` 或 `error`（可附错误名与消息） |
| Context | 标识新工作在 span 树中归属的句柄；span 本身也是子 context |

### 1.3 核心类型与函数（src/index.ts）

```ts
// 契约：startSpan 包裹回调，回调持有 span；没有公开的 end()
export interface TelemetryContext {
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}

// span 可记录属性/事件/状态，同时自身作为子 context
export interface TelemetrySpan extends TelemetryContext {
	addEvent(name: string, attributes?: SpanAttributes): void;
	setAttributes(attributes: SpanAttributes): void;
	setStatus(status: SpanStatus): void;
}
```

关键设计点：

- **回调管理生命周期**：`startSpan()` 拥有 span 的结算（settlement）。回调返回的 Promise 结算前 span 保持打开；正常完成视为 `ok`，抛出/拒绝视为 `error`，显式 `setStatus()` 优先。适配器必须在结算后忽略后续调用（inert）。
- **属性值受限**：`AttributeValue = string | number | boolean | readonly (string|number|boolean)[]`。刻意排除自由文本与二进制，避免把 prompt、凭据、工具输出等敏感数据写进遥测。
- **无环境状态**：不使用 `AsyncLocalStorage` 等 ambient context API，父 context 通过参数显式传播，因此可运行于 Node、Bun、浏览器与 Worker。

### 1.4 类型化 Schema

低层 API 接受开放的名称与属性包（适配器需要通用性）；领域包则可定义封闭、可序列化的 schema，并从中推导精确类型：

```ts
export const EXAMPLE_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {
		"example.read": {
			description: "Read one resource",
			parents: { kind: "any" },          // any | root_or_external | spans: [...]
			startAttributes: {                  // 创建时传入，声明 required
				"example.resource": { type: "string", required: true, values: ["account", "project"], ... },
			},
			endAttributes: {                    // 完成时补充，永远可选
				"example.item_count": { type: "number", ... },
			},
			events: {
				"example.cache": {
					attributes: { "example.cache.hit": { type: "boolean", required: true, ... } },
				},
			},
			status: { default: "ok", errorWhen: "The read throws or returns an error result" },
		},
	},
} as const);

// 将 context 绑定到一个或多个 schema 的词汇表
const startSpan = createTypedSpanStarter(telemetryContext, [EXAMPLE_SCHEMA]);

await startSpan("example.read", { "example.resource": "account" }, async (span, startChildSpan) => {
	span.addEvent("example.cache", { "example.cache.hit": true });
	span.setAttributes({ "example.item_count": 3 });   // 只接受该 span 声明的 end 属性
	await startChildSpan("example.read", { "example.resource": "project" }, async () => { ... });
});
```

类型系统会拒绝：缺失必填属性、未知键、越出封闭值集的值、未声明的事件、跨 schema 重复的 span 名（编译期检查，运行时不做 schema 校验）。

**startAttributes 与 endAttributes 的语义**：描述"属性何时可知"，而非两份存储——两者最终都是同一个后端 span 上的普通属性。"end" 指完成时的补充信息，可在回调活跃期任意时刻设置，也可缺省（早失败、取消、provider 特有数据缺失等场景）。

### 1.5 与 pi 各包的分工

| 包 | 遥测职责 |
|----|----------|
| `pi-telemetry` | 拥有中立契约、NOOP/in-memory 实现、schema 工具、适配器一致性套件 |
| `pi-ai` | 在 provider 请求选项中接受并传播 `telemetryContext`，但不拥有 schema |
| `pi-agent-core` | 拥有并导出 pi 的 AI 请求与 harness 遥测 schema：`AGENT_TELEMETRY_SCHEMAS`（含 `AI_TELEMETRY_SCHEMA`、`HARNESS_TELEMETRY_SCHEMA`）及类型化入口 `startAiSpan` / `startHarnessSpan`，命名空间为 `pi.ai.*` / `pi.harness.*` / `pi.session.*` |

### 1.6 适配器一致性套件（src/testing/）

`createTelemetryAdapterConformance()` 生成与测试 runner 无关的分组用例。测试方提供 fixture（新 context + 归一化快照读取器），套件校验：同步单次准入回调、结果/拒绝恒等、自动与显式状态、属性合并、事件顺序、结算后的惰性调用、嵌套与并发父子关系、遥测负载故障的抑制。用于验证自研适配器是否满足 [1.3](#13-核心类型与函数srcindexts) 列出的全部契约语义。

### 1.7 目录结构

```
packages/telemetry/
├── src/
│   ├── index.ts          # 契约类型 + schema 类型推导 + createTypedSpanStarter
│   ├── noop.ts           # NOOP_TELEMETRY_CONTEXT（共享冻结的惰性 span）
│   ├── memory.ts         # InMemoryTelemetryContext / RecordedTelemetrySpan
│   └── testing/          # 适配器一致性套件（Node assert，root 包保持运行时中立）
└── test/                 # conformance.test.ts / telemetry.test.ts
```

---

## 2. @earendil-works/pi-session-backend-sqlite-node（packages/session-backends/sqlite-node）

### 2.1 定位

基于 Node 内置 `node:sqlite`（`DatabaseSync`）的 [pi-agent-core Harness Session](03-package-agent.md#64-session-持久化harnesssession) 存储后端，是默认 JSONL 后端之外的可选持久化实现。依赖 `pi-ai` 与 `pi-agent-core`，运行时零第三方依赖（直接用 Node 22+ 内置 SQLite）。

### 2.2 使用方式

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { createNodeSqliteFactory, SqliteSessionRepo } from "@earendil-works/pi-session-backend-sqlite-node";

const repository = new SqliteSessionRepo({
	directory: "/var/lib/pi/sessions",
	databaseFactory: createNodeSqliteFactory(),
});

const session = await repository.create({}, BACKGROUND_CONTEXT);
const main = await session.createBranch("main", null, BACKGROUND_CONTEXT);
await main.appendMessage({ role: "user", content: "hello", timestamp: Date.now() }, BACKGROUND_CONTEXT);
await session.close(BACKGROUND_CONTEXT);
await repository.close(BACKGROUND_CONTEXT);
```

### 2.3 存储布局与关键类

```
packages/session-backends/sqlite-node/src/
├── index.ts              # createNodeSqliteFactory + wrapNodeSqliteDatabase + 再导出
└── sqlite/
    ├── repo.ts           # SqliteSessionRepo：仓库（create/open/fork/delete/list/close）
    ├── storage.ts        # SqliteStorage：单库 Session 持久化
    ├── session/          # 会话内部结构
    │   ├── session-row.ts        # session 元数据行
    │   ├── session-sequences.ts  # 序列号分配
    │   ├── entries.ts            # 追加条目（entries 表）
    │   ├── branch-entries.ts     # 分支条目
    │   ├── values.ts             # 值存储（values 列表）
    │   ├── usage-ledger.ts       # 用量台账
    │   └── session-stats.ts      # 会话统计
    ├── migrations.ts + migrations/001_initial.sql   # schema 迁移
    ├── sql.ts            # sql 模板标签（sql`BEGIN IMMEDIATE` 风格）
    └── types.ts          # SqliteDatabase / SqliteDatabaseFactory 等抽象
```

关键点：

- **每个 Session 一个数据库文件**。默认在 `directory` 下按 ID 命名：仅含 ASCII 字母/数字/`_`/`-` 的 ID 使用 `{sessionId}.sqlite`；其他 ID 使用 `~` 前缀的 base64url（UTF-16 码元）编码。持久 ID 不变，元数据中返回规范物理路径。传 `databasePath` 可把多个 Session 放进同一个受支持的共享容器。
- **`SqliteDatabase` 抽象**（[src/sqlite/types.ts](../packages/session-backends/sqlite-node/src/sqlite/types.ts)）：`prepare / exec / transaction / close` 的同步接口。`createNodeSqliteFactory()` 区分三种打开方式——`open`（有意创建）、`openExisting`（读写但不创建）、`openReadOnly`（只读）。`transaction()` 强制同步回调，用 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` 包裹。
- **SQL 模板**：`sql`...\`\` 标签构造语句，统一经 `SqliteStatement` 的 run/get/all/iterate 执行，支持位置与命名参数。

### 2.4 所有权与并发模型（重要约束）

- **单一可写所有者由宿主生命周期保证**，不由本后端保证：直接在另一个进程写打开同一 Session 不受支持。仓库会拒绝同一 ID 的本地重叠 create/open/fork/delete，但**不实现**跨进程租约、锁、栅栏、心跳或接管。
- `open()` 与删除会拒绝配置目录之外的元数据，且永不创建缺失的数据库；列表是只读、尽力而为的。
- **Fork 语义**：fork 同仓库内打开的源时，快照排在源的 commit 队列上；其他源（包括活的 Session worker 持有的）使用独立只读连接 + 一个延迟 WAL 事务，后续 worker 提交可在快照仍打开时完成。Fork 刻意允许外部源元数据路径：精确读取该容器，绝不替换为同 ID 的本地活动 Session。
- 共享容器删除只移除所选 Session 的行；仓库 close 会等待所有打开 Session 的清理尝试结束后再报错。
- 本包**不**导出搜索服务或 FTS 索引——搜索是独立的 S3 投影（规划中）。

### 2.5 迁移

`src/sqlite/migrations/001_initial.sql` 建立初始 schema；`migrations.ts` 按序应用未执行的迁移并记录进度。构建脚本 `scripts/copy-migrations.mjs` 在 `npm run build` 后把 SQL 文件复制进 `dist/`。

---

## 3. @earendil-works/pi-evals（packages/evals）

### 3.1 定位

私有工作区包（`"private": true`，不发布）。基于 [vitest-evals](https://github.com/getsentry/vitest-evals) 的**行为化、模型背书**的评估框架：把真实的 `AgentSession` 适配为 eval harness，在隔离的临时项目/agent 目录中运行，并附带原生 Pi 会话产物。用于度量端到端行为，比较 prompt、工具、skills、模型或 harness 配置的差异。

### 3.2 运行方式

```bash
# 从仓库根目录：必须同时给出 provider 与 model
npm run eval -- --provider openai --model gpt-5.6-sol

# 或等价的环境变量
PI_PROVIDER=openai PI_MODEL=gpt-5.6-sol npm run eval

# 透传 Vitest 参数：指定文件或用 -t 过滤
npm run eval -- src/extensions.eval.ts
npm run eval -- -t "creates, reloads, and uses"
```

认证走 Pi 正常的 `ModelRuntime`（订阅凭据或 provider API key 环境变量）。每次调用打印被忽略的 `.eval/` 产物目录：`runs.jsonl` 索引已完成的 harness 运行及其原生会话 JSONL 附件（`sessions/`），**这些文件可能包含 prompt、响应、源码与工具输出**。

### 3.3 核心：createPiCodingAgentHarness（src/pi-harness.ts）

```ts
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createPiCodingAgentHarness } from "./pi-harness.ts";

const harness = createPiCodingAgentHarness({ noTools: "all" });

describeEval("Pi smoke", { harness }, (it) => {
	it("answers a factual question", async ({ run }) => {
		const result = await run("What is the capital of France? Reply with only the city name.");
		expect(result.output).toBe("Paris");
	});
});
```

`createPiCodingAgentHarness(...)` 选项：

| 选项 | 说明 |
|------|------|
| `name` | 稳定的 harness 身份，用于报告与比较 |
| `model` | `{ provider, id }` 显式选模，覆盖 runner 默认 |
| `noTools` | Pi 的工具禁用配置 |
| `transformSystemPrompt` | eval 开始前变换完整默认 prompt |
| `output` | 把最终响应 + `AgentSession` 变换为 JSON 安全的领域结果 |

一次 `run()` 接受单个 prompt 或"prompt / reload 步骤序列"——reload 步骤用于前一条 prompt 创建或修改了 Pi 资源（如扩展）后再使用它的场景：

```ts
const result = await run([
	{ type: "prompt", content: "Create a Pi extension." },
	{ type: "reload" },
	{ type: "prompt", content: "Use the extension." },
]);
```

实现要点（src/pi-harness.ts）：

- `resolveModelSelection()`：显式 model 优先，其次 `PI_PROVIDER` / `PI_MODEL`，两者必须成对出现；
- 用 `createAgentSessionFromServices` + `createAgentSessionServices` 在 `mkdtemp` 的隔离目录中组装真实 `AgentSession`；
- `toTranscriptEvents()`：把 `session.messages` 归一化为 vitest-evals 的 `TranscriptEvent[]`（user/assistant 消息、tool_call、tool_result，含错误标记）；
- `promptAgent()`：驱动 `session.prompt()`，校验以 `stopReason === "stop"` 结束且产出非空文本，否则抛错；
- 会话 JSONL 在删除临时工作区前被快照，经 eval 专用 `afterEach` 钩子注册到显式的 Vitest 测试任务（在 reporter 运行前）。

### 3.4 比较型评估：evalHarnessTable

用 `evalHarnessTable(...)` + Vitest 原生 `describe.for(...)` 让相同输入跑在多个 harness 上（可按 prompt、工具、skills、模型等任意维度差异）：

```ts
const TargetTaskJudge = createJudge<string, string>("TargetTaskJudge", ({ output }) => ({
	score: output === "expected result" ? 1 : 0,
}));

const harnessTable = evalHarnessTable("target skill effectiveness", {
	baseline: withoutTargetSkillHarness,
	candidate: withTargetSkillHarness,
	repetitions: 6,
});

describe.for(harnessTable)("$name repetition $repetition", ({ harness }) => {
	describeEval("target skill effectiveness", { harness, judges: [TargetTaskJudge], judgeThreshold: null }, (it) => {
		it("completes the target task", async ({ run }) => {
			await run("Complete the target task.");
		});
	});
});
```

比较报告的规则：

- 正确性用确定性或模型背书的 judge 记录，且设置 `judgeThreshold: null`——低分只是观察值，**不**让 Vitest 调用失败；硬断言只用于套件不变量与基础设施契约（`expect.soft` 仍会失败测试，不是评分机制）；
- harness 名在 eval 集合内必须稳定且唯一；分组键 = repetition ×（非空 `input.id` 或输入的 SHA-256 规范 JSON 哈希）；
- 每个 candidate 只与声明的 baseline 比较；对每组匹配的 input+repetition，reporter 用各 run 的平均 judge 分计算通过率提升（lift = candidate 通过率 − baseline 通过率，按百分点），分数 ≥1 记为通过，缺失 judge 分记为不完整观察；
- token、延迟、估算成本作为独立的 candidate−baseline 配对差值报告。

### 3.5 目录结构

```
packages/evals/
├── scripts/run-evals.mjs        # npm run eval 入口（模型解析 + 转发 Vitest）
├── src/
│   ├── pi-harness.ts            # createPiCodingAgentHarness（核心适配器）
│   ├── smoke.eval.ts            # 冒烟 eval
│   ├── extensions.eval.ts       # 扩展系统行为 eval
│   └── vitest-evals/
│       ├── harness-table.ts     # evalHarnessTable：比较型评估表
│       ├── artifacts.ts         # PI_SESSION_SNAPSHOT_ARTIFACT 等产物常量
│       ├── reporter.ts          # 比较报告（lift/配对差值）
│       ├── summary.ts           # 汇总
│       └── setup.ts             # vitest-evals 集成设置
└── test/                        # 框架自测（不依赖真实 LLM）
```

---

## 4. 小结

| 包 | 解决的问题 | 关键取舍 |
|----|-----------|----------|
| `pi-telemetry` | 可观测性 | 只定契约不绑后端；显式 context 传播；属性值限制为原始标量/数组 |
| `pi-session-backend-sqlite-node` | 持久化替代后端 | 每 Session 一文件；同步 `node:sqlite`；所有权交给宿主生命周期，不做跨进程锁 |
| `pi-evals` | 质量评估 | 复用真实 `AgentSession` 而非 mock；judge 评分不阻断测试；产物含完整会话 JSONL |
