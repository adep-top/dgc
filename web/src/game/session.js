import * as core from './core/index.js';
import { CONFIG } from './config.js';
import { C2S, S2C } from './core/protocol.js';
import { sound } from './sound.js';
import * as api from './net/api.js';

const STATUS = core.STATUS;

/**
 * 对局会话。GameScene 只跟这个接口打交道：
 *   state / mySeat / canPlay() / play(edge) / statusText() / reset() / resign() / destroy()
 * 人机和联网对战共用同一套渲染与交互。
 */

// 「再来一局」客户端超过这么久没收到服务端回复就当作超时，把按钮切到「等待新对手」；
// 必须比服务端的 REMATCH_TTL_MS 略大一点点，给服务端先开口的机会。
const REMATCH_CONFIRM_TIMEOUT_MS = 50 * 1000;

class BaseSession {
  constructor() {
    this.listeners = [];
    this.lastError = null;
    // 当前回合落子截止时间戳（仅对局中有效）；客户端只用于显示倒计时
    this.turnDeadline = null;
    // 求和状态：null | 0 无人发起；>0 表示发起方 seat（等于自己即等待对方回应）
    this.drawOfferedBy = null;
    // 对手掉线的座位号（0 = 对手在线/未入座）；用于「对手已断线，等待重连…」提醒
    this.peerOfflineSeat = 0;
    // 双方玩家（含 online 标记），联网会话从服务端快照/PEER 事件维护
    this.players = [];
  }
  onChange(cb) {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter((f) => f !== cb); };
  }
  emit() {
    for (const cb of this.listeners) cb(this);
  }
  /** 对手座位（观战 / 单机为 0） */
  opponentSeat() {
    if (!this.online || !this.mySeat) return 0;
    return this.mySeat === 1 ? 2 : 1;
  }
  /**
   * 某座位是否已断线。
   * 只认「座位上确实有人」的情况（uid 非空），否则等待中的空座位会被误报成断线。
   */
  seatOffline(seat) {
    if (!this.online || !seat) return false;
    const p = (this.players || []).find((x) => x.seat === seat);
    if (p && p.uid && typeof p.online === 'boolean') return !p.online;
    return this.peerOfflineSeat === seat;
  }
  /** 对手是否掉线（对局中才有意义） */
  opponentOffline() {
    const seat = this.opponentSeat();
    return !!seat && this.seatOffline(seat);
  }
  canPlay() {
    return this.state && this.state.status === STATUS.PLAYING && this.state.turn === this.mySeat;
  }
  /** 是否可悔棋：对局中且至少有一步可回退。异步对战默认不支持。 */
  canUndo() {
    return !!(this.state && this.state.status === STATUS.PLAYING && this.state.moves && this.state.moves.length);
  }
  /** 悔棋 / 求和：联网与本地由子类实现，异步对战返回 false */
  undo() { return false; }
  offerDraw() { return false; }
  acceptDraw() { return false; }
  declineDraw() { return false; }
  statusText() {
    if (!this.state) return '连接中…';
    if (this.state.status === STATUS.WAITING) return '等待对手加入…';
    if (this.state.status === STATUS.FINISHED) return '本局结束';
    return this.state.turn === this.mySeat ? '轮到你落子' : '对手思考中…';
  }
  lastMoveEdge() {
    const m = this.state && this.state.moves[this.state.moves.length - 1];
    return m ? m.edge : null;
  }
  /**
   * 结算浮层「再来一局」按钮呈现（由 GameScene 据此画按钮文字/灰态/提示）。
   * 子类按场景实现：本地单机立刻可重玩；联网等协商结果；异步暂不支持。
   */
  rematchView() {
    return { label: '再来一局', disabled: false, hint: '' };
  }
}

/** 本地人机：不需要服务器。firstPlayer=1 玩家先手，=2 AI 先手 */
export class LocalSession extends BaseSession {
  constructor({ rows = CONFIG.defaultSize, cols = CONFIG.defaultSize, level = CONFIG.aiLevel, firstPlayer = 1 } = {}) {
    super();
    this.rows = rows;
    this.cols = cols;
    this.level = level;
    this.firstPlayer = firstPlayer;
    this.mySeat = 1;
    this.online = false;
    this.roomId = null;
    this.state = core.startGame(core.createGame({ rows, cols, firstPlayer }));
    this.timer = null;
    this.turnDeadline = Date.now() + CONFIG.turnTimeoutMs;
    if (firstPlayer === 2) this.scheduleBot();
  }

  play(edge) {
    if (!this.canPlay()) return false;
    const r = core.applyMove(this.state, this.mySeat, edge);
    if (!r.ok) return false;
    sound.move();
    sound.vibrate();
    if (r.gained.length) sound.gain();
    this.state = r.state;
    this.turnDeadline = Date.now() + CONFIG.turnTimeoutMs;
    if (r.finished) this._soundFinish(r.winner);
    this.emit();
    if (this.state.status === STATUS.PLAYING && this.state.turn === 2) this.scheduleBot();
    return true;
  }

  scheduleBot() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const edge = core.pickMove(this.state, this.level);
      const r = core.applyMove(this.state, 2, edge);
      if (r.ok) {
        sound.move();
        if (r.gained.length) sound.gain();
        this.state = r.state;
        this.turnDeadline = Date.now() + CONFIG.turnTimeoutMs;
        if (r.finished) this._soundFinish(r.winner);
        this.emit();
        if (this.state.status === STATUS.PLAYING && this.state.turn === 2) this.scheduleBot();
      }
    }, CONFIG.aiDelayMs);
  }

  /**
   * 本地人机悔棋：连续回退直到重新轮到玩家（seat 1）。
   * 若最后一步是 AI 走的，就把 AI 那步和玩家上一步一起撤掉，让玩家重走。
   */
  undo() {
    if (!this.canUndo()) return false;
    clearTimeout(this.timer);
    let guard = 0;
    while (this.state.moves.length && guard++ < 12) {
      this.state = core.undoMove(this.state);
      if (this.state.turn === this.mySeat) break;
    }
    this.turnDeadline = Date.now() + CONFIG.turnTimeoutMs;
    this.emit();
    return true;
  }

  reset() {
    clearTimeout(this.timer);
    this.state = core.startGame(core.createGame({ rows: this.rows, cols: this.cols, firstPlayer: this.firstPlayer }));
    this.turnDeadline = Date.now() + CONFIG.turnTimeoutMs;
    if (this.firstPlayer === 2) this.scheduleBot();
    this.emit();
    return true;
  }

  resign() {
    clearTimeout(this.timer);
    this.state = { ...core.cloneState(this.state), status: STATUS.FINISHED, winner: 2 };
    sound.lose();
    this.emit();
  }

  /** 玩家红方（seat 1）：win=1 玩家赢，win=3 平局，否则输 */
  _soundFinish(winner) {
    if (winner === 3) sound.finish(null);
    else sound.finish(winner === this.mySeat);
  }

  destroy() {
    clearTimeout(this.timer);
  }
}

/** 联网对战：状态以服务端为准，本地用同一套引擎推演做表现 */
export class RemoteSession extends BaseSession {
  constructor(client, { roomId, onFinish } = {}) {
    super();
    this.client = client;
    this.roomId = roomId;
    this.onFinish = onFinish || null;   // 终局回调（用于上传积分到微信云存储）
    this._finishNotified = false;       // 一局只通知一次
    this.online = true;
    this.mySeat = 0;
    this.state = null;
    this.players = [];
    this.round = 1;
    // 房间可见性：'public' | 'friends'；从服务端快照读取，默认公开
    this.visibility = 'public';
    this.connection = 'connecting';
    this.peerEvent = null;
    // 聊天消息列表（最多保留最近 50 条）与未读计数
    this.chatMessages = [];
    this.chatUnread = 0;
    // ── 结算后的「再来一局」协商状态 ──
    //   rematchState: 'idle' 还没发起 / 'waiting' 已发出邀请 / 'peer_left' 对手不可用，可换人
    //   peerWantsRematch: 对手已发起邀请（点自己这边的按钮即可开局）
    //   peerLeft:         对手主动离开（点返回首页 / 关游戏）；按钮自动变成「等待新对手」
    //   rematchHint:      结算浮层按钮下方的提示文案（按 rematchState 推导，也可被服务端覆盖）
    this.rematchState = 'idle';
    this.rematchPeerOnline = null;
    this.peerWantsRematch = false;
    this.peerLeft = false;
    this.rematchHint = '';
    this._rematchTimer = null;

    client.on('open', () => { this.connection = 'open'; this.emit(); });
    client.on('close', () => { this.connection = 'closed'; this.emit(); });
    client.on('reconnecting', () => { this.connection = 'reconnecting'; this.emit(); });
    client.on(S2C.SNAPSHOT, (m) => {
      this.mySeat = m.you;
      this.state = m.state;
      this.players = m.players;
      this.round = m.round || 1;
      this.visibility = m.visibility || 'public';
      this.turnDeadline = m.turnDeadline || null;
      this.drawOfferedBy = null;
      this.connection = 'open';
      this.syncPeerOffline();
      // 任何快照都当作一次「房间状态重新对齐」：把上一局的协商状态清掉，
      // 让结算浮层回到 idle。理由：断线重连后服务端那张过期的「等待对手确认」
      // 邀请已经不可信，与其保留旧状态导致「按钮一直灰着」不如让玩家重新点。
      this._resetRematch();
      this.emit();
    });
    client.on(S2C.STARTED, (m) => {
      if (m.state) this.state = m.state;
      if (m.round) this.round = m.round;
      this._finishNotified = false; // 再来一局：重置终局通知标记
      this.drawOfferedBy = null;
      this._resetRematch();
      this.emit();
    });
    client.on(S2C.MOVE, (m) => {
      if (typeof m.turnDeadline === 'number') this.turnDeadline = m.turnDeadline;
      this.applyRemoteMove(m);
    });
    client.on(S2C.UNDO, (m) => {
      if (m.state) this.state = m.state;
      if (typeof m.turnDeadline === 'number') this.turnDeadline = m.turnDeadline;
      this.emit();
    });
    client.on(S2C.DRAW, (m) => {
      if (m.event === 'offered') this.drawOfferedBy = m.by;
      else this.drawOfferedBy = null;
      this.emit();
    });
    client.on(S2C.PEER, (m) => {
      this.peerEvent = m;
      // 对手上线/断线：服务端在 WS 打开/关闭时广播，
      // 客户端据此在状态胶囊与计分板上标出「对手已断线，等待重连…」。
      if (m.event === 'online' || m.event === 'offline') {
        const online = m.event === 'online';
        this.players = (this.players || []).map((p) => (p.seat === m.seat ? { ...p, online } : p));
        this.peerOfflineSeat = online ? 0 : m.seat;
        // 对手主动离开：服务端会把 `left:true` 一并带过来，按这个标志把按钮
        // 切换成「等待新对手」，并取消正在等待的「再来一局」邀请。
        if (!online && m.left) {
          this.peerLeft = true;
          if (this.rematchState === 'waiting') {
            this.rematchState = 'peer_left';
            this._clearRematchTimeout();
          }
        }
      }
      if (m.event === 'rematch') {
        // 对手已发起「再来一局」：按钮立刻可点，状态回到 idle 等用户确认。
        this.peerWantsRematch = true;
        this.rematchState = 'idle';
        this._clearRematchTimeout();
        this.hint = '对手想再来一局';
      }
      this.emit();
    });
    client.on(S2C.FINISHED, (m) => {
      // 终局广播必须把客户端状态推进到 finished，否则结算浮层不会出现。
      // 优先采信服务端权威 state；老版本服务端 FINISHED 不带 state 时，
      // 用 winner/scores 推导终局态（兼容未升级的旧后端）。
      if (m.state) {
        this.state = m.state;
      } else if (this.state && this.state.status !== STATUS.FINISHED) {
        this.state = { ...this.state, status: STATUS.FINISHED, winner: m.winner, scores: m.scores };
      }
      this.turnDeadline = null;
      this._notifyFinish();
      this.emit();
    });
    // 服务端对「再来一局」请求的应答，详见 shared/game-core/protocol.js 的 S2C.REMATCH
    client.on(S2C.REMATCH, (m) => {
      if (m.event === 'waiting') {
        this.rematchState = 'waiting';
        this.rematchPeerOnline = m.peerOnline !== false;
        this._armRematchTimeout();
      } else if (m.event === 'peer_left') {
        this.rematchState = 'peer_left';
        this.rematchPeerOnline = false;
        this.rematchHint = '对手已离开房间';
        this._clearRematchTimeout();
      } else if (m.event === 'expired') {
        // 服务端兜底：超时未凑齐两票，作废邀请并让玩家走「等待新对手」分支
        this.rematchState = 'peer_left';
        this.rematchPeerOnline = false;
        this.rematchHint = this.rematchHint || '对手暂时没有回应';
        this._clearRematchTimeout();
      } else if (m.event === 'started') {
        this._resetRematch();   // 真正开局由 STARTED + snapshot 推进，这里只是冗余兜底
      }
      this.emit();
    });
    client.on(S2C.ERROR, (m) => {
      this.lastError = m;
      this.emit();
    });
    client.on(S2C.CHAT, (m) => {
      this.chatMessages.push({
        seat: m.seat,
        nick: m.nick,
        text: m.text || '',
        emoji: m.emoji || '',
        ts: m.ts || Date.now(),
      });
      if (this.chatMessages.length > 50) this.chatMessages.shift();
      this.chatUnread = (this.chatUnread || 0) + 1;
      this.emit();
    });
  }

  /** 按最新玩家列表刷新「对手是否掉线」（快照里带 online 标记） */
  syncPeerOffline() {
    const seat = this.opponentSeat();
    const p = (this.players || []).find((x) => x.seat === seat);
    // 座位上没人（uid 为空）= 还没人加入，不是断线
    this.peerOfflineSeat = (seat && p && p.uid && p.online === false) ? seat : 0;
  }

  applyRemoteMove(m) {
    if (!this.state) return;
    const r = m.edge ? core.applyMove(this.state, m.by, m.edge) : { ok: false };
    if (r.ok) {
      this.state = r.state;
      sound.move();
      if (m.by === this.mySeat) sound.vibrate();
      if (m.gained && m.gained.length) sound.gain();
      if (r.finished) this._soundFinish(r.winner);
    } else {
      // 本地推演失败（例如重连后缺历史），直接采信服务端字段
      this.state = {
        ...this.state,
        scores: m.scores,
        turn: m.turn,
        status: m.status,
        winner: m.winner,
        seq: m.seq,
      };
      if (m.status === STATUS.FINISHED) this._soundFinish(m.winner);
    }
    if (this.state && this.state.status === STATUS.FINISHED) this._notifyFinish();
    this.emit();
  }

  /** 终局时触发一次 onFinish 回调（用于上传积分到微信云存储） */
  _notifyFinish() {
    if (this._finishNotified) return;
    this._finishNotified = true;
    try { if (this.onFinish) this.onFinish(); } catch (e) { console.warn(e); }
  }

  /**
   * 进入新一轮（包括再来一局开局 / 等待新对手）时清掉上局的协商状态。
   * 由 SNAPSHOT（非 FINISHED）与 STARTED 触发，保证下一次结算浮层是干净的。
   */
  _resetRematch() {
    this.rematchState = 'idle';
    this.rematchPeerOnline = null;
    this.rematchHint = '';
    this.peerWantsRematch = false;
    this.peerLeft = false;
    this._clearRematchTimeout();
  }

  _clearRematchTimeout() {
    if (this._rematchTimer) {
      clearTimeout(this._rematchTimer);
      this._rematchTimer = null;
    }
  }

  /**
   * 「等待对手确认」期间设一个客户端兜底：超过这段时间没收到服务端应答
   * 就主动把按钮切到「等待新对手」，避免服务端丢失响应时 UI 永远转圈。
   */
  _armRematchTimeout() {
    this._clearRematchTimeout();
    this._rematchTimer = setTimeout(() => {
      this._rematchTimer = null;
      if (this.rematchState !== 'waiting') return;
      this.rematchState = 'peer_left';
      this.rematchPeerOnline = false;
      this.rematchHint = '对手暂时没有回应';
      this.emit();
    }, REMATCH_CONFIRM_TIMEOUT_MS);
  }

  /** 结算浮层按钮呈现（场景据此画文字/灰态/提示行） */
  rematchView() {
    if (this.rematchState === 'waiting') {
      return {
        label: '等待对手确认…',
        disabled: true,
        hint: this.rematchPeerOnline
          ? '已通知对手，等他点「再来一局」'
          : '对手已离线，等他回到房间后点一下即可',
      };
    }
    if (this.rematchState === 'peer_left') {
      return {
        label: '等待新对手',
        disabled: false,
        hint: this.rematchHint || '对手已离开房间，可换一位新对手',
      };
    }
    if (this.peerWantsRematch) {
      return { label: '再来一局', disabled: false, hint: '对手想再来一局，点这里开始' };
    }
    return { label: '再来一局', disabled: false, hint: '' };
  }

  /** 终局音效：观战（seat 0）不播；win=3 平局，否则按是否自己胜 */
  _soundFinish(winner) {
    if (!this.mySeat) return;
    if (winner === 3) sound.finish(null);
    else sound.finish(winner === this.mySeat);
  }

  play(edge) {
    if (!this.canPlay()) return false;
    this.client.send({ t: C2S.MOVE, edge, seq: this.state.seq });
    return true;
  }

  /**
   * 结算后点「再来一局」：
   *   idle          → 向服务端发邀请，按钮立即进入「等待对手确认」给出即时反馈
   *   waiting       → 已经在邀请中，重复点击一律忽略（防双击）
   *   peer_left     → 对手不可用，发出 action:'wait_new'，服务端把房间退回等待态换人
   * 返回是否真的发出了请求；false 表示当前状态不应发起（场景层据此提示）。
   */
  reset() {
    if (!this.state || this.state.status !== STATUS.FINISHED) return false;
    if (this.connection !== 'open') {
      this.lastError = { message: '网络已断开，无法发起' };
      this.emit();
      return false;
    }
    if (this.rematchState === 'waiting') return false;   // 已邀请中，避免重复发出
    if (this.rematchState === 'peer_left') {
      this.client.send({ t: C2S.REMATCH, action: 'wait_new' });
      this._resetRematch();   // 切回 idle，等新对手加入或房间回到 WAITING
      return true;
    }
    // 乐观置位：先把自己这边切到「等待对手确认」，等服务端应答再细化（waiting / peer_left）。
    // 这样玩家点完立刻能看到反馈，不再有「按下去没反应」的卡死感。
    this.rematchState = 'waiting';
    this.rematchPeerOnline = !this.opponentOffline();
    this._armRematchTimeout();
    this.emit();
    this.client.send({ t: C2S.REMATCH });
    return true;
  }

  resign() {
    this.client.send({ t: C2S.RESIGN });
  }

  /** 悔棋（联网对局服务端统一裁定，每局限 3 次） */
  undo() {
    if (!this.canUndo()) return false;
    this.client.send({ t: C2S.UNDO });
    return true;
  }

  /** 发起求和请求 */
  offerDraw() {
    if (this.state?.status !== STATUS.PLAYING) return false;
    if (this.drawOfferedBy) return false; // 已有挂起请求
    this.client.send({ t: C2S.DRAW, action: 'offer' });
    return true;
  }

  /** 接受对手的求和请求 */
  acceptDraw() {
    if (!this.drawOfferedBy || this.drawOfferedBy === this.mySeat) return false;
    this.client.send({ t: C2S.DRAW, action: 'accept' });
    return true;
  }

  /** 拒绝对手的求和请求 */
  declineDraw() {
    if (!this.drawOfferedBy) return false;
    this.client.send({ t: C2S.DRAW, action: 'decline' });
    return true;
  }

  /** 发送聊天消息（文本 / 表情包），服务端会做长度裁剪与速率限制。
   *  本地乐观追加自己的消息，避免等服务端广播（服务端通常不回发给发送者）。 */
  sendChat({ text = '', emoji = '' } = {}) {
    const payload = { text, emoji };
    this.client.send({ t: C2S.CHAT, ...payload });
    // 本地乐观添加：服务端一般只广播给其他玩家，不回发给自己
    const me = (this.players || []).find((p) => p.seat === this.mySeat);
    this.chatMessages.push({
      seat: this.mySeat,
      nick: (me && me.nick) || '',
      text: text || '',
      emoji: emoji || '',
      ts: Date.now(),
      local: true,
    });
    if (this.chatMessages.length > 50) this.chatMessages.shift();
    this.emit();
  }

  /** 打开聊天面板时清零未读角标 */
  clearChatUnread() {
    this.chatUnread = 0;
  }

  destroy() {
    this._clearRematchTimeout();
    this.client.close();
  }

  statusText() {
    if (this.connection === 'reconnecting') return '连接中断，正在重连…';
    if (this.connection === 'closed') return '已断开，检查网络后重进';
    return super.statusText();
  }
}

/**
 * 异步对战会话：不依赖 WebSocket，通过 HTTP 轮询获取最新状态。
 * 接口与 RemoteSession 一致，GameScene 可直接复用。
 *
 * 构造后立即拉一次对局状态，随后按 CONFIG.asyncPollMs 周期轮询；
 * 轮到对手落子时保持轮询，轮到自己时也继续轮询（防止对手在你思考时落子——
 * 异步对战里你不需要立即回应，但切回前台时要看到最新局面）。
 */
export class AsyncSession extends BaseSession {
  /**
   * @param {object} opts
   * @param {string} opts.gameId   对局 ID
   * @param {number} [opts.mySeat] 已知座位（可选；不传则从服务端 players 推断）
   */
  constructor({ gameId, mySeat = 0, onFinish = null } = {}) {
    super();
    this.gameId = gameId;
    this.online = true;
    this.roomId = gameId;          // GameScene 顶部显示用
    this.mySeat = mySeat;
    this.onFinish = onFinish;       // 终局回调（用于上传积分到微信云存储）
    this._finishNotified = false;
    this.state = null;
    this.players = [];
    this.connection = 'connecting';
    this.timer = null;
    this.lastSeq = 0;
    this._polling = false;

    this.refresh().then(() => {
      this.connection = 'open';
      this.emit();
      this._requestSubscribe();
      this._schedule();
    }).catch((e) => {
      console.warn('异步对局加载失败', e);
      this.connection = 'closed';
      this.lastError = e;
      this.emit();
    });
  }

  /** 拉取一次最新状态；有新落子则播放音效 */
  async refresh() {
    if (this._polling) return;
    this._polling = true;
    try {
      const info = await api.getAsyncGame(this.gameId);
      const st = info.state;
      // 推断自己座位（构造时未传 mySeat 的话）
      if (!this.mySeat) {
        const uid = api.getUid();
        const p = (info.players || []).find((pl) => pl.uid === uid);
        this.mySeat = p ? p.seat : 0;
      }
      this.players = info.players || [];
      // 服务端 DB 的 status / current_turn 列是权威值，用它校正内嵌 state 里的同名字段。
      // 两者理论上应一致，一旦不一致（例如老数据），界面会显示成「轮到你落子」但落子必被拒。
      if (st) {
        if (info.status) st.status = info.status;
        if (info.currentTurn) st.turn = info.currentTurn;
      }

      // 检测对手是否新落子
      if (st && st.seq > this.lastSeq) {
        const lastMove = st.moves[st.moves.length - 1];
        if (this.lastSeq > 0 && lastMove && lastMove.by !== this.mySeat && this.mySeat) {
          sound.move();
          if (lastMove.gained && lastMove.gained.length) sound.gain();
          if (st.status === STATUS.FINISHED) this._soundFinish(st.winner);
        }
        this.lastSeq = st.seq;
      } else if (st) {
        this.lastSeq = st.seq;
      }
      this.state = st;
      if (st && st.status === STATUS.FINISHED) this._notifyFinish();
      this.emit();
    } finally {
      this._polling = false;
    }
  }

  _schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      await this.refresh().catch(() => { /* 单次失败忽略，下次继续 */ });
      this._schedule();
    }, CONFIG.asyncPollMs || 4000);
  }

  /** 落子：POST 到服务端，成功后立即更新本地 state */
  play(edge) {
    if (!this.canPlay()) return false;
    // 乐观锁：先标记正在落子，避免快速点击重复发送
    if (this._playing) return false;
    this._playing = true;
    api.asyncMove(this.gameId, edge).then((res) => {
      this._playing = false;
      if (res && res.state) {
        this.state = res.state;
        this.lastSeq = res.state.seq;
        sound.move();
        sound.vibrate();
        if (res.gained && res.gained.length) sound.gain();
        if (res.finished) { this._soundFinish(res.winner); this._notifyFinish(); }
        this.emit();
      }
    }).catch((e) => {
      this._playing = false;
      this.lastError = e;
      // 落子被拒说明本地 state 已过期（典型：对手还没加入、或已被对手抢先一步），
      // 立刻拉一次服务端状态把界面纠回来，别让玩家继续对着旧局面点。
      if (e && (e.statusCode === 409 || e.statusCode === 403)) {
        this.refresh().catch(() => { /* 下次轮询会再试 */ });
      }
      this.emit();
    });
    return true;
  }

  /** 异步对战暂不支持认输（后续可加） */
  resign() { return false; }

  /** 异步对战暂不支持悔棋 / 求和 */
  canUndo() { return false; }
  undo() { return false; }

  /** 异步对战没有 rematch */
  reset() { return false; }

  /** 结算浮层按钮：异步对战暂时不支持再来一局，按钮直接置灰并说明原因 */
  rematchView() {
    return { label: '再来一局', disabled: true, hint: '异步对战暂不支持再来一局' };
  }

  /** 终局音效 */
  _soundFinish(winner) {
    if (!this.mySeat) return;
    if (winner === 3) sound.finish(null);
    else sound.finish(winner === this.mySeat);
  }

  /** 终局时触发一次 onFinish 回调（用于上传积分到微信云存储） */
  _notifyFinish() {
    if (this._finishNotified) return;
    this._finishNotified = true;
    try { if (this.onFinish) this.onFinish(); } catch (e) { console.warn(e); }
  }

  /** 进入对局时请求订阅消息授权并上报模板 ID（未配置模板则跳过） */
  _requestSubscribe() {
    const tpl = CONFIG.subscribeTemplateId;
    if (!tpl || !wx || !wx.requestSubscribeMessage) return;
    try {
      wx.requestSubscribeMessage({
        tmplIds: [tpl],
        success: (res) => {
          // 任一被授权就上报（接受/拒绝都无所谓，上报后服务端知道用这个模板）
          if (res && res[tpl] === 'accept') {
            api.subscribeAsync(this.gameId, tpl).catch(() => {});
          }
        },
        fail: () => { /* 用户拒绝或不支持，忽略 */ },
      });
    } catch { /* ignore */ }
  }

  statusText() {
    if (this.connection === 'connecting') return '加载对局…';
    if (this.connection === 'closed') return '加载失败，请重试';
    if (!this.state) return '加载对局…';
    if (this.state.status === STATUS.WAITING) return '等待对手加入…';
    if (this.state.status === STATUS.FINISHED) return '本局结束';
    return this.state.turn === this.mySeat ? '轮到你落子' : '等待对手落子…';
  }

  destroy() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}
