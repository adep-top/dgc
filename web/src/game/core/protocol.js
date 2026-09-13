/**
 * 三端共用的协议常量：HTTP 路径、WS 消息类型、错误码。
 * 服务端（Node / Workers）与客户端（微信小游戏 / H5）都从这里取，避免手写字符串出错。
 */

export const API = {
  LOGIN: '/api/auth/login',
  ME: '/api/auth/me',
  CREATE_ROOM: '/api/rooms',          // POST 创建；GET 大厅房间列表
  ROOM: (id) => `/api/rooms/${id}`,
  JOIN: (id) => `/api/rooms/${id}/join`,
  LEAVE: (id) => `/api/rooms/${id}/leave`, // POST 主动离开房间（解除「一人一房」归属）
  QUICK_MATCH: '/api/match',          // POST 陌生人快速匹配
  RANKING: '/api/ranking',            // GET 积分排行榜
  MATCHES: '/api/matches',            // GET 我的战绩列表
  MATCH_DETAIL: (id) => `/api/matches/${id}`, // GET 对局详情（含落子序列）
  // ---- 异步对战（每步落库 + 订阅消息提醒，不依赖长连接）----
  ASYNC_CREATE: '/api/async/games',                    // POST 创建异步对局
  ASYNC_LIST: '/api/async/games',                      // GET 我的异步对局列表
  ASYNC_GAME: (id) => `/api/async/games/${id}`,        // GET 获取对局状态
  ASYNC_JOIN: (id) => `/api/async/games/${id}/join`,   // POST 加入等待中的对局
  ASYNC_MOVE: (id) => `/api/async/games/${id}/move`,   // POST 落子
  ASYNC_SUBSCRIBE: (id) => `/api/async/games/${id}/subscribe`, // POST 登记订阅模板
  // ---- 实时对战轮询通道（adep 云函数为 HTTP，替代微信版 WebSocket /v1/ws）----
  ROOM_STATE: (id) => `/api/rooms/${id}/state`,   // POST 轮询：心跳 + 增量事件（{since}）
  ROOM_COMMAND: (id) => `/api/rooms/${id}/command`, // POST 指令（move/undo/resign/draw/rematch/chat）
  // ---- 邀请链接（web 版替代小程序码；路径保留以便兼容旧客户端）----
  WXACODE: (roomId) => '/api/wxacode/' + roomId,   // GET（web 版返回 404，前端不再调用）
};

export const WS_PATH = '/v1/ws';

/**
 * 房间可见性：
 *   public  —— 公开房间，登记到大厅，陌生人可在房间列表 / 快速匹配中看到并加入；
 *   friends —— 「仅好友可见」（实际语义：不公开列出），不登记大厅，
 *              只能通过房号 / 分享卡片 / 小程序码被知道的人加入。
 * 注：服务端无法获取微信好友关系链，这里只控制是否在大厅公开列出。
 */
export const VISIBILITY = {
  PUBLIC: 'public',
  FRIENDS: 'friends',
};

/** 客户端 -> 服务端 */
export const C2S = {
  HELLO: 'hello',   // {t, token, room, lastSeq?}
  MOVE: 'move',     // {t, edge, seq}
  RESIGN: 'resign', // {t}
  REMATCH: 'rematch',
  PING: 'ping',
  CHAT: 'chat',     // {t, text?, emoji?} 对局聊天，旁观也可发
  UNDO: 'undo',     // {t} 请求悔棋（每局限 3 次）
  DRAW: 'draw',     // {t, action:'offer'|'accept'|'decline'} 求和
};

/** 服务端 -> 客户端 */
export const S2C = {
  SNAPSHOT: 'snapshot', // {t, room, you, state, players, hostSeat, turnDeadline}
  MOVE: 'move',         // {t, seq, by, edge, gained, scores, turn, status, winner, turnDeadline}
  PEER: 'peer',         // {t, event:'join'|'leave'|'online'|'offline'|'rematch', seat, nick, left?}
  STARTED: 'started',   // {t, state, round}
  FINISHED: 'finished', // {t, winner, scores, reason?:'resign'|'timeout'|'draw'}
  ERROR: 'error',       // {t, code, message}
  PONG: 'pong',
  CHAT: 'chat',         // {t, seat, nick, text, emoji, ts}
  UNDO: 'undo',         // {t, by, state, turnDeadline} 悔棋结果（state 为回退后的完整状态）
  DRAW: 'draw',         // {t, event:'offered'|'accepted'|'declined', by} 求和广播
  // 再来一局协商结果（仅发给发起者）。
  //   waiting  —— 已记录你的邀请，等对手同意；peerOnline 表示对手当前是否在线
  //   peer_left —— 对手已离场（座位空 / 主动退出），再点一次「等待新对手」即可换人
  //   expired  —— 邀请超时（对手长时间没回应），同样可以换人
  //   started —— 已凑齐两票，新一局开打（多数路径走 STARTED + 快照，这里仅作冗余通知）
  REMATCH: 'rematch',
};

export const ERR = {
  BAD_MESSAGE: 'bad_message',
  UNAUTHORIZED: 'unauthorized',
  NO_ROOM: 'no_room',
  ROOM_FULL: 'room_full',
  NOT_STARTED: 'not_started',
  NOT_YOUR_TURN: 'not_your_turn',
  BAD_EDGE: 'bad_edge',
  EDGE_TAKEN: 'edge_taken',
  FINISHED: 'finished',
  RATE_LIMITED: 'rate_limited',
  UNDO_NOT_ALLOWED: 'undo_not_allowed',
  // ---- 异步对战 ----
  ASYNC_NOT_FOUND: 'async_not_found',
  ASYNC_NOT_YOUR_TURN: 'async_not_your_turn',
  ASYNC_FINISHED: 'async_finished',
  ASYNC_NOT_JOINED: 'async_not_joined',
  ASYNC_NOT_WAITING: 'async_not_waiting',
};

const ERR_TEXT = {
  [ERR.BAD_MESSAGE]: '消息格式错误',
  [ERR.UNAUTHORIZED]: '登录态失效，请重试',
  [ERR.NO_ROOM]: '房间不存在或已过期',
  [ERR.ROOM_FULL]: '房间已满',
  [ERR.NOT_STARTED]: '等待对手加入',
  [ERR.NOT_YOUR_TURN]: '还没轮到你',
  [ERR.BAD_EDGE]: '无效的落点',
  [ERR.EDGE_TAKEN]: '这条边已经被占了',
  [ERR.FINISHED]: '本局已结束',
  [ERR.RATE_LIMITED]: '操作太快了',
  [ERR.UNDO_NOT_ALLOWED]: '现在不能悔棋（无棋可悔或次数已用完）',
  [ERR.ASYNC_NOT_FOUND]: '对局不存在',
  [ERR.ASYNC_NOT_YOUR_TURN]: '还没轮到你落子',
  [ERR.ASYNC_FINISHED]: '本局已结束',
  [ERR.ASYNC_NOT_JOINED]: '你还没有加入这局',
  [ERR.ASYNC_NOT_WAITING]: '这局已经开始或结束',
};

export const errText = (code) => ERR_TEXT[code] || '出错了，请重试';

/** 房间号：6 位大写字母数字，去掉易混淆字符（0/O/1/I） */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function makeRoomId(rnd = Math.random, len = 6) {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
  return out;
}
export const isValidRoomId = (id) => typeof id === 'string' && /^[A-Z2-9]{4,8}$/.test(id);
