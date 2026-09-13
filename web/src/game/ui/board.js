import { COLORS } from '../config.js';
import { edgeCount, edgeIdFromIndex, parseEdge, vOffset } from '../core/index.js';
import { fillRoundRect, roundRectPath } from './widgets.js';

const seatColor = (seat) => (seat === 1 ? COLORS.p1 : COLORS.p2);

/**
 * 棋盘视图：只负责画和命中检测，不含任何规则。
 */
export class BoardView {
  constructor() {
    this.box = { x: 0, y: 0, size: 0 };
    this.gap = 0;
    this.ox = 0;
    this.oy = 0;
    this.rows = 0;
    this.cols = 0;
  }

  /** 给定外框正方形区域，计算点阵布局 */
  layout(box, rows, cols) {
    this.box = box;
    this.rows = rows;
    this.cols = cols;
    const pad = 14;
    const inner = box.size - pad * 2;
    this.gap = Math.floor(inner / Math.max(rows, cols));
    const w = this.gap * cols;
    const h = this.gap * rows;
    this.ox = Math.round(box.x + (box.size - w) / 2);
    this.oy = Math.round(box.y + (box.size - h) / 2);
    return this;
  }

  px(r, c) {
    return [this.ox + c * this.gap, this.oy + r * this.gap];
  }

  edgeSegment(id) {
    const p = parseEdge(id);
    if (!p) return null;
    const [x1, y1] = this.px(p.r, p.c);
    const [x2, y2] = p.kind === 'h' ? this.px(p.r, p.c + 1) : this.px(p.r + 1, p.c);
    return [x1, y1, x2, y2];
  }

  render(ctx, state, { lastEdge = null, interactive = true } = {}) {
    if (!state) return;
    if (state.rows !== this.rows || state.cols !== this.cols) {
      this.layout(this.box, state.rows, state.cols);
    }
    const { gap } = this;

    // 底板
    fillRoundRect(ctx, this.box.x, this.box.y, this.box.size, this.box.size, 18, COLORS.panel);

    // 格子归属
    for (let b = 0; b < state.rows * state.cols; b++) {
      const owner = state.owner[b];
      if (owner === '0') continue;
      const r = Math.floor(b / state.cols);
      const c = b % state.cols;
      const [x, y] = this.px(r, c);
      ctx.globalAlpha = 0.22;
      fillRoundRect(ctx, x + 2, y + 2, gap - 4, gap - 4, 6, seatColor(Number(owner)));
      ctx.globalAlpha = 1;
      ctx.fillStyle = seatColor(Number(owner));
      ctx.font = `${Math.round(gap * 0.34)}px -apple-system, "PingFang SC", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(owner === '1' ? '红' : '蓝', x + gap / 2, y + gap / 2);
    }

    // 边
    const total = edgeCount(state.rows, state.cols);
    for (let i = 0; i < total; i++) {
      const id = edgeIdFromIndex(i, state.rows, state.cols);
      const seg = this.edgeSegment(id);
      if (!seg) continue;
      const [x1, y1, x2, y2] = seg;
      const filled = state.edges[i] === '1';
      const owner = filled ? (state.moves.find((m) => m.edge === id)?.by ?? 1) : 0;

      ctx.lineCap = 'round';
      if (filled) {
        ctx.strokeStyle = seatColor(owner);
        ctx.lineWidth = Math.max(5, gap * 0.13);
      } else {
        ctx.strokeStyle = interactive ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.08)';
        ctx.lineWidth = Math.max(6, gap * 0.17);
      }
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // 最后一步高亮
    if (lastEdge) {
      const seg = this.edgeSegment(lastEdge);
      if (seg) {
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.lineWidth = Math.max(2, gap * 0.05);
        ctx.beginPath();
        ctx.moveTo(seg[0], seg[1]);
        ctx.lineTo(seg[2], seg[3]);
        ctx.stroke();
      }
    }

    // 点
    ctx.fillStyle = '#8b94a7';
    for (let r = 0; r <= state.rows; r++) {
      for (let c = 0; c <= state.cols; c++) {
        const [x, y] = this.px(r, c);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(3, gap * 0.075), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 外框提示（可落子时）
    if (interactive) {
      ctx.strokeStyle = COLORS.line;
      roundRectPath(ctx, this.box.x, this.box.y, this.box.size, this.box.size, 18);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /** 返回离触点最近的空闲边；超出阈值返回 null */
  hitTest(x, y, state) {
    if (!state) return null;
    const total = edgeCount(state.rows, state.cols);
    let best = null;
    let bestD = this.gap * 0.34;
    for (let i = 0; i < total; i++) {
      if (state.edges[i] === '1') continue;
      const id = edgeIdFromIndex(i, state.rows, state.cols);
      const seg = this.edgeSegment(id);
      if (!seg) continue;
      const d = distToSegment(x, y, seg[0], seg[1], seg[2], seg[3]);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export { vOffset };
