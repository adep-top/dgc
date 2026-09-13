/**
 * 响应信封：保持原 dgc 后端（Cloudflare Workers）的响应形状。
 *
 * 客户端 net/api.js 直接读 `res.data`（期望 `{roomId, ...}` 之类的业务体）与
 * `res.statusCode`，错误体为 `{error, message}` —— 所以这里把原始形状包进
 * `__adepHttp` 信封透传，客户端一行都不用改。
 */
import type { AdepHttpEnvelope } from '@adep/types'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

/** 200 + 原始业务体 */
export function ok<T>(body: T): AdepHttpEnvelope {
  return { __adepHttp: { status: 200, headers: JSON_HEADERS, body } }
}

/** 错误：{error, message} 与 HTTP 状态（客户端 httpError 依赖 statusCode + data.error/message） */
export function err(status: number, error: string, message: string): AdepHttpEnvelope {
  return { __adepHttp: { status, headers: JSON_HEADERS, body: { error, message } } }
}
