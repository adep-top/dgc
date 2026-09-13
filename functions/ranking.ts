/**
 * 积分排行榜（移植自原 /v1/ranking）：公开接口，不需要登录。
 * web 版没有微信好友/群开放数据域，friends/group 由客户端本地降级展示。
 */
import type { FunctionContext } from '@adep/types'
import { routePath } from './_shared/route'
import { err, ok } from './_shared/respond'

export default async function handle(ctx: FunctionContext): Promise<ReturnType<typeof ok>> {
  const path = routePath(ctx.path)
  const db = ctx.cloud.db

  if (path !== '/ranking' || ctx.method !== 'GET') return err(404, 'not_found', '接口不存在')

  const limit = Math.min(100, Number(ctx.query?.limit) || 20)
  const rows = await db
    .table('users')
    .select('uid', 'nick', 'avatar', 'wins', 'losses', 'draws', 'rating', 'updated_at')
    .orderBy('rating', 'desc')
    .orderBy('wins', 'desc')
    .orderBy('updated_at', 'asc')
    .limit(limit)
    .get()
  return ok({ ranking: rows })
}
