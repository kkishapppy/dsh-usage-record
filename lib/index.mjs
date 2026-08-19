import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
//#region src/index.mjs
const name = "usage-record";
const inject = [
	"webServer",
	"sessions",
	"sessionPersistence"
];
const RECORDS_PATH = "/plugins/dsh-usage-record/records";
const QUESTIONS_PATH = "/plugins/dsh-usage-record/questions";
/** 每会话保留的最大 step 记录数（超出丢最旧）。 */
const MAX_STEPS_PER_SESSION = 500;
/** 内存中的最大会话数（超出丢最旧 updatedAt）。 */
const MAX_SESSIONS = 200;
/** 把 user/message 的 content（string 或 block 数组）转成纯文本。 */
function contentText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((b) => b && typeof b.text === "string" ? b.text : "").join(" ");
	return "";
}
function apply(ctx, config = {}) {
	const dataDir = config.dataDir || join(process.cwd(), "data", "usage-record");
	const storeFile = join(dataDir, "records.json");
	try {
		mkdirSync(dataDir, { recursive: true });
	} catch {}
	/** sessionId -> { steps: StepRec[]（时间正序）, updatedAt } */
	const sessions = /* @__PURE__ */ new Map();
	/** sessionId -> 当前打开 step 的折叠状态 */
	const openSteps = /* @__PURE__ */ new Map();
	/** callId -> { sessionId, time }：step 内工具调用归属 */
	const pendingTools = /* @__PURE__ */ new Map();
	let saveTimer = null;
	/**
	* 提问缓存（新提问推送）：sessionId -> { list: Question[], version }。
	* version 每次新增提问 +1；长轮询等待者按 (sessionId, version) 唤醒。
	*/
	const questionCache = /* @__PURE__ */ new Map();
	/** 长轮询等待者：sessionId -> Set<resolve 回调> */
	const questionWaiters = /* @__PURE__ */ new Map();
	/** 唤醒某会话所有长轮询等待者（新提问到达时调用）。 */
	function wakeQuestionWaiters(sid) {
		const waiters = questionWaiters.get(sid);
		if (!waiters || waiters.size === 0) return;
		for (const resolve of waiters) {
			if (resolve._timer !== void 0) clearTimeout(resolve._timer);
			resolve();
		}
		questionWaiters.delete(sid);
	}
	function load() {
		try {
			if (!existsSync(storeFile)) return;
			const raw = JSON.parse(readFileSync(storeFile, "utf8"));
			if (raw && typeof raw === "object") {
				for (const [sid, entry] of Object.entries(raw)) if (entry && Array.isArray(entry.steps)) sessions.set(sid, entry);
			}
		} catch {}
	}
	load();
	function persist() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			try {
				const out = {};
				for (const [sid, entry] of sessions) out[sid] = entry;
				writeFileSync(storeFile, JSON.stringify(out), "utf8");
			} catch (error) {
				console.error("[usage-record] persist failed:", error);
			}
		}, 1e3);
	}
	const questionsDir = join(dataDir, "questions");
	try {
		mkdirSync(questionsDir, { recursive: true });
	} catch {}
	const questionsFile = (sid) => join(questionsDir, `${sid}.json`);
	const titleIdleMs = Math.max(0, Number(config.titleIdleMinutes ?? 30)) * 6e4;
	const titleHostileIds = /* @__PURE__ */ new Set();
	const lastQuestionAt = /* @__PURE__ */ new Map();
	const stableTitle = /* @__PURE__ */ new Map();
	const MANUAL_TITLES_FILE = join(dataDir, "titles.json");
	const STABLE_TITLES_FILE = join(dataDir, "session-titles.json");
	let manualTitles = {};
	try {
		if (existsSync(MANUAL_TITLES_FILE)) {
			const raw = JSON.parse(readFileSync(MANUAL_TITLES_FILE, "utf8"));
			if (raw && typeof raw === "object") manualTitles = raw;
		}
		if (existsSync(STABLE_TITLES_FILE)) {
			const raw = JSON.parse(readFileSync(STABLE_TITLES_FILE, "utf8"));
			if (raw && typeof raw === "object") {
				for (const [sid, title] of Object.entries(raw)) if (typeof sid === "string" && typeof title === "string" && title.trim() !== "") stableTitle.set(sid, title);
			}
		}
	} catch {}
	function summarizeTitle(text) {
		let t = String(text ?? "").replace(/\s+/g, " ").trim();
		if (t === "") return null;
		if (t.length > 30) t = t.slice(0, 30) + "…";
		return t;
	}
	/** 固化前的候选标题：最后一条提问；太短时并入更早一条（cd 冷会话从索引取）。 */
	function candidateTitleFor(sid) {
		const q = questionCache.get(sid);
		const list = q && q.list || readQuestionIndex(sid) || null;
		if (!list || list.length === 0) return null;
		let t = list[list.length - 1].text ?? "";
		if (t.length < 8 && list.length > 1) t = [list[list.length - 2].text ?? "", t].join(" ");
		return summarizeTitle(t);
	}
	function persistStableTitles() {
		try {
			if (stableTitle.size === 0) return;
			const obj = {};
			for (const [sid, title] of stableTitle) obj[sid] = title;
			writeFileSync(STABLE_TITLES_FILE, JSON.stringify(obj), "utf8");
		} catch {}
	}
	/** 定时固化：闲置超时的会话出标题（离开对话才开始计时）。 */
	const titleTimer = setInterval(() => {
		const now = Date.now();
		let changed = false;
		for (const sid of titleHostileIds) {
			const lastTs = lastQuestionAt.get(sid);
			if (lastTs === void 0 || now - lastTs >= titleIdleMs) {
				const title = candidateTitleFor(sid);
				if (title) {
					stableTitle.set(sid, title);
					changed = true;
				}
				titleHostileIds.delete(sid);
			}
		}
		if (changed) persistStableTitles();
	}, 6e4);
	if (titleIdleMs === 0) titleTimer.unref();
	const originalList = typeof ctx.sessionPersistence?.list === "function" ? ctx.sessionPersistence.list.bind(ctx.sessionPersistence) : null;
	if (originalList) ctx.sessionPersistence.list = async (...args) => {
		const result = await originalList(...args);
		const rows = Array.isArray(result) ? result : result && Array.isArray(result.rows) ? result.rows : null;
		if (!rows) return result;
		const decorated = rows.map((row) => {
			if (!row || typeof row !== "object") return row;
			const sid = row.id ?? row.sessionId;
			if (typeof sid !== "string" || sid === "") return row;
			if (row.title && String(row.title).trim() !== "") return row;
			const title = manualTitles[sid] || stableTitle.get(sid);
			if (!title) return row;
			return {
				...row,
				title
			};
		});
		return Array.isArray(result) ? decorated : {
			...result,
			rows: decorated
		};
	};
	/** Read the persisted question index for a session, if present. */
	function readQuestionIndex(sid) {
		try {
			const f = questionsFile(sid);
			if (!existsSync(f)) return null;
			const raw = JSON.parse(readFileSync(f, "utf8"));
			if (raw && Array.isArray(raw.questions)) return raw.questions;
		} catch {}
		return null;
	}
	/** Append a new question to the persisted index (write-time indexing). */
	function appendQuestionIndex(sid, question) {
		try {
			const list = readQuestionIndex(sid) ?? [];
			if (list.some((q) => q.id === question.id)) return;
			list.push(question);
			writeFileSync(questionsFile(sid), JSON.stringify({
				sessionId: sid,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
				count: list.length,
				questions: list
			}, null, 2), "utf8");
		} catch (error) {
			console.error("[usage-record] question index write failed:", error);
		}
	}
	ctx.on("session/event", (session, event) => {
		if (!event || typeof event !== "object") return;
		const sid = session?.id ?? session?.sessionId;
		if (typeof sid !== "string" || sid === "") return;
		const t = typeof event.time === "number" ? event.time : Date.now();
		const data = event.data ?? {};
		switch (event.type) {
			case "user/message":
				if (data.source?.kind === "user" && typeof data.id === "string") {
					const text = contentText(data.content).replace(/\s+/g, " ").trim();
					if (text !== "") {
						const question = {
							seq: typeof event.seq === "number" ? event.seq : void 0,
							turn: typeof data.turn === "number" ? data.turn : void 0,
							time: t,
							id: data.id,
							text: text.slice(0, 200)
						};
						const q = questionCache.get(sid) ?? {
							list: [],
							version: 0
						};
						if (!q.list.some((item) => item.id === data.id)) {
							q.list.push(question);
							q.version += 1;
							questionCache.set(sid, q);
							lastQuestionAt.set(sid, t);
							titleHostileIds.add(sid);
							wakeQuestionWaiters(sid);
							appendQuestionIndex(sid, question);
						}
					}
				}
				break;
			case "step/start":
				openSteps.set(sid, {
					turn: data.turn,
					step: data.step,
					startTime: t,
					firstTokenTime: null,
					toolCalls: 0
				});
				break;
			case "assistant/chunk": {
				const st = openSteps.get(sid);
				if (!st || st.turn !== data.turn || st.step !== data.step || st.firstTokenTime !== null) break;
				const chunk = data.chunk;
				if ((typeof chunk === "string" ? chunk : chunk && typeof chunk.text === "string" ? chunk.text : "").trim().length > 0) st.firstTokenTime = t;
				break;
			}
			case "assistant/message": {
				const st = openSteps.get(sid);
				if (!st || st.turn !== data.turn || st.step !== data.step) break;
				const usage = data.usage ?? {};
				const entry = sessions.get(sid) ?? {
					steps: [],
					updatedAt: 0
				};
				entry.steps.push({
					turn: st.turn,
					step: st.step,
					startedAt: st.startTime,
					endedAt: t,
					llmMs: Math.max(0, t - st.startTime),
					ttftMs: st.firstTokenTime !== null ? Math.max(0, st.firstTokenTime - st.startTime) : null,
					tokensOut: typeof usage.outputTokens === "number" ? usage.outputTokens : null,
					tokensIn: typeof usage.inputTokens === "number" ? usage.inputTokens : null,
					toolCalls: st.toolCalls
				});
				if (entry.steps.length > MAX_STEPS_PER_SESSION) entry.steps.splice(0, entry.steps.length - MAX_STEPS_PER_SESSION);
				entry.updatedAt = t;
				sessions.set(sid, entry);
				if (sessions.size > MAX_SESSIONS) {
					let oldest = null;
					for (const [k, v] of sessions) if (!oldest || v.updatedAt < oldest.v.updatedAt) oldest = {
						k,
						v
					};
					if (oldest) sessions.delete(oldest.k);
				}
				openSteps.delete(sid);
				persist();
				break;
			}
			case "tool/call": {
				const st = openSteps.get(sid);
				if (st && data.callId !== void 0) {
					st.toolCalls += 1;
					pendingTools.set(data.callId, {
						sid,
						time: t
					});
				}
				break;
			}
			case "tool/result": {
				const callId = data.message?.source?.callId;
				if (callId !== void 0) pendingTools.delete(callId);
				break;
			}
		}
	});
	const disposeRecords = ctx.webServer.register({
		kind: "exact",
		path: RECORDS_PATH,
		handler: async (_req, res) => {
			try {
				const out = {};
				for (const [sid, entry] of sessions) out[sid] = { steps: [...entry.steps].reverse() };
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ sessions: out }));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: message }));
			}
		}
	});
	/** 从会话日志提取全部提问（缓存未命中/初始化时全量扫描）。
	*  优先读内存态 session.log（attach 中的会话）；冷会话（未 attach/被 LRU 淘汰）
	*  从磁盘读日志（sessionPersistence.loadStored），保证历史提问不丢。 */
	async function scanQuestions(sessionId) {
		const out = [];
		if (sessionId === "") return out;
		let events = null;
		if (typeof ctx.sessions?.get === "function") {
			const session = ctx.sessions.get(sessionId);
			if (session && Array.isArray(session.log)) events = session.log;
		}
		if (events === null && typeof ctx.sessionPersistence?.loadStored === "function") try {
			const stored = await ctx.sessionPersistence.loadStored(sessionId);
			if (stored && Array.isArray(stored.events)) events = stored.events;
		} catch {}
		if (events !== null) for (const event of events) {
			if (!event || event.type !== "user/message") continue;
			const data = event.data ?? {};
			if (data.source?.kind !== "user") continue;
			if (typeof data.id !== "string") continue;
			const text = contentText(data.content).replace(/\s+/g, " ").trim();
			if (text === "") continue;
			out.push({
				seq: typeof event.seq === "number" ? event.seq : void 0,
				turn: typeof data.turn === "number" ? data.turn : void 0,
				id: data.id,
				text: text.slice(0, 200),
				time: typeof event.time === "number" ? event.time : 0
			});
		}
		return out;
	}
	/** 取某会话提问列表（持久化索引优先 → 缓存 → 全量扫描回填索引）。 */
	async function questionsFor(sessionId) {
		const cached = questionCache.get(sessionId);
		if (cached !== void 0 && cached.list.length > 0) return cached;
		const indexed = readQuestionIndex(sessionId);
		if (indexed !== null && indexed.length > 0) {
			const entry = {
				list: indexed,
				version: indexed.length
			};
			questionCache.set(sessionId, entry);
			return entry;
		}
		const list = await scanQuestions(sessionId);
		const entry = {
			list,
			version: list.length
		};
		questionCache.set(sessionId, entry);
		if (list.length > 0) try {
			writeFileSync(questionsFile(sessionId), JSON.stringify({
				sessionId,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
				count: list.length,
				questions: list
			}, null, 2), "utf8");
		} catch {}
		return entry;
	}
	/** 全部提问：从缓存（实时增量）或会话日志提取 user/message（source.kind === 'user'）。 */
	const disposeQuestions = ctx.webServer.register({
		kind: "exact",
		path: QUESTIONS_PATH,
		handler: async (req, res) => {
			try {
				const entry = await questionsFor(new URL(req.url ?? "/", "http://dsh.internal").searchParams.get("sessionId") ?? "");
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({
					questions: entry.list,
					version: entry.version
				}));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: message }));
			}
		}
	});
	/**
	* 提问长轮询：?sessionId=..&v=<上次版本>。
	* 版本未变则挂起（最长 ~25s）；新提问到达（version 增加）立即返回最新列表。
	* 客户端据此实现"事件驱动"刷新——新提问不再依赖 DOM 虚拟化渲染。
	*/
	const disposeQuestionsWait = ctx.webServer.register({
		kind: "exact",
		path: "/plugins/dsh-usage-record/questions/wait",
		handler: async (req, res) => {
			try {
				const url = new URL(req.url ?? "/", "http://dsh.internal");
				const sessionId = url.searchParams.get("sessionId") ?? "";
				const rawV = url.searchParams.get("v") ?? "0";
				const lastV = Number.isFinite(Number(rawV)) ? Number(rawV) : 0;
				if (sessionId === "") {
					res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({
						questions: [],
						version: 0,
						changed: false
					}));
					return;
				}
				const entry = await questionsFor(sessionId);
				if (entry.version > lastV) {
					res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({
						questions: entry.list,
						version: entry.version,
						changed: true
					}));
					return;
				}
				await new Promise((resolve) => {
					const waiters = questionWaiters.get(sessionId) ?? /* @__PURE__ */ new Set();
					waiters.add(resolve);
					questionWaiters.set(sessionId, waiters);
					resolve._timer = setTimeout(() => {
						waiters.delete(resolve);
						if (waiters.size === 0) questionWaiters.delete(sessionId);
						resolve();
					}, 25e3);
				});
				const latest = await questionsFor(sessionId);
				const changed = latest.version > lastV;
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({
					questions: latest.list,
					version: latest.version,
					changed
				}));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: message }));
			}
		}
	});
	return () => {
		clearTimeout(saveTimer);
		clearInterval(titleTimer);
		persistStableTitles();
		disposeRecords();
		disposeQuestions();
		disposeQuestionsWait();
		for (const waiters of questionWaiters.values()) for (const resolve of waiters) {
			if (resolve._timer !== void 0) clearTimeout(resolve._timer);
			resolve();
		}
		questionWaiters.clear();
	};
}
//#endregion
export { QUESTIONS_PATH, RECORDS_PATH, apply, inject, name };
