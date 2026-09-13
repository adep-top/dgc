/**
 * 鉴权（移植自原 auth.js + index.js 登录段的口径，改用设备身份）：
 *
 * 原版用 wx.login code 换 openid；web 版没有微信登录，客户端 wx.login 适配层
 * 会生成/持久化一个设备 ID 并以 `dev:<deviceId>` 作为 code 调 /auth/login。
 * 服务端据此派生稳定 uid：`dev_` + deviceId（去掉连字符），首次登录建用户行。
 * token 就是 `dev:<deviceId>` 本身（等价 API Key，前端持久化于 localStorage）。
 */
import type { CloudDb, FunctionContext } from '@adep/types'
import { err } from './respond'
import { errText, ERR } from './protocol.js'

export const DEVICE_CODE_PREFIX = 'dev:'

/** 校验登录 code（web 设备身份）：dev:<8~64 位字母数字连字符> */
export function parseDeviceCode(code: unknown): string {
  if (typeof code !== 'string') return ''
  const m = /^dev:([A-Za-z0-9-]{8,64})$/.exec(code.trim())
  return m ? m[1] : ''
}

/** 设备标识 → 稳定 uid（去掉连字符，与微信版 'dev_' 前缀风格一致） */
export function uidOfDeviceId(deviceId: string): string {
  return `dev_${deviceId.replace(/-/g, '')}`
}

/** 从 Authorization / X-DGC-Token / ?token= 取凭据 */
export function parseBearer(ctx: FunctionContext): string {
  const header = ctx.headers?.authorization ?? ctx.headers?.Authorization ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(String(header).trim())
  if (m) return m[1].trim()
  const alt = ctx.headers?.['x-dgc-token']
  if (typeof alt === 'string' && alt.trim()) return alt.trim()
  const q = ctx.query?.token
  if (typeof q === 'string' && q) return q
  return ''
}

export interface AuthedUser {
  uid: string
  nick: string | null
  avatar: string | null
}

export type AuthResult = AuthedUser | { __error: ReturnType<typeof err> }

export function isAuthError(r: AuthResult): r is { __error: ReturnType<typeof err> } {
  return '__error' in r
}

/** 登录态 → 用户；失败返回 401 信封。 */
export async function requireUser(db: CloudDb, ctx: FunctionContext): Promise<AuthResult> {
  const token = parseBearer(ctx)
  const deviceId = parseDeviceCode(token)
  if (!deviceId) return { __error: err(401, ERR.UNAUTHORIZED, errText(ERR.UNAUTHORIZED)) }
  const uid = uidOfDeviceId(deviceId)
  const row = await db.table('users').where('uid', uid).first()
  if (!row) {
    return { __error: err(401, ERR.UNAUTHORIZED, errText(ERR.UNAUTHORIZED)) }
  }
  return { uid, nick: (row.nick as string | null) ?? null, avatar: (row.avatar as string | null) ?? null }
}

/** 只取 uid（已在 requireUser 校验过的场景复用） */
export function uidOfToken(token: string): string {
  const deviceId = parseDeviceCode(token)
  return deviceId ? uidOfDeviceId(deviceId) : ''
}
