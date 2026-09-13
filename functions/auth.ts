/**
 * 登录 / 我的信息（移植自原 /v1/login、/v1/me）。
 * 客户端 wx.login 适配层传 code=`dev:<deviceId>`，服务端派生稳定 uid 并建用户行。
 */
import type { FunctionContext } from '@adep/types'
import { routePath } from './_shared/route'
import { err, ok } from './_shared/respond'
import { parseDeviceCode, uidOfDeviceId, requireUser } from './_shared/auth'
import { ERR, errText } from './_shared/protocol'

function clampNick(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return ''
  // 昵称最长 12 个字符（与客户端输入一致），去掉不可见控制字符
  return s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 12)
}

export default async function handle(ctx: FunctionContext): Promise<ReturnType<typeof ok>> {
  const path = routePath(ctx.path)
  const db = ctx.cloud.db

  // POST /auth/login { code, nick } → { token, uid, nick, avatar }
  if (path === '/auth/login' && ctx.method === 'POST') {
    const body = (ctx.body ?? {}) as Record<string, unknown>
    const deviceId = parseDeviceCode(body.code)
    if (!deviceId) return err(400, 'bad_code', '登录凭证无效')
    const uid = uidOfDeviceId(deviceId)
    const nick = clampNick(body.nick) || `玩家${uid.slice(-4)}`
    const now = Date.now()
    try {
      // 先查后写（避免 ON CONFLICT ... DO UPDATE SET 的 CASE 表达式，sim 引擎不支持；
      // 语义同原 Cloudflare 版：首次登录写入昵称，重登只刷新 updated_at，不覆盖自定义昵称）
      const existing = await db.table('users').where('uid', uid).first()
      if (!existing) {
        await db.table('users').insert({
          uid,
          nick,
          avatar: null,
          wins: 0,
          losses: 0,
          draws: 0,
          rating: 0,
          updated_at: now,
        })
      } else {
        await db.table('users').where('uid', uid).update({ updated_at: now })
      }
    } catch (e) {
      console.error('[dgc:auth] upsert user failed', e)
      return err(503, 'db_unavailable', '数据库暂不可用，请稍后重试')
    }
    const token = body.code as string
    return ok({ token, uid, nick, avatar: null })
  }

  // GET /auth/me → { uid, nick, avatar, wins, losses, draws, rating }
  if (path === '/auth/me' && ctx.method === 'GET') {
    const user = await requireUser(db, ctx)
    if ('__error' in user) return user.__error
    const row = await db.table('users').where('uid', user.uid).first()
    if (!row) return err(401, ERR.UNAUTHORIZED, errText(ERR.UNAUTHORIZED))
    return ok({
      uid: row.uid,
      nick: row.nick ?? null,
      avatar: row.avatar ?? null,
      wins: Number(row.wins) || 0,
      losses: Number(row.losses) || 0,
      draws: Number(row.draws) || 0,
      rating: Number(row.rating) || 0,
    })
  }

  return err(404, 'not_found', '接口不存在')
}
