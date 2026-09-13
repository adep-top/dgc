/**
 * 实时对战房间引擎（移植自原 RoomDO + LobbyDO 的语义，落库实现）。
 *
 * 传输层差异：原版走 WebSocket 长连接（presence = 连接数），adep 云函数是
 * HTTP 轮询（presence = last_seen 心跳）。其余状态机语义逐一对应：
 *   - 开局：坐满两家才 startGame；每步重置回合倒计时；
 *   - 终局（移步完成 / 认输 / 求和 / 超时）：记战绩 + 更新积分（wins*10 + draws*3）；
 *   - 再来一局：双票制，45s 超时作废；对手离场可「等待新对手」换人；
 *   - 空房回收：双方 64s 无任何轮询/指令即销毁（懒回收，在下次访问时结算）；
 *   - 回合超时：轮到谁谁超时判负（懒结算，任意一方下次轮询时触发）。
 *
 * 事件队列（events_json）：客户端轮询时按 seq 增量拉取（audience 过滤）。
 *   both   —— 广播给房间内所有人（move/undo/peer/finished/started 等）
 *   seat   —— 只发给指定座位（snapshot / rematch 结果）
 *   other  —— 广播给除发送者以外的人（chat）
 */
import type { CloudDb, Row } from '@adep/types'
import * as core from './game-core.js'
import { ERR, errText, makeRoomId, C2S, S2C } from './protocol.js'

export const TURN_TIMEOUT_MS = 60 * 1000
export const ONLINE_TTL_MS = 6 * 1000      // 6s 内有过轮询 = 在线（客户端 800ms 轮询）
export const EMPTY_TTL_MS = 64 * 1000      // 双方 64s 无访问 → 空房回收
export const REMATCH_TTL_MS = 45 * 1000
export const MAX_UNDO_PER_GAME = 3
export const MAX_EVENTS = 120
export const CHAT_RATE_MS = 2000

export interface Seat {
  seat: 1 | 2
  uid: string | null
  nick: string | null
  avatar: string | null
  online: boolean
  left: boolean
}

export interface RoomEvent {
  seq: number
  t: string
  audience: 'both' | 'seat' | 'other'
  targetSeat?: number
  actorSeat?: number
  [k: string]: unknown
}

export interface Room {
  roomId: string
  rows: number
  cols: number
  visibility: string
  hostUid: string | null
  seats: [null, Seat, Seat] // 1 起用
  state: ReturnType<typeof core.createGame>
  events: RoomEvent[]
  evtSeq: number
  status: string
  round: number
  turnDeadline: number | null
  drawOfferBy: number
  undoCount: number
  rematchVotes: string[]
  rematchAt: number | null
  lastSeen: [0, number | null, number | null]
  lastChat: [0, number | null, number | null]
  createdAt: number
  updatedAt: number
  finishedAt: number | null
  /** 置位表示本轮事务内销毁房间（不落 save） */
  _destroyed?: boolean
}

export interface RoomInfo {
  roomId: string
  rows: number
  cols: number
  round: number
  status: string
  turn: number
  seq: number
  scores: [number, number]
  visibility: string
  players: Array<{ seat: number; uid: string | null; nick: string | null; avatar: string | null; online: boolean }>
  turnDeadline: number | null
  createdAt: number
  updatedAt: number
}

/* ---------------- 序列化 ---------------- */

function parseRoom(row: Row): Room {
  const seat = (n: 1 | 2): Seat => ({
    seat: n,
    uid: (row[`seat${n}_uid`] as string | null) ?? null,
    nick: (row[`seat${n}_nick`] as string | null) ?? null,
    avatar: (row[`seat${n}_avatar`] as string | null) ?? null,
    online: !!row[`seat${n}_online`],
    left: !!row[`seat${n}_left`],
  })
  return {
    roomId: row.room_id as string,
    rows: Number(row.rows),
    cols: Number(row.cols),
    visibility: (row.visibility as string) || 'public',
    hostUid: (row.host_uid as string | null) ?? null,
    seats: [null, seat(1), seat(2)],
    state: core.deserialize(JSON.parse(row.state_json as string)) ?? core.createGame({ rows: Number(row.rows), cols: Number(row.cols) }),
    events: JSON.parse(row.events_json as string) as RoomEvent[],
    evtSeq: Number(row.evt_seq) || 0,
    status: row.status as string,
    round: Number(row.round) || 1,
    turnDeadline: (row.turn_deadline as number | null) ?? null,
    drawOfferBy: Number(row.draw_offer_by) || 0,
    undoCount: Number(row.undo_count) || 0,
    rematchVotes: JSON.parse((row.rematch_votes as string) || '[]') as string[],
    rematchAt: (row.rematch_at as number | null) ?? null,
    lastSeen: [0, (row.last_seen1 as number | null) ?? null, (row.last_seen2 as number | null) ?? null],
    lastChat: [0, (row.last_chat1 as number | null) ?? null, (row.last_chat2 as number | null) ?? null],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    finishedAt: (row.finished_at as number | null) ?? null,
  }
}

function saveRoom(tx: CloudDb, room: Room): Promise<number> {
  const s1 = room.seats[1]
  const s2 = room.seats[2]
  return tx.table('rooms').where('room_id', room.roomId).update({
    rows: room.rows,
    cols: room.cols,
    visibility: room.visibility,
    host_uid: room.hostUid,
    seat1_uid: s1?.uid ?? null,
    seat1_nick: s1?.nick ?? null,
    seat1_avatar: s1?.avatar ?? null,
    seat1_online: s1?.online ? 1 : 0,
    seat1_left: s1?.left ? 1 : 0,
    seat2_uid: s2?.uid ?? null,
    seat2_nick: s2?.nick ?? null,
    seat2_avatar: s2?.avatar ?? null,
    seat2_online: s2?.online ? 1 : 0,
    seat2_left: s2?.left ? 1 : 0,
    state_json: JSON.stringify(room.state),
    events_json: JSON.stringify(room.events),
    evt_seq: room.evtSeq,
    status: room.status,
    round: room.round,
    turn_deadline: room.turnDeadline,
    draw_offer_by: room.drawOfferBy,
    undo_count: room.undoCount,
    rematch_votes: JSON.stringify(room.rematchVotes),
    rematch_at: room.rematchAt,
    last_seen1: room.lastSeen[1],
    last_seen2: room.lastSeen[2],
    last_chat1: room.lastChat[1],
    last_chat2: room.lastChat[2],
    updated_at: room.updatedAt,
    finished_at: room.finishedAt,
  })
}

async function loadRoom(tx: CloudDb, roomId: string): Promise<Room | null> {
  const row = await tx.table('rooms').where('room_id', roomId).first()
  return row ? parseRoom(row) : null
}

/**
 * 在事务里读-改-写一个房间。fn 内对 room 的修改会整体落库；
 * fn 置 room._destroyed = true 则删除该行。返回 null = 房间不存在。
 */
export async function transactRoom<T>(
  db: CloudDb,
  roomId: string,
  fn: (room: Room, tx: CloudDb) => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    const room = await loadRoom(tx, roomId)
    if (!room) return null
    const out = await fn(room, tx)
    if (room._destroyed) {
      await tx.table('rooms').where('room_id', room.roomId).delete()
    } else {
      room.updatedAt = Date.now()
      await saveRoom(tx, room)
    }
    return out
  })
}

/* ---------------- 基础操作 ---------------- */

export function pushEvent(room: Room, ev: Omit<RoomEvent, 'seq'>): void {
  room.evtSeq += 1
  room.events.push({ ...(ev as object), seq: room.evtSeq } as RoomEvent)
  if (room.events.length > MAX_EVENTS) room.events.splice(0, room.events.length - MAX_EVENTS)
}

/** 按座位过滤事件（增量 + audience） */
export function eventsFor(events: RoomEvent[], since: number, seat: number): RoomEvent[] {
  return events.filter(
    (e) =>
      e.seq > since &&
      (e.audience === 'both' ||
        (e.audience === 'seat' && e.targetSeat === seat) ||
        (e.audience === 'other' && e.actorSeat !== seat)),
  )
}

export function seatOf(room: Room, uid: string): number {
  if (room.seats[1]?.uid === uid) return 1
  if (room.seats[2]?.uid === uid) return 2
  return 0
}

export function seatOccupied(room: Room, seat: number): boolean {
  const p = room.seats[seat]
  return !!(p && p.uid && !p.left)
}

export function info(room: Room): RoomInfo {
  const st = room.state
  return {
    roomId: room.roomId,
    rows: room.rows,
    cols: room.cols,
    round: room.round,
    status: room.status,
    turn: st.turn,
    seq: st.seq,
    scores: [st.scores[0], st.scores[1]],
    visibility: room.visibility,
    players: [1, 2].map((s) => {
      const p = room.seats[s]
      return { seat: s, uid: p?.uid ?? null, nick: p?.nick ?? null, avatar: p?.avatar ?? null, online: !!p?.online }
    }),
    turnDeadline: room.turnDeadline ?? null,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  }
}

export function snapshot(room: Room, seat: number): Record<string, unknown> {
  return {
    t: S2C.SNAPSHOT,
    room: room.roomId,
    you: seat,
    round: room.round,
    state: room.state,
    players: info(room).players,
    hostSeat: 1,
    visibility: room.visibility,
    turnDeadline: room.turnDeadline ?? null,
  }
}

/** 重算座位在线状态；翻转时推 peer online/offline 事件（仅当座位有人） */
export function recomputeOnline(room: Room, nowMs: number): void {
  for (const s of [1, 2] as const) {
    const p = room.seats[s]
    if (!p || !p.uid) continue
    const last = room.lastSeen[s]
    const online = !!last && nowMs - last <= ONLINE_TTL_MS
    if (p.online !== online) {
      p.online = online
      pushEvent(room, { t: S2C.PEER, event: online ? 'online' : 'offline', seat: s, nick: p.nick, audience: 'both' })
    }
  }
}

/** 坐满两家 → 开局 */
function maybeStart(room: Room, nowMs: number): boolean {
  if (room.status === core.STATUS.WAITING && room.seats[1]?.uid && room.seats[2]?.uid) {
    room.state = core.startGame(room.state)
    room.status = core.STATUS.PLAYING
    room.turnDeadline = nowMs + TURN_TIMEOUT_MS
    pushEvent(room, { t: S2C.STARTED, state: room.state, round: room.round, audience: 'both' })
    return true
  }
  return false
}

/* ---------------- 终局记账 ---------------- */

/** 记战绩 + 更新双方积分（wins*10 + draws*3），与微信版口径一致 */
export async function recordResult(tx: CloudDb, room: Room, winner: number): Promise<void> {
  const st = room.state
  const finishedAt = Date.now()
  await tx.table('matches').insert({
    room_id: room.roomId,
    round: room.round,
    rows: room.rows,
    cols: room.cols,
    seat1: room.seats[1]?.uid ?? null,
    seat2: room.seats[2]?.uid ?? null,
    score1: st.scores[0],
    score2: st.scores[1],
    winner,
    moves: st.moves.length,
    moves_json: JSON.stringify(st.moves || []),
    finished_at: finishedAt,
  })
  for (const s of [1, 2] as const) {
    const p = room.seats[s]
    if (!p?.uid) continue // 旁观 / 匿名玩家不落积分
    const isWin = (winner === 1 || winner === 2) && winner === s
    const isDraw = winner === core.DRAW
    const w = isWin ? 1 : 0
    const d = isDraw ? 1 : 0
    const l = isWin || isDraw ? 0 : 1
    // upsert：rating 由 wins/draws 现算，保证与战绩列一致
    await tx.writeQuery(
      `INSERT INTO users (uid, nick, avatar, wins, losses, draws, rating, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET
         wins = wins + excluded.wins,
         losses = losses + excluded.losses,
         draws = draws + excluded.draws,
         rating = (wins + excluded.wins) * 10 + (draws + excluded.draws) * 3,
         nick = excluded.nick,
         avatar = excluded.avatar,
         updated_at = excluded.updated_at`,
      [p.uid, p.nick ?? '', p.avatar ?? '', w, l, d, w * 10 + d * 3, finishedAt],
    )
  }
}

/** 终局落定（移动完成 / 认输 / 求和 / 超时共用） */
export async function finishRoom(tx: CloudDb, room: Room, winner: number, reason: string): Promise<void> {
  room.state = { ...core.cloneState(room.state), status: core.STATUS.FINISHED, winner }
  room.status = core.STATUS.FINISHED
  room.turnDeadline = null
  room.drawOfferBy = 0
  room.finishedAt = Date.now()
  await recordResult(tx, room, winner)
  pushEvent(room, {
    t: S2C.FINISHED,
    state: room.state,
    winner,
    scores: [room.state.scores[0], room.state.scores[1]],
    reason,
    audience: 'both',
  })
}

/* ---------------- 维护（懒结算） ---------------- */

/**
 * 每次轮询/指令/读取前的维护：
 *  1. 「再来一局」邀请超时作废（45s）；
 *  2. 回合超时判负（60s，轮到谁谁输）；
 *  3. 空房回收（双方 64s 无访问 → 销毁）。
 * 返回 false = 房间已在本次维护中被回收销毁。
 */
export async function maintainRoom(tx: CloudDb, room: Room, nowMs: number): Promise<boolean> {
  // 1) rematch 超时
  if (
    room.status === core.STATUS.FINISHED &&
    room.rematchAt &&
    nowMs - room.rematchAt > REMATCH_TTL_MS &&
    room.rematchVotes.length
  ) {
    room.rematchVotes = []
    room.rematchAt = null
    pushEvent(room, { t: S2C.REMATCH, event: 'expired', audience: 'both' })
  }

  // 2) 回合超时判负
  if (room.status === core.STATUS.PLAYING && room.turnDeadline && nowMs >= room.turnDeadline) {
    const loser = room.state.turn
    await finishRoom(tx, room, core.other(loser), 'timeout')
  }

  // 3) 空房回收：任意座位 64s 内有过访问则保留，否则销毁
  const anyRecent =
    (room.lastSeen[1] !== null && nowMs - room.lastSeen[1] <= EMPTY_TTL_MS) ||
    (room.lastSeen[2] !== null && nowMs - room.lastSeen[2] <= EMPTY_TTL_MS)
  if (!anyRecent) {
    room._destroyed = true
    return false
  }
  return true
}

/* ---------------- 命令 ---------------- */

export interface CommandResult {
  error?: { status: number; code: string; message: string }
}

export async function applyCommand(
  tx: CloudDb,
  room: Room,
  seat: number,
  msg: Record<string, unknown>,
): Promise<CommandResult> {
  const nowMs = Date.now()
  const t = msg.t
  const fail = (code: string, status = 400): CommandResult => ({
    error: { status, code, message: errText(code) },
  })

  // 聊天：旁观者也能发（原版语义），放在座位校验前
  if (t === C2S.CHAT) {
    const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 200) : ''
    const emoji = typeof msg.emoji === 'string' ? msg.emoji.slice(0, 16) : ''
    if (!text && !emoji) return fail(ERR.BAD_MESSAGE)
    const last = room.lastChat[seat] ?? 0
    if (nowMs - last < CHAT_RATE_MS) return fail(ERR.RATE_LIMITED)
    room.lastChat[seat] = nowMs
    const nick = room.seats[seat]?.nick ?? null
    pushEvent(room, {
      t: S2C.CHAT,
      seat,
      nick,
      text,
      emoji,
      ts: nowMs,
      audience: 'other',
      actorSeat: seat,
    })
    return {}
  }

  if (!seat || !room.seats[seat]?.uid) return fail(ERR.UNAUTHORIZED, 401)

  if (t === C2S.MOVE) {
    if (typeof msg.edge !== 'string') return fail(ERR.BAD_EDGE)
    const res = core.applyMove(room.state, seat, msg.edge)
    if (!res.ok) {
      const code = (ERR as Record<string, string>)[res.reason.toUpperCase()] || ERR.BAD_EDGE
      return fail(code)
    }
    room.state = res.state
    room.drawOfferBy = 0 // 落子使挂起的求和失效
    const deadline = res.finished ? null : nowMs + TURN_TIMEOUT_MS
    room.turnDeadline = deadline
    pushEvent(room, {
      t: S2C.MOVE,
      seq: res.state.seq,
      by: seat,
      edge: msg.edge,
      gained: res.gained,
      scores: res.state.scores,
      turn: res.state.turn,
      status: res.state.status,
      winner: res.state.winner,
      turnDeadline: deadline,
      audience: 'both',
    })
    if (res.finished) {
      await finishRoom(tx, room, res.state.winner, 'win')
    }
    return {}
  }

  if (t === C2S.UNDO) {
    if (room.status !== core.STATUS.PLAYING) return fail(ERR.FINISHED)
    if (!room.state.moves.length || room.undoCount >= MAX_UNDO_PER_GAME) return fail(ERR.UNDO_NOT_ALLOWED)
    room.state = core.undoMove(room.state)
    room.undoCount += 1
    room.drawOfferBy = 0
    room.turnDeadline = nowMs + TURN_TIMEOUT_MS
    pushEvent(room, {
      t: S2C.UNDO,
      by: seat,
      state: room.state,
      turnDeadline: room.turnDeadline,
      audience: 'both',
    })
    return {}
  }

  if (t === C2S.RESIGN) {
    if (room.status !== core.STATUS.PLAYING) return {} // 等待/已结束：忽略
    await finishRoom(tx, room, core.other(seat), 'resign')
    return {}
  }

  if (t === C2S.DRAW) {
    if (room.status !== core.STATUS.PLAYING) return fail(ERR.FINISHED)
    const action = msg.action
    if (action === 'offer') {
      room.drawOfferBy = seat
      pushEvent(room, { t: S2C.DRAW, event: 'offered', by: seat, audience: 'both' })
      return {}
    }
    if (action === 'accept') {
      if (!room.drawOfferBy || room.drawOfferBy === seat) return fail(ERR.UNDO_NOT_ALLOWED)
      const by = seat
      room.drawOfferBy = 0
      await finishRoom(tx, room, core.DRAW, 'draw')
      // finishRoom 已推 finished；补 draw accepted 广播
      pushEvent(room, { t: S2C.DRAW, event: 'accepted', by, audience: 'both' })
      return {}
    }
    if (action === 'decline') {
      if (!room.drawOfferBy || room.drawOfferBy === seat) return {} // 无挂起请求：忽略
      room.drawOfferBy = 0
      pushEvent(room, { t: S2C.DRAW, event: 'declined', by: seat, audience: 'both' })
      return {}
    }
    return fail(ERR.BAD_MESSAGE)
  }

  if (t === C2S.REMATCH) {
    return applyRematch(room, seat, msg)
  }

  return fail(ERR.BAD_MESSAGE)
}

/** 再来一局协商（双票制，见原版 onRematch 注释） */
function applyRematch(room: Room, seat: number, msg: Record<string, unknown>): CommandResult {
  if (room.status !== core.STATUS.FINISHED) return { error: { status: 400, code: ERR.FINISHED, message: errText(ERR.FINISHED) } }
  const peerSeat = (seat === 1 ? 2 : 1) as 1 | 2
  const peerGone = !seatOccupied(room, peerSeat)

  // 「等待新对手」：对手已离场（座位空 / 主动 left）才允许
  if (msg.action === 'wait_new' && peerGone) {
    rematchWithNewPeer(room, seat)
    return {}
  }

  // 清掉过期的挂起投票
  const now = Date.now()
  if (room.rematchAt && now - room.rematchAt > REMATCH_TTL_MS) {
    room.rematchVotes = []
    room.rematchAt = null
  }

  if (!room.rematchVotes.includes(room.seats[seat]?.uid ?? '')) {
    const uid = room.seats[seat]?.uid
    if (uid) room.rematchVotes.push(uid)
  }
  room.rematchAt = now

  if (peerGone) {
    // 对手不在场，票永远凑不齐：立刻撤销并明确答复
    room.rematchVotes = room.rematchVotes.filter((u) => u !== room.seats[seat]?.uid)
    room.rematchAt = null
    pushEvent(room, { t: S2C.REMATCH, event: 'peer_left', audience: 'seat', targetSeat: seat })
    return {}
  }

  if (room.rematchVotes.length >= 2) {
    startRematch(room)
    return {}
  }

  // 通知对手「想再来一局」+ 发起者「已记录，等对手」
  pushEvent(room, { t: S2C.PEER, event: 'rematch', seat, audience: 'both' })
  pushEvent(room, {
    t: S2C.REMATCH,
    event: 'waiting',
    peerOnline: room.seats[peerSeat]?.online === true,
    audience: 'seat',
    targetSeat: seat,
  })
  return {}
}

/** 双票凑齐 → 开下一局（先手轮换：上局胜者后手） */
function startRematch(room: Room): void {
  const winner = room.state.winner
  const nextFirst: 1 | 2 = winner === 1 || winner === 2 ? (core.other(winner) as 1 | 2) : 1
  room.state = core.startGame(core.createGame({ rows: room.rows, cols: room.cols, firstPlayer: nextFirst }))
  room.rematchVotes = []
  room.rematchAt = null
  room.undoCount = 0
  room.drawOfferBy = 0
  room.round += 1
  room.turnDeadline = Date.now() + TURN_TIMEOUT_MS
  room.finishedAt = null
  pushEvent(room, { t: S2C.STARTED, state: room.state, round: room.round, audience: 'both' })
  pushEvent(room, { t: S2C.REMATCH, event: 'started', audience: 'both' })
  pushEvent(room, { ...snapshot(room, 1), audience: 'seat', targetSeat: 1 })
  pushEvent(room, { ...snapshot(room, 2), audience: 'seat', targetSeat: 2 })
}

/** 结算后换新对手：清空离场者座位、房间退回等待态、公开房重新上大厅 */
function rematchWithNewPeer(room: Room, seat: number): void {
  const peerSeat = (seat === 1 ? 2 : 1) as 1 | 2
  room.seats[peerSeat] = { seat: peerSeat, uid: null, nick: null, avatar: null, online: false, left: false }
  room.rematchVotes = []
  room.rematchAt = null
  room.undoCount = 0
  room.drawOfferBy = 0
  room.turnDeadline = null
  room.round = 1
  room.finishedAt = null
  room.lastSeen[peerSeat] = null
  room.state = core.createGame({ rows: room.rows, cols: room.cols })
  room.status = core.STATUS.WAITING
  pushEvent(room, { ...snapshot(room, seat), audience: 'seat', targetSeat: seat })
}

/* ---------------- 房间级操作（join / leave） ---------------- */

export interface JoinOutcome {
  room: Room
  seat: number
  joined: boolean // true = 本次新坐入 / false = 回归原座位
  started: boolean // 本次坐入是否触发了开局
}

/** 加入房间：回归原座位 / 坐空位 / 满员返回 seat=0。房间不存在或已回收返回 null。 */
export async function joinRoom(db: CloudDb, roomId: string, profile: { uid: string; nick: string | null; avatar: string | null }): Promise<JoinOutcome | null> {
  const nowMs = Date.now()
  return transactRoom(db, roomId, async (room, tx) => {
    const alive = await maintainRoom(tx, room, nowMs)
    if (!alive) return null
    const existing = seatOf(room, profile.uid)
    if (existing) {
      const p = room.seats[existing]!
      p.nick = profile.nick ?? p.nick
      p.avatar = profile.avatar ?? p.avatar
      p.online = true
      p.left = false
      room.lastSeen[existing] = nowMs
      return { room, seat: existing, joined: false, started: false }
    }
    for (const s of [1, 2] as const) {
      if (!room.seats[s]?.uid) {
        room.seats[s] = { seat: s, ...profile, online: true, left: false }
        room.lastSeen[s] = nowMs
        pushEvent(room, { t: S2C.PEER, event: 'join', seat: s, nick: profile.nick, audience: 'both' })
        const started = maybeStart(room, nowMs)
        // 两个座位都推快照（新加入者与房主都能对齐）
        pushEvent(room, { ...snapshot(room, 1), audience: 'seat', targetSeat: 1 })
        pushEvent(room, { ...snapshot(room, 2), audience: 'seat', targetSeat: 2 })
        return { room, seat: s, joined: true, started }
      }
    }
    return { room, seat: 0, joined: false, started: false }
  })
}

/**
 * 主动离开：解除「一人一房」归属；等待中的房间直接销毁；对局中保留座位与棋局
 * （座位标记 left，对手可「等待新对手」换人；双方都不再访问时由空房回收清理）。
 */
export async function leaveRoom(db: CloudDb, roomId: string, uid: string): Promise<{ destroyed: boolean; seat: number } | null> {
  return transactRoom(db, roomId, async (room, tx) => {
    const alive = await maintainRoom(tx, room, Date.now())
    if (!alive) return { destroyed: true, seat: seatOf(room, uid) }
    const seat = seatOf(room, uid)
    if (seat) {
      const p = room.seats[seat]!
      p.online = false
      p.left = true
      room.lastSeen[seat] = Date.now()
      pushEvent(room, { t: S2C.PEER, event: 'offline', seat, left: true, audience: 'both' })
      room.rematchVotes = []
      room.rematchAt = null
    }
    const waiting = room.status === core.STATUS.WAITING
    if (waiting) {
      room._destroyed = true
      return { destroyed: true, seat }
    }
    return { destroyed: false, seat }
  })
}

/* ---------------- 创建 / 大厅 / 匹配 ---------------- */

/** 生成不冲突的房号 */
export async function createRoomId(tx: CloudDb): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const id = makeRoomId()
    const exists = await tx.table('rooms').where('room_id', id).first()
    if (!exists) return id
  }
  return makeRoomId()
}

export interface CreateRoomInput {
  rows: number
  cols: number
  visibility: string
  uid: string
  nick: string | null
  avatar: string | null
}

export interface CreatedRoom {
  roomId: string
  seat: number
  room: Room
}

/**
 * 创建房间（房主自动坐 seat1）。
 * 事务内复查「一人一房」：若该用户已有活跃房间，直接复用（reused=true），
 * 避免并发点两次创建堆出幽灵房。
 */
export async function createRoom(db: CloudDb, input: CreateRoomInput): Promise<{ reused: boolean; roomId: string; seat: number; room: Room }> {
  const nowMs = Date.now()
  return db.transaction(async (tx) => {
    const existing = await liveRoomOf(tx, input.uid)
    if (existing) {
      return { reused: true, roomId: existing.roomId, seat: seatOf(existing, input.uid), room: existing }
    }
    const roomId = await createRoomId(tx)
    await tx.table('rooms').insert({
      room_id: roomId,
      rows: input.rows,
      cols: input.cols,
      visibility: input.visibility,
      host_uid: input.uid,
      seat1_uid: input.uid,
      seat1_nick: input.nick,
      seat1_avatar: input.avatar,
      seat1_online: 1,
      seat1_left: 0,
      seat2_uid: null,
      seat2_nick: null,
      seat2_avatar: null,
      seat2_online: 0,
      seat2_left: 0,
      state_json: JSON.stringify(core.createGame({ rows: input.rows, cols: input.cols })),
      events_json: '[]',
      evt_seq: 0,
      status: core.STATUS.WAITING,
      round: 1,
      turn_deadline: null,
      draw_offer_by: 0,
      undo_count: 0,
      rematch_votes: '[]',
      rematch_at: null,
      last_seen1: nowMs,
      last_seen2: null,
      last_chat1: null,
      last_chat2: null,
      created_at: nowMs,
      updated_at: nowMs,
      finished_at: null,
    })
    const room: Room = {
      roomId,
      rows: input.rows,
      cols: input.cols,
      visibility: input.visibility,
      hostUid: input.uid,
      seats: [
        null,
        { seat: 1, uid: input.uid, nick: input.nick, avatar: input.avatar, online: true, left: false },
        { seat: 2, uid: null, nick: null, avatar: null, online: false, left: false },
      ],
      state: core.createGame({ rows: input.rows, cols: input.cols }),
      events: [],
      evtSeq: 0,
      status: core.STATUS.WAITING,
      round: 1,
      turnDeadline: null,
      drawOfferBy: 0,
      undoCount: 0,
      rematchVotes: [],
      rematchAt: null,
      lastSeen: [0, nowMs, null],
      lastChat: [0, null, null],
      createdAt: nowMs,
      updatedAt: nowMs,
      finishedAt: null,
    }
    return { reused: false, roomId, seat: 1, room }
  })
}

/** 某用户当前活跃的房间（未结束、未主动离场） */
export async function liveRoomOf(db: CloudDb, uid: string): Promise<Room | null> {
  const rows = await db
    .table('rooms')
    .where('seat1_uid', uid)
    .where('seat1_left', 0)
    .where('status', '!=', core.STATUS.FINISHED)
    .orderBy('updated_at', 'desc')
    .limit(5)
    .get()
  const rows2 = await db
    .table('rooms')
    .where('seat2_uid', uid)
    .where('seat2_left', 0)
    .where('status', '!=', core.STATUS.FINISHED)
    .orderBy('updated_at', 'desc')
    .limit(5)
    .get()
  const all = [...rows, ...rows2].sort((a, b) => Number(b.updated_at) - Number(a.updated_at))
  for (const row of all) {
    const room = parseRoom(row)
    if (seatOccupied(room, seatOf(room, uid))) return room
  }
  return null
}

/** 大厅：等待对手的公开房间（附带懒清理过期房） */
export async function listLobbyRooms(db: CloudDb): Promise<Array<{ roomId: string; rows: number; cols: number; hostNick: string | null; hostUid: string | null; createdAt: number }>> {
  const nowMs = Date.now()
  // 懒清理：房主超 64s 无访问的等待房直接删掉，别让大厅堆死房
  await db
    .table('rooms')
    .where('status', core.STATUS.WAITING)
    .where('visibility', 'public')
    .where('last_seen1', '<', nowMs - EMPTY_TTL_MS)
    .delete()
  const rows = await db
    .table('rooms')
    .where('status', core.STATUS.WAITING)
    .where('visibility', 'public')
    .orderBy('created_at', 'desc')
    .limit(50)
    .get()
  return rows.map((r) => ({
    roomId: r.room_id as string,
    rows: Number(r.rows),
    cols: Number(r.cols),
    hostNick: (r.seat1_nick as string | null) ?? null,
    hostUid: (r.host_uid as string | null) ?? null,
    createdAt: Number(r.created_at),
  }))
}

/** 快速匹配：找同尺寸等待房加入；没有就开新房。返回房间信息 + 行为标记。 */
export async function quickMatchRoom(
  db: CloudDb,
  input: { rows: number; cols: number; uid: string; nick: string | null; avatar: string | null },
): Promise<{ roomId: string; action: 'join' | 'create' | 'reuse'; seat: number; room: Room }> {
  // 与大厅同口径：先清一遍过期等待房
  await db
    .table('rooms')
    .where('status', core.STATUS.WAITING)
    .where('last_seen1', '<', Date.now() - EMPTY_TTL_MS)
    .delete()
  const candidates = await db
    .table('rooms')
    .where('status', core.STATUS.WAITING)
    .where('visibility', 'public')
    .where('rows', input.rows)
    .where('cols', input.cols)
    .orderBy('created_at', 'asc')
    .limit(10)
    .get()
  for (const row of candidates) {
    const roomId = row.room_id as string
    if (row.seat1_uid === input.uid || row.seat2_uid === input.uid) continue
    const outcome = await joinRoom(db, roomId, input)
    if (outcome && outcome.seat > 0) return { roomId, action: 'join', seat: outcome.seat, room: outcome.room }
  }
  const created = await createRoom(db, { ...input, visibility: 'public' })
  return { roomId: created.roomId, action: created.reused ? 'reuse' : 'create', seat: created.seat, room: created.room }
}
