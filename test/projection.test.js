/**
 * 会话花费投影的回归测试。
 * 每个用例都把 view() 的输出喂给投影自己的 zod schema, 因为宿主就是这么校验的:
 * 任何 NaN / 负数泄漏到 view 都会在宿主侧炸掉整个投影。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, makeCostProjection, TIDE_PRICES } from '../src/index.js'

/** cutoff 推到远期, 让 phase 恒为 flat, 使断言不随跑测试的时刻漂移。 */
const config = Config({ tideCutoff: '2099-01-01T00:00:00+08:00' })

const modelEvent = (model) => ({ type: 'request/header', data: { header: { config: { model } } } })
const usageEvent = (turn, step, usage) => ({ type: 'assistant/message', data: { turn, step, usage } })
const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
})

/** 折叠一串事件并返回通过 schema 校验后的视图。 */
const run = (events, projection = makeCostProjection(config)) => {
  let state = projection.init()
  for (const event of events) state = projection.apply(state, event)
  const view = projection.view(state)
  // 校验失败会抛, 等同于宿主侧的行为。
  return projection.schema.parse(view)
}

test('按 flat 价折算单模型花费', () => {
  const view = run([
    modelEvent('deepseek-v4-flash'),
    usageEvent(1, 1, usage(1e6, 1e6)),
  ])
  const p = TIDE_PRICES.flat['deepseek-v4-flash']
  assert.equal(view.phase, 'flat')
  assert.equal(view.cost, (1e6 * p.cacheMiss + 1e6 * p.output) / 1e6)
  assert.deepEqual(view.models, ['deepseek-v4-flash'])
  assert.equal(view.tokens.uncachedInput, 1e6)
  assert.equal(view.tokens.output, 1e6)
})

test('缓存命中与写入分别按 hit / miss 价计费', () => {
  const view = run([
    modelEvent('deepseek-v4-pro'),
    usageEvent(1, 1, usage(0, 0, 2e6, 1e6)),
  ])
  const p = TIDE_PRICES.flat['deepseek-v4-pro']
  // 缓存写入并入未命中输入计价。
  assert.equal(view.cost, (1e6 * p.cacheMiss + 2e6 * p.cacheHit) / 1e6)
  assert.equal(view.tokens.cacheRead, 2e6)
  assert.equal(view.tokens.cacheWrite, 1e6)
})

test('同一 (turn, step) 的累积样本替换而非叠加', () => {
  const view = run([
    modelEvent('deepseek-v4-flash'),
    usageEvent(1, 1, usage(100, 50)),
    usageEvent(1, 1, usage(300, 150)), // 累积值刷新, 不是增量
  ])
  assert.equal(view.tokens.uncachedInput, 300)
  assert.equal(view.tokens.output, 150)
})

test('不同 step 的样本累加', () => {
  const view = run([
    modelEvent('deepseek-v4-flash'),
    usageEvent(1, 1, usage(100, 50)),
    usageEvent(1, 2, usage(200, 80)),
    usageEvent(2, 1, usage(50, 10)),
  ])
  assert.equal(view.tokens.uncachedInput, 350)
  assert.equal(view.tokens.output, 140)
})

test('同一步骤内换模型时, 旧模型的归属被扣回', () => {
  const view = run([
    modelEvent('deepseek-v4-flash'),
    usageEvent(1, 1, usage(1e6, 1e6)),
    modelEvent('deepseek-v4-pro'),
    usageEvent(1, 1, usage(1e6, 1e6)),
  ])
  // 同一步骤只应记一次, 且归给最后生效的模型。
  assert.equal(view.tokens.uncachedInput, 1e6)
  assert.equal(view.tokens.output, 1e6)
  const p = TIDE_PRICES.flat['deepseek-v4-pro']
  assert.equal(view.cost, (1e6 * p.cacheMiss + 1e6 * p.output) / 1e6)
  assert.equal(view.costByModel['deepseek-v4-flash'], undefined)
})

test('usage 缺字段不会把 NaN 泄漏进视图', () => {
  // 宿主未必每个字段都给; 旧实现只给 cacheRead/cacheWrite 兜了底,
  // inputTokens / outputTokens 缺失时 NaN 会一路击穿 schema。
  const cases = [
    {},
    { inputTokens: 100 },
    { outputTokens: 100 },
    { inputTokens: undefined, outputTokens: undefined },
    { inputTokens: null, outputTokens: null },
    { inputTokens: NaN, outputTokens: NaN },
    { inputTokens: -5, outputTokens: -5 },
    { inputTokens: '120', outputTokens: '30' },
  ]
  for (const u of cases) {
    const view = run([modelEvent('deepseek-v4-flash'), usageEvent(1, 1, u)])
    assert.ok(Number.isFinite(view.cost), `usage=${JSON.stringify(u)} 的 cost 应是有限数`)
    assert.ok(view.cost >= 0, `usage=${JSON.stringify(u)} 的 cost 应非负`)
    for (const [k, v] of Object.entries(view.tokens)) {
      assert.ok(Number.isInteger(v) && v >= 0, `usage=${JSON.stringify(u)} 的 tokens.${k} 应是非负整数`)
    }
  }
})

test('叫 toString 的模型被正常记账, 而不是穿透到原型', () => {
  // 旧实现: `model in state.byModel` 对 'toString' 恒为 true, 模型不进 modelOrder,
  // 花费直接丢失; priceOf 又会取到 Object.prototype.toString 令 cost 变 NaN。
  const view = run([
    modelEvent('toString'),
    usageEvent(1, 1, usage(1e6, 1e6)),
  ])
  assert.deepEqual(view.models, ['toString'])
  const p = config.defaultPrices
  assert.equal(view.cost, (1e6 * p.cacheMiss + 1e6 * p.output) / 1e6)
  assert.ok(view.cost > 0)
})

test('未声明模型时归入 unknown', () => {
  const view = run([usageEvent(1, 1, usage(1e6, 0))])
  assert.deepEqual(view.models, ['unknown'])
  assert.equal(view.cost, config.defaultPrices.cacheMiss)
})

test('request/context 也能切换模型', () => {
  const view = run([
    { type: 'request/context', data: { model: 'deepseek-v4-pro' } },
    usageEvent(1, 1, usage(1e6, 0)),
  ])
  assert.deepEqual(view.models, ['deepseek-v4-pro'])
  assert.equal(view.cost, TIDE_PRICES.flat['deepseek-v4-pro'].cacheMiss)
})

test('无 usage 事件时视图为空且合法', () => {
  const view = run([modelEvent('deepseek-v4-flash')])
  assert.equal(view.cost, 0)
  assert.deepEqual(view.models, [])
  assert.deepEqual(view.costByModel, {})
})

test('apply 不就地修改传入的 state', () => {
  const projection = makeCostProjection(config)
  const state = projection.init()
  const before = JSON.stringify(state)
  projection.apply(projection.apply(state, modelEvent('deepseek-v4-flash')), usageEvent(1, 1, usage(10, 10)))
  assert.equal(JSON.stringify(state), before)
})

test('多模型各自成账, 顺序按首次出现', () => {
  const view = run([
    modelEvent('deepseek-v4-flash'),
    usageEvent(1, 1, usage(1e6, 0)),
    modelEvent('deepseek-v4-pro'),
    usageEvent(2, 1, usage(1e6, 0)),
  ])
  assert.deepEqual(view.models, ['deepseek-v4-flash', 'deepseek-v4-pro'])
  assert.equal(view.costByModel['deepseek-v4-flash'], TIDE_PRICES.flat['deepseek-v4-flash'].cacheMiss)
  assert.equal(view.costByModel['deepseek-v4-pro'], TIDE_PRICES.flat['deepseek-v4-pro'].cacheMiss)
})
