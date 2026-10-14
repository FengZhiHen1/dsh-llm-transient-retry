// adapter 单测：接线形态、写入事件的逐字段形状、用尽与中止路径。
// 用假 ctx 与假 session，不 boot DSH；真实组合的激活验证留给 test profile 直挂。

import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/adapter/index.js'

/** 测试用极短退避：不抖动、1ms，让断言快而不依赖真实时间。 */
const FAST = { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }

const OVERLOAD = 'Codex error: Our servers are currently overloaded. Please try again later.'

/**
 * 装配最小 harness。
 * @param {object} [config] 覆盖 FAST 的配置
 * @returns {object} harness（含假 ctx、事件记录与 payload 工厂）
 */
function createHarness(config = {}) {
  const listeners = new Map()
  const disposers = []
  const events = []
  const ctx = {
    on(name, handler) {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    },
    effect(factory) {
      disposers.push(factory())
      return () => {}
    },
    logger: { warn() {} },
  }
  const session = {
    snapshotEvents: () => [...events],
    append(type, data) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const agent = { session }
  apply(ctx, { ...FAST, ...config })
  return {
    events,
    agent,
    payload: (overrides = {}) => ({
      agent,
      turn: 7,
      step: 1,
      provider: 'openai-codex',
      failure: { code: 'PI_AI_ERROR', message: OVERLOAD },
      signal: new AbortController().signal,
      ...overrides,
    }),
    listener: listeners.get('agent/request-error'),
    dispose: () => Promise.all(disposers.map((disposer) => disposer())),
  }
}

test('监听器已挂上 agent/request-error', () => {
  const harness = createHarness()
  assert.equal(typeof harness.listener, 'function')
})

test('命中后先写 llm/retry、等退避、再写 llm/retry-started，并返回 retry', async () => {
  const harness = createHarness()
  const failure = { code: 'PI_AI_ERROR', message: OVERLOAD }
  let nextCalls = 0
  const action = await harness.listener(harness.payload({ failure }), async () => {
    nextCalls += 1
    return undefined
  })

  assert.deepEqual(action, { kind: 'retry' })
  assert.equal(nextCalls, 0)
  assert.equal(harness.events.length, 2)

  const [scheduled, started] = harness.events
  assert.equal(scheduled.type, 'llm/retry')
  assert.equal(scheduled.data.mode, 'normal')
  assert.equal(scheduled.data.policyKey, 'llm-transient-retry-v1')
  assert.equal(scheduled.data.turn, 7)
  assert.equal(scheduled.data.step, 1)
  assert.equal(scheduled.data.provider, 'openai-codex')
  assert.equal(scheduled.data.retry, 1)
  assert.equal(scheduled.data.maxRetries, 3)
  assert.equal(scheduled.data.delayMs, 1)
  // failure 原样透传：不塞自定义字段，也不复制改写（不变量对 failure 逐字段校验）。
  assert.equal(scheduled.data.failure, failure)
  assert.ok(typeof scheduled.data.retryId === 'string' && scheduled.data.retryId.length > 0)

  assert.equal(started.type, 'llm/retry-started')
  assert.deepEqual(started.data, { retryId: scheduled.data.retryId, turn: 7, step: 1, retry: 1 })
})

test('同一链的第二次失败续号并复用 retryId', async () => {
  const harness = createHarness()
  const next = async () => undefined
  await harness.listener(harness.payload(), next)
  await harness.listener(harness.payload(), next)

  const [first, , second, started] = harness.events
  assert.equal(first.data.retry, 1)
  assert.equal(second.data.retry, 2)
  assert.equal(second.data.retryId, first.data.retryId)
  assert.deepEqual(started.data, { retryId: first.data.retryId, turn: 7, step: 1, retry: 2 })
})

test('用尽后不再介入且不写事件', async () => {
  const harness = createHarness({ maxRetries: 1 })
  let nextAction = 'sentinel'
  const next = async () => nextAction
  await harness.listener(harness.payload(), next)
  const before = harness.events.length
  const action = await harness.listener(harness.payload(), next)
  assert.equal(action, 'sentinel')
  assert.equal(harness.events.length, before)
})

test('非命中载荷直接交回下游', async () => {
  const harness = createHarness()
  let nextCalls = 0
  const next = async () => {
    nextCalls += 1
    return undefined
  }
  const cases = [
    harness.payload({ provider: 'workbuddy' }),
    harness.payload({ failure: { code: 'AUTH', message: OVERLOAD } }),
    harness.payload({ failure: { code: 'PI_AI_ERROR', message: 'ended pending' } }),
  ]
  for (const payload of cases) {
    await harness.listener(payload, next)
  }
  assert.equal(nextCalls, cases.length)
  assert.equal(harness.events.length, 0)
})

test('信号已中止时只落调度事件、不标已开始，且不替下游作答', async () => {
  const harness = createHarness()
  const controller = new AbortController()
  controller.abort()
  let nextCalls = 0
  const action = await harness.listener(harness.payload({ signal: controller.signal }), async () => {
    nextCalls += 1
    return undefined
  })
  assert.equal(action, undefined)
  assert.equal(nextCalls, 0)
  assert.equal(harness.events.length, 1)
  assert.equal(harness.events[0].type, 'llm/retry')
})

test('处置后中止在途等待，且不再进入下游', async () => {
  const harness = createHarness({ initialDelayMs: 200, maxDelayMs: 200 })
  let nextCalls = 0
  const pending = harness.listener(harness.payload(), async () => {
    nextCalls += 1
    return undefined
  })
  await harness.dispose()
  assert.equal(await pending, undefined)
  assert.equal(nextCalls, 0)
  assert.equal(harness.events.length, 1)
  assert.equal(await harness.listener(harness.payload(), async () => undefined), undefined)
})

test('非法配置在装配期抛错，不静默兜底', () => {
  const ctx = { on: () => () => {}, effect: () => () => {}, logger: { warn() {} } }
  assert.throws(() => apply(ctx, { maxRetries: 0 }), /maxRetries/)
  assert.throws(() => apply(ctx, { providers: [] }), /providers/)
  assert.throws(() => apply(ctx, { initialDelayMs: 900, maxDelayMs: 100 }), /maxDelayMs/)
  assert.throws(() => apply(ctx, { jitterRatio: 2 }), /jitterRatio/)
})
