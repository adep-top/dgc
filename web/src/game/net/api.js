import { apiBaseUrl } from '../config.js';
import { API } from '../core/protocol.js';

const KEY_TOKEN = 'dgc_token';
const KEY_UID = 'dgc_uid';

export const getToken = () => {
  try { return wx.getStorageSync(KEY_TOKEN) || ''; } catch { return ''; }
};
export const getUid = () => {
  try { return wx.getStorageSync(KEY_UID) || ''; } catch { return ''; }
};
export const isLogin = () => !!getToken();

/** 清掉本地登录态（服务端拒绝了这个 token 时调用） */
export const clearLogin = () => {
  try {
    wx.removeStorageSync(KEY_TOKEN);
    wx.removeStorageSync(KEY_UID);
  } catch { /* ignore */ }
};

/** 构造带状态码的错误：上层据此区分「登录态失效(401)」与普通网络错误 */
function httpError(res) {
  const data = res.data || {};
  // 后端有两种错误体：函数级 err() 返回 {error: string, message: string}；
  // 平台运行时错误（FN_EXEC_ERROR 等）返回 {error: {code, message}}。
  // 两种都要把真实 message 透出来，不能 new Error(对象) 变成 "[object Object]"。
  const errorObj = typeof data.error === 'object' && data.error !== null ? data.error : null;
  const message =
    (typeof data.message === 'string' && data.message) ||
    (errorObj && typeof errorObj.message === 'string' && errorObj.message) ||
    `HTTP ${res.statusCode}`;
  const err = new Error(message);
  err.statusCode = res.statusCode;
  err.code =
    (errorObj && typeof errorObj.code === 'string' && errorObj.code) ||
    (typeof data.error === 'string' ? data.error : '') ||
    '';
  return err;
}

/**
 * 发一个请求。
 * @param {object} [opts]
 *   auth    是否需要登录态（默认 true）。为 true 且服务端回 401 时，
 *           会自动清掉旧 token 重新 wx.login，并把本次请求重试一次——
 *           token 会过期，本地也可能残留「上一个后端」签发的 token，不能直接把 401 抛给用户。
 *   retried 内部参数：标记已经重试过，避免无限递归。
 */
function request(path, method = 'GET', data, opts = {}) {
  const { auth = true, retried = false } = opts;
  return new Promise((resolve, reject) => {
    wx.request({
      url: apiBaseUrl() + path,
      method,
      data: data || {},
      header: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`,
      },
      timeout: 10000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) { resolve(res.data); return; }
        if (auth && !retried && res.statusCode === 401) {
          login(true).then(
            () => request(path, method, data, { auth, retried: true }).then(resolve, reject),
            reject,
          );
          return;
        }
        reject(httpError(res));
      },
      fail: (err) => reject(new Error(err.errMsg || 'network error')),
    });
  });
}

let loggingIn = null; // 并发登录去重：多处同时触发登录时只发一次 wx.login

/**
 * wx.login 换 code。真机调试时 wx.login 偶发不回调（success/fail 都不触发），
 * 外层 await 会永久挂起 —— 这里包一层超时，超时即按失败处理并在界面上给出原因。
 */
function wxLoginCode(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('wx.login 无响应（8s 超时，真机调试常见，请重进）'));
    }, timeoutMs);
    try { timer.unref && timer.unref(); } catch { /* 非 Node 环境 */ }
    wx.login({
      success: (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res.code);
      },
      fail: (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(e && e.errMsg ? `wx.login: ${e.errMsg}` : 'wx.login 失败'));
      },
    });
  });
}

/**
 * wx.login -> code -> 服务端换 openid -> 自签名 token。
 * @param {boolean} force 忽略本地缓存强制重登（token 失效时用）
 * @param {string}  [nick] 昵称，首次登录时带给服务端
 */
export async function login(force = false, nick) {
  if (!force && isLogin()) return { token: getToken(), uid: getUid() };
  if (loggingIn) return loggingIn;
  loggingIn = (async () => {
    // 旧 token 已经不可用了，先清掉，避免重试时又把它带上
    clearLogin();
    const code = await wxLoginCode();
    const data = await request(API.LOGIN, 'POST', { code, nick }, { auth: false });
    try {
      wx.setStorageSync(KEY_TOKEN, data.token);
      wx.setStorageSync(KEY_UID, data.uid);
    } catch { /* ignore */ }
    return data;
  })();
  try { return await loggingIn; } finally { loggingIn = null; }
}

/**
 * 确保本地有登录态：没有 token 就先登录一次。
 * 这里不校验有效性——token 真的失效时，第一个 401 会被 request 层自动重登并重试。
 */
export async function ensureToken() {
  if (!isLogin()) await login();
  return getToken();
}

/** 创建房间：visibility 为 'public'（公开上大厅）或 'friends'（仅好友可见，不公开列出） */
export const createRoom = (rows, cols, visibility = 'public') =>
  request(API.CREATE_ROOM, 'POST', { rows, cols, visibility });
export const joinRoom = (roomId) => request(API.JOIN(roomId), 'POST', {});
/** 主动离开房间：解除服务端「一人一房」的归属（等待中的房间会被直接销毁） */
export const leaveRoom = (roomId) => request(API.LEAVE(roomId), 'POST', {});
export const getRoom = (roomId) => request(API.ROOM(roomId), 'GET');
export const me = () => request(API.ME, 'GET');

/* ---------------- 断线重连：记住上次进的房间 ---------------- */

const KEY_LAST_ROOM = 'dgc_last_room';

/**
 * 上次进入过的房间号。
 * 游戏中途被杀进程 / 断网时不会被清掉，下次上线据此自动回到还没销毁的房间；
 * 主动点「返回首页」会清空（那是主动退出，不是断线）。
 */
export const getLastRoom = () => {
  try { return String(wx.getStorageSync(KEY_LAST_ROOM) || ''); } catch { return ''; }
};
export const setLastRoom = (roomId) => {
  try { wx.setStorageSync(KEY_LAST_ROOM, roomId || ''); } catch { /* ignore */ }
};
export const clearLastRoom = () => {
  try { wx.removeStorageSync(KEY_LAST_ROOM); } catch { /* ignore */ }
};

/** 大厅：等待对手的公开房间列表 */
export const listRooms = () => request(API.CREATE_ROOM, 'GET');
/** 陌生人快速匹配：返回 {roomId, action: 'join'|'create', ...} */
export const quickMatch = (rows, cols) => request(API.QUICK_MATCH, 'POST', { rows, cols });

/** 积分排行榜 */
export const getRanking = () => request(API.RANKING, 'GET');

/**
 * 拼 query string：跳过 undefined / null / 空串，但保留数字 0
 * （0 是合法取值，例如 offset=0、limit=0，丢掉会让服务端只能吃默认值）。
 *
 * 不要改回 `new URLSearchParams()`：微信「小游戏」运行时没有这个 Web API
 * （小程序有、小游戏没有），而开发者工具模拟器里是有的。
 * 于是同一份代码在工具里正常、到真机上直接抛 ReferenceError，
 * 表现成列表页永远「加载失败」——战绩页就踩过这个坑。
 */
function qs(params) {
  const parts = [];
  for (const k of Object.keys(params || {})) {
    const v = params[k];
    if (!v && v !== 0) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? '?' + parts.join('&') : '';
}

/** 我的战绩列表：{limit=20, offset=0} -> {matches, total} */
export const getMatches = ({ limit = 20, offset = 0 } = {}) =>
  request(API.MATCHES + qs({ limit, offset }), 'GET');

/** 对局详情（含落子序列，用于复盘） */
export const getMatchDetail = (id) => request(API.MATCH_DETAIL(id), 'GET');

/**
 * 小程序码邀请图片完整 URL（含 token）。
 * 图片下载/加载场景（wx.createImage / wx.downloadFile）不方便带 Authorization 头，
 * 直接把 token 拼到 query 上，服务端路由同样支持 ?token= 认证。
 */
export const getWxacodeUrl = (roomId) =>
  `${apiBaseUrl()}${API.WXACODE(roomId)}?token=${encodeURIComponent(getToken())}`;

/* ---------------- 异步对战 ---------------- */

/** 创建异步对局：{rows, cols, opponentUid?, opponentNick?} */
export const createAsyncGame = ({ rows, cols, opponentUid, opponentNick } = {}) =>
  request(API.ASYNC_CREATE, 'POST', { rows, cols, opponentUid, opponentNick });

/** 我的异步对局列表：?status=playing&limit=20 */
export const listAsyncGames = ({ status, limit } = {}) =>
  request(API.ASYNC_LIST + qs({ status, limit }), 'GET');

/** 获取异步对局状态 */
export const getAsyncGame = (gameId) => request(API.ASYNC_GAME(gameId), 'GET');

/** 加入等待中的异步对局 */
export const joinAsyncGame = (gameId) => request(API.ASYNC_JOIN(gameId), 'POST', {});

/** 落子：{edge} */
export const asyncMove = (gameId, edge) => request(API.ASYNC_MOVE(gameId), 'POST', { edge });

/** 登记订阅消息模板 ID */
export const subscribeAsync = (gameId, templateId) =>
  request(API.ASYNC_SUBSCRIBE(gameId), 'POST', { templateId });

/* ---------------- 实时对战轮询通道（web 版替代 WebSocket） ---------------- */

/**
 * 轮询房间状态：心跳 + 增量事件。
 * 响应 { snapshot, events, realign, evtSeq }：snapshot 始终带（客户端按需对齐），
 * events 为 seq > since 且按座位过滤后的增量；since 落后被裁剪时 realign=true。
 */
export const pollRoomState = (roomId, since) => request(API.ROOM_STATE(roomId), 'POST', { since });

/** 下发指令（move/undo/resign/draw/rematch/chat）-> { events } 本次指令产生的事件 */
export const sendRoomCommand = (roomId, msg) => request(API.ROOM_COMMAND(roomId), 'POST', msg);
