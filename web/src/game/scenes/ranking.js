/**
 * 积分排行榜场景：三个 Tab
 *   全球 —— 服务端全局排行榜（api.getRanking()）
 *   好友 —— 微信开放数据域：wx.getFriendCloudStorage()
 *   群   —— 微信开放数据域：wx.getGroupCloudStorage()，需要从群卡片进入拿到 shareTicket
 *
 * 好友/群数据由开放数据域渲染到共享画布，本场景只负责 Tab 栏、
 * 列表区域背景，以及把共享画布 drawImage 到主画布上；触摸滚动时把 scrollY
 * 通过 postMessage 发给开放数据域重绘。
 * 支持下拉刷新。
 *
 * ── 版面基准线（改视觉先看这里）───────────────────────────────
 * 1) 所有块级元素左右都贴 PAD=20 这条线：返回按钮、Tab 分段控件、说明行、
 *    列表卡片。以前 back=14 / tab=20 / 卡片=20 各写一套，是"看着没对齐"的根因。
 * 2) 纵向顺序：标题中线 → Tab(高 36) → 说明行 → 列表 → 底部提示。
 *    说明行与 Tab 留 20px 呼吸，不再像以前那样直接压在 Tab 底边上。
 * 3) 顶部按 app.safeTop、底部按 app.safeBottom 让位（刘海 / Home Indicator），
 *    不再写死 64 / H-28。
 * 4) 行内两行文字（昵称 / 战绩）以行中线为轴上下各 12px，视觉重心居中。
 */
import { COLORS, CONFIG } from '../config.js';
import * as api from '../net/api.js';
import {
  drawText, fillRoundRect, strokeRoundRect, inRect, withAlpha, fitLabel,
} from '../ui/widgets.js';
import { sound } from '../sound.js';

const ROW_H = 76;
const ROW_GAP = 10;
const ROW_STEP = ROW_H + ROW_GAP;
const RANK_COLORS = ['#f5c542', '#c0c8d4', '#cd8f5a']; // 金 / 银 / 铜
const LOSE_COLOR = '#ff6b6b';
const RANK_BADGE = 30;        // 名次徽章边长（1~3 名有底，其余只有数字）
const PULL_THRESHOLD = 60;
const PULL_MAX = 80;
const PULL_REFRESH_H = 50;

/** 页面左右基准线：标题、Tab、说明行、列表卡片共用 */
const PAD = 20;

const TABS = [
  { id: 'global', label: '全球' },
  { id: 'friends', label: '好友' },
  { id: 'group', label: '群' },
];

const playerName = (p) => ((p.nick && p.nick.trim()) ? p.nick : `玩家${String(p.uid || '0000').slice(-4)}`);

export class RankingScene {
  constructor(app) {
    this.app = app;
    this.tab = 'global';
    this.ranking = [];
    this.loading = true;
    this.error = null;
    this.scrollY = 0;
    this.drag = null;
    this.shareTicket = (app && app.launchShareTicket) || '';
    // 下拉刷新状态
    this.pull = { state: 'idle', distance: 0, pulling: false };
    this._pullTimer = null;
    this.refreshNow();
  }

  /* ---------------- 开放数据域通信 ---------------- */

  openData() {
    try {
      if (typeof wx === 'undefined' || typeof wx.getOpenDataContext !== 'function') return null;
      return wx.getOpenDataContext();
    } catch (e) { return null; }
  }

  sharedCanvas() {
    try {
      if (typeof wx === 'undefined' || typeof wx.getSharedCanvas !== 'function') return null;
      return wx.getSharedCanvas();
    } catch (e) { return null; }
  }

  /** 自己的 uid（用于把「我」那一行高亮出来）；取不到返回空串 */
  myUid() {
    if (this._myUid === undefined) {
      try { this._myUid = api.getUid() || ''; } catch (e) { this._myUid = ''; }
    }
    return this._myUid;
  }

  pushOpenData(force) {
    const odc = this.openData();
    if (!odc || !this.listW) return;
    const base = { width: this.listW, height: this.listH, scrollY: this.scrollY, limit: 100 };
    if (this.tab === 'friends') {
      odc.postMessage(Object.assign({ type: 'friends', force: !!force }, base));
    } else if (this.tab === 'group') {
      if (!this.shareTicket) return;
      odc.postMessage(Object.assign({ type: 'group', shareTicket: this.shareTicket, force: !!force }, base));
    }
  }

  pushScrollOnly() {
    const odc = this.openData();
    if (!odc || !this.listW) return;
    odc.postMessage({
      type: this.tab,
      width: this.listW,
      height: this.listH,
      scrollY: this.scrollY,
      limit: 100,
    });
  }

  /* ---------------- 布局 ---------------- */

  layout(W, H) {
    const app = this.app || {};
    const safeTop = Math.max(0, Number(app.safeTop) || 20);
    const safeBottom = Math.max(0, Number(app.safeBottom) || 0);
    this.safeTop = safeTop;
    this.safeBottom = safeBottom;

    // 顶栏：标题与返回按钮共中线
    this.headerY = safeTop + 22;
    this.back = { id: 'back', x: PAD, y: this.headerY - 18, w: 74, h: 36 };

    // Tab：一个胶囊容器 + 一个选中滑块（内部按内边距 3 等分）
    const segInner = 3;
    const segH = 36;
    const segY = safeTop + 52;
    this.seg = { x: PAD, y: segY, w: W - PAD * 2, h: segH };
    const tabW = (this.seg.w - segInner * 2) / TABS.length;
    this.tabs = TABS.map((t, i) => ({
      ...t,
      x: this.seg.x + segInner + i * tabW,
      y: segY + segInner,
      w: tabW,
      h: segH - segInner * 2,
    }));

    // 说明行：左「共 N 位玩家」/ 右「胜 +10 · 平 +3 · 负 +0」，与 Tab 留 20px
    this.statsY = segY + segH + 20;
    this.listTop = this.statsY + 22;
    this.listBottom = H - safeBottom - 36;
    this.listW = W - PAD * 2;
    this.listH = this.listBottom - this.listTop;
    this.footerY = H - safeBottom - 16;

    this.shareBtn = null;
    if (this.tab === 'group' && !this.shareTicket) {
      this.shareBtn = {
        id: 'shareGroup',
        x: (W - 200) / 2, y: this.listTop + this.listH / 2 + 30,
        w: 200, h: 44,
      };
    }

    if (this.tab === 'global') {
      const contentH = this.ranking.length * ROW_STEP - ROW_GAP;
      this.maxScroll = Math.max(0, contentH - this.listH);
    } else {
      this.maxScroll = 100 * ROW_STEP;
    }
    this.scrollY = Math.max(0, Math.min(this.maxScroll, this.scrollY));
  }

  /* ---------------- 数据 ---------------- */

  async refreshNow() {
    if (this.tab !== 'global') {
      this.pushOpenData(true);
      // 开放数据域异步加载，用定时器模拟刷新完成反馈
      if (this._pullTimer) clearTimeout(this._pullTimer);
      this._pullTimer = setTimeout(() => {
        this.pull.state = 'idle';
        this.pull.distance = 0;
      }, 1200);
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const data = await api.getRanking();
      this.ranking = (data && data.ranking) || [];
      this.error = null;
    } catch (e) {
      this.error = e.message;
    } finally {
      this.loading = false;
      this.pull.state = 'idle';
      this.pull.distance = 0;
    }
  }

  switchTab(id) {
    if (this.tab === id) return;
    this.tab = id;
    this.scrollY = 0;
    this.pull.state = 'idle';
    this.pull.distance = 0;
    sound.tap();
    if (id === 'global') {
      if (!this.ranking.length) this.refreshNow();
    } else {
      this.pushOpenData(true);
    }
  }

  shareToGroup() {
    sound.tap();
    try {
      wx.shareAppMessage({ title: CONFIG.shareTitle.replace('{room}', '好友房') });
    } catch (e) { /* ignore */ }
  }

  pullOffset() {
    if (this.pull.state === 'refreshing') return PULL_REFRESH_H;
    return Math.min(this.pull.distance, PULL_MAX);
  }

  /** 绘制下拉刷新指示器（在裁剪区域内调用） */
  renderPullIndicator(ctx, W) {
    const offset = this.pullOffset();
    if (offset <= 0) return;
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

  /* ---------------- 渲染 ---------------- */

  render(ctx, W, H) {
    this.layout(W, H);

    this.renderHeader(ctx, W);
    this.renderTabs(ctx, W);

    if (this.tab === 'global') {
      this.renderStatsRow(ctx, W, `共 ${this.ranking.length} 位玩家`, '胜 +10 · 平 +3 · 负 +0');
      this.renderGlobalList(ctx, W, H);
    } else {
      this.renderStatsRow(ctx, W, this.tab === 'friends' ? '微信好友' : '群成员', '按积分排序');
      this.renderSocialList(ctx, W, H);
    }

    drawText(ctx, '下拉可刷新 · 每日更新', W / 2, this.footerY, {
      size: 11, color: withAlpha(COLORS.sub, 0.75), align: 'center', baseline: 'middle',
    });
  }

  /** 顶栏：返回胶囊（图标 + 文字）+ 居中标题 */
  renderHeader(ctx, W) {
    const b = this.back;
    const cy = b.y + b.h / 2;

    fillRoundRect(ctx, b.x, b.y, b.w, b.h, 12, COLORS.panel);
    strokeRoundRect(ctx, b.x, b.y, b.w, b.h, 12, COLORS.line, 1);

    // 左箭头：用 stroke 画折线，比「‹」字符在不同字体下的位置稳定
    ctx.save();
    ctx.strokeStyle = COLORS.text;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(b.x + 17, cy - 5);
    ctx.lineTo(b.x + 12, cy);
    ctx.lineTo(b.x + 17, cy + 5);
    ctx.stroke();
    ctx.restore();
    drawText(ctx, '返回', b.x + 25, cy + 1, {
      size: 14, color: COLORS.text, baseline: 'middle',
    });

    drawText(ctx, '排行榜', W / 2, this.headerY, {
      size: 20, bold: true, align: 'center', baseline: 'middle', color: COLORS.text,
    });
  }

  /** Tab：分段控件（容器 + 选中滑块），选中态用品牌蓝实心块 */
  renderTabs(ctx, W) {
    const s = this.seg;
    fillRoundRect(ctx, s.x, s.y, s.w, s.h, 12, withAlpha('#000000', 0.28));
    strokeRoundRect(ctx, s.x, s.y, s.w, s.h, 12, withAlpha('#ffffff', 0.05), 1);

    for (const t of this.tabs) {
      const active = this.tab === t.id;
      if (active) {
        ctx.save();
        ctx.shadowColor = withAlpha(COLORS.accent, 0.45);
        ctx.shadowBlur = 12;
        ctx.shadowOffsetY = 2;
        fillRoundRect(ctx, t.x, t.y, t.w, t.h, 9, COLORS.accent);
        ctx.restore();
        strokeRoundRect(ctx, t.x, t.y, t.w, t.h, 9, withAlpha('#ffffff', 0.18), 1);
      }
      drawText(ctx, t.label, t.x + t.w / 2, t.y + t.h / 2 + 1, {
        size: 14, bold: active, align: 'center', baseline: 'middle',
        color: active ? '#ffffff' : COLORS.sub,
      });
    }
  }

  /** 说明行：左右两端对齐到同一条基准线，压在 Tab 底边上的老问题在这里消失 */
  renderStatsRow(ctx, W, left, right) {
    const y = this.statsY;
    if (left) {
      drawText(ctx, left, PAD, y, { size: 12, color: COLORS.sub, baseline: 'middle' });
    }
    if (right) {
      drawText(ctx, right, W - PAD, y, {
        size: 12, color: COLORS.sub, align: 'right', baseline: 'middle',
      });
    }
  }

  /** 全球榜：本地绘制行 */
  renderGlobalList(ctx, W, H) {
    const offset = this.pullOffset();
    const clipTop = this.listTop;
    const clipBottom = this.listBottom;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, clipTop, W, clipBottom - clipTop);
    ctx.clip();

    this.renderPullIndicator(ctx, W);

    const viewH = clipBottom - clipTop;
    // 起点必须跟着 scrollY 走：以前固定从 0 开始画，滚动超过一屏后下半屏整片空白
    const first = Math.max(0, Math.floor((this.scrollY - offset) / ROW_STEP));
    const count = Math.ceil(viewH / ROW_STEP) + 2;
    const uid = this.myUid();
    for (let i = first; i < Math.min(first + count, this.ranking.length); i++) {
      const p = this.ranking[i];
      const y = clipTop + i * ROW_STEP - this.scrollY + offset;
      if (y + ROW_H < clipTop || y > clipBottom) continue;
      this.renderRow(ctx, p, i + 1, y, W, uid);
    }
    ctx.restore();

    // 空 / 错误 / 加载态（跟随下拉偏移）
    const cx = W / 2;
    const midY = (clipTop + clipBottom) / 2 + offset;
    if (this.loading && !this.ranking.length && this.pull.state !== 'refreshing') {
      drawText(ctx, '加载中…', cx, midY, { size: 15, color: COLORS.sub, align: 'center', baseline: 'middle' });
    } else if (this.error && !this.ranking.length) {
      drawText(ctx, '加载失败，下拉刷新重试', cx, midY, { size: 14, color: COLORS.sub, align: 'center', baseline: 'middle' });
    } else if (!this.ranking.length) {
      drawText(ctx, '暂无上榜玩家', cx, midY - 14, { size: 16, color: COLORS.text, align: 'center', baseline: 'middle' });
      drawText(ctx, '去打一局对战，胜利即可获得积分上榜', cx, midY + 16, { size: 12, color: COLORS.sub, align: 'center', baseline: 'middle' });
    }
  }

  /**
   * 单行。三段结构：名次徽章（定宽，保证昵称左边界永远对齐）｜昵称 + 战绩｜积分。
   * 昵称过长时按可用宽度反算字号并截断，不会顶到积分上。
   */
  renderRow(ctx, p, rankNo, y, W, uid) {
    const x = PAD;
    const w = W - PAD * 2;
    const cy = y + ROW_H / 2;
    const top3 = rankNo <= 3;
    const isMe = !!(uid && p.uid && String(p.uid) === uid);

    const fill = isMe ? withAlpha(COLORS.accent, 0.12) : COLORS.panel;
    const stroke = isMe ? withAlpha(COLORS.accent, 0.5)
      : rankNo === 1 ? withAlpha(RANK_COLORS[0], 0.26)
        : COLORS.line;
    fillRoundRect(ctx, x, y, w, ROW_H, 14, fill);
    strokeRoundRect(ctx, x, y, w, ROW_H, 14, stroke, 1);

    // ① 名次徽章：前三名有底色，其余只有数字，但占位宽度一致
    const bcx = x + 32;
    if (top3) {
      const c = RANK_COLORS[rankNo - 1];
      fillRoundRect(ctx, bcx - RANK_BADGE / 2, cy - RANK_BADGE / 2, RANK_BADGE, RANK_BADGE, 10,
        withAlpha(c, rankNo === 1 ? 0.22 : 0.14));
      strokeRoundRect(ctx, bcx - RANK_BADGE / 2, cy - RANK_BADGE / 2, RANK_BADGE, RANK_BADGE, 10,
        withAlpha(c, 0.45), 1);
    }
    drawText(ctx, String(rankNo), bcx, cy + 1, {
      size: top3 ? 17 : 15, bold: top3,
      color: top3 ? RANK_COLORS[rankNo - 1] : COLORS.sub,
      align: 'center', baseline: 'middle',
    });

    // ② 昵称 + 战绩：两行以行中线为轴，上下各 12px
    const nameX = bcx + RANK_BADGE / 2 + 16;
    const scoreX = x + w - 18;
    const nameMaxW = scoreX - 46 - nameX;
    const name = fitLabel(ctx, playerName(p), nameMaxW, { max: 16, min: 12, bold: true });
    drawText(ctx, name.text, nameX, cy - 12, {
      size: name.size, bold: true, color: COLORS.text, baseline: 'middle',
    });
    this.renderRecord(ctx, p, nameX, cy + 12);

    // ③ 积分
    drawText(ctx, String(p.rating || 0), scoreX, cy + 1, {
      size: 22, bold: true,
      color: rankNo === 1 ? RANK_COLORS[0] : COLORS.text,
      align: 'right', baseline: 'middle',
    });
  }

  /** 战绩「N胜 · N平 · N负」：数字跟着胜负着色，顺序与说明行的积分规则一致 */
  renderRecord(ctx, p, x, y) {
    const wins = p.wins || 0;
    const draws = p.draws || 0;
    const losses = p.losses || 0;
    const segs = [
      { text: `${wins}胜`, color: wins ? COLORS.win : COLORS.sub },
      { text: ' · ', color: withAlpha(COLORS.sub, 0.6) },
      { text: `${draws}平`, color: COLORS.sub },
      { text: ' · ', color: withAlpha(COLORS.sub, 0.6) },
      { text: `${losses}负`, color: losses ? LOSE_COLOR : COLORS.sub },
    ];
    ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let cx = x;
    for (const s of segs) {
      ctx.fillStyle = s.color;
      ctx.fillText(s.text, cx, y);
      cx += ctx.measureText(s.text).width;
    }
  }

  /** 好友/群榜：共享画布 + 列表区域背景 */
  renderSocialList(ctx, W, H) {
    const offset = this.pullOffset();

    // 列表区域底（共享画布画在其上，边界与全球榜卡片完全对齐）
    fillRoundRect(ctx, PAD, this.listTop, this.listW, this.listH, 14, COLORS.panel);
    strokeRoundRect(ctx, PAD, this.listTop, this.listW, this.listH, 14, COLORS.line, 1);

    if (this.tab === 'group' && !this.shareTicket) {
      const off = offset;
      drawText(ctx, '群排行需要从群聊卡片进入小游戏', W / 2, this.listTop + this.listH / 2 - 24 + off, {
        size: 15, color: COLORS.text, align: 'center', baseline: 'middle',
      });
      drawText(ctx, '把小游戏分享到群，再从群里的卡片点进来', W / 2, this.listTop + this.listH / 2 + 2 + off, {
        size: 12, color: COLORS.sub, align: 'center', baseline: 'middle',
      });
      if (this.shareBtn) {
        fillRoundRect(ctx, this.shareBtn.x, this.shareBtn.y + off, this.shareBtn.w, this.shareBtn.h, 12, COLORS.accent);
        drawText(ctx, '分享到群', this.shareBtn.x + this.shareBtn.w / 2, this.shareBtn.y + this.shareBtn.h / 2 + 1 + off, {
          size: 16, bold: true, color: '#ffffff', align: 'center', baseline: 'middle',
        });
      }
      return;
    }

    // 裁剪后绘制共享画布（带下拉偏移）+ 下拉指示器
    const clipTop = this.listTop;
    const clipBottom = this.listBottom;
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD, clipTop, this.listW, clipBottom - clipTop);
    ctx.clip();

    this.renderPullIndicator(ctx, W);

    const shared = this.sharedCanvas();
    if (shared) {
      ctx.drawImage(shared, PAD, this.listTop + offset, this.listW, this.listH);
    } else {
      drawText(ctx, '当前环境不支持好友排行榜', W / 2, (clipTop + clipBottom) / 2 + offset, {
        size: 14, color: COLORS.sub, align: 'center', baseline: 'middle',
      });
    }
    ctx.restore();
  }

  /* ---------------- 触摸 ---------------- */

  onTouchStart(x, y) {
    if (!this.back) return;
    // 热区外扩：按钮视觉高只有 36，触控目标要够大
    if (inRect(grow(this.back, 6), x, y)) {
      sound.tap();
      this.app.goHome();
      return;
    }
    for (const t of this.tabs) {
      if (inRect(grow(t, 7), x, y)) { this.switchTab(t.id); return; }
    }
    if (this.shareBtn && inRect(this.shareBtn, x, y)) {
      this.shareToGroup();
      return;
    }
    this.drag = { startY: y, startScroll: this.scrollY, moved: false };
    this.pull.pulling = false;
  }

  onTouchMove(x, y) {
    if (!this.drag) return;
    const dy = y - this.drag.startY;
    if (Math.abs(dy) > 8) this.drag.moved = true;

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
        if (this.tab !== 'global') this.pushScrollOnly();
      }
      return;
    }

    if (this.drag.moved) {
      this.scrollY = Math.max(0, Math.min(this.maxScroll, this.drag.startScroll - dy));
      if (this.tab !== 'global') this.pushScrollOnly();
    }
  }

  onTouchEnd() {
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
    this.drag = null;
  }

  destroy() {
    if (this._pullTimer) { clearTimeout(this._pullTimer); this._pullTimer = null; }
    const odc = this.openData();
    if (odc) { try { odc.postMessage({ type: 'clear' }); } catch (e) { /* ignore */ } }
  }
}

/** 把一个矩形按 pad 向四周外扩，得到更大的触摸热区 */
function grow(r, pad) {
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}
