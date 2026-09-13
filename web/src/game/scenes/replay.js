/**
 * 对局复盘播放器：
 *  - 拉取对局详情（api.getMatchDetail），用规则引擎逐步回放落子；
 *  - 支持上一步 / 下一步 / 跳到开局 / 跳到终局 / 自动播放（800ms 一步）；
 *  - 落子播 move 音效，吃格播 gain 音效。
 */
import { COLORS } from '../config.js';
import * as api from '../net/api.js';
import { BoardView } from '../ui/board.js';
import { drawText, fillRoundRect, strokeRoundRect, inRect } from '../ui/widgets.js';
import { layoutDock, drawDock, hitDock } from '../ui/dock.js';
import { sound } from '../sound.js';
import * as core from '../core/index.js';

const AUTO_INTERVAL = 800; // 自动播放每步间隔（毫秒）

export class ReplayScene {
  constructor(app, matchId) {
    this.app = app;
    this.matchId = matchId;
    this.board = new BoardView();
    this.detail = null;      // 对局详情
    this.loading = true;
    this.error = null;
    this.step = 0;           // 当前展示到第几步（0 = 开局）
    this.playing = false;    // 是否自动播放
    this.timer = null;
    this.buttons = [];
    this.dock = null;        // 底部播放控制 Dock（layout 时计算）
    this.pressedId = null;   // 按钮按压态（drawDock 读取）
    this.loadDetail();
  }

  /* ---------------- 数据 ---------------- */

  async loadDetail() {
    this.loading = true;
    this.error = null;
    try {
      const d = await api.getMatchDetail(this.matchId);
      this.detail = d;
      this.buildStates();
    } catch (e) {
      this.error = e.message;
    } finally {
      this.loading = false;
    }
  }

  /** 预计算从开局到终局的每一步状态，便于前后跳转 */
  buildStates() {
    const d = this.detail;
    this.states = [];
    this.lastEdges = [];
    if (!d) return;
    let s = core.startGame(core.createGame({ rows: d.rows, cols: d.cols }));
    this.states.push(s);
    this.lastEdges.push(null);
    const moves = Array.isArray(d.moves) ? d.moves : [];
    for (const mv of moves) {
      const r = core.applyMove(s, mv.by, mv.edge);
      if (!r.ok) break; // 历史数据异常时截断
      s = r.state;
      this.states.push(s);
      this.lastEdges.push(mv.edge);
    }
    this.step = this.states.length - 1; // 默认停在终局
  }

  /* ---------------- 播放控制 ---------------- */

  get totalSteps() {
    return this.states ? this.states.length - 1 : 0;
  }

  setStep(n, { sound: playSound = true } = {}) {
    if (!this.states) return;
    const from = this.step;
    this.step = Math.max(0, Math.min(this.totalSteps, n));
    // 步进音效（只在单步推进时播，跳转/自动连续播由调用方控制）
    if (playSound && this.step > from) {
      const mv = (this.detail?.moves || [])[this.step - 1];
      if (mv) {
        sound.move();
        if (mv.gained && mv.gained.length) sound.gain();
      }
    }
  }

  play() {
    if (this.playing) return;
    if (this.step >= this.totalSteps) this.step = 0; // 已播完则从头再播
    this.playing = true;
    this.timer = setInterval(() => this.tick(), AUTO_INTERVAL);
  }

  pause() {
    this.playing = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  tick() {
    if (this.step >= this.totalSteps) { this.pause(); return; }
    this.setStep(this.step + 1, { sound: true });
    if (this.step >= this.totalSteps) this.pause();
  }

  destroy() {
    this.pause();
  }

  /* ---------------- 布局 ---------------- */

  layout(W, H) {
    const safeTop = this.app.safeTop || 0;
    this.back = { id: 'back', x: 14, y: Math.max(46, safeTop + 6), w: 76, h: 36 };

    // 底部控制栏：⇤ | ◀ | 播放/暂停 | ▶ | ⇥ —— 与对局页共用同一个 Dock 容器与规格
    this.dockGroups = [[
      { id: 'start', label: '', icon: 'skipStart' },
      { id: 'prev', label: '', icon: 'prev' },
      { id: 'play', label: '', icon: this.playing ? 'pause' : 'play', kind: 'primary' },
      { id: 'next', label: '', icon: 'next' },
      { id: 'end', label: '', icon: 'skipEnd' },
    ]];
    this.dock = layoutDock(W, H, this.dockGroups, { safeBottom: this.app.safeBottom || 0 });
    this.buttons = this.dock ? this.dock.buttons : [];

    const headerH = 126;
    const dockH = this.dock ? this.dock.spec.dockH : 64;
    const footerH = dockH + 12 + 40; // Dock + 底距 + 进度文字
    const size = Math.max(160, Math.min(W - 32, H - headerH - footerH));
    const rows = this.detail?.rows || 6;
    const cols = this.detail?.cols || 6;
    this.board.layout({ x: (W - size) / 2, y: headerH, size }, rows, cols);
    this.progressY = (this.dock ? this.dock.dock.y : H - 96) - 18;
  }

  /* ---------------- 渲染 ---------------- */

  render(ctx, W, H) {
    this.layout(W, H);

    if (this.loading) {
      drawText(ctx, '加载中…', W / 2, H / 2, { size: 15, color: COLORS.sub, align: 'center', baseline: 'middle' });
      return;
    }
    if (this.error) {
      drawText(ctx, '加载失败', W / 2, H / 2 - 10, { size: 16, color: COLORS.text, align: 'center', baseline: 'middle' });
      drawText(ctx, this.error, W / 2, H / 2 + 18, { size: 12, color: COLORS.sub, align: 'center', baseline: 'middle' });
      return;
    }
    const d = this.detail;
    if (!d) return;

    // 顶部信息
    fillRoundRect(ctx, this.back.x, this.back.y, this.back.w, this.back.h, 12, COLORS.panel);
    strokeRoundRect(ctx, this.back.x, this.back.y, this.back.w, this.back.h, 12, COLORS.line, 1);
    drawText(ctx, '‹ 返回', this.back.x + this.back.w / 2, this.back.y + this.back.h / 2 + 1, {
      size: 14, color: COLORS.text, align: 'center', baseline: 'middle',
    });

    // 对手昵称 + 最终比分
    const oppNick = this.opponentNick();
    drawText(ctx, `对手：${oppNick}`, W / 2, 36, { size: 15, color: COLORS.text, align: 'center', baseline: 'middle' });
    drawText(ctx, `${d.rows}×${d.cols} · 终局 ${d.score1}:${d.score2}`, W / 2, 62, {
      size: 12, color: COLORS.sub, align: 'center', baseline: 'middle',
    });

    // 比分小字（棋盘上方）
    const st = this.states[this.step];
    if (st) {
      const y = 100;
      drawText(ctx, String(st.scores[0]), W / 2 - 40, y, { size: 20, bold: true, color: COLORS.p1, align: 'center', baseline: 'middle' });
      drawText(ctx, ':', W / 2, y - 2, { size: 18, color: COLORS.sub, align: 'center', baseline: 'middle' });
      drawText(ctx, String(st.scores[1]), W / 2 + 40, y, { size: 20, bold: true, color: COLORS.p2, align: 'center', baseline: 'middle' });
    }

    // 无复盘数据
    if (this.totalSteps === 0) {
      fillRoundRect(ctx, this.board.box.x, this.board.box.y, this.board.box.size, this.board.box.size, 18, 'rgba(15,18,24,.92)');
      const cx = this.board.box.x + this.board.box.size / 2;
      const cy = this.board.box.y + this.board.box.size / 2;
      drawText(ctx, '该对局无复盘数据', cx, cy - 6, { size: 15, color: COLORS.sub, align: 'center', baseline: 'middle' });
      drawText(ctx, '（旧版本对局未保存落子记录）', cx, cy + 20, { size: 12, color: COLORS.sub, align: 'center', baseline: 'middle' });
    } else {
      this.board.render(ctx, st, { lastEdge: this.lastEdges[this.step] || null, interactive: false });
    }

    // 进度文字
    drawText(ctx, `第 ${this.step} / ${this.totalSteps} 步`, W / 2, this.progressY, {
      size: 14, color: COLORS.sub, align: 'center', baseline: 'middle',
    });

    // 控制按钮（Dock）
    drawDock(ctx, this.dock, { pressedId: this.pressedId });
  }

  /** 对手昵称：按 seat 取对方名字，空则「未知对手」 */
  opponentNick() {
    const d = this.detail;
    if (!d) return '';
    const myUid = api.getUid();
    // 详情里 mySeat 未直接返回，按 seat1/seat2 推断
    if (d.seat1 && d.seat1 === myUid) return d.player2Nick || '未知对手';
    if (d.seat2 && d.seat2 === myUid) return d.player1Nick || '未知对手';
    // 拿不到自己 uid 时退而求其次：两个昵称里挑一个
    return d.player2Nick || d.player1Nick || '未知对手';
  }

  /* ---------------- 触摸 ---------------- */

  onTap(x, y) {
    if (inRect(this.back, x, y)) {
      sound.tap();
      this.app.goHome();
      return;
    }
    const hit = hitDock(this.dock, x, y);
    if (!hit) return;
    sound.tap();
    const id = hit.id;
    if (id === 'start') { this.pause(); this.setStep(0, { sound: false }); }
    else if (id === 'prev') { this.pause(); this.setStep(this.step - 1, { sound: false }); }
    else if (id === 'next') { this.pause(); this.setStep(this.step + 1, { sound: false }); }
    else if (id === 'end') { this.pause(); this.setStep(this.totalSteps, { sound: false }); }
    else if (id === 'play') { this.playing ? this.pause() : this.play(); }
  }
}
