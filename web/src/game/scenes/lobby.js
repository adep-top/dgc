/**
 * 大厅房间列表场景：展示所有「等待对手」的公开房间，点击即可加入与陌生人开战。
 * 支持上下滚动、下拉刷新、每 15 秒自动刷新。
 */
import { COLORS } from '../config.js';
import * as api from '../net/api.js';
import { drawText, fillRoundRect, strokeRoundRect, inRect } from '../ui/widgets.js';
import { sound } from '../sound.js';

const REFRESH_MS = 15000;
const ROW_H = 84;
const ROW_GAP = 10;
const PULL_THRESHOLD = 60;
const PULL_MAX = 80;
const PULL_REFRESH_H = 50;

function fmtAge(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

const hostName = (r) => r.hostNick || `玩家${r.roomId.slice(-4)}`;

export class LobbyScene {
  constructor(app) {
    this.app = app;
    this.rooms = [];
    this.loading = true;
    this.error = null;
    this.scrollY = 0;
    this.drag = null;
    this.pending = null;
    this.timer = null;
    // 下拉刷新状态
    this.pull = { state: 'idle', distance: 0, pulling: false };
    this.refreshNow();
    this.timer = setInterval(() => this.refreshNow(true), REFRESH_MS);
  }

  layout(W, H) {
    this.back = { id: 'back', x: 14, y: 46, w: 76, h: 36 };
    this.listTop = 112;
    this.listBottom = H - 56;
    const contentH = this.rooms.length * (ROW_H + ROW_GAP) - ROW_GAP;
    this.maxScroll = Math.max(0, contentH - (this.listBottom - this.listTop));
    this.scrollY = Math.min(this.scrollY, this.maxScroll);
  }

  async refreshNow(silent = false) {
    if (!silent) { this.loading = true; this.error = null; }
    try {
      const data = await api.listRooms();
      this.rooms = (data && data.rooms) || [];
      this.error = null;
    } catch (e) {
      if (!silent) this.error = e.message;
    } finally {
      if (!silent) {
        this.loading = false;
        this.pull.state = 'idle';
        this.pull.distance = 0;
      }
    }
  }

  pullOffset() {
    if (this.pull.state === 'refreshing') return PULL_REFRESH_H;
    return Math.min(this.pull.distance, PULL_MAX);
  }

  render(ctx, W, H) {
    this.layout(W, H);

    // 标题（完全居中）
    drawText(ctx, '房间列表', W / 2, 64, { size: 20, bold: true, align: 'center', baseline: 'middle', color: COLORS.text });

    // 返回
    fillRoundRect(ctx, this.back.x, this.back.y, this.back.w, this.back.h, 12, COLORS.panel);
    strokeRoundRect(ctx, this.back.x, this.back.y, this.back.w, this.back.h, 12, COLORS.line, 1);
    drawText(ctx, '‹ 返回', this.back.x + this.back.w / 2, this.back.y + this.back.h / 2 + 1, {
      size: 14, color: COLORS.text, align: 'center', baseline: 'middle',
    });

    const stats = `共 ${this.rooms.length} 个房间等待对手 · 每 15 秒自动刷新`;
    drawText(ctx, stats, W / 2, this.listTop - 20, { size: 12, color: COLORS.sub, align: 'center', baseline: 'middle' });

    const offset = this.pullOffset();

    // 列表
    const viewH = this.listBottom - this.listTop;
    const visible = Math.ceil(viewH / (ROW_H + ROW_GAP)) + 1;
    const clipTop = this.listTop;
    const clipBottom = this.listBottom;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, clipTop, W, clipBottom - clipTop);
    ctx.clip();

    // 下拉刷新指示器
    if (offset > 0) {
      const indY = this.listTop + offset - PULL_REFRESH_H;
      const label = this.pull.state === 'refreshing' ? '加载中…'
        : this.pull.state === 'ready' ? '松开刷新'
        : '下拉刷新';
      const labelColor = this.pull.state === 'ready' ? COLORS.win : COLORS.sub;
      if (this.pull.state === 'refreshing') {
        const t = Date.now() / 300;
        ctx.save();
        ctx.translate(W / 2 - 40, indY + PULL_REFRESH_H / 2);
        ctx.rotate(t);
        ctx.fillStyle = COLORS.sub;
        ctx.beginPath();
        ctx.arc(0, 0, 5, 0, Math.PI * 1.5);
        ctx.lineTo(0, 0);
        ctx.fill();
        ctx.restore();
      } else {
        const arrowUp = this.pull.state === 'ready';
        ctx.save();
        ctx.translate(W / 2 - 40, indY + PULL_REFRESH_H / 2);
        if (arrowUp) ctx.rotate(Math.PI);
        ctx.fillStyle = labelColor;
        ctx.beginPath();
        ctx.moveTo(0, -5);
        ctx.lineTo(5, 3);
        ctx.lineTo(-5, 3);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      drawText(ctx, label, W / 2 + 8, indY + PULL_REFRESH_H / 2 + 1, {
        size: 13, color: labelColor, align: 'left', baseline: 'middle',
      });
    }

    for (let i = 0; i < Math.min(visible, this.rooms.length); i++) {
      const r = this.rooms[i];
      const y = this.listTop + i * (ROW_H + ROW_GAP) - this.scrollY + offset;
      if (y + ROW_H < clipTop || y > clipBottom) continue;
      fillRoundRect(ctx, 20, y, W - 40, ROW_H, 14, COLORS.panel);
      strokeRoundRect(ctx, 20, y, W - 40, ROW_H, 14, COLORS.line, 1);

      // 左上：等待中状态点 + 房号
      ctx.fillStyle = COLORS.win;
      ctx.beginPath();
      ctx.arc(46, y + 28, 3.5, 0, Math.PI * 2);
      ctx.fill();
      drawText(ctx, r.roomId, 58, y + 28, { size: 17, bold: true, color: COLORS.text, baseline: 'middle' });

      // 左下：规格 · 房主
      drawText(ctx, `${r.rows}×${r.cols} · 房主 ${hostName(r)}`, 38, y + 58, {
        size: 13, color: COLORS.sub, baseline: 'middle',
      });

      // 加入按钮（垂直居中，右侧）
      fillRoundRect(ctx, W - 128, y + ROW_H / 2 - 17, 88, 34, 12, COLORS.accent);
      drawText(ctx, '加入', W - 84, y + ROW_H / 2 + 1, {
        size: 14, color: '#ffffff', align: 'center', baseline: 'middle', bold: true,
      });

      // 右下：创建时间（避开按钮所在的中线区域，与规格行同行右对齐）
      drawText(ctx, fmtAge(r.createdAt), W - 142, y + 58, {
        size: 12, color: COLORS.sub, align: 'right', baseline: 'middle',
      });
    }
    ctx.restore();

    // 空 / 错误 / 加载态（跟随下拉偏移）
    const cx = W / 2;
    const midY = (this.listTop + this.listBottom) / 2 + offset;
    if (this.loading && !this.rooms.length && this.pull.state !== 'refreshing') {
      drawText(ctx, '加载中…', cx, midY, { size: 15, color: COLORS.sub, align: 'center', baseline: 'middle' });
    } else if (this.error && !this.rooms.length) {
      drawText(ctx, '加载失败，下拉刷新重试', cx, midY, { size: 14, color: COLORS.sub, align: 'center', baseline: 'middle' });
    } else if (!this.rooms.length) {
      drawText(ctx, '暂无等待中的房间', cx, midY - 14, { size: 16, color: COLORS.text, align: 'center', baseline: 'middle' });
      drawText(ctx, '点首页「快速匹配」或「创建房间」，等陌生人上门', cx, midY + 16, { size: 12, color: COLORS.sub, align: 'center', baseline: 'middle' });
    }

    drawText(ctx, '点击房间加入对战', W / 2, H - 28, { size: 12, color: COLORS.sub, align: 'center', baseline: 'middle' });
  }

  rowIndexAt(y) {
    const offset = this.pullOffset();
    return Math.floor((y - this.listTop + this.scrollY - offset) / (ROW_H + ROW_GAP));
  }

  onTouchStart(x, y) {
    if (!this.back) return;
    if (inRect(this.back, x, y)) {
      sound.tap();
      this.app.goHome();
      return;
    }
    const idx = this.rowIndexAt(y);
    this.pending = (idx >= 0 && idx < this.rooms.length) ? this.rooms[idx].roomId : null;
    this.drag = { startY: y, startScroll: this.scrollY, moved: false };
    this.pull.pulling = false;
  }

  onTouchMove(x, y) {
    if (!this.drag) return;
    const dy = y - this.drag.startY;
    if (Math.abs(dy) > 8) {
      this.drag.moved = true;
      this.pending = null;
    }

    if (!this.pull.pulling && this.drag.startScroll === 0 && dy > 0 && this.pull.state !== 'refreshing') {
      this.pull.pulling = true;
    }

    if (this.pull.pulling) {
      if (dy > 0) {
        this.pull.distance = dy * 0.5;
        this.pull.state = this.pull.distance >= PULL_THRESHOLD ? 'ready' : 'pulling';
      } else {
        this.pull.pulling = false;
        this.pull.distance = 0;
        this.pull.state = 'idle';
        this.scrollY = Math.max(0, Math.min(this.maxScroll, -dy));
      }
      return;
    }

    if (this.drag.moved) {
      this.scrollY = Math.max(0, Math.min(this.maxScroll, this.drag.startScroll - dy));
    }
  }

  onTouchEnd() {
    if (this.pull.pulling) {
      if (this.pull.state === 'ready') {
        this.pull.state = 'refreshing';
        this.pull.distance = PULL_REFRESH_H;
        this.refreshNow(false);
      } else {
        this.pull.state = 'idle';
        this.pull.distance = 0;
      }
      this.pull.pulling = false;
    }

    if (!this.drag) return;
    const roomId = this.pending;
    this.drag = null;
    this.pending = null;
    if (!roomId) return;
    sound.tap();
    this.app.enterRoom(roomId).then((ok) => {
      if (!ok) this.refreshNow(true);
    });
  }

  destroy() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
