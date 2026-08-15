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
 *
 * 路由暴露账户余额, 因此对读取方做同源与 Host 校验(见 `isRequestAllowed`),
 * 以阻断跨站读取与 DNS rebinding。
 */
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'

export const name = 'dsh-balance-tide'

// ---------------------------------------------------------------------------
// 峰谷计价时间表(北京时间), 依据官方定价页 2026-08 版:
//   https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// - 2026-08-17T00:00:00+08:00 起采用峰谷定价; 此前为现行统一价。
// - 高峰时段: 09:00-12:00、14:00-18:00; 其余为空闲(低谷)时段, 价格为高峰的一半。
// 以下三个常量仅作为默认值; 官方调价时可经配置覆盖, 无需等插件发版。
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

/** 每个模型每 100 万 token 的价格(以 `currency` 计价)。 */
const ModelPrice = Schema.object({
  /** 缓存命中输入价 */
  cacheHit: Schema.number().min(0).default(0.2),
  /** 缓存未命中输入价(含缓存写入) */
  cacheMiss: Schema.number().min(0).default(2),
  /** 输出价 */
  output: Schema.number().min(0).default(8),
})

/** 高峰窗口(北京时间整点, 左闭右开)。 */
const PeakWindow = Schema.object({
  start: Schema.number().min(0).max(23).default(9),
  end: Schema.number().min(1).max(24).default(12),
})

export const Config = Schema.object({
  /** 显式 API 密钥; 建议留空并改用 apiKeyRef(credentials / 环境变量) */
  apiKey: Schema.string().role('secret').default(''),
  /** credentials / 环境变量引用名 */
  apiKeyRef: Schema.string().default('DEEPSEEK_API_KEY'),
  /** DeepSeek API 基址(必须 https, 明文 http 会被拒绝) */
  baseUrl: Schema.string().default('https://api.deepseek.com'),
  /** 服务器向 DeepSeek 查询余额的频率(毫秒) */
  refreshIntervalMs: Schema.number().min(1000).default(300000),
  /** 浏览器刷新显示读取缓存的频率(毫秒) */
  clientPollIntervalMs: Schema.number().min(5000).default(30000),
  /** 单次请求超时(毫秒) */
  timeoutMs: Schema.number().min(1000).default(8000),
  /** 花费估算的计价货币(与 prices 一致) */
  currency: Schema.string().default('CNY'),
  /**
   * 允许读取 `/query-tide` 的额外 Host(不含端口)。
   * localhost 与 IP 字面量恒被允许; 经域名反代访问时在此登记该域名。
   */
  allowedHosts: Schema.array(Schema.string()).default([]),
  /** 峰谷定价生效时刻(可被 Date.parse 解析的字符串); 留空用官方公布值 */
  tideCutoff: Schema.string().default(''),
  /** 高峰时段窗口(北京时间整点); 官方调整时段时覆盖此项 */
  peakWindows: Schema.array(PeakWindow).default(PEAK_WINDOWS_BJT),
  /** 各档位单价; 官方调价时覆盖此项, 无需等插件发版 */
  tidePrices: Schema.object({
    flat: Schema.dict(ModelPrice).default(TIDE_PRICES.flat),
    offpeak: Schema.dict(ModelPrice).default(TIDE_PRICES.offpeak),
    peak: Schema.dict(ModelPrice).default(TIDE_PRICES.peak),
  }).default(TIDE_PRICES),
  /**
   * 未进入峰谷体系的历史模型静态单价。
   * deepseek-chat / deepseek-reasoner 已不在官方定价页公示, 此处仅作回退估算。
   */
  prices: Schema.dict(ModelPrice).default({
    'deepseek-chat': { cacheHit: 0.1, cacheMiss: 1, output: 2 },
    'deepseek-reasoner': { cacheHit: 1, cacheMiss: 4, output: 16 },
  }),
  /** 未列出的模型的回退单价 */
  defaultPrices: ModelPrice.default({ cacheHit: 0.1, cacheMiss: 1, output: 2 }),
})

/** 取时刻 t 的北京时间墙钟分量。 */
const beijingParts = (t) => {
  const d = new Date(t + 8 * 3600e3)
  return { h: d.getUTCHours(), y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate() }
}

/** 构造“北京时间 h 点整”的绝对时刻(ms); day/h 溢出由 Date.UTC 自动进位。 */
const beijingAt = (y, m, day, h) => Date.UTC(y, m, day, h - 8, 0, 0, 0)

/** 丢弃非法窗口并按起点排序; 非法配置退化为“全天低谷”而不是抛错。 */
const normalizeWindows = (windows) => {
  const list = Array.isArray(windows) ? windows : []
  return list
    .filter((w) => Number.isInteger(w?.start) && Number.isInteger(w?.end) &&
      w.start >= 0 && w.end <= 24 && w.start < w.end)
    .sort((a, b) => a.start - b.start)
}

const isPeakHour = (h, windows) => windows.some((w) => h >= w.start && h < w.end)

/** 解析 `tideCutoff` 配置; 非法值回退到官方公布值。 */
export const resolveCutoff = (raw) => {
  if (typeof raw !== 'string' || raw === '') return TIDE_CUTOFF_MS
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : TIDE_CUTOFF_MS
}

/**
 * 计算 t 时刻的潮汐状态。
 * @param {number} t 绝对时刻(ms)
 * @param {{cutoff?: number, peakWindows?: Array<{start: number, end: number}>}} [options]
 * @returns {{phase: 'flat'|'peak'|'offpeak', isPeak: boolean|null, next: {at: number, phase: 'peak'|'offpeak'}, note: string}}
 */
export const computeTide = (t, options = {}) => {
  const cutoff = options.cutoff ?? TIDE_CUTOFF_MS
  const windows = normalizeWindows(options.peakWindows ?? PEAK_WINDOWS_BJT)
  if (t < cutoff) {
    return {
      phase: 'flat',
      isPeak: null,
      next: {
        at: cutoff,
        phase: isPeakHour(beijingParts(cutoff).h, windows) ? 'peak' : 'offpeak',
      },
      note: 'tide-not-started',
    }
  }
  const { h, y, m, day } = beijingParts(t)
  const isPeak = isPeakHour(h, windows)
  // 下一次切换必然发生在某个窗口边界的整点; 当天已无边界则顺延到次日首个边界。
  const boundaries = [...new Set(windows.flatMap((w) => [w.start, w.end]))]
    .filter((b) => b > 0 && b < 24)
    .sort((a, b) => a - b)
  const nextHour = boundaries.length === 0
    ? 24
    : boundaries.find((b) => b > h) ?? boundaries[0] + 24
  return {
    phase: isPeak ? 'peak' : 'offpeak',
    isPeak,
    next: {
      at: beijingAt(y, m, day, nextHour),
      phase: isPeakHour(nextHour % 24, windows) ? 'peak' : 'offpeak',
    },
    note: 'ok',
  }
}

/** 描述高峰窗口, 供界面展示(例: `09:00-12:00 / 14:00-18:00`)。 */
export const describeWindows = (windows) => {
  const list = normalizeWindows(windows)
  if (list.length === 0) return '—'
  const pad = (h) => String(h).padStart(2, '0') + ':00'
  return list.map((w) => `${pad(w.start)}-${pad(w.end)}`).join(' / ')
}

/** 取指定档位的潮汐价格表(缺失档位回退到内置默认)。 */
const tideTableOf = (config, phase) => {
  const table = config.tidePrices?.[phase]
  if (table !== null && typeof table === 'object') return table
  return TIDE_PRICES[phase]
}

/**
 * 取指定模型在指定潮汐档位下的单价。
 * 全程用 `Object.hasOwn` 而非 `in` / 裸索引, 避免 `toString` 之类的模型名
 * 命中 Object.prototype 后返回函数, 令后续算术退化为 NaN。
 */
export const priceOf = (config, model, phase) => {
  const tideTable = tideTableOf(config, phase)
  if (tideTable !== undefined && Object.hasOwn(tideTable, model)) return tideTable[model]
  if (config.prices !== undefined && Object.hasOwn(config.prices, model)) return config.prices[model]
  return config.defaultPrices
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
  const cutoff = resolveCutoff(config.tideCutoff)
  const zero = () => ({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })
  /** 宿主可能省略任一 token 字段; 一律折成非负整数, 否则 NaN 会击穿投影 schema。 */
  const count = (value) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
  }
  const bucketsOf = (usage) => ({
    uncachedInputTokens: count(usage?.inputTokens),
    cacheReadTokens: count(usage?.cacheReadTokens),
    cacheWriteTokens: count(usage?.cacheWriteTokens),
    outputTokens: count(usage?.outputTokens),
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
  /** byModel 用 null 原型, 使 `toString` 等模型名不再穿透到 Object.prototype。 */
  const emptyByModel = () => Object.create(null)

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
    init: () => ({ currentModel: null, last: null, byModel: emptyByModel(), modelOrder: [] }),
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
      const isNewModel = !Object.hasOwn(state.byModel, model)
      let byModel = Object.assign(emptyByModel(), state.byModel)
      if (previous !== null) {
        // 同一步骤的替换样本: 先减去旧归属, 再加新归属。
        const before = Object.hasOwn(byModel, previous.model) ? byModel[previous.model] : zero()
        byModel[previous.model] = subBuckets(before, previous.buckets)
      }
      const current = Object.hasOwn(byModel, model) ? byModel[model] : zero()
      byModel[model] = addBuckets(current, buckets)
      return {
        ...state,
        currentModel: nextModel,
        last: { turn, step, model, buckets },
        byModel,
        modelOrder: isNewModel ? [...state.modelOrder, model] : state.modelOrder,
      }
    },
    view: (state) => {
      const phase = computeTide(Date.now(), { cutoff, peakWindows: config.peakWindows }).phase
      const tokens = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      const costByModel = {}
      let cost = 0
      for (const model of state.modelOrder) {
        const b = Object.hasOwn(state.byModel, model) ? state.byModel[model] : zero()
        tokens.uncachedInput += b.uncachedInputTokens
        tokens.cacheRead += b.cacheReadTokens
        tokens.cacheWrite += b.cacheWriteTokens
        tokens.output += b.outputTokens
        // DeepSeek 计费: 未命中输入(含缓存写入)按 miss 价, 命中按 hit 价, 输出按 output 价。
        // 配置价是“每 1M token”的价格, 因此除以 1e6。
        const p = priceOf(config, model, phase)
        const c = ((b.uncachedInputTokens + b.cacheWriteTokens) * (p?.cacheMiss ?? 0) +
          b.cacheReadTokens * (p?.cacheHit ?? 0) +
          b.outputTokens * (p?.output ?? 0)) / 1e6
        if (Number.isFinite(c) && c > 0) costByModel[model] = round6(c)
        if (Number.isFinite(c)) cost += c
      }
      return {
        models: state.modelOrder,
        cost: round6(Math.max(cost, 0)),
        costByModel,
        tokens: {
          uncachedInput: Math.max(tokens.uncachedInput, 0),
          cacheRead: Math.max(tokens.cacheRead, 0),
          cacheWrite: Math.max(tokens.cacheWrite, 0),
          output: Math.max(tokens.output, 0),
        },
        currency: config.currency,
        phase,
      }
    },
    stateVersion: 1,
  }
}

// ---------------------------------------------------------------------------
// 路由访问控制
// ---------------------------------------------------------------------------

/** localhost 或 IP 字面量(可带端口); DNS rebinding 必然携带域名, 故被此规则排除。 */
const LITERAL_HOST = /^(localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-fA-F:.]+\])(?::\d+)?$/

const hostOf = (value) => {
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * 判定一次 `/query-tide` 读取是否可信。
 * - Host 必须是 localhost / IP 字面量, 或在 `allowedHosts` 中登记(挡 DNS rebinding);
 * - 若带 Origin(跨源 fetch 一定会带), 必须与 Host 同源(挡任意网页读取余额)。
 * @returns {true|string} 通过返回 true, 否则返回拒绝原因
 */
export const isRequestAllowed = (headers, allowedHosts = []) => {
  const host = typeof headers?.host === 'string' ? headers.host.toLowerCase() : ''
  if (host === '') return 'missing-host'
  const bare = host.replace(/:\d+$/, '')
  const hostOk = LITERAL_HOST.test(host) ||
    allowedHosts.some((h) => typeof h === 'string' && h.toLowerCase() === bare)
  if (!hostOk) return 'host-not-allowed'
  const origin = headers.origin
  if (typeof origin === 'string' && origin !== '') {
    // 'null' 来自沙箱 iframe / file://, 无法判定来源, 一律拒绝。
    if (origin === 'null') return 'origin-not-allowed'
    if (hostOf(origin) !== host) return 'origin-not-allowed'
  }
  return true
}

export function apply(ctx, config) {
  const cutoff = resolveCutoff(config.tideCutoff)
  const tideOptions = { cutoff, peakWindows: config.peakWindows }

  /** 环境变量名白名单化, 避免把配置项当成任意环境变量的读取入口。 */
  const isValidRef = (ref) => typeof ref === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)

  /** 解析本次刷新使用的密钥(每次操作重新解析, 遵循 credentials seam)。 */
  const resolveKey = async () => {
    if (config.apiKey !== '') return config.apiKey
    if (!isValidRef(config.apiKeyRef)) return ''
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

  /** 校验并归一化 baseUrl; 明文 http 会把密钥暴露在链路上, 直接拒绝。 */
  const resolveBaseUrl = () => {
    let url
    try {
      url = new URL(config.baseUrl)
    } catch {
      return null
    }
    if (url.protocol !== 'https:') return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  }

  let cache = { state: 'empty', payload: null, error: null, fetchedAt: 0, lastErrorAt: 0 }
  let inflight = null
  let consecutiveFailures = 0

  /**
   * 把异常折叠成有限的错误码集合。
   * 原始 message 可能带上自定义 baseUrl 的完整 URL, 不下发给浏览器, 只进日志。
   */
  const classify = (error) => {
    if (error?.code !== undefined) return error.code
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'timeout'
    return 'network-error'
  }

  const refresh = () => {
    if (inflight !== null) return inflight
    inflight = (async () => {
      const fail = (code, detail) => {
        consecutiveFailures++
        // 首次失败即告警, 之后退避到第 10、100… 次, 避免长期故障完全静默。
        if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0) {
          ctx.logger.warn(`[dsh-balance-tide] balance fetch failed (#${consecutiveFailures}): ${detail}`)
        }
        // 保留上次成功值(stale-while-error), 仅标记错误。
        cache = {
          state: cache.state === 'ok' ? 'ok' : 'error',
          payload: cache.payload,
          error: code,
          fetchedAt: cache.fetchedAt,
          lastErrorAt: Date.now(),
        }
      }
      const key = await resolveKey()
      if (key === '') {
        fail('api-key-missing', `credential ${config.apiKeyRef} not resolved`)
        return
      }
      const base = resolveBaseUrl()
      if (base === null) {
        fail('bad-base-url', `baseUrl must be a valid https URL, got ${config.baseUrl}`)
        return
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.timeoutMs)
      try {
        const res = await fetch(`${base}/user/balance`, {
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          signal: controller.signal,
        })
        if (!res.ok) {
          const known = res.status === 401 || res.status === 403 || res.status === 402 || res.status === 429
          throw Object.assign(new Error(`DeepSeek API HTTP ${res.status}`), {
            code: known ? `http-${res.status}` : 'http-error',
          })
        }
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
        fail(classify(error), error instanceof Error ? error.message : String(error))
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
    let disposed = false
    const run = () => {
      void refresh().then(() => {
        // dispose 可能发生在 refresh 悬空期间; 不加这道闸就会留下无人持有的
        // 定时器, 令插件卸载/热重载后旧循环继续打 DeepSeek。
        if (disposed) return
        const missingKey = cache.state === 'error' && cache.error === 'api-key-missing'
        timer = setTimeout(run, missingKey ? 5000 : config.refreshIntervalMs)
      })
    }
    timer = setTimeout(run, 1000)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, 'dsh-balance-tide: refresh loop')

  // 可选 webServer: 提供浏览器读取的缓存端点(headless 组合不受影响)。
  ctx.inject(['webServer'], (webCtx) => {
    const serialize = () => {
      const now = Date.now()
      const tide = computeTide(now, tideOptions)
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
          cutoff,
          phase: tide.phase,
          isPeak: tide.isPeak,
          note: tide.note,
          next: tide.next,
          peakWindows: describeWindows(config.peakWindows),
          currentPrices: tideTableOf(config, tide.phase),
          nextPrices: tideTableOf(config, tide.next.phase),
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
      // 响应含账户余额, 因此先做同源 / Host 校验再吐数据。
      const verdict = isRequestAllowed(req.headers, config.allowedHosts)
      if (verdict !== true) {
        const body = JSON.stringify({ error: verdict })
        res.writeHead(403, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(body),
        })
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }
      const body = JSON.stringify(serialize())
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        // 明确拒绝任何跨源共享, 并避免被中间层缓存后串给其他来源。
        'Vary': 'Origin',
        'Content-Length': Buffer.byteLength(body),
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    webCtx.effect(() => {
      webCtx.webServer.register({ kind: 'exact', path: '/query-tide', handler })
      // /query-balance 为兼容别名, 供仍运行旧 dsh-balance 客户端 bundle 的
      // 未刷新页面读取。该路径不属于本插件命名空间: 旧插件同时在装时会撞车,
      // 因此单独兜住异常, 不让别名的失败连累上面的正式路由。
      try {
        webCtx.webServer.register({ kind: 'exact', path: '/query-balance', handler })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[dsh-balance-tide] legacy alias /query-balance not registered: ${message}`)
      }
    }, 'dsh-balance-tide: routes')
  })

  // 可选 sessionProjections: 会话花费投影。
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(makeCostProjection(config))
  })
}
