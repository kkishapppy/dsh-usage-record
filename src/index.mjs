// dsh-usage-record Node half：监听 session/event 采集每轮 LLM 用量（备用），
// 并提供「全部提问」只读路由：从会话日志（session.log）提取所有 user/message
// 事件（source.kind === 'user' 的真实提问，排除插件/压缩检查点），
// 不受聊天视图渲染窗口限制。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'usage-record'
export const inject = ['webServer', 'sessions', 'sessionPersistence']

export const RECORDS_PATH = '/plugins/dsh-usage-record/records'
export const QUESTIONS_PATH = '/plugins/dsh-usage-record/questions'

/** 每会话保留的最大 step 记录数（超出丢最旧）。 */
const MAX_STEPS_PER_SESSION = 500
/** 内存中的最大会话数（超出丢最旧 updatedAt）。 */
const MAX_SESSIONS = 200

/** 把 user/message 的 content（string 或 block 数组）转成纯文本。 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ')
  }
  return ''
}

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir || join(process.cwd(), 'data', 'usage-record')
  const storeFile = join(dataDir, 'records.json')
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch { /* 目录不可建时仅内存运行 */ }

  /** sessionId -> { steps: StepRec[]（时间正序）, updatedAt } */
  const sessions = new Map()
  /** sessionId -> 当前打开 step 的折叠状态 */
  const openSteps = new Map()
  /** callId -> { sessionId, time }：step 内工具调用归属 */
  const pendingTools = new Map()
  let saveTimer = null

  /**
   * 提问缓存（新提问推送）：sessionId -> { list: Question[], version }。
   * version 每次新增提问 +1；长轮询等待者按 (sessionId, version) 唤醒。
   */
  const questionCache = new Map()
  /** 长轮询等待者：sessionId -> Set<resolve 回调> */
  const questionWaiters = new Map()

  /** 唤醒某会话所有长轮询等待者（新提问到达时调用）。 */
  function wakeQuestionWaiters(sid) {
    const waiters = questionWaiters.get(sid)
    if (!waiters || waiters.size === 0) return
    for (const resolve of waiters) {
      if (resolve._timer !== undefined) clearTimeout(resolve._timer)
      resolve()
    }
    questionWaiters.delete(sid)
  }

  function load() {
    try {
      if (!existsSync(storeFile)) return
      const raw = JSON.parse(readFileSync(storeFile, 'utf8'))
      if (raw && typeof raw === 'object') {
        for (const [sid, entry] of Object.entries(raw)) {
          if (entry && Array.isArray(entry.steps)) sessions.set(sid, entry)
        }
      }
    } catch {
      // 损坏文件：从空开始
    }
  }
  load()

  function persist() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try {
        const out = {}
        for (const [sid, entry] of sessions) out[sid] = entry
        writeFileSync(storeFile, JSON.stringify(out), 'utf8')
      } catch (error) {
        console.error('[usage-record] persist failed:', error)
      }
    }, 1000)
  }

  // ---- persistent question index -----------------------------------------
  // The question list is appended to on write (session/event), so cold
  // sessions never need a full loadStored scan: read the index file instead.
  const questionsDir = join(dataDir, 'questions')
  try { mkdirSync(questionsDir, { recursive: true }) } catch { /* 只读时跳过 */ }
  const questionsFile = (sid) => join(questionsDir, `${sid}.json`)

  /** Read the persisted question index for a session, if present.
   *  Returns { questions, lastSeq }（lastSeq = 已索引的最大事件 seq，缺失时为 null）。 */
  function readQuestionIndex(sid) {
    try {
      const f = questionsFile(sid)
      if (!existsSync(f)) return null
      const raw = JSON.parse(readFileSync(f, 'utf8'))
      if (raw && Array.isArray(raw.questions)) {
        return { questions: raw.questions, lastSeq: typeof raw.lastSeq === 'number' ? raw.lastSeq : null }
      }
    } catch { /* 损坏索引：回退全量扫描 */ }
    return null
  }

  /** Append a new question to the persisted index (write-time indexing). */
  function appendQuestionIndex(sid, question) {
    try {
      const index = readQuestionIndex(sid)
      const list = index?.questions ?? []
      if (list.some((q) => q.id === question.id)) return
      list.push(question)
      const lastSeq = Math.max(
        typeof index?.lastSeq === 'number' ? index.lastSeq : 0,
        typeof question.seq === 'number' ? question.seq : 0,
      )
      writeFileSync(questionsFile(sid), JSON.stringify({
        sessionId: sid,
        updatedAt: new Date().toISOString(),
        count: list.length,
        lastSeq: lastSeq > 0 ? lastSeq : undefined,
        questions: list,
      }, null, 2), 'utf8')
    } catch (error) {
      console.error('[usage-record] question index write failed:', error)
    }
  }

  ctx.on('session/event', (session, event) => {
    if (!event || typeof event !== 'object') return
    const sid = session?.id ?? session?.sessionId
    if (typeof sid !== 'string' || sid === '') return
    const t = typeof event.time === 'number' ? event.time : Date.now()
    const data = event.data ?? {}
    switch (event.type) {
      case 'user/message': {
        // 权威的新提问信号（不依赖客户端 DOM 虚拟化渲染）：
        // 增量维护提问缓存并唤醒长轮询等待者；同时落盘到持久化索引
        // （写时索引，冷会话读取免全量扫描；带 seq 供导航轨精确跳转）。
        if (data.source?.kind === 'user' && typeof data.id === 'string') {
          const text = contentText(data.content).replace(/\s+/g, ' ').trim()
          if (text !== '') {
            const question = {
              seq: typeof event.seq === 'number' ? event.seq : undefined,
              turn: typeof data.turn === 'number' ? data.turn : undefined,
              time: t,
              id: data.id,
              text: text.slice(0, 200),
            }
            const q = questionCache.get(sid) ?? { list: [], version: 0 }
            if (!q.list.some((item) => item.id === data.id)) {
              q.list.push(question)
              q.version += 1
              questionCache.set(sid, q)
              wakeQuestionWaiters(sid)
              appendQuestionIndex(sid, question)
            }
          }
        }
        break
      }
      case 'step/start': {
        openSteps.set(sid, {
          turn: data.turn,
          step: data.step,
          startTime: t,
          firstTokenTime: null,
          toolCalls: 0,
        })
        break
      }
      case 'assistant/chunk': {
        const st = openSteps.get(sid)
        if (!st || st.turn !== data.turn || st.step !== data.step || st.firstTokenTime !== null) break
        const chunk = data.chunk
        const text = typeof chunk === 'string' ? chunk : chunk && typeof chunk.text === 'string' ? chunk.text : ''
        if (text.trim().length > 0) st.firstTokenTime = t
        break
      }
      case 'assistant/message': {
        const st = openSteps.get(sid)
        if (!st || st.turn !== data.turn || st.step !== data.step) break
        const usage = data.usage ?? {}
        const entry = sessions.get(sid) ?? { steps: [], updatedAt: 0 }
        entry.steps.push({
          turn: st.turn,
          step: st.step,
          startedAt: st.startTime,
          endedAt: t,
          llmMs: Math.max(0, t - st.startTime),
          ttftMs: st.firstTokenTime !== null ? Math.max(0, st.firstTokenTime - st.startTime) : null,
          tokensOut: typeof usage.outputTokens === 'number' ? usage.outputTokens : null,
          tokensIn: typeof usage.inputTokens === 'number' ? usage.inputTokens : null,
          toolCalls: st.toolCalls,
        })
        if (entry.steps.length > MAX_STEPS_PER_SESSION) {
          entry.steps.splice(0, entry.steps.length - MAX_STEPS_PER_SESSION)
        }
        entry.updatedAt = t
        sessions.set(sid, entry)
        if (sessions.size > MAX_SESSIONS) {
          let oldest = null
          for (const [k, v] of sessions) {
            if (!oldest || v.updatedAt < oldest.v.updatedAt) oldest = { k, v }
          }
          if (oldest) sessions.delete(oldest.k)
        }
        openSteps.delete(sid)
        persist()
        break
      }
      case 'tool/call': {
        const st = openSteps.get(sid)
        if (st && data.callId !== undefined) {
          st.toolCalls += 1
          pendingTools.set(data.callId, { sid, time: t })
        }
        break
      }
      case 'tool/result': {
        const callId = data.message?.source?.callId
        if (callId !== undefined) pendingTools.delete(callId)
        break
      }
    }
  })

  const disposeRecords = ctx.webServer.register({
    kind: 'exact',
    path: RECORDS_PATH,
    handler: async (_req, res) => {
      try {
        const out = {}
        for (const [sid, entry] of sessions) {
          out[sid] = { steps: [...entry.steps].reverse() }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ sessions: out }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: message }))
      }
    },
  })

  /** 从事件数组提取提问（user/message + source.kind==='user'）。
   *  @param fromSeq - 只提取 seq > fromSeq 的事件（增量）；0/undefined = 全量。 */
  function extractQuestions(events, fromSeq = 0) {
    const out = []
    if (!Array.isArray(events)) return out
    for (const event of events) {
      if (!event || event.type !== 'user/message') continue
      const seq = typeof event.seq === 'number' ? event.seq : 0
      if (fromSeq > 0 && seq <= fromSeq) continue
      const data = event.data ?? {}
      if (data.source?.kind !== 'user') continue
      if (typeof data.id !== 'string') continue
      const text = contentText(data.content).replace(/\s+/g, ' ').trim()
      if (text === '') continue
      out.push({
        seq: seq > 0 ? seq : undefined,
        turn: typeof data.turn === 'number' ? data.turn : undefined,
        id: data.id,
        text: text.slice(0, 200),
        time: typeof event.time === 'number' ? event.time : 0,
      })
    }
    return out
  }

  /** 尾部增量提取：事件按 seq 升序 append，新提问几乎都在尾部。
   *  从尾部反向找到第一个 seq <= fromSeq 的边界，只处理其后的事件——
   *  O(新增) 而非 O(全量)。回扫上限 5000 条防异常乱序（无 seq 事件混排）。 */
  function extractTailQuestions(events, fromSeq) {
    const out = []
    if (!Array.isArray(events) || events.length === 0) return out
    let i = events.length - 1
    let scanned = 0
    while (i >= 0 && scanned < 5000) {
      const e = events[i]
      const seq = typeof e?.seq === 'number' ? e.seq : 0
      if (seq <= fromSeq) break
      i--
      scanned++
    }
    for (let j = i + 1; j < events.length; j++) {
      const event = events[j]
      if (!event || event.type !== 'user/message') continue
      const data = event.data ?? {}
      if (data.source?.kind !== 'user') continue
      if (typeof data.id !== 'string') continue
      const text = contentText(data.content).replace(/\s+/g, ' ').trim()
      if (text === '') continue
      out.push({
        seq: typeof event.seq === 'number' ? event.seq : undefined,
        turn: typeof data.turn === 'number' ? data.turn : undefined,
        id: data.id,
        text: text.slice(0, 200),
        time: typeof event.time === 'number' ? event.time : 0,
      })
    }
    return out
  }

  /** 从会话日志提取全部提问（缓存未命中/初始化时全量扫描）。
   *  优先读内存态 session.log（attach 中的会话）；冷会话（未 attach/被 LRU 淘汰）
   *  从磁盘读日志（sessionPersistence.loadStored），保证历史提问不丢。 */
  async function scanQuestions(sessionId, fromSeq = 0) {
    if (sessionId === '') return []
    let events = null
    // 1) 内存态：attach 中的会话
    if (typeof ctx.sessions?.get === 'function') {
      const session = ctx.sessions.get(sessionId)
      if (session && Array.isArray(session.log)) events = session.log
    }
    // 2) 冷会话：从磁盘读
    if (events === null && typeof ctx.sessionPersistence?.loadStored === 'function') {
      try {
        const stored = await ctx.sessionPersistence.loadStored(sessionId)
        if (stored && Array.isArray(stored.events)) events = stored.events
      } catch { /* 磁盘读取失败：返回已收集的增量 */ }
    }
    return extractQuestions(events, fromSeq)
  }

  /** 取某会话提问列表（持久化索引优先 → 增量修补 → 全量扫描回填索引）。 */
  async function questionsFor(sessionId) {
    const cached = questionCache.get(sessionId)
    // 空会话也走缓存（cached 存在即返回）：新提问由 session/event 写时维护更新
    // 同一 entry 对象（q.list.push + version++），无需重查；避免每次请求重跑增量。
    if (cached !== undefined) return cached
    // 1) 持久化索引（写时维护）：冷会话免全量扫描
    const indexed = readQuestionIndex(sessionId)
    if (indexed !== null && indexed.questions.length > 0) {
      const entry = { list: indexed.questions, version: indexed.questions.length }
      // 1b) 增量修补：仅限【attach 中的会话 + 新格式索引（有 lastSeq）】——
      //     只从内存 session.log 提取更高 seq 的事件（热重载窗口/索引写失败漏掉
      //     的新提问），绝不触发 loadStored 全量解压（冷会话事件只会在 attach 时
      //     产生且写时索引已覆盖；旧格式索引视为完整，不做全量提取去重）。
      let newOnes = []
      if (indexed.lastSeq !== null) {
        try {
          const live = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(sessionId) : undefined
          if (live && Array.isArray(live.log) && live.log.length > 0) {
            // 尾部反向增量（O(新增)）——绝不全量遍历几十万事件的 session.log
            newOnes = extractTailQuestions(live.log, indexed.lastSeq)
          }
        } catch { /* 增量失败不影响已有索引 */ }
      }
      if (newOnes.length > 0) {
        const seen = new Set(entry.list.map((q) => q.id))
        for (const q of newOnes) {
          if (seen.has(q.id)) continue
          seen.add(q.id)
          entry.list.push(q)
          appendQuestionIndex(sessionId, q)
        }
        entry.version = entry.list.length
      }
      questionCache.set(sessionId, entry)
      return entry
    }
    // 2) 无索引：全量扫描并回填持久化索引（历史会话一次性补建）
    const list = await scanQuestions(sessionId)
    const entry = { list, version: list.length }
    questionCache.set(sessionId, entry)
    if (list.length > 0) {
      try {
        const lastSeq = list.reduce((max, q) => Math.max(max, typeof q.seq === 'number' ? q.seq : 0), 0)
        writeFileSync(questionsFile(sessionId), JSON.stringify({
          sessionId,
          updatedAt: new Date().toISOString(),
          count: list.length,
          lastSeq: lastSeq > 0 ? lastSeq : undefined,
          questions: list,
        }, null, 2), 'utf8')
      } catch { /* 索引写失败不影响返回 */ }
    }
    return entry
  }

  /** 全部提问：从缓存（实时增量）或会话日志提取 user/message（source.kind === 'user'）。 */
  const disposeQuestions = ctx.webServer.register({
    kind: 'exact',
    path: QUESTIONS_PATH,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const entry = await questionsFor(sessionId)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ questions: entry.list, version: entry.version }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: message }))
      }
    },
  })

  /**
   * 提问长轮询：?sessionId=..&v=<上次版本>。
   * 版本未变则挂起（最长 ~25s）；新提问到达（version 增加）立即返回最新列表。
   * 客户端据此实现"事件驱动"刷新——新提问不再依赖 DOM 虚拟化渲染。
   */
  const disposeQuestionsWait = ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-usage-record/questions/wait',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const rawV = url.searchParams.get('v') ?? '0'
        const lastV = Number.isFinite(Number(rawV)) ? Number(rawV) : 0
        if (sessionId === '') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ questions: [], version: 0, changed: false }))
          return
        }
        const entry = await questionsFor(sessionId)
        if (entry.version > lastV) {
          // 已有新提问：立即返回
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ questions: entry.list, version: entry.version, changed: true }))
          return
        }
        // 挂起等待：新提问到达（wakeQuestionWaiters）或 25s 超时
        await new Promise((resolve) => {
          const waiters = questionWaiters.get(sessionId) ?? new Set()
          waiters.add(resolve)
          questionWaiters.set(sessionId, waiters)
          const timer = setTimeout(() => {
            waiters.delete(resolve)
            if (waiters.size === 0) questionWaiters.delete(sessionId)
            resolve()
          }, 25000)
          resolve._timer = timer
        })
        const latest = await questionsFor(sessionId)
        const changed = latest.version > lastV
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ questions: latest.list, version: latest.version, changed }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: message }))
      }
    },
  })

  return () => {
    clearTimeout(saveTimer)
    disposeRecords()
    disposeQuestions()
    disposeQuestionsWait()
    // 唤醒所有残留等待者（插件卸载时避免挂起连接）
    for (const waiters of questionWaiters.values()) {
      for (const resolve of waiters) {
        if (resolve._timer !== undefined) clearTimeout(resolve._timer)
        resolve()
      }
    }
    questionWaiters.clear()
  }
}
