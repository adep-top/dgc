/**
 * wx 全局适配层：把微信小游戏 API 映射到网页（Canvas 2D 游戏本体零改动运行）。
 *
 * 设计原则：
 *   - 只实现游戏用到的子集；未实现的开放数据域 API（getOpenDataContext /
 *     getFriendCloudStorage / ...）故意不定义 —— ranking.js 里有
 *     `typeof wx.getOpenDataContext === 'function'` 守卫，缺失即优雅降级
 *     （好友/群排行在 web 版显示「暂不支持」）。
 *   - 覆盖层（toast/modal/loading/actionsheet）走 DOM（overlay.ts），
 *     游戏自身的 Canvas toast 不受影响。
 *   - 触摸事件统一走 Pointer Events（触屏 + 鼠标），形状对齐 wx 的
 *     `{ touches: [{clientX, clientY}], changedTouches: [...] }`。
 */
import { showToast, showLoading, hideLoading, showModal, showActionSheet, type ModalOptions } from './overlay'

type TouchLike = { clientX: number; clientY: number; identifier?: number }
type TouchListLike = { touches: TouchLike[]; changedTouches: TouchLike[]; timeStamp?: number }
type TouchHandler = (evt: TouchListLike) => void

export interface WxApi {
  [k: string]: unknown
}

const DEVICE_KEY = 'dgc_device_id'

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}
function writeStorage(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch { /* ignore */ }
}

export function getDeviceId(): string {
  let id = readStorage(DEVICE_KEY)
  if (!id) {
    id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
    writeStorage(DEVICE_KEY, id)
  }
  return id
}

function buildShareLink(query?: string): string {
  const q = typeof query === 'string' ? query : ''
  const room = /room=([A-Za-z0-9]+)/.exec(q)
  const game = /gameId=([A-Za-z0-9]+)/.exec(q)
  let href = location.origin + location.pathname
  const params: string[] = []
  if (room) params.push(`room=${encodeURIComponent(room[1])}`)
  if (game) params.push(`gameId=${encodeURIComponent(game[1])}`)
  if (params.length) href += `?${params.join('&')}`
  return href
}

export function installWxAdapter(canvas: HTMLCanvasElement): WxApi {
  // 微信语义：wx.createCanvas() 每次调用都返回【新的】画布（游戏主画布取一次，
  // 离屏画布各取各的）。web 端首次调用必须返回传入的主画布（触摸绑定在它上面），
  // 之后再调用才新建 canvas —— 否则离屏烘焙会拿到主画布，drawImage 自绘成 no-op，
  // 画布永不真正清屏，旧场景内容会残留在新场景下面。
  let mainCanvasGiven = false
  const createCanvas = (): HTMLCanvasElement => {
    if (!mainCanvasGiven) {
      mainCanvasGiven = true
      return canvas
    }
    const c = document.createElement('canvas')
    return c
  }

  const touchHandlers: { start: TouchHandler[]; move: TouchHandler[]; end: TouchHandler[] } = { start: [], move: [], end: [] }
  const showHandlers: Array<() => void> = []
  const hideHandlers: Array<() => void> = []
  const activePointers = new Map<number, TouchLike>()

  const fire = (list: TouchHandler[], kind: 'start' | 'move' | 'end', changed: TouchLike[]) => {
    const touches = [...activePointers.values()]
    const evt: TouchListLike = { touches, changedTouches: changed, timeStamp: Date.now() }
    for (const h of list) {
      try {
        h(evt)
      } catch (e) {
        console.error('[dgc:wx] touch handler error', e)
      }
    }
  }

  // 把指针事件坐标换算成「canvas 相对 + 逻辑像素」：wx 小游戏里 clientX/clientY 即画布逻辑坐标，
  // web 端画布位图（width*dpr）可能被 CSS 拉伸/偏移，直接透传会点击错位（视觉点中 A、命中 B）。
  const px = (e: PointerEvent): TouchLike => {
    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const logicalW = (canvas.width / dpr) || rect.width || 1
    const logicalH = (canvas.height / dpr) || rect.height || 1
    return {
      clientX: (e.clientX - rect.left) * (logicalW / (rect.width || 1)),
      clientY: (e.clientY - rect.top) * (logicalH / (rect.height || 1)),
      identifier: e.pointerId,
    }
  }

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault()
    const t = px(e)
    activePointers.set(e.pointerId, t)
    fire(touchHandlers.start, 'start', [t])
  }
  const onPointerMove = (e: PointerEvent) => {
    e.preventDefault()
    if (!activePointers.has(e.pointerId)) return
    const t = px(e)
    activePointers.set(e.pointerId, t)
    fire(touchHandlers.move, 'move', [t])
  }
  const onPointerUp = (e: PointerEvent) => {
    e.preventDefault()
    const t = px(e)
    activePointers.delete(e.pointerId)
    fire(touchHandlers.end, 'end', [t])
  }

  canvas.style.touchAction = 'none'
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())

  const onVis = () => {
    if (document.visibilityState === 'visible') {
      for (const h of showHandlers) {
        try {
          h()
        } catch { /* ignore */ }
      }
    } else {
      for (const h of hideHandlers) {
        try {
          h()
        } catch { /* ignore */ }
      }
    }
  }
  document.addEventListener('visibilitychange', onVis)
  window.addEventListener('focus', () => {
    if (document.visibilityState === 'visible') for (const h of showHandlers) { try { h() } catch { /* ignore */ } }
  })

  const launchQuery = (): Record<string, string> => {
    try {
      const sp = new URLSearchParams(location.search)
      const out: Record<string, string> = {}
      for (const [k, v] of sp.entries()) out[k] = v
      return out
    } catch {
      return {}
    }
  }

  const safeArea = () => {
    const w = window.innerWidth || 375
    const h = window.innerHeight || 667
    return { top: 0, bottom: h, left: 0, right: w, width: w, height: h }
  }

  const wx: WxApi = {
    /* ---------- 画布与显示 ---------- */
    createCanvas,
    createImage: () => new Image(),
    getSystemInfoSync: () => ({
      windowWidth: window.innerWidth || 375,
      windowHeight: window.innerHeight || 667,
      pixelRatio: window.devicePixelRatio || 1,
      platform: 'web',
      system: `${navigator.platform || ''} ${navigator.userAgent || ''}`,
      screenWidth: window.screen?.width || window.innerWidth,
      screenHeight: window.screen?.height || window.innerHeight,
      safeArea: safeArea(),
      safeAreaInsets: { top: 0, left: 0, right: 0, bottom: 0 },
    }),
    getMenuButtonBoundingClientRect: () => null,
    getAccountInfoSync: () => null,
    getLaunchOptionsSync: () => ({ query: launchQuery(), path: location.pathname, scene: 1001 }),
    onShow: (cb: () => void) => {
      showHandlers.push(cb)
    },
    onHide: (cb: () => void) => {
      hideHandlers.push(cb)
    },

    /* ---------- 触摸 ---------- */
    onTouchStart: (cb: TouchHandler) => touchHandlers.start.push(cb),
    onTouchMove: (cb: TouchHandler) => touchHandlers.move.push(cb),
    onTouchEnd: (cb: TouchHandler) => touchHandlers.end.push(cb),

    /* ---------- 存储 ---------- */
    getStorageSync: (key: string) => readStorage(String(key)),
    setStorageSync: (key: string, value: unknown) => writeStorage(String(key), typeof value === 'string' ? value : String(value ?? '')),
    removeStorageSync: (key: string) => writeStorage(String(key), ''),

    /* ---------- 登录 ---------- */
    login: (opts: { success?: (res: { code: string }) => void; fail?: (e: unknown) => void }) => {
      try {
        const code = `dev:${getDeviceId()}`
        if (opts.success) opts.success({ code })
      } catch (e) {
        if (opts.fail) opts.fail(e)
      }
    },

    /* ---------- 网络 ---------- */
    request: (opts: {
      url: string
      method?: string
      data?: unknown
      header?: Record<string, string>
      timeout?: number
      success?: (res: { statusCode: number; data: unknown; header: Record<string, string> }) => void
      fail?: (e: { errMsg: string }) => void
    }) => {
      const { url, method = 'GET', data, header, timeout } = opts
      const controller = new AbortController()
      const timer = typeof timeout === 'number' && timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null
      const init: RequestInit = { method, headers: { ...(header || {}) }, signal: controller.signal }
      if (method !== 'GET' && method !== 'HEAD' && data !== undefined && data !== null) {
        init.body = typeof data === 'string' ? data : JSON.stringify(data)
      }
      fetch(url, init)
        .then(async (res) => {
          const text = await res.text().catch(() => '')
          let parsed: unknown = text
          try {
            parsed = text ? JSON.parse(text) : null
          } catch { /* 非 JSON 保留原文 */ }
          if (opts.success) {
            opts.success({
              statusCode: res.status,
              data: parsed,
              header: Object.fromEntries(res.headers.entries()),
            })
          }
        })
        .catch((e: unknown) => {
          if (opts.fail) opts.fail({ errMsg: e instanceof Error ? e.message : String(e) })
        })
        .finally(() => {
          if (timer) clearTimeout(timer)
        })
    },

    /* ---------- 弹层（DOM 覆盖层） ---------- */
    showToast: (opts: { title?: string; duration?: number; icon?: string; success?: () => void }) => {
      showToast(opts.title || '', { duration: opts.duration, icon: opts.icon })
      if (opts.success) opts.success()
    },
    showLoading: (opts: { title?: string; mask?: boolean; success?: () => void }) => {
      showLoading(opts.title || '加载中…')
      if (opts.success) opts.success()
    },
    hideLoading: () => hideLoading(),
    showModal: (opts: ModalOptions) => showModal(opts),
    showActionSheet: (opts: { itemList: string[]; success?: (res: { tapIndex: number }) => void; fail?: (e: unknown) => void }) =>
      showActionSheet(opts),

    /* ---------- 剪贴板 / 震动 / 音频 ---------- */
    setClipboardData: (opts: { data: string; success?: () => void; fail?: (e: unknown) => void }) => {
      const text = String(opts.data || '')
      const done = () => {
        if (opts.success) opts.success()
      }
      if (navigator.clipboard?.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(done)
          .catch(() => {
            legacyCopy(text)
            done()
          })
      } else {
        legacyCopy(text)
        done()
      }
    },
    vibrateShort: () => {
      try {
        navigator.vibrate?.(10)
      } catch { /* ignore */ }
    },
    createWebAudioContext: () => new AudioContext(),

    /* ---------- 分享 ---------- */
    showShareMenu: () => {},
    onShareAppMessage: () => {},
    shareAppMessage: (opts: { title?: string; query?: string }) => {
      const title = opts.title || '云柯点格棋'
      const url = buildShareLink(opts.query)
      const share = () => {
        if (navigator.share) {
          navigator
            .share({ title, text: title, url })
            .catch(() => { /* 用户取消分享不提示 */ })
        } else {
          legacyCopy(url)
          showToast('邀请链接已复制')
        }
      }
      share()
    },

    /* ---------- 云存储 / 订阅（web 无此能力，安全降级） ---------- */
    setUserCloudStorage: () => {},
    requestSubscribeMessage: (opts: { tmplIds?: string[]; success?: () => void; fail?: (e: unknown) => void }) => {
      if (opts.fail) opts.fail({ errMsg: 'web 版不支持订阅消息' })
    },
    getSystemSetting: () => ({}),
    getSystemSettingSync: () => ({}),
  }

  return wx
}

/** 老式剪贴板回退 */
function legacyCopy(text: string): void {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  } catch { /* ignore */ }
}

/** 注册到全局（游戏代码以全局 wx 调用） */
export function registerWx(wx: WxApi): void {
  ;(globalThis as unknown as { wx: WxApi }).wx = wx
}
