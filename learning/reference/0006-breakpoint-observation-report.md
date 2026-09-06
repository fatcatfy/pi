# 关键断点位置观察报告（10 站全链路 · Interactive 模式实测）

> 实践日期：2026-09-06 · 模型：`deepseek-v4-flash`（`DEEPSEEK_API_KEY`=`sk-388e...8d46`）
> 运行命令：`pi --model deepseek-v4-flash --approve`（伪终端内运行）
> 方法：CDP（Chrome DevTools Protocol）直连 `node --inspect-brk`，`--approve` 跳过项目信任确认；断点行号经内联 sourcemap 从源码行:列映射到压缩 bundle 的精确 line:column。
> 原始数据：`learning/.tmp/pi-cdp-trace.jsonl`（324 条）

## 断点链路

```
cli.ts → main.ts → createAgentSessionServices（服务组装，含认证解析）
       → createAgentSessionRuntime（Runtime 创建）
       → InteractiveMode 构造（TUI 创建）
       → run() → getUserInput()（主循环等待输入）
       → session.prompt()（消息发送）
       → runAgentLoop（Agent 循环）
       → streamAssistantResponse（LLM 调用）
```

## 10 个断点：位置与观察结果

### BP1 CLI 入口 — `packages/coding-agent/src/cli.ts:27`

```ts
main(process.argv.slice(2));
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | 模块顶层（`fn` 为空） |
| `process.argv.slice(2)` | `["--model","deepseek-v4-flash","--approve"]` |

原始参数数组原样进入主流程，未做任何解析。

### BP2 主流程开始 — `packages/coding-agent/src/main.ts:676`

```ts
export async function main(args: string[], options?: MainOptions) {
	resetTimings();   // ← 断点
	...
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `main` |
| `args` | `["--model","deepseek-v4-flash","--approve"]` |
| `process.stdin.isTTY` | `true`（伪终端 → 走 Interactive 模式） |
| `process.stdout.isTTY` | `true` |

参数在此进入解析；stdin/stdout 均为 TTY 是 Interactive 模式的判定依据。`--approve`（`projectTrustOverride=true`）在此阶段消费，跳过项目信任弹窗。

### BP3 服务组装 — `packages/coding-agent/src/core/agent-session-services.ts:182`

```ts
export async function createAgentSessionServices(options) {
	// ... SettingsManager、ModelRuntime、ResourceLoader 依次创建 ...
	await modelRuntime.refresh({ allowNetwork: false });   // ← 断点
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `createAgentSessionServices` |
| `cwd` | `/workspace` |
| `agentDir` | `/root/.pi/agent` |
| `modelRuntime` 就绪 | `true`（对象含 16 个自有键） |
| `settingsManager` 就绪 | `true` |
| `resourceLoader` 就绪 | `true` |

三大服务组装完毕后，`modelRuntime.refresh` 触发首次模型目录刷新 —— 认证解析（BP10）正是在这行执行期间发生（见下）。

### BP4 Runtime 创建 — `packages/coding-agent/src/core/agent-session-runtime.ts:431`

```ts
export async function createAgentSessionRuntime(createRuntime, options) {
	assertSessionCwdExists(options.sessionManager, options.cwd);   // ← 断点
	const result = await createRuntime(options);
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `createAgentSessionRuntime` |
| `createRuntime` 工厂 | 存在 |
| `options.cwd` | `/workspace` |

### BP5 TUI 创建 — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:521`

```ts
constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
	this.runtimeHost = runtimeHost;   // ← 断点
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `InteractiveMode`（构造函数） |
| `options` | 存在 |
| `agentDir` | `/root/.pi/agent` |
| 输入注入 | 成功——把 `"Summarize this repo"` 压入 `pendingUserInputs` 队列，等价于在 TUI 里敲回车 |

注入成功后，主循环的 `getUserInput()` 会直接从队列取输入，无需人工交互。

### BP6 主循环 — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1135`（`run()` 内）

```ts
while (true) {
	const userInput = await this.getUserInput();   // 等待输入
	try {
		await this.session.prompt(userInput);   // ← 断点
	```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `run` |
| `userInput` | `"Summarize this repo"`（来自注入队列；正常键盘输入也走同一路径） |
| `inputLen` | `19` |

### BP7 消息发送 — `packages/coding-agent/src/core/agent-session.ts:1160`（`prompt()` 内）

```ts
async prompt(text: string, options?) {
	const expandPromptTemplates = options?.expandPromptTemplates ?? true;   // ← 断点
	// … 消息预处理、skill 展开、扩展拦截
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `prompt` |
| `method` | `"prompt"` |
| `text` | `"Summarize this repo"`（前 80 字符） |

### BP8 Agent 循环 — `packages/agent/src/agent-loop.ts:104`（`runAgentLoop` 内，★ 核心循环入口）

```ts
export async function runAgentLoop(prompts, context, config, emit, signal, streamFn) {
	const newMessages: AgentMessage[] = [...prompts];   // ← 断点
	const currentContext = { ...context, messages: [...context.messages, ...prompts] };
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `runAgentLoop` |
| `prompts.length` | `1`（本轮要发给模型的消息数） |
| `context.messages.length`（循环前） | `0` |
| 可用工具数 `context.tools.length` | `4` |

Agent 循环以「prompts + 上下文」进入，反复执行「调 LLM → 若返回工具调用则执行工具 → 工具结果回合再调 LLM」，直到无工具调用为止。

### BP9 LLM 调用 — `packages/agent/src/agent-loop.ts:306`（`streamAssistantResponse` 内）

```ts
const response = await streamFunction(config.model, llmContext, {
	// 请求参数（model、messages、tools、systemPrompt）…
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `streamAssistantResponse` |
| `config.model.id` | `deepseek-v4-flash` |
| 请求消息数 `llmContext.messages.length` | 多轮 LLM 调用依次为 `1 → 4 → 7 → 10 → 13`（共 5 次） |
| `llmContext.tools.length` | `4` |
| System prompt 字符数 | `15533` |

5 次 LLM 调用 = 1 次首答 + 4 次工具执行后的续答，验证了「Agent 循环 ↔ 工具执行」的往返。

### BP10 认证解析 — `packages/ai/src/auth/helpers.ts:26`（`envApiKeyAuth.resolve` 内）

```ts
for (const envVar of envVars) {
	const value = await ctx.env(envVar);
	if (value) return { auth: { apiKey: value }, source: envVar };   // ← 断点
}
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `resolve` |
| 命中次数 | `311` 次（约 40 个环境变量 × 14 轮 refresh） |
| 命中判定 | `keyFound` 逐变量轮询，按「存储凭据 → 首个命中的环境变量」顺序 |
| 最终命中 | `envVar="DEEPSEEK_API_KEY"`，`keyFound=true`，掩码 `sk-3...8d46`（即 `sk-388e...8d46`） |

全部 provider 均走 `envApiKeyAuth`；本例仅 `DEEPSEEK_API_KEY` 命中，其余 39 个变量（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`…）均未设置。

## 断点从源码行 → 压缩 bundle 的落点

源码被 esbuild 压缩为 3~10 行/文件，行断点会落错位置，需经内联 sourcemap 映射（`generatedPositionFor`，LEAST_UPPER_BOUND 查找）：

| 断点 | 源码位置 | 生成位置 |
|---|---|---|
| BP1 CLI 入口 | `cli.ts:27` | bundle 第 2 行 :877 |
| BP2 主流程开始 | `main.ts:676` | 第 3 行 :11136 |
| BP3 服务组装 | `agent-session-services.ts:182` | 第 1 行 :2845（actual :2864） |
| BP4 Runtime 创建 | `agent-session-runtime.ts:431` | 第 1 行 :8741 |
| BP5 TUI 创建 | `interactive-mode.ts:521` | 第 1 行 :12143 |
| BP6 主循环 | `interactive-mode.ts:1135` | 第 8 行 :3224 |
| BP7 消息发送 | `agent-session.ts:1160` | 第 1 行 :18083（actual :18111） |
| BP8 Agent 循环 | `agent-loop.ts:104` | 第 1 行 :1075（actual :1093） |
| BP9 LLM 调用 | `agent-loop.ts:306` | 第 1 行 :5140 |
| BP10 认证解析 | `auth/helpers.ts:26` | 第 1 行 :643 |

## 端到端结果

注入的问题 `Summarize this repo` 被模型完整回答（示例摘录）：

> Notable question — recent commits suggest this worktree has been used to run pi while learning…

| 指标 | 值 |
|---|---|
| 输出 tokens | 1,604 |
| 输入 tokens | 9,839 |
| 总 tokens | 43,699（含缓存读写） |
| 耗时 | 23.2s |
| TPS | 69.1 tok/s |
| 状态行 | `deepseek-v4-flash · high · 1.2%/1.0M` |

## 关键结论

1. **认证解析（BP10）并非最后一步**：它发生在 BP3 服务组装的 `modelRuntime.refresh` 期间，且覆盖全部 provider 的环境变量——理解认证流程应把该断点与 `agent-session-services.ts:182` 关联观察。
2. **TUI 无需人工输入即可自动化**：在 `InteractiveMode` 构造函数注入 `pendingUserInputs`，等价于键盘输入，主循环 `getUserInput()` 立即取走。
3. **一次交互 = 多次 LLM 调用**：工具使用场景下 `streamAssistantResponse` 会按工具回合数重复触发（本例 5 次，消息数 1→13 递增），故断点 BP9 会多次命中。
4. **压缩代码上断点必须用 sourcemap**：全部落点为 1~8 行内的具体列偏移，直接行断点必失效。