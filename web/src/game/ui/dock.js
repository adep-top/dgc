/**
 * 对局页 / 复盘页底部操作区（Dock）。
 *
 * 设计要点（对应 docs/对战界面改版设计.md 第五节）：
 *  1. 单一容器：所有操作收进一个带阴影的面板，用"容器"而非散点表达"这是一组操作"；
 *  2. 三组分隔：社交 │ 对局 │ 危险，组间 1px 竖线，组内等分剩余宽度；
 *  3. 尺寸由内容反推：标签经 fitLabel 反算字号，任何机型下都不越出按钮边界；
 *  4. 三档断点：<375 通栏 56 竖排、375–767 通栏 64 横排、≥768 右侧竖排 Rail。
 *
 * 本文件只负责「布局计算 + 绘制」，不碰任何业务语义：
 * 按钮分组由各场景（GameScene / ReplayScene）根据自己的会话状态组装后传入。
 */
import { COLORS } from '../config.js';
import {
  fillRoundRect, strokeRoundRect, linearGradient, withAlpha,
  fitLabel, drawText,
} from './widgets.js';

export const WIDE_BP = 768;   // ≥ 该宽度走右侧 Rail
export const NARROW_BP = 375; // < 该宽度走小屏紧凑规格

/** 当前宽度对应的 Dock 规格 */
export function dockSpec(W) {
  const narrow = W < NARROW_BP;
  const dockH = narrow ? 56 : 64;
  const inner = 8;
  const btnH = dockH - inner * 2;          // 小屏 40 / 常规 48
  return {
    narrow,
    rail: W >= WIDE_BP,
    pad: narrow ? 8 : 12,          // Dock 距屏幕左右边距
    dockH,
    radius: narrow ? 16 : 20,
    inner,                         // 容器内边距
    btnRadius: narrow ? 12 : 14,
    sepW: 13,                      // 1px 分隔线 + 左右各 6pt 留白
    stack: narrow,                 // 小屏：图标在上、文字在下
    gap: 6,                        // 图标与文字的间距
    fontSize: narrow ? 12 : 15,
    iconSize: narrow ? 17 : 19,
    maxBtnW: 132,                  // 只有 1–2 个按钮时不让它拉成一条长条
    minBtnW: 56,                   // 最小触控目标
    // 视觉高之外上下各外扩的命中区：补齐到 56pt 最小触控目标
    // （小屏 40 → 8、常规 48 → 4；外扩范围仍落在 Dock 容器内，不会侵入棋盘）
    touchPad: Math.max(2, (56 - btnH) / 2),
    railW: 96,
    railBtnH: 64,
  };
}

/**
 * 计算 Dock 与其内部按钮的位置。
 *
 * @param {number} W 逻辑宽度
 * @param {number} H 逻辑高度
 * @param {Array<Array<object>>} groups 分组按钮，每个按钮 { id, label, icon, kind, disabled, badge, spinner }
 * @param {object} opts { safeBottom }
 * @returns {null|{ dock, buttons, rail, spec }}
 */
export function layoutDock(W, H, groups, { safeBottom = 0 } = {}) {
  const spec = dockSpec(W);
  const flat = groups.filter((g) => g && g.length).reduce((a, g) => a.concat(g), []);
  if (!flat.length) return null;

  const clean = groups.filter((g) => g && g.length);

  if (spec.rail) return layoutRail(W, H, clean, spec);

  const { pad, dockH, inner, sepW } = spec;
  const dockX = pad;
  const dockY = H - safeBottom - 12 - dockH;
  const dock = { x: dockX, y: dockY, w: W - pad * 2, h: dockH };

  const avail = dock.w - inner * 2 - (clean.length - 1) * sepW;
  let bw = avail / flat.length;
  let leading = 0;
  if (bw > spec.maxBtnW) {
    // 按钮数量少时把剩余宽度平摊到两侧，整排居中而不是贴左
    bw = spec.maxBtnW;
    leading = (avail - bw * flat.length) / 2;
  }

  const btnY = dockY + inner;
  const btnH = dockH - inner * 2;
  const buttons = [];
  let x = dockX + inner + leading;
  clean.forEach((g, gi) => {
    if (gi > 0) x += sepW;
    for (const it of g) {
      buttons.push({
        ...it,
        x,
        y: btnY,
        w: bw,
        h: btnH,
        radius: spec.btnRadius,
        fontSize: spec.fontSize,
        stack: spec.stack,
      });
      x += bw;
    }
  });

  return { dock, buttons, rail: false, spec, groups: clean };
}

/** 平板 / 桌面：Dock 折成右侧竖排 Rail，垂直居中 */
function layoutRail(W, H, groups, spec) {
  const { railW, railBtnH, inner, sepW } = spec;
  const total = inner * 2 + groups.reduce((a, g) => a + g.length, 0) * railBtnH
    + (groups.length - 1) * sepW;
  const dock = {
    x: W - railW - 16,
    y: Math.max(16, Math.round((H - total) / 2)),
    w: railW,
    h: total,
  };

  const buttons = [];
  let y = dock.y + inner;
  groups.forEach((g, gi) => {
    if (gi > 0) y += sepW;
    for (const it of g) {
      buttons.push({
        ...it,
        x: dock.x,
        y,
        w: railW,
        h: railBtnH,
        radius: spec.btnRadius,
        fontSize: 12,
        stack: true,
      });
      y += railBtnH;
    }
  });

  return { dock, buttons, rail: true, spec, groups };
}

/** 命中测试：视觉高之外上下各外扩 touchPad（满足 ≥56pt 触控目标） */
export function hitDock(layout, x, y) {
  if (!layout) return null;
  const padY = layout.spec.touchPad;
  for (const b of layout.buttons) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y - padY && y <= b.y + b.h + padY) return b;
  }
  return null;
}

/* ---------------- 绘制 ---------------- */

/**
 * 绘制整个 Dock。
 * @param {object} layout layoutDock 的返回值
 * @param {object} opts { pressedId, badgeIds }
 */
export function drawDock(ctx, layout, { pressedId = null, badgeIds = [] } = {}) {
  if (!layout) return;
  const { dock, groups, spec } = layout;

  // 容器：阴影让它从棋盘背景里"浮起"（这是原来完全缺失的一层）
  ctx.save();
  ctx.shadowColor = COLORS.dockShadow;
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 8;
  fillRoundRect(ctx, dock.x, dock.y, dock.w, dock.h, spec.radius,
    linearGradient(ctx, dock.x, dock.y, dock.x, dock.y + dock.h,
      [[0, COLORS.dockTop], [1, COLORS.dockBottom]], COLORS.panel));
  ctx.restore();
  strokeRoundRect(ctx, dock.x, dock.y, dock.w, dock.h, spec.radius, COLORS.dockStroke, 1);

  // 组间分隔线：直接由每组首个按钮的坐标反推，避免累加误差
  const sepInset = spec.rail ? 14 : 13;
  let idx = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    if (gi > 0) {
      const first = layout.buttons[idx];
      if (first) {
        if (spec.rail) {
          fillRoundRect(ctx, dock.x + sepInset, first.y - spec.sepW / 2 - 0.5,
            dock.w - sepInset * 2, 1, 0.5, COLORS.dockDivider);
        } else {
          fillRoundRect(ctx, first.x - spec.sepW / 2 - 0.5, dock.y + sepInset,
            1, dock.h - sepInset * 2, 0.5, COLORS.dockDivider);
        }
      }
    }
    idx += groups[gi].length;
  }

  for (const b of layout.buttons) {
    drawDockButton(ctx, b, { pressed: b.id === pressedId, badge: badgeIds.indexOf(b.id) >= 0 });
  }
}

/** 单个 Dock 按钮：常规 / danger / primary / disabled / 按下 + 图标 + 徽标 */
function drawDockButton(ctx, b, { pressed = false, badge = false } = {}) {
  const kind = b.kind || 'ghost';
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;

  ctx.save();
  if (b.disabled) ctx.globalAlpha = 0.38;
  if (pressed && !b.disabled) {
    ctx.translate(cx, cy);
    ctx.scale(0.94, 0.94);
    ctx.translate(-cx, -cy);
  }

  if (kind === 'danger') {
    // 透明底 + 1px 红描边：危险靠边界感提示，不靠发光
    strokeRoundRect(ctx, b.x, b.y, b.w, b.h, b.radius, COLORS.dangerStroke, 1);
  } else if (kind === 'primary') {
    ctx.save();
    ctx.shadowColor = 'rgba(47,111,235,.4)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
    fillRoundRect(ctx, b.x, b.y, b.w, b.h, b.radius,
      linearGradient(ctx, b.x, b.y, b.x, b.y + b.h,
        [[0, COLORS.primaryTop], [1, COLORS.primaryBottom]], COLORS.accent));
    ctx.restore();
    strokeRoundRect(ctx, b.x, b.y, b.w, b.h, b.radius, 'rgba(255,255,255,.18)', 1);
  }
  if (pressed && !b.disabled) {
    fillRoundRect(ctx, b.x, b.y, b.w, b.h, b.radius, COLORS.btnPressed);
    strokeRoundRect(ctx, b.x, b.y, b.w, b.h, b.radius, COLORS.btnPressedStroke, 1);
  }

  const textColor = kind === 'primary' ? '#ffffff'
    : kind === 'danger' ? COLORS.dangerText
      : COLORS.text;
  const iconColor = kind === 'primary' ? '#ffffff'
    : kind === 'danger' ? COLORS.dangerText
      : COLORS.iconMuted;

  const iconSize = b.stack ? b.fontSize + 5 : 19;
  const gap = b.stack ? 4 : 7;
  // 转圈占用图标位（标准的"进行中"表现）。
  // 横向布局下换成更小的占位（13 而非 19），否则 64.8pt 的按钮里「求和」会被压到截断。
  const spinAsIcon = b.spinner && b.icon;
  let iconSlot;
  let iconGap;
  let spinW;
  if (b.stack) {
    iconSlot = b.icon ? iconSize : 0; iconGap = 0; spinW = 0;
  } else if (spinAsIcon) {
    iconSlot = 13; iconGap = 5; spinW = 0;
  } else {
    iconSlot = b.icon ? iconSize : 0;
    iconGap = iconSlot ? gap : 0;
    spinW = b.spinner ? 18 : 0;
  }
  // 文字可用宽 = 按钮宽 − 两侧安全边距 − 图标占位 − 转圈占位
  const availText = b.w - 16 - (iconSlot ? iconSlot + iconGap : 0) - spinW;
  const fit = b.label ? fitLabel(ctx, b.label, availText, { max: b.fontSize, min: 10, bold: false }) : null;

  if (b.stack) {
    if (spinAsIcon) drawSpinner(ctx, cx, cy - 8, 6.5);
    else if (b.icon) drawDockIcon(ctx, b.icon, cx, cy - 8, iconSize, iconColor);
    if (fit) {
      drawText(ctx, fit.text, cx, cy + 13, {
        size: fit.size, color: textColor, align: 'center', baseline: 'middle',
      });
    }
  } else if (fit) {
    ctx.font = `${fit.size}px -apple-system, "PingFang SC", sans-serif`;
    const tw = ctx.measureText(fit.text).width;
    const total = (iconSlot ? iconSlot + iconGap : 0) + tw + spinW;
    const startX = cx - total / 2;
    if (spinAsIcon) drawSpinner(ctx, startX + iconSlot / 2, cy, 5.5);
    else if (b.icon) drawDockIcon(ctx, b.icon, startX + iconSize / 2, cy, iconSize, iconColor);
    drawText(ctx, fit.text, startX + (iconSlot ? iconSlot + iconGap : 0), cy + 0.5, {
      size: fit.size, color: textColor, align: 'left', baseline: 'middle',
    });
    if (spinW) drawSpinner(ctx, startX + total - 5, cy, 6);
  } else {
    const cxo = b.spinner ? cx - 9 : cx;
    if (spinAsIcon) drawSpinner(ctx, cxo, cy, 5.5);
    else if (b.icon) drawDockIcon(ctx, b.icon, cxo, cy, iconSize, iconColor);
    if (b.spinner && !spinAsIcon) drawSpinner(ctx, cx + 9, cy, 6);
  }

  // 小屏竖排且没有图标时：转圈贴右上角，不参与文字排版
  if (b.spinner && !spinAsIcon && b.stack) drawSpinner(ctx, b.x + b.w - 13, b.y + 13, 5.5);

  // 未读小红点：贴在按钮右上角，避免压住图标或文字
  if (badge) {
    ctx.fillStyle = '#ff4d4f';
    ctx.beginPath();
    ctx.arc(b.x + b.w - 12, b.y + 9, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* ---------------- 图标 ---------------- */

/** 等待中的小转圈（异步动作进行中，如求和请求已发出） */
function drawSpinner(ctx, cx, cy, r = 6) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = withAlpha(COLORS.text, 0.25);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = COLORS.text;
  ctx.beginPath();
  const t = ((Date.now() % 900) / 900) * Math.PI * 2;
  ctx.arc(cx, cy, r, t, t + Math.PI * 0.6);
  ctx.stroke();
  ctx.restore();
}

/*
 * 统一 19×19 视觉尺寸、1.6 线宽、round 线帽；颜色跟随按钮文字色。
 * 一律用带面积的矩形 / 非直线路径，避免部分渲染器对退化几何的处理差异。
 */
export function drawDockIcon(ctx, name, cx, cy, size, color) {
  const s = size;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.3, s * 0.085);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (name) {
    case 'back': {
      // 左上角返回：一段折线（非共线，安全）
      ctx.beginPath();
      ctx.moveTo(cx + s * 0.16, cy - s * 0.28);
      ctx.lineTo(cx - s * 0.16, cy);
      ctx.lineTo(cx + s * 0.16, cy + s * 0.28);
      ctx.stroke();
      break;
    }
    case 'chat': {
      // 圆角气泡 + 左下尾巴
      const w = s * 0.82;
      const h = s * 0.66;
      strokeRoundRect(ctx, cx - w / 2, cy - h * 0.72, w, h, s * 0.20, color, ctx.lineWidth);
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.24, cy - h * 0.06);
      ctx.lineTo(cx - w * 0.34, cy + s * 0.28);
      ctx.lineTo(cx - w * 0.02, cy - h * 0.06);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'invite': {
      // 圆角方框 + 加号
      const r = s * 0.34;
      strokeRoundRect(ctx, cx - r, cy - r, r * 2, r * 2, s * 0.13, color, ctx.lineWidth);
      const t = Math.max(1.6, s * 0.11);
      fillRoundRect(ctx, cx - s * 0.15, cy - t / 2, s * 0.30, t, t / 2, color);
      fillRoundRect(ctx, cx - t / 2, cy - s * 0.15, t, s * 0.30, t / 2, color);
      break;
    }
    case 'copy': {
      // 两张叠放的纸
      const w = s * 0.54;
      const h = s * 0.60;
      strokeRoundRect(ctx, cx - s * 0.38, cy - s * 0.40, w, h, s * 0.10, color, ctx.lineWidth);
      strokeRoundRect(ctx, cx - s * 0.16, cy - s * 0.18, w, h, s * 0.10, color, ctx.lineWidth);
      break;
    }
    case 'undo': {
      // 回退箭头：一段跨过顶部的圆弧 + 左端向下的三角箭头
      const r = s * 0.30;
      const cyo = cy + s * 0.04;
      ctx.beginPath();
      ctx.arc(cx, cyo, r, Math.PI * 1.0, Math.PI * 1.98);
      ctx.stroke();
      const ax = cx - r;
      const ay = cyo;
      ctx.beginPath();
      ctx.moveTo(ax - s * 0.12, ay - s * 0.06);
      ctx.lineTo(ax + s * 0.12, ay + s * 0.02);
      ctx.lineTo(ax - s * 0.01, ay + s * 0.19);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'draw': {
      // 求和：等号（棋界通用的和棋符号）。
      // 特意不再用"两个叠放圆角矩形"——那和复制按钮的图标撞形，同屏无法区分。
      const w = s * 0.62;
      const h = Math.max(2.2, s * 0.15);
      fillRoundRect(ctx, cx - w / 2, cy - s * 0.17 - h / 2, w, h, h / 2, color);
      fillRoundRect(ctx, cx - w / 2, cy + s * 0.17 - h / 2, w, h, h / 2, color);
      break;
    }
    case 'flag': {
      // 白旗：细旗杆 + 三角旗面
      fillRoundRect(ctx, cx - s * 0.30, cy - s * 0.46, Math.max(1.8, s * 0.11), s * 0.92, s * 0.06, color);
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.19, cy - s * 0.44);
      ctx.lineTo(cx + s * 0.40, cy - s * 0.27);
      ctx.lineTo(cx - s * 0.19, cy - s * 0.08);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'skipStart': {
      fillRoundRect(ctx, cx - s * 0.42, cy - s * 0.30, Math.max(1.8, s * 0.10), s * 0.60, s * 0.05, color);
      ctx.beginPath();
      ctx.moveTo(cx + s * 0.36, cy - s * 0.28);
      ctx.lineTo(cx - s * 0.22, cy);
      ctx.lineTo(cx + s * 0.36, cy + s * 0.28);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'skipEnd': {
      fillRoundRect(ctx, cx + s * 0.32, cy - s * 0.30, Math.max(1.8, s * 0.10), s * 0.60, s * 0.05, color);
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.36, cy - s * 0.28);
      ctx.lineTo(cx + s * 0.22, cy);
      ctx.lineTo(cx - s * 0.36, cy + s * 0.28);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'prev': {
      ctx.beginPath();
      ctx.moveTo(cx + s * 0.26, cy - s * 0.30);
      ctx.lineTo(cx - s * 0.30, cy);
      ctx.lineTo(cx + s * 0.26, cy + s * 0.30);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'next':
    case 'play': {
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.24, cy - s * 0.32);
      ctx.lineTo(cx + s * 0.34, cy);
      ctx.lineTo(cx - s * 0.24, cy + s * 0.32);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'pause': {
      const w = Math.max(2.4, s * 0.20);
      fillRoundRect(ctx, cx - w * 1.45, cy - s * 0.32, w, s * 0.64, w * 0.35, color);
      fillRoundRect(ctx, cx + w * 0.45, cy - s * 0.32, w, s * 0.64, w * 0.35, color);
      break;
    }
    default:
      break;
  }
  ctx.restore();
}
