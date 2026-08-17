// dsh-usage-record 浏览器 half（提问导航轨 v22）：横线列表来自服务端全量提问。
// 事件驱动刷新（无轮询）：会话切换（sessions 订阅）或新提问出现（DOM 观察）时才查询。
// 轨道定高（最多 15 条可见），上下滚动；tooltip 为独立 fixed 元素（不产生横向滚动）。
// 点击：已渲染直接跳（scroller 定位 + 流式锁定 + 高亮），未渲染自动加载更早再跳。
import { useEffect, useState } from 'react'
import type { Context } from 'cordis'
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Usage-record copy. */
    'usage-record': UsageRecordKey
  }
}

const NS = 'usage-record'

const zh = {
  'tooltip.q': 'Q{index}',
  'rail.loading': '加载历史中…（{n} 批）',
} satisfies Record<string, string>
type UsageRecordKey = keyof typeof zh
const en = {
  'tooltip.q': 'Q{index}',
  'rail.loading': 'Loading history… ({n} batches)',
} satisfies Record<string, string>

interface Tick {
  /** 消息 id（用于 DOM 匹配跳转）。 */
  id: string
  index: number
  text: string
}
interface RailState {
  visible: boolean
  left: number
  top: number
  height: number
  contentH: number
  gap: number
  lineH: number
  ticks: Tick[]
}

const LINE_H = 4
const GAP = 17
const MAX_VISIBLE = 15
/** 后台预加载批数上限：预热绝大部分历史（250 批 ≈ 12500 条消息 ≈ 60+ 万事件，
 *  覆盖本机最大会话（~35 万事件 / 70+ 提问）的全部历史；极端超大会话剩余
 *  由 loadUntilVisible 按需加载。2026-08-16 从 60 调大：60 批只覆盖 ~20 条
 *  提问，70 提问级大会话的早期提问点击时仍要逐批现加载（"卡一下"）。 */
const PRELOAD_BATCH_CAP = 250
const SIDE_INSET = 6
const BASE_W = 16
/** 鱼眼放大参数：正中最粗宽、最大高、影响半径（σ 越小放大越聚焦，邻线保持小线，视觉区分清晰不误触）。 */
const MAX_W = 46
const MAX_H = 13
const SIGMA = 12
/** 内容区上下留白：边缘横线放大后不被裁剪。 */
const PAD = 10

const QUESTIONS_PATH = '/plugins/dsh-usage-record/questions'

/** 当前会话 id 读取器（apply 时从 ctx.workspaces 捕获）。 */
let currentSessionGetter: () => string | undefined = () => undefined
/** 会话切换通知（apply 的 sessions 订阅回调）。 */
let sessionChangeNotifier: (() => void) | null = null
/** 模块级布局去重/新提问检测状态（勿移入 effect 内部，否则重置导致死循环）。 */
let lastLayout = ''
let lastUserRows = -1
/** 聊天滚动容器（滚动跟随用）。 */
let chatScroller: HTMLElement | null = null
/** 提问版本号（长轮询用）：服务端每次新增提问 +1。 */
let questionsVersion = 0
/** 组件挂载时注入的 currentId setter（jump 后强制同步 rail 高亮，不等 scroll-spy）。 */
let currentIdSetter: ((v: string | null) => void) | null = null

/** 滚动跟随：高亮离视口垂直中心最近的那条提问（scroll-spy 居中判定）。 */
function computeCurrentId(scroller: HTMLElement, setCurrentId: (v: string | null) => void): void {
  const flow = document.querySelector('[data-chat-flow]')
  if (flow === null || scroller === null) return
  const srect = scroller.getBoundingClientRect()
  const viewportCenter = srect.top + srect.height / 2
  const rows = [...flow.querySelectorAll<HTMLElement>('[data-chat-anchor-key][data-chat-flow-kind="user"]')]
  let current: string | null = null
  let bestDist = Infinity
  for (const row of rows) {
    const key = row.dataset.chatAnchorKey ?? ''
    const m = key.match(/input-message(.+)$/)
    if (m === null) continue
    const r = row.getBoundingClientRect()
    const center = r.top + r.height / 2
    const d = Math.abs(center - viewportCenter)
    if (d < bestDist) {
      bestDist = d
      current = m[1]
    }
  }
  setCurrentId(prev => (prev === current ? prev : current))
}

/** 提问列表客户端缓存（sessionId -> { ticks, at }）：切换回已看过的会话秒显，
 *  避免每次切会话都重新 fetch + 重建轨道（后端 scanQuestions 每次全量遍历会话日志）。
 *  5 分钟内复用；新提问由长轮询（/questions/wait）触发 refreshTick 刷新，不依赖此缓存过期。 */
const questionsCache = new Map<string, { ticks: Tick[]; at: number }>()
const QUESTIONS_CACHE_TTL_MS = 5 * 60 * 1000

/** 从会话日志服务端路由拉取全部提问（带客户端缓存）。
 *  @param force - 长轮询确认有新提问时传入 true，绕过 5 分钟缓存；
 *  否则新提问要等缓存过期才出现，导航轨看起来"不更新"。 */
async function fetchQuestions(sessionId: string | undefined, force = false): Promise<Tick[]> {
  if (sessionId === undefined || sessionId === '') return []
  const cached = questionsCache.get(sessionId)
  if (!force && cached !== undefined && Date.now() - cached.at < QUESTIONS_CACHE_TTL_MS) {
    return cached.ticks
  }
  try {
    const res = await fetch(`${QUESTIONS_PATH}?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } })
    if (!res.ok) return []
    const json = (await res.json()) as { questions?: Array<{ id: string; text: string; time: number }>; version?: number }
    if (!json || !Array.isArray(json.questions)) return []
    if (typeof json.version === 'number') questionsVersion = json.version
    const ticks = json.questions.map((q, i) => ({ id: q.id, index: i + 1, text: q.text }))
    questionsCache.set(sessionId, { ticks, at: Date.now() })
    return ticks
  } catch {
    return []
  }
}

/** DOM 兜底扫描（服务端路由不可用时的可见子集）。 */
function scanDomQuestions(): Tick[] {
  const flow = document.querySelector('[data-chat-flow]')
  if (flow === null) return []
  const rows = [...flow.querySelectorAll<HTMLElement>('[data-chat-anchor-key][data-chat-flow-kind="user"]')]
  return rows.map((row, i) => {
    const key = row.dataset.chatAnchorKey ?? ''
    const m = key.match(/input-message(.+)$/)
    return {
      id: m !== null ? m[1] : `dom-${i}`,
      index: i + 1,
      text: (row.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    }
  }).filter(t => t.id !== '')
}

/** 布局：轨道定高（最多 MAX_VISIBLE 条可见），超出内容在轨道内上下滚动。
 *  left 锚定聊天真实滚动容器（findScroller，overflow auto/scroll 祖先，结构稳定）：
 *  不能用 [data-chat-flow] 内容列（max-width 居中会偏右），也不用
 *  [data-conversation-scroll]（F12 布局切换时其 rect 会飘到页面最左工作区）。
 *  @param allowEmpty - 提问数据未到（fetch 进行中）时也渲染空轨道骨架：
 *  容器立即出现，数据到达后填充 tick——避免"每次加载都是最后才冒出来"的观感。 */
function railLayout(ticks: Tick[], allowEmpty = false): RailState {
  const hidden: RailState = { visible: false, left: 0, top: 0, height: 0, contentH: 0, gap: GAP, lineH: LINE_H, ticks: [] }
  if (ticks.length === 0 && !allowEmpty) return hidden
  const flow = document.querySelector('[data-chat-flow]')
  if (flow === null) return hidden
  const port = findScroller(flow) ?? flow.closest('[data-conversation-scroll]') ?? flow
  const portRect = port.getBoundingClientRect()
  if (portRect.height <= 0 || portRect.width <= 0) return hidden
  const seat = port.querySelector('[data-composer-seat]')
  let seatTop = portRect.bottom
  if (seat instanceof HTMLElement) {
    const st = seat.getBoundingClientRect().top
    if (st > portRect.top + 80 && st <= portRect.bottom) seatTop = st
  }
  const visibleH = Math.max(0, seatTop - portRect.top)
  const budgetH = Math.max(1, portRect.height - 24)

  const step = LINE_H + GAP
  // 空骨架：保留最小可点击轨道（PAD 上下留白），避免 0 高度布局抖动
  const contentH = ticks.length > 0 ? Math.max(1, ticks.length * step - GAP + PAD * 2) : PAD * 2
  const height = ticks.length > 0
    ? Math.min(contentH, MAX_VISIBLE * step - GAP + PAD * 2)
    : PAD * 2
  const centerH = visibleH > 60 ? visibleH : budgetH

  return {
    visible: true,
    left: portRect.left + SIDE_INSET,
    top: portRect.top + Math.max(12, (centerH - height) / 2),
    height,
    contentH,
    gap: GAP,
    lineH: LINE_H,
    ticks,
  }
}

/** 布局轻量签名：几何值 + ticks 规模/首尾 id/最后 index（O(1) 比较，替代 JSON.stringify 全量序列化）。
 *  index 是连续序号，末位 index 变化能捕获"中间插入/删除"这类首尾不变但内容已变的场景。 */
function layoutSignature(s: RailState): string {
  const ticks = s.ticks
  const n = ticks.length
  const first = n > 0 ? ticks[0].id : ''
  const last = n > 1 ? ticks[n - 1].id : ''
  const lastIndex = n > 0 ? ticks[n - 1].index : 0
  return `${s.visible ? 1 : 0}|${s.left}|${s.top}|${s.height}|${s.contentH}|${n}|${first}|${last}|${lastIndex}`
}

/** 可视区虚拟化渲染：只渲染 [scrollTop - overscan, scrollTop + height + overscan] 内的 tick。
 *  保证命中测试/高亮/鱼眼只对可见元素生效（与全量渲染视觉一致，滚动时按需补渲染）。
 *  注意：不能引用组件内部函数（lineCenter 等闭包），全部自包含计算。 */
const TICK_OVERSCAN = 80 // px：可视区上下各多渲染 80px，滚动时新元素提前就位
function renderTicks(
  rail: RailState,
  scrollTop: number,
  mouseY: number | null,
  active: number | null,
  currentId: string | null,
  step: number,
): ReactNode[] {
  const out: ReactNode[] = []
  const lineCenter = (i: number): number => i * step + rail.lineH / 2
  const from = Math.max(0, Math.floor((scrollTop - TICK_OVERSCAN - PAD) / step))
  const to = Math.min(rail.ticks.length, Math.ceil((scrollTop + rail.height + TICK_OVERSCAN - PAD) / step))
  for (let i = from; i < to; i++) {
    const tick = rail.ticks[i]
    const center = lineCenter(i)
    const dist = mouseY === null ? Infinity : Math.abs(center - mouseY)
    const k = fisheye(dist)
    const w = BASE_W + (MAX_W - BASE_W) * k
    const h = rail.lineH + (MAX_H - rail.lineH) * k
    const isActive = active === tick.index
    const isCurrent = tick.id === currentId
    // 放大后钳制在留白区内（边缘横线不会被裁剪、不越界）
    const top = Math.max(PAD, Math.min(PAD + center - h / 2, rail.contentH - PAD - h))
    out.push(
      <div
        key={tick.id}
        data-question-tick={tick.id}
        style={{
          position: 'absolute', left: 0,
          top,
          width: w, height: h,
          borderRadius: Math.max(2, h / 2),
          background: isActive
            ? 'var(--dsw-alias-accent, #4cc2ff)'
            : isCurrent
              ? '#7dd3fc'
              : 'var(--dsh-alias-border-l2, rgba(128,128,128,.45))',
          boxShadow: isCurrent ? '0 0 5px var(--dsw-alias-accent, #4cc2ff)' : 'none',
        }}
      />,
    )
  }
  return out
}

/** 当前高亮的行（用于点击其它区域时清除）。 */
let highlightedRow: HTMLElement | null = null
let highlightedStyles: { outline: string; outlineOffset: string; background: string } | null = null
/** 高亮行的消息 id（清除时按 id 重新找当前节点——流式/虚拟化可能重建过行节点）。 */
let highlightedId: string | null = null
/** 跳转目标的待钉高亮 id：滚动稳定/锁定校正后重新定位高亮（行节点可能被 React 重建、或停在视口边缘）。 */
let pendingHighlightId: string | null = null

function clearHighlight(): void {
  // 恢复保存的节点 + 按 id 重新查找当前节点（节点可能已被 React 重建）
  const restore = (row: HTMLElement | null): void => {
    if (row === null || highlightedStyles === null) return
    row.style.outline = highlightedStyles.outline
    row.style.outlineOffset = highlightedStyles.outlineOffset
    row.style.background = highlightedStyles.background
  }
  restore(highlightedRow)
  if (highlightedId !== null) restore(findRow(highlightedId))
  highlightedRow = null
  highlightedStyles = null
  highlightedId = null
}

function markHighlight(row: HTMLElement): void {
  clearHighlight()
  highlightedRow = row
  highlightedStyles = {
    outline: row.style.outline,
    outlineOffset: row.style.outlineOffset,
    background: row.style.background,
  }
  // 从 data-chat-anchor-key（形如 "13:input-message<id>"）提取消息 id
  const key = row.dataset.chatAnchorKey ?? ''
  const m = key.match(/input-message(.+)$/)
  highlightedId = m !== null ? m[1] : null
  row.style.outline = '2px solid var(--dsw-alias-accent, #4cc2ff)'
  row.style.outlineOffset = '-2px'
  row.style.background = 'rgba(76, 194, 255, .12)'
}

/** 滚动稳定后重新钉高亮（以最新行节点为准）。 */
function rehighlight(id: string): void {
  if (pendingHighlightId !== id) return
  const r = findRow(id)
  if (r !== null) markHighlight(r)
}

/** 跳转后延迟重钉高亮：smooth 动画 + jump-lock 校正基本结束后执行。 */
function scheduleRehighlight(id: string, delayMs: number): void {
  pendingHighlightId = id
  window.setTimeout(() => rehighlight(id), delayMs)
}

/** 从行元素向上找真正可滚动的祖先容器（overflow auto/scroll 且内容超高）。 */
function findScroller(row: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = row.parentElement
  while (el !== null && el !== document.body) {
    const style = getComputedStyle(el)
    const oy = style.overflowY
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
      return el
    }
    el = el.parentElement
  }
  return null
}

/** 按消息 id 找行（DOM key 形如 "13:input-message<uuid>"）。 */
function findRow(id: string): HTMLElement | null {
  const flow = document.querySelector('[data-chat-flow]')
  if (flow === null) return null
  for (const r of flow.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
    if ((r.dataset.chatAnchorKey ?? '').includes(`input-message${id}`)) return r
  }
  return null
}

/** 进行中的历史加载：id -> 完成回调（去重，避免悬停预加载与点击跳转双循环抢按钮）。 */
const activeLoads = new Map<string, () => void>()

/** 后台全量预加载状态（轨道可见时自动启动，把全部旧历史提前加载完）。 */
let bgPreloading = false
let bgPreloadTimer = 0
let bgPreloadBatches = 0
let onBgPreloadChange: ((loading: boolean, batches: number) => void) | null = null

/** 当前 user 提问行数（判断"加载更早"是否还有增量）。 */
function countUserRows(): number {
  const flow = document.querySelector('[data-chat-flow]')
  if (flow === null) return 0
  return flow.querySelectorAll('[data-chat-anchor-key][data-chat-flow-kind="user"]').length
}

/** 找"加载更早"按钮（无则 null）。 */
function findLoadOlderBtn(): HTMLButtonElement | null {
  const flow = document.querySelector('[data-chat-flow]')
  if (flow === null) return null
  return [...flow.querySelectorAll<HTMLButtonElement>('button')].find(b =>
    /加载更早|load earlier|加载中|loading/i.test(b.textContent ?? '')) ?? null
}

/**
 * 后台预加载：持续点击"加载更早"直到没有更早（行数不再增长）或达到批次上限。
 * 与 loadUntilVisible 串行：跳转加载进行中（activeLoads 非空）时让路，避免双循环抢按钮。
 * 终止判定：①已渲染行数达到已知提问总数（total）＝全部加载完；
 * ②连续两批行数无增长；③批次上限。不依赖"按钮是否存在"（虚拟化窗口会让按钮暂离 DOM）。
 */
function startBackgroundPreload(total = Infinity): void {
  if (bgPreloading) return
  bgPreloading = true
  bgPreloadBatches = 0
  onBgPreloadChange?.(true, 0)
  let noGrowth = 0
  let noBtnTries = 0
  const tick = (): void => {
    if (!bgPreloading) return
    if (activeLoads.size > 0) { // 跳转加载优先，预加载让路
      bgPreloadTimer = window.setTimeout(tick, 200)
      return
    }
    const btn = findLoadOlderBtn()
    if (btn === null) {
      // 按钮暂不在 DOM（虚拟化窗口）：不能据此认为"没有更早"
      if (countUserRows() >= total) { stopBackgroundPreload(); return } // 全部提问已渲染 → 完成
      noBtnTries += 1
      if (noBtnTries >= 40) { stopBackgroundPreload(); return } // 12s 仍无按钮 → 放弃
      bgPreloadTimer = window.setTimeout(tick, 300)
      return
    }
    if (btn.disabled) { // 上一批还在加载：等它完成再点
      noBtnTries = 0
      bgPreloadTimer = window.setTimeout(tick, 200)
      return
    }
    noBtnTries = 0
    const rowsBefore = countUserRows()
    btn.click()
    bgPreloadBatches += 1
    onBgPreloadChange?.(true, bgPreloadBatches)
    if (bgPreloadBatches >= PRELOAD_BATCH_CAP) { // 上限保护：只预热近端历史，更远的点击时 loadUntilVisible 兜底
      stopBackgroundPreload()
      return
    }
    // 等本批渲染完成（按钮重新可点）再判断增量，最多等 3s
    const waitBatch = (left: number): void => {
      if (!bgPreloading) return
      const b2 = findLoadOlderBtn()
      if (left <= 0 || (b2 !== null && !b2.disabled)) {
        const rowsAfter = countUserRows()
        if (rowsAfter > rowsBefore) {
          noGrowth = 0
        } else if (rowsAfter >= total) {
          stopBackgroundPreload(); return // 全部提问已渲染 → 完成
        } else {
          noGrowth += 1
          if (noGrowth >= 2) { stopBackgroundPreload(); return } // 连续两批无增长 = 已到最早
        }
        // 节奏控制：前 10 批快速预热（近端历史），之后 250ms/批（2026-08-16
        // 从 450ms 调快：大会话预加载总时长 ~24s → ~14s，缩短"首次点击早期
        // 提问要等"的窗口；每批 3-6MB 历史 + 渲染仍留有余量不卡页面）。
        const slow = bgPreloadBatches >= 10 ? 250 : 120
        bgPreloadTimer = window.setTimeout(tick, slow)
        return
      }
      bgPreloadTimer = window.setTimeout(() => waitBatch(left - 1), 150)
    }
    waitBatch(20)
  }
  tick()
}

function stopBackgroundPreload(): void {
  clearTimeout(bgPreloadTimer)
  if (bgPreloading) {
    bgPreloading = false
    onBgPreloadChange?.(false, bgPreloadBatches)
  }
}

/** 持续点击"加载更早"直到目标行出现（或超时），然后回调。
 *  加载期间通过 onBgPreloadChange 显示进度（复用"加载历史中…（n 批）"指示），
 *  让用户看到跳转正在加载而不是"没反应"。 */
function loadUntilVisible(id: string, onDone: () => void): void {
  if (findRow(id) !== null) {
    onDone()
    return
  }
  console.log('[usage-record] loadUntilVisible start', id.slice(0, 8), { rows: countUserRows() })
  const existing = activeLoads.get(id)
  if (existing !== undefined) {
    activeLoads.set(id, () => { existing(); onDone() })
    return
  }
  activeLoads.set(id, onDone)
  onBgPreloadChange?.(true, 0) // 显示"加载历史中…"反馈
  let lastReported = 0
  const startTime = Date.now()
  const tick = (tries: number): void => {
    if (findRow(id) !== null) {
      const done = activeLoads.get(id)
      activeLoads.delete(id)
      console.log('[usage-record] loadUntilVisible FOUND after', tries, 'tries')
      onBgPreloadChange?.(false, 0)
      done?.()
      return
    }
    if (Date.now() - startTime > 30000) { // 30s 上限：容忍大会话长距离加载（几十批 × 每批 ~1s）
      activeLoads.delete(id)
      console.warn('[usage-record] loadUntilVisible TIMEOUT (30s), row never appeared:', id)
      onBgPreloadChange?.(false, 0)
      return
    }
    // 按钮可点才点（加载中/暂缺不盲点，避免空转）
    const btn = findLoadOlderBtn()
    let delay = 100
    if (btn !== null && !btn.disabled) {
      btn.click()
      delay = 300 // 点击后等渲染完成再检查（比 100ms 盲轮更有效）
    } else if (btn !== null && btn.disabled) {
      delay = 500 // 上一批还在加载：等它完成，不空转
    } else if (btn === null) {
      // 按钮不在 DOM：消息流虚拟化窗口可能把它卸载了（滚动位置在下方）。
      // 滚动到消息流顶部让按钮重新渲染，再继续轮询。
      const flow = document.querySelector('[data-chat-flow]')
      const scroller = flow !== null ? findScroller(flow) : null
      if (scroller !== null && scroller.scrollTop > 0) {
        scroller.scrollTo({ top: 0, behavior: 'auto' })
      }
    }
    // 每 25 轮更新一次进度显示
    if (tries % 25 === 0) {
      const rows = countUserRows()
      if (rows !== lastReported) {
        lastReported = rows
        onBgPreloadChange?.(true, Math.round(tries / 25))
      }
    }
    window.setTimeout(() => tick(tries + 1), delay)
  }
  tick(0)
}

/** 流式锁定定时器（新跳转必须取消旧的，否则旧锁定会把视图拉回旧目标）。 */
let activeStick = 0

/** 取消流式 stick：用户任何主动滚动/点击/键盘操作后立即释放，不再把视图拉回目标行。 */
function cancelActiveStick(): void {
  if (activeStick !== 0) {
    window.clearInterval(activeStick)
    activeStick = 0
  }
}

/** 跳转锁定期：官方 at-bottom 跟随（流式/新消息到达时 toBottom）会把视图拉回底部，
 *  跳转后 holdMs 内持续监控，目标行偏离视口中心超 60px 就重新定位（用户主动滚动则解锁）。
 *  每次 tick 都以行 id 重新计算目标位置（内容漂移自适应：流式增长/图片加载/历史插入后
 *  目标行实际位置会变，不能用点击瞬间的静态快照，否则跳转位置不准）。 */
let jumpLock = 0
let jumpLockId: string | null = null
let jumpScroller: HTMLElement | null = null
let userScrolledAway = false

function cancelJumpLock(): void {
  if (jumpLock !== 0) {
    window.clearTimeout(jumpLock)
    jumpLock = 0
  }
  jumpLockId = null
  jumpScroller = null
  userScrolledAway = false
}

function armJumpLock(id: string, scroller: HTMLElement, holdMs: number): void {
  cancelJumpLock()
  jumpLockId = id
  jumpScroller = scroller
  userScrolledAway = false
  const started = Date.now()
  const tick = (): void => {
    if (jumpScroller === null || jumpLockId === null) return
    if (userScrolledAway) { // 用户主动滚动：解锁，不再对抗
      cancelJumpLock()
      return
    }
    if (scrollAnimRaf !== 0) { // 滚动动画进行中：让路，不打断动画
      if (Date.now() - started < holdMs) jumpLock = window.setTimeout(tick, 100)
      else cancelJumpLock()
      return
    }
    const r = findRow(jumpLockId)
    if (r !== null) {
      const t = computeScrollTarget(r) // 每次重新计算，跟随行位置漂移
      if (t !== null && t.scroller === jumpScroller) {
        const drift = Math.abs(t.scroller.scrollTop - t.top)
        if (drift > 60) {
          console.log('[usage-record] jump-lock: counter-drift', Math.round(drift), '->', Math.round(t.top))
          t.scroller.scrollTo({ top: t.top, behavior: 'auto' })
        }
        // 校正后同步重钉高亮（行位置已变，旧高亮节点可能已偏离）
        rehighlight(jumpLockId)
      }
    }
    if (Date.now() - started < holdMs) {
      jumpLock = window.setTimeout(tick, 250)
    } else {
      cancelJumpLock()
    }
  }
  jumpLock = window.setTimeout(tick, 300) // 先给 smooth 动画一点时间
}

/** 计算滚动目标位置（行居中）。返回 null 表示找不到滚动容器。 */
function computeScrollTarget(r: HTMLElement): { scroller: HTMLElement; top: number } | null {
  const scroller = findScroller(r)
  if (scroller === null) return null
  const rowRect = r.getBoundingClientRect()
  const srect = scroller.getBoundingClientRect()
  const target = scroller.scrollTop + (rowRect.top - srect.top) - (scroller.clientHeight - rowRect.height) / 2
  return { scroller, top: Math.max(0, target) }
}

/** 手动滚动动画：ease-out cubic 缓动，durationMs 到位。
 *  浏览器原生 smooth 时长不可控且偏短（~300ms），用户感知"跳转太快"；
 *  手动动画让视线跟得上。返回是否启动动画。 */
let scrollAnimRaf = 0
function animatedScrollTo(scroller: HTMLElement, top: number, durationMs: number): boolean {
  cancelAnimationFrame(scrollAnimRaf)
  const start = scroller.scrollTop
  const delta = top - start
  if (Math.abs(delta) < 1) return false
  const t0 = performance.now()
  const ease = (t: number): number => 1 - Math.pow(1 - t, 3)
  const step = (now: number): void => {
    const p = Math.min(1, (now - t0) / durationMs)
    scroller.scrollTop = start + delta * ease(p)
    if (p < 1) scrollAnimRaf = requestAnimationFrame(step)
  }
  scrollAnimRaf = requestAnimationFrame(step)
  return true
}

/** 定位：找到真实滚动容器并滚动到目标行居中；流式生成期间持续重定位对抗跟随滚动。
 *  instant=true 时瞬时到位（加载历史完成后那次跳转用，避免长距离 smooth 动画的感知延迟）。 */
function jumpToQuestion(id: string, instant = false): void {
  // 去重：同一 id 400ms 内只跳一次（document capture 与元素级监听会双触发）
  const now = Date.now()
  if (lastJump.id === id && now - lastJump.at < 400) {
    console.log('[usage-record] jump deduped', id.slice(0, 8))
    return
  }
  lastJump = { id, at: now }
  console.log('[usage-record] jumpToQuestion', id.slice(0, 8), { instant })
  // 取消上一次跳转遗留的流式锁定与跳转锁定
  cancelActiveStick()
  cancelJumpLock()
  const row = findRow(id)
  if (row === null) {
    // 目标未渲染：持续加载历史直到可见，再跳（与悬停预加载共用去重循环）
    console.log('[usage-record] jump: row missing in DOM -> loadUntilVisible', id.slice(0, 8))
    loadUntilVisible(id, () => jumpToQuestion(id, true))
    return
  }

  const applyScroll = (r: HTMLElement, animate: boolean): void => {
    const target = computeScrollTarget(r)
    if (target !== null) {
      console.log('[usage-record] jump: scrolling', { to: Math.round(target.top), now: Math.round(target.scroller.scrollTop) })
      // 流式期间用瞬时（stick 每 300ms 对抗重定位，动画无意义）；非流式用 600ms 缓动动画
      const streaming = document.querySelector('[data-streaming]') !== null
      const useAnim = animate && !streaming
      if (useAnim) {
        animatedScrollTo(target.scroller, target.top, 600)
        // 锁定期 2.5s：对抗官方 at-bottom 跟随把视图拉回底部（流式/新消息 appended 时）；
        // 锁定以行 id 重定位，内容漂移时跟着目标走（解决"有时跳转不准"）
        armJumpLock(id, target.scroller, 2500)
      } else {
        target.scroller.scrollTo({ top: target.top, behavior: 'auto' })
      }
    } else {
      console.log('[usage-record] jump: no scroller found, scrollIntoView fallback')
      r.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  applyScroll(row, true)
  // 强制同步 rail 高亮到目标提问：scroll-spy 的"最近中心"判定在边界
  // （第一个/最后一个提问无法滚到视口居中）会选中相邻行，导致 rail 高亮
  // 不跟随跳转——这里直接指定 currentId，后续用户滚动再交给 scroll-spy 校正。
  currentIdSetter?.(id)
  // 立即高亮 + 滚动稳定后（smooth 动画/锁定校正结束）重新钉高亮：
  // 长距离滚动期间行可能被 React 重建（高亮丢失）或停在视口边缘（高亮不可见）
  markHighlight(row)
  scheduleRehighlight(id, 700)
  let stickTicks = 0
  const stick = window.setInterval(() => {
    if (userScrolledAway) {
      // 用户开始主动滚动/触摸/按键：立即释放，streaming 期间也不再对抗拉回
      window.clearInterval(stick)
      if (activeStick === stick) activeStick = 0
      return
    }
    if (document.querySelector('[data-streaming]') === null) {
      window.clearInterval(stick)
      if (activeStick === stick) activeStick = 0
      return
    }
    const r = findRow(id)
    if (r !== null) applyScroll(r, false)
    stickTicks += 1
    if (stickTicks >= 400) {
      window.clearInterval(stick)
      if (activeStick === stick) activeStick = 0
    }
  }, 300)
  activeStick = stick

  markHighlight(row)
}

/** 鱼眼倍率：距离 dist 处的放大系数（0..1）。 */
function fisheye(dist: number): number {
  return Math.exp(-(dist * dist) / (2 * SIGMA * SIGMA))
}

/** 坐标命中（全实时 DOM）：找到包含点击点的轨道实例，用横线元素真实位置做命中测试。
 *  注意：不能用"逻辑位置"命中——鱼眼放大时边界线会被留白钳制偏移，逻辑位置与实际渲染
 *  位置不一致（曾导致边界线点击错位）；实时 rect 与视觉完全一致。
 *  误触邻线由视觉参数解决（SIGMA/GAP 放大更聚焦、间隙更宽），不靠收窄命中区。 */
function jumpAtPoint(clientX: number, clientY: number): void {
  const rails = document.querySelectorAll('[data-question-rail]')
  let el: Element | null = null
  for (const r of rails) {
    const rc = r.getBoundingClientRect()
    if (clientX >= rc.left - 2 && clientX <= rc.right + 2 && clientY >= rc.top - 4 && clientY <= rc.bottom + 4) {
      el = r
      break
    }
  }
  let best: string | null = null
  let bestD = Infinity
  if (el !== null) {
    for (const tickEl of el.querySelectorAll<HTMLElement>('[data-question-tick]')) {
      const t = tickEl.getBoundingClientRect()
      const cy = t.top + t.height / 2
      const d = Math.abs(cy - clientY)
      if (d < bestD) { bestD = d; best = tickEl.dataset.questionTick ?? null }
    }
  }
  console.log('[usage-record] click@', {
    x: Math.round(clientX), y: Math.round(clientY),
    rails: rails.length, hitRail: el !== null,
    bestD: bestD === Infinity ? null : Math.round(bestD),
    best: best === null ? null : best.slice(0, 8),
  })
  if (best !== null && bestD <= 14) {
    jumpToQuestion(best)
  }
}

/** 全局调试句柄：浏览器控制台执行 copy(JSON.stringify(__usageRecordDebug()))。 */
function debugSnapshot(): unknown {
  const rails = [...document.querySelectorAll('[data-question-rail]')]
  return {
    rails: rails.length,
    ticksPerRail: rails.map(r => r.querySelectorAll('[data-question-tick]').length),
    sessionId: currentSessionGetter() ?? null,
    questions: (window as unknown as { __usageRecordQuestions?: unknown }).__usageRecordQuestions ?? null,
  }
}
;(window as unknown as { __usageRecordDebug?: () => unknown }).__usageRecordDebug = debugSnapshot

export function QuestionRail(props: PropsRuntime<'conversation.input.dock'> & PropsLocale<'usage-record'>): ReactNode {
  const { t } = props
  const [rail, setRail] = useState<RailState>({ visible: false, left: 0, top: 0, height: 0, contentH: 0, gap: GAP, lineH: LINE_H, ticks: [] })
  const [questions, setQuestions] = useState<Tick[]>([])
  const [mouseY, setMouseY] = useState<number | null>(null)
  /** 鼠标是否在轨道上（悬停时暂停轨道自动跟随滚动，避免点击落空/误触）。 */
  const [mouseOnRail, setMouseOnRail] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [refreshTick, setRefreshTick] = useState(0)
  /** 当前视口内的提问 id（滚动跟随高亮）。 */
  const [currentId, setCurrentId] = useState<string | null>(null)
  /** 后台预加载进度（false = 未加载/完成）。 */
  const [bgLoading, setBgLoading] = useState(false)
  const [bgBatches, setBgBatches] = useState(0)
  const mouseYRef = { current: null as number | null }
  const rafRef = { current: 0 }
  const lastClientYRef = { current: 0 }
  const railElRef = { current: null as HTMLDivElement | null }
  const sessionIdRef = { current: (props as { sessionId?: string }).sessionId ?? currentSessionGetter() }
  sessionIdRef.current = (props as { sessionId?: string }).sessionId ?? currentSessionGetter()

  // 纯计算（必须放在所有 hooks 之前：hooks 的依赖数组会引用 active，
  // 若在 hooks 之后声明会触发 TDZ ReferenceError，导致组件渲染崩溃）
  const step = rail.lineH + rail.gap
  const lineCenter = (i: number): number => i * step + rail.lineH / 2
  let nearest: { index: number; dist: number } | null = null
  rail.ticks.forEach((tick, i) => {
    const d = mouseY === null ? Infinity : Math.abs(lineCenter(i) - mouseY)
    if (nearest === null || d < nearest.dist) nearest = { index: tick.index, dist: d }
  })
  const showTip = mouseY !== null && nearest !== null && nearest.dist < SIGMA * 1.1
  const active = showTip && nearest !== null ? nearest.index : null
  const tipTick = showTip && nearest !== null ? rail.ticks.find(t => t.index === nearest!.index) : undefined
  const tipTop = tipTick === undefined ? 0 : Math.max(0, Math.min(rail.height - 34, PAD + lineCenter(rail.ticks.indexOf(tipTick)) - scrollTop - 1))

  // 事件驱动刷新：会话切换（sessions 订阅回调）+ 初次挂载
  useEffect(() => {
    sessionChangeNotifier = () => setRefreshTick(t => t + 1)
    currentIdSetter = (v) => setCurrentId(v)
    onBgPreloadChange = (loading, batches) => {
      setBgLoading(loading)
      setBgBatches(batches)
    }
    return () => {
      sessionChangeNotifier = null
      currentIdSetter = null
      onBgPreloadChange = null
      stopBackgroundPreload()
      cancelJumpLock()
      cancelAnimationFrame(scrollAnimRaf)
    }
  }, [])

  // 查询（仅在 refreshTick 变化或新提问出现时执行）
  const doRefresh = async (force = false): Promise<void> => {
    const sessionId = sessionIdRef.current
    console.log('[usage-record] refresh session:', sessionId)
    let ticks: Tick[]
    if (sessionId === undefined || sessionId === '') {
      ticks = scanDomQuestions()
    } else {
      ticks = await fetchQuestions(sessionId, force)
      if (ticks.length === 0) ticks = scanDomQuestions()
    }
    console.log('[usage-record] refresh ticks:', ticks.length)
    ;(window as unknown as { __usageRecordQuestions?: unknown }).__usageRecordQuestions = ticks
    setQuestions(ticks)
  }
  useEffect(() => {
    let alive = true
    if (alive) void doRefresh(true)
    return () => { alive = false }
  }, [refreshTick])

  // 提问长轮询（事件驱动的新提问推送，不依赖 DOM 虚拟化渲染）：
  // 常驻一个 /questions/wait 挂起请求，服务端有新 user/message 立即返回；
  // changed 时触发 doRefresh。会话切换/组件卸载时重建循环。
  useEffect(() => {
    let alive = true
    let loopTimer = 0
    const loop = async (): Promise<void> => {
      if (!alive) return
      const sessionId = sessionIdRef.current
      if (sessionId === undefined || sessionId === '') {
        // 无会话：稍后重试
        loopTimer = window.setTimeout(() => { void loop() }, 2000)
        return
      }
      try {
        const res = await fetch(
          `${QUESTIONS_PATH}/wait?sessionId=${encodeURIComponent(sessionId)}&v=${questionsVersion}`,
          { headers: { accept: 'application/json' } },
        )
        if (!alive) return
        if (res.ok) {
          const json = (await res.json()) as { changed?: boolean; version?: number }
          if (json.changed === true && typeof json.version === 'number' && json.version > questionsVersion) {
            questionsVersion = json.version
            setRefreshTick(t => t + 1)
          }
        }
      } catch {
        // 网络/服务错误：稍后重试（长轮询期间后端重启等）
      }
      if (alive) loopTimer = window.setTimeout(() => { void loop() }, 500)
    }
    void loop()
    return () => {
      alive = false
      clearTimeout(loopTimer)
    }
  }, [refreshTick])

  // 布局 + 新提问检测 + 滚动跟随：内容/窗口变化时重算；用户提问行数增加时触发刷新
  // （lastUserRows/lastLayout 必须放模块级，effect 内声明会在每次重跑时重置导致死循环）
  useEffect(() => {
    let alive = true
    let timer = 0
    let spyRaf = 0
    const update = (): void => {
      if (!alive) return
      const flow = document.querySelector('[data-chat-flow]')
      // 新提问检测（用户消息行变多 → 刷新列表）
      if (flow !== null) {
        const rows = flow.querySelectorAll('[data-chat-anchor-key][data-chat-flow-kind="user"]').length
        if (rows > lastUserRows) {
          lastUserRows = rows
          setRefreshTick(t => t + 1)
        }
      }
      // 滚动跟随：找聊天真实滚动容器（换了视图就重新挂监听）
      const scroller = flow === null ? null : findScroller(flow)
      if (scroller !== chatScroller) {
        if (chatScroller !== null) chatScroller.removeEventListener('scroll', onChatScroll)
        chatScroller = scroller
        if (scroller !== null) {
          scroller.addEventListener('scroll', onChatScroll, { passive: true })
          onChatScroll()
        }
      } else if (scroller !== null) {
        // 内容变化（新消息/流式）也刷新当前位置
        cancelAnimationFrame(spyRaf)
        spyRaf = requestAnimationFrame(() => { if (alive) computeCurrentId(scroller, setCurrentId) })
      }
      // 布局变化才重渲染（避免流式期间无谓渲染）。
      // 轻量签名：只比较几何值与 ticks 规模/首尾 id（O(1)），
      // 不做 JSON.stringify 全量序列化（大会话时每次滚动都 O(n) 卡顿）。
      // 空骨架期间（提问数据未到）布局只算一次：签名以 '|0|||0'（n=0）结尾时
      // 直接跳过，避免流式输出高频触发 getBoundingClientRect reflow。
      if (questions.length === 0 && lastLayout.endsWith('|0|||0')) return
      const next = railLayout(questions, sessionIdRef.current !== undefined && sessionIdRef.current !== '')
      const key = layoutSignature(next)
      if (key !== lastLayout) {
        lastLayout = key
        setRail(next)
      }
    }
    const onChatScroll = (): void => {
      cancelAnimationFrame(spyRaf)
      spyRaf = requestAnimationFrame(() => {
        if (alive && chatScroller !== null) computeCurrentId(chatScroller, setCurrentId)
      })
    }
    const schedule = (): void => {
      clearTimeout(timer)
      timer = window.setTimeout(update, 120)
    }
    update()
    const flowObserver = new MutationObserver(schedule)
    const flow = document.querySelector('[data-chat-flow]')
    if (flow !== null) flowObserver.observe(flow, { childList: true, subtree: true })
    // 不再观察整个 body：大会话流式输出时 body 每秒变几十次，全量观察会让
    // update() 高频执行（每次含 railLayout + DOM 查询），拖慢导航轨和整个页面。
    // flow 容器内的变化已覆盖消息增删/虚拟化重建；F12/布局切换等结构变化由
    // resizeObserver + scroll 事件兜底（update 每次都会重新 findScroller）。
    window.addEventListener('resize', schedule)
    // 尺寸变化立即重算（F12 打开/关闭、侧边栏开合、内容列宽度变化）
    const resizeObserver = new ResizeObserver(schedule)
    if (flow !== null) resizeObserver.observe(flow)
    const port = flow?.closest('[data-conversation-scroll]') ?? flow
    if (port !== null && port !== flow) resizeObserver.observe(port)
    return () => {
      alive = false
      clearTimeout(timer)
      cancelAnimationFrame(spyRaf)
      if (chatScroller !== null) chatScroller.removeEventListener('scroll', onChatScroll)
      chatScroller = null
      flowObserver.disconnect()
      resizeObserver.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [questions])

  // 悬停预加载：光标靠近某条未渲染的提问时，后台就开始加载历史（点击时立即可跳）
  useEffect(() => {
    try {
      if (active === null) return
      const tick = rail.ticks.find(t => t.index === active)
      if (tick === undefined) return
      if (findRow(tick.id) === null) {
        loadUntilVisible(tick.id, () => {})
      }
    } catch (error) {
      console.error('[usage-record] hover preload failed:', error)
    }
  }, [active, rail])

  // 轨道可见即后台预加载（不等鼠标入轨）：聊天时悄悄把全部旧历史加载完，
  // 之后点击任意横线都是已渲染 → 立即跳转，消除"首次点击要等几秒"的延迟。
  // 依赖 questions：会话切换（提问列表变化）也会重新触发预加载。
  // 骨架阶段（questions 为空，fetch 未回）不预加载：total=0 会误判"已全部渲染"，
  // 且可能点一次 load-older 白白加载一批历史——数据到达后本 effect 会重跑。
  useEffect(() => {
    if (rail.visible && questions.length > 0) {
      const t = window.setTimeout(() => startBackgroundPreload(questions.length), 400)
      return () => { clearTimeout(t) }
    }
    stopBackgroundPreload()
    return undefined
  }, [rail.visible, questions])

  // 轨道自动跟随：当前提问变化时，滚动轨道让对应横线可见（居中）
  // （鼠标在轨道上时暂停，避免跟随滚动导致点击落空/误触）
  useEffect(() => {
    const el = railElRef.current
    if (el === null || currentId === null || mouseOnRail) return
    const idx = rail.ticks.findIndex(t => t.id === currentId)
    if (idx < 0) return
    const step = rail.lineH + rail.gap
    const tickTop = PAD + idx * step
    if (tickTop < el.scrollTop || tickTop > el.scrollTop + el.clientHeight - step) {
      el.scrollTo({ top: Math.max(0, tickTop - el.clientHeight / 2), behavior: 'smooth' })
    }
  }, [currentId, rail, mouseOnRail])

  if (!rail.visible) return null

  // 当前提问序号（scroll-spy 高亮的那条，1 起）；无则显示 —/总数
  const currentIdx = currentId === null ? 0 : rail.ticks.findIndex((t) => t.id === currentId) + 1

  return (
    <>
      <div
        data-question-rail=""
        onMouseEnter={() => { setMouseOnRail(true); if (rail.ticks.length > 0) startBackgroundPreload(rail.ticks.length) }}
        ref={(el) => {
          railElRef.current = el
          // 元素级原生点击兜底：直接命中横线元素（与 rect 判定视觉一致）
          if (el !== null && el.dataset.usageRecordBound === undefined) {
            el.dataset.usageRecordBound = '1'
            el.addEventListener('click', (e) => {
              const target = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-question-tick]') : null
              if (target !== null && target.dataset.questionTick !== undefined) {
                jumpToQuestion(target.dataset.questionTick)
              }
            })
          }
        }}
        onMouseMove={(e) => {
          lastClientYRef.current = e.clientY
          const rect = e.currentTarget.getBoundingClientRect()
          const y = (e.clientY - rect.top) + e.currentTarget.scrollTop
          if (mouseYRef.current === y) return
          mouseYRef.current = y
          cancelAnimationFrame(rafRef.current)
          rafRef.current = requestAnimationFrame(() => setMouseY(mouseYRef.current))
        }}
        onMouseLeave={() => { setMouseOnRail(false); mouseYRef.current = null; cancelAnimationFrame(rafRef.current); setMouseY(null) }}
        onScroll={(e) => {
          const el = e.currentTarget
          const st = el.scrollTop
          setScrollTop(st)
          // 滚动后重新换算鼠标内容坐标（鱼眼跟随）
          if (mouseYRef.current !== null) {
            const rect = el.getBoundingClientRect()
            const y = (lastClientYRef.current - rect.top) + st
            mouseYRef.current = y
            cancelAnimationFrame(rafRef.current)
            rafRef.current = requestAnimationFrame(() => setMouseY(y))
          }
        }}
        style={{
          position: 'fixed', left: rail.left, top: rail.top,
          width: MAX_W + 8, height: rail.height, zIndex: 900, cursor: 'pointer',
          overflowY: 'auto', overflowX: 'hidden',
          scrollbarWidth: 'none',
        }}
      >
        <div style={{ position: 'relative', height: rail.contentH, boxSizing: 'border-box', paddingTop: PAD, paddingBottom: PAD }}>
          {/* 虚拟化：只渲染可视区 ± 溢出带内的 tick（轨道高 ~500px、step ~21px ≈ 30 条可见；
              全部渲染在几千条提问时会拖慢每次重渲染——鼠标移动/滚动都全量重算 fisheye）。 */}
          {renderTicks(rail, scrollTop, mouseY, active, currentId, step)}
        </div>
      </div>
      {/* 计数：当前/总数（纯数字 x/x，低调，主题弱化色，始终显示在轨道正下方，微左移与轨道视觉对齐） */}
      <div
        style={{
          position: 'fixed', left: rail.left - 4, top: rail.top + rail.height + 6,
          fontSize: 10, lineHeight: 1.4,
          color: 'var(--dsw-alias-label-tertiary)',
          fontVariantNumeric: 'tabular-nums',
          pointerEvents: 'none', whiteSpace: 'nowrap', zIndex: 900,
        }}
      >
        {currentIdx > 0 ? `${currentIdx}/${rail.ticks.length}` : `—/${rail.ticks.length}`}
      </div>
      {tipTick !== undefined && (
        <div
          style={{
            position: 'fixed', left: rail.left + MAX_W + 4, top: rail.top + tipTop,
            maxWidth: 280, padding: '6px 10px', borderRadius: 8, pointerEvents: 'none',
            background: 'var(--dsw-specific-tip, #1a2030)',
            border: '1px solid var(--dsw-alias-border-l1)',
            boxShadow: '0 4px 16px rgba(0,0,0,.35)',
            fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            zIndex: 901,
          }}
        >
          <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{t('tooltip.q', { index: tipTick.index })} · </span>
          {tipTick.text || '…'}
        </div>
      )}
    </>
  )
}

export const inject = ['slots', 'locale', 'workspaces']

/** 是否已包装 history RPC（防止 apply 多次运行重复包装）。 */
let historyPatched = false
/** 历史分页批量（官方默认 50；放大后长会话回翻大幅减少往返）。 */
const HISTORY_BATCH = 3000
/** 去重：同一 id 短时间内不重复跳（document 与元素级监听都会触发）。 */
let lastJump = { id: '', at: 0 }

export function apply(ctx: Context): void {
  // 隐藏轨道滚动条（滚轮滚动仍可用；Firefox 用 scrollbar-width，Chromium 用伪元素）
  if (document.querySelector('style[data-usage-record-scrollbar]') === null) {
    const tag = document.createElement('style')
    tag.dataset.usageRecordScrollbar = ''
    tag.textContent = `[data-question-rail]{scrollbar-width:none}[data-question-rail]::-webkit-scrollbar{display:none;width:0;height:0}`
    document.head.appendChild(tag)
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'usage-record: dictionaries')
  // 包装 session.history RPC：官方 loadOlder 每批只拉 maxMessages: 50，
  // 跳到很老的提问要十几批（十几秒）。包装后每批最多 HISTORY_BATCH 条 → 1 批到位。
  // 只放大带 beforeSeq 的“翻旧页”请求；不带 beforeSeq 的首次打开/断线补页保持
  // 官方默认 50，否则当前会话会被 3000 条历史（几十 MB）堵住，实时回答无法渲染。
  // 默认 3000；若担心响应体积可调小（服务端按 turn/start 切页，无硬上限）。
  try {
    if (!historyPatched) {
      const api = (ctx.workspaces as unknown as { api?: { sessions?: { history?: (req: Record<string, unknown>) => Promise<unknown> } } } | undefined)?.api
      if (api?.sessions && typeof api.sessions.history === 'function') {
        const orig = api.sessions.history
        api.sessions.history = (req: Record<string, unknown>) =>
          orig((req as { beforeSeq?: unknown }).beforeSeq === undefined ? req : { ...req, maxMessages: HISTORY_BATCH })
        historyPatched = true
        console.log(`[usage-record] history RPC patched (loadOlder only): batch -> ${HISTORY_BATCH}`)
      }
    }
  } catch (error) {
    console.error('[usage-record] history patch failed:', error)
  }
  try {
    const workspaces = ctx.workspaces as { sessions?: { list?: { getSnapshot?: () => { current?: string }; subscribe?: (cb: () => void) => () => void } } } | undefined
    currentSessionGetter = () => {
      try {
        return workspaces?.sessions?.list?.getSnapshot?.()?.current
      } catch {
        return undefined
      }
    }
    // 会话切换事件驱动刷新（替代轮询）
    if (typeof workspaces?.sessions?.list?.subscribe === 'function') {
      let lastCurrent: string | undefined
      ctx.effect(() => workspaces.sessions!.list!.subscribe(() => {
        const current = currentSessionGetter()
        if (current !== lastCurrent) {
          lastCurrent = current
          sessionChangeNotifier?.()
        }
      }), 'usage-record: session subscription')
    }
  } catch { /* 忽略 */ }
  document.addEventListener('click', () => {
    pendingHighlightId = null
    cancelJumpLock()
    cancelActiveStick()
    clearHighlight()
  }, true)
  document.addEventListener('click', (e) => {
    jumpAtPoint(e.clientX, e.clientY)
  }, true)
  // 用户主动滚动（滚轮/触摸/键盘）→ 解锁跳转锁定与流式 stick，不再对抗拉回
  document.addEventListener('wheel', () => { userScrolledAway = true; cancelActiveStick() }, true)
  document.addEventListener('touchstart', () => { userScrolledAway = true; cancelActiveStick() }, true)
  document.addEventListener('keydown', () => { userScrolledAway = true; cancelActiveStick() }, true)
  // 鼠标移动也算用户主动操作：命令运行期间若只是移动鼠标，应立即释放 stick，避免视图在光标下反复被拉回（鼠标“漂移”感）
  document.addEventListener('mousemove', () => {
    if (activeStick !== 0 || jumpLock !== 0) {
      userScrolledAway = true
      cancelActiveStick()
    }
  }, true)
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'usage-record',
      order: 30,
      locale: NS,
    }, QuestionRail))
}
