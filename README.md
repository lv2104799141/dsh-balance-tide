# dsh-balance-tide

**English** | [简体中文](./README.zh.md)

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-DeepSeek%20Harness-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![version](https://img.shields.io/badge/version-0.1.4-4176E6)](package.json)

**DeepSeek Harness (DSH) Web plugin: account balance + peak/off-peak pricing tide indicator.**

A live readout row under the composer:

```
[standard] peak pricing starts in 2d 5h | Balance ¥28.78 | ~¥0.42 this session | ?
```

Once peak/off-peak pricing takes effect (2026-08-17), the badge and countdown
follow Beijing time in real time:

```
[off-peak] peak in 2h 15m | Balance ¥28.78 | ~¥0.42 this session | ?   ← off-peak hours
[peak] off-peak in 1h 30m | Balance ¥28.78 | ~¥0.42 this session | ?   ← peak hours
```

## Features

- **Pricing badge**: `standard` (before 2026-08-17) / `peak` / `off-peak`, judged live in Beijing time
- **Countdown**: time remaining until the next pricing switch, ticking every second — plan your usage ahead
- **Balance**: live balance from the official `/user/balance` endpoint (granted / topped-up split)
- **Session cost**: estimated at current-period prices (reuses `sessionProjections`; same-turn/step samples replace rather than double-count)
- **Hover details**: full price tables for the current and the next period, the peak/off-peak gap (peak = off-peak × 2), peak windows, and usage advice
- **`?` icon**: opens the official pricing page <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>
- **Zero config**: reuses `DEEPSEEK_API_KEY` from DSH credentials — no key in the repo, ever
- **i18n**: UI follows the interface language (中文 / English)

## Peak/off-peak schedule (Beijing time)

Per the official pricing page (2026-08 edition):

- **From 2026-08-17 00:00**, peak/off-peak pricing applies; before that, current flat prices
- **Peak windows**: 09:00–12:00 and 14:00–18:00; all other hours are off-peak
- **Off-peak = half of peak**

| Model (per 1M tokens) | Flat (hit / miss / output) | Off-peak | Peak |
|---|---|---|---|
| deepseek-v4-flash | 0.02 / 1 / 2 | 0.05 / 1.5 / 4.5 | 0.10 / 3.0 / 9.0 |
| deepseek-v4-pro | 0.025 / 3 / 6 | 0.15 / 4.5 / 13.5 | 0.30 / 9.0 / 27.0 |

## Install

**From npm (once published)**

```sh
dsh plugin --profile web add dsh-balance-tide
```

**From the Git URL**

```sh
dsh plugin --profile web add https://github.com/huanyuLv/dsh-balance-tide
```

**From a local directory**

```sh
dsh plugin --profile web add file:/path/to/dsh-balance-tide
```

Restart `dsh web` to take effect. Requires `pnpm` (`npm i -g pnpm`).

## Configuration (in `$DSH_HOME/profiles/web/cordis.patch.yml`)

```yaml
- id: dsh-balance-tide
  config:
    refreshIntervalMs: 300000   # how often the host polls the balance API
    clientPollIntervalMs: 30000 # how often the browser re-reads the cache
    currency: CNY
```

## Compatibility

- DeepSeek Harness `0.1.0-rc.6`+ (web profile)
- Cross-platform: pure JavaScript + standard browser CSS, no native modules
- License: MIT
