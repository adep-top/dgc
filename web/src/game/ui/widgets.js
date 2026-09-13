import { COLORS } from '../config.js';

/** '#5aa9ff' + 0.14 → 'rgba(90, 169, 255, 0.14)' */
export function withAlpha(hex, a) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return hex;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** 线性渐变；当前环境不支持时返回 fallback 纯色 */
export function linearGradient(ctx, x0, y0, x1, y1, stops, fallback = COLORS.bg) {
  const g = typeof ctx.createLinearGradient === 'function'
    ? ctx.createLinearGradient(x0, y0, x1, y1)
    : null;
  if (!g || typeof g.addColorStop !== 'function') return fallback;
  for (const [p, c] of stops) g.addColorStop(p, c);
  return g;
}

export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function fillRoundRect(ctx, x, y, w, h, r, color) {
  ctx.fillStyle = color;
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fill();
}

export function strokeRoundRect(ctx, x, y, w, h, r, color, lw = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  roundRectPath(ctx, x, y, w, h, r);
  ctx.stroke();
}

export function drawText(ctx, text, x, y, {
  size = 16, color = COLORS.text, align = 'left', baseline = 'alphabetic', bold = false,
} = {}) {
  ctx.fillStyle = color;
  ctx.font = `${bold ? 'bold ' : ''}${size}px -apple-system, "PingFang SC", sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(text, x, y);
}

/**
 * 按可用宽度反算字号：任何标签都不允许越出容器边界。
 * maxW 为文字可用宽度，从 max 逐级降到 min，返回首个放得下的字号。
 */
export function fitText(ctx, text, maxW, { max = 15, min = 11, bold = false } = {}) {
  for (let size = max; size > min; size--) {
    ctx.font = `${bold ? 'bold ' : ''}${size}px -apple-system, "PingFang SC", sans-serif`;
    if (ctx.measureText(text).width <= maxW) return size;
  }
  return min;
}

/** 仍放不下时按字数截断并补省略号（配合 fitText 使用，保证不溢出） */
export function ellipsize(ctx, text, maxW, size, bold = false) {
  ctx.font = `${bold ? 'bold ' : ''}${size}px -apple-system, "PingFang SC", sans-serif`;
  if (ctx.measureText(text).width <= maxW) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxW) out = out.slice(0, -1);
  return `${out}…`;
}

/** 一次拿到「不溢出的字号 + 最终文案」 */
export function fitLabel(ctx, text, maxW, { max = 15, min = 11, bold = false } = {}) {
  const size = fitText(ctx, text, maxW, { max, min, bold });
  return { size, text: ellipsize(ctx, text, maxW, size, bold) };
}

/** 在按钮中心围绕自身做等比缩放（按下反馈） */
function scaleAbout(ctx, cx, cy, s) {
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.translate(-cx, -cy);
}

export function drawButton(ctx, btn, { disabled = false, pressed = false } = {}) {
  const {
    x, y, w, h, label, kind = 'primary',
  } = btn;
  const radius = btn.radius || 14;
  const alpha = disabled ? 0.4 : 1;
  const cx = x + w / 2;
  const cy = y + h / 2;

  ctx.save();
  ctx.globalAlpha = alpha;
  // 按下：整块按钮围绕中心缩到 0.94，制造"按下去了"的物理感
  if (pressed && !disabled) scaleAbout(ctx, cx, cy, 0.94);

  if (kind === 'primary') {
    // 主按钮：蓝色渐变 + 外发光
    ctx.save();
    ctx.shadowColor = 'rgba(47,111,235,.4)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 4;
    fillRoundRect(ctx, x, y, w, h, radius, linearGradient(ctx, x, y, x, y + h,
      [[0, COLORS.primaryTop], [0.55, '#3b7cf6'], [1, COLORS.primaryBottom]], COLORS.accent));
    ctx.restore();
    strokeRoundRect(ctx, x, y, w, h, radius, 'rgba(255,255,255,.18)', 1);
  } else if (kind === 'danger') {
    // 危险按钮：透明底 + 1px 红描边 + 红字。
    // 去掉原来的红色渐变填充与 shadowBlur 发光——危险操作靠"边界感"提示，
    // 发光反而让它在暗色面板里比常规按钮更显眼、更"诱人"。
    strokeRoundRect(ctx, x, y, w, h, radius, COLORS.dangerStroke, 1);
  } else if (kind === 'win') {
    // 胜利/确认按钮：绿色渐变
    ctx.save();
    ctx.shadowColor = 'rgba(78,203,143,.35)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 4;
    fillRoundRect(ctx, x, y, w, h, radius, linearGradient(ctx, x, y, x, y + h,
      [[0, '#5fd9a0'], [1, '#3ab87a']], COLORS.win));
    ctx.restore();
    strokeRoundRect(ctx, x, y, w, h, radius, 'rgba(255,255,255,.2)', 1);
  } else {
    // ghost 默认：用于弹窗内按钮（面板之上需要有形底板才可辨认）
    fillRoundRect(ctx, x, y, w, h, radius, linearGradient(ctx, x, y, x, y + h,
      [[0, '#1c2330'], [1, '#161b26']], COLORS.panel));
    strokeRoundRect(ctx, x, y, w, h, radius, COLORS.btnStroke, 1);
  }

  // 按下态叠加层：统一提亮底色 + 提亮描边（渐变按钮上表现为"被压亮"）
  if (pressed && !disabled) {
    fillRoundRect(ctx, x, y, w, h, radius, COLORS.btnPressed);
    strokeRoundRect(ctx, x, y, w, h, radius, COLORS.btnPressedStroke, 1);
  }

  if (label) {
    const color = kind === 'danger' ? COLORS.dangerText
      : kind === 'win' ? '#0f1218'
        : kind === 'primary' ? '#ffffff'
          : COLORS.text;
    const size = btn.fontSize || 15;
    const bold = kind === 'primary' || kind === 'win' || kind === 'danger';
    // 兜底：即便 layout 阶段漏算了，这里也不会让文字越出按钮
    const inner = Math.max(8, w - (btn.icon ? 26 : 16));
    const fit = btn.noFit ? { size, text: label } : fitLabel(ctx, label, inner, { max: size, min: 10, bold });
    drawText(ctx, fit.text, cx, cy + 1, {
      size: fit.size, color, align: 'center', baseline: 'middle', bold,
    });
  }
  ctx.restore();
}

export const inRect = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** 获取微信右上角胶囊按钮位置；不可用时返回 null。
 *  用于把「刷新」等右上角按钮往左挪，避免被胶囊菜单遮挡。 */
export function getMenuButtonRect() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.getMenuButtonBoundingClientRect === 'function') {
      const r = wx.getMenuButtonBoundingClientRect();
      if (r && r.width && r.height) return r;
    }
  } catch (e) { /* ignore */ }
  return null;
}

export function toast(title, icon = 'none') {
  wx.showToast({ title, icon, duration: 1600 });
}
