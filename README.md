# dsh-llm-transient-retry

把「上游瞬态错误」从 DSH 的 turn 级失败里救回来：在模型请求失败接缝上按**文本限定**识别过载类报文，按退避策略重发请求，并把重试以标准 `llm/retry` / `llm/retry-started` 事件写进会话（GUI 可见、可倒计时）。

> **状态：已实现；单元与接线测试全绿（29 项），`test` 实例上已激活**（只读 RPC 读到本行 `fiberPhase: active`，见 `docs/技术设计.md` §9.2）。**尚未验证**：消融对照与真实过载自愈——两者都要真实上游失败，只能等自然发生或到云主机验证。设计权威见 `docs/`。

## 解决什么

`dsh-llm-pi-ai` 的 `classifyPiAiError()` 是**纯文本正则**分类，未命中任何模式的报文一律归入 `PI_AI_ERROR`；而 DSH 默认可重试码集合不含 `PI_AI_ERROR`。于是上游把过载写成 SSE `error` 事件时（报文形如 `Our servers are currently overloaded. Please try again later.`，无任何三位状态码可供匹配），全链路**没有任何一处会尝试重发**，用户看到的是 `本轮运行失败` 横幅。

本插件只补这一段：不重试整个 `PI_AI_ERROR` 桶（那会连带认证、协议、`pending`/`deferred` 等非瞬态错误），只重试**明确语义为瞬态**的三句报文。

## 与邻居的关系

- 不修改 `dsh-llm-retry`（平台重试策略）、不修改 `dsh-codex-subscription`（路由与配额处理）；只挂同一个扩展点，且只处理它们放行的失败。
- 不需要 client 半侧代码：GUI 已有 `llm/retry` 的渲染节点（`packages/client/ui-chat/src/client/conversation-nodes/retry.ts`）。

## 安装（规划）

```text
试验 profile：dsh plugin --profile test add link:./plugins/dsh-llm-transient-retry
稳定 profile：dsh plugin --profile web  add github:FengZhiHen1/dsh-llm-transient-retry
```

## 平台支持

无平台相关代码路径，但**未在任何实例上实测**（连同源码直挂都还没做）——实测后方可声明支持范围。

## 许可

MIT
