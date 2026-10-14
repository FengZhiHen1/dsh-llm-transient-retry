// chain — 从会话事件推导本链的下一次重试序号与 retryId。
//
// 边界：纯函数，输入是快照事件数组。与 llm/retry 不变量同源推导，而不是另存一份计数：
// 不变量要求同一 (turn, step, provider, policyKey) 链内 retry 严格加一、retryId 保持不变
// （packages/llm/llm-retry/src/invariant.ts），按日志现算才能与校验器结论一致。

/**
 * 推导下一次重试的链状态。
 *
 * 同一链的界定维度是 turn、step、provider 与 policyKey 四者同时相等；
 * 序号从 1 起，超出 maxRetries 即判为用尽（调用方据此放行原错误）。
 * @param {ReadonlyArray<{type?: string, data?: object}>} events 会话事件快照
 * @param {{turn: number, step: number, provider: string, policyKey: string, maxRetries: number}} chain 本链的界定维度与上限
 * @returns {{retry: number, retryId: string | null, exhausted: boolean}} retryId 为 null 表示本链尚无重试，需新生成
 */
export function nextChainStep(events, chain) {
  const { turn, step, provider, policyKey, maxRetries } = chain
  let prior
  for (const event of events) {
    if (event?.type !== 'llm/retry') continue
    const data = event.data
    if (data?.turn !== turn || data?.step !== step) continue
    if (data?.provider !== provider || data?.policyKey !== policyKey) continue
    prior = data
  }
  const retry = (prior?.retry ?? 0) + 1
  return {
    retry,
    retryId: typeof prior?.retryId === 'string' ? prior.retryId : null,
    exhausted: retry > maxRetries,
  }
}
