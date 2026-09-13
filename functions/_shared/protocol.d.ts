/** protocol.js（原样移植的协议常量）类型声明 */
export const API: {
  LOGIN: string
  ME: string
  CREATE_ROOM: string
  ROOM: (id: string) => string
  JOIN: (id: string) => string
  LEAVE: (id: string) => string
  QUICK_MATCH: string
  RANKING: string
  MATCHES: string
  MATCH_DETAIL: (id: string) => string
  ASYNC_CREATE: string
  ASYNC_LIST: string
  ASYNC_GAME: (id: string) => string
  ASYNC_JOIN: (id: string) => string
  ASYNC_MOVE: (id: string) => string
  ASYNC_SUBSCRIBE: (id: string) => string
  WXACODE: (roomId: string) => string
  [k: string]: unknown
}
export const WS_PATH: string
export const VISIBILITY: Record<string, string>
export const C2S: Record<string, string>
export const S2C: Record<string, string>
export const ERR: Record<string, string>
export function errText(code: string): string
export function makeRoomId(rnd?: () => number, len?: number): string
export const isValidRoomId: (id: string) => boolean
