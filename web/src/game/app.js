import { CONFIG, resolveEndpoints } from './config.js';
import { HomeScene, GameScene } from './scenes.js';
import { SettingsScene } from './scenes/settings.js';
import { LobbyScene } from './scenes/lobby.js';
import { HowToScene } from './scenes/howto.js';
import { RankingScene } from './scenes/ranking.js';
import { MatchesScene } from './scenes/matches.js';
import { ReplayScene } from './scenes/replay.js';
import { LocalSession, RemoteSession, AsyncSession } from './session.js';
import { GameClient } from './net/client.js';
import * as api from './net/api.js';
import { toast, getMenuButtonRect } from './ui/widgets.js';
import { createBackgroundCanvas, paintHomeBackground } from './ui/home-art.js';
import { Settings } from './settings.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 从 systemInfo 推导安全区缩进。
 * safeArea 是屏幕坐标系（top 含状态栏），canvas 覆盖整屏，所以：
 *   safeTop    = safeArea.top
 *   safeBottom = screenHeight − safeArea.bottom（全面屏的 Home Indicator 高度）
 * 老机型 / 无刘海机型可能没有 safeArea，退回一个保守值。
 */
function insetsFrom(info) {
  const screenH = info.screenHeight || info.windowHeight || 0;
  const sa = info.safeArea;
  if (!sa || !screenH) return { top: 20, bottom: 0 };
  return {
    top: Math.max(0, Math.round(sa.top || 0)),
    bottom: Math.max(0, Math.round(screenH - (sa.bottom || screenH))),
  };
}

export class App {
  constructor() {
    // jsbridge 未就绪时可能抛错，退回一个常见的 iPhone 逻辑分辨率，
    // 正常情况下 game.js 已等 bridge 就绪才启动，这里只是最后防线
    let info = { windowWidth: 375, windowHeight: 667, pixelRatio: 2 };
    try {
      info = wx.getSystemInfoSync();
    } catch (e) {
      console.warn('getSystemInfoSync 失败，使用默认视口', e);
    }
    this.W = info.windowWidth;
    this.H = info.windowHeight;
    this.dpr = Math.min(info.pixelRatio || 2, 3);
    if (this.dpr <= 0 || !this.W || !this.H) {
      this.dpr = 2; this.W = 375; this.H = 667;
    }
    // 安全区与微信胶囊：对局页顶栏/底栏都要避开它们，
    // 之前各场景各自写死 132 / 128 的边距，是"位置看着不对"的根因之一。
    const insets = insetsFrom(info);
    this.safeTop = insets.top;
    this.safeBottom = insets.bottom;
    this.menuRect = getMenuButtonRect();

    this.canvas = wx.createCanvas();
    this.canvas.width = Math.floor(this.W * this.dpr);
    this.canvas.height = Math.floor(this.H * this.dpr);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(this.dpr, this.dpr);

    this.roomId = null;
    this.asyncGameId = null;
    this.loginState = CONFIG.enableOnline ? 'loading' : 'off';
    this.loginError = null;
    this.authVerified = false; // 本次启动是否已用 /v1/me 校验过登录态
    this.scene = null;
    // 从群聊卡片进入小游戏时微信会带上 shareTicket，群排行榜需要它
    this.launchShareTicket = '';
    try {
      const opts = wx.getLaunchOptionsSync ? wx.getLaunchOptionsSync() : {};
      this.launchShareTicket = (opts && opts.shareTicket) || '';
    } catch { /* ignore */ }

    this.setScene(new HomeScene(this));
    this.bindTouch();
    this.bindShare();
    this.bindShow();

    // 全场景共用的底纹（渐变 + 点阵）：烘焙到离屏画布，避免每帧重绘
    this.bgCanvas = null;
    this.bgKey = '';

    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);

    // 先后端环境判定（真机要探测局域网，异步的），再登录
    this.resolveBackend()
      .then(() => this.autoLogin())
      .then(() => this.handleLaunch())
      // 启动后尝试回到上次断线离开、且还没被回收的房间
      .then(() => this.tryResumeRoom());

    // 视口校正：若启动时 bridge 未就绪走了默认尺寸，就绪后重取一次并更新画布；
    // 之后浏览器窗口尺寸变化（resize / 开发者工具开关）同样校正，保证画布位图与显示一致。
    setTimeout(() => this.applyViewport(), 300);
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', () => this.applyViewport());
    }
  }

  /** 校正视口：同步 W/H 与画布位图，坐标从此以最新窗口为准（resize 后触摸/布局不再错位） */
  applyViewport() {
    try {
      const latest = wx.getSystemInfoSync();
      if (!latest) return;
      const insets = insetsFrom(latest);
      this.safeTop = insets.top;
      this.safeBottom = insets.bottom;
      this.menuRect = getMenuButtonRect();
      if (latest.windowWidth && (latest.windowWidth !== this.W || latest.windowHeight !== this.H)) {
        this.W = latest.windowWidth;
        this.H = latest.windowHeight;
        this.dpr = Math.min(latest.pixelRatio || 2, 3);
        if (this.dpr <= 0 || !this.W || !this.H) {
          this.dpr = 2;
          this.W = 375;
          this.H = 667;
          return;
        }
        this.canvas.width = Math.floor(this.W * this.dpr);
        this.canvas.height = Math.floor(this.H * this.dpr);
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      }
    } catch (e) { /* 保留原视口 */ }
  }

  /* ---------------- 生命周期 ---------------- */

  setScene(scene) {
    if (this.scene && typeof this.scene.destroy === 'function') this.scene.destroy();
    this.scene = scene;
  }

  /**
   * 铺底：渐变 + 点阵底纹由 App 统一负责，各场景只画自己的内容（契约同「不透明底」）。
   * 底纹烘焙一次后逐帧贴图；视口变化时按键重建。
   */
  paintBackground() {
    const ctx = this.ctx;
    const dpr = Math.min(this.dpr || 1, 2); // 底纹不需要 3 倍图，省显存
    const key = `${this.W}x${this.H}@${dpr}`;
    if (this.bgKey !== key) {
      this.bgKey = key;
      this.bgCanvas = createBackgroundCanvas(this.W, this.H, dpr);
    }
    if (this.bgCanvas) ctx.drawImage(this.bgCanvas, 0, 0, this.W, this.H);
    else paintHomeBackground(ctx, this.W, this.H);
  }

  frame() {
    const ctx = this.ctx;
    this.paintBackground();
    try {
      this.scene.render(ctx, this.W, this.H);
    } catch (e) {
      console.error('渲染异常', e);
    }
    requestAnimationFrame(this.frame);
  }

  bindTouch() {
    wx.onTouchStart((e) => {
      const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
      if (!t || !this.scene) return;
      // 需要按下/滑动/抬起三段交互的场景（如房间列表滚动）走 onTouchStart，其余场景保持 onTap
      try {
        if (typeof this.scene.onTouchStart === 'function') this.scene.onTouchStart(t.clientX, t.clientY);
        else this.scene.onTap(t.clientX, t.clientY);
      } catch (err) { console.error('点击处理异常', err); }
    });
    wx.onTouchMove((e) => {
      const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
      if (!t || !this.scene || typeof this.scene.onTouchMove !== 'function') return;
      try { this.scene.onTouchMove(t.clientX, t.clientY); } catch (err) { console.error('滑动处理异常', err); }
    });
    wx.onTouchEnd((e) => {
      const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
      if (!t || !this.scene || typeof this.scene.onTouchEnd !== 'function') return;
      try { this.scene.onTouchEnd(t.clientX, t.clientY); } catch (err) { console.error('抬起处理异常', err); }
    });
  }

  bindShare() {
    const shareData = () => {
      // 异步对局用 gameId 作为分享 query；实时对战用 room
      if (this.asyncGameId) {
        return {
          title: `来下一盘云柯点格棋（${this.asyncGameId}）`,
          query: `gameId=${this.asyncGameId}`,
        };
      }
      return {
        title: CONFIG.shareTitle.replace('{room}', this.roomId || ''),
        query: `room=${this.roomId || ''}`,
      };
    };
    try { wx.showShareMenu({ withShareTicket: true }); } catch { /* ignore */ }
    try { wx.onShareAppMessage(shareData); } catch { /* ignore */ }
  }

  bindShow() {
    wx.onShow((res) => {
      // 从群聊卡片再次进入时更新 shareTicket
      if (res && res.shareTicket) this.launchShareTicket = res.shareTicket;
      const q = (res && res.query) || {};
      // 分享卡片带 room 直接进房；小程序码扫码进入带 scene（room-XXXX），同样解析进房
      const room = q.room ? String(q.room).toUpperCase() : this.parseSceneRoom(q.scene);
      if (room && room !== this.roomId) {
        this.enterRoom(room);
        return;
      }
      // 异步对局分享/卡片进入：query 里带 gameId
      const gameId = q.gameId ? String(q.gameId).toUpperCase() : '';
      if (gameId && gameId !== this.asyncGameId) {
        this.enterAsyncGame(gameId);
        return;
      }
      // 从后台回到前台：若连接已断则重连
      const s = this.scene && this.scene.session;
      if (s && s.online && s.connection === 'closed') {
        if (s instanceof AsyncSession) s.refresh();
        else s.client && s.client.connect();
      }
      // 断线重连：上次的房间若还没被回收，自动回去
      this.tryResumeRoom();
    });
  }

  /**
   * 断线重连：本地记着上次进的房间、服务器上这间房还在、自己仍在座位上且未终局 → 自动进去。
   * 房间已被空房回收（双方离线超过 64s）时清掉记录，安静留在首页。
   */
  async tryResumeRoom() {
    if (!CONFIG.enableOnline || this._resuming) return false;
    const cur = this.scene;
    // 已经在联网对局里（含异步对局）就不打扰
    if (cur && cur.session && cur.session.online) return false;
    const last = api.getLastRoom();
    if (!last) return false;
    this._resuming = true;
    try {
      await this.ensureLogin();
      const info = await api.getRoom(last);
      const uid = api.getUid();
      const mine = (info.players || []).some((p) => p.uid && p.uid === uid);
      if (!mine || info.status === 'finished') {
        api.clearLastRoom();
        return false;
      }
      const ok = await this.enterRoom(last, { auto: true });
      if (ok) toast(`已回到房间 ${last}`);
      return ok;
    } catch (e) {
      // 404 = 房间已经被空房回收：清掉记录，不再反复重试；
      // 其它错误（网络抖动）留着记录，下次回前台再试一次。
      if (e && e.statusCode === 404) api.clearLastRoom();
      return false;
    } finally {
      this._resuming = false;
    }
  }

  /**
   * 从小程序码 scene 参数解析房间号。
   * 微信启动参数里的 scene 是 URL 编码的，格式 room-ABC123（不含 = &），需先 decodeURIComponent。
   * 解析不到返回空串。
   */
  parseSceneRoom(scene) {
    if (!scene) return '';
    let decoded = String(scene);
    try { decoded = decodeURIComponent(decoded); } catch { /* 保留原值继续尝试 */ }
    const m = /room-([A-Z2-9]{4,8})/.exec(decoded);
    return m ? m[1] : '';
  }

  async handleLaunch() {
    try {
      const opts = wx.getLaunchOptionsSync ? wx.getLaunchOptionsSync() : {};
      const q = (opts && opts.query) || {};
      // 冷启动：分享卡片 room 或小程序码 scene 都能直接进房
      const room = q.room ? String(q.room).toUpperCase() : this.parseSceneRoom(q.scene);
      if (room) await this.enterRoom(room);
      const gameId = q.gameId ? String(q.gameId).toUpperCase() : '';
      if (gameId) await this.enterAsyncGame(gameId);
    } catch (e) {
      console.warn('处理启动参数失败', e);
    }
  }

  /* ---------------- 登录 ---------------- */

  /**
   * 判定后端环境（本地 / 线上）。真机上的开发版需要探测局域网后端，是异步的，
   * 所以必须在登录之前 await，否则第一个请求可能发到错的地址。
   * 判定结果挂到 this.env，首页状态条会显示「本地 xxx」以便确认没连错环境。
   */
  async resolveBackend() {
    try {
      this.env = await resolveEndpoints();
    } catch (e) {
      this.env = null; // 判定失败不影响启动：API 层有兜底地址
      console.warn('后端环境判定失败', e);
    }
    return this.env;
  }

  /**
   * 启动登录：本地没有 token 就先 wx.login 换一个，再用 /v1/me 校验一次。
   * token 过期或残留了别的后端签发的 token 时，api 层会自动重新登录并重试，
   * 所以这里能拿到 me 就说明登录态确实可用（不能只看本地有没有 token）。
   */
  async autoLogin() {
    if (!CONFIG.enableOnline) { this.loginState = 'off'; return; }
    // 硬超时看门狗：真机调试下 wx.login / wx.request 偶发既不回调 success 也不回调 fail，
    // await 链会永久挂起，界面永远停在「正在连接服务器…」。25s（覆盖 10s 请求超时 +
    // 401 自动重登 + 二次请求）后强制按失败结算，并把原因显示在状态胶囊上。
    const result = await Promise.race([
      (async () => {
        try {
          await api.ensureToken();
          const me = await api.me();
          return { state: 'ok', me };
        } catch (e) {
          return { state: 'fail', error: e };
        }
      })(),
      sleep(25000).then(() => ({ state: 'timeout', error: new Error('连接超时（25s），点击状态条重试') })),
    ]);
    if (result.state === 'ok') {
      this.loginState = 'ok';
      this.authVerified = true;
      // 登录后把最新积分上传到微信云存储，好友/群排行榜才能看到
      this.uploadMyRating(result.me);
    } else {
      this.loginState = 'fail';
      this.loginError = result.error.message;
      console.warn('登录失败', result.error);
    }
  }

  /**
   * 把自己的最新积分上传到微信云存储（好友/群排行榜的数据源）。
   * @param {object} [me] 已经拉过的 /v1/me 结果，复用可省一次请求；不传则自己拉。
   * 失败不影响游戏主流程。
   */
  async uploadMyRating(me) {
    if (!CONFIG.enableOnline) return;
    if (typeof wx === 'undefined' || typeof wx.setUserCloudStorage !== 'function') return;
    try {
      if (!me) me = await api.me();
      if (!me || !me.rating) return; // 还没战绩（积分 0），不上传
      const payload = {
        rating: Number(me.rating) || 0,
        wins: Number(me.wins) || 0,
        losses: Number(me.losses) || 0,
        draws: Number(me.draws) || 0,
        nick: me.nick || '',
      };
      wx.setUserCloudStorage({
        KVDataList: [{ key: CONFIG.cloudStorageKey, value: JSON.stringify(payload) }],
        fail: (e) => console.warn('上传积分到微信云存储失败', e),
      });
    } catch (e) {
      console.warn('上传积分到微信云存储失败', e);
    }
  }

  async ensureLogin() {
    if (!CONFIG.enableOnline) throw new Error('当前为单机模式');
    await api.ensureToken();
    // 冷启动时校验一次登录态：本地 token 可能已过期（或来自切换前的后端），
    // 401 时 api 层会自动重新登录并重试，通过后本次会话不再重复校验。
    if (!this.authVerified) {
      await api.me();
      this.authVerified = true;
    }
    this.loginState = 'ok';
  }

  /* ---------------- 场景切换 ---------------- */

  /**
   * 返回首页。
   * 这里代表「主动离开房间」（不是断线）：清掉本地自动回房记录，
   * 并通知服务端解除「一人一房」归属 —— 否则用户会被自动拉回这间房。
   */
  goHome() {
    const roomId = this.roomId;
    this.roomId = null;
    this.asyncGameId = null;
    api.clearLastRoom();
    this.setScene(new HomeScene(this)); // 销毁旧场景 → 关闭 WebSocket
    if (roomId) api.leaveRoom(roomId).catch(() => { /* 离开失败不影响回首页 */ });
  }

  /** 大厅：房间列表 */
  showLobby() {
    this.roomId = null;
    this.setScene(new LobbyScene(this));
  }

  /** 状态胶囊显示失败/超时时，点它手动重试登录（真机调试挂起后的主要恢复手段） */
  retryLogin() {
    if (this.loginState !== 'fail' || this._retrying) return;
    this._retrying = true;
    this.loginState = 'loading';
    this.loginError = null;
    api.clearLogin();
    this.autoLogin().finally(() => { this._retrying = false; });
  }

  goSettings() {
    this.roomId = null;
    this.setScene(new SettingsScene(this));
  }

  /** 积分排行榜 */
  goRanking() {
    this.roomId = null;
    this.setScene(new RankingScene(this));
  }

  /** 战绩列表 */
  goMatches() {
    this.roomId = null;
    this.setScene(new MatchesScene(this));
  }

  /** 对局复盘：先拉详情再进复盘播放器 */
  goReplay(matchId) {
    this.roomId = null;
    this.setScene(new ReplayScene(this, matchId));
  }

  /** 玩法介绍：规则说明页 */
  goHowTo() {
    this.roomId = null;
    this.setScene(new HowToScene(this));
  }

  startLocal() {
    const n = Settings.boardSize;
    this.setScene(new GameScene(this, new LocalSession({ rows: n, cols: n, level: Settings.aiLevel, firstPlayer: Settings.firstPlayerValue() })));
  }

  promptJoin() {
    wx.showModal({
      title: '加入房间',
      placeholderText: '输入好友给的房间号',
      editable: true,
      success: (res) => {
        if (res.confirm && res.content) this.enterRoom(String(res.content).trim().toUpperCase());
      },
    });
  }

  /** 陌生人快速匹配：优先加入等待房，没有就自己开房等陌生人 */
  async quickMatch() {
    try {
      await this.ensureLogin();
    } catch (e) {
      toast(`登录失败：${e.message}`);
      return;
    }
    wx.showLoading({ title: '匹配中…', mask: true });
    try {
      const n = Settings.boardSize;
      const res = await api.quickMatch(n, n);
      wx.hideLoading();
      if (!res.roomId) {
        toast('暂时没有对手，请稍后再试');
        return;
      }
      const ok = await this.enterRoom(res.roomId);
      // 服务端口径：一个用户同一时间只能有一个房间，已有房间时会直接把你送回那间
      if (ok && res.action === 'reuse') toast(`你已有房间 ${res.roomId}，直接进入`);
    } catch (e) {
      wx.hideLoading();
      toast(`匹配失败：${e.message}`);
    }
  }

  /**
   * 创建房间。visibility 为 'public'（公开房间，上大厅）或 'friends'（仅好友可见，不公开列出）。
   * 选择由首页「创建房间」按钮通过 ActionSheet 给出，默认公开以保持向后兼容。
   */
  async createRoom(visibility = 'public') {
    try {
      await this.ensureLogin();
    } catch (e) {
      toast(`登录失败：${e.message}`);
      return;
    }
    wx.showLoading({ title: '创建房间…', mask: true });
    try {
      const n = Settings.boardSize;
      const res = await api.createRoom(n, n, visibility);
      wx.hideLoading();
      const ok = await this.enterRoom(res.roomId);
      // 已有未结束的房间时，服务端不会新建，而是把你送回那间（避免一堆幽灵房）
      if (ok && res.action === 'reuse') toast(`你已有房间 ${res.roomId}，直接进入`);
    } catch (e) {
      wx.hideLoading();
      toast(`创建失败：${e.message}`);
    }
  }

  /**
   * 进入房间；成功返回 true，失败返回 false（已 toast 原因）。
   * @param {object} [opts]
   *   auto —— 断线重连的自动回房：不弹「房间已满」这类告警，失败就静默留在首页
   */
  async enterRoom(roomId, { auto = false } = {}) {
    try {
      await this.ensureLogin();
    } catch (e) {
      if (!auto) toast(`登录失败：${e.message}`);
      return false;
    }
    wx.showLoading({ title: auto ? '回到房间…' : '进入房间…', mask: true });
    const client = new GameClient({ roomId, token: api.getToken() });
    const session = new RemoteSession(client, { roomId, onFinish: () => this.uploadMyRating() });
    client.connect();

    const deadline = Date.now() + 6000;
    while (!session.state && Date.now() < deadline) await sleep(120);
    wx.hideLoading();

    if (!session.state) {
      client.close();
      if (!auto) toast('进入房间失败，请检查网络');
      return false;
    }
    if (session.mySeat === 0) {
      client.close();
      if (!auto) toast('房间已满');
      else api.clearLastRoom(); // 座位已经没了，别再自动重试
      return false;
    }
    this.roomId = roomId;
    // 记住这间房：进程被杀 / 断网后重新上线可以自动回来（点返回首页会清掉）
    api.setLastRoom(roomId);
    this.setScene(new GameScene(this, session));
    return true;
  }

  /* ---------------- 异步对战 ---------------- */

  /** 首页「异步对战」：创建一局并进入（等好友通过分享加入） */
  async startAsync() {
    try {
      await this.ensureLogin();
    } catch (e) {
      toast(`登录失败：${e.message}`);
      return;
    }
    wx.showLoading({ title: '创建对局…', mask: true });
    try {
      const n = Settings.boardSize;
      const res = await api.createAsyncGame({ rows: n, cols: n });
      wx.hideLoading();
      if (!res.gameId) {
        toast('创建失败，请稍后再试');
        return;
      }
      await this.enterAsyncGame(res.gameId);
    } catch (e) {
      wx.hideLoading();
      toast(`创建失败：${e.message}`);
    }
  }

  /**
   * 进入异步对局。若尚未加入（等待中且不是创建者），自动 join。
   * 成功返回 true，失败 false。
   */
  async enterAsyncGame(gameId) {
    try {
      await this.ensureLogin();
    } catch (e) {
      toast(`登录失败：${e.message}`);
      return false;
    }
    wx.showLoading({ title: '进入对局…', mask: true });
    try {
      // 先拉一下详情：如果是 waiting 且不是创建者，就 join
      let info;
      try {
        info = await api.getAsyncGame(gameId);
      } catch (e) {
        wx.hideLoading();
        toast('对局不存在或已结束');
        return false;
      }
      const uid = api.getUid();
      const isPlayer1 = info.players && info.players[0] && info.players[0].uid === uid;
      if (info.status === 'waiting' && !isPlayer1) {
        try { await api.joinAsyncGame(gameId); } catch (e) { /* 可能已被人抢走 */ }
      }
      wx.hideLoading();
      this.asyncGameId = gameId;
      this.setScene(new GameScene(this, new AsyncSession({ gameId, onFinish: () => this.uploadMyRating() })));
      return true;
    } catch (e) {
      wx.hideLoading();
      toast(`进入失败：${e.message}`);
      return false;
    }
  }

  /* ---------------- 分享 ---------------- */

  shareRoom() {
    if (this.asyncGameId) {
      wx.shareAppMessage({
        title: `来下一盘云柯点格棋（${this.asyncGameId}）`,
        query: `gameId=${this.asyncGameId}`,
      });
      return;
    }
    if (!this.roomId) return;
    wx.shareAppMessage({
      title: CONFIG.shareTitle.replace('{room}', this.roomId),
      query: `room=${this.roomId}`,
    });
  }

  copyRoom() {
    if (!this.roomId) return;
    wx.setClipboardData({ data: this.roomId });
  }
}
