/**
 * 战绩列表 / 对局详情回放（移植自原 /v1/matches、/v1/matches/:id）。
 * 列表联表取对手昵称；详情仅参与者可看（含落子序列，供 ReplayScene）。
 */
import type { FunctionContext, Row } from '@adep/types'
import { routePath } from './_shared/route'
import { err, ok } from './_shared/respond'
import { requireUser } from './_shared/auth'

/** 战绩行 → 列表项（与微信版 matchRowToList 形状一致） */
function matchRowToList(r: Row, uid: string): Record<string, unknown> {
  const mySeat: 1 | 2 = r.seat1 === uid ? 1 : 2
  const oppNick = mySeat === 1 ? r.nick2 : r.nick1
  return {
    id: r.id,
    roomId: r.room_id,
    rows: Number(r.rows),
    cols: Number(r.cols),
    score1: Number(r.score1),
    score2: Number(r.score2),
    winner: Number(r.winner),
    moves: Number(r.moves),
    finishedAt: Number(r.finished_at),
    mySeat,
    opponentNick: oppNick && String(oppNick).trim() ? String(oppNick).trim() : '未知对手',
  }
}

export default async function handle(ctx: FunctionContext): Promise<ReturnType<typeof ok>> {
  const path = routePath(ctx.path)
  const db = ctx.cloud.db
  const user = await requireUser(db, ctx)
  if ('__error' in user) return user.__error

  // GET /matches 我的战绩列表
  if (path === '/matches' && ctx.method === 'GET') {
    const limit = Math.min(100, Math.max(1, Number(ctx.query?.limit) || 20))
    const offset = Math.max(0, Number(ctx.query?.offset) || 0)
    // 联表取双方昵称（builder 无 JOIN，用裸 SQL 读）
    const rows = await db.query(
      `SELECT m.id, m.room_id, m.rows, m.cols, m.seat1, m.seat2,
              m.score1, m.score2, m.winner, m.moves, m.finished_at,
              u1.nick AS nick1, u2.nick AS nick2
       FROM matches m
       LEFT JOIN users u1 ON u1.uid = m.seat1
       LEFT JOIN users u2 ON u2.uid = m.seat2
       WHERE m.seat1 = ? OR m.seat2 = ?
       ORDER BY m.finished_at DESC
       LIMIT ? OFFSET ?`,
      [user.uid, user.uid, limit, offset],
    )
    const totalRow = await db
      .query('SELECT COUNT(*) AS total FROM matches WHERE seat1 = ? OR seat2 = ?', [user.uid, user.uid])
      .then((r) => r[0])
    return ok({
      matches: rows.map((r) => matchRowToList(r, user.uid)),
      total: Number(totalRow?.total) || 0,
    })
  }

  // GET /matches/:id 对局详情（仅参与者）
  const mm = /^\/matches\/([^/]+)$/.exec(path)
  if (mm && ctx.method === 'GET') {
    const row = (await db
      .query(
        `SELECT m.*, u1.nick AS nick1, u2.nick AS nick2
         FROM matches m
         LEFT JOIN users u1 ON u1.uid = m.seat1
         LEFT JOIN users u2 ON u2.uid = m.seat2
         WHERE m.id = ?`,
        [mm[1]],
      )
      .then((r) => r[0])) as Row | undefined
    if (!row) return err(404, 'match_not_found', '对局不存在')
    if (row.seat1 !== user.uid && row.seat2 !== user.uid) return err(403, 'forbidden', '无权查看该对局')
    let moves: unknown[] = []
    if (typeof row.moves_json === 'string' && row.moves_json) {
      try {
        moves = JSON.parse(row.moves_json) as unknown[]
      } catch {
        moves = []
      }
    }
    return ok({
      id: row.id,
      roomId: row.room_id,
      rows: Number(row.rows),
      cols: Number(row.cols),
      seat1: row.seat1,
      seat2: row.seat2,
      score1: Number(row.score1),
      score2: Number(row.score2),
      winner: Number(row.winner),
      movesCount: Number(row.moves),
      finishedAt: Number(row.finished_at),
      moves,
      player1Nick: row.nick1 ?? null,
      player2Nick: row.nick2 ?? null,
    })
  }

  return err(404, 'not_found', '接口不存在')
}
