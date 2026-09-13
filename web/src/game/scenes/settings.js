/**
 * 设置场景：音效开关 / 震动反馈 / 棋盘大小 / 先手方。
 * 所有改动即时写入本地存储，重新开局后生效。
 */
import { COLORS } from '../config.js';
import { Settings, BOARD_SIZES, FIRST_PLAYERS, AI_LEVELS } from '../settings.js';
import { sound } from '../sound.js';
import { drawText, fillRoundRect, strokeRoundRect, inRect } from '../ui/widgets.js';

const CARD_X = 20;      // 卡片左右边距
const CARD_R = 18;      // 卡片圆角

function drawToggle(ctx, x, y, on) {
  const w = 48;
  const h = 28;
  const r = h / 2;
  fillRoundRect(ctx, x, y, w, h, r, on ? COLORS.accent : '#2a303c');
  strokeRoundRect(ctx, x, y, w, h, r, on ? COLORS.accent : COLORS.line, 1);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(on ? x + w - r : x + r, y + r, r - 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawChip(ctx, c, selected) {
  fillRoundRect(ctx, c.x, c.y, c.w, c.h, 12, selected ? COLORS.accent : COLORS.panel);
  strokeRoundRect(ctx, c.x, c.y, c.w, c.h, 12, selected ? COLORS.accent : COLORS.line, 1);
  drawText(ctx, c.label, c.x + c.w / 2, c.y + c.h / 2 + 1, {
    size: c.fontSize || 13,
    color: selected ? '#ffffff' : COLORS.sub,
    align: 'center',
    baseline: 'middle',
  });
}

export class SettingsScene {
  constructor(app) {
    this.app = app;
    this.back = null;
    this.rows = [];
    this.tipY = 0;
  }

  layout(W, H) {
    this.back = { id: 'back', x: 14, y: 46, w: 76, h: 36 };
    const cw = W - CARD_X * 2;
    const rows = [];

    // 开关组：音效 / 震动
    const toggleRows = [
      { id: 'sound', label: '音效', sub: '落子、得分与胜负提示音', type: 'toggle' },
      { id: 'vibration', label: '震动反馈', sub: '落子时轻微震动', type: 'toggle' },
    ];
    const toggleH = 58;
    toggleRows.forEach((r, i) => {
      rows.push({ ...r, x: CARD_X, y: 108 + i * toggleH, w: cw, h: toggleH });
    });
    let y = 108 + toggleRows.length * toggleH + 14;

    // 选项组：棋盘大小 / 先手方
    const chipH = 40;
    const optionRows = [
      {
        id: 'boardSize', label: '棋盘大小', type: 'chips', h: 96,
        options: BOARD_SIZES.map((n, i, arr) => ({
          value: n,
          label: `${n}×${n}`,
          x: CARD_X + 20 + i * ((cw - 40 - 8 * (arr.length - 1)) / arr.length + 8),
          y: 0, // 下面统一赋值
          w: (cw - 40 - 8 * (arr.length - 1)) / arr.length,
          h: chipH,
        })),
      },
      {
        id: 'firstPlayer', label: '先手方', sub: '仅对单人练习生效', type: 'chips', h: 96,
        options: FIRST_PLAYERS.map((f, i, arr) => ({
          value: f.value,
          label: f.label,
          x: CARD_X + 20 + i * ((cw - 40 - 8 * (arr.length - 1)) / arr.length + 8),
          y: 0,
          w: (cw - 40 - 8 * (arr.length - 1)) / arr.length,
          h: chipH,
        })),
      },
      {
        id: 'aiLevel', label: 'AI 难度', sub: '仅对单人练习生效', type: 'chips', h: 96,
        options: AI_LEVELS.map((a, i, arr) => ({
          value: a.value,
          label: a.label,
          x: CARD_X + 20 + i * ((cw - 40 - 8 * (arr.length - 1)) / arr.length + 8),
          y: 0,
          w: (cw - 40 - 8 * (arr.length - 1)) / arr.length,
          h: chipH,
        })),
      },
    ];
    for (const r of optionRows) {
      rows.push({ ...r, x: CARD_X, y, w: cw });
      for (const c of r.options) c.y = y + 50;
      y += r.h + 14;
    }

    this.rows = rows;
    this.tipY = y - 14 + 12;
  }

  render(ctx, W, H) {
    this.layout(W, H);

    // 标题
    drawText(ctx, '设置', W / 2, 64, { size: 20, bold: true, align: 'center', baseline: 'middle', color: COLORS.text });

    // 返回按钮
    fillRoundRect(ctx, this.back.x, this.back.y, this.back.w, this.back.h, 12, COLORS.panel);
    strokeRoundRect(ctx, this.back.x, this.back.y, this.back.w, this.back.h, 12, COLORS.line, 1);
    drawText(ctx, '‹ 返回', this.back.x + this.back.w / 2, this.back.y + this.back.h / 2 + 1, {
      size: 14, color: COLORS.text, align: 'center', baseline: 'middle',
    });

    for (const row of this.rows) {
      fillRoundRect(ctx, row.x, row.y, row.w, row.h, CARD_R, COLORS.panel);
      strokeRoundRect(ctx, row.x, row.y, row.w, row.h, CARD_R, COLORS.line, 1);

      if (row.type === 'toggle') {
        drawText(ctx, row.label, row.x + 20, row.y + 19, { size: 16, color: COLORS.text, baseline: 'middle' });
        drawText(ctx, row.sub, row.x + 20, row.y + 41, { size: 12, color: COLORS.sub, baseline: 'middle' });
        drawToggle(ctx, row.x + row.w - 20 - 48, row.y + (row.h - 28) / 2, Settings[row.id]);
      } else if (row.type === 'chips') {
        drawText(ctx, row.label, row.x + 20, row.y + 22, { size: 14, color: COLORS.text, baseline: 'middle' });
        if (row.sub) {
          drawText(ctx, row.sub, row.x + row.w - 20, row.y + 22, { size: 11, color: COLORS.sub, align: 'right', baseline: 'middle' });
        }
        for (const c of row.options) {
          drawChip(ctx, c, Settings[row.id] === c.value);
        }
      }
    }

    drawText(ctx, '设置自动保存，重新开局后生效', W / 2, this.tipY, {
      size: 12, align: 'center', baseline: 'middle', color: COLORS.sub,
    });
  }

  onTap(x, y) {
    if (inRect(this.back, x, y)) {
      sound.tap();
      this.app.goHome();
      return;
    }
    for (const row of this.rows) {
      if (row.type === 'toggle') {
        if (inRect(row, x, y)) {
          Settings[row.id] = !Settings[row.id];
          sound.tap();
          return;
        }
      } else if (row.type === 'chips') {
        for (const c of row.options) {
          if (inRect(c, x, y)) {
            if (Settings[row.id] !== c.value) {
              Settings[row.id] = c.value;
              sound.tap();
            }
            return;
          }
        }
      }
    }
  }
}
