# Mission: 读懂 pi 的架构

## Why

我刚接触 TypeScript / Node，想真正读懂 pi（一个开源 AI 编程代理 CLI 项目，这也是我 clone 这个仓库的原因），但面对一个 10+ 包的 monorepo 不知道从何读起。学完之后，我希望遇到任何名词（session、tool、provider、extension…）都能说出它归哪个包管、去哪个文件读，能独立追一条"用户输入 → 模型调用"的完整路径，为将来自己贡献或写扩展打好地图。

## Success looks like

- 不看提示也能说出 monorepo 的三层结构：基础层 / 运行时层 / 应用层，各含哪些包
- 能指出 `pi` 命令的入口文件，以及 agent 主循环所在的文件
- 能说出 session、tool、provider、extension 分别由哪个包负责
- 被问到"想了解 X 该读哪"时，能直接指向具体包与文档
- 能就任何不清楚的点向老师（agent）提问

## Constraints

- TS/Node 新手：先建立概念，再补语言细节
- 使用中文教学
- 每课小而短（10 分钟左右），学完立刻能用；配合 retrieval practice 强化记忆
- 分多节课推进，不追求一次学完

## Out of scope

- 深入各 LLM 供应商的 API 差异（OpenAI / Anthropic / Google 实现细节）
- 深入 TUI 差分渲染算法
- 编写自定义 extension 的具体 API（之后的课程）
- session 存储格式的逐字段细节