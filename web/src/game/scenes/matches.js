/**
 * 战绩列表场景：展示当前用户的历史对局，点击任意一条进入复盘。
 * 数据来自 GET /v1/matches（api.getMatches），按终局时间倒序。
 * 支持下拉刷新。
 */
import { COLORS } from '../config.js';
import * as api from '../net/api.js';
import { drawText, fillRoundRect, strokeRoundRect, inRect } from '../ui/widgets.js';
import { sound } from '../sound.js';

const ROW_H = 72;
const ROW_GAP = 10;
const PULL_THRESHOLD = 60;   // 下拉触发刷新的阈值（px）
const PULL_MAX = 80;         // 下拉最大视觉偏移
const PULL_REFRESH_H = 50;   // 刷新中保持的偏移高度

/** 友好时间格式：今天 HH:mm / 昨天 / MM-DD（跨年附年份） */
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = startOfDay(now);
  const that = startOfDay(d);
  const pad = (n) => String(n).padStart(2, '0');
  if (that === today) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (that === today - 86400000) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本局对当前用户的结果：'win' | 'lose' | 'draw' */
function resultOf(m) {
  if (m.winner === 3) return 'draw';
  return m.winner === m.mySeat ? 'win' : 'lose';
}

const RESULT_LABEL = { win: '胜', lose: '负', draw: '平' };
const RESULT_COLOR = { win: COLORS.win, lose: '#ff6b6b', draw: COLORS.sub };

export class MatchesScene {
  constructor(app) {
    this.app = app;
    this.matches = [];
    this.total = 0;
    this.loading = true;
    this.error = null;
    this.scrollY = 0;
    this.drag = null;
    // 下拉刷新状态：idle | pulling | ready | refreshing
    this.pull = { state: 'idle', distance: 0, pulling: false };
    this.refreshNow();
  }

  layout(W, H) {
    this.back = { id: 'back', x: 14, y: 46, w: 76, h: 36 };
    this.listTop = 112;
    this.listBottom = H - 40;
    this.listW = W - 40;
    const contentH = this.matches.length * (ROW_H + ROW_GAP) - ROW_GAP;
    this.maxScroll = Math.max(0, contentH - (this.listBottom - this.listTop));
    this.scrollY = Math.max(0, Math.min(this.maxScroll, this.scrollY));
  }

  async refreshNow() {
    this.loading = true;
    this.error = null;
    try {
      const data = await api.getMatches({ limit: 50, offset: 0 });
      this.matches = (data && data.matches) || [];
      this.total = (data && data.total) || 0;
      this.error = null;
    } catch (e) {
      this.error = e.message;
    } finally {
      this.loading = false;
      this.pull.state = 'idle';
      this.pull.distance = 0;
    }
  }

  /** 当前下拉产生的内容偏移量 */
  pullOffset() {
    if (this.pull.state === 'refreshing') return PULL_REFRESH_H;
    return Math.min(this.pull.distance, PULL_MAX);
  }

  render(ctx, W, H) {
    this.layout(W, H);

    // 标题（完全居中，右上角无按钮遮挡）
    drawText(ctx, '战绩', W / 2, 64, { size: 20, bold: true, align: 'center', baseline: 'middle', color: COLORS.text });

    // 返回
    fillRoundRect(ctx, this.back.x, this.back.y, this.back.w, this.back.h, 12, COLORS.panel);
    strokeRoundRect(ctx, this.back.x, this.back.y, this.back.w, this.back.h, 12, COLORS.line, 1);
    drawText(ctx, '‹ 返回', this.back.x + this.back.w / 2, this.back.y + this.back.h / 2 + 1, {
      size: 14, color: COLORS.text, align: 'center', baseline: 'middle',
    });

    // 统计小字
    drawText(ctx, `共 ${this.total} 场对局`, W / 2, this.listTop - 16, {
      size: 12, color: COLORS.sub, align: 'center', baseline: 'middle',
    });

    const offset = this.pullOffset();

    // 列表（裁剪 + 滚动 + 下拉偏移）
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
      // 简单的旋转箭头/圆点指示
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
        // 箭头：达到阈值时朝上，未达到时朝下
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

    for (let i = 0; i < this.matches.length; i++) {
      const m = this.matches[i];
      const y = this.listTop + i * (ROW_H + ROW_GAP) - this.scrollY + offset;
      if (y + ROW_H < clipTop || y > clipBottom) continue;
      this.renderRow(ctx, m, 20, y, W - 40);
    }
    ctx.restore();

    // 空 / 错误 / 加载态（跟随下拉偏移）
    const cx = W / 2;
    const midY = (this.listTop + this.listBottom) / 2 + offset;
    if (this.loading && !this.matches.length && this.pull.state !== 'refreshing') {
      drawText(ctx, '加载中…', cx, midY, { size: 15, color: COLORS.sub, align: 'center', baseline: 'middle' });
    } else if (this.error && !this.matches.length) {
      drawText(ctx, '加载失败，下拉刷新重试', cx, midY, { size: 14, color: COLORS.sub, align: 'center', baseline: 'middle' });
      // 真机上没有 console，把原因缩略后上屏是唯一的诊断出口（与首页状态胶囊同一套做法）
      drawText(ctx, String(this.error).slice(0, 42), cx, midY + 24, {
        size: 11, color: '#ff8f6b', align: 'center', baseline: 'middle',
      });
    } else if (!this.matches.length) {
      drawText(ctx, '暂无对战记录', cx, midY - 14, { size: 16, color: COLORS.text, align: 'center', baseline: 'middle' });
      drawText(ctx, '去打一局对战，战绩会自动记录在这里', cx, midY + 18, { size: 12, color: COLORS.sub, align: 'center', baseline: 'middle' });
    }
  }

  renderRow(ctx, m, x, y, w) {
    fillRoundRect(ctx, x, y, w, ROW_H, 14, COLORS.panel);
    strokeRoundRect(ctx, x, y, w, ROW_H, 14, COLORS.line, 1);

    const res = resultOf(m);
    const resColor = RESULT_COLOR[res];

    // 左：结果标识（胜/负/平）
    fillRoundRect(ctx, x + 12, y + ROW_H / 2 - 16, 40, 32, 8, resColor);
    drawText(ctx, RESULT_LABEL[res], x + 12 + 20, y + ROW_H / 2 + 1, {
      size: 16, bold: true, color: '#0f1218', align: 'center', baseline: 'middle',
    });

    // 中：对手昵称 + 棋盘尺寸
    drawText(ctx, m.opponentNick || '未知对手', x + 64, y + 26, {
      size: 16, bold: true, color: COLORS.text, baseline: 'middle',
    });
    drawText(ctx, `${m.rows}×${m.cols} · ${fmtTime(m.finishedAt)}`, x + 64, y + 50, {
      size: 12, color: COLORS.sub, baseline: 'middle',
    });

    // 右：比分
    drawText(ctx, `${m.score1}:${m.score2}`, x + w - 16, y + ROW_H / 2 + 1, {
      size: 22, bold: true, color: COLORS.text, align: 'right', baseline: 'middle',
    });
  }

  /* ---------------- 触摸 ---------------- */

  onTouchStart(x, y) {
    if (!this.back) return;
    if (inRect(this.back, x, y)) {
      sound.tap();
      this.app.goHome();
      return;
    }
    // 列表区：记录拖拽起点；若未移动则视为点击行
    this.drag = { startY: y, startX: x, startScroll: this.scrollY, moved: false, row: this.rowAt(y) };
    this.pull.pulling = false;
  }

  onTouchMove(x, y) {
    if (!this.drag) return;
    const dy = y - this.drag.startY;
    if (Math.abs(dy) > 8) this.drag.moved = true;

    // 进入下拉模式：在列表顶部且向下拉，且不在刷新中
    if (!this.pull.pulling && this.drag.startScroll === 0 && dy > 0 && this.pull.state !== 'refreshing') {
      this.pull.pulling = true;
    }

    if (this.pull.pulling) {
      if (dy > 0) {
        this.pull.distance = dy * 0.5; // 阻尼
        this.pull.state = this.pull.distance >= PULL_THRESHOLD ? 'ready' : 'pulling';
      } else {
        // 推回顶部以上，退出下拉模式，转为正常向上滚动
        this.pull.pulling = false;
        this.pull.distance = 0;
        this.pull.state = 'idle';
        this.scrollY = Math.max(0, Math.min(this.maxScroll, -dy));
      }
      return;
    }

    // 正常滚动
    if (this.drag.moved) {
      this.scrollY = Math.max(0, Math.min(this.maxScroll, this.drag.startScroll - dy));
    }
  }

  onTouchEnd(x, y) {
    // 下拉刷新触发
    if (this.pull.pulling) {
      if (this.pull.state === 'ready') {
        this.pull.state = 'refreshing';
        this.pull.distance = PULL_REFRESH_H;
        this.refreshNow();
      } else {
        this.pull.state = 'idle';
        this.pull.distance = 0;
      }
      this.pull.pulling = false;
    }

    if (this.drag && !this.drag.moved && this.drag.row) {
      const m = this.drag.row;
      sound.tap();
      this.app.goReplay(m.id);
    }
    this.drag = null;
  }

  /** 给定 y 坐标返回对应的战绩行（不在列表区或空白处返回 null） */
  rowAt(y) {
    if (y < this.listTop || y > this.listBottom) return null;
    const offset = this.pullOffset();
    const idx = Math.floor((y - this.listTop + this.scrollY - offset) / (ROW_H + ROW_GAP));
    if (idx < 0 || idx >= this.matches.length) return null;
    const rowY = this.listTop + idx * (ROW_H + ROW_GAP) - this.scrollY + offset;
    if (y < rowY || y > rowY + ROW_H) return null;
    return this.matches[idx];
  }
}
