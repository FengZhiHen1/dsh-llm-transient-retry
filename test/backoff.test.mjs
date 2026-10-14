// backoff 单测：退避序列、抖动边界与上限约束。

import test from 'node:test'
import assert from 'node:assert/strict'
import { backoffDelay } from '../src/core/backoff.js'

const settings = { initialDelayMs: 1000, maxDelayMs: 8000, jitterRatio: 0 }

test('无抖动时按 2 的幂次增长并受上限约束', () => {
  const fixed = () => 0.5
  assert.equal(backoffDelay(1, settings, fixed), 1000)
  assert.equal(backoffDelay(2, settings, fixed), 2000)
  assert.equal(backoffDelay(3, settings, fixed), 4000)
  assert.equal(backoffDelay(4, settings, fixed), 8000)
  assert.equal(backoffDelay(5, settings, fixed), 8000)
  assert.equal(backoffDelay(1024, settings, fixed), 8000)
})

test('抖动区间为 1 - jitterRatio 到 1 + jitterRatio', () => {
  const jittered = { initialDelayMs: 1000, maxDelayMs: 100000, jitterRatio: 0.3 }
  assert.equal(backoffDelay(1, jittered, () => 0), 700)
  assert.equal(backoffDelay(1, jittered, () => 0.5), 1000)
  assert.equal(backoffDelay(1, jittered, () => 1), 1300)
})

test('抖动放大后仍不超过 maxDelayMs', () => {
  const capped = { initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0.3 }
  assert.equal(backoffDelay(1, capped, () => 1), 1000)
  assert.equal(backoffDelay(6, capped, () => 1), 1000)
})

test('任意序号都返回有限整数毫秒', () => {
  for (const retry of [1, 2, 3, 64, 1024, 2048]) {
    const delay = backoffDelay(retry, settings, () => 0.5)
    assert.ok(Number.isSafeInteger(delay), `retry ${retry} -> ${delay}`)
    assert.ok(delay >= 1 && delay <= settings.maxDelayMs)
  }
})
