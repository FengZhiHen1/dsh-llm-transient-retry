// invariant 单测：把我方写出的事件喂给上游真校验器。
// 这里不另写第二套不变量规则——校验器来自 @deepseek-ai/dsh-llm-retry/invariant（devDependency，版本钉 0.1.7-rc.2）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { apply as installCompanion } from '@deepseek-ai/dsh-llm-retry/invariant'
import { apply } from '../src/adapter/index.js'

/** 测试用极短退避。 */
const FAST = { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }

const PROVIDER = 'openai-codex'
const TURN = 7
const STEP = 1
const OVERLOAD = 'Codex error: Our servers are currently overloaded. Please try again later.'

/**
 * 装配一个把上游不变量接上的 harness。
 *
 * 保真依据：Session.append 在事件入册前派发 session/event 做 pre-commit 校验
 * （packages/core/session/src/index.ts:759-764），而 llm-retry 的不变量正挂在
 * internal/dispatch 的该事件上（packages/llm/llm-retry/src/invariant.ts:162-169）。
 * 假 session 因此先派发、再入册，与平台同序。
 * @param {object} [config] 覆盖 FAST 的插件配置
 * @returns {Promise<object>} harness
 */
async function createHarness(config = {}) {
  const events = [
    // 平台在真实会话里必然具备的边界事件：不变量据此确认请求处于开放 turn/step 内，
    // 并从最近的 request/header 取该 step 的 provider（packages/llm/llm-retry/src/history.ts:14-32）。
    { type: 'turn/start', data: { turn: TURN } },
    { type: 'step/start', data: { turn: TURN, step: STEP } },
    { type: 'request/header', data: { header: { config: { provider: PROVIDER } } } },
  ]
  const listenersByName = new Map()
  const session = {
    snapshotEvents: () => [...events],
    append(type, data) {
      const event = { type, data }
      // 只派发 internal/dispatch：平台的 pre-commit 校验钩子就是它（按事件名分派）。
      for (const handler of listenersByName.get('internal/dispatch') ?? []) {
        handler('waterfall', 'session/event', [session, event])
      }
      events.push(event)
      return event
    },
  }

  let installer
  await installCompanion({
    invariants: {
      register(_packageName, install) {
        installer = install
        return () => {}
      },
    },
  })
  installer({
    sessions: { list: () => [session] },
    on(name, handler) {
      listenersByName.set(name, [...(listenersByName.get(name) ?? []), handler])
      return () => {}
    },
  }, (message) => {
    throw new Error(`invariant violated: ${message}`)
  })

  const listeners = new Map()
  const disposers = []
  apply({
    on(name, handler) {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    },
    effect(factory) {
      disposers.push(factory())
      return () => {}
    },
    logger: { warn() {} },
  }, { ...FAST, ...config })

  return {
    events,
    append: session.append,
    payload: (overrides = {}) => ({
      agent: { session },
      turn: TURN,
      step: STEP,
      provider: PROVIDER,
      failure: { code: 'PI_AI_ERROR', message: OVERLOAD },
      signal: new AbortController().signal,
      ...overrides,
    }),
    listener: listeners.get('agent/request-error'),
  }
}

test('我方写出的事件通过上游真校验器', async () => {
  const harness = await createHarness()
  const action = await harness.listener(harness.payload(), async () => undefined)
  assert.deepEqual(action, { kind: 'retry' })
  const written = harness.events.filter((event) => event.type.startsWith('llm/retry'))
  assert.equal(written.length, 2)
  assert.equal(written[0].data.retry, 1)
})

test('同链多次重试均通过校验，且 retryId 保持一致', async () => {
  const harness = await createHarness({ maxRetries: 3 })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await harness.listener(harness.payload(), async () => undefined)
  }
  const scheduled = harness.events.filter((event) => event.type === 'llm/retry')
  assert.deepEqual(scheduled.map((event) => event.data.retry), [1, 2, 3])
  assert.equal(new Set(scheduled.map((event) => event.data.retryId)).size, 1)
})

test('校验器不是空跑：跳号与换 retryId 都会被拒', async () => {
  const harness = await createHarness()
  const base = {
    turn: TURN,
    step: STEP,
    provider: PROVIDER,
    mode: 'normal',
    policyKey: 'probe',
    maxRetries: 3,
    delayMs: 1,
    failure: { code: 'PI_AI_ERROR', message: OVERLOAD },
  }
  assert.throws(
    () => harness.append('llm/retry', { ...base, retryId: 'a', retry: 2 }),
    /must equal provider policy retry 1/,
  )
  harness.append('llm/retry', { ...base, retryId: 'a', retry: 1 })
  assert.throws(
    () => harness.append('llm/retry', { ...base, retryId: 'b', retry: 2 }),
    /must preserve retryId/,
  )
})
