/**
 * 玩法介绍场景：用卡片化的方式讲解云柯点格棋（Dots and Boxes）的规则与小技巧。
 * 支持上下滚动，左上角「‹ 返回」回到首页。
 */
import { COLORS } from '../config.js';
import { sound } from '../sound.js';
import { drawText, fillRoundRect, strokeRoundRect, inRect } from '../ui/widgets.js';

const CARD_X = 20;      // 卡片左右边距
const CARD_R = 18;      // 卡片圆角
const CARD_GAP = 12;    // 卡片之间的垂直间距
const LIST_TOP = 108;   // 内容区起始 y
const PAD = 20;         // 卡片内边距

/** 规则卡片数据：一张卡片讲一个规则点 */
const CARDS = [
  {
    title: '基本目标',
    body: '两名玩家轮流在相邻两点之间画一条边。谁围成的方格多，谁就获胜。',
  },
  {
    title: '画边',
    body: '点击两个相邻点之间的虚线即可画边。每条边只能画一次，由当前回合的颜色绘制。',
    diagram: 'edge',
  },
  {
    title: '得分与连击',
    body: '如果你画的边刚好围成了一个或多个方格，这些方格归你所有（显示你的颜色），并且你可以继续画下一条边——不用换人。',
    diagram: 'box',
  },
  {
    title: '终局判定',
    body: '当所有边都画完时游戏结束。比较双方的方格数，多的一方获胜；数量相同则平局。',
  },
  {
    title: '小技巧',
    body: '尽量避免给对手留出「三连格」——对方一口气围三格会迅速拉开差距。残局时仔细算清楚送格顺序，往往能反败为胜。',
  },
];

/** 按每行最多字符数把一段中文折行（中文按等宽估算，足够排版用） */
function wrapText(text, maxChars) {
  const lines = [];
  let line = '';
  for (const ch of text) {
    line += ch;
    if (line.length >= maxChars) { lines.push(line); line = ''; }
  }
  if (line) lines.push(line);
  return lines;
}

/** 画点 */
function drawDots(ctx, x0, y0, cols, rows, s) {
  ctx.fillStyle = COLORS.text;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.beginPath();
      ctx.arc(x0 + c * s, y0 + r * s, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** 示意图：画边 —— 3×2 个点，虚线表示可画的边，实线高亮一条已画边 */
function drawEdgeDemo(ctx, x, y) {
  const s = 24;
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      ctx.beginPath();
      ctx.moveTo(x + c * s, y + r * s);
      ctx.lineTo(x + (c + 1) * s, y + r * s);
      ctx.stroke();
    }
    // 竖边
    ctx.beginPath();
    ctx.moveTo(x, y + r * s);
    ctx.lineTo(x, y + (r + 1) * s);
    ctx.moveTo(x + s, y + r * s);
    ctx.lineTo(x + s, y + (r + 1) * s);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // 高亮一条已画边（第一行）
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + s, y);
  ctx.stroke();
  ctx.lineWidth = 1;
  drawDots(ctx, x, y, 2, 2, s);
}

/** 示意图：得分 —— 一个被围满的方格填上红方颜色，旁边两个空格用虚线表示 */
function drawBoxDemo(ctx, x, y) {
  const s = 24;
  // 已围成的方格（红方）
  ctx.fillStyle = 'rgba(255,107,107,.28)';
  ctx.fillRect(x, y, s, s);
  ctx.strokeStyle = COLORS.p1;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, s, s);
  // 相邻两个空格（虚线）
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(x + s, y, s, s);
  ctx.strokeRect(x, y + s, s, s);
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  drawDots(ctx, x, y, 3, 3, s);
}

export class HowToScene {
  constructor(app) {
    this.app = app;
    this.back = null;
    this.cards = [];
    this.scrollY = 0;
    this.drag = null;   // { startY, startScroll, moved }
    this.maxScroll = 0;
    this.listTop = LIST_TOP;
    this.listBottomPad = 24;
  }

  layout(W, H) {
    this.back = { id: 'back', x: 14, y: 46, w: 76, h: 36 };
    this.listTop = LIST_TOP;
    this.listBottom = H - this.listBottomPad;

    const cardW = W - CARD_X * 2;
    const maxChars = Math.max(10, Math.floor((cardW - PAD * 2) / 13));
    let y = this.listTop;
    const cards = CARDS.map((c) => {
      const lines = wrapText(c.body, maxChars);
      const dh = c.diagram ? 64 : 0;
      const h = PAD + 22 + 10 + lines.length * 20 + dh + PAD;
      const card = { ...c, x: CARD_X, y, w: cardW, h, lines, dh };
      y += h + CARD_GAP;
      return card;
    });
    this.cards = cards;

    const contentH = y - CARD_GAP - this.listTop;
    this.maxScroll = Math.max(0, contentH - (this.listBottom - this.listTop));
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScroll));
  }

  render(ctx, W, H) {
    this.layout(W, H);

    // 标题
    drawText(ctx, '玩法介绍', W / 2, 64, { size: 20, bold: true, align: 'center', baseline: 'middle', color: COLORS.text });

    // 返回按钮
    fillRoundRect(ctx, this.back.x, this.back.y, this.back.w, this.back.h, 12, COLORS.panel);
    strokeRoundRect(ctx, this.back.x, this.back.y, this.back.w, this.back.h, 12, COLORS.line, 1);
    drawText(ctx, '‹ 返回', this.back.x + this.back.w / 2, this.back.y + this.back.h / 2 + 1, {
      size: 14, color: COLORS.text, align: 'center', baseline: 'middle',
    });

    // 滚动内容（裁剪在标题与底边提示之间）
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.listTop, W, this.listBottom - this.listTop);
    ctx.clip();

    for (const card of this.cards) {
      const y = card.y - this.scrollY;
      if (y + card.h < this.listTop || y > this.listBottom) continue;

      fillRoundRect(ctx, card.x, y, card.w, card.h, CARD_R, COLORS.panel);
      strokeRoundRect(ctx, card.x, y, card.w, card.h, CARD_R, COLORS.line, 1);

      let ty = y + PAD + 11;
      drawText(ctx, card.title, card.x + PAD, ty, { size: 15, bold: true, color: COLORS.text, baseline: 'middle' });
      ty += 22 + 10 - 11;

      for (const line of card.lines) {
        drawText(ctx, line, card.x + PAD, ty, { size: 13, color: COLORS.sub, baseline: 'middle' });
        ty += 20;
      }

      if (card.diagram === 'edge') {
        drawEdgeDemo(ctx, card.x + PAD, ty + 6);
      } else if (card.diagram === 'box') {
        drawBoxDemo(ctx, card.x + PAD, ty + 6);
      }
    }
    ctx.restore();

    // 底部提示
    drawText(ctx, '看完了？点左上角「‹ 返回」回到首页', W / 2, H - 12, {
      size: 12, align: 'center', baseline: 'middle', color: COLORS.sub,
    });
  }

  onTouchStart(x, y) {
    if (!this.back) return; // 尚未完成首次布局
    if (inRect(this.back, x, y)) {
      sound.tap();
      this.app.goHome();
      return;
    }
    this.drag = { startY: y, startScroll: this.scrollY, moved: false };
  }

  onTouchMove(x, y) {
    if (!this.drag) return;
    const dy = y - this.drag.startY;
    if (Math.abs(dy) > 8) this.drag.moved = true;
    if (this.drag.moved) {
      this.scrollY = Math.max(0, Math.min(this.maxScroll, this.drag.startScroll - dy));
    }
  }

  onTouchEnd() {
    this.drag = null;
  }
}
