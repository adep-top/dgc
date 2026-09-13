/**
 * 音效与震动反馈。
 *
 * 音效用 WebAudio 合成（wx.createWebAudioContext，基础库 2.19.0+），
 * 不依赖任何音频资源文件；环境不支持时静默降级为无声。
 * 所有反馈均受 Settings 开关控制。
 */
import { Settings } from './settings.js';

let ctx = null;

function ensureCtx() {
  if (ctx) return ctx;
  try {
    if (typeof wx !== 'undefined' && wx.createWebAudioContext) {
      ctx = wx.createWebAudioContext();
    } else if (typeof AudioContext !== 'undefined') {
      ctx = new AudioContext();
    } else if (typeof webkitAudioContext !== 'undefined') {
      ctx = new webkitAudioContext();
    }
  } catch (e) {
    ctx = null;
  }
  return ctx;
}

/** 播放一个短音：freq 频率、dur 时长、type 波形、vol 音量、delay 延迟 */
function tone(freq, dur, { type = 'triangle', vol = 0.1, delay = 0 } = {}) {
  const c = ensureCtx();
  if (!c) return;
  try {
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g);
    g.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch (e) {
    // 播放失败静默
  }
}

function seq(notes, step = 0.1) {
  notes.forEach((f, i) => tone(f, 0.12, { type: 'triangle', vol: 0.1, delay: i * step }));
}

export const sound = {
  /** UI 点击反馈 */
  tap() {
    if (!Settings.sound) return;
    tone(520, 0.05, { type: 'triangle', vol: 0.08 });
  },

  /** 落子 */
  move() {
    if (!Settings.sound) return;
    tone(660, 0.06, { type: 'triangle', vol: 0.1 });
  },

  /** 得分（围成一个格子） */
  gain() {
    if (!Settings.sound) return;
    tone(880, 0.08, { type: 'triangle', vol: 0.11 });
    tone(1320, 0.12, { type: 'triangle', vol: 0.1, delay: 0.07 });
  },

  /** 胜利 */
  win() {
    if (!Settings.sound) return;
    seq([523, 659, 784, 1046], 0.1);
  },

  /** 失败 */
  lose() {
    if (!Settings.sound) return;
    seq([392, 330, 262], 0.12);
  },

  /** 平局 */
  tie() {
    if (!Settings.sound) return;
    seq([440, 440], 0.1);
  },

  /** 震动反馈（仅玩家自身落子时触发）。type: light | medium | heavy */
  vibrate(type = 'light') {
    if (!Settings.vibration) return;
    try {
      if (typeof wx !== 'undefined' && wx.vibrateShort) wx.vibrateShort({ type });
    } catch (e) {
      // 设备不支持时静默
    }
  },

  /** 终局音效：win=true 胜利、false 失败、null/undefined 平局 */
  finish(win) {
    if (win === null || win === undefined) this.tie();
    else if (win) this.win();
    else this.lose();
  },
};
