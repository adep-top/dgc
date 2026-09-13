import { COLORS, CONFIG } from './config.js';
import { BoardView } from './ui/board.js';
import {
  drawButton, drawText, fillRoundRect, strokeRoundRect, inRect, toast, withAlpha, fitLabel,
} from './ui/widgets.js';
import {
  layoutDock, drawDock, hitDock, dockSpec, drawDockIcon, WIDE_BP,
} from './ui/dock.js';
import {
  drawBrandLogo,
  drawSpacedTitle,
  drawStatusPill,
  drawHeroCard,
  drawTile,
  drawPill,
  drawRowItem,
  drawListCard,
} from './ui/home-art.js';
import { sound } from './sound.js';
import * as api from './net/api.js';

const STATUS = { WAITING: 'waiting', PLAYING: 'playing', FINISHED: 'finished' };

/** 聊天文本按宽度简单换行：每约 n 个字符一行 */
function wrapChatText(text, n = 14) {
  const lines = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if (cur.length >= n) { lines.push(cur); cur = ''; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * 首页分组定义。视觉上分三层：
 *   主 CTA（快速匹配）→ 三宫格磁贴（对战方式）→ 胶囊按钮（加入房间）→ 功能列表卡片。
 * 每层用不同的形状与色彩权重，避免原来「十个按钮一样大」的平铺感。
 */
const HOME_HERO = { id: 'quick', label: '快速匹配', icon: 'bolt' };
const HOME_TILES = [
  { id: 'local', label: '单人练习', sub: '人机对战', icon: 'solo', accent: COLORS.win },
  { id: 'create', label: '创建房间', sub: '邀请好友', icon: 'plus', accent: COLORS.p2 },
  { id: 'async', label: '异步对战', sub: '不必同时在线', icon: 'hourglass', accent: '#a78bfa' },
];
const HOME_PILLS = [
  { id: 'lobby', label: '房间列表', icon: 'list', accent: COLORS.p2 },
  { id: 'join', label: '输入房号', icon: 'hash', accent: COLORS.win },
];
const HOME_ROWS = [
  { id: 'howto', label: '玩法介绍', hint: '规则 · 技巧' },
  { id: 'ranking', label: '排行榜', hint: '全球 · 好友' },
  { id: 'matches', label: '战绩', hint: '历史对局' },
  { id: 'settings', label: '设置', hint: '音效 · 棋盘' },
];

export class HomeScene {
  constructor(app) {
    this.app = app;
    this.buttons = [];
    this.listCard = null;
  }

  layout(W, H) {
    const padX = 22;
    const contentW = W - padX * 2;
    const colGap = 12;

    // 顶部品牌区：标 → 标题 → 副标题 → 状态胶囊
    const header = {
      logoCy: 110,
      logoSize: 46,
      titleY: 161,
      taglineY: 190,
      statusCy: 218,
      statusH: 26,
    };
    this.header = header;

    const HERO_H = 58;
    const TILE_H = 92;
    const PILL_H = 54;
    const ROW_H = 46;

    const tiles = CONFIG.enableOnline ? HOME_TILES : HOME_TILES.filter((t) => t.id === 'local');
    const pills = CONFIG.enableOnline ? HOME_PILLS : [];

    // 分段表：h = 段高，gap = 与上一段的间距（首段不与上一段相邻，其 gap 单独算进 topY）
    const sections = [];
    if (CONFIG.enableOnline) sections.push({ key: 'hero', h: HERO_H, gap: 26 });
    if (tiles.length) sections.push({ key: 'tiles', h: TILE_H, gap: 14 });
    if (pills.length) sections.push({ key: 'pills', h: PILL_H, gap: 12 });
    sections.push({ key: 'rows', h: ROW_H * HOME_ROWS.length, gap: 12 });

    const interGaps = sections.length - 1;
    const natural = sections.reduce((a, s, i) => a + s.h + (i ? s.gap : 0), 0);
    const baseTopY = header.statusCy + header.statusH / 2 + sections[0].gap;

    // 小屏：等比压缩段高与间距，保证不溢出；大屏：把富余空间分给段间距与顶部留白
    const avail = H - 28 - baseTopY;
    const slack = avail - natural;
    const k = Math.min(1, avail / natural);
    const grow = Math.max(0, Math.min(18, slack / Math.max(1, interGaps)));
    const shift = Math.max(0, Math.min(16, (slack - grow * interGaps) / 2));
    const topY = baseTopY + shift;

    const buttons = [];
    this.listCard = null;
    let y = topY;

    sections.forEach((s, i) => {
      if (i > 0) y += s.gap * k + grow;
      if (s.key === 'hero') {
        buttons.push({
          ...HOME_HERO, style: 'hero', kind: 'primary', x: padX, y, w: contentW, h: HERO_H * k,
        });
      } else if (s.key === 'tiles') {
        // 只剩一张磁贴时（单机模式）保持三列宽度居中，避免拉成一条空荡的长条
        const tileW = tiles.length === 1
          ? (contentW - colGap * 2) / 3
          : (contentW - colGap * (tiles.length - 1)) / tiles.length;
        const startX = tiles.length === 1 ? padX + (contentW - tileW) / 2 : padX;
        tiles.forEach((t, j) => {
          buttons.push({
            ...t, style: 'tile', x: startX + j * (tileW + colGap), y, w: tileW, h: TILE_H * k,
          });
        });
      } else if (s.key === 'pills') {
        const pillW = (contentW - colGap) / 2;
        pills.forEach((t, j) => {
          buttons.push({
            ...t, style: 'pill', x: padX + j * (pillW + colGap), y, w: pillW, h: PILL_H * k,
          });
        });
      } else {
        const rh = ROW_H * k;
        const cardPad = 6 * k;
        this.listCard = { x: padX, y: y - cardPad, w: contentW, h: rh * HOME_ROWS.length + cardPad * 2 };
        HOME_ROWS.forEach((t, j) => {
          buttons.push({
            ...t, style: 'row', x: padX, y: y + j * rh, w: contentW, h: rh, first: j === 0,
          });
        });
      }
      y += s.h * k;
    });

    this.buttons = buttons;
    // 状态胶囊区域（供命中测试：失败时点击重试登录）。y 覆盖胶囊上下各 13px
    this.statusHit = { x: 0, y: header.statusCy - 13, w: 0, h: 26 };
  }

  /** 登录态对应的状态点颜色与文案 */
  statusInfo() {
    const st = this.app.loginState;
    if (st === 'off') return { color: COLORS.sub, text: '单机模式（未开启联网）' };
    if (st === 'fail') {
      // 把失败原因缩略后跟上，真机上没有 console，状态条是唯一的诊断出口
      const reason = this.app.loginError ? `：${String(this.app.loginError).slice(0, 18)}` : '';
      return { color: '#ff8f6b', text: `连接失败${reason}，点此重试` };
    }
    if (st === 'loading') return { color: '#f0b429', text: '正在连接服务器…' };
    // 连本地后端时把地址显示出来（蓝色点），避免「以为在连线上 / 以为在连本地」搞混
    const env = this.app.env;
    if (env && env.isLocal) return { color: COLORS.p2, text: `已连接 · 本地 ${env.host}` };
    return { color: COLORS.win, text: '已连接 · 快速匹配可遇到陌生人' };
  }

  /** 点击状态胶囊：失败时重试登录 */
  onStatusTap() {
    if (this.app.loginState === 'fail') this.app.retryLogin();
  }

  render(ctx, W, H) {
    this.layout(W, H);

    const hd = this.header;
    drawBrandLogo(ctx, W / 2, hd.logoCy, hd.logoSize);
    drawSpacedTitle(ctx, '云柯点格棋', W / 2, hd.titleY, { size: 34, gap: 6 });
    drawText(ctx, '轮流连线，围成格子得分并继续走', W / 2, hd.taglineY, {
      size: 13, align: 'center', baseline: 'middle', color: COLORS.sub,
    });

    const status = this.statusInfo();
    drawStatusPill(ctx, W / 2, hd.statusCy, status.text, status.color);

    if (this.listCard) drawListCard(ctx, this.listCard);

    for (const b of this.buttons) {
      // 联网相关入口在登录失败时置灰（单人练习与设置始终可用）
      const disabled = this.app.loginState === 'fail' && b.id !== 'local' && b.id !== 'settings';
      // style 由 layout 统一赋值：hero | tile | pill | row
      if (b.style === 'hero') drawHeroCard(ctx, b, { disabled });
      else if (b.style === 'tile') drawTile(ctx, b, { disabled });
      else if (b.style === 'pill') drawPill(ctx, b, { disabled });
      else drawRowItem(ctx, b, { disabled });
    }
  }

  onTap(x, y) {
    // 状态胶囊命中：胶囊垂直居中在 statusCy，该横条区域没有其他可点元素，
    // 按 y 区间判断即可；仅在失败态接管点击（loading/ok 时让按钮正常处理）
    const sh = this.statusHit;
    if (sh && sh.h > 0 && y >= sh.y && y <= sh.y + sh.h && this.app.loginState === 'fail') {
      this.onStatusTap();
      return;
    }
    for (const b of this.buttons) {
      if (inRect(b, x, y)) {
        if (b.id === 'local') this.app.startLocal();
        else if (b.id === 'quick') this.app.quickMatch();
        else if (b.id === 'create') this.pickCreateVisibility();
        else if (b.id === 'async') this.app.startAsync();
        else if (b.id === 'lobby') this.app.showLobby();
        else if (b.id === 'join') this.app.promptJoin();
        else if (b.id === 'howto') this.app.goHowTo();
        else if (b.id === 'ranking') this.app.goRanking();
        else if (b.id === 'matches') this.app.goMatches();
        else if (b.id === 'settings') this.app.goSettings();
        return;
      }
    }
  }

  /**
   * 「创建房间」先选可见性：
   *   公开房间 —— 出现在大厅列表，陌生人可加入；
   *   仅好友可见 —— 不上大厅，只能通过分享卡片/房号/小程序码邀请好友加入。
   */
  pickCreateVisibility() {
    wx.showActionSheet({
      itemList: ['公开房间（陌生人可加入）', '仅好友可见（分享邀请）'],
      success: (res) => {
        if (res.tapIndex === 0) this.app.createRoom('public');
        else if (res.tapIndex === 1) this.app.createRoom('friends');
      },
    });
  }
}

export class GameScene {
  constructor(app, session) {
    this.app = app;
    this.session = session;
    this.board = new BoardView();
    this.buttons = [];
    this.overlayButtons = [];
    // 底部操作区（Dock）布局结果；null 表示当前阶段不显示（如结算态）
    this.dock = null;
    this.dockGroups = [];
    // 按钮按压态：按下命中后置位，滑出热区清空，抬起时才派发动作
    this.pressedId = null;
    // 聊天面板状态（仅联网模式可用）
    this.chatOpen = false;
    this.chatScroll = 0;
    this.chatDrag = null; // { startY, startScroll, moved }
    this.chatLastMsgCount = -1;
    this.chatEmojis = ['😊', '😂', '👍', '👎', '😎', '🎉', '😅', '😡', '🤔', '💪', '😴', '👏'];
    // 邀请弹窗状态（仅联网房间可用）：微信版为小程序码，web 版为邀请链接卡片
    this.wxacodeOpen = false;
    this.wxacodeLink = '';        // 邀请链接（web 版替代小程序码）
    this.wxacodeError = false;
    // 对手断线提醒：只在「在线 ↔ 断线」发生翻转时提示一次（render 每帧都会走 onChange）
    this.peerOfflineNotified = false;
    // 对手主动离开（点返回首页 / 关游戏）：触发一次 toast 让结算浮层的提示更显眼
    this.peerLeftNotified = false;
    session.onChange((sess) => {
      this.app.dirty = true;
      this.syncPeerNotice(sess);
    });
  }

  /**
   * 对手离场 / 回场提醒。
   * 服务端在对手的 WebSocket 断开/重连时广播 peer:offline / peer:online，
   * 这里做一次性提示：断线时弹 toast，并让状态胶囊持续显示「等待重连」；
   * 对手回来后同样提示一次，玩家知道可以继续下。
   *
   * 另：对手主动离开（left:true）会在结算态里把按钮切成「等待新对手」，
   * 这里补一个 toast 帮玩家立刻注意到。
   */
  syncPeerNotice(sess) {
    if (typeof sess.opponentOffline !== 'function') return;

    // 对手主动离开：翻转时弹一次 toast，避免每帧重弹
    const left = !!sess.peerLeft;
    if (left !== this.peerLeftNotified) {
      this.peerLeftNotified = left;
      if (left) { sound.vibrate('light'); toast('对手已离开房间'); return; }
    }

    const off = sess.opponentOffline();
    if (off === this.peerOfflineNotified) return;
    this.peerOfflineNotified = off;
    if (off && sess.state && sess.state.status !== STATUS.FINISHED) {
      sound.vibrate('light');
      toast('对手已离开房间，等待重连…');
    } else if (!off && sess.state && sess.state.status === STATUS.PLAYING) {
      toast('对手已重新连接');
    }
  }

  layout(W, H) {
    const s = this.session;
    const st = s.state;
    const spec = dockSpec(W);
    const rail = W >= WIDE_BP;                 // 平板 / 桌面：Dock 折成右侧 Rail
    const safeTop = this.app.safeTop || 0;
    const safeBottom = this.app.safeBottom || 0;
    const finished = st?.status === STATUS.FINISHED;

    // ── 顶栏 ── 返回 chevron + 房间号(+标签) + 倒计时 chip
    // 返回属于「导航」，从底部操作区移到左上角，危险操作才不会被它挤到身边
    const padX = rail ? 24 : 14;
    const topH = rail ? 64 : 48;
    const topY = rail ? 16 : safeTop + 6;
    const backSize = 36;
    this.topBar = { y: topY, h: topH, cy: topY + topH / 2 };
    this.backBtn = {
      id: 'home', x: padX, y: topY + Math.round((topH - backSize) / 2), w: backSize, h: backSize,
    };
    this.roomTextX = padX + backSize + 10;
    // 倒计时右边界：优先贴到微信胶囊左侧，避免"45s 压在胶囊上"
    const menu = this.app.menuRect;
    const menuLeft = menu && menu.left ? menu.left - 10 : W - 16;
    this.chipRight = rail ? W - spec.railW - 24 : Math.max(W * 0.55, Math.min(W - 16, menuLeft));

    // ── 计分板 / 状态胶囊 / 棋盘 ──
    // 不再写死 headerH / footerH，剩余空间由内容组垂直居中吸收，
    // 从根上消掉原来"棋盘与按钮之间空 256pt"的单侧空洞。
    const scoreH = rail ? 56 : 76;
    const pillH = 28;
    const gapPill = 18;   // 计分板 → 状态胶囊
    const gapBoard = 14;  // 状态胶囊 → 棋盘
    const dockH = finished ? 0 : spec.dockH;
    const boardRows = st?.rows || 6;
    const boardCols = st?.cols || 6;

    if (rail) {
      const stageW = W - spec.railW - padX * 3;
      const availTop = topY + topH + 16;
      const availH = H - availTop - 32;
      const size = Math.max(200, Math.min(stageW - 40, availH - scoreH - gapPill - pillH - gapBoard));
      const boardX = padX + Math.round((stageW - size) / 2);
      const slack = Math.max(0, Math.round((availH - size - scoreH - gapPill - pillH - gapBoard) / 2));
      const stageTop = availTop + slack;
      this.scoreBox = { x: boardX, y: stageTop, w: size, h: scoreH };
      this.pillBox = { y: stageTop + scoreH + gapPill, h: pillH };
      this.board.layout({ x: boardX, y: this.pillBox.y + pillH + gapBoard, size }, boardRows, boardCols);
    } else {
      const slotTop = safeTop + topH + 8;
      const slotBottom = H - safeBottom - 12 - dockH;
      const size = Math.max(160, Math.min(W - 28, slotBottom - slotTop - scoreH - gapPill - pillH - gapBoard));
      const groupH = scoreH + gapPill + pillH + gapBoard + size;
      const groupTop = Math.max(slotTop, slotTop + Math.round((slotBottom - slotTop - groupH) / 2));
      const cardW = Math.min(W - 28, 340);
      this.scoreBox = { x: (W - cardW) / 2, y: groupTop, w: cardW, h: scoreH };
      this.pillBox = { y: groupTop + scoreH + gapPill, h: pillH };
      this.board.layout({
        x: Math.round((W - size) / 2),
        y: this.pillBox.y + pillH + gapBoard,
        size,
      }, boardRows, boardCols);
    }

    // ── 底部 Dock：入口 7 → ≤5，收进单一容器并按 社交 │ 对局 │ 危险 分组 ──
    this.dockGroups = this.buildDockGroups();
    this.dock = layoutDock(W, H, this.dockGroups, { safeBottom });
    this.buttons = this.dock ? this.dock.buttons : [];

    // 结算浮层。结算态下 Dock 会隐藏，这里是唯一入口（消除原来的重复入口）。
    // 「再来一局」按钮的标签与灰态由 session.rematchView() 给出：
    //   - idle          → 「再来一局」
    //   - waiting       → 「等待对手确认…」灰态（已发出邀请）
    //   - peer_left     → 「等待新对手」（点下去服务端把房间退回等待态换人）
    // 返回首页始终可点，作为兜底出口。
    const obw = Math.min(128, (Math.min(300, W - 60) - 44) / 2);
    const rv = typeof s.rematchView === 'function'
      ? s.rematchView()
      : { label: '再来一局', disabled: false, hint: '' };
    this.rematchHint = rv.hint || '';
    // 结算面板几何：ph = 216 比原来多 26pt，用来塞下方提示行
    const ph = 216;
    const py = H / 2 - ph / 2 + 6;
    this.finishPanel = { x: (W - Math.min(300, W - 60)) / 2, y: py, w: Math.min(300, W - 60), h: ph };
    const btnY = py + 152;
    this.overlayButtons = [
      { id: 'again', label: rv.label, kind: 'primary', disabled: !!rv.disabled,
        x: W / 2 - obw - 8, y: btnY, w: obw, h: 48, fontSize: 15 },
      { id: 'home', label: '返回首页', kind: 'ghost',
        x: W / 2 + 8, y: btnY, w: obw, h: 48, fontSize: 15 },
    ];

    this.layoutChat(W, H);

    // 求和弹窗：对手发来求和请求时显示（自己发起的只把按钮置灰，不弹窗）
    const s0 = this.session;
    this.drawModal = null;
    this.drawButtons = [];
    if (
      s0.online
      && s0.drawOfferedBy
      && s0.drawOfferedBy !== s0.mySeat
      && s0.mySeat
      && s0.state?.status === STATUS.PLAYING
    ) {
      const pw = Math.min(280, W - 60);
      const ph = 160;
      this.drawModal = { x: (W - pw) / 2, y: H / 2 - ph / 2, w: pw, h: ph };
      const bw = 100, bh = 44;
      this.drawButtons = [
        { id: 'drawAccept', label: '接受', kind: 'win', x: W / 2 - bw - 8, y: H / 2 + 26, w: bw, h: bh, fontSize: 15 },
        { id: 'drawDecline', label: '拒绝', kind: 'ghost', x: W / 2 + 8, y: H / 2 + 26, w: bw, h: bh, fontSize: 15 },
      ];
    }

    // 小程序码邀请弹窗：面板 + 二维码图片区 + 复制房号/保存按钮。
    // 「复制房号」并入这里——它和分享卡片、小程序码同属"把房间邀约出去"这一个动作，
    // 对局中不必再单独占一个底部入口（底部入口因此从 7 个降到 5 个）。
    {
      const pw = Math.min(300, W - 60);
      const ph = 400;
      this.wxacodeModal = { x: (W - pw) / 2, y: H / 2 - ph / 2, w: pw, h: ph };
      const imgSize = Math.min(180, pw - 64);
      this.wxacodeImageRect = {
        x: W / 2 - imgSize / 2,
        y: this.wxacodeModal.y + 66,
        w: imgSize,
        h: imgSize,
      };
      // 右上角 ✕（与聊天面板一致），点遮罩空白处同样关闭
      this.wxacodeClose = { x: this.wxacodeModal.x + pw - 40, y: this.wxacodeModal.y + 6, w: 34, h: 34 };
      const bw = (pw - 24 - 12) / 2, bh = 46;
      const btnY = this.wxacodeModal.y + ph - bh - 16;
      this.wxacodeButtons = [
        { id: 'copy', label: '复制房号', kind: 'ghost', x: W / 2 - bw - 6, y: btnY, w: bw, h: bh, fontSize: 14 },
        { id: 'copyLink', label: '复制邀请链接', kind: 'primary', x: W / 2 + 6, y: btnY, w: bw, h: bh, fontSize: 14 },
      ];
    }
  }

  /**
   * 组装 Dock 的分组按钮（业务语义在这里，dock.js 只负责画）。
   * 分组固定三类：社交 │ 对局 │ 危险。结算态返回空数组 → Dock 隐藏，只留浮层入口。
   */
  buildDockGroups() {
    const s = this.session;
    const st = s.state;
    if (!st || st.status === STATUS.FINISHED) return [];

    const playing = st.status === STATUS.PLAYING;
    const waiting = st.status === STATUS.WAITING;
    const watching = s.online && s.mySeat === 0;
    const groups = [];

    // 组 1 · 社交：只有联网模式才有邀请/聊天
    if (s.online) {
      const social = [];
      // 等待开场是最需要把房号发出去的时刻，复制房号在这里保留为一等入口
      if (waiting) social.push({ id: 'copy', label: '复制房号', icon: 'copy' });
      // 聊天只有 WebSocket 实时房间支持；异步对局（AsyncSession）没有聊天接口
      if (typeof s.sendChat === 'function' && s.mySeat) {
        social.push({
          id: 'chat', label: '聊天', icon: 'chat',
          badge: (s.chatUnread || 0) > 0 && !this.chatOpen,
        });
      }
      // 对局中空间紧，用 2 字标签；等待开局时按钮宽裕，写全 4 字更明确
      const cta = {
        id: 'share', label: (playing || watching) ? '邀请' : '邀请好友', icon: 'invite',
        kind: (playing || watching) ? 'ghost' : 'primary',
      };
      if (waiting) {
        // 等待开场：复制房号/聊天是辅助动作，邀请好友是主 CTA —— 拆成两组，
        // 用一条分隔线把主按钮的权重单独拎出来
        if (social.length) groups.push(social);
        groups.push([cta]);
      } else {
        social.push(cta);
        groups.push(social);
      }
    }

    // 组 2 · 对局：悔棋 / 求和
    const match = [];
    if (!watching && (playing || !s.online) && s.canUndo && s.canUndo()) {
      match.push({ id: 'undo', label: '悔棋', icon: 'undo' });
    }
    if (s.online && playing && s.mySeat) {
      const offered = s.drawOfferedBy === s.mySeat;
      // 求和等待中：标签保持「求和」不变（避免文字抖动），由图标位的转圈 + 置灰表达进行中
      match.push({
        id: 'draw', label: '求和', icon: 'draw',
        disabled: offered, spinner: offered,
      });
    }
    if (match.length) groups.push(match);

    // 组 3 · 危险：独立在最右，与常规操作之间一定有分隔线
    if (!watching && (!s.online || playing)) {
      groups.push([{
        id: 'resign',
        label: s.online ? '认输' : '重开',
        icon: 'flag',
        kind: 'danger',
      }]);
    }

    return groups;
  }

  /** 计算聊天面板各区域位置（仅联网模式使用，单机关联按钮时也会算但不显示） */
  layoutChat(W, H) {
    const panel = { x: 20, y: Math.max(140, H * 0.28), w: W - 40, h: Math.min(420, H * 0.56) };
    this.chatPanel = panel;

    const headerH = 44;
    const emojiH = 80;
    const inputH = 50;
    const gap = 8;
    this.chatHeader = { x: panel.x, y: panel.y, w: panel.w, h: headerH };
    // 关闭按钮：面板右上角 36×36
    this.chatClose = { x: panel.x + panel.w - 40, y: panel.y + 4, w: 36, h: 36 };
    // 消息列表区域
    this.chatMsgArea = {
      x: panel.x + 8,
      y: panel.y + headerH,
      w: panel.w - 16,
      h: panel.h - headerH - emojiH - inputH - gap * 2,
    };
    // 表情快捷栏：2 行 × 6 列
    this.chatEmojiArea = {
      x: panel.x,
      y: this.chatMsgArea.y + this.chatMsgArea.h + gap,
      w: panel.w,
      h: emojiH,
    };
    const cellW = (panel.w - 24) / 6;
    const cellH = (emojiH - 12) / 2;
    this.chatEmojiBtns = this.chatEmojis.map((emoji, i) => {
      const col = i % 6;
      const row = Math.floor(i / 6);
      return {
        emoji,
        x: panel.x + 12 + col * cellW,
        y: this.chatEmojiArea.y + 6 + row * cellH,
        w: cellW - 6,
        h: cellH - 6,
      };
    });
    // 输入文字按钮
    this.chatInputBtn = {
      x: panel.x + 12,
      y: this.chatEmojiArea.y + emojiH + gap,
      w: panel.w - 24,
      h: inputH - 16,
    };

    // 预计算每条消息的高度（用于滚动与裁剪）
    const msgs = this.session.chatMessages || [];
    this.chatMsgHeights = msgs.map((m) => {
      if (m.emoji) {
        return { total: 56 + 8, bubble: 56, lines: null, emoji: m.emoji };
      }
      const lines = wrapChatText(m.text || '', 14);
      return { total: lines.length * 18 + 20 + 14 + 8, bubble: lines.length * 18 + 20, lines, emoji: null };
    });
    this.chatContentH = this.chatMsgHeights.reduce((a, b) => a + b.total, 0);
    this.chatMaxScroll = Math.max(0, this.chatContentH - this.chatMsgArea.h);
    this.chatScroll = Math.max(0, Math.min(this.chatMaxScroll, this.chatScroll));
  }

  render(ctx, W, H) {
    const s = this.session;
    const st = s.state;
    this.layout(W, H);

    this.renderTopBar(ctx, W);
    if (st) {
      this.renderScoreCard(ctx, s);
      const pill = this.statusPill();
      if (pill) {
        drawStatusPill(ctx, W / 2, this.pillBox.y + this.pillBox.h / 2, pill.text, pill.color);
      }
    }

    this.board.render(ctx, st, { lastEdge: s.lastMoveEdge(), interactive: s.canPlay() });

    // 底部操作区：结算态 this.dock 为 null → 只剩浮层入口，不再出现两套按钮
    if (this.dock) {
      const badges = [];
      for (const b of this.dock.buttons) if (b.badge) badges.push(b.id);
      drawDock(ctx, this.dock, { pressedId: this.pressedId, badgeIds: badges });
    }

    // 等待好友：显示大房间号
    if (s.online && st && st.status === STATUS.WAITING) {
      const box = this.board.box;
      fillRoundRect(ctx, box.x, box.y, box.size, box.size, 18, 'rgba(15,18,24,.92)');
      strokeRoundRect(ctx, box.x, box.y, box.size, box.size, 18, COLORS.line, 1);
      const cx = box.x + box.size / 2;
      const cy = box.y + box.size / 2;
      drawText(ctx, '把房间号发给好友', cx, cy - 52, { size: 15, color: COLORS.sub, align: 'center', baseline: 'middle' });
      drawText(ctx, s.roomId, cx, cy - 8, { size: 40, bold: true, color: COLORS.text, align: 'center', baseline: 'middle' });
      // 提示文案按棋盘宽度反算字号并手工折成两行，窄屏也不会溢出棋盘
      const tipLines = s.visibility === 'friends'
        ? ['仅好友可见：不在大厅显示', '发卡片 / 房号 / 小程序码邀好友']
        : ['陌生人可从「房间列表」加入', '也可发卡片邀好友'];
      const maxW = box.size - 32;
      tipLines.forEach((line, i) => {
        const fit = fitLabel(ctx, line, maxW, { max: 13, min: 10 });
        drawText(ctx, fit.text, cx, cy + 44 + i * 20, {
          size: fit.size, color: COLORS.sub, align: 'center', baseline: 'middle',
        });
      });
    }

    // 观战提示已并入状态胶囊（原位置 H-112 现在被 Dock 占用）

    // 结算浮层
    if (st && st.status === STATUS.FINISHED) {
      ctx.fillStyle = 'rgba(8,10,14,.72)';
      ctx.fillRect(0, 0, W, H);
      const pw = Math.min(300, W - 60);
      const ph = 216;
      const px = (W - pw) / 2;
      const py = H / 2 - ph / 2 + 6;
      fillRoundRect(ctx, px, py, pw, ph, 18, COLORS.panel);
      strokeRoundRect(ctx, px, py, pw, ph, 18, COLORS.line, 1);

      const myScore = s.mySeat === 2 ? st.scores[1] : st.scores[0];
      const opScore = s.mySeat === 2 ? st.scores[0] : st.scores[1];
      // 观战者（mySeat=0）不参与胜负，展示阵营结果
      const title = st.winner === 3 ? '平局'
        : (s.online && !s.mySeat) ? (st.winner === 1 ? '红方获胜' : '蓝方获胜')
        : (myScore > opScore ? '你赢了' : '你输了');
      drawText(ctx, title, W / 2, py + 48, { size: 26, bold: true, align: 'center', baseline: 'middle', color: COLORS.text });
      drawText(ctx, `${st.scores[0]} : ${st.scores[1]}`, W / 2, py + 88, { size: 22, align: 'center', baseline: 'middle', color: COLORS.sub });
      // 「再来一局」协商提示（waiting / peer_left / peer 想再开）；没提示就不画
      if (this.rematchHint) {
        const fit = fitLabel(ctx, this.rematchHint, pw - 32, { max: 12, min: 10 });
        drawText(ctx, fit.text, W / 2, py + 124, {
          size: fit.size, color: COLORS.sub, align: 'center', baseline: 'middle',
        });
      }
      for (const b of this.overlayButtons) drawButton(ctx, b, { disabled: b.disabled });
    }

    // 求和请求弹窗
    if (this.drawModal) {
      ctx.fillStyle = 'rgba(8,10,14,.72)';
      ctx.fillRect(0, 0, W, H);
      const m = this.drawModal;
      fillRoundRect(ctx, m.x, m.y, m.w, m.h, 18, COLORS.panel);
      strokeRoundRect(ctx, m.x, m.y, m.w, m.h, 18, COLORS.line, 1);
      drawText(ctx, '对手请求求和', W / 2, m.y + 52, {
        size: 20, bold: true, align: 'center', baseline: 'middle', color: COLORS.text,
      });
      drawText(ctx, '同意则本局判平局', W / 2, m.y + 88, {
        size: 13, align: 'center', baseline: 'middle', color: COLORS.sub,
      });
      for (const b of this.drawButtons) drawButton(ctx, b);
    }

    // 小程序码邀请弹窗
    if (this.wxacodeOpen) {
      ctx.fillStyle = 'rgba(8,10,14,.72)';
      ctx.fillRect(0, 0, W, H);
      const m = this.wxacodeModal;
      fillRoundRect(ctx, m.x, m.y, m.w, m.h, 18, COLORS.panel);
      strokeRoundRect(ctx, m.x, m.y, m.w, m.h, 18, COLORS.line, 1);
      drawText(ctx, '邀请好友', W / 2, m.y + 30, {
        size: 18, bold: true, align: 'center', baseline: 'middle', color: COLORS.text,
      });
      // 右上角关闭 ✕（与聊天面板一致），底部的两个位置留给复制
      const cb = this.wxacodeClose;
      fillRoundRect(ctx, cb.x, cb.y, cb.w, cb.h, 10, COLORS.line);
      drawText(ctx, '✕', cb.x + cb.w / 2, cb.y + cb.h / 2 + 1, {
        size: 16, color: COLORS.text, align: 'center', baseline: 'middle',
      });
      // 链接卡片区（web 版替代二维码）：白底衬链接文字，过长自动换行
      const ir = this.wxacodeImageRect;
      fillRoundRect(ctx, ir.x, ir.y, ir.w, ir.h, 10, '#ffffff');
      if (this.wxacodeError) {
        drawText(ctx, '链接生成失败', W / 2, ir.y + ir.h / 2, {
          size: 14, align: 'center', baseline: 'middle', color: '#ff6b6b',
        });
      } else if (this.wxacodeLink) {
        const lines = wrapInviteLink(this.wxacodeLink, ir.w - 24);
        const lineH = 18;
        const total = lines.length * lineH;
        let y = ir.y + ir.h / 2 - total / 2 + lineH / 2;
        for (const line of lines) {
          drawText(ctx, line, W / 2, y, {
            size: 12, align: 'center', baseline: 'middle', color: COLORS.sub,
          });
          y += lineH;
        }
        drawText(ctx, '好友打开链接即可加入对局', W / 2, ir.y + ir.h - 14, {
          size: 10, align: 'center', baseline: 'middle', color: '#8b93a3',
        });
      } else {
        drawText(ctx, '生成中…', W / 2, ir.y + ir.h / 2, {
          size: 14, align: 'center', baseline: 'middle', color: COLORS.sub,
        });
      }
      // 房间号大字
      drawText(ctx, s.roomId || '', W / 2, ir.y + ir.h + 36, {
        size: 28, bold: true, align: 'center', baseline: 'middle', color: COLORS.text,
      });
      for (const b of this.wxacodeButtons) drawButton(ctx, b);
    }

    if (this.chatOpen) this.renderChat(ctx, W, H);
  }

  /* ---------------- 顶栏 / 计分板 / 状态胶囊 ---------------- */

  /** 顶栏：返回 chevron + 房间号(+仅好友可见标签) + 倒计时 chip（避让微信胶囊） */
  renderTopBar(ctx, W) {
    const s = this.session;
    const tb = this.topBar;
    const b = this.backBtn;

    // 返回：从底栏移到左上角（属于导航，不再占据宝贵的操作位）
    const pressed = this.pressedId === 'home';
    fillRoundRect(ctx, b.x, b.y, b.w, b.h, 12,
      pressed ? COLORS.btnPressed : 'rgba(255,255,255,.05)');
    strokeRoundRect(ctx, b.x, b.y, b.w, b.h, 12,
      pressed ? COLORS.btnPressedStroke : COLORS.btnStroke, 1);
    drawDockIcon(ctx, 'back', b.x + b.w / 2, b.y + b.h / 2, 19, COLORS.text);

    const roomText = s.online ? `房间 ${s.roomId}` : '单机练习';
    const roomSize = 15;
    drawText(ctx, roomText, this.roomTextX, tb.cy, {
      size: roomSize, color: COLORS.text, baseline: 'middle',
    });

    // 倒计时 chip：右边界已按微信胶囊左边界算好，窄屏也不会叠上去
    const st = s.state;
    if (st && st.status === STATUS.PLAYING && s.turnDeadline) {
      const remain = Math.max(0, Math.ceil((s.turnDeadline - Date.now()) / 1000));
      const urgent = remain <= 10;
      const label = `${remain}s`;
      const chip = this.drawChip(ctx, this.chipRight, tb.cy, label, urgent);
      this.chipLeft = chip.x;
    } else {
      this.chipLeft = W;
    }

    // 「仅好友可见」标签：跟在房间号后面，与倒计时 chip 冲突时让位
    if (s.online && s.visibility === 'friends' && W >= 375) {
      const tagText = '仅好友可见';
      const tagFont = '10px -apple-system, "PingFang SC", sans-serif';
      ctx.font = `${roomSize}px -apple-system, "PingFang SC", sans-serif`;
      const roomW = ctx.measureText(roomText).width;
      ctx.font = tagFont;
      const tagW = ctx.measureText(tagText).width;
      const tagH = 16;
      const tagX = this.roomTextX + roomW + 8;
      if (tagX + tagW + 14 < this.chipLeft - 8) {
        fillRoundRect(ctx, tagX, tb.cy - tagH / 2, tagW + 12, tagH, 8, 'rgba(90,169,255,.18)');
        drawText(ctx, tagText, tagX + (tagW + 12) / 2, tb.cy, {
          size: 10, color: COLORS.p2, align: 'center', baseline: 'middle',
        });
      }
    }
  }

  /** 圆角信息 chip（倒计时）。返回绘制矩形，便于外部避让 */
  drawChip(ctx, right, cy, label, urgent) {
    const size = 12;
    ctx.font = `${urgent ? 'bold ' : ''}${size}px -apple-system, "PingFang SC", sans-serif`;
    const tw = ctx.measureText(label).width;
    const w = tw + 24;
    const h = 26;
    const x = right - w;
    const y = cy - h / 2;
    fillRoundRect(ctx, x, y, w, h, h / 2, urgent ? 'rgba(255,92,92,.16)' : 'rgba(255,255,255,.05)');
    strokeRoundRect(ctx, x, y, w, h, h / 2, urgent ? 'rgba(255,92,92,.45)' : COLORS.btnStroke, 1);
    drawText(ctx, label, x + w / 2, cy + 0.5, {
      size, bold: urgent, color: urgent ? COLORS.dangerText : COLORS.sub,
      align: 'center', baseline: 'middle',
    });
    return { x, y, w, h };
  }

  /**
   * 计分板：双人卡片（头像圈 + 阵营名 + 比分 + 领地进度条）。
   * 进度条让"谁领先"一眼可见，比纯数字更适合观战与复盘。
   */
  renderScoreCard(ctx, s) {
    const st = s.state;
    if (!st) return;
    const box = this.scoreBox;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const contentW = Math.min(box.w, 340);
    const left = cx - contentW / 2;
    const right = cx + contentW / 2;

    const r = 17, gap = 9, barW = 76, barH = 4;
    const total = Math.max(1, (st.rows || 1) * (st.cols || 1));

    const drawSide = (seat) => {
      const color = seat === 1 ? COLORS.p1 : COLORS.p2;
      const name = seat === 1 ? '红方' : '蓝方';
      const score = st.scores[seat - 1] || 0;
      const ratio = Math.max(0, Math.min(1, score / total));
      const mine = s.mySeat === seat || (!s.online && seat === 1);
      const mirrored = seat === 2;
      // 对手掉线时在名字后面挂「断线」标记，一眼能看出是哪一方掉线
      const offline = typeof s.seatOffline === 'function' && s.seatOffline(seat);
      const label = offline ? `${name} · 断线` : name;
      const labelColor = offline ? '#f0b429' : color;

      const boxX = mirrored ? right - r * 2 : left;
      fillRoundRect(ctx, boxX, cy - r, r * 2, r * 2, r, withAlpha(color, 0.18));
      strokeRoundRect(ctx, boxX, cy - r, r * 2, r * 2, r, withAlpha(color, mine ? 0.85 : 0.5), mine ? 1.6 : 1);
      drawText(ctx, seat === 1 ? '红' : '蓝', boxX + r, cy + 0.5, {
        size: 13, color, align: 'center', baseline: 'middle', bold: mine,
      });

      // 文字列：阵营名（11）+ 比分（22）+ 领地条（76×4），整体垂直居中
      const metaX = mirrored ? boxX - gap - barW : boxX + r * 2 + gap;
      const textX = mirrored ? metaX + barW : metaX;
      const align = mirrored ? 'right' : 'left';
      drawText(ctx, label, textX, cy - 18, {
        size: 11, color: labelColor, align, baseline: 'middle',
      });
      drawText(ctx, String(score), textX, cy - 1, {
        size: 22, color, align, baseline: 'middle', bold: true,
      });
      const barY = cy + 14.5;
      fillRoundRect(ctx, metaX, barY, barW, barH, barH / 2, 'rgba(255,255,255,.09)');
      const fillW = ratio * barW;
      if (fillW > 0.5) {
        fillRoundRect(ctx, mirrored ? metaX + barW - fillW : metaX, barY,
          Math.max(2, fillW), barH, barH / 2, color);
      }
    };

    drawSide(1);
    drawSide(2);
    drawText(ctx, ':', cx, cy - 4, { size: 18, color: COLORS.sub, align: 'center', baseline: 'middle' });
  }

  /** 状态胶囊文案：把「你是蓝方」和「轮到你落子」合成一条，并带上当前轮次语义 */
  statusPill() {
    const s = this.session;
    const st = s.state;
    if (!st) return { text: s.statusText(), color: COLORS.sub };
    if (st.status === STATUS.FINISHED) return { text: '本局结束', color: COLORS.sub };
    // 对手掉线优先于「轮到谁」：这是玩家此刻最需要知道的事
    if (typeof s.opponentOffline === 'function' && s.opponentOffline()) {
      return { text: '对手已断线，等待重连…', color: '#f0b429' };
    }
    if (st.status === STATUS.WAITING) return { text: '等待好友加入…', color: '#f0b429' };
    if (s.online && !s.mySeat) return { text: '观战中 · 等待对局结束', color: COLORS.sub };
    const seat = s.online
      ? (s.mySeat === 1 ? '你是红方' : '你是蓝方')
      : `你是红方（${s.firstPlayer === 2 ? '后手' : '先手'}）`;
    const myTurn = st.turn === s.mySeat;
    return { text: `${seat} · ${s.statusText()}`, color: myTurn ? COLORS.win : COLORS.sub };
  }

  /** 绘制聊天面板（遮罩 + 面板 + 消息列表 + 表情栏 + 输入按钮） */
  renderChat(ctx, W, H) {
    const s = this.session;
    // 新消息自动滚到底部
    const msgCount = (s.chatMessages || []).length;
    if (msgCount !== this.chatLastMsgCount) {
      this.chatLastMsgCount = msgCount;
      this.chatScroll = this.chatMaxScroll;
    }

    // 半透明遮罩
    ctx.fillStyle = 'rgba(0,0,0,.5)';
    ctx.fillRect(0, 0, W, H);

    const panel = this.chatPanel;
    fillRoundRect(ctx, panel.x, panel.y, panel.w, panel.h, 18, COLORS.panel);
    strokeRoundRect(ctx, panel.x, panel.y, panel.w, panel.h, 18, COLORS.line, 1);

    // 面板标题
    drawText(ctx, '聊天', panel.x + panel.w / 2, panel.y + 22, {
      size: 16, bold: true, align: 'center', baseline: 'middle', color: COLORS.text,
    });
    // 关闭按钮
    fillRoundRect(ctx, this.chatClose.x, this.chatClose.y, this.chatClose.w, this.chatClose.h, 10, COLORS.line);
    drawText(ctx, '✕', this.chatClose.x + this.chatClose.w / 2, this.chatClose.y + this.chatClose.h / 2 + 1, {
      size: 16, color: COLORS.text, align: 'center', baseline: 'middle',
    });

    // 消息列表（裁剪）
    const area = this.chatMsgArea;
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();

    const msgs = s.chatMessages || [];
    const baseTop = area.y + area.h - this.chatContentH;
    let y = baseTop - this.chatScroll;
    const bubbleMaxW = area.w - 80;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const h = this.chatMsgHeights[i];
      const isMine = m.seat === s.mySeat && !!m.seat;
      const nickText = m.nick || (m.seat ? `玩家${m.seat}` : '玩家');

      if (!m.emoji) {
        // 文字消息
        if (!isMine) {
          drawText(ctx, nickText, area.x + 6, y + 8, { size: 11, color: COLORS.sub, baseline: 'middle' });
        }
        y += isMine ? 0 : 14;
        const lineH = 18;
        const bubbleH = h.bubble;
        // 估算气泡宽度（按最长行）
        let maxLineLen = 0;
        for (const ln of h.lines) if (ln.length > maxLineLen) maxLineLen = ln.length;
        const bubbleW = Math.min(bubbleMaxW, Math.max(60, maxLineLen * 14 + 20));
        const bx = isMine ? area.x + area.w - bubbleW - 6 : area.x + 6;
        fillRoundRect(ctx, bx, y, bubbleW, bubbleH, 10, isMine ? COLORS.accent : COLORS.bg);
        const lineColor = isMine ? '#ffffff' : COLORS.text;
        h.lines.forEach((ln, li) => {
          drawText(ctx, ln, bx + 10, y + 12 + li * lineH, { size: 13, color: lineColor, baseline: 'middle' });
        });
        y += bubbleH + 8;
      } else {
        // 表情包消息
        if (!isMine) {
          drawText(ctx, nickText, area.x + 6, y + 8, { size: 11, color: COLORS.sub, baseline: 'middle' });
        }
        y += isMine ? 0 : 14;
        const bubbleW = 64;
        const bx = isMine ? area.x + area.w - bubbleW - 6 : area.x + 6;
        fillRoundRect(ctx, bx, y, bubbleW, 56, 10, isMine ? COLORS.accent : COLORS.bg);
        drawText(ctx, m.emoji, bx + bubbleW / 2, y + 29, { size: 36, align: 'center', baseline: 'middle' });
        y += 56 + 8;
      }
    }
    ctx.restore();

    // 滚动条：仅当内容超出可视区域时显示
    if (this.chatMaxScroll > 0) {
      const trackW = 4;
      const trackX = area.x + area.w - trackW - 2;
      const trackY = area.y + 4;
      const trackH = area.h - 8;
      // 轨道
      fillRoundRect(ctx, trackX, trackY, trackW, trackH, trackW / 2, 'rgba(255,255,255,.06)');
      // 滑块
      const thumbH = Math.max(24, trackH * (area.h / this.chatContentH));
      const thumbY = trackY + (this.chatScroll / this.chatMaxScroll) * (trackH - thumbH);
      fillRoundRect(ctx, trackX, thumbY, trackW, thumbH, trackW / 2, 'rgba(255,255,255,.22)');
    }

    // 消息区边框提示
    strokeRoundRect(ctx, area.x, area.y, area.w, area.h, 8, COLORS.line, 1);

    // 表情快捷栏
    for (const e of this.chatEmojiBtns) {
      fillRoundRect(ctx, e.x, e.y, e.w, e.h, 10, COLORS.bg);
      strokeRoundRect(ctx, e.x, e.y, e.w, e.h, 10, COLORS.line, 1);
      drawText(ctx, e.emoji, e.x + e.w / 2, e.y + e.h / 2 + 1, {
        size: 24, align: 'center', baseline: 'middle',
      });
    }

    // 输入文字按钮
    fillRoundRect(ctx, this.chatInputBtn.x, this.chatInputBtn.y, this.chatInputBtn.w, this.chatInputBtn.h, 12, COLORS.bg);
    strokeRoundRect(ctx, this.chatInputBtn.x, this.chatInputBtn.y, this.chatInputBtn.w, this.chatInputBtn.h, 12, COLORS.line, 1);
    drawText(ctx, '输入文字…', this.chatInputBtn.x + 16, this.chatInputBtn.y + this.chatInputBtn.h / 2 + 1, {
      size: 14, color: COLORS.sub, baseline: 'middle',
    });
  }

  /** 处理聊天面板内的点击；命中返回 true（调用方应直接 return，不继续走棋盘/按钮） */
  handleChatTap(x, y) {
    if (inRect(this.chatClose, x, y)) { this.chatOpen = false; return true; }
    for (const e of this.chatEmojiBtns) {
      if (inRect(e, x, y)) { this.session.sendChat?.({ emoji: e.emoji }); return true; }
    }
    if (inRect(this.chatInputBtn, x, y)) {
      wx.showModal({
        title: '发送消息',
        placeholderText: '输入聊天内容',
        editable: true,
        success: (res) => { if (res.confirm && res.content) this.session.sendChat?.({ text: String(res.content).trim() }); },
      });
      return true;
    }
    // 点在面板外（遮罩）→ 关闭面板
    if (!inRect(this.chatPanel, x, y)) { this.chatOpen = false; return true; }
    return false;
  }

  /** 处理小程序码弹窗内的点击；命中返回 true（调用方应直接 return） */
  handleWxacodeTap(x, y) {
    if (this.wxacodeClose && inRect(this.wxacodeClose, x, y)) { this.wxacodeOpen = false; return true; }
    for (const b of this.wxacodeButtons) {
      if (inRect(b, x, y)) { this.onButton(b.id); return true; }
    }
    // 点遮罩空白处 → 关闭弹窗
    if (!inRect(this.wxacodeModal, x, y)) { this.wxacodeOpen = false; return true; }
    return false;
  }

  /** 打开邀请弹窗（web 版：生成邀请链接卡片替代小程序码） */
  openWxacode() {
    if (!this.session.roomId) return;
    this.wxacodeOpen = true;
    this.wxacodeError = false;
    this.wxacodeLink = '';
    const link = buildInviteLink(this.session.roomId);
    if (!link) { this.wxacodeError = true; return; }
    this.wxacodeLink = link;
  }

  /** 复制邀请链接 */
  copyInviteLink() {
    const roomId = this.session.roomId;
    if (!roomId) return;
    const link = buildInviteLink(roomId) || roomId;
    if (typeof wx.setClipboardData === 'function') {
      wx.setClipboardData({ data: link });
    }
  }

  /** 网页端分享/进房链接：同源 ?room=XXXX */
  getInviteLink() {
    return buildInviteLink(this.session.roomId || '');
  }

  onTap(x, y) {
    // 小程序码弹窗打开时：只接受弹窗内点击
    if (this.wxacodeOpen) { this.handleWxacodeTap(x, y); return; }
    // 聊天面板打开时：优先处理面板内点击，命中则不再走棋盘/底部按钮
    if (this.chatOpen) {
      if (this.handleChatTap(x, y)) return;
      return; // 消息区域的点击交给 onTouchStart 的拖拽处理；此处兜底不穿透
    }
    const s = this.session;
    const finished = s.state && s.state.status === STATUS.FINISHED;
    // 求和弹窗优先：弹窗打开时只接受接受/拒绝
    if (this.drawModal) {
      for (const b of this.drawButtons) if (inRect(b, x, y)) return this.onButton(b.id);
      return;
    }
    if (finished) {
      for (const b of this.overlayButtons) {
        // 已置灰的按钮（等待对手确认中）不响应点击，避免重复发出邀请
        if (b.disabled) continue;
        if (inRect(b, x, y)) return this.onButton(b.id);
      }
      return;
    }
    // 顶栏返回 + 底部 Dock（兜底路径：正常流程由 onTouchStart/End 走按压态派发）
    if (inRect(this.backBtn, x, y)) return this.onButton('home');
    const hit = hitDock(this.dock, x, y);
    if (hit) return this.onButton(hit.id);
    if (!s.canPlay()) return;
    const edge = this.board.hitTest(x, y, s.state);
    if (edge) s.play(edge);
  }

  /** 按坐标找 Dock / 顶栏返回按钮（统一命中口径，避免视觉与热区不一致） */
  hitAction(x, y) {
    const hit = hitDock(this.dock, x, y);
    if (hit) return hit;
    if (this.backBtn && inRect(this.backBtn, x, y)) {
      return { ...this.backBtn, kind: 'nav' };
    }
    return null;
  }

  onButton(id) {
    const s = this.session;
    if (id === 'home') return this.app.goHome();
    if (id === 'share') return this.openWxacode();
    if (id === 'copy') return this.app.copyRoom();
    if (id === 'copyLink') return this.copyInviteLink();
    if (id === 'wxClose') { this.wxacodeOpen = false; return; }
    if (id === 'chat') {
      this.chatOpen = true;
      this.chatScroll = 0; // 打开时先定位，renderChat 里会按新消息数滚到底
      if (s.clearChatUnread) s.clearChatUnread();
      return;
    }
    if (id === 'again') {
      // 本地 / 异步两种 session 已在 rematchView 里处理灰态；
      // 这里只需把按钮点击转换成具体请求；失败时（断网/已邀请中）给一句提示，
      // 避免点完「没反应」的卡死体验。
      const ok = s.reset();
      if (!ok && s.online) toast('暂时无法再来一局，请稍后再试');
      return;
    }
    if (id === 'undo') return s.undo();
    if (id === 'draw') return s.offerDraw();
    if (id === 'drawAccept') return s.acceptDraw();
    if (id === 'drawDecline') return s.declineDraw();
    if (id === 'resign') {
      if (!s.online) return s.reset();
      wx.showModal({
        title: '确认认输？',
        content: '认输后本局立即结束',
        success: (res) => { if (res.confirm) s.resign(); },
      });
    }
  }

  /**
   * 按下：
   *  - 弹窗 / 结算浮层：不做按压态，按原有 onTap 派发；
   *  - 顶栏返回 / 底部 Dock：进入按压态并立刻给震动 + 音效（按下即反馈），
   *    抬起时若仍在同一热区内才真正派发动作 —— 滑出可取消；
   *  - 其余（棋盘）：交回 onTap。
   */
  onTouchStart(x, y) {
    if (this.wxacodeOpen) { this.pressedId = null; this.handleWxacodeTap(x, y); return; }
    if (this.chatOpen) {
      this.pressedId = null;
      if (this.handleChatTap(x, y)) return;
      // 消息区域：记录拖拽起点用于滚动
      if (inRect(this.chatMsgArea, x, y)) {
        this.chatDrag = { startY: y, startScroll: this.chatScroll, moved: false };
      } else {
        // 面板内其他空白处：关闭面板
        this.chatOpen = false;
      }
      return;
    }
    const st = this.session.state;
    if (this.drawModal || (st && st.status === STATUS.FINISHED)) {
      this.pressedId = null;
      this.onTap(x, y);
      return;
    }
    const hit = this.hitAction(x, y);
    if (hit && !hit.disabled) {
      this.pressedId = hit.id;
      sound.tap();
      if (hit.kind === 'danger') sound.vibrate('medium');
      else sound.vibrate('light');
      return;
    }
    this.pressedId = null;
    this.onTap(x, y);
  }

  onTouchMove(x, y) {
    if (this.chatDrag) {
      const dy = y - this.chatDrag.startY;
      if (Math.abs(dy) > 8) this.chatDrag.moved = true;
      if (this.chatDrag.moved) {
        this.chatScroll = Math.max(0, Math.min(this.chatMaxScroll, this.chatDrag.startScroll - dy));
      }
      return;
    }
    // 按下后滑出热区 → 取消高亮，且不触发动作
    if (this.pressedId) {
      const hit = this.hitAction(x, y);
      if (!hit || hit.id !== this.pressedId) this.pressedId = null;
    }
  }

  onTouchEnd(x, y) {
    if (this.chatDrag) { this.chatDrag = null; return; }
    if (!this.pressedId) return;
    const id = this.pressedId;
    this.pressedId = null;
    const hit = this.hitAction(x, y);
    if (hit && hit.id === id) this.onButton(id);
  }

  destroy() {
    this.session.destroy();
  }
}

export { toast };

/* ---------------- web 版邀请链接（替代微信小程序码） ---------------- */

/** 生成同源邀请链接：{origin}{path}?room=XXXX（深链进房复用 app.js 的启动 query 解析） */
function buildInviteLink(roomId) {
  if (!roomId || typeof location === 'undefined') return '';
  return `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`;
}

/** 邀请链接卡片内换行（按字符宽度估算，链接多为等宽/半角字符） */
function wrapInviteLink(text, maxPx) {
  const charW = 6.6; // 12px 字号下平均字符宽度
  const maxChars = Math.max(6, Math.floor(maxPx / charW));
  const out = [];
  let cur = '';
  for (const ch of text) {
    if (cur.length >= maxChars) {
      out.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}
