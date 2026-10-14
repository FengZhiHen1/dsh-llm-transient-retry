// judgement — 介入判据：provider 白名单、错误码、报文文本三层与。
//
// 边界：只做判定，不做任何副作用；报文清单是唯一需要随上游新增而维护的地方。
// 判据为何必须文本限定见 docs/技术设计.md §3（同码下的 pending/deferred 终态不可重试）。

/**
 * 可重试的上游瞬态报文清单。每项一个正则，逐条可审。
 *
 * 三条正则均不使用 g 标志：带 g 的 RegExp.test 会记忆 lastIndex，
 * 同一实例跨次调用会给出漂移结果。
 */
export const TRANSIENT_MESSAGES = Object.freeze([
  /Our servers are currently overloaded\. Please try again later\./i,
  /An error occurred while processing your request\b[\s\S]*you can retry your request/i,
  /exceeded request buffer limit while retrying upstream/i,
])

/**
 * 本插件唯一介入的错误码。
 *
 * PI_AI_ERROR 是 classifyPiAiError 的兜底桶：既包含本次要救的上游过载，
 * 也包含 pending/deferred 两种终态，故不能整桶放行。
 */
export const RECOVERABLE_CODE = 'PI_AI_ERROR'

/**
 * 三层判据。
 * @param {{provider?: string, failure?: {code?: string, message?: string}}} payload agent/request-error 载荷中的判定面
 * @param {{providers: string[]}} settings 归一后的配置
 * @returns {boolean} true 表示本插件应尝试恢复
 */
export function shouldRecover(payload, settings) {
  const { provider, failure } = payload
  if (typeof provider !== 'string' || !settings.providers.includes(provider)) return false
  if (failure?.code !== RECOVERABLE_CODE) return false
  const message = typeof failure.message === 'string' ? failure.message : ''
  if (message === '') return false
  return TRANSIENT_MESSAGES.some((pattern) => pattern.test(message))
}
