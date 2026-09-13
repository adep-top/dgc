/**
 * 陌生人快速匹配（移植自原 /v1/match）：优先加入同尺寸等待房，没有就自己开房等待。
 * 已有活跃房间 → 直接复用（断线重连回原房）。
 */
import type { FunctionContext } from '@adep/types'
import { routePath } from './_shared/route'
import { err, ok } from './_shared/respond'
import { requireUser } from './_shared/auth'
import { liveRoomOf, joinRoom, quickMatchRoom, info } from './_shared/room'

const clampBoardSize = (v: unknown, def: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def
  return Math.min(8, Math.max(4, n))
}

export default async function handle(ctx: FunctionContext): Promise<ReturnType<typeof ok>> {
  const path = routePath(ctx.path)
  const db = ctx.cloud.db

  if (path !== '/match' || ctx.method !== 'POST') return err(404, 'not_found', '接口不存在')

  const user = await requireUser(db, ctx)
  if ('__error' in user) return user.__error
  const body = (ctx.body ?? {}) as Record<string, unknown>
  const rows = clampBoardSize(body.rows, 6)
  const cols = clampBoardSize(body.cols, 6)
  const profile = { uid: user.uid, nick: user.nick, avatar: user.avatar }

  const existing = await liveRoomOf(db, user.uid)
  if (existing) {
    const outcome = await joinRoom(db, existing.roomId, profile)
    if (outcome) return ok({ ...info(outcome.room), roomId: existing.roomId, action: 'reuse', seat: outcome.seat })
  }

  const matched = await quickMatchRoom(db, { rows, cols, ...profile })
  return ok({ ...info(matched.room), roomId: matched.roomId, action: matched.action, seat: matched.seat })
}
