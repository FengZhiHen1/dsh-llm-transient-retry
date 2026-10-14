// 真实组合测试：把一份 cordis.yml 交给真 Loader boot（不是手拼 ctx.plugin），再驱动一次真实 turn。
// 装配范式取自上游 packages/llm/llm-retry/tests/loader-composition.spec.ts（同基线 0.1.7-rc.2）。
//
// 这里能确定性造出真实失败面：故障注入 adapter 用与线上同一条报文 + 同一个错误码抛错，
// 于是 agent/request-error 的载荷与真实过载时逐字段一致，链路（分类之后的全部）都是真的。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as platformRetry from '@deepseek-ai/dsh-llm-retry'
import * as transientRetry from '../src/adapter/index.js'

/** 与线上一致：provider / model 取自 references/Codex断连.md 的失败现场。 */
const PROVIDER = 'openai-codex'
const MODEL = 'gpt-6.1-sol'
/** 参考文件里 7 次失败中出现 4 次的那一句。 */
const OVERLOAD = 'Codex error: Our servers are currently overloaded. Please try again later.'
/** 恢复后模型产出的文本，用来区分「救回来了」与「只是没报错」。 */
const RECOVERED = 'recovered after the overload'

/** 组合里除被测行以外的行；顺序与真实 profile 的关键相对次序一致（平台 llm-retry 在我方之前）。 */
const BASE_ROWS = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm-retry',
]
const OUR_ROW = 'dsh-llm-transient-retry'
const TAIL_ROW = '@deepseek-ai/dsh-agent-loop'

/** Loader 的解析桩：按 specifier 直接给模块，不依赖 node_modules 解析。 */
const MODULES = new Map([
  ['@deepseek-ai/dsh-llm', LlmRuntime],
  ['@deepseek-ai/dsh-session', SessionStore],
  ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
  ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
  ['@deepseek-ai/dsh-tools', ToolRuntime],
  ['@deepseek-ai/dsh-agent', AgentRegistry],
  ['@deepseek-ai/dsh-llm-retry', platformRetry],
  ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  [OUR_ROW, transientRetry],
])

/**
 * 首次调用按给定 failure 抛错、其后成功返回文本的 provider。
 * 抛 LlmError 是 adapter 契约允许的失败方式，运行时会把它的 failure 归一成流终态错误。
 */
class FaultOnceAdapter extends LlmAdapter {
  requests = 0

  /**
   * @param {{code: string, message: string}} failure 首次调用抛出的错误码与报文
   */
  constructor(failure) {
    super()
    this.failure = failure
  }

  async * stream() {
    this.requests += 1
    if (this.requests === 1) throw new LlmError(this.failure.message, this.failure.code)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: RECOVERED }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: RECOVERED } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * boot 一次真 Loader 组合，驱动一次 turn，读回会话事件。
 * @param {object} options 组合与故障参数
 * @param {boolean} options.withOurs 是否包含被测行（消融对照用）
 * @param {{code: string, message: string}} [options.failure] 首次调用抛出的 failure
 * @returns {Promise<object>} 未激活行、请求次数、会话事件、turn 失败原因与最终助手文本
 */
async function runComposition({ withOurs, failure = { code: 'PI_AI_ERROR', message: OVERLOAD } }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-transient-retry-'))
  // 硬隔离：即便组合里有东西读 DSH_HOME，也只能读到这个临时根，碰不到真实实例 HOME。
  process.env.DSH_HOME = root
  const rows = [...BASE_ROWS, ...(withOurs ? [OUR_ROW] : []), TAIL_ROW]
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, `${rows.map((name) => `- name: '${name}'`).join('\n')}\n`)

  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier) {
      const module = MODULES.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()

  try {
    // 机器等价于「N entries did not activate」：已启用却没有 fiber 的行。
    const unloaded = [...ctx.loader.entries()]
      .filter((entry) => entry.fiber === undefined && !entry.disabled)
      .map((entry) => entry.options.name)
    const active = [...ctx.loader.entries()].filter((entry) => entry.fiber !== undefined)
      .map((entry) => entry.options.name)

    const adapter = new FaultOnceAdapter(failure)
    ctx.llm.registerAdapter([PROVIDER], adapter)
    const agent = await ctx.agentLoop.create(SessionId(`transient-${withOurs ? 'on' : 'off'}`), {
      provider: PROVIDER,
      model: MODEL,
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'answer despite the overload' }],
      source: { kind: 'user' },
    }))
    // turn 失败不会让 whenIdle() 拒绝——失败记录在 turn/end 事件里，故断言面取事件而非这个 promise。
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    const last = agent.session.deriveMessages().at(-1)
    const output = last?.role === 'assistant'
      ? last.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
      : undefined
    return { unloaded, active, requests: adapter.requests, events, output }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

/** 本次 turn 的结束原因——参考文件里那条 turn 级失败就是这个字段的 kind === 'error'。 */
function turnEndReason(result) {
  const end = result.events.filter((event) => event.type === 'turn/end').at(-1)
  assert.notEqual(end, undefined, '组合里应记录 turn/end')
  return end.data.reason
}

test('真 Loader 组合 + 真实过载报文：turn 被救回并产出消息', async () => {
  const result = await runComposition({ withOurs: true })

  assert.deepEqual(result.unloaded, [])
  assert.ok(result.active.includes(OUR_ROW), '被测行应处于激活态')
  assert.ok(result.active.includes('@deepseek-ai/dsh-llm-retry'), '平台邻居应同时在场')
  const reason = turnEndReason(result)
  assert.equal(reason.kind, 'completed', `turn 不应以错误结束：${JSON.stringify(reason)}`)
  assert.equal(result.requests, 2, '应恰好重发一次')
  assert.equal(result.output, RECOVERED)

  const retries = result.events.filter((event) => event.type === 'llm/retry')
  assert.equal(retries.length, 1)
  // 键集合精确：既不缺字段，也不偷偷多塞自定义字段（后者会被会话消费者与不变量挑剔）。
  assert.deepEqual(Object.keys(retries[0].data).sort(), [
    'delayMs', 'failure', 'maxRetries', 'mode', 'policyKey', 'provider', 'retry', 'retryId', 'step', 'turn',
  ])
  assert.equal(retries[0].data.mode, 'normal')
  assert.equal(retries[0].data.turn, 1)
  assert.equal(retries[0].data.step, 1)
  assert.equal(retries[0].data.provider, PROVIDER)
  assert.equal(retries[0].data.retry, 1)
  assert.equal(retries[0].data.maxRetries, 3)
  assert.equal(retries[0].data.policyKey, 'llm-transient-retry-v1')
  assert.deepEqual(retries[0].data.failure, { code: 'PI_AI_ERROR', message: OVERLOAD })
  assert.ok(Number.isInteger(retries[0].data.delayMs) && retries[0].data.delayMs > 0)
  assert.ok(typeof retries[0].data.retryId === 'string' && retries[0].data.retryId.length > 0)

  // GUI 的 model-retry 节点按 retryId 聚链、以 retry===1 记为首个 attempt；
  // 这两个字段是它能把本次恢复渲染成一张卡片的全部依据。
  const started = result.events.filter((event) => event.type === 'llm/retry-started')
  assert.equal(started.length, 1)
  assert.deepEqual(started[0].data, { retryId: retries[0].data.retryId, turn: 1, step: 1, retry: 1 })
})

test('消融对照：同一构造移除本插件行后 turn 失败，且无任何重试记录', async () => {
  const result = await runComposition({ withOurs: false })

  assert.deepEqual(result.unloaded, [])
  assert.equal(result.requests, 1, '平台默认策略不覆盖 PI_AI_ERROR，故一次都不重发')
  const reason = turnEndReason(result)
  assert.equal(reason.kind, 'error')
  assert.deepEqual(reason.error, { message: OVERLOAD, code: 'PI_AI_ERROR' })
  assert.equal(result.events.filter((event) => event.type === 'llm/retry').length, 0)
  assert.equal(result.events.filter((event) => event.type === 'llm/retry-started').length, 0)
})

test('同码非瞬态报文：本插件不介入（文本限定确实在起作用）', async () => {
  const result = await runComposition({
    withOurs: true,
    failure: { code: 'PI_AI_ERROR', message: 'Codex error: unauthorized, check your credentials' },
  })

  assert.equal(result.requests, 1)
  const reason = turnEndReason(result)
  assert.equal(reason.kind, 'error')
  assert.equal(reason.error.message, 'Codex error: unauthorized, check your credentials')
  assert.equal(result.events.filter((event) => event.type === 'llm/retry').length, 0)
})
