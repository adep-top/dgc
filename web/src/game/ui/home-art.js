/**
 * 首页视觉资源：背景、品牌标、图标与各种卡片控件。
 *
 * 全部用几何图形程序化绘制（不依赖图片、字体图标或外部资源），
 * 好处是各端渲染一致、可跟随主题色调整、也不用额外下载体积。
 *
 * 注意：所有渐变都走 linearGradient / radialGlow 包装，
 * 在不支持渐变对象的环境（Node 冒烟测试的 canvas 桩）自动退回纯色，避免渲染期抛错。
 */
import { COLORS } from '../config.js';
import { roundRectPath, fillRoundRect, strokeRoundRect } from './widgets.js';

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

/** 柔光：用径向渐变刷一块方形，做出「光晕」而不是硬边圆 */
function radialGlow(ctx, cx, cy, r, color) {
  const g = typeof ctx.createRadialGradient === 'function'
    ? ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    : null;
  if (!g || typeof g.addColorStop !== 'function') return;
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
}

/* ---------------- 背景 ---------------- */

/** 渐变底色 + 两处柔光 + 点阵底纹（点阵呼应「云柯点格棋」的网格感） */
export function paintHomeBackground(ctx, W, H) {
  ctx.fillStyle = linearGradient(ctx, 0, 0, 0, H,
    [[0, '#0d1119'], [0.52, '#0f131c'], [1, '#0a0d13']], COLORS.bg);
  ctx.fillRect(0, 0, W, H);

  radialGlow(ctx, W * 0.5, H * 0.05, Math.max(W, 320) * 0.95, 'rgba(56,109,235,.20)');
  radialGlow(ctx, W * 1.02, H * 0.96, W * 0.78, 'rgba(90,169,255,.07)');

  ctx.fillStyle = 'rgba(255,255,255,.028)';
  const step = 26;
  const r = 1.1;
  for (let y = step * 0.5; y < H; y += step) {
    for (let x = step * 0.5; x < W; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * 把背景烘焙到离屏画布，避免每帧重绘几百个点。
 * 失败（环境不支持离屏画布）返回 null，调用方退回逐帧直接绘制。
 */
export function createBackgroundCanvas(W, H, dpr = 2) {
  if (typeof wx === 'undefined' || typeof wx.createCanvas !== 'function') return null;
  try {
    // 主画布已在 app.js 构造时取走，这里拿到的必定是离屏画布
    const canvas = wx.createCanvas();
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    const c = canvas.getContext('2d');
    if (!c || typeof c.fillRect !== 'function') return null;
    c.scale(dpr, dpr);
    paintHomeBackground(c, W, H);
    return canvas;
  } catch (e) {
    return null;
  }
}

/* ---------------- 品牌标与文字 ---------------- */

/** 品牌标：圆角底板 + 3×3 点位 + 一个已占领的格子 */
export function drawBrandLogo(ctx, cx, cy, size) {
  const half = size / 2;
  const x = cx - half;
  const y = cy - half;
  const r = size * 0.3;

  ctx.fillStyle = linearGradient(ctx, x, y, x + size, y + size,
    [[0, 'rgba(64,124,255,.32)'], [1, 'rgba(37,99,235,.13)']], 'rgba(64,124,255,.20)');
  roundRectPath(ctx, x, y, size, size, r);
  ctx.fill();
  strokeRoundRect(ctx, x, y, size, size, r, 'rgba(255,255,255,.14)', 1);

  const step = size * 0.25;
  const dotR = Math.max(1.2, size * 0.034);
  const gx = cx - step;
  const gy = cy - step;

  // 左上格：由四条边围成的「已占领格子」（画在四个点之间，不遮点位）
  const cell = step * 0.78;
  const bx = gx + step * 0.5 - cell / 2;
  const by = gy + step * 0.5 - cell / 2;
  ctx.fillStyle = linearGradient(ctx, bx, by, bx + cell, by + cell,
    [[0, '#8cbcff'], [1, '#3b82f6']], '#5aa9ff');
  roundRectPath(ctx, bx, by, cell, cell, cell * 0.24);
  ctx.fill();
  strokeRoundRect(ctx, bx, by, cell, cell, cell * 0.24, 'rgba(255,255,255,.45)', 1);

  ctx.fillStyle = 'rgba(226,235,255,.5)';
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      ctx.beginPath();
      ctx.arc(gx + i * step, gy + j * step, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** 带字距的标题（逐字绘制），并给一层自上而下的金属渐变 */
export function drawSpacedTitle(ctx, text, cx, cy, { size = 34, gap = 6, fallback = '#eef2f9' } = {}) {
  const chars = String(text).split('');
  ctx.font = `bold ${size}px -apple-system, "PingFang SC", sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + gap * (chars.length - 1);
  ctx.fillStyle = linearGradient(ctx, 0, cy - size * 0.6, 0, cy + size * 0.6,
    [[0, '#ffffff'], [0.62, '#e8eefa'], [1, '#a7b6d3']], fallback);
  let x = cx - total / 2;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x, cy);
    x += widths[i] + gap;
  }
}

/** 状态胶囊：小圆点 + 文案（登录态 / 单机模式） */
export function drawStatusPill(ctx, cx, cy, text, dotColor) {
  ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
  const tw = ctx.measureText(text).width;
  const dotR = 3.5;
  const padL = 13;
  const padR = 14;
  const gap = 7;
  const h = 26;
  const w = padL + dotR * 2 + gap + tw + padR;
  const x = cx - w / 2;
  const y = cy - h / 2;

  fillRoundRect(ctx, x, y, w, h, h / 2, 'rgba(255,255,255,.045)');
  strokeRoundRect(ctx, x, y, w, h, h / 2, 'rgba(255,255,255,.07)', 1);

  const dx = x + padL + dotR;
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = dotColor;
  ctx.beginPath();
  ctx.arc(dx, cy, dotR * 2.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(dx, cy, dotR, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#aab4c6';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, dx + dotR + gap, cy + 0.5);
}

/** 右侧箭头（用两段折线画，比字体符号更锐利） */
export function drawChevron(ctx, x, cy, size, color, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x, cy - size / 2);
  ctx.lineTo(x + size * 0.55, cy);
  ctx.lineTo(x, cy + size / 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/* ---------------- 图标 ---------------- */

/**
 * 纯几何图标。name: bolt | solo | plus | hourglass | list | hash
 * cx/cy 为中心点，size 为图标外接尺寸。
 */
export function drawIcon(ctx, name, cx, cy, size, color) {
  const s = size;
  switch (name) {
    case 'bolt': {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(cx + s * 0.20, cy - s * 0.50);
      ctx.lineTo(cx - s * 0.36, cy + s * 0.06);
      ctx.lineTo(cx - s * 0.02, cy + s * 0.06);
      ctx.lineTo(cx - s * 0.18, cy + s * 0.50);
      ctx.lineTo(cx + s * 0.38, cy - s * 0.08);
      ctx.lineTo(cx + s * 0.02, cy - s * 0.08);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'solo': {
      // 2×2 小棋格：左上已占领，其余为待围的空格
      const cell = s * 0.36;
      const o = cell * 0.5 + s * 0.07;
      const cells = [[-o, -o, true], [o, -o, false], [-o, o, false], [o, o, false]];
      for (const [dx, dy, solid] of cells) {
        const x = cx + dx - cell / 2;
        const y = cy + dy - cell / 2;
        if (solid) fillRoundRect(ctx, x, y, cell, cell, cell * 0.24, color);
        else strokeRoundRect(ctx, x, y, cell, cell, cell * 0.24, withAlpha(color, 0.45), 1.6);
      }
      break;
    }
    case 'plus': {
      const t = s * 0.22;
      const l = s * 0.86;
      fillRoundRect(ctx, cx - l / 2, cy - t / 2, l, t, t / 2, color);
      fillRoundRect(ctx, cx - t / 2, cy - l / 2, t, l, t / 2, color);
      break;
    }
    case 'hourglass': {
      const w = s * 0.72;
      const h = s * 0.82;
      const ty = cy - h / 2;
      const by = cy + h / 2;
      const barH = s * 0.14;
      fillRoundRect(ctx, cx - w / 2 - s * 0.07, ty - barH / 2, w + s * 0.14, barH, barH / 2, color);
      fillRoundRect(ctx, cx - w / 2 - s * 0.07, by - barH / 2, w + s * 0.14, barH, barH / 2, color);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(cx - w / 2, ty + barH * 0.4);
      ctx.lineTo(cx + w / 2, ty + barH * 0.4);
      ctx.lineTo(cx + s * 0.07, cy);
      ctx.lineTo(cx + w / 2, by - barH * 0.4);
      ctx.lineTo(cx - w / 2, by - barH * 0.4);
      ctx.lineTo(cx - s * 0.07, cy);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'list': {
      const h = s * 0.12;
      const ys = [cy - s * 0.25, cy, cy + s * 0.25];
      const widths = [0.88, 0.6, 0.74];
      for (let i = 0; i < 3; i++) {
        const y = ys[i] - h / 2;
        fillRoundRect(ctx, cx - s * 0.44, y, s * widths[i], h, h / 2, color);
      }
      break;
    }
    case 'hash': {
      const t = s * 0.13;
      const l = s * 0.82;
      const off = s * 0.19;
      fillRoundRect(ctx, cx - off - t / 2, cy - l / 2, t, l, t / 2, color);
      fillRoundRect(ctx, cx + off - t / 2, cy - l / 2, t, l, t / 2, color);
      fillRoundRect(ctx, cx - l / 2, cy - off - t / 2, l, t, t / 2, color);
      fillRoundRect(ctx, cx - l / 2, cy + off - t / 2, l, t, t / 2, color);
      break;
    }
    default:
      break;
  }
}

/* ---------------- 首页控件 ---------------- */

/** 主 CTA：蓝紫渐变 + 外发光 + 闪电图标，全屏最亮的元素 */
export function drawHeroCard(ctx, b, { disabled = false } = {}) {
  ctx.globalAlpha = disabled ? 0.4 : 1;
  ctx.save();
  ctx.shadowColor = 'rgba(47,111,235,.45)';
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 8;
  fillRoundRect(ctx, b.x, b.y, b.w, b.h, 18, linearGradient(ctx, b.x, b.y, b.x, b.y + b.h,
    [[0, '#5b95ff'], [0.55, '#3b7cf6'], [1, '#2563eb']], COLORS.accent));
  ctx.restore();
  strokeRoundRect(ctx, b.x, b.y, b.w, b.h, 18, 'rgba(255,255,255,.16)', 1);

  const cy = b.y + b.h / 2;
  const iconSize = 20;
  const gap = 9;
  ctx.font = 'bold 17px -apple-system, "PingFang SC", sans-serif';
  const lw = ctx.measureText(b.label).width;
  const total = iconSize + gap + lw;
  const ix = b.x + (b.w - total) / 2;
  drawIcon(ctx, b.icon || 'bolt', ix + iconSize / 2, cy, iconSize, '#ffffff');
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 17px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(b.label, ix + iconSize + gap, cy + 0.5);

  drawChevron(ctx, b.x + b.w - 22, cy, 9, '#ffffff', 0.7);
  ctx.globalAlpha = 1;
}

/** 三宫格磁贴：图标块 + 主标题 + 副标题 */
export function drawTile(ctx, b, { disabled = false } = {}) {
  ctx.globalAlpha = disabled ? 0.38 : 1;
  ctx.fillStyle = linearGradient(ctx, b.x, b.y, b.x, b.y + b.h,
    [[0, '#1b2231'], [1, '#151a24']], '#171d28');
  roundRectPath(ctx, b.x, b.y, b.w, b.h, 16);
  ctx.fill();
  strokeRoundRect(ctx, b.x, b.y, b.w, b.h, 16, 'rgba(255,255,255,.075)', 1);

  const is = Math.min(34, b.w * 0.4);
  const ibx = b.x + (b.w - is) / 2;
  const iby = b.y + Math.min(13, b.h * 0.14);
  const accent = b.accent || COLORS.p2;
  fillRoundRect(ctx, ibx, iby, is, is, 11, withAlpha(accent, 0.14));
  strokeRoundRect(ctx, ibx, iby, is, is, 11, withAlpha(accent, 0.22), 1);
  drawIcon(ctx, b.icon, ibx + is / 2, iby + is / 2, is * 0.56, accent);

  const cx = b.x + b.w / 2;
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 14px -apple-system, "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(b.label, cx, b.y + b.h - 26);
  if (b.sub) {
    ctx.fillStyle = withAlpha(COLORS.sub, 0.9);
    ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(b.sub, cx, b.y + b.h - 11);
  }
  ctx.globalAlpha = 1;
}

/** 胶囊按钮：左图标 + 标题 + 右箭头 */
export function drawPill(ctx, b, { disabled = false } = {}) {
  ctx.globalAlpha = disabled ? 0.38 : 1;
  ctx.fillStyle = linearGradient(ctx, b.x, b.y, b.x, b.y + b.h,
    [[0, '#1a212e'], [1, '#151a24']], '#171d28');
  roundRectPath(ctx, b.x, b.y, b.w, b.h, 16);
  ctx.fill();
  strokeRoundRect(ctx, b.x, b.y, b.w, b.h, 16, 'rgba(255,255,255,.07)', 1);

  const is = Math.min(28, b.h * 0.55);
  const ibx = b.x + 14;
  const iby = b.y + (b.h - is) / 2;
  const accent = b.accent || COLORS.p2;
  fillRoundRect(ctx, ibx, iby, is, is, 9, withAlpha(accent, 0.14));
  drawIcon(ctx, b.icon, ibx + is / 2, iby + is / 2, is * 0.6, accent);

  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 14px -apple-system, "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(b.label, ibx + is + 11, b.y + b.h / 2 + 0.5);
  drawChevron(ctx, b.x + b.w - 20, b.y + b.h / 2, 9, COLORS.sub, 0.75);
  ctx.globalAlpha = 1;
}

/** 功能列表行（放在一张卡片里，行间细分割线） */
export function drawRowItem(ctx, b, { disabled = false } = {}) {
  ctx.globalAlpha = disabled ? 0.45 : 1;
  if (!b.first) {
    ctx.strokeStyle = 'rgba(255,255,255,.055)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(b.x + 18, b.y + 0.5);
    ctx.lineTo(b.x + b.w - 18, b.y + 0.5);
    ctx.stroke();
  }
  ctx.fillStyle = COLORS.text;
  ctx.font = '15px -apple-system, "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(b.label, b.x + 18, b.y + b.h / 2 + 0.5);

  const cy = b.y + b.h / 2;
  if (b.hint) {
    ctx.fillStyle = withAlpha(COLORS.sub, 0.85);
    ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(b.hint, b.x + b.w - 36, cy + 0.5);
  }
  drawChevron(ctx, b.x + b.w - 22, cy, 9, COLORS.sub, 0.6);
  ctx.globalAlpha = 1;
}

/** 列表卡片底板 */
export function drawListCard(ctx, r) {
  ctx.fillStyle = linearGradient(ctx, r.x, r.y, r.x, r.y + r.h,
    [[0, '#161c27'], [1, '#131822']], '#151a24');
  roundRectPath(ctx, r.x, r.y, r.w, r.h, 18);
  ctx.fill();
  strokeRoundRect(ctx, r.x, r.y, r.w, r.h, 18, 'rgba(255,255,255,.065)', 1);
}
