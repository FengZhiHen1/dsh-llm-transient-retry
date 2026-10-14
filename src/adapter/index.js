// index — DSH Host 侧装配：把 agent/request-error waterfall 的一个 handler 接成 fiber。
//
// 边界：只做接线与副作用（事件监听、可中止等待、会话写入、处置清理）；判据与数值在 core/，
// 可裸 node 单测。契约依据见 docs/技术设计.md 与 docs/decisions/DSR-001。
// 本插件不消费任何 DSH 服务，故不声明 inject。

import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { backoffDelay } from '../core/backoff.js'
import { nextChainStep } from '../core/chain.js'
import { DEFAULT_CONFIG, resolveConfig } from '../core/config.js'
import { shouldRecover } from '../core/judgement.js'

/** 插件名，同时是 loader 行的 id。 */
export const name = 'llm-transient-retry'

/** 本插件重试链的标识。平台策略用自己的 policyKey（策略指纹），两者互不覆盖。 */
const POLICY_KEY = 'llm-transient-retry-v1'

/**
 * 本插件 loader 行的配置 schema。
 *
 * 默认值取自 core 的 DEFAULT_CONFIG，两处不会漂移；运行期再经 resolveConfig 校验一次，
 * 使不经 loader 的直接装配同样拒绝非法配置。非 volatile：退避策略是部署事实，改动走 patch 层。
 */
export const Config = Schema.object({
  providers: Schema.array(Schema.string()).default([...DEFAULT_CONFIG.providers]),
  maxRetries: Schema.natural().min(1).default(DEFAULT_CONFIG.maxRetries),
  initialDelayMs: Schema.natural().min(1).default(DEFAULT_CONFIG.initialDelayMs),
  maxDelayMs: Schema.natural().min(1).default(DEFAULT_CONFIG.maxDelayMs),
  jitterRatio: Schema.number().min(0).max(1).default(DEFAULT_CONFIG.jitterRatio),
})

/**
 * 可中止等待。
 * @param {number} delayMs 等待毫秒数
 * @param {AbortSignal} signal 中止信号（用户取消与本 fiber 处置的合流）
 * @returns {Promise<boolean>} true 表示等满；false 表示中途被中止
 */
function sleep(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 记录在途恢复动作，供处置路径等待。
 * @param {Set<Promise<unknown>>} inFlight 在途集合
 * @param {Promise<unknown>} operation 待登记的动作
 * @returns {Promise<unknown>} 与 operation 同时结算的句柄
 */
function track(inFlight, operation) {
  const tracked = operation.finally(() => inFlight.delete(tracked))
  inFlight.add(tracked)
  return tracked
}

/**
 * 调度一次重试：先写 llm/retry，等退避，再写 llm/retry-started。
 *
 * 事件顺序是契约：GUI 按 llm/retry 建节点、按 llm/retry-started 标记已开始；
 * 链序号与 retryId 现算自会话日志，与 llm/retry 不变量同源。
 * 写入不合规的事件会由上游不变量当场抛错，本函数不做兜底吞并。
 * @param {{agent: {session: object}, turn: number, step: number, provider: string, failure: object, signal: AbortSignal}} payload agent/request-error 载荷
 * @param {{maxRetries: number, initialDelayMs: number, maxDelayMs: number, jitterRatio: number}} settings 归一后的配置
 * @param {AbortController} lifetime 本 fiber 的生命周期信号
 * @returns {Promise<{kind: 'retry'} | {kind: 'pass'} | {kind: 'aborted'}>} retry 已调度；pass 不再介入；aborted 已中止
 */
async function recover(payload, settings, lifetime) {
  const { agent, turn, step, provider, failure, signal } = payload
  const { retry, retryId: priorRetryId, exhausted } = nextChainStep(agent.session.snapshotEvents(), {
    turn,
    step,
    provider,
    policyKey: POLICY_KEY,
    maxRetries: settings.maxRetries,
  })
  if (exhausted) return { kind: 'pass' }

  const retryId = priorRetryId ?? randomUUID()
  // 只算一次：事件里公示的 delayMs 必须等于实际等待，否则 GUI 倒计时与真实等待不符。
  const delayMs = backoffDelay(retry, settings)
  agent.session.append('llm/retry', {
    retryId,
    turn,
    step,
    provider,
    mode: 'normal',
    policyKey: POLICY_KEY,
    retry,
    maxRetries: settings.maxRetries,
    delayMs,
    failure,
  })
  if (!await sleep(delayMs, AbortSignal.any([signal, lifetime.signal]))) {
    return { kind: 'aborted' }
  }
  agent.session.append('llm/retry-started', { retryId, turn, step, retry })
  return { kind: 'retry' }
}

/**
 * Host 侧装配。
 * @param {object} ctx Host 插件上下文
 * @param {object} [config] loader 按 Config 校验并填默认后的配置
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config)
  const lifetime = new AbortController()
  const inFlight = new Set()

  ctx.on('agent/request-error', (payload, next) => {
    // 已处置的 fiber 不再进入任何下游策略，也不替下游作答。
    if (lifetime.signal.aborted) return Promise.resolve(undefined)
    if (!shouldRecover(payload, settings)) return next()
    return track(inFlight, recover(payload, settings, lifetime).then((outcome) => {
      if (outcome.kind === 'retry') return { kind: 'retry' }
      if (outcome.kind === 'pass') return next()
      return undefined
    }))
  })

  // 处置顺序：本 effect 晚于 ctx.on 注册，故先中止在途等待，再由 fiber 摘除监听器。
  // 等待的东西不依赖本 fiber 结算（定时器与 AbortSignal），不构成自我等待闭环。
  ctx.effect(() => () => {
    lifetime.abort(new Error(`${name}: disposed`))
    return Promise.allSettled([...inFlight])
  }, `${name}: abort and drain in-flight recovery`)
}
