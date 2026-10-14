// judgement 单测：三层判据的命中面与负例面。
// 报文取自本仓库 references/Codex断连.md 记录的实测文本。

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/core/config.js'
import { TRANSIENT_MESSAGES, shouldRecover } from '../src/core/judgement.js'

const settings = resolveConfig({})

/** 构造一个默认命中的载荷。 */
function payload(overrides = {}) {
  return {
    provider: 'openai-codex',
    failure: { code: 'PI_AI_ERROR', message: 'x' },
    ...overrides,
  }
}

test('三句实测报文各自触发恢复', () => {
  const messages = [
    'Codex error: Our servers are currently overloaded. Please try again later.',
    'Codex error: An error occurred while processing your request. You can retry your request, '
      + 'or contact us through our help center at help.openai.com if the error persists. '
      + 'Please include the request ID 08d3e4fd-5b9c-4190-9a6d-41f9bed0c1b6 in your message.',
    'exceeded request buffer limit while retrying upstream',
  ]
  for (const message of messages) {
    assert.equal(shouldRecover(payload({ failure: { code: 'PI_AI_ERROR', message } }), settings), true, message)
  }
})

test('报文清单是一份可审的三条', () => {
  assert.equal(TRANSIENT_MESSAGES.length, 3)
})

test('provider 不在白名单则不介入', () => {
  const failure = { code: 'PI_AI_ERROR', message: 'Our servers are currently overloaded. Please try again later.' }
  assert.equal(shouldRecover({ provider: 'workbuddy', failure }, settings), false)
  assert.equal(shouldRecover({ provider: undefined, failure }, settings), false)
})

test('非本错误码一律不介入', () => {
  const message = 'Our servers are currently overloaded. Please try again later.'
  for (const code of ['AUTH', 'QUOTA_EXCEEDED', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'RATE_LIMIT', 'SERVER', 'TRANSPORT', 'TIMEOUT']) {
    assert.equal(shouldRecover(payload({ failure: { code, message } }), settings), false, code)
  }
})

test('同码但非瞬态文本不介入', () => {
  const messages = [
    'pi-ai stream for model "gpt-6.1-sol" ended pending',
    'pi-ai deferred response for model "gpt-6.1-sol" is not supported',
    'An error occurred while processing your request.',
    '',
  ]
  for (const message of messages) {
    assert.equal(shouldRecover(payload({ failure: { code: 'PI_AI_ERROR', message } }), settings), false, message)
  }
})

test('message 非字符串时不介入且不抛错', () => {
  assert.equal(shouldRecover(payload({ failure: { code: 'PI_AI_ERROR', message: undefined } }), settings), false)
  assert.equal(shouldRecover(payload({ failure: { code: 'PI_AI_ERROR' } }), settings), false)
  assert.equal(shouldRecover({ provider: 'openai-codex' }, settings), false)
})

test('判据无跨次状态（正则不带 g 标志）', () => {
  const once = payload({ failure: { code: 'PI_AI_ERROR', message: 'exceeded request buffer limit while retrying upstream' } })
  assert.equal(shouldRecover(once, settings), true)
  assert.equal(shouldRecover(once, settings), true)
})

test('上游升级改写后的报文仍在命中面内（安全冗余）', () => {
  const message = 'Network transport failure: exceeded request buffer limit while retrying upstream'
  assert.equal(shouldRecover(payload({ failure: { code: 'PI_AI_ERROR', message } }), settings), true)
})
