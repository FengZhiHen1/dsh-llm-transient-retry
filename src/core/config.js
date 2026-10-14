// config — 配置默认值与运行期归一。
//
// 边界：不接触 DSH。默认值只在 DEFAULT_CONFIG 定义一次，adapter 的 schema 与运行期解析共用它，
// 避免两处默认值漂移。非法配置一律抛错而不静默兜底：错的退避参数比不重试更难排查。

/** 配置默认值。 */
export const DEFAULT_CONFIG = Object.freeze({
  providers: Object.freeze(['openai-codex']),
  maxRetries: 3,
  initialDelayMs: 1500,
  maxDelayMs: 30000,
  jitterRatio: 0.3,
})

/**
 * 归一配置：缺省取默认值，一旦出现就必须合法。
 *
 * adapter 之外的直接调用（单测、手工装配）不经过 loader 的 schema，
 * 因此这里做同一套校验，非法即抛。
 * @param {object} [config] loader 按 Config 校验后传入的配置，可为空对象
 * @returns {{providers: string[], maxRetries: number, initialDelayMs: number, maxDelayMs: number, jitterRatio: number}} 归一后的配置
 * @throws {Error} providers 非非空字符串数组、maxRetries 非正整数、
 *   延迟非正有限数、initialDelayMs 大于 maxDelayMs，或 jitterRatio 不在 0 到 1 之间
 */
export function resolveConfig(config = {}) {
  const providers = config.providers ?? DEFAULT_CONFIG.providers
  if (!Array.isArray(providers)
    || providers.length === 0
    || providers.some((provider) => typeof provider !== 'string' || provider === '')) {
    throw new Error('llm-transient-retry: providers must be a non-empty array of non-empty strings')
  }

  const maxRetries = config.maxRetries ?? DEFAULT_CONFIG.maxRetries
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 1) {
    throw new Error('llm-transient-retry: maxRetries must be a positive safe integer')
  }

  const initialDelayMs = config.initialDelayMs ?? DEFAULT_CONFIG.initialDelayMs
  const maxDelayMs = config.maxDelayMs ?? DEFAULT_CONFIG.maxDelayMs
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) {
    throw new Error('llm-transient-retry: initialDelayMs must be a positive finite number')
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) {
    throw new Error('llm-transient-retry: maxDelayMs must be a positive finite number')
  }
  if (initialDelayMs > maxDelayMs) {
    throw new Error('llm-transient-retry: initialDelayMs must not exceed maxDelayMs')
  }

  const jitterRatio = config.jitterRatio ?? DEFAULT_CONFIG.jitterRatio
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error('llm-transient-retry: jitterRatio must be between 0 and 1')
  }

  return { providers: [...providers], maxRetries, initialDelayMs, maxDelayMs, jitterRatio }
}
