/**
 * dsh-balance-tide — browser half (lazy-CJS 客户端 bundle)。
 *
 * 在 `conversation.composer.dock` 注册一枚读数:
 *   [峰价/谷价/现行价 徽章] [距切换倒计时] | 余额 ¥xx.xx | 本会话约 ¥x.xx | ?
 *
 * - 余额与潮汐: 单例轮询器按服务器下发的 `clientPollIntervalMs` 读取 `/query-tide`
 *   (只读缓存, 不直接访问 DeepSeek); 页面隐藏时暂停轮询。
 * - 倒计时: 组件内每秒本地计时, 基于服务端下发的下一切换时刻。
 * - 本会话消耗: 读取宿主推送的 `queryTideCost` 投影(按当前时段计价)。
 * - 悬停: 当前/切换后各档单价、余额构成、会话消耗、高峰窗口与使用建议;
 *   "?" 图标点击打开官方定价页。
 */
window.__ModuleLoader__.load({
	id: "dsh-balance-tide",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region styles
		const CSS_ID = "dsh-balance-tide/styles.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-balance-tide";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				".dshbt_root{text-align:center;max-width:var(--dsh-chat-content-width);box-sizing:border-box;width:100%;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0;color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;margin:0 auto;font-size:12px;line-height:20px;display:block;overflow:hidden}",
				".dshbt_sep{color:var(--dsw-alias-separator-primary);margin:0 10px}",
				".dshbt_amount{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
				".dshbt_error{color:var(--dsw-alias-state-error-primary)}",
				".dshbt_badge{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;font-weight:600;font-size:11px;line-height:1;border:1px solid currentColor;vertical-align:1px}",
				".dshbt_off{color:var(--dsw-alias-state-success-primary,#2e9e5b);background:color-mix(in srgb, currentColor 12%, transparent)}",
				".dshbt_peak{color:var(--dsw-alias-state-warning-primary,#d97706);background:color-mix(in srgb, currentColor 14%, transparent)}",
				".dshbt_flat{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-separator-primary);background:var(--dsw-alias-interactive-bg-hover)}",
				".dshbt_countdown{font-variant-numeric:tabular-nums;margin-left:8px}",
				".dshbt_pricing{color:var(--dsw-alias-label-tertiary);vertical-align:-2px;display:inline-flex;align-items:center;margin-left:2px;padding:0 2px;border-radius:999px;text-decoration:none}",
				".dshbt_pricing:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}"
			].join("\n");
			document.head.appendChild(tag);
		}
		//#endregion

		//#region formatting
		const CURRENCY_SYMBOLS = { CNY: "¥", USD: "$", EUR: "€" };
		const currencySymbol = (currency) => CURRENCY_SYMBOLS[currency] ?? currency + " ";
		/** 余额/花费显示: 大额 2 位小数, 小额 3~4 位。 */
		function formatMoney(amount, currency) {
			const fixed = amount >= 1 ? 2 : amount >= 0.01 ? 3 : 4;
			return currencySymbol(currency) + amount.toFixed(fixed);
		}
		/** 紧凑 token 数: 517 / 12.2K / 517K / 1.2M。 */
		function formatTokens(n) {
			const scaled = (v) => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
			if (n < 1e3) return String(n);
			if (n < 1e6) return scaled(n / 1e3) + "K";
			return scaled(n / 1e6) + "M";
		}
		function formatClock(ms) {
			if (ms <= 0) return "—";
			return new Date(ms).toLocaleTimeString();
		}
		/** 单价显示: 整数去尾零(¥2 / ¥8), 小数保留 ≤3 位(¥0.2)。 */
		function formatPrice(n, currency) {
			const num = Number(n);
			if (!Number.isFinite(num)) return currencySymbol(currency) + "?";
			return currencySymbol(currency) + (num % 1 === 0 ? String(num) : String(Math.round(num * 1000) / 1000));
		}
		/** 倒计时: 2天3时 / 2时15分 / 45分 / 12秒。 */
		function formatDuration(ms, t) {
			if (!Number.isFinite(ms) || ms < 0) ms = 0;
			const totalSec = Math.floor(ms / 1000);
			const d = Math.floor(totalSec / 86400);
			const h = Math.floor((totalSec % 86400) / 3600);
			const m = Math.floor((totalSec % 3600) / 60);
			if (d > 0) return t("dur.days", { d, h });
			if (h > 0) return t("dur.hours", { h, m });
			if (m > 0) return t("dur.minutes", { m });
			return t("dur.seconds", { s: Math.max(totalSec, 0) });
		}
		/** 官方定价页。 */
		const PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
		//#endregion

		//#region tide store (单例轮询器: 全页面共享一个 fetch 循环)
		const DEFAULT_POLL_MS = 30000;
		let snapshot = { status: "loading" };
		const listeners = new Set();
		let timer = null;
		let pollMs = DEFAULT_POLL_MS;
		let inflight = null;
		let started = false;

		function notify() {
			for (const fn of [...listeners]) fn();
		}

		async function refresh() {
			if (inflight !== null) return inflight;
			inflight = (async () => {
				try {
					const res = await fetch("/query-tide", {
						cache: "no-store",
						headers: { accept: "application/json" }
					});
					if (!res.ok) throw new Error("HTTP " + res.status);
					const data = await res.json();
					if (typeof data.clientPollIntervalMs === "number" && data.clientPollIntervalMs >= 5000) {
						pollMs = Math.min(data.clientPollIntervalMs, 3600000);
					}
					snapshot = { status: "ok", payload: data, at: Date.now() };
				} catch (error) {
					snapshot = {
						status: "error",
						message: error instanceof Error ? error.message : String(error),
						at: Date.now()
					};
				}
				inflight = null;
				notify();
			})();
			return inflight;
		}

		function schedule() {
			if (timer !== null) return;
			timer = setTimeout(() => {
				timer = null;
				if (document.hidden) return; // 页面隐藏时暂停; 由 visibilitychange 恢复
				refresh().then(schedule, schedule);
			}, pollMs);
		}

		const tideStore = {
			subscribe(fn) {
				listeners.add(fn);
				if (!started) {
					started = true;
					refresh().then(schedule, schedule);
				}
				return () => {
					listeners.delete(fn);
					if (listeners.size === 0) {
						started = false;
						if (timer !== null) {
							clearTimeout(timer);
							timer = null;
						}
					}
				};
			},
			getSnapshot() {
				return snapshot;
			}
		};
		//#endregion

		//#region locale
		const NS = "queryTide";
		const zh = {
			"phase.flat": "现行价",
			"phase.peak": "峰价",
			"phase.offpeak": "谷价",
			"phase.flatFull": "现行统一价",
			"phase.peakFull": "高峰价",
			"phase.offpeakFull": "低谷价",
			"countdown.flat": "峰谷计价 {time} 后生效",
			"countdown.peak": "距低谷 {time}",
			"countdown.offpeak": "距高峰 {time}",
			"balance": "余额 {amount}",
			"balanceError": "余额不可用",
			"balanceMissing": "未配置 API Key",
			"sessionCost": "本会话约 {amount}",
			"tip.tide": "当前时段: {label} · {countdown}\n高峰窗口: {windows}(北京时间)",
			"tip.flatNote": "峰谷定价将于 2026-08-17 00:00(北京时间)生效, 空闲时段价格为高峰的一半",
			"tip.currentPrices": "当前价(每 1M token · {currency}):\n{models}",
			"tip.nextPrices": "切换后({label}, 每 1M token):\n{models}",
			"tip.pricingModel": "{model}: 命中 {hit} · 未命中 {miss} · 输出 {output}",
			"tip.balance": "余额: 总额 {total} · 赠送 {granted} · 充值 {toppedUp}\n状态: {status} · 更新于 {time}",
			"tip.statusAvailable": "可用",
			"tip.statusUnavailable": "不足",
			"tip.cost": "本会话消耗(估算, 按当前时段计价): {amount}\n{models}\n输入 {input} tok · 输出 {output} tok",
			"tip.costModel": "{model}: {amount}",
			"tip.error": "获取失败: {error}",
			"tip.gap": "峰谷差距: 高峰价 = 低谷价 × 2(现行价不参与峰谷)",
			"tip.advice": "💡 高峰时段价格为低谷的 2 倍, 请合理安排使用时间",
			"pricing.aria": "查看 DeepSeek 官方定价策略",
			"model.unknown": "未知模型",
			"model.other": "其他模型",
			"unit.minutes": "{n} 分钟",
			"unit.seconds": "{n} 秒",
			"dur.days": "{d}天{h}时",
			"dur.hours": "{h}时{m}分",
			"dur.minutes": "{m}分",
			"dur.seconds": "{s}秒"
		};
		const en = {
			"phase.flat": "standard",
			"phase.peak": "peak",
			"phase.offpeak": "off-peak",
			"phase.flatFull": "Standard pricing",
			"phase.peakFull": "Peak pricing",
			"phase.offpeakFull": "Off-peak pricing",
			"countdown.flat": "peak pricing starts in {time}",
			"countdown.peak": "off-peak in {time}",
			"countdown.offpeak": "peak in {time}",
			"balance": "Balance {amount}",
			"balanceError": "Balance unavailable",
			"balanceMissing": "API key not configured",
			"sessionCost": "~{amount} this session",
			"tip.tide": "Now: {label} · {countdown}\nPeak windows: {windows} (Beijing time)",
			"tip.flatNote": "Peak/off-peak pricing takes effect 2026-08-17 00:00 (Beijing), off-peak is half of peak",
			"tip.currentPrices": "Current prices (per 1M tokens · {currency}):\n{models}",
			"tip.nextPrices": "After switch ({label}, per 1M tokens):\n{models}",
			"tip.pricingModel": "{model}: hit {hit} · miss {miss} · output {output}",
			"tip.balance": "Balance: total {total} · granted {granted} · topped up {toppedUp}\nStatus: {status} · updated {time}",
			"tip.statusAvailable": "available",
			"tip.statusUnavailable": "insufficient",
			"tip.cost": "This session (est., current period): {amount}\n{models}\nInput {input} tok · Output {output} tok",
			"tip.costModel": "{model}: {amount}",
			"tip.error": "Fetch failed: {error}",
			"tip.gap": "Peak/off-peak gap: peak = off-peak × 2 (legacy pricing not affected)",
			"tip.advice": "💡 Peak hours cost 2× off-peak — plan your usage accordingly",
			"pricing.aria": "View the official DeepSeek pricing",
			"model.unknown": "unknown model",
			"model.other": "other models",
			"unit.minutes": "{n} min",
			"unit.seconds": "{n} s",
			"dur.days": "{d}d {h}h",
			"dur.hours": "{h}h {m}m",
			"dur.minutes": "{m}m",
			"dur.seconds": "{s}s"
		};
		//#endregion

		//#region component
		function formatInterval(ms, t) {
			const minutes = Math.round(ms / 60000);
			return minutes >= 1 ? t("unit.minutes", { n: minutes }) : t("unit.seconds", { n: Math.round(ms / 1000) });
		}

		/**
		 * 余额 + 潮汐读数: 徽章(峰/谷/现行) + 倒计时 + 余额 + 本会话花费。
		 * 独立一行居中显示, 不做任何负 margin 对齐(避免与底部文字重叠)。
		 */
		const TideReadout = react.memo(function TideReadout({ useProjection, t }) {
			const cost = useProjection("queryTideCost");
			const snap = react.useSyncExternalStore(tideStore.subscribe, tideStore.getSnapshot, tideStore.getSnapshot);
			const [pricingHover, setPricingHover] = react.useState(false);
			const [, setTick] = react.useState(0);

			// 每秒 tick 一次, 驱动倒计时刷新。
			react.useEffect(() => {
				const id = setInterval(() => setTick((x) => x + 1), 1000);
				return () => clearInterval(id);
			}, []);

			const groups = [];
			const tooltipLines = [];

			// —— 潮汐段(独立于余额, 只要 /query-tide 可达就显示) ——
			if (snap.status === "ok" && snap.payload !== null && snap.payload.tide !== null && typeof snap.payload.tide === "object") {
				const tide = snap.payload.tide;
				const phase = tide.phase ?? "flat";
				const badgeCls = phase === "peak" ? "dshbt_peak" : phase === "offpeak" ? "dshbt_off" : "dshbt_flat";
				const label = t("phase." + phase);
				const remaining = (tide.next?.at ?? 0) - Date.now();
				const countdown = t("countdown." + phase, { time: formatDuration(remaining, t) });

				groups.push(react.createElement("span", { className: "dshbt_badge " + badgeCls, key: "tide" }, label));
				groups.push(react.createElement("span", { className: "dshbt_countdown", key: "cd" }, countdown));

				const fullLabel = t("phase." + phase + "Full");
				tooltipLines.push(t("tip.tide", {
					label: fullLabel,
					countdown,
					windows: tide.peakWindows ?? "09:00-12:00 / 14:00-18:00"
				}));
				if (tide.note === "tide-not-started") {
					tooltipLines.push(t("tip.flatNote"));
				}

				// 当前档与切换后档的单价表。
				const currency = typeof snap.payload.currency === "string" ? snap.payload.currency : "CNY";
				const priceLines = (table, titleKey, labelForNext) => {
					if (table === null || typeof table !== "object") return;
					const lines = [];
					for (const [model, p] of Object.entries(table)) {
						if (p !== null && typeof p === "object") {
							lines.push(t("tip.pricingModel", {
								model,
								hit: formatPrice(p.cacheHit, currency),
								miss: formatPrice(p.cacheMiss, currency),
								output: formatPrice(p.output, currency)
							}));
						}
					}
					if (lines.length > 0) {
						tooltipLines.push(t(titleKey, { currency, label: labelForNext, models: lines.join("\n") }));
					}
				};
				priceLines(tide.currentPrices, "tip.currentPrices", "");
				if (tide.next?.phase !== undefined && tide.next.phase !== phase) {
					priceLines(tide.nextPrices, "tip.nextPrices", t("phase." + tide.next.phase + "Full"));
				}

				// 峰谷差距(生效后): 恒在建议行之前。
				if (tide.phase !== "flat") {
					tooltipLines.push(t("tip.gap"));
				}

				// 使用建议恒在潮汐段末尾。
				tooltipLines.push(t("tip.advice"));
			}

			// —— 余额段 ——
			if (snap.status === "ok") {
				const info = snap.payload;
				if (info.ok === true && Array.isArray(info.balances) && info.balances.length > 0) {
					const primary = info.balances[0];
					const amount = formatMoney(primary.total, primary.currency);
					groups.push(react.createElement("span", { className: "dshbt_amount", key: "bal" }, t("balance", { amount })));
					const status = info.isAvailable === true ? t("tip.statusAvailable") : t("tip.statusUnavailable");
					tooltipLines.push(t("tip.balance", {
						total: formatMoney(primary.total, primary.currency),
						granted: formatMoney(primary.granted, primary.currency),
						toppedUp: formatMoney(primary.toppedUp, primary.currency),
						status,
						time: formatClock(info.fetchedAt)
					}));
					if (info.stale === true && typeof info.error === "string") {
						tooltipLines.push(t("tip.error", { error: info.error }));
					}
				} else {
					const message = info.error === "api-key-missing" ? t("balanceMissing") : t("balanceError");
					groups.push(react.createElement("span", { className: "dshbt_error", key: "bal" }, message));
					if (typeof info.error === "string") tooltipLines.push(t("tip.error", { error: info.error }));
				}
			} else if (snap.status === "error") {
				groups.push(react.createElement("span", { className: "dshbt_error", key: "bal" }, t("balanceError")));
				tooltipLines.push(t("tip.error", { error: snap.message }));
			}

			// —— 本会话花费段 ——
			if (cost !== undefined && cost.cost > 0) {
				const amount = formatMoney(cost.cost, cost.currency ?? "CNY");
				groups.push(react.createElement("span", { key: "cost" }, t("sessionCost", { amount })));
				const modelLines = (cost.models ?? [])
					.filter((model) => (cost.costByModel[model] ?? 0) > 0)
					.map((model) => t("tip.costModel", {
						model: model === "unknown" ? t("model.unknown") : model,
						amount: formatMoney(cost.costByModel[model], cost.currency ?? "CNY")
					}));
				tooltipLines.push(t("tip.cost", {
					amount,
					models: modelLines.length > 0 ? modelLines.join("\n") : "",
					input: formatTokens(cost.tokens.uncachedInput + cost.tokens.cacheRead + cost.tokens.cacheWrite),
					output: formatTokens(cost.tokens.output)
				}));
			}

			// —— "?" 图标: 点击打开官方定价页 ——
			groups.push(react.createElement(primitives.Tooltip, {
				key: "pricing",
				label: t("pricing.aria"),
				side: "top",
				delayMs: 300,
				children: react.createElement("a", {
					className: "dshbt_pricing",
					href: PRICING_URL,
					target: "_blank",
					rel: "noreferrer",
					"aria-label": t("pricing.aria"),
					title: t("pricing.aria"),
					onMouseEnter: () => setPricingHover(true),
					onMouseLeave: () => setPricingHover(false),
					children: react.createElement(primitives.IconQuestionOutline14, { size: 14 })
				})
			}));

			if (groups.length === 0) return null;

			const line = groups.map((node, i) => react.createElement(react.Fragment, { key: i }, i > 0 ? react.createElement("span", {
				className: "dshbt_sep",
				"aria-hidden": true
			}, "|") : null, node));

			return react.createElement(primitives.Tooltip, {
				label: tooltipLines.length > 0 ? tooltipLines.join("\n") : "",
				side: "top",
				delayMs: 500,
				disabled: tooltipLines.length === 0 || pricingHover,
				children: react.createElement("div", {
					className: "dshbt_root",
					children: line
				})
			});
		});
		//#endregion

		//#region plugin
		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-balance-tide: dictionaries");
			// 等待 ui-conversation 声明 composer.dock 槽位后再注册本条目。
			ctx.slots.inject("conversation.composer.dock", () => {
				const dispose = ctx.slots.register({
					name: "conversation.composer.dock",
					id: "dsh-balance-tide",
					order: 1,
					locale: NS
				}, TideReadout);
				return () => {
					dispose();
				};
			});
			// 页面回到前台时立即刷新一次, 并在隐藏期间跳过定时器。
			ctx.effect(() => {
				const onVisibility = () => {
					if (!document.hidden) refresh().then(schedule, schedule);
				};
				document.addEventListener("visibilitychange", onVisibility);
				return () => document.removeEventListener("visibilitychange", onVisibility);
			}, "dsh-balance-tide: visibility resume");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
