/**
 * 实时对战房间（移植自原 /v1/rooms、/v1/rooms/:id/[join|leave] + RoomDO WebSocket 语义）。
 *
 * HTTP 轮询版的状态通道：
 *   POST /rooms/:id/state  —— 轮询：心跳 + 增量拉取事件（since=上次 evtSeq）；
 *   POST /rooms/:id/command —— 下发指令（move/undo/resign/draw/rematch/chat），
 *                              响应直接带回本次指令产生的事件（近实时手感）。
 */
import type { FunctionContext } from '@adep/types'
import { routePath } from './_shared/route'
import { err, ok } from './_shared/respond'
import { requireUser } from './_shared/auth'
import { ERR, errText, isValidRoomId, C2S } from './_shared/protocol'
import {
  createRoom,
  joinRoom,
  leaveRoom,
  liveRoomOf,
  listLobbyRooms,
  quickMatchRoom,
  transactRoom,
  recomputeOnline,
  info,
  snapshot,
  eventsFor,
  seatOf,
  applyCommand,
  maintainRoom,
  type Room,
} from './_shared/room'

const clampBoardSize = (v: unknown, def: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def
  return Math.min(8, Math.max(4, n))
}

type Envelope = ReturnType<typeof ok>

function roomResponse(roomId: string, action: 'create' | 'reuse' | 'join', room: Room, seat: number): Envelope {
  return ok({ ...info(room), roomId, action, seat })
}

export default async function handle(ctx: FunctionContext): Promise<Envelope> {
  const path = routePath(ctx.path)
  const db = ctx.cloud.db

  // POST /rooms 创建房间（已有活跃房间 → 复用）
  if (path === '/rooms' && ctx.method === 'POST') {
    const user = await requireUser(db, ctx)
    if ('__error' in user) return user.__error
    const body = (ctx.body ?? {}) as Record<string, unknown>
    const rows = clampBoardSize(body.rows, 6)
    const cols = clampBoardSize(body.cols, 6)
    const visibility = body.visibility === 'friends' ? 'friends' : 'public'
    const profile = { uid: user.uid, nick: user.nick, avatar: user.avatar }

    const existing = await liveRoomOf(db, user.uid)
    if (existing) {
      const outcome = await joinRoom(db, existing.roomId, profile)
      if (outcome) return roomResponse(existing.roomId, 'reuse', outcome.room, outcome.seat)
    }
    const created = await createRoom(db, { rows, cols, visibility, ...profile })
    return roomResponse(created.roomId, created.reused ? 'reuse' : 'create', created.room, created.seat)
  }

  // GET /rooms 大厅房间列表（等待对手的公开房间）
  if (path === '/rooms' && ctx.method === 'GET') {
    const user = await requireUser(db, ctx)
    if ('__error' in user) return user.__error
    const rooms = await listLobbyRooms(db)
    return ok({ rooms })
  }

  const rm = /^\/rooms\/([A-Za-z0-9]{4,8})(?:\/([a-z]+))?$/.exec(path)
  if (rm) {
    const roomId = rm[1].toUpperCase()
    const sub = rm[2] || ''
    const user = await requireUser(db, ctx)
    if ('__error' in user) return user.__error
    if (!isValidRoomId(roomId)) return err(400, 'bad_room', '房间号格式错误')
    const profile = { uid: user.uid, nick: user.nick, avatar: user.avatar }

    // GET /rooms/:id 房间信息（断线重连恢复用；房间已回收 → 404 让客户端清掉本地残留）
    if (!sub && ctx.method === 'GET') {
      const room = await transactRoom(db, roomId, async (r, tx) => {
        const alive = await maintainRoom(tx, r, Date.now())
        return alive ? r : null
      })
      if (!room) return err(404, ERR.NO_ROOM, errText(ERR.NO_ROOM))
      return ok(info(room))
    }

    // POST /rooms/:id/join —— 轮询版没有 WS 握手 = 入座，客户端 connect 时会调一次。
    // 满房不报错：与原版 room-do 一致返回旁观快照（seat=0，客户端提示「房间已满」）。
    if (sub === 'join' && ctx.method === 'POST') {
      const outcome = await joinRoom(db, roomId, profile)
      if (!outcome) return err(404, ERR.NO_ROOM, errText(ERR.NO_ROOM))
      if (!outcome.seat) return ok({ ...info(outcome.room), roomId, action: 'join', seat: 0 })
      return roomResponse(roomId, 'join', outcome.room, outcome.seat)
    }

    // POST /rooms/:id/leave
    if (sub === 'leave' && ctx.method === 'POST') {
      const res = await leaveRoom(db, roomId, user.uid)
      if (!res) return ok({ ok: true, destroyed: true })
      return ok({ ok: true, ...res })
    }

    // POST /rooms/:id/state 轮询（心跳 + 增量事件）。非座位成员 → 旁观快照（mySeat=0，
    // 不刷新心跳、不给事件），与原版 HELLO 返回 snapshot(att.seat || 0) 一致。
    if (sub === 'state' && ctx.method === 'POST') {
      const since = typeof (ctx.body as { since?: unknown })?.since === 'number' ? Number((ctx.body as { since: number }).since) : 0
      const now = Date.now()
      const outcome = await transactRoom(db, roomId, async (room, tx) => {
        const alive = await maintainRoom(tx, room, now)
        if (!alive) return { gone: true as const }
        const seat = seatOf(room, user.uid)
        if (!seat) {
          return {
            gone: false as const,
            seat: 0,
            snapshot: snapshot(room, 0),
            events: [] as Array<Record<string, unknown>>,
            realign: false,
            evtSeq: room.evtSeq,
          }
        }
        room.lastSeen[seat] = now
        recomputeOnline(room, now)
        const firstKept = room.events.length ? room.events[0].seq : room.evtSeq + 1
        const realign = since > 0 && since < firstKept
        const events = realign ? [] : eventsFor(room.events, since, seat)
        return {
          gone: false as const,
          seat,
          snapshot: snapshot(room, seat),
          events,
          realign,
          evtSeq: room.evtSeq,
        }
      })
      if (!outcome || outcome.gone) return err(404, ERR.NO_ROOM, errText(ERR.NO_ROOM))
      return ok({ snapshot: outcome.snapshot, events: outcome.events, realign: outcome.realign, evtSeq: outcome.evtSeq })
    }

    // POST /rooms/:id/command 指令（move/undo/resign/draw/rematch/chat）
    if (sub === 'command' && ctx.method === 'POST') {
      const msg = (ctx.body ?? {}) as Record<string, unknown>
      if (!msg || typeof msg.t !== 'string' || !Object.values(C2S).includes(msg.t as string)) {
        return err(400, ERR.BAD_MESSAGE, errText(ERR.BAD_MESSAGE))
      }
      const now = Date.now()
      const outcome = await transactRoom(db, roomId, async (room, tx) => {
        const alive = await maintainRoom(tx, room, now)
        if (!alive) return { gone: true as const }
        const seat = seatOf(room, user.uid)
        if (!seat) return { gone: false as const, seat: 0 }
        room.lastSeen[seat] = now
        recomputeOnline(room, now)
        const beforeSeq = room.evtSeq
        const res = await applyCommand(tx, room, seat, msg)
        if (res.error) return { gone: false as const, seat, error: res.error }
        const events = eventsFor(room.events, beforeSeq, seat)
        return { gone: false as const, seat, events }
      })
      if (!outcome || outcome.gone) return err(404, ERR.NO_ROOM, errText(ERR.NO_ROOM))
      if (outcome.seat === 0) return err(403, 'not_joined', '你不在这个房间里')
      if (outcome.error) return err(outcome.error.status, outcome.error.code, outcome.error.message)
      return ok({ events: outcome.events })
    }
  }

  return err(404, 'not_found', '接口不存在')
}
