import { apiBaseUrl } from '../config.js';
import { S2C } from '../core/protocol.js';
import * as api from './api.js';

/**
 * 实时对战通道（web 版）：HTTP 轮询替代 WebSocket。
 * 对外接口与微信版 GameClient 完全一致（on / connect / send / close），
 * 只是把「连接-心跳-重连」换成「800ms 轮询 + 退避重连」，事件形状不变，
 * 因此 app.js / session.js 零改动。
 *
 * 协议：
 *   connect()  → 立即 emit('open')，随后开始轮询 GET/POST rooms/:id/state；
 *   send(msg)  → POST rooms/:id/command，响应里直接带回本次指令产生的事件
 *                （自己落子有近实时反馈），服务端拒绝时 emit S2C.ERROR；
 *   close()    → 停止轮询。
 */
const POLL_MS = 800;
const RECONNECT_BACKOFF = [1000, 2000, 4000, 8000];
const MAX_CONSECUTIVE_FAILS = 8;

export class GameClient {
  constructor({ roomId, token }) {
    this.roomId = roomId;
    this.token = token;
    this.handlers = new Map();
    this.closedByUser = true;
    this.timer = null;
    this.lastSeq = 0;
    this.firstPoll = true;
    this.fails = 0;
    this.joined = false;
    this.spectator = false;
    this.polling = false;
  }

  on(evt, cb) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, []);
    this.handlers.get(evt).push(cb);
    return this;
  }

  emit(evt, payload) {
    const list = this.handlers.get(evt);
    if (list) for (const cb of list.slice()) {
      try { cb(payload); } catch (e) { console.error('[dgc:poll] handler error', e); }
    }
  }

  connect() {
    if (!this.closedByUser) return this;
    this.closedByUser = false;
    this.firstPoll = true;
    this.lastSeq = 0;
    this.fails = 0;
    this.emit('open');
    // 轮询版没有 WS 握手 = 入座：连接时先显式 join 一次。
    // 建房者 → 复用既有座位；新玩家 → 分到空座；满房 → seat=0 转观战（快照 mySeat=0）。
    // join 失败（房间已回收）不阻塞轮询，由轮询的 404 统一收尾。
    this.joinOnce();
    this.schedule(POLL_MS);
    return this;
  }

  async joinOnce() {
    if (this.joined) return;
    this.joined = true;
    try {
      const res = await api.joinRoom(this.roomId);
      if (res && res.seat === 0) this.spectator = true;
    } catch {
      /* 轮询兜底：房间不存在由 404 close 处理 */
    }
  }

  schedule(delay) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  async tick() {
    this.timer = null;
    if (this.closedByUser || this.polling) return;
    this.polling = true;
    try {
      const res = await api.pollRoomState(this.roomId, this.lastSeq);
      this.fails = 0;
      if (!res) return;
      if (res.snapshot) {
        if (this.firstPoll || res.realign) {
          this.firstPoll = false;
          this.emit(S2C.SNAPSHOT, res.snapshot);
        }
      }
      for (const ev of res.events || []) this.emit(ev.t, ev);
      if (typeof res.evtSeq === 'number') this.lastSeq = res.evtSeq;
      this.schedule(POLL_MS);
    } catch (e) {
      this.fails += 1;
      if (e && e.statusCode === 404) {
        // 房间已回收/销毁：会话层收到 close 会退出房间并提示
        this.emit('close', { reason: 'room_gone' });
        this.close();
        return;
      }
      if (this.fails === 3) this.emit('reconnecting', { delay: POLL_MS, retry: this.fails });
      if (this.fails >= MAX_CONSECUTIVE_FAILS) {
        this.emit('close', { reason: 'network' });
        this.close();
        return;
      }
      const backoff = RECONNECT_BACKOFF[Math.min(this.fails - 1, RECONNECT_BACKOFF.length - 1)];
      this.schedule(backoff);
    } finally {
      this.polling = false;
    }
  }

  send(obj) {
    if (this.closedByUser) return false;
    api
      .sendRoomCommand(this.roomId, obj)
      .then((res) => {
        for (const ev of (res && res.events) || []) this.emit(ev.t, ev);
      })
      .catch((e) => {
        // 服务端拒绝（不是你的回合/边被占/房间已结束等）：透传错误事件。
        // 本地棋盘可能因此短暂领先服务端，下一次轮询的快照/事件会把它纠正回来。
        this.emit(S2C.ERROR, {
          code: (e && e.code) || 'error',
          message: (e && e.message) || '操作失败',
          statusCode: (e && e.statusCode) || 0,
        });
      });
    return true;
  }

  close() {
    this.closedByUser = true;
    this.joined = false;
    this.spectator = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

export { S2C };
