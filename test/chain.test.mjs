// chain 单测：链的界定维度、序号推导与用尽判定。

import test from 'node:test'
import assert from 'node:assert/strict'
import { nextChainStep } from '../src/core/chain.js'

const base = { turn: 7, step: 1, provider: 'openai-codex', policyKey: 'chain', maxRetries: 3 }

/** 造一条本链的 llm/retry 事件。 */
function retryEvent(retry, overrides = {}) {
  return {
    type: 'llm/retry',
    data: {
      turn: 7,
      step: 1,
      provider: 'openai-codex',
      policyKey: 'chain',
      retryId: 'r1',
      retry,
      ...overrides,
    },
  }
}

test('空历史给出第 1 次且无既有 retryId', () => {
  assert.deepEqual(nextChainStep([], base), { retry: 1, retryId: null, exhausted: false })
})

test('同链续号并复用 retryId', () => {
  assert.deepEqual(nextChainStep([retryEvent(1)], base), { retry: 2, retryId: 'r1', exhausted: false })
})

test('四个维度任一不同即另起一链', () => {
  const others = [
    retryEvent(1, { turn: 8 }),
    retryEvent(1, { step: 2 }),
    retryEvent(1, { provider: 'workbuddy' }),
    retryEvent(1, { policyKey: 'other' }),
  ]
  for (const event of others) {
    assert.deepEqual(nextChainStep([event], base), { retry: 1, retryId: null, exhausted: false })
  }
})

test('只取最近一条同链事件', () => {
  const history = [retryEvent(1), retryEvent(2), retryEvent(3, { retryId: 'r2' })]
  assert.deepEqual(nextChainStep(history, base), { retry: 4, retryId: 'r2', exhausted: true })
})

test('越过 maxRetries 即判用尽', () => {
  // retry 是「下一次」的序号：前值 2 时下一次为 3，仍在上限内；前值 3 时下一次为 4，已越界。
  assert.equal(nextChainStep([retryEvent(2)], base).exhausted, false)
  assert.equal(nextChainStep([retryEvent(3)], base).exhausted, true)
  assert.equal(nextChainStep([retryEvent(1)], { ...base, maxRetries: 1 }).exhausted, true)
})

test('其它事件类型与畸形事件不影响推导', () => {
  const history = [
    { type: 'assistant/attempt', data: { turn: 7 } },
    { type: 'llm/retry-started', data: { retryId: 'r1', retry: 1 } },
    { type: 'llm/retry' },
    { type: 'llm/retry', data: {} },
    retryEvent(1),
  ]
  assert.deepEqual(nextChainStep(history, base), { retry: 2, retryId: 'r1', exhausted: false })
})
