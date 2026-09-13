/**
 * 客户端配置。上线前只需要改这里。
 */
export const CONFIG = {
  // 线上后端地址：必须是「已完成 ICP 备案」的域名，且在微信后台配置为 request/wss 合法域名。
  // 只填线上地址即可 —— 本地调试会自动切到本机/局域网后端，不用改这两行（见下方「运行环境」）。
  apiBase: 'https://dgc.jajabjbj.top',
  wsBase: 'wss://dgc.jajabjbj.top',

  // 关掉后只保留单机 + 人机，不需要服务器也能跑（方便调试 / 提审）
  enableOnline: true,

  defaultSize: 6,      // 默认 6x6 个格子
  aiLevel: 'normal',   // easy | normal | hard
  aiDelayMs: 320,
  // 每回合（每步）限时毫秒：联网对战由服务端裁定超时判负，本地人机仅用于倒计时显示
  turnTimeoutMs: 60 * 1000,

  shareTitle: '来一局云柯点格棋，房间号 {room}',
  shareImageRatio: '5:4', // 不传 imageUrl 时微信自动截取游戏画面

  // 异步对战：微信订阅消息模板 ID。留空则不请求授权也不上报。
  // 上线前在微信公众平台 → 订阅消息 中申请模板，把模板 ID 填到这里。
  subscribeTemplateId: '',
  // 异步对战轮询间隔（毫秒）。轮到对手时用这个频率拉取最新状态。
  asyncPollMs: 4000,

  // 微信开放数据域好友/群排行榜使用的云存储 key。
  // 主域把玩家积分以 {rating, wins, nick} 的 JSON 字符串写入该 key，
  // 开放数据域再用同名 key 拉取好友/群数据做排行。
  cloudStorageKey: 'dgc_rating',
};

/* ---------------- 运行环境：web 版固定同源（adep 平台 /api） ----------------
 * adep 云函数与前端同源部署，apiBase 恒为空串（相对路径 /api/...）。
 * 本地开发（vite + 进程内 adep dev）时 /api 由 vite 代理到模拟运行时；
 * 部署到平台后 /api 由网关分流到云函数 —— 两端都无需改配置。
 *
 * 仍保留 ?dev=http://host:8787 手动覆盖，方便本地联调其它后端实例。
 */
let envCache = null;

const envOf = (host, isLocal, reason) => ({
  apiBase: host || '',
  wsBase: host || '',
  host: host || '',
  isLocal: !!isLocal,
  label: isLocal ? '本地' : '平台',
  reason: reason || '',
});

function manualOverride() {
  try {
    const q = (wx.getLaunchOptionsSync && wx.getLaunchOptionsSync().query) || {};
    const raw = String(q.dev || '').trim();
    if (!raw || raw === 'prod' || raw === 'online' || raw === 'release') return null;
    const withScheme = /^(https?):\/\/(.+)$/i.exec(raw);
    if (withScheme) return withScheme[2].split('/')[0];
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** 首次判定（web 版：同步可判，保留 Promise 形状以兼容启动流程） */
export function resolveEndpoints() {
  if (envCache) return Promise.resolve(envCache);
  const host = manualOverride();
  envCache = envOf(host, !!host, host ? `手动指定 ${host}` : '同源部署');
  try {
    console.log(`[dgc] 后端 ${envCache.apiBase || '/api（同源）'}（${envCache.reason}）`);
  } catch { /* ignore */ }
  return Promise.resolve(envCache);
}

/** 同步读当前环境 */
export function currentEnv() {
  if (envCache) return envCache;
  const host = manualOverride();
  envCache = envOf(host, !!host, '预估');
  return envCache;
}

/** 当前 HTTP 基地址（web 版恒为同源空串） */
export const apiBaseUrl = () => currentEnv().apiBase;

/** 当前 WebSocket 基地址（web 版无 WS，保留给兼容代码） */
export const wsBaseUrl = () => currentEnv().wsBase;

/** 当前是否指向本地后端（首页状态条会显示，便于确认没连错环境） */
export const isDevBackend = () => currentEnv().isLocal;

export const COLORS = {
  bg: '#0f1218',
  panel: '#171b24',
  line: '#2a303c',
  text: '#e6e9ef',
  sub: '#8b94a7',
  p1: '#ff6b6b',   // 红方（先手）
  p2: '#5aa9ff',   // 蓝方
  accent: '#2f6feb',
  win: '#4ecb8f',

  // ── 对局页操作区（Dock）扩展 token ──
  // 全部沿用上面的暗色体系，色相不变，只是补齐层级
  dockTop: '#1c2330',          // Dock 渐变起（与首页磁贴同源）
  dockBottom: '#161b26',       // Dock 渐变止
  dockStroke: 'rgba(255,255,255,.07)',
  dockDivider: 'rgba(255,255,255,.16)',
  dockShadow: 'rgba(0,0,0,.5)',
  btnPressed: 'rgba(255,255,255,.09)',
  btnPressedStroke: '#4a5568',
  btnStroke: 'rgba(255,255,255,.10)', // 常规按钮的弱描边（替代整块底色）
  iconMuted: '#9aa6b8',
  danger: '#ff5c5c',
  dangerText: '#ff8080',
  dangerStroke: 'rgba(255,92,92,.42)',
  primaryTop: '#5b95ff',
  primaryBottom: '#2563eb',
};
