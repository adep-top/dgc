/**
 * 云柯点格棋 (Dots and Boxes) 规则引擎
 * 纯逻辑、零依赖，Node / Cloudflare Workers / 微信小游戏 三端共用。
 *
 * 坐标约定：
 *   棋盘为 rows 行 cols 列「格子」，点阵为 (rows+1) x (cols+1)。
 *   边 id：横边 `h-{r}-{c}`（0<=r<=rows, 0<=c<cols），竖边 `v-{r}-{c}`（0<=r<rows, 0<=c<=cols）。
 *   点 (r,c) 位于第 r 行第 c 列（0 起）。
 */

export const VERSION = 1;
export const STATUS = { WAITING: 'waiting', PLAYING: 'playing', FINISHED: 'finished' };
export const DRAW = 3; // winner === 3 表示平局

export const other = (p) => (p === 1 ? 2 : 1);

export function edgeCount(rows, cols) {
  return (rows + 1) * cols + rows * (cols + 1);
}

/** 竖边在 edges 字符串中的起始下标 */
export function vOffset(rows, cols) {
  return (rows + 1) * cols;
}

export function makeEdgeId(kind, r, c) {
  return `${kind}-${r}-${c}`;
}

export function parseEdge(id) {
  if (typeof id !== 'string') return null;
  const m = /^([hv])-(\d{1,3})-(\d{1,3})$/.exec(id);
  if (!m) return null;
  return { kind: m[1], r: Number(m[2]), c: Number(m[3]) };
}

/** 边 id -> edges 下标，非法返回 -1 */
export function edgeIndex(id, rows, cols) {
  const p = parseEdge(id);
  if (!p) return -1;
  if (p.kind === 'h') {
    if (p.r < 0 || p.r > rows || p.c < 0 || p.c >= cols) return -1;
    return p.r * cols + p.c;
  }
  if (p.r < 0 || p.r >= rows || p.c < 0 || p.c > cols) return -1;
  return vOffset(rows, cols) + p.r * (cols + 1) + p.c;
}

/** edges 下标 -> 边 id */
export function edgeIdFromIndex(i, rows, cols) {
  const off = vOffset(rows, cols);
  if (i < 0 || i >= edgeCount(rows, cols)) return null;
  if (i < off) return makeEdgeId('h', Math.floor(i / cols), i % cols);
  const k = i - off;
  return makeEdgeId('v', Math.floor(k / (cols + 1)), k % (cols + 1));
}

/** 格子 boxIdx 的四条边（edges 下标） */
export function boxEdges(boxIdx, rows, cols) {
  const r = Math.floor(boxIdx / cols);
  const c = boxIdx % cols;
  const off = vOffset(rows, cols);
  return [
    r * cols + c,                    // 上  h-{r}-{c}
    (r + 1) * cols + c,              // 下  h-{r+1}-{c}
    off + r * (cols + 1) + c,        // 左  v-{r}-{c}
    off + r * (cols + 1) + c + 1,    // 右  v-{r}-{c+1}
  ];
}

/** 一条边相邻的 1~2 个格子 */
export function boxesAroundEdge(id, rows, cols) {
  const p = parseEdge(id);
  if (!p) return [];
  const out = [];
  if (p.kind === 'h') {
    if (p.r > 0) out.push((p.r - 1) * cols + p.c); // 上方格子
    if (p.r < rows) out.push(p.r * cols + p.c);    // 下方格子
  } else {
    if (p.c > 0) out.push(p.r * cols + p.c - 1);   // 左方格子
    if (p.c < cols) out.push(p.r * cols + p.c);    // 右方格子
  }
  return out;
}

export function createGame({ rows = 6, cols = 6, firstPlayer = 1 } = {}) {
  return {
    v: VERSION,
    rows,
    cols,
    edges: '0'.repeat(edgeCount(rows, cols)), // '0' 空闲 / '1' 已占
    owner: '0'.repeat(rows * cols),           // '0' 无主 / '1' / '2'
    turn: firstPlayer,
    scores: [0, 0],
    seq: 0,
    status: STATUS.WAITING,
    winner: 0,
    moves: [],
  };
}

export function cloneState(s) {
  return {
    v: s.v,
    rows: s.rows,
    cols: s.cols,
    edges: s.edges,
    owner: s.owner,
    turn: s.turn,
    scores: [s.scores[0], s.scores[1]],
    seq: s.seq,
    status: s.status,
    winner: s.winner,
    moves: s.moves.slice(),
  };
}

export function freeEdges(s) {
  const out = [];
  for (let i = 0; i < s.edges.length; i++) {
    if (s.edges[i] === '0') out.push(edgeIdFromIndex(i, s.rows, s.cols));
  }
  return out;
}

export function isEdgeFree(s, id) {
  const i = edgeIndex(id, s.rows, s.cols);
  return i >= 0 && s.edges[i] === '0';
}

export function startGame(s) {
  if (s.status !== STATUS.WAITING) return s;
  const n = cloneState(s);
  n.status = STATUS.PLAYING;
  return n;
}

/**
 * 落子。返回新的状态（不修改入参）。
 * @returns {{ok:boolean, reason?:string, state?:object, gained:number[], extraTurn:boolean, finished:boolean, winner:number}}
 */
export function applyMove(s, player, edgeId) {
  const fail = (reason) => ({ ok: false, reason, gained: [], extraTurn: false, finished: false, winner: s.winner });
  if (player !== 1 && player !== 2) return fail('bad_player');
  if (s.status === STATUS.FINISHED) return fail('finished');
  if (s.status === STATUS.WAITING) return fail('not_started');
  if (s.turn !== player) return fail('not_your_turn');
  const idx = edgeIndex(edgeId, s.rows, s.cols);
  if (idx < 0) return fail('bad_edge');
  if (s.edges[idx] === '1') return fail('edge_taken');

  const n = cloneState(s);
  const edges = n.edges.split('');
  const owner = n.owner.split('');
  edges[idx] = '1';

  // 检查该边相邻格子是否被补全
  const gained = [];
  for (const box of boxesAroundEdge(edgeId, n.rows, n.cols)) {
    if (owner[box] !== '0') continue;
    const es = boxEdges(box, n.rows, n.cols);
    if (es.every((e) => edges[e] === '1')) {
      owner[box] = String(player);
      gained.push(box);
    }
  }

  n.edges = edges.join('');
  n.owner = owner.join('');
  n.scores[player - 1] += gained.length;
  const extraTurn = gained.length > 0;
  n.turn = extraTurn ? player : other(player);
  n.seq += 1;
  n.moves.push({ seq: n.seq, by: player, edge: edgeId, gained });

  const finished = !n.edges.includes('0');
  if (finished) {
    n.status = STATUS.FINISHED;
    n.winner = n.scores[0] === n.scores[1] ? DRAW : (n.scores[0] > n.scores[1] ? 1 : 2);
  }
  return { ok: true, state: n, gained, extraTurn, finished, winner: n.winner };
}

/** 该边会送几个格子给对手（用于 AI 评估）—— 相邻格子中已有 3 条边的数量 */
export function riskOfEdge(s, id) {
  let risk = 0;
  for (const box of boxesAroundEdge(id, s.rows, s.cols)) {
    if (s.owner[box] !== '0') continue;
    const filled = boxEdges(box, s.rows, s.cols).filter((e) => s.edges[e] === '1').length;
    if (filled === 3) risk += 1;
  }
  return risk;
}

/** 落子后能拿几个格子 */
export function gainOfEdge(s, id) {
  let gain = 0;
  for (const box of boxesAroundEdge(id, s.rows, s.cols)) {
    if (s.owner[box] !== '0') continue;
    const filled = boxEdges(box, s.rows, s.cols).filter((e) => s.edges[e] === '1').length;
    if (filled === 3) gain += 1;
  }
  return gain;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * AI 选点。level:
 *   'easy'   随机；
 *   'normal' 贪心+避险；
 *   'hard'   两层 minimax（我走一步 + 对手最佳应手）。
 */
export function pickMove(s, level = 'normal', rnd = Math.random) {
  const free = freeEdges(s);
  if (!free.length) return null;
  if (level === 'easy') return free[Math.floor(rnd() * free.length)];
  if (level === 'hard') return pickMoveHard(s, rnd);

  let best = -Infinity;
  let pool = [];
  for (const id of free) {
    const gain = gainOfEdge(s, id);
    const risk = riskOfEdge(s, id);
    const score = gain * 10 - risk * 6;
    if (score > best) { best = score; pool = [id]; }
    else if (score === best) pool.push(id);
  }
  return pool[Math.floor(rnd() * pool.length)];
}

/**
 * 局面评估（从 me 视角）：己方格子分差为主，
 * 另给「三面已围、下一步即可拿走」的空格一点权重，鼓励制造双格机会/避免送格。
 */
function evalState(s, me) {
  const opp = other(me);
  let v = (s.scores[me - 1] - s.scores[opp - 1]) * 10;
  // 数一下还有多少个「三格边」的空格：这些格子迟早会被拿走，谁走谁得，
  // 静态评估不归属任何一方，仅作微小提示避免深度搜索漏掉它们。
  for (let b = 0; b < s.owner.length; b++) {
    if (s.owner[b] !== '0') continue;
    const filled = boxEdges(b, s.rows, s.cols).filter((e) => s.edges[e] === '1').length;
    if (filled === 3) v += 0.2;
  }
  return v;
}

/**
 * hard 级 AI：深度 2 的极小极大（我走 → 对手最佳应手 → 评估）。
 * 不做剪枝，云柯点格棋可选边在残局时数量已不大，开局也可接受。
 */
export function pickMoveHard(s, rnd = Math.random) {
  const me = s.turn;
  const opp = other(me);
  const free = freeEdges(s);
  if (!free.length) return null;

  let best = -Infinity;
  let pool = [];
  for (const id of free) {
    const r1 = applyMove(s, me, id);
    if (!r1.ok) continue;
    let score;
    if (r1.finished) {
      score = r1.winner === me ? 10000 : (r1.winner === DRAW ? 0 : -10000);
    } else if (r1.extraTurn) {
      // 我得格了，免费再走一步：直接按当前分差评估，略加鼓励
      score = evalState(r1.state, me) + 2;
    } else {
      // 对手走他认为对自己最有利的一步 → 我方取悲观值
      let worst = Infinity;
      for (const e2 of freeEdges(r1.state)) {
        const r2 = applyMove(r1.state, opp, e2);
        if (!r2.ok) continue;
        let v;
        if (r2.finished) v = r2.winner === me ? 10000 : (r2.winner === DRAW ? 0 : -10000);
        else v = evalState(r2.state, me);
        if (v < worst) worst = v;
      }
      score = worst;
    }
    if (score > best) { best = score; pool = [id]; }
    else if (score === best) pool.push(id);
  }
  return pool[Math.floor(rnd() * pool.length)];
}

/**
 * 悔棋：回退最后一步落子，返回新状态（不修改入参）。
 * 规则：把最后一步的边清空、得格归还、扣分；回合方交还给走那步的玩家。
 * 一局内可多次调用，直到 moves 为空。
 */
export function undoMove(s) {
  if (!s.moves.length) return s;
  const n = cloneState(s);
  const last = n.moves.pop();
  const idx = edgeIndex(last.edge, n.rows, n.cols);
  if (idx >= 0 && n.edges[idx] === '1') {
    const edges = n.edges.split('');
    edges[idx] = '0';
    n.edges = edges.join('');
  }
  if (Array.isArray(last.gained)) {
    const owner = n.owner.split('');
    for (const b of last.gained) {
      if (b >= 0 && b < owner.length) owner[b] = '0';
    }
    n.owner = owner.join('');
    n.scores[last.by - 1] = Math.max(0, (n.scores[last.by - 1] || 0) - last.gained.length);
  }
  n.turn = last.by;
  n.seq = n.moves.length; // 与 moves 长度保持一致
  if (n.status === STATUS.FINISHED) {
    n.status = STATUS.PLAYING;
    n.winner = 0;
  }
  return n;
}

/** 序列化（当前 state 本身就是可 JSON 化的紧凑结构） */
export function serialize(s) {
  return s;
}

/** 反序列化 + 基本校验，失败返回 null */
export function deserialize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { rows, cols, edges, owner } = raw;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) return null;
  if (typeof edges !== 'string' || edges.length !== edgeCount(rows, cols)) return null;
  if (typeof owner !== 'string' || owner.length !== rows * cols) return null;
  return { ...cloneState(createGame({ rows, cols })), ...raw, moves: Array.isArray(raw.moves) ? raw.moves : [] };
}
