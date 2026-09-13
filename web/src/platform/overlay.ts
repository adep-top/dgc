/**
 * DOM 覆盖层：把 wx.showToast / showLoading / showModal / showActionSheet
 * 渲染成网页浮层，样式贴近小游戏暗色 UI（游戏本身的 Canvas toast 不受影响）。
 *
 * 所有元素挂在 body 下的 #dgc-overlay-root 上，z-index 高于画布。
 */

let root: HTMLElement | null = null

function ensureRoot(): HTMLElement {
  if (root && document.body.contains(root)) return root
  const el = document.createElement('div')
  el.id = 'dgc-overlay-root'
  el.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:9999;font-family:-apple-system,"PingFang SC",sans-serif;'
  document.body.appendChild(el)
  root = el
  return el
}

function el(tag: string, css: string, parent: HTMLElement): HTMLElement {
  const n = document.createElement(tag)
  n.style.cssText = css
  parent.appendChild(n)
  return n
}

/* ---------------- toast ---------------- */

let toastTimer: ReturnType<typeof setTimeout> | null = null

export function showToast(title: string, opts: { duration?: number; icon?: string } = {}): void {
  const { duration = 1800 } = opts
  const host = ensureRoot()
  const box = el(
    'div',
    'position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);' +
      'background:rgba(23,27,36,.94);border:1px solid rgba(255,255,255,.10);' +
      'border-radius:12px;padding:16px 24px;color:#e6e9ef;font-size:14px;' +
      'line-height:1.5;text-align:center;max-width:70vw;pointer-events:none;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.45);',
    host,
  )
  box.textContent = title
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    box.remove()
    toastTimer = null
  }, duration)
}

/* ---------------- loading ---------------- */

let loadingEl: HTMLElement | null = null
let loadingCount = 0

export function showLoading(title = '加载中…'): void {
  loadingCount += 1
  if (loadingEl) return
  const host = ensureRoot()
  const mask = el('div', 'position:absolute;inset:0;background:rgba(8,10,14,.35);pointer-events:auto;', host)
  const box = el(
    'div',
    'position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);' +
      'background:rgba(23,27,36,.96);border:1px solid rgba(255,255,255,.10);' +
      'border-radius:14px;padding:24px 28px;display:flex;flex-direction:column;align-items:center;gap:12px;',
    mask,
  )
  const spin = el(
    'div',
    'width:30px;height:30px;border-radius:50%;border:3px solid rgba(255,255,255,.15);' +
      'border-top-color:#5b95ff;animation:dgc-spin .8s linear infinite;',
    box,
  )
  const style = document.createElement('style')
  style.textContent = '@keyframes dgc-spin{to{transform:rotate(360deg)}}'
  document.head.appendChild(style)
  const label = el('div', 'color:#aab4c6;font-size:13px;', box)
  label.textContent = title
  loadingEl = mask
}

export function hideLoading(): void {
  loadingCount = Math.max(0, loadingCount - 1)
  if (loadingCount > 0) return
  if (loadingEl) {
    loadingEl.remove()
    loadingEl = null
  }
}

/* ---------------- modal（含可编辑输入） ---------------- */

export interface ModalOptions {
  title?: string
  content?: string
  editable?: boolean
  placeholderText?: string
  confirmText?: string
  cancelText?: string
  showCancel?: boolean
  success?: (res: { confirm: boolean; cancel: boolean; content?: string }) => void
  fail?: (err: unknown) => void
}

export function showModal(opts: ModalOptions = {}): void {
  const host = ensureRoot()
  const mask = el('div', 'position:absolute;inset:0;background:rgba(8,10,14,.62);pointer-events:auto;', host)
  const panel = el(
    'div',
    'position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);width:min(300px,86vw);' +
      'background:#171b24;border:1px solid rgba(255,255,255,.10);border-radius:16px;' +
      'overflow:hidden;box-shadow:0 12px 32px rgba(0,0,0,.5);',
    mask,
  )
  const title = el('div', 'padding:18px 18px 4px;color:#e6e9ef;font-size:16px;font-weight:600;text-align:center;', panel)
  title.textContent = opts.title || ''
  const body = el('div', 'padding:8px 18px 14px;color:#8b94a7;font-size:13px;line-height:1.6;text-align:center;word-break:break-all;', panel)
  body.textContent = opts.content || ''

  let input: HTMLInputElement | null = null
  if (opts.editable) {
    input = el('input', 'margin:0 18px 8px;padding:9px 12px;border-radius:8px;border:1px solid #2a303c;' +
      'background:#0f1218;color:#e6e9ef;font-size:14px;outline:none;width:calc(100% - 60px);', panel) as HTMLInputElement
    input.placeholder = opts.placeholderText || ''
    input.maxLength = 24
  }

  const btnRow = el('div', 'display:flex;border-top:1px solid rgba(255,255,255,.08);', panel)
  const btnCss =
    'flex:1;padding:13px 0;background:none;border:none;color:#8b94a7;font-size:15px;cursor:pointer;'
  const confirmBtn = el('button', btnCss + 'color:#5b95ff;font-weight:600;', btnRow) as HTMLButtonElement
  confirmBtn.textContent = opts.confirmText || '确定'

  const finish = (confirm: boolean) => {
    mask.remove()
    if (opts.success) opts.success({ confirm, cancel: !confirm, content: input ? input.value : undefined })
  }
  if (opts.showCancel !== false) {
    const cancelBtn = el('button', btnCss + 'border-right:1px solid rgba(255,255,255,.08);', btnRow) as HTMLButtonElement
    cancelBtn.textContent = opts.cancelText || '取消'
    cancelBtn.onclick = () => finish(false)
  }
  confirmBtn.onclick = () => finish(true)
  mask.onclick = (e) => {
    if (e.target === mask) finish(false)
  }
  if (input) {
    input.onkeydown = (e) => {
      if (e.key === 'Enter') finish(true)
      e.stopPropagation()
    }
    setTimeout(() => input?.focus(), 50)
  }
}

/* ---------------- action sheet ---------------- */

export function showActionSheet(opts: { itemList: string[]; success?: (res: { tapIndex: number }) => void; fail?: (err: unknown) => void }): void {
  const host = ensureRoot()
  const mask = el('div', 'position:absolute;inset:0;background:rgba(8,10,14,.62);pointer-events:auto;', host)
  const sheet = el(
    'div',
    'position:absolute;left:50%;bottom:18px;transform:translateX(-50%);width:min(320px,92vw);' +
      'background:#171b24;border:1px solid rgba(255,255,255,.10);border-radius:16px;overflow:hidden;',
    mask,
  )
  opts.itemList.forEach((item, i) => {
    const btn = el(
      'button',
      'width:100%;padding:14px 0;background:none;border:none;color:#e6e9ef;font-size:15px;cursor:pointer;' +
        (i < opts.itemList.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,.07);' : ''),
      sheet,
    ) as HTMLButtonElement
    btn.textContent = item
    btn.onclick = () => {
      mask.remove()
      if (opts.success) opts.success({ tapIndex: i })
    }
  })
  const cancel = el('button', 'width:100%;padding:14px 0;background:none;border:none;color:#8b94a7;font-size:15px;cursor:pointer;' +
    'border-top:1px solid rgba(255,255,255,.10);', sheet) as HTMLButtonElement
  cancel.textContent = '取消'
  cancel.onclick = () => {
    mask.remove()
    if (opts.fail) opts.fail({ errMsg: 'cancel' })
  }
  mask.onclick = (e) => {
    if (e.target === mask) {
      mask.remove()
      if (opts.fail) opts.fail({ errMsg: 'cancel' })
    }
  }
}
