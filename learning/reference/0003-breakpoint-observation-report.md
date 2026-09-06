# 关键断点位置观察报告（13 站全链路 · Interactive 模式实测）

> 实践日期：2026-09-06 · 模型：`deepseek-v4-flash`（`DEEPSEEK_API_KEY`=`sk-388e...8d46`）
> 运行命令：`pi --model deepseek-v4-flash --approve`（伪终端内运行）
> 方法：CDP（Chrome DevTools Protocol）直连 `node --inspect-brk`，`--approve` 跳过项目信任确认；断点行号经内联 sourcemap 从源码行:列映射到压缩 bundle 的精确 line:column。
> 原始数据：`learning/.tmp/pi-cdp-trace.jsonl`（18 条命中）

## 断点链路

```
cli.ts → main.ts（参数解析 → appMode → 项目信任）
       → createAgentSessionServices（服务组装，含认证解析）
       → createAgentSessionRuntime（Runtime 创建）
       → InteractiveMode 构造（TUI 创建）
       → run() → getUserInput()（主循环等待输入）
       → session.prompt()（消息预处理、skill 展开、扩展拦截）
       → runAgentLoop（Agent 循环 ★）
       → streamAssistantResponse（LLM 调用）
```

## 13 个断点：位置与观察结果

### BP1 CLI 入口 — `PI/packages/coding-agent/src/cli.ts:27`

```ts
main(process.argv.slice(2));
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | 模块顶层（`fn` 为空） |
| `process.argv.slice(2)` | `["--model","deepseek-v4-flash","--approve"]` |

原始参数数组原样进入主流程，未做任何解析。

### BP2 主流程开始 — `PI/packages/coding-agent/src/main.ts:676`

```ts
export async function main(args: string[], options?: MainOptions) {
	resetTimings();   // ← 断点
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `main` |
| `args` | `["--model","deepseek-v4-flash","--approve"]` |
| `process.stdin.isTTY` | `true` |
| `process.stdout.isTTY` | `true` |

### BP2-1 参数解析完成 — `PI/packages/coding-agent/src/main.ts:731`

```ts
const parsed = parseArgs(args);   // L721
// ... diagnostics 处理 ...
time("parseArgs");   // ← 断点
```

| 观察项 | 实测值 |
|---|---|
| `parsed.model` | `"deepseek-v4-flash"` |
| `parsed.projectTrustOverride` | `true`（来自 `--approve`） |
| `parsed.diagnostics.length` | `0` |
| `parsed.fileArgs` | `[]` |

`parseArgs` 将 flag 解析为结构化对象；`projectTrustOverride=true` 直接决定后续项目信任判定。

### BP2-2 appMode 判定 — `PI/packages/coding-agent/src/main.ts:753`

```ts
let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
const shouldTakeOverStdout = appMode !== "interactive" && ...;   // ← 断点
```

| 观察项 | 实测值 |
|---|---|
| `appMode` | `"interactive"` |
| `stdinTTY` | `true` |
| `stdoutTTY` | `true` |
| `shouldTakeOverStdout` | `false`（interactive 模式不接管 stdout） |

`resolveAppMode` 优先级：`--mode rpc` > `--mode json` > `-p` 或非 TTY → print > 其余 → interactive。

### BP2-3 项目信任判定 — `PI/packages/coding-agent/src/main.ts:849`（`createRuntime` 工厂内）

```ts
const projectTrusted = shouldResolveProjectTrust
	? false
	: (cachedProjectTrust ?? parsed.projectTrustOverride ?? ...);
const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });   // ← 断点
```

| 观察项 | 实测值 |
|---|---|
| `hasTrustRequiringResources` | `true`（项目内有需信任的资源） |
| `shouldResolveProjectTrust` | `false`（因 `projectTrustOverride` 已设） |
| `projectTrusted` | `true` |
| `override` | `true` |
| `cached` | `null` |

`--approve` 使 `projectTrustOverride=true`，跳过信任弹窗直接信任。

### BP3 服务组装 — `PI/packages/coding-agent/src/core/agent-session-services.ts:182`

```ts
await modelRuntime.refresh({ allowNetwork: false });   // ← 断点
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `createAgentSessionServices` |
| `cwd` | `/workspace` |
| `agentDir` | `/root/.pi/agent` |
| `modelRuntimeReady` | `true`（16 个自有键） |
| `settingsReady` | `true` |
| `resourceLoaderReady` | `true` |

三大服务组装完毕后，`modelRuntime.refresh` 触发首次模型目录刷新 —— 认证解析（BP10）在这行执行期间发生。

### BP4 Runtime 创建 — `PI/packages/coding-agent/src/core/agent-session-runtime.ts:431`

```ts
export async function createAgentSessionRuntime(createRuntime, options) {
	assertSessionCwdExists(options.sessionManager, options.cwd);   // ← 断点
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `createAgentSessionRuntime` |
| `options.cwd` | `/workspace` |
| `options.agentDir` | `/root/.pi/agent` |
| `hasSessionManager` | `true` |
| `hasSessionStartEvent` | `false` |
| `createRuntime` | `"function"` |

### BP5 TUI 创建 — `PI/packages/coding-agent/src/modes/interactive/interactive-mode.ts:521`

```ts
constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
	this.runtimeHost = runtimeHost;   // ← 断点
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `InteractiveMode`（构造函数） |
| `options.tuiMode` | `null`（未指定，用 settings 默认值） |
| `options.autoTrustOnReloadCwd` | `undefined` |
| `hasRuntimeHost` | `true` |
| `agentDir` | `/root/.pi/agent` |
| 输入注入 | 成功——`pendingUserInputs.push("Summarize this repo")` |

注入成功后，主循环的 `getUserInput()` 直接从队列取输入。

### BP6 主循环 — `PI/packages/coding-agent/src/modes/interactive/interactive-mode.ts:1135`（`run()` 内）

```ts
while (true) {
	const userInput = await this.getUserInput();
	try {
		await this.session.prompt(userInput);   // ← 断点
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `run` |
| `userInput` | `"Summarize this repo"` |
| `inputLen` | `19` |
| `source` | `"getUserInput"` |

### BP7 消息发送 — `PI/packages/coding-agent/src/core/agent-session.ts:1161`（`prompt()` 内）

```ts
const expandPromptTemplates = options?.expandPromptTemplates ?? true;   // L1160
const preflightResult = options?.preflightResult;   // ← 断点
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `prompt` |
| `text` | `"Summarize this repo"` |
| `expandPromptTemplates` | `true`（启用 skill/模板展开） |
| `source` | `null` |
| `hasImages` | `false` |
| `isExtensionCommand` | `false`（非 `/` 开头） |

### BP8 Agent 循环 — `PI/packages/agent/src/agent-loop.ts:104`（`runAgentLoop` 内，★ 核心循环入口）

```ts
export async function runAgentLoop(prompts, context, config, emit, signal, streamFn) {
	const newMessages: AgentMessage[] = [...prompts];   // ← 断点
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `runAgentLoop` |
| `prompts.length` | `1` |
| `context.messages.length`（循环前） | `0` |
| `context.tools.length` | `4` |
| `hasSystemPrompt` | `true` |

### BP9 LLM 调用 — `PI/packages/agent/src/agent-loop.ts:306`（`streamAssistantResponse` 内）

```ts
const response = await streamFunction(config.model, llmContext, {   // ← 断点
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `streamAssistantResponse` |
| `config.model.id` | `deepseek-v4-flash` |
| `config.model.provider` | `deepseek` |
| `llmContext.tools.length` | `4` |
| `systemPromptLen` | `15533` |
| `hasApiKey`（config 层） | `false`（key 由 provider auth 层解析，不经 config） |
| `temperature` / `maxTokens` | `null`（使用模型默认值） |

BP9 共命中 **6 次**，`llmContext.messages.length` 依次为 `1 → 4 → 7 → 10 → 12 → 14`，对应 1 次首答 + 5 次工具执行后的续答。

### BP10 认证解析 — `PI/packages/coding-agent/src/core/model-runtime.ts:300`（`runAvailabilityRefresh` 内）

```ts
const [available, checks, credentials] = await Promise.all([
	this.models.getAvailable(undefined, { signal }),
	Promise.all(providers.map(p => [p.id, await this.models.checkAuth(p.id, { signal })])),
	this.credentials.list({ signal }),
]);
if (seq !== this.availabilityRefreshSeq) return;
const auth = new Map(checks);   // ← 断点
```

| 观察项 | 实测值 |
|---|---|
| 命中函数 | `runAvailabilityRefresh` |
| `providerCount` | `41`（注册的 provider 总数） |
| `configuredProviders` | `["deepseek"]`（auth 检查通过的 provider） |
| `authSources` | `[{"provider":"deepseek","source":"DEEPSEEK_API_KEY"}]` |
| `storedCredentials`（CredentialStore） | `[]`（无持久化存储的凭据） |
| `deepseekRuntimeOverride` | `false`（无运行时 API key 覆盖） |

认证解析发生在 BP3 服务组装的 `modelRuntime.refresh` 期间。`checkAuth` 对所有 41 个 provider 逐一检查，仅 deepseek 通过（来源 `DEEPSEEK_API_KEY` 环境变量）。`hasRuntimeApiKey("deepseek")` 为 `false` 说明未使用 `--api-key` 运行时覆盖。

## 断点从源码行 → 压缩 bundle 的落点

源码被 esbuild 压缩为 3~10 行/文件，行断点会落错位置，需经内联 sourcemap 映射（`generatedPositionFor`，LEAST_UPPER_BOUND 查找）：

| 断点 | 源码位置 | 生成位置 |
|---|---|---|
| BP1 CLI 入口 | `cli.ts:27` | gen 2:877 |
| BP2 主流程开始-原始参数 | `main.ts:676` | gen 3:11136 |
| BP2-1 参数解析完成 | `main.ts:731` | gen 3:12446 |
| BP2-2 appMode 判定 | `main.ts:753` | gen 3:12985 |
| BP2-3 项目信任判定 | `main.ts:849` | gen 3:16111 |
| BP3 服务组装 | `agent-session-services.ts:182` | gen 1:2864 |
| BP4 Runtime 创建 | `agent-session-runtime.ts:431` | gen 1:8741 |
| BP5 TUI 创建 | `interactive-mode.ts:521` | gen 1:12143 |
| BP6 主循环 | `interactive-mode.ts:1135` | gen 8:3224 |
| BP7 消息发送 | `agent-session.ts:1161` | gen 1:18170 |
| BP8 Agent 循环 | `agent-loop.ts:104` | gen 1:1093 |
| BP9 LLM 调用 | `agent-loop.ts:306` | gen 1:5140 |
| BP10 认证解析 | `model-runtime.ts:300` | gen 1:6125 |

## 端到端结果

| 指标 | 值 |
|---|---|
| 输出 tokens | 1,762 |
| 输入 tokens | 5,004 |
| 总 tokens | 50,542（含缓存读写 43,776） |
| 耗时 | 15.8s |
| TPS | 111.5 tok/s |
| LLM 调用次数 | 6（消息数 1→14） |

## 关键结论

1. **主流程开始分三步**：参数解析（`parseArgs`）→ appMode 判定（`resolveAppMode`）→ 项目信任判定（`projectTrusted`）。`--approve` 使 `projectTrustOverride=true`，直接跳过信任弹窗。
2. **认证解析在服务组装期间**：BP10 位于 `model-runtime.ts` 的 `runAvailabilityRefresh`，在 BP3 的 `modelRuntime.refresh` 内执行。`checkAuth` 对 41 个 provider 逐一检查，仅 deepseek 通过（来源 `DEEPSEEK_API_KEY`）。
3. **API key 不经 config 传递**：BP9 显示 `hasApiKey=false`，因为 key 由 provider 的 `auth.resolve` 在底层解析，`streamAssistantResponse` 的 `config.apiKey` 为空。
4. **一次交互 = 多次 LLM 调用**：BP9 命中 6 次（消息数 1→4→7→10→12→14），验证 Agent 循环与工具执行的往返。
5. **压缩代码断点必须用 sourcemap**：全部落点为 1~8 行内的具体列偏移，直接行断点必失效。