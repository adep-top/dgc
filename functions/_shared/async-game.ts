/**
 * 异步对战引擎（移植自 index.js 异步段）：每步落库，不依赖长连接。
 * 轮询频率由客户端 CONFIG.asyncPollMs 控制（默认 4s）。
 */
import type { CloudDb, CloudDbTable, Row } from '@adep/types'
import * as core from './game-core.js'
import { ERR, errText, makeRoomId } from './protocol.js'

const nowSec = () => Math.floor(Date.now() / 1000)

export type AsyncErrorCode = string

export interface AsyncGameInfo {
  rows: number
  cols: number
  players: Array<{ seat: number; uid: string | null; nick: string | null; avatar: string | null }>
  state: ReturnType<typeof core.createGame> | null
  currentTurn: number
  status: string
  winner: number
  moves: Array<{ seq: number; by: number; edge: string; gained: number[]; createdAt: number }>
  createdAt: number
  updatedAt: number
}

function asyncRowToInfo(row: Row, moves: Row[]): AsyncGameInfo {
  const state = safeParse<ReturnType<typeof core.createGame>>(row.state)
  return {
    rows: Number(row.rows),
    cols: Number(row.cols),
    players: [
      { seat: 1, uid: (row.player1_uid as string) ?? null, nick: (row.player1_nick as string) ?? null, avatar: (row.player1_avatar as string) ?? null },
      { seat: 2, uid: (row.player2_uid as string) ?? null, nick: (row.player2_nick as string) ?? null, avatar: (row.player2_avatar as string) ?? null },
    ],
    state,
    currentTurn: Number(row.current_turn) || 1,
    status: row.status as string,
    winner: Number(row.winner) || 0,
    moves: (moves || []).map((m) => ({
      seq: Number(m.seq),
      by: Number(m.by),
      edge: m.edge as string,
      gained: safeParse<number[]>(m.gained) || [],
      createdAt: Number(m.created_at),
    })),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export async function loadAsyncRow(db: CloudDb, gameId: string): Promise<Row | null> {
  return db.table('async_games').where('game_id', gameId).first()
}

export async function loadAsyncGame(db: CloudDb, gameId: string): Promise<AsyncGameInfo | null> {
  const row = await loadAsyncRow(db, gameId)
  if (!row) return null
  const moves = await db.table('async_moves').where('game_id', gameId).orderBy('seq', 'asc').get()
  return asyncRowToInfo(row, moves)
}

export async function createAsyncGame(
  db: CloudDb,
  input: { rows: number; cols: number; uid: string; nick: string | null; avatar: string | null; opponentUid?: string; opponentNick?: string },
): Promise<{ gameId: string; info: AsyncGameInfo }> {
  return db.transaction(async (tx) => {
    let gameId = makeRoomId()
    for (let i = 0; i < 5; i++) {
      const exists = await tx.table('async_games').where('game_id', gameId).first()
      if (!exists) break
      gameId = makeRoomId()
    }
    const hasOpponent = !!input.opponentUid
    const base = core.createGame({ rows: input.rows, cols: input.cols, firstPlayer: 1 })
    const state = hasOpponent ? core.startGame(base) : base
    const status = hasOpponent ? core.STATUS.PLAYING : core.STATUS.WAITING
    const now = nowSec()
    await tx.table('async_games').insert({
      game_id: gameId,
      rows: input.rows,
      cols: input.cols,
      player1_uid: input.uid,
      player2_uid: hasOpponent ? (input.opponentUid ?? null) : null,
      player1_nick: input.nick,
      player2_nick: hasOpponent ? input.opponentNick ?? null : null,
      player1_avatar: input.avatar,
      player2_avatar: null,
      state: JSON.stringify(state),
      current_turn: 1,
      status,
      winner: 0,
      created_at: now,
      updated_at: now,
      last_move_at: hasOpponent ? now : null,
    })
    const info = await loadAsyncGame(tx, gameId)
    return { gameId, info: info! }
  })
}

export async function listAsyncGames(db: CloudDb, uid: string, opts: { status?: string; limit?: number } = {}): Promise<Array<{ gameId: string; rows: number; cols: number; status: string; mySeat: number; opponentNick: string | null; opponentUid: string | null; updatedAt: number; winner: number }>> {
  const limit = Math.min(50, opts.limit || 20)
  // builder 不支持 OR，分两次查询后按 updated_at 合并取前 limit 条
  let q1: CloudDbTable = db.table('async_games')
  let q2: CloudDbTable = db.table('async_games')
  if (opts.status) {
    q1 = q1.where('status', opts.status)
    q2 = q2.where('status', opts.status)
  }
  const [rowsA, rowsB] = await Promise.all([
    q1.where('player1_uid', uid).orderBy('updated_at', 'desc').limit(limit).get(),
    q2.where('player2_uid', uid).orderBy('updated_at', 'desc').limit(limit).get(),
  ])
  const seen = new Set<string>()
  const rows = [...rowsA, ...rowsB]
    .sort((a, b) => Number(b.updated_at) - Number(a.updated_at))
    .filter((r) => (seen.has(r.game_id as string) ? false : (seen.add(r.game_id as string), true)))
    .slice(0, limit)
  return rows.map((r) => ({
    gameId: r.game_id as string,
    rows: Number(r.rows),
    cols: Number(r.cols),
    status: r.status as string,
    mySeat: r.player1_uid === uid ? 1 : 2,
    opponentNick: (r.player1_uid === uid ? r.player2_nick : r.player1_nick) as string | null,
    opponentUid: (r.player1_uid === uid ? r.player2_uid : r.player1_uid) as string | null,
    updatedAt: Number(r.updated_at),
    winner: Number(r.winner) || 0,
  }))
}

export type JoinAsyncResult = { ok: true; info: AsyncGameInfo; seat: 2 } | { ok: false; status: number; code: string; message: string }

export async function joinAsyncGame(db: CloudDb, gameId: string, uid: string, nick: string | null, avatar: string | null): Promise<JoinAsyncResult> {
  const row = await loadAsyncRow(db, gameId)
  if (!row) return { ok: false, status: 404, code: ERR.ASYNC_NOT_FOUND, message: errText(ERR.ASYNC_NOT_FOUND) }
  if (row.status !== core.STATUS.WAITING) return { ok: false, status: 409, code: ERR.ASYNC_NOT_WAITING, message: errText(ERR.ASYNC_NOT_WAITING) }
  if (row.player1_uid === uid) return { ok: false, status: 400, code: ERR.ASYNC_NOT_JOINED, message: '不能加入自己创建的对局' }
  const now = nowSec()
  const state = safeParse<ReturnType<typeof core.createGame>>(row.state)
  const startedState = state ? core.startGame(state) : null
  await db
    .table('async_games')
    .where('game_id', gameId)
    .update({
      player2_uid: uid,
      player2_nick: nick,
      player2_avatar: avatar,
      state: startedState ? JSON.stringify(startedState) : String(row.state),
      status: core.STATUS.PLAYING,
      updated_at: now,
      last_move_at: now,
    })
  const info = await loadAsyncGame(db, gameId)
  return { ok: true, info: info!, seat: 2 }
}

export type MoveAsyncResult =
  | { ok: true; state: ReturnType<typeof core.createGame>; gained: number[]; finished: boolean; winner: number }
  | { ok: false; status: number; code: string; message: string }

export async function moveAsyncGame(db: CloudDb, gameId: string, uid: string, edge: string): Promise<MoveAsyncResult> {
  const row = await loadAsyncRow(db, gameId)
  if (!row) return { ok: false, status: 404, code: ERR.ASYNC_NOT_FOUND, message: errText(ERR.ASYNC_NOT_FOUND) }
  const seat = row.player1_uid === uid ? 1 : row.player2_uid === uid ? 2 : 0
  if (!seat) return { ok: false, status: 403, code: ERR.ASYNC_NOT_JOINED, message: errText(ERR.ASYNC_NOT_JOINED) }
  if (row.status === core.STATUS.FINISHED) return { ok: false, status: 409, code: ERR.ASYNC_FINISHED, message: errText(ERR.ASYNC_FINISHED) }
  if (row.status !== core.STATUS.PLAYING) return { ok: false, status: 409, code: ERR.ASYNC_NOT_WAITING, message: '等待对手加入' }
  if (Number(row.current_turn) !== seat) return { ok: false, status: 409, code: ERR.ASYNC_NOT_YOUR_TURN, message: errText(ERR.ASYNC_NOT_YOUR_TURN) }

  const state = safeParse<ReturnType<typeof core.createGame>>(row.state)
  if (!state) return { ok: false, status: 400, code: ERR.BAD_EDGE, message: errText(ERR.BAD_EDGE) }
  const r = core.applyMove(state, seat, edge)
  if (!r.ok) {
    const map: Record<string, string> = {
      bad_edge: ERR.BAD_EDGE,
      edge_taken: ERR.EDGE_TAKEN,
      finished: ERR.ASYNC_FINISHED,
      not_your_turn: ERR.ASYNC_NOT_YOUR_TURN,
    }
    const code = map[r.reason] || ERR.BAD_EDGE
    return { ok: false, status: 400, code, message: errText(code) }
  }

  const now = nowSec()
  await db.transaction(async (tx) => {
    await tx
      .table('async_games')
      .where('game_id', gameId)
      .update({
        state: JSON.stringify(r.state),
        current_turn: r.state.turn,
        status: r.state.status,
        winner: r.state.winner,
        updated_at: now,
        last_move_at: now,
      })
    await tx.table('async_moves').insert({
      game_id: gameId,
      seq: r.state.seq,
      by: seat,
      edge,
      gained: JSON.stringify(r.gained),
      created_at: now,
    })
    if (r.finished) await updateAsyncRanking(tx, row, r.state.winner)
  })

  return { ok: true, state: r.state, gained: r.gained, finished: r.finished, winner: r.state.winner }
}

/** 终局更新战绩与积分（与实时对战口径一致） */
async function updateAsyncRanking(tx: CloudDb, row: Row, winner: number): Promise<void> {
  const finishedAt = Date.now()
  const entries = [
    { uid: row.player1_uid as string | null, seat: 1 },
    { uid: row.player2_uid as string | null, seat: 2 },
  ]
  for (const e of entries) {
    if (!e.uid) continue
    const isWin = (winner === 1 || winner === 2) && winner === e.seat
    const isDraw = winner === core.DRAW
    const w = isWin ? 1 : 0
    const d = isDraw ? 1 : 0
    const l = isWin || isDraw ? 0 : 1
    await tx.writeQuery(
      `INSERT INTO users (uid, nick, avatar, wins, losses, draws, rating, updated_at)
       VALUES (?, ?, '', ?, ?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET
         wins = wins + excluded.wins,
         losses = losses + excluded.losses,
         draws = draws + excluded.draws,
         rating = (wins + excluded.wins) * 10 + (draws + excluded.draws) * 3,
         updated_at = excluded.updated_at`,
      [e.uid, (e.seat === 1 ? row.player1_nick : row.player2_nick) as string | null ?? '', w, l, d, w * 10 + d * 3, finishedAt],
    )
  }
}

function safeParse<T>(raw: unknown): T | null {
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
