/**
 * 游戏设置：音效开关 / 震动反馈 / 棋盘大小 / 先手方。
 *
 * 写入 wx 本地存储，设置项自动保存，下次启动时自动生效。
 * 在无 wx 环境（如 Node 冒烟测试）下退回内存模式，不影响功能验证。
 */
import { CONFIG } from './config.js';

const KEY = 'dgc_settings_v1';

/** 可选的棋盘大小（格子数） */
export const BOARD_SIZES = [4, 5, 6, 7, 8];

/** 先手方选项：player=玩家先手，ai=AI 先手，random=随机 */
export const FIRST_PLAYERS = [
  { value: 'player', label: '玩家先手' },
  { value: 'ai', label: 'AI 先手' },
  { value: 'random', label: '随机' },
];

/** AI 难度选项（仅对单人练习生效） */
export const AI_LEVELS = [
  { value: 'easy', label: '简单' },
  { value: 'normal', label: '普通' },
  { value: 'hard', label: '困难' },
];

const DEFAULTS = {
  sound: true,                       // 音效开关
  vibration: true,                   // 震动反馈
  boardSize: BOARD_SIZES.includes(CONFIG.defaultSize) ? CONFIG.defaultSize : 6,
  firstPlayer: 'player',             // 仅对单人练习（本地人机）生效
  aiLevel: AI_LEVELS.some((a) => a.value === CONFIG.aiLevel) ? CONFIG.aiLevel : 'normal',
};

/** 合并 + 校验存储值，非法字段回退默认 */
function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.sound === 'boolean') out.sound = raw.sound;
  if (typeof raw.vibration === 'boolean') out.vibration = raw.vibration;
  if (BOARD_SIZES.includes(raw.boardSize)) out.boardSize = raw.boardSize;
  if (FIRST_PLAYERS.some((f) => f.value === raw.firstPlayer)) out.firstPlayer = raw.firstPlayer;
  if (AI_LEVELS.some((a) => a.value === raw.aiLevel)) out.aiLevel = raw.aiLevel;
  return out;
}

function loadRaw() {
  try {
    if (typeof wx === 'undefined' || !wx.getStorageSync) return null;
    const raw = wx.getStorageSync(KEY);
    if (!raw) return null;
    return typeof raw === 'object' ? raw : JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function persist(data) {
  try {
    if (typeof wx === 'undefined' || !wx.setStorageSync) return;
    wx.setStorageSync(KEY, JSON.stringify(data));
  } catch (e) {
    // 存储失败不影响本次会话，下次启动回退默认
  }
}

export const Settings = {
  _data: null,

  /** 首次访问时读取本地存储 */
  load() {
    if (!this._data) this._data = sanitize(loadRaw());
    return this;
  },

  save() {
    if (this._data) persist(this._data);
  },

  get sound() { return this.load()._data.sound; },
  set sound(v) { this.load()._data.sound = !!v; this.save(); },

  get vibration() { return this.load()._data.vibration; },
  set vibration(v) { this.load()._data.vibration = !!v; this.save(); },

  get boardSize() { return this.load()._data.boardSize; },
  set boardSize(v) {
    if (BOARD_SIZES.includes(v)) { this.load()._data.boardSize = v; this.save(); }
  },

  get firstPlayer() { return this.load()._data.firstPlayer; },
  set firstPlayer(v) {
    if (FIRST_PLAYERS.some((f) => f.value === v)) { this.load()._data.firstPlayer = v; this.save(); }
  },

  get aiLevel() { return this.load()._data.aiLevel; },
  set aiLevel(v) {
    if (AI_LEVELS.some((a) => a.value === v)) { this.load()._data.aiLevel = v; this.save(); }
  },

  /** 把先手方设置解析成 1（玩家红方先手）或 2（AI 先手） */
  firstPlayerValue() {
    const f = this.firstPlayer;
    if (f === 'ai') return 2;
    if (f === 'random') return Math.random() < 0.5 ? 1 : 2;
    return 1;
  },
};
