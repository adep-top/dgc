/**
 * 异步对战（移植自原 /v1/async/*）：每步落库，轮询推进，无需长连接。
 */
import type { FunctionContext } from '@adep/types'
import { routePath } from './_shared/route'
import { err, ok } from './_shared/respond'
import { requireUser } from './_shared/auth'
import { createAsyncGame, joinAsyncGame, listAsyncGames, loadAsyncGame, moveAsyncGame } from './_shared/async-game'

const clampBoardSize = (v: unknown, def: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def
  return Math.min(8, Math.max(4, n))
}

export default async function handle(ctx: FunctionContext): Promise<ReturnType<typeof ok>> {
  const path = routePath(ctx.path)
  const db = ctx.cloud.db
  const user = await requireUser(db, ctx)
  if ('__error' in user) return user.__error

  // POST /async/games 创建异步对局（可带 opponentUid 直接开战）
  if (path === '/async/games' && ctx.method === 'POST') {
    const body = (ctx.body ?? {}) as Record<string, unknown>
    const rows = clampBoardSize(body.rows, 6)
    const cols = clampBoardSize(body.cols, 6)
    const opponentUid = typeof body.opponentUid === 'string' && body.opponentUid ? body.opponentUid : undefined
    const opponentNick = typeof body.opponentNick === 'string' ? body.opponentNick : undefined
    const created = await createAsyncGame(db, {
      rows,
      cols,
      uid: user.uid,
      nick: user.nick,
      avatar: user.avatar,
      opponentUid,
      opponentNick,
    })
    return ok({ gameId: created.gameId, ...created.info })
  }

  // GET /async/games 我的异步对局列表
  if (path === '/async/games' && ctx.method === 'GET') {
    const status = typeof ctx.query?.status === 'string' ? ctx.query.status : undefined
    const limit = Number(ctx.query?.limit) || 20
    const games = await listAsyncGames(db, user.uid, { status, limit })
    return ok({ games })
  }

  const am = /^\/async\/games\/([A-Za-z0-9]{4,8})(?:\/(join|move|subscribe))?$/.exec(path)
  if (am) {
    const gameId = am[1].toUpperCase()
    const sub = am[2] || ''

    // GET /async/games/:id 单局详情（轮询核心）
    if (!sub && ctx.method === 'GET') {
      const info = await loadAsyncGame(db, gameId)
      if (!info) return err(404, 'async_not_found', '对局不存在或已过期')
      return ok({ gameId, ...info })
    }

    // POST /async/games/:id/join
    if (sub === 'join' && ctx.method === 'POST') {
      const res = await joinAsyncGame(db, gameId, user.uid, user.nick, user.avatar)
      if (!res.ok) return err(res.status, res.code, res.message)
      return ok({ gameId, ...res.info, seat: res.seat })
    }

    // POST /async/games/:id/move
    if (sub === 'move' && ctx.method === 'POST') {
      const body = (ctx.body ?? {}) as Record<string, unknown>
      const edge = String(body.edge || '')
      const res = await moveAsyncGame(db, gameId, user.uid, edge)
      if (!res.ok) return err(res.status, res.code, res.message)
      return ok({ ok: true, state: res.state, gained: res.gained, finished: res.finished, winner: res.winner })
    }

    // POST /async/games/:id/subscribe —— web 无订阅消息通道，占位兼容客户端调用
    if (sub === 'subscribe' && ctx.method === 'POST') {
      return ok({ ok: true, unsupported: true })
    }
  }

  return err(404, 'not_found', '接口不存在')
}
