/**
 * dsh-balance-tide — server half.
 *
 * 1. 余额服务: 按 `refreshIntervalMs` 从 DeepSeek `/user/balance` 拉取余额并缓存,
 *    通过 HTTP 路由 `/query-tide` 提供给浏览器(浏览器只读缓存, 不打 DeepSeek)。
 *    密钥优先取配置 `apiKey`, 否则经 `ctx.credentials` 解析 `apiKeyRef`
 *    (默认 `DEEPSEEK_API_KEY`, 即 $DSH_HOME/.credentials.yaml 或进程环境)。
 * 2. 峰谷潮汐: 依据官方定价页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 *    的峰谷时间表, 计算当前价格档位(现行价 / 高峰价 / 低谷价)与下一次切换时刻,
 *    随路由下发, 由浏览器端显示倒计时与使用建议。
 * 3. 会话花费投影: 注册 `sessionProjections` 单元 `queryTideCost`, 在已提交的
 *    会话事件上按模型折叠 token 用量, 用当前时段单价估算本会话消耗。
 *
 * 折叠规则: 同 (turn, step) 的样本替换而非重复计数; 模型取自
 * `request/header` / `request/context`(last-wins)。
 */
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'

export const name = 'dsh-balance-tide'

/** 每个模型每 100 万 token 的价格(以 `currency` 计价)。 */
const ModelPrice = Schema.object({
  /** 缓存命中输入价 */
  cacheHit: Schema.number().min(0).default(0.2),
  /** 缓存未命中输入价(含缓存写入) */
  cacheMiss: Schema.number().min(0).default(2),
  /** 输出价 */
  output: Schema.number().min(0).default(8),
})

export const Config = Schema.object({
  /** 显式 API 密钥; 留空则走 apiKeyRef(credentials / 环境变量) */
  apiKey: Schema.string().default(''),
  /** credentials / 环境变量引用名 */
  apiKeyRef: Schema.string().default('DEEPSEEK_API_KEY'),
  /** DeepSeek API 基址 */
  baseUrl: Schema.string().default('https://api.deepseek.com'),
  /** 服务器向 DeepSeek 查询余额的频率(毫秒) */
  refreshIntervalMs: Schema.number().min(1000).default(300000),
  /** 浏览器刷新显示读取缓存的频率(毫秒) */
  clientPollIntervalMs: Schema.number().min(5000).default(30000),
  /** 单次请求超时(毫秒) */
  timeoutMs: Schema.number().min(1000).default(8000),
  /** 花费估算的计价货币(与 prices 一致) */
  currency: Schema.string().default('CNY'),
  /** 未进入峰谷体系的历史模型静态单价(deepseek-chat / deepseek-reasoner) */
  prices: Schema.dict(ModelPrice).default({
    'deepseek-chat': { cacheHit: 0.1, cacheMiss: 1, output: 2 },
    'deepseek-reasoner': { cacheHit: 1, cacheMiss: 4, output: 16 },
  }),
  /** 未列出的模型的回退单价 */
  defaultPrices: ModelPrice.default({ cacheHit: 0.1, cacheMiss: 1, output: 2 }),
})

// ---------------------------------------------------------------------------
// 峰谷计价时间表(北京时间), 依据官方定价页 2026-08 版:
//   https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// - 2026-08-17T00:00:00+08:00 起采用峰谷定价; 此前为现行统一价。
// - 高峰时段: 09:00-12:00、14:00-18:00; 其余为空闲(低谷)时段, 价格为高峰的一半。
// ---------------------------------------------------------------------------

/** 峰谷定价生效时刻(ms): 2026-08-17T00:00:00+08:00 = 2026-08-16T16:00:00Z */
export const TIDE_CUTOFF_MS = Date.UTC(2026, 7, 16, 16, 0, 0)

/** 高峰时段窗口(北京时间, [start, end) 小时)。 */
export const PEAK_WINDOWS_BJT = [
  { start: 9, end: 12 },
  { start: 14, end: 18 },
]

/** 各档位 v4 系列单价(每 1M token)。 */
export const TIDE_PRICES = {
  /** 现行统一价(2026-08-17 前) */
  flat: {
    'deepseek-v4-flash': { cacheHit: 0.02, cacheMiss: 1, output: 2 },
    'deepseek-v4-pro': { cacheHit: 0.025, cacheMiss: 3, output: 6 },
  },
  /** 低谷价(高峰的半价) */
  offpeak: {
    'deepseek-v4-flash': { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
    'deepseek-v4-pro': { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
  },
  /** 高峰价 */
  peak: {
    'deepseek-v4-flash': { cacheHit: 0.1, cacheMiss: 3, output: 9 },
    'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  },
}

/** 取时刻 t 的北京时间墙钟分量。 */
const beijingParts = (t) => {
  const d = new Date(t + 8 * 3600e3)
  return { h: d.getUTCHours(), y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate() }
}

/** 构造"北京时间 h 点整"的绝对时刻(ms); day 溢出由 Date.UTC 自动进位。 */
const beijingAt = (y, m, day, h) => Date.UTC(y, m, day, h - 8, 0, 0, 0)

/**
 * 计算 t 时刻的潮汐状态。
 * @returns {{phase: 'flat'|'peak'|'offpeak', isPeak: boolean|null, next: {at: number, phase: 'peak'|'offpeak'}, note: string}}
 */
export const computeTide = (t) => {
  if (t < TIDE_CUTOFF_MS) {
    return {
      phase: 'flat',
      isPeak: null,
      next: { at: TIDE_CUTOFF_MS, phase: 'offpeak' },
      note: 'tide-not-started',
    }
  }
  const { h, y, m, day } = beijingParts(t)
  const isPeak = PEAK_WINDOWS_BJT.some((w) => h >= w.start && h < w.end)
  const phase = isPeak ? 'peak' : 'offpeak'
  let nextAt
  let nextPhase
  if (h < 9) {
    nextAt = beijingAt(y, m, day, 9)
    nextPhase = 'peak'
  } else if (h < 12) {
    nextAt = beijingAt(y, m, day, 12)
    nextPhase = 'offpeak'
  } else if (h < 14) {
    nextAt = beijingAt(y, m, day, 14)
    nextPhase = 'peak'
  } else if (h < 18) {
    nextAt = beijingAt(y, m, day, 18)
    nextPhase = 'offpeak'
  } else {
    nextAt = beijingAt(y, m, day + 1, 9)
    nextPhase = 'peak'
  }
  return { phase, isPeak, next: { at: nextAt, phase: nextPhase }, note: 'ok' }
}

/** 取指定模型在指定潮汐档位下的单价。 */
export const priceOf = (config, model, phase) => {
  const tideTable = TIDE_PRICES[phase]
  if (tideTable !== undefined && model in tideTable) return tideTable[model]
  return config.prices[model] ?? config.defaultPrices
}

/** 归一化 DeepSeek 余额响应中的金额字符串。 */
const toAmount = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 归一化 `/user/balance` 响应体。 */
const normalizeBalances = (data) => {
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : []
  return infos.map((info) => ({
    currency: typeof info?.currency === 'string' && info.currency !== '' ? info.currency : 'CNY',
    total: toAmount(info?.total_balance),
    granted: toAmount(info?.granted_balance),
    toppedUp: toAmount(info?.topped_up_balance),
  }))
}

/** 构造会话花费投影单元(按当前时段计价)。 */
export const makeCostProjection = (config) => {
  const zero = () => ({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })
  const bucketsOf = (usage) => ({
    uncachedInputTokens: usage.inputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens,
  })
  const bucketsEqual = (a, b) =>
    a.uncachedInputTokens === b.uncachedInputTokens && a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens && a.outputTokens === b.outputTokens
  const addBuckets = (a, b) => ({
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  })
  const subBuckets = (a, b) => ({
    uncachedInputTokens: a.uncachedInputTokens - b.uncachedInputTokens,
    cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens - b.cacheWriteTokens,
    outputTokens: a.outputTokens - b.outputTokens,
  })
  const round6 = (n) => Math.round(n * 1e6) / 1e6

  return {
    key: 'queryTideCost',
    schema: z.object({
      models: z.array(z.string()),
      cost: z.number().nonnegative(),
      costByModel: z.record(z.string(), z.number().nonnegative()),
      tokens: z.object({
        uncachedInput: z.number().int().nonnegative(),
        cacheRead: z.number().int().nonnegative(),
        cacheWrite: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
      }).strict(),
      currency: z.string(),
      phase: z.string(),
    }).strict(),
    init: () => ({ currentModel: null, last: null, byModel: {}, modelOrder: [] }),
    apply: (state, event) => {
      let nextModel = state.currentModel
      if (event.type === 'request/header') {
        const model = event.data.header?.config?.model
        if (typeof model === 'string' && model !== '') nextModel = model
      } else if (event.type === 'request/context') {
        const model = event.data.model
        if (typeof model === 'string' && model !== '') nextModel = model
      }
      let usage = null
      let turn = 0
      let step = 0
      if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
        ({ turn, step } = event.data)
        usage = event.data.chunk.usage
      } else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
        ({ turn, step, usage } = event.data)
      }
      if (usage === null) {
        return nextModel === state.currentModel ? state : { ...state, currentModel: nextModel }
      }
      const model = nextModel ?? 'unknown'
      const buckets = bucketsOf(usage)
      const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : null
      if (previous !== null && previous.model === model && bucketsEqual(previous.buckets, buckets)) {
        return nextModel === state.currentModel ? state : { ...state, currentModel: nextModel }
      }
      const isNewModel = !(model in state.byModel)
      let byModel = state.byModel
      if (previous !== null) {
        // 同一步骤的替换样本: 先减去旧归属, 再加新归属。
        byModel = { ...byModel, [previous.model]: subBuckets(byModel[previous.model] ?? zero(), previous.buckets) }
      }
      byModel = { ...byModel, [model]: addBuckets(byModel[model] ?? zero(), buckets) }
      return {
        ...state,
        currentModel: nextModel,
        last: { turn, step, model, buckets },
        byModel,
        modelOrder: isNewModel ? [...state.modelOrder, model] : state.modelOrder,
      }
    },
    view: (state) => {
      const phase = computeTide(Date.now()).phase
      const tokens = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      const costByModel = {}
      let cost = 0
      for (const model of state.modelOrder) {
        const b = state.byModel[model] ?? zero()
        tokens.uncachedInput += b.uncachedInputTokens
        tokens.cacheRead += b.cacheReadTokens
        tokens.cacheWrite += b.cacheWriteTokens
        tokens.output += b.outputTokens
        // DeepSeek 计费: 未命中输入(含缓存写入)按 miss 价, 命中按 hit 价, 输出按 output 价。
        // 配置价是"每 1M token"的价格, 因此除以 1e6。
        const p = priceOf(config, model, phase)
        const c = ((b.uncachedInputTokens + b.cacheWriteTokens) * p.cacheMiss +
          b.cacheReadTokens * p.cacheHit +
          b.outputTokens * p.output) / 1e6
        if (c > 0) costByModel[model] = round6(c)
        cost += c
      }
      return {
        models: state.modelOrder,
        cost: round6(cost),
        costByModel,
        tokens,
        currency: config.currency,
        phase,
      }
    },
    stateVersion: 1,
  }
}

export function apply(ctx, config) {
  /** 解析本次刷新使用的密钥(每次操作重新解析, 遵循 credentials seam)。 */
  const resolveKey = async () => {
    if (config.apiKey !== '') return config.apiKey
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(config.apiKeyRef)
        if (hit !== undefined) return hit.value
      } catch {
        /* 解析失败视为未配置 */
      }
    }
    return process.env[config.apiKeyRef] ?? ''
  }

  let cache = { state: 'empty', payload: null, error: null, fetchedAt: 0, lastErrorAt: 0 }
  let inflight = null
  let consecutiveFailures = 0

  const refresh = () => {
    if (inflight !== null) return inflight
    inflight = (async () => {
      const key = await resolveKey()
      if (key === '') {
        cache = { state: 'error', payload: null, error: 'api-key-missing', fetchedAt: 0, lastErrorAt: Date.now() }
        consecutiveFailures++
        return
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.timeoutMs)
      try {
        const res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/user/balance`, {
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`DeepSeek API HTTP ${res.status}`)
        const data = await res.json()
        cache = {
          state: 'ok',
          payload: {
            isAvailable: data?.is_available === true,
            balances: normalizeBalances(data),
          },
          error: null,
          fetchedAt: Date.now(),
          lastErrorAt: 0,
        }
        consecutiveFailures = 0
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        consecutiveFailures++
        if (consecutiveFailures === 1) ctx.logger.warn(`[dsh-balance-tide] balance fetch failed: ${message}`)
        // 保留上次成功值(stale-while-error), 仅标记错误。
        cache = {
          state: cache.state === 'ok' ? 'ok' : 'error',
          payload: cache.payload,
          error: message,
          fetchedAt: cache.fetchedAt,
          lastErrorAt: Date.now(),
        }
      } finally {
        clearTimeout(timer)
      }
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  ctx.effect(() => {
    // 密钥缺失(credentials 提供方尚未就绪)时快速重试, 否则按配置频率轮询。
    let timer = null
    const run = () => {
      void refresh().then(() => {
        const missingKey = cache.state === 'error' && cache.error === 'api-key-missing'
        const delay = missingKey ? 5000 : config.refreshIntervalMs
        timer = setTimeout(run, delay)
      })
    }
    timer = setTimeout(run, 1000)
    return () => clearTimeout(timer)
  }, 'dsh-balance-tide: refresh loop')

  // 可选 webServer: 提供浏览器读取的缓存端点(headless 组合不受影响)。
  ctx.inject(['webServer'], (webCtx) => {
    const serialize = () => {
      const now = Date.now()
      const tide = computeTide(now)
      const base = {
        ok: cache.state === 'ok',
        fetchedAt: cache.fetchedAt,
        refreshIntervalMs: config.refreshIntervalMs,
        clientPollIntervalMs: config.clientPollIntervalMs,
        currency: config.currency,
        // 静态历史模型定价(deepseek-chat / reasoner 等不参与峰谷)
        prices: config.prices,
        defaultPrices: config.defaultPrices,
        // 峰谷潮汐
        tide: {
          now,
          cutoff: TIDE_CUTOFF_MS,
          phase: tide.phase,
          isPeak: tide.isPeak,
          note: tide.note,
          next: tide.next,
          peakWindows: '09:00-12:00 / 14:00-18:00',
          currentPrices: TIDE_PRICES[tide.phase],
          nextPrices: TIDE_PRICES[tide.next.phase],
        },
      }
      if (cache.state === 'ok') {
        return {
          ...base,
          isAvailable: cache.payload.isAvailable,
          balances: cache.payload.balances,
          ...(cache.error !== null ? { error: cache.error, stale: true } : {}),
        }
      }
      return { ...base, error: cache.error ?? 'unknown' }
    }
    const handler = (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' })
        res.end()
        return
      }
      const body = JSON.stringify(serialize())
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    webCtx.effect(() => {
      // /query-tide 为本插件正式路由; /query-balance 为兼容别名,
      // 供仍运行旧 dsh-balance 客户端 bundle 的未刷新页面读取,
      // 避免旧页面对缺失路由收到 HTML 回退后 JSON 解析报错。
      for (const path of ['/query-tide', '/query-balance']) {
        webCtx.webServer.register({ kind: 'exact', path, handler })
      }
    }, 'dsh-balance-tide: routes')
  })

  // 可选 sessionProjections: 会话花费投影。
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(makeCostProjection(config))
  })
}
