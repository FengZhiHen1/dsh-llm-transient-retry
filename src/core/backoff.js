// backoff — 第 n 次重试的等待时长。
//
// 边界：纯计算，不持有定时器。上界理由：上游过载是秒级现象，30s 上限已远超其恢复时间；
// 更长的等待会让本可恢复的会话长时间停在无输出状态。

/** 指数退避的指数上限：避免 retry 异常大时 2 ** (retry - 1) 溢出为 Infinity。 */
const MAX_EXPONENT = 1024

/**
 * 计算第 retry 次重试的等待毫秒数：指数退避乘以抖动，最后受 maxDelayMs 约束。
 * @param {number} retry 从 1 开始的链内重试序号
 * @param {{initialDelayMs: number, maxDelayMs: number, jitterRatio: number}} settings 归一后的配置
 * @param {() => number} [random] 0 到 1 的随机源，便于测试注入
 * @returns {number} 等待毫秒数
 */
export function backoffDelay(retry, settings, random = Math.random) {
  const { initialDelayMs, maxDelayMs, jitterRatio } = settings
  const exponential = Math.min(initialDelayMs * 2 ** Math.min(retry - 1, MAX_EXPONENT), maxDelayMs)
  const jitter = 1 - jitterRatio + 2 * jitterRatio * random()
  return Math.round(Math.min(exponential * jitter, maxDelayMs))
}
