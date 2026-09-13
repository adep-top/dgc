# 移植说明：微信小游戏「云柯点格棋」→ adep 应用

> 原仓库：`/Users/yunke/WorkBuddy/dot-grid-chess`（minigame/ Canvas 前端 + server/cloudflare/ Cloudflare Workers 后端）
> 移植目标：`/Users/yunke/works/adep/apps/dgc`（functions/ 云函数 + web/ Canvas 前端）
> 硬约束：**界面与体验与原始小程序保持一致**；代码结构便于本地开发调试。

## 1. 总体结构

```
apps/dgc/
├── adep.config.ts          # adep 项目配置（slug=dgc、functions_dir=functions、prefix=/api）
├── package.json            # dev/build/start/db:init/deploy/test/typecheck 脚本
├── functions/              # 云函数（原 Cloudflare 6 个 handler 一一对应）
│   ├── schema.sql          # 五张表：id TEXT PRIMARY KEY（平台注入 ULID）+ 业务键 UNIQUE
│   ├── auth.ts             # 设备身份登录（wx.login code → uid/token）
│   ├── rooms.ts            # 实时房间：创建/加入/指令/轮询 state
│   ├── match.ts            # 快速匹配
│   ├── ranking.ts          # 积分排行榜
│   ├── matches.ts          # 战绩列表/详情
│   ├── async.ts            # 异步对战
│   └── _shared/            # 三端共用逻辑 + 函数层工具
│       ├── room.ts         # 房间引擎（轮询版状态机，~26KB）
│       ├── async-game.ts   # 异步对局引擎
│       ├── auth.ts         # 设备身份解析
│       ├── respond.ts      # 响应信封 { __adepHttp: {...} }
│       ├── route.ts        # 函数内路由
│       ├── game-core.js    # 规则引擎（与小程序原样复制）
│       └── protocol.js     # 协议常量（三端共用）
├── web/                    # 前端（Vue 3 壳 + Canvas 游戏本体）
│   ├── src/main.ts         # 入口：createApp
│   ├── src/App.vue         # 建 canvas → 装 wx 适配层 → new App()
│   ├── src/style.css       # 全屏黑底画布
│   ├── src/platform/       # ★ web 适配层（wx.* → DOM/Pointer Events）
│   │   ├── wx.ts           #    createCanvas/getSystemInfo/touch/storage/fetch/showModal 等
│   │   └── overlay.ts      #    toast/modal/loading/actionsheet 的 DOM 实现
│   └── src/game/           # ★ 原 minigame/js 近乎逐行拷入
│       ├── app.js          #   游戏主循环（+applyViewport resize 校正）
│       ├── scenes.js       #   首页/对局场景（邀请链接卡片替代小程序码）
│       ├── session.js      #   会话状态机（零改动）
│       ├── net/            #   client.js 轮询 GameClient / api.js 轮询接口
│       ├── core/           #   index.js 规则引擎 / protocol.js
│       ├── ui/             #   棋盘/Dock/控件绘制
│       └── ...
└── tests/                  # vitest 冒烟测试（规则引擎三端一致性）
```

## 2. 关键移植决策

### 2.1 前端：Canvas 原样移植 + wx 适配层
- 原 `minigame/js` 的 Canvas 代码近乎逐行拷入 `web/src/game/`，游戏逻辑零改写。
- `platform/wx.ts` 把 `wx.*` API 映射到 web：
  - `createCanvas()`：**首次调用返回主画布，之后新建离屏 canvas**（微信语义）。若每次都返回主画布，
    离屏烘焙 `drawImage` 自绘成 no-op → 画布永不真正清屏，旧场景内容残留在新场景下。
  - 触摸：Pointer Events → 换算成 **canvas 相对 + 逻辑像素**（`(clientX-rect.left) * (logicalW/rect.width)`）。
  - `getSystemInfoSync`：innerWidth/innerHeight + devicePixelRatio。
  - 开放数据域 API（getOpenDataContext 等）故意不实现——ranking.js 有 `typeof` 守卫自动降级。
- `App.vue` 建好 canvas 后**动态 import wx 适配层**注册，再动态 import `game/app.js` 启动（wx 必须先于游戏模块）。

### 2.2 实时对战：轮询替代 WebSocket
- 平台云函数无 WebSocket → 800ms 轮询：
  - `POST /rooms/:id/state`（`since=evtSeq` 增量事件，满房/非成员返回观战快照 `mySeat=0`）
  - `POST /rooms/:id/command`（响应带回本次指令产生的事件）
- `net/client.js` 整体重写为轮询 `GameClient`，**类名与事件接口不变** → app.js/session.js 零改动。
- 服务端语义对齐原版 room-do：WS 握手即入座、满房→观战 snapshot(att.seat||0)、chat 在座位校验之前（观战可发聊天）。

### 2.3 鉴权：设备身份登录
- `wx.login` 返回 `dev:<deviceId>` 作 code → uid=`dev_<去连字符>`，token 即该串。
- 客户端存 localStorage：`dgc_token` / `dgc_uid` / `dgc_device_id`。

### 2.4 邀请：链接卡片替代小程序码
- `scenes.js` 邀请弹窗改为「复制房号 / 复制邀请链接」，链接形如 `http://<slug>.adep.localhost:3001/?room=XXXXXX`。

### 2.5 服务端：Cloudflare 6 handler → 6 个云函数
- auth/rooms/match/ranking/matches/async 一一对应；`_shared/` 放共用模块。
- `game-core.js` / `protocol.js` 原样复制 + 手写 .d.ts。**函数层 import 须带 `./X.js` 扩展名**。

## 3. 平台缺陷修复（每修一个 commit 一次）

| commit | 问题 | 修复 |
| --- | --- | --- |
| `7b5ab47` | `adep db migrate` 行内注释并入语句 → incomplete input | splitSqlStatements 引号外 `--` 截断到行尾 |
| `3610137` | 函数沙箱拒绝 `./protocol`（收集器只收 .ts） | 收集器同时收 .ts+.js、排除 .d.ts/.test.ts |
| `cf38b5e` | sim 引擎 INSERT 吞 ON CONFLICT 尾巴、裸 NULL 存成字符串 | splitInsertTuples + ON CONFLICT DO UPDATE/NOTHING + NULL→null |
| `04db46e` | sim SELECT 不支持表限定列名/AS 别名/m.*/OR/LEFT JOIN | 查询面补齐（战绩列表全 null 的根因） |
| `a4881b1` | 平台 owned 写路径注入 ULID 主键 → 详情路由 404 | schema 五表加 `id TEXT PRIMARY KEY`；matches 路由改 `^/matches/([^/]+)$` |
| `85d81af`+`4d5ae53` | 前端草稿总量上限 256KB 卡住发布 | 常量改 512KB（CLI 与服务端同一份） |

## 4. 命令速查（apps/dgc 根目录）

```bash
pnpm install                # 依赖
npm run dev                 # 本地开发：vite(5173) 进程内 adep dev + /api 代理，函数热重载
npm run build               # 前端构建
npm run start               # 本地 serve：adep serve --static web/dist --spa
npm run db:init             # 建库 + 迁移 schema.sql
npm run deploy              # 发布（6 云函数 + 前端）→ http://dgc.adep.localhost:3001
npm run test                # vitest 冒烟测试
npm run typecheck           # tsc strict
```

> ⚠️ 发布必须用 `./node_modules/.bin/adep publish`（本地 shim exec bun 跑源码）；
> `npx adep` / 全局 adep 走 dist 内联旧常量，可能误报前端体积上限。

## 5. 已知取舍（与原版差异，均为有意为之）
- 实时性：轮询 800ms 增量事件，观感≈原 WS；断线/重连语义对齐（ONLINE_TTL=6s、EMPTY_TTL=64s）。
- 单人练习/排行榜/战绩/异步对战：逻辑一致，数据落平台 SQLite。
- 小程序码、微信开放数据域、分享到群聊等微信专属能力不可移植，已降级为链接卡片 / 降级不渲染。
