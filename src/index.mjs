// dsh-usage-record Node half：监听 session/event 采集每轮 LLM 用量（备用），
// 并提供「全部提问」只读路由：从会话日志（session.log）提取所有 user/message
// 事件（source.kind === 'user' 的真实提问，排除插件/压缩检查点），
// 不受聊天视图渲染窗口限制。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'usage-record'
export const inject = ['webServer', 'sessions']

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

  ctx.on('session/event', (session, event) => {
    if (!event || typeof event !== 'object') return
    const sid = session?.id ?? session?.sessionId
    if (typeof sid !== 'string' || sid === '') return
    const t = typeof event.time === 'number' ? event.time : Date.now()
    const data = event.data ?? {}
    switch (event.type) {
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

  /** 全部提问：从会话日志提取 user/message（source.kind === 'user'）。 */
  const disposeQuestions = ctx.webServer.register({
    kind: 'exact',
    path: QUESTIONS_PATH,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const out = []
        if (sessionId !== '' && typeof ctx.sessions?.get === 'function') {
          const session = ctx.sessions.get(sessionId)
          if (session && Array.isArray(session.log)) {
            for (const event of session.log) {
              if (!event || event.type !== 'user/message') continue
              const data = event.data ?? {}
              if (data.source?.kind !== 'user') continue
              if (typeof data.id !== 'string') continue
              const text = contentText(data.content).replace(/\s+/g, ' ').trim()
              if (text === '') continue
              out.push({
                id: data.id,
                text: text.slice(0, 200),
                time: typeof event.time === 'number' ? event.time : 0,
              })
            }
          }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ questions: out }))
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
  }
}
