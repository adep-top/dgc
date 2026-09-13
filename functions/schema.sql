-- dgc 云柯点格棋 · 项目数据库表结构（移植自原 Cloudflare D1 schema.sql）
-- 用法：adep db start && adep db migrate functions/schema.sql

-- ============ 用户与战绩（排行榜 / 战绩页用） ============
-- ⚠️ 平台 owned 写路径约定：每表含 `id TEXT PRIMARY KEY`（CloudDb builder 对
-- table().insert 自动注入 ULID，行变更进 _adep_changes_<table> 变更流）。
-- 业务键（uid）降为 UNIQUE；raw writeQuery 的 ON CONFLICT(uid) 不受影响。
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  uid        TEXT NOT NULL UNIQUE,
  nick       TEXT,
  avatar     TEXT,
  wins       INTEGER NOT NULL DEFAULT 0,
  losses     INTEGER NOT NULL DEFAULT 0,
  draws      INTEGER NOT NULL DEFAULT 0,
  rating     INTEGER NOT NULL DEFAULT 0,  -- 积分 = wins*10 + draws*3
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id          TEXT PRIMARY KEY,   -- 平台注入 ULID（原 D1 为 INTEGER AUTOINCREMENT）
  room_id     TEXT    NOT NULL,
  round       INTEGER NOT NULL DEFAULT 1,
  rows        INTEGER NOT NULL,
  cols        INTEGER NOT NULL,
  seat1       TEXT,
  seat2       TEXT,
  score1      INTEGER NOT NULL,
  score2      INTEGER NOT NULL,
  winner      INTEGER NOT NULL,   -- 1 / 2 / 3=平局
  moves       INTEGER NOT NULL,
  moves_json  TEXT,               -- 落子序列 JSON：[{seq, by, edge, gained}, ...]
  finished_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_room ON matches(room_id);
CREATE INDEX IF NOT EXISTS idx_matches_finished ON matches(finished_at DESC);

-- ============ 实时对战房间（原 RoomDO 的状态落库） ============
-- 每个房间一行；状态机（等待/对局/结算/重赛）全部在 rooms.ts 的引擎里推进。
-- last_seen* 是轮询心跳：轮询/指令都会刷新，6s 内视为在线，64s 无任何访问即空房回收。
CREATE TABLE IF NOT EXISTS rooms (
  id           TEXT PRIMARY KEY,          -- 平台注入 ULID
  room_id      TEXT NOT NULL UNIQUE,      -- 6 位房号（业务键）
  rows         INTEGER NOT NULL,
  cols         INTEGER NOT NULL,
  visibility   TEXT    NOT NULL DEFAULT 'public',   -- public 上大厅 / friends 仅好友可见
  host_uid     TEXT,
  seat1_uid    TEXT,
  seat1_nick   TEXT,
  seat1_avatar TEXT,
  seat1_online INTEGER NOT NULL DEFAULT 0,
  seat1_left   INTEGER NOT NULL DEFAULT 0,
  seat2_uid    TEXT,
  seat2_nick   TEXT,
  seat2_avatar TEXT,
  seat2_online INTEGER NOT NULL DEFAULT 0,
  seat2_left   INTEGER NOT NULL DEFAULT 0,
  state_json   TEXT    NOT NULL,          -- 核心对局状态（game-core 序列化）
  events_json  TEXT    NOT NULL DEFAULT '[]',  -- 事件队列 [{seq,t,...,audience,targetSeat?,actorSeat?}]
  evt_seq      INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'waiting',  -- waiting / playing / finished
  round        INTEGER NOT NULL DEFAULT 1,
  turn_deadline INTEGER,
  draw_offer_by INTEGER NOT NULL DEFAULT 0,
  undo_count   INTEGER NOT NULL DEFAULT 0,   -- 每局悔棋总次数上限 3
  rematch_votes TEXT    NOT NULL DEFAULT '[]',
  rematch_at   INTEGER,
  last_seen1   INTEGER,
  last_seen2   INTEGER,
  last_chat1   INTEGER,
  last_chat2   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status, visibility, created_at DESC);

-- ============ 异步对战（每步落库，不依赖长连接） ============
CREATE TABLE IF NOT EXISTS async_games (
  id            TEXT PRIMARY KEY,         -- 平台注入 ULID
  game_id       TEXT    UNIQUE NOT NULL,  -- 业务键（对局号）
  rows          INTEGER NOT NULL,
  rows          INTEGER NOT NULL,
  cols          INTEGER NOT NULL,
  player1_uid   TEXT,
  player2_uid   TEXT,
  player1_nick  TEXT,
  player2_nick  TEXT,
  player1_avatar TEXT,
  player2_avatar TEXT,
  state         TEXT    NOT NULL,
  current_turn  INTEGER NOT NULL DEFAULT 1,
  status        TEXT    NOT NULL,          -- waiting / playing / finished
  winner        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_move_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_async_games_p1 ON async_games(player1_uid, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_async_games_p2 ON async_games(player2_uid, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_async_games_status ON async_games(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS async_moves (
  id          TEXT PRIMARY KEY,           -- 平台注入 ULID
  game_id     TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  by          INTEGER NOT NULL,            -- 1 / 2
  edge        TEXT    NOT NULL,
  gained      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_async_moves_game ON async_moves(game_id, seq);
