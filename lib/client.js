window.__ModuleLoader__.load({
	id: "dsh-usage-record",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/usage-record.tsx
		const NS = "usage-record";
		const zh = {
			"tooltip.q": "Q{index}",
			"rail.loading": "加载历史中…（{n} 批）"
		};
		const en = {
			"tooltip.q": "Q{index}",
			"rail.loading": "Loading history… ({n} batches)"
		};
		const LINE_H = 4;
		const GAP = 17;
		/** 后台预加载批数上限：预热绝大部分历史（250 批 ≈ 12500 条消息 ≈ 60+ 万事件，
		*  覆盖本机最大会话（~35 万事件 / 70+ 提问）的全部历史；极端超大会话剩余
		*  由 loadUntilVisible 按需加载。2026-08-16 从 60 调大：60 批只覆盖 ~20 条
		*  提问，70 提问级大会话的早期提问点击时仍要逐批现加载（"卡一下"）。 */
		const PRELOAD_BATCH_CAP = 250;
		const SIDE_INSET = 6;
		const BASE_W = 16;
		/** 鱼眼放大参数：正中最粗宽、最大高、影响半径（σ 越小放大越聚焦，邻线保持小线，视觉区分清晰不误触）。 */
		const MAX_W = 46;
		const MAX_H = 13;
		const SIGMA = 12;
		/** 内容区上下留白：边缘横线放大后不被裁剪。 */
		const PAD = 10;
		const QUESTIONS_PATH = "/plugins/dsh-usage-record/questions";
		/** 当前会话 id 读取器（apply 时从 ctx.workspaces 捕获）。 */
		let currentSessionGetter = () => void 0;
		/** 会话切换通知（apply 的 sessions 订阅回调）。 */
		let sessionChangeNotifier = null;
		/** 模块级布局去重/新提问检测状态（勿移入 effect 内部，否则重置导致死循环）。 */
		let lastLayout = "";
		let lastUserRows = -1;
		/** 聊天滚动容器（滚动跟随用）。 */
		let chatScroller = null;
		/** 提问版本号（长轮询用）：服务端每次新增提问 +1。 */
		let questionsVersion = 0;
		/** 组件挂载时注入的 currentId setter（jump 后强制同步 rail 高亮，不等 scroll-spy）。 */
		let currentIdSetter = null;
		/** 滚动跟随：高亮离视口垂直中心最近的那条提问（scroll-spy 居中判定）。 */
		function computeCurrentId(scroller, setCurrentId) {
			const flow = document.querySelector("[data-chat-flow]");
			if (flow === null || scroller === null) return;
			const srect = scroller.getBoundingClientRect();
			const viewportCenter = srect.top + srect.height / 2;
			const rows = [...flow.querySelectorAll("[data-chat-anchor-key][data-chat-flow-kind=\"user\"]")];
			let current = null;
			let bestDist = Infinity;
			for (const row of rows) {
				const m = (row.dataset.chatAnchorKey ?? "").match(/input-message(.+)$/);
				if (m === null) continue;
				const r = row.getBoundingClientRect();
				const center = r.top + r.height / 2;
				const d = Math.abs(center - viewportCenter);
				if (d < bestDist) {
					bestDist = d;
					current = m[1];
				}
			}
			setCurrentId((prev) => prev === current ? prev : current);
		}
		/** 提问列表客户端缓存（sessionId -> { ticks, at }）：切换回已看过的会话秒显，
		*  避免每次切会话都重新 fetch + 重建轨道（后端 scanQuestions 每次全量遍历会话日志）。
		*  5 分钟内复用；新提问由长轮询（/questions/wait）触发 refreshTick 刷新，不依赖此缓存过期。 */
		const questionsCache = /* @__PURE__ */ new Map();
		const QUESTIONS_CACHE_TTL_MS = 300 * 1e3;
		/** 从会话日志服务端路由拉取全部提问（带客户端缓存）。
		*  @param force - 长轮询确认有新提问时传入 true，绕过 5 分钟缓存；
		*  否则新提问要等缓存过期才出现，导航轨看起来"不更新"。 */
		async function fetchQuestions(sessionId, force = false) {
			if (sessionId === void 0 || sessionId === "") return [];
			const cached = questionsCache.get(sessionId);
			if (!force && cached !== void 0 && Date.now() - cached.at < QUESTIONS_CACHE_TTL_MS) return cached.ticks;
			try {
				const res = await fetch(`${QUESTIONS_PATH}?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: "application/json" } });
				if (!res.ok) return [];
				const json = await res.json();
				if (!json || !Array.isArray(json.questions)) return [];
				if (typeof json.version === "number") questionsVersion = json.version;
				const ticks = json.questions.map((q, i) => ({
					id: q.id,
					index: i + 1,
					text: q.text
				}));
				questionsCache.set(sessionId, {
					ticks,
					at: Date.now()
				});
				return ticks;
			} catch {
				return [];
			}
		}
		/** DOM 兜底扫描（服务端路由不可用时的可见子集）。 */
		function scanDomQuestions() {
			const flow = document.querySelector("[data-chat-flow]");
			if (flow === null) return [];
			return [...flow.querySelectorAll("[data-chat-anchor-key][data-chat-flow-kind=\"user\"]")].map((row, i) => {
				const m = (row.dataset.chatAnchorKey ?? "").match(/input-message(.+)$/);
				return {
					id: m !== null ? m[1] : `dom-${i}`,
					index: i + 1,
					text: (row.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160)
				};
			}).filter((t) => t.id !== "");
		}
		/** 布局：轨道定高（最多 MAX_VISIBLE 条可见），超出内容在轨道内上下滚动。
		*  left 锚定聊天真实滚动容器（findScroller，overflow auto/scroll 祖先，结构稳定）：
		*  不能用 [data-chat-flow] 内容列（max-width 居中会偏右），也不用
		*  [data-conversation-scroll]（F12 布局切换时其 rect 会飘到页面最左工作区）。
		*  @param allowEmpty - 提问数据未到（fetch 进行中）时也渲染空轨道骨架：
		*  容器立即出现，数据到达后填充 tick——避免"每次加载都是最后才冒出来"的观感。 */
		function railLayout(ticks, allowEmpty = false) {
			const hidden = {
				visible: false,
				left: 0,
				top: 0,
				height: 0,
				contentH: 0,
				gap: GAP,
				lineH: LINE_H,
				ticks: []
			};
			if (ticks.length === 0 && !allowEmpty) return hidden;
			const flow = document.querySelector("[data-chat-flow]");
			if (flow === null) return hidden;
			const port = findScroller(flow) ?? flow.closest("[data-conversation-scroll]") ?? flow;
			const portRect = port.getBoundingClientRect();
			if (portRect.height <= 0 || portRect.width <= 0) return hidden;
			const seat = port.querySelector("[data-composer-seat]");
			let seatTop = portRect.bottom;
			if (seat instanceof HTMLElement) {
				const st = seat.getBoundingClientRect().top;
				if (st > portRect.top + 80 && st <= portRect.bottom) seatTop = st;
			}
			const visibleH = Math.max(0, seatTop - portRect.top);
			const budgetH = Math.max(1, portRect.height - 24);
			const contentH = ticks.length > 0 ? Math.max(1, ticks.length * 21 - GAP + PAD * 2) : PAD * 2;
			const height = ticks.length > 0 ? Math.min(contentH, 318) : PAD * 2;
			const centerH = visibleH > 60 ? visibleH : budgetH;
			return {
				visible: true,
				left: portRect.left + SIDE_INSET,
				top: portRect.top + Math.max(12, (centerH - height) / 2),
				height,
				contentH,
				gap: GAP,
				lineH: LINE_H,
				ticks
			};
		}
		/** 布局轻量签名：几何值 + ticks 规模/首尾 id/最后 index（O(1) 比较，替代 JSON.stringify 全量序列化）。
		*  index 是连续序号，末位 index 变化能捕获"中间插入/删除"这类首尾不变但内容已变的场景。 */
		function layoutSignature(s) {
			const ticks = s.ticks;
			const n = ticks.length;
			const first = n > 0 ? ticks[0].id : "";
			const last = n > 1 ? ticks[n - 1].id : "";
			const lastIndex = n > 0 ? ticks[n - 1].index : 0;
			return `${s.visible ? 1 : 0}|${s.left}|${s.top}|${s.height}|${s.contentH}|${n}|${first}|${last}|${lastIndex}`;
		}
		/** 可视区虚拟化渲染：只渲染 [scrollTop - overscan, scrollTop + height + overscan] 内的 tick。
		*  保证命中测试/高亮/鱼眼只对可见元素生效（与全量渲染视觉一致，滚动时按需补渲染）。
		*  注意：不能引用组件内部函数（lineCenter 等闭包），全部自包含计算。 */
		const TICK_OVERSCAN = 80;
		function renderTicks(rail, scrollTop, mouseY, active, currentId, step) {
			const out = [];
			const lineCenter = (i) => i * step + rail.lineH / 2;
			const from = Math.max(0, Math.floor((scrollTop - TICK_OVERSCAN - PAD) / step));
			const to = Math.min(rail.ticks.length, Math.ceil((scrollTop + rail.height + TICK_OVERSCAN - PAD) / step));
			for (let i = from; i < to; i++) {
				const tick = rail.ticks[i];
				const center = lineCenter(i);
				const k = fisheye(mouseY === null ? Infinity : Math.abs(center - mouseY));
				const w = BASE_W + (MAX_W - BASE_W) * k;
				const h = rail.lineH + (MAX_H - rail.lineH) * k;
				const isActive = active === tick.index;
				const isCurrent = tick.id === currentId;
				const top = Math.max(PAD, Math.min(PAD + center - h / 2, rail.contentH - PAD - h));
				out.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					"data-question-tick": tick.id,
					style: {
						position: "absolute",
						left: 0,
						top,
						width: w,
						height: h,
						borderRadius: Math.max(2, h / 2),
						background: isActive ? "var(--dsw-alias-accent, #4cc2ff)" : isCurrent ? "#7dd3fc" : "var(--dsh-alias-border-l2, rgba(128,128,128,.45))",
						boxShadow: isCurrent ? "0 0 5px var(--dsw-alias-accent, #4cc2ff)" : "none"
					}
				}, tick.id));
			}
			return out;
		}
		/** 当前高亮的行（用于点击其它区域时清除）。 */
		let highlightedRow = null;
		let highlightedStyles = null;
		/** 高亮行的消息 id（清除时按 id 重新找当前节点——流式/虚拟化可能重建过行节点）。 */
		let highlightedId = null;
		/** 跳转目标的待钉高亮 id：滚动稳定/锁定校正后重新定位高亮（行节点可能被 React 重建、或停在视口边缘）。 */
		let pendingHighlightId = null;
		function clearHighlight() {
			const restore = (row) => {
				if (row === null || highlightedStyles === null) return;
				row.style.outline = highlightedStyles.outline;
				row.style.outlineOffset = highlightedStyles.outlineOffset;
				row.style.background = highlightedStyles.background;
			};
			restore(highlightedRow);
			if (highlightedId !== null) restore(findRow(highlightedId));
			highlightedRow = null;
			highlightedStyles = null;
			highlightedId = null;
		}
		function markHighlight(row) {
			clearHighlight();
			highlightedRow = row;
			highlightedStyles = {
				outline: row.style.outline,
				outlineOffset: row.style.outlineOffset,
				background: row.style.background
			};
			const m = (row.dataset.chatAnchorKey ?? "").match(/input-message(.+)$/);
			highlightedId = m !== null ? m[1] : null;
			row.style.outline = "2px solid var(--dsw-alias-accent, #4cc2ff)";
			row.style.outlineOffset = "-2px";
			row.style.background = "rgba(76, 194, 255, .12)";
		}
		/** 滚动稳定后重新钉高亮（以最新行节点为准）。 */
		function rehighlight(id) {
			if (pendingHighlightId !== id) return;
			const r = findRow(id);
			if (r !== null) markHighlight(r);
		}
		/** 跳转后延迟重钉高亮：smooth 动画 + jump-lock 校正基本结束后执行。 */
		function scheduleRehighlight(id, delayMs) {
			pendingHighlightId = id;
			window.setTimeout(() => rehighlight(id), delayMs);
		}
		/** 从行元素向上找真正可滚动的祖先容器（overflow auto/scroll 且内容超高）。 */
		function findScroller(row) {
			let el = row.parentElement;
			while (el !== null && el !== document.body) {
				const oy = getComputedStyle(el).overflowY;
				if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) return el;
				el = el.parentElement;
			}
			return null;
		}
		/** 按消息 id 找行（DOM key 形如 "13:input-message<uuid>"）。 */
		function findRow(id) {
			const flow = document.querySelector("[data-chat-flow]");
			if (flow === null) return null;
			for (const r of flow.querySelectorAll("[data-chat-anchor-key]")) if ((r.dataset.chatAnchorKey ?? "").includes(`input-message${id}`)) return r;
			return null;
		}
		/** 进行中的历史加载：id -> 完成回调（去重，避免悬停预加载与点击跳转双循环抢按钮）。 */
		const activeLoads = /* @__PURE__ */ new Map();
		/** 后台全量预加载状态（轨道可见时自动启动，把全部旧历史提前加载完）。 */
		let bgPreloading = false;
		let bgPreloadTimer = 0;
		let bgPreloadBatches = 0;
		let onBgPreloadChange = null;
		/** 当前 user 提问行数（判断"加载更早"是否还有增量）。 */
		function countUserRows() {
			const flow = document.querySelector("[data-chat-flow]");
			if (flow === null) return 0;
			return flow.querySelectorAll("[data-chat-anchor-key][data-chat-flow-kind=\"user\"]").length;
		}
		/** 找"加载更早"按钮（无则 null）。 */
		function findLoadOlderBtn() {
			const flow = document.querySelector("[data-chat-flow]");
			if (flow === null) return null;
			return [...flow.querySelectorAll("button")].find((b) => /加载更早|load earlier|加载中|loading/i.test(b.textContent ?? "")) ?? null;
		}
		/**
		* 后台预加载：持续点击"加载更早"直到没有更早（行数不再增长）或达到批次上限。
		* 与 loadUntilVisible 串行：跳转加载进行中（activeLoads 非空）时让路，避免双循环抢按钮。
		* 终止判定：①已渲染行数达到已知提问总数（total）＝全部加载完；
		* ②连续两批行数无增长；③批次上限。不依赖"按钮是否存在"（虚拟化窗口会让按钮暂离 DOM）。
		*/
		function startBackgroundPreload(total = Infinity) {
			if (bgPreloading) return;
			bgPreloading = true;
			bgPreloadBatches = 0;
			onBgPreloadChange?.(true, 0);
			let noGrowth = 0;
			let noBtnTries = 0;
			const tick = () => {
				if (!bgPreloading) return;
				if (activeLoads.size > 0) {
					bgPreloadTimer = window.setTimeout(tick, 200);
					return;
				}
				const btn = findLoadOlderBtn();
				if (btn === null) {
					if (countUserRows() >= total) {
						stopBackgroundPreload();
						return;
					}
					noBtnTries += 1;
					if (noBtnTries >= 40) {
						stopBackgroundPreload();
						return;
					}
					bgPreloadTimer = window.setTimeout(tick, 300);
					return;
				}
				if (btn.disabled) {
					noBtnTries = 0;
					bgPreloadTimer = window.setTimeout(tick, 200);
					return;
				}
				noBtnTries = 0;
				const rowsBefore = countUserRows();
				btn.click();
				bgPreloadBatches += 1;
				onBgPreloadChange?.(true, bgPreloadBatches);
				if (bgPreloadBatches >= PRELOAD_BATCH_CAP) {
					stopBackgroundPreload();
					return;
				}
				const waitBatch = (left) => {
					if (!bgPreloading) return;
					const b2 = findLoadOlderBtn();
					if (left <= 0 || b2 !== null && !b2.disabled) {
						const rowsAfter = countUserRows();
						if (rowsAfter > rowsBefore) noGrowth = 0;
						else if (rowsAfter >= total) {
							stopBackgroundPreload();
							return;
						} else {
							noGrowth += 1;
							if (noGrowth >= 2) {
								stopBackgroundPreload();
								return;
							}
						}
						const slow = bgPreloadBatches >= 10 ? 250 : 120;
						bgPreloadTimer = window.setTimeout(tick, slow);
						return;
					}
					bgPreloadTimer = window.setTimeout(() => waitBatch(left - 1), 150);
				};
				waitBatch(20);
			};
			tick();
		}
		function stopBackgroundPreload() {
			clearTimeout(bgPreloadTimer);
			if (bgPreloading) {
				bgPreloading = false;
				onBgPreloadChange?.(false, bgPreloadBatches);
			}
		}
		/** 持续点击"加载更早"直到目标行出现（或超时），然后回调。
		*  加载期间通过 onBgPreloadChange 显示进度（复用"加载历史中…（n 批）"指示），
		*  让用户看到跳转正在加载而不是"没反应"。 */
		function loadUntilVisible(id, onDone) {
			if (findRow(id) !== null) {
				onDone();
				return;
			}
			console.log("[usage-record] loadUntilVisible start", id.slice(0, 8), { rows: countUserRows() });
			const existing = activeLoads.get(id);
			if (existing !== void 0) {
				activeLoads.set(id, () => {
					existing();
					onDone();
				});
				return;
			}
			activeLoads.set(id, onDone);
			onBgPreloadChange?.(true, 0);
			let lastReported = 0;
			const startTime = Date.now();
			const tick = (tries) => {
				if (findRow(id) !== null) {
					const done = activeLoads.get(id);
					activeLoads.delete(id);
					console.log("[usage-record] loadUntilVisible FOUND after", tries, "tries");
					onBgPreloadChange?.(false, 0);
					done?.();
					return;
				}
				if (Date.now() - startTime > 3e4) {
					activeLoads.delete(id);
					console.warn("[usage-record] loadUntilVisible TIMEOUT (30s), row never appeared:", id);
					onBgPreloadChange?.(false, 0);
					return;
				}
				const btn = findLoadOlderBtn();
				let delay = 100;
				if (btn !== null && !btn.disabled) {
					btn.click();
					delay = 300;
				} else if (btn !== null && btn.disabled) delay = 500;
				else if (btn === null) {
					const flow = document.querySelector("[data-chat-flow]");
					const scroller = flow !== null ? findScroller(flow) : null;
					if (scroller !== null && scroller.scrollTop > 0) scroller.scrollTo({
						top: 0,
						behavior: "auto"
					});
				}
				if (tries % 25 === 0) {
					const rows = countUserRows();
					if (rows !== lastReported) {
						lastReported = rows;
						onBgPreloadChange?.(true, Math.round(tries / 25));
					}
				}
				window.setTimeout(() => tick(tries + 1), delay);
			};
			tick(0);
		}
		/** 流式锁定定时器（新跳转必须取消旧的，否则旧锁定会把视图拉回旧目标）。 */
		let activeStick = 0;
		/** 取消流式 stick：用户任何主动滚动/点击/键盘操作后立即释放，不再把视图拉回目标行。 */
		function cancelActiveStick() {
			if (activeStick !== 0) {
				window.clearInterval(activeStick);
				activeStick = 0;
			}
		}
		/** 跳转锁定期：官方 at-bottom 跟随（流式/新消息到达时 toBottom）会把视图拉回底部，
		*  跳转后 holdMs 内持续监控，目标行偏离视口中心超 60px 就重新定位（用户主动滚动则解锁）。
		*  每次 tick 都以行 id 重新计算目标位置（内容漂移自适应：流式增长/图片加载/历史插入后
		*  目标行实际位置会变，不能用点击瞬间的静态快照，否则跳转位置不准）。 */
		let jumpLock = 0;
		let jumpLockId = null;
		let jumpScroller = null;
		let userScrolledAway = false;
		function cancelJumpLock() {
			if (jumpLock !== 0) {
				window.clearTimeout(jumpLock);
				jumpLock = 0;
			}
			jumpLockId = null;
			jumpScroller = null;
			userScrolledAway = false;
		}
		function armJumpLock(id, scroller, holdMs) {
			cancelJumpLock();
			jumpLockId = id;
			jumpScroller = scroller;
			userScrolledAway = false;
			const started = Date.now();
			const tick = () => {
				if (jumpScroller === null || jumpLockId === null) return;
				if (userScrolledAway) {
					cancelJumpLock();
					return;
				}
				if (scrollAnimRaf !== 0) {
					if (Date.now() - started < holdMs) jumpLock = window.setTimeout(tick, 100);
					else cancelJumpLock();
					return;
				}
				const r = findRow(jumpLockId);
				if (r !== null) {
					const t = computeScrollTarget(r);
					if (t !== null && t.scroller === jumpScroller) {
						const drift = Math.abs(t.scroller.scrollTop - t.top);
						if (drift > 60) {
							console.log("[usage-record] jump-lock: counter-drift", Math.round(drift), "->", Math.round(t.top));
							t.scroller.scrollTo({
								top: t.top,
								behavior: "auto"
							});
						}
						rehighlight(jumpLockId);
					}
				}
				if (Date.now() - started < holdMs) jumpLock = window.setTimeout(tick, 250);
				else cancelJumpLock();
			};
			jumpLock = window.setTimeout(tick, 300);
		}
		/** 计算滚动目标位置（行居中）。返回 null 表示找不到滚动容器。 */
		function computeScrollTarget(r) {
			const scroller = findScroller(r);
			if (scroller === null) return null;
			const rowRect = r.getBoundingClientRect();
			const srect = scroller.getBoundingClientRect();
			const target = scroller.scrollTop + (rowRect.top - srect.top) - (scroller.clientHeight - rowRect.height) / 2;
			return {
				scroller,
				top: Math.max(0, target)
			};
		}
		/** 手动滚动动画：ease-out cubic 缓动，durationMs 到位。
		*  浏览器原生 smooth 时长不可控且偏短（~300ms），用户感知"跳转太快"；
		*  手动动画让视线跟得上。返回是否启动动画。 */
		let scrollAnimRaf = 0;
		function animatedScrollTo(scroller, top, durationMs) {
			cancelAnimationFrame(scrollAnimRaf);
			const start = scroller.scrollTop;
			const delta = top - start;
			if (Math.abs(delta) < 1) return false;
			const t0 = performance.now();
			const ease = (t) => 1 - Math.pow(1 - t, 3);
			const step = (now) => {
				const p = Math.min(1, (now - t0) / durationMs);
				scroller.scrollTop = start + delta * ease(p);
				if (p < 1) scrollAnimRaf = requestAnimationFrame(step);
			};
			scrollAnimRaf = requestAnimationFrame(step);
			return true;
		}
		/** 定位：找到真实滚动容器并滚动到目标行居中；流式生成期间持续重定位对抗跟随滚动。
		*  instant=true 时瞬时到位（加载历史完成后那次跳转用，避免长距离 smooth 动画的感知延迟）。 */
		function jumpToQuestion(id, instant = false) {
			const now = Date.now();
			if (lastJump.id === id && now - lastJump.at < 400) {
				console.log("[usage-record] jump deduped", id.slice(0, 8));
				return;
			}
			lastJump = {
				id,
				at: now
			};
			console.log("[usage-record] jumpToQuestion", id.slice(0, 8), { instant });
			cancelActiveStick();
			cancelJumpLock();
			const row = findRow(id);
			if (row === null) {
				console.log("[usage-record] jump: row missing in DOM -> loadUntilVisible", id.slice(0, 8));
				loadUntilVisible(id, () => jumpToQuestion(id, true));
				return;
			}
			const applyScroll = (r, animate) => {
				const target = computeScrollTarget(r);
				if (target !== null) {
					console.log("[usage-record] jump: scrolling", {
						to: Math.round(target.top),
						now: Math.round(target.scroller.scrollTop)
					});
					const streaming = document.querySelector("[data-streaming]") !== null;
					if (animate && !streaming) {
						animatedScrollTo(target.scroller, target.top, 600);
						armJumpLock(id, target.scroller, 2500);
					} else target.scroller.scrollTo({
						top: target.top,
						behavior: "auto"
					});
				} else {
					console.log("[usage-record] jump: no scroller found, scrollIntoView fallback");
					r.scrollIntoView({
						behavior: "smooth",
						block: "center"
					});
				}
			};
			applyScroll(row, true);
			currentIdSetter?.(id);
			markHighlight(row);
			scheduleRehighlight(id, 700);
			let stickTicks = 0;
			const stick = window.setInterval(() => {
				if (userScrolledAway) {
					window.clearInterval(stick);
					if (activeStick === stick) activeStick = 0;
					return;
				}
				if (document.querySelector("[data-streaming]") === null) {
					window.clearInterval(stick);
					if (activeStick === stick) activeStick = 0;
					return;
				}
				const r = findRow(id);
				if (r !== null) applyScroll(r, false);
				stickTicks += 1;
				if (stickTicks >= 400) {
					window.clearInterval(stick);
					if (activeStick === stick) activeStick = 0;
				}
			}, 300);
			activeStick = stick;
			markHighlight(row);
		}
		/** 鱼眼倍率：距离 dist 处的放大系数（0..1）。 */
		function fisheye(dist) {
			return Math.exp(-(dist * dist) / (2 * SIGMA * SIGMA));
		}
		/** 坐标命中（全实时 DOM）：找到包含点击点的轨道实例，用横线元素真实位置做命中测试。
		*  注意：不能用"逻辑位置"命中——鱼眼放大时边界线会被留白钳制偏移，逻辑位置与实际渲染
		*  位置不一致（曾导致边界线点击错位）；实时 rect 与视觉完全一致。
		*  误触邻线由视觉参数解决（SIGMA/GAP 放大更聚焦、间隙更宽），不靠收窄命中区。 */
		function jumpAtPoint(clientX, clientY) {
			const rails = document.querySelectorAll("[data-question-rail]");
			let el = null;
			for (const r of rails) {
				const rc = r.getBoundingClientRect();
				if (clientX >= rc.left - 2 && clientX <= rc.right + 2 && clientY >= rc.top - 4 && clientY <= rc.bottom + 4) {
					el = r;
					break;
				}
			}
			let best = null;
			let bestD = Infinity;
			if (el !== null) for (const tickEl of el.querySelectorAll("[data-question-tick]")) {
				const t = tickEl.getBoundingClientRect();
				const cy = t.top + t.height / 2;
				const d = Math.abs(cy - clientY);
				if (d < bestD) {
					bestD = d;
					best = tickEl.dataset.questionTick ?? null;
				}
			}
			console.log("[usage-record] click@", {
				x: Math.round(clientX),
				y: Math.round(clientY),
				rails: rails.length,
				hitRail: el !== null,
				bestD: bestD === Infinity ? null : Math.round(bestD),
				best: best === null ? null : best.slice(0, 8)
			});
			if (best !== null && bestD <= 14) jumpToQuestion(best);
		}
		/** 全局调试句柄：浏览器控制台执行 copy(JSON.stringify(__usageRecordDebug()))。 */
		function debugSnapshot() {
			const rails = [...document.querySelectorAll("[data-question-rail]")];
			return {
				rails: rails.length,
				ticksPerRail: rails.map((r) => r.querySelectorAll("[data-question-tick]").length),
				sessionId: currentSessionGetter() ?? null,
				questions: window.__usageRecordQuestions ?? null
			};
		}
		window.__usageRecordDebug = debugSnapshot;
		function QuestionRail(props) {
			const { t } = props;
			const [rail, setRail] = (0, react.useState)({
				visible: false,
				left: 0,
				top: 0,
				height: 0,
				contentH: 0,
				gap: GAP,
				lineH: LINE_H,
				ticks: []
			});
			const [questions, setQuestions] = (0, react.useState)([]);
			const [mouseY, setMouseY] = (0, react.useState)(null);
			/** 鼠标是否在轨道上（悬停时暂停轨道自动跟随滚动，避免点击落空/误触）。 */
			const [mouseOnRail, setMouseOnRail] = (0, react.useState)(false);
			const [scrollTop, setScrollTop] = (0, react.useState)(0);
			const [refreshTick, setRefreshTick] = (0, react.useState)(0);
			/** 当前视口内的提问 id（滚动跟随高亮）。 */
			const [currentId, setCurrentId] = (0, react.useState)(null);
			/** 后台预加载进度（false = 未加载/完成）。 */
			const [bgLoading, setBgLoading] = (0, react.useState)(false);
			const [bgBatches, setBgBatches] = (0, react.useState)(0);
			const mouseYRef = { current: null };
			const rafRef = { current: 0 };
			const lastClientYRef = { current: 0 };
			const railElRef = { current: null };
			const sessionIdRef = { current: props.sessionId ?? currentSessionGetter() };
			sessionIdRef.current = props.sessionId ?? currentSessionGetter();
			const step = rail.lineH + rail.gap;
			const lineCenter = (i) => i * step + rail.lineH / 2;
			let nearest = null;
			rail.ticks.forEach((tick, i) => {
				const d = mouseY === null ? Infinity : Math.abs(lineCenter(i) - mouseY);
				if (nearest === null || d < nearest.dist) nearest = {
					index: tick.index,
					dist: d
				};
			});
			const showTip = mouseY !== null && nearest !== null && nearest.dist < SIGMA * 1.1;
			const active = showTip && nearest !== null ? nearest.index : null;
			const tipTick = showTip && nearest !== null ? rail.ticks.find((t) => t.index === nearest.index) : void 0;
			const tipTop = tipTick === void 0 ? 0 : Math.max(0, Math.min(rail.height - 34, PAD + lineCenter(rail.ticks.indexOf(tipTick)) - scrollTop - 1));
			(0, react.useEffect)(() => {
				sessionChangeNotifier = () => setRefreshTick((t) => t + 1);
				currentIdSetter = (v) => setCurrentId(v);
				onBgPreloadChange = (loading, batches) => {
					setBgLoading(loading);
					setBgBatches(batches);
				};
				return () => {
					sessionChangeNotifier = null;
					currentIdSetter = null;
					onBgPreloadChange = null;
					stopBackgroundPreload();
					cancelJumpLock();
					cancelAnimationFrame(scrollAnimRaf);
				};
			}, []);
			const doRefresh = async (force = false) => {
				const sessionId = sessionIdRef.current;
				console.log("[usage-record] refresh session:", sessionId);
				let ticks;
				if (sessionId === void 0 || sessionId === "") ticks = scanDomQuestions();
				else {
					ticks = await fetchQuestions(sessionId, force);
					if (ticks.length === 0) ticks = scanDomQuestions();
				}
				console.log("[usage-record] refresh ticks:", ticks.length);
				window.__usageRecordQuestions = ticks;
				setQuestions(ticks);
			};
			(0, react.useEffect)(() => {
				let alive = true;
				if (alive) doRefresh(true);
				return () => {
					alive = false;
				};
			}, [refreshTick]);
			(0, react.useEffect)(() => {
				let alive = true;
				let loopTimer = 0;
				const loop = async () => {
					if (!alive) return;
					const sessionId = sessionIdRef.current;
					if (sessionId === void 0 || sessionId === "") {
						loopTimer = window.setTimeout(() => {
							loop();
						}, 2e3);
						return;
					}
					try {
						const res = await fetch(`${QUESTIONS_PATH}/wait?sessionId=${encodeURIComponent(sessionId)}&v=${questionsVersion}`, { headers: { accept: "application/json" } });
						if (!alive) return;
						if (res.ok) {
							const json = await res.json();
							if (json.changed === true && typeof json.version === "number" && json.version > questionsVersion) {
								questionsVersion = json.version;
								setRefreshTick((t) => t + 1);
							}
						}
					} catch {}
					if (alive) loopTimer = window.setTimeout(() => {
						loop();
					}, 500);
				};
				loop();
				return () => {
					alive = false;
					clearTimeout(loopTimer);
				};
			}, [refreshTick]);
			(0, react.useEffect)(() => {
				let alive = true;
				let timer = 0;
				let spyRaf = 0;
				const update = () => {
					if (!alive) return;
					const flow = document.querySelector("[data-chat-flow]");
					if (flow !== null) {
						const rows = flow.querySelectorAll("[data-chat-anchor-key][data-chat-flow-kind=\"user\"]").length;
						if (rows > lastUserRows) {
							lastUserRows = rows;
							setRefreshTick((t) => t + 1);
						}
					}
					const scroller = flow === null ? null : findScroller(flow);
					if (scroller !== chatScroller) {
						if (chatScroller !== null) chatScroller.removeEventListener("scroll", onChatScroll);
						chatScroller = scroller;
						if (scroller !== null) {
							scroller.addEventListener("scroll", onChatScroll, { passive: true });
							onChatScroll();
						}
					} else if (scroller !== null) {
						cancelAnimationFrame(spyRaf);
						spyRaf = requestAnimationFrame(() => {
							if (alive) computeCurrentId(scroller, setCurrentId);
						});
					}
					if (questions.length === 0 && lastLayout.endsWith("|0|||0")) return;
					const next = railLayout(questions, sessionIdRef.current !== void 0 && sessionIdRef.current !== "");
					const key = layoutSignature(next);
					if (key !== lastLayout) {
						lastLayout = key;
						setRail(next);
					}
				};
				const onChatScroll = () => {
					cancelAnimationFrame(spyRaf);
					spyRaf = requestAnimationFrame(() => {
						if (alive && chatScroller !== null) computeCurrentId(chatScroller, setCurrentId);
					});
				};
				const schedule = () => {
					clearTimeout(timer);
					timer = window.setTimeout(update, 120);
				};
				update();
				const flowObserver = new MutationObserver(schedule);
				const flow = document.querySelector("[data-chat-flow]");
				if (flow !== null) flowObserver.observe(flow, {
					childList: true,
					subtree: true
				});
				window.addEventListener("resize", schedule);
				const resizeObserver = new ResizeObserver(schedule);
				if (flow !== null) resizeObserver.observe(flow);
				const port = flow?.closest("[data-conversation-scroll]") ?? flow;
				if (port !== null && port !== flow) resizeObserver.observe(port);
				return () => {
					alive = false;
					clearTimeout(timer);
					cancelAnimationFrame(spyRaf);
					if (chatScroller !== null) chatScroller.removeEventListener("scroll", onChatScroll);
					chatScroller = null;
					flowObserver.disconnect();
					resizeObserver.disconnect();
					window.removeEventListener("resize", schedule);
				};
			}, [questions]);
			(0, react.useEffect)(() => {
				try {
					if (active === null) return;
					const tick = rail.ticks.find((t) => t.index === active);
					if (tick === void 0) return;
					if (findRow(tick.id) === null) loadUntilVisible(tick.id, () => {});
				} catch (error) {
					console.error("[usage-record] hover preload failed:", error);
				}
			}, [active, rail]);
			(0, react.useEffect)(() => {
				if (rail.visible && questions.length > 0) {
					const t = window.setTimeout(() => startBackgroundPreload(questions.length), 400);
					return () => {
						clearTimeout(t);
					};
				}
				stopBackgroundPreload();
			}, [rail.visible, questions]);
			(0, react.useEffect)(() => {
				const el = railElRef.current;
				if (el === null || currentId === null || mouseOnRail) return;
				const idx = rail.ticks.findIndex((t) => t.id === currentId);
				if (idx < 0) return;
				const step = rail.lineH + rail.gap;
				const tickTop = PAD + idx * step;
				if (tickTop < el.scrollTop || tickTop > el.scrollTop + el.clientHeight - step) el.scrollTo({
					top: Math.max(0, tickTop - el.clientHeight / 2),
					behavior: "smooth"
				});
			}, [
				currentId,
				rail,
				mouseOnRail
			]);
			if (!rail.visible) return null;
			const currentIdx = currentId === null ? 0 : rail.ticks.findIndex((t) => t.id === currentId) + 1;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					"data-question-rail": "",
					onMouseEnter: () => {
						setMouseOnRail(true);
						if (rail.ticks.length > 0) startBackgroundPreload(rail.ticks.length);
					},
					ref: (el) => {
						railElRef.current = el;
						if (el !== null && el.dataset.usageRecordBound === void 0) {
							el.dataset.usageRecordBound = "1";
							el.addEventListener("click", (e) => {
								const target = e.target instanceof HTMLElement ? e.target.closest("[data-question-tick]") : null;
								if (target !== null && target.dataset.questionTick !== void 0) jumpToQuestion(target.dataset.questionTick);
							});
						}
					},
					onMouseMove: (e) => {
						lastClientYRef.current = e.clientY;
						const rect = e.currentTarget.getBoundingClientRect();
						const y = e.clientY - rect.top + e.currentTarget.scrollTop;
						if (mouseYRef.current === y) return;
						mouseYRef.current = y;
						cancelAnimationFrame(rafRef.current);
						rafRef.current = requestAnimationFrame(() => setMouseY(mouseYRef.current));
					},
					onMouseLeave: () => {
						setMouseOnRail(false);
						mouseYRef.current = null;
						cancelAnimationFrame(rafRef.current);
						setMouseY(null);
					},
					onScroll: (e) => {
						const el = e.currentTarget;
						const st = el.scrollTop;
						setScrollTop(st);
						if (mouseYRef.current !== null) {
							const rect = el.getBoundingClientRect();
							const y = lastClientYRef.current - rect.top + st;
							mouseYRef.current = y;
							cancelAnimationFrame(rafRef.current);
							rafRef.current = requestAnimationFrame(() => setMouseY(y));
						}
					},
					style: {
						position: "fixed",
						left: rail.left,
						top: rail.top,
						width: 54,
						height: rail.height,
						zIndex: 900,
						cursor: "pointer",
						overflowY: "auto",
						overflowX: "hidden",
						scrollbarWidth: "none"
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							position: "relative",
							height: rail.contentH,
							boxSizing: "border-box",
							paddingTop: PAD,
							paddingBottom: PAD
						},
						children: renderTicks(rail, scrollTop, mouseY, active, currentId, step)
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						position: "fixed",
						left: rail.left - 4,
						top: rail.top + rail.height + 6,
						fontSize: 10,
						lineHeight: 1.4,
						color: "var(--dsw-alias-label-tertiary)",
						fontVariantNumeric: "tabular-nums",
						pointerEvents: "none",
						whiteSpace: "nowrap",
						zIndex: 900
					},
					children: currentIdx > 0 ? `${currentIdx}/${rail.ticks.length}` : `—/${rail.ticks.length}`
				}),
				tipTick !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						position: "fixed",
						left: rail.left + MAX_W + 4,
						top: rail.top + tipTop,
						maxWidth: 280,
						padding: "6px 10px",
						borderRadius: 8,
						pointerEvents: "none",
						background: "var(--dsw-specific-tip, #1a2030)",
						border: "1px solid var(--dsw-alias-border-l1)",
						boxShadow: "0 4px 16px rgba(0,0,0,.35)",
						fontSize: 12,
						lineHeight: 1.5,
						color: "var(--dsw-alias-label-primary)",
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
						zIndex: 901
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: { color: "var(--dsw-alias-label-tertiary)" },
						children: [t("tooltip.q", { index: tipTick.index }), " · "]
					}), tipTick.text || "…"]
				})
			] });
		}
		const inject = [
			"slots",
			"locale",
			"workspaces"
		];
		/** 是否已包装 history RPC（防止 apply 多次运行重复包装）。 */
		let historyPatched = false;
		/** 历史分页批量（官方默认 50；放大后长会话回翻大幅减少往返）。 */
		const HISTORY_BATCH = 3e3;
		/** 去重：同一 id 短时间内不重复跳（document 与元素级监听都会触发）。 */
		let lastJump = {
			id: "",
			at: 0
		};
		function apply(ctx) {
			if (document.querySelector("style[data-usage-record-scrollbar]") === null) {
				const tag = document.createElement("style");
				tag.dataset.usageRecordScrollbar = "";
				tag.textContent = `[data-question-rail]{scrollbar-width:none}[data-question-rail]::-webkit-scrollbar{display:none;width:0;height:0}`;
				document.head.appendChild(tag);
			}
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "usage-record: dictionaries");
			try {
				if (!historyPatched) {
					const api = ctx.workspaces?.api;
					if (api?.sessions && typeof api.sessions.history === "function") {
						const orig = api.sessions.history;
						api.sessions.history = (req) => orig(req.beforeSeq === void 0 ? req : {
							...req,
							maxMessages: HISTORY_BATCH
						});
						historyPatched = true;
						console.log(`[usage-record] history RPC patched (loadOlder only): batch -> ${HISTORY_BATCH}`);
					}
				}
			} catch (error) {
				console.error("[usage-record] history patch failed:", error);
			}
			try {
				const workspaces = ctx.workspaces;
				currentSessionGetter = () => {
					try {
						return workspaces?.sessions?.list?.getSnapshot?.()?.current;
					} catch {
						return;
					}
				};
				if (typeof workspaces?.sessions?.list?.subscribe === "function") {
					let lastCurrent;
					ctx.effect(() => workspaces.sessions.list.subscribe(() => {
						const current = currentSessionGetter();
						if (current !== lastCurrent) {
							lastCurrent = current;
							sessionChangeNotifier?.();
						}
					}), "usage-record: session subscription");
				}
			} catch {}
			document.addEventListener("click", () => {
				pendingHighlightId = null;
				cancelJumpLock();
				cancelActiveStick();
				clearHighlight();
			}, true);
			document.addEventListener("click", (e) => {
				jumpAtPoint(e.clientX, e.clientY);
			}, true);
			document.addEventListener("wheel", () => {
				userScrolledAway = true;
				cancelActiveStick();
			}, true);
			document.addEventListener("touchstart", () => {
				userScrolledAway = true;
				cancelActiveStick();
			}, true);
			document.addEventListener("keydown", () => {
				userScrolledAway = true;
				cancelActiveStick();
			}, true);
			document.addEventListener("mousemove", () => {
				if (activeStick !== 0 || jumpLock !== 0) {
					userScrolledAway = true;
					cancelActiveStick();
				}
			}, true);
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "usage-record",
				order: 30,
				locale: NS
			}, QuestionRail));
		}
		//#endregion
		exports.QuestionRail = QuestionRail;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
