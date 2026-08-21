# dsh-balance-tide

[English](./README.md) | **简体中文**

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-DeepSeek%20Harness-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![version](https://img.shields.io/badge/version-0.3.0-4176E6)](package.json)

**DeepSeek Harness（DSH）Web 插件：余额 + 峰谷计价潮汐提示。**

在输入框下方显示一行实时读数：

```
[现行价] 峰谷计价 2天5时 后生效 | 余额 ¥28.78 | 本会话约 ¥0.42 | 今日约 ¥5.60 | ?
```

8 月 17 日峰谷定价生效后，徽章与倒计时随北京时间实时切换：

```
[谷价] 距高峰 2时15分 | 余额 ¥28.78 | 本会话约 ¥0.42 | 今日约 ¥5.60 | ?        ← 空闲时段
[峰价] 距低谷 1时30分 | 余额 ¥28.78 | 本会话约 ¥0.42 | 今日约 ¥5.60 | ?        ← 高峰时段
```

## 功能

- **峰谷徽章**：`现行价`（2026-08-17 前）/ `峰价` / `谷价`，按北京时间实时判定
- **倒计时**：距下一次档位切换的剩余时间，每秒刷新，提前规划使用时间
- **余额**：官方 `/user/balance` 实时余额（赠送/充值拆分）
- **本会话消耗**：按当前时段单价估算（复用 `sessionProjections` 折叠，同 turn/step 样本替换不重复计数）
- **今日消耗**：纯客户端估算，按北京日在 `localStorage` 累计本会话消耗的增量，跨天自动清零；仅反映本浏览器看到过的会话，不是账户维度的官方账单
- **悬停明细**：当前价与切换后价格的完整单价表、峰谷差距（高峰 = 低谷 × 2）、高峰窗口与使用建议
- **`?` 图标**：直达官方定价页 <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>
- **零配置**：复用 DSH credentials 中的 `DEEPSEEK_API_KEY`，无需再填密钥，代码仓库中不含任何密钥
- **双语界面**：中文 / English 跟随界面语言

## 峰谷计价规则（北京时间）

依据官方定价页（2026-08 版，最后核对于 2026-08-15）：

- **2026-08-17 00:00 起**采用峰谷定价；此前为现行统一价
- **高峰时段**：09:00–12:00、14:00–18:00；其余为低谷（空闲）时段
- **低谷价 = 高峰价的一半**

| 模型（每 1M token） | 现行价（命中/未命中/输出） | 低谷价 | 高峰价 |
|---|---|---|---|
| deepseek-v4-flash | 0.02 / 1 / 2 | 0.05 / 1.5 / 4.5 | 0.10 / 3.0 / 9.0 |
| deepseek-v4-pro | 0.025 / 3 / 6 | 0.15 / 4.5 / 13.5 | 0.30 / 9.0 / 27.0 |

## 安装

**方式一：npm（推荐）**

```sh
dsh plugin --profile web add dsh-balance-tide
```

**方式二：Git 地址**

```sh
dsh plugin --profile web add https://github.com/huanyuLv/dsh-balance-tide
```

**方式三：本地目录**

```sh
dsh plugin --profile web add file:/path/to/dsh-balance-tide
```

安装后重启 `dsh web` 生效。需要 pnpm（`npm i -g pnpm`）。

## 配置（写入 `$DSH_HOME/profiles/web/cordis.patch.yml`）

```yaml
- id: dsh-balance-tide
  config:
    refreshIntervalMs: 300000   # 服务器拉取余额频率
    clientPollIntervalMs: 30000 # 浏览器轮询频率
    currency: CNY
    allowedHosts: []            # 经域名反代访问时，在此登记该域名
```

官方调价或调整时段时，无需等插件发版，直接覆盖对应配置即可：

```yaml
- id: dsh-balance-tide
  config:
    tideCutoff: '2026-08-17T00:00:00+08:00'   # 峰谷定价生效时刻
    peakWindows:                              # 高峰时段（北京时间整点，左闭右开）
      - { start: 9, end: 12 }
      - { start: 14, end: 18 }
    tidePrices:                               # 各档位单价（每 1M token）
      flat:
        deepseek-v4-flash: { cacheHit: 0.02, cacheMiss: 1, output: 2 }
      peak:
        deepseek-v4-flash: { cacheHit: 0.1, cacheMiss: 3, output: 9 }
      offpeak:
        deepseek-v4-flash: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 }
```

`peakWindows: []` 表示不存在高峰时段（官方日后取消峰谷定价时可这样配）。

## 安全

- **密钥**：优先走 DSH credentials 的 `DEEPSEEK_API_KEY`。配置项 `apiKey` 仅作应急，
  它会以明文落在配置文件里，**不建议填写**。`baseUrl` 必须是 https，明文 http 会被拒绝
  （否则密钥会暴露在链路上）。
- **余额端点**：`/query-tide` 会返回账户余额，因此对读取方做了校验——Host 必须是
  localhost、IP 字面量或 `allowedHosts` 中登记的域名（阻断 DNS rebinding）；带 Origin 的
  请求必须同源（阻断任意网页读取你的余额）。被拒时返回 403。
- **错误信息**：服务端只向浏览器下发有限的错误码，原始异常文本仅写入日志，避免自定义
  `baseUrl` 的完整地址回流到前端。

## 已知限制

- 花费为**估算值**，按当前时段单价折算，实际扣费以官方账单为准。
- 多币种账户的主行只显示第一种货币，其余在悬停明细中列出。
- `deepseek-chat` / `deepseek-reasoner` 已不在官方定价页公示，`prices` 中的静态价仅作回退。

## 开发

```sh
npm install
npm test
```

## 兼容性

- DeepSeek Harness `0.1.0-rc.6`+（web profile）
- Node.js 20 / 22 / 24（CI 覆盖）
- 跨平台：纯 JavaScript + 标准浏览器 CSS，无原生模块（macOS 已验证；Windows/Linux 设计兼容）
- 许可证：MIT
