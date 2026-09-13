# 云柯点格棋（adep 应用）

微信小游戏「云柯点格棋」移植为 adep 平台应用：**functions/ 云函数 + web/ Canvas 前端**。
界面/体验与原始小程序保持一致，代码结构为本地开发调试而设计。

> 完整移植决策、平台缺陷修复记录、与原版差异见 [`docs/porting-notes.md`](docs/porting-notes.md)。

## 目录结构

```
apps/dgc/
├── adep.config.ts    # 项目配置（slug=dgc、functions_dir=functions、/api 前缀）
├── functions/        # 6 个云函数 + _shared/ 共用模块 + schema.sql
├── web/              # 前端（Vue 3 壳 + Canvas 游戏本体）
│   ├── src/game/     #   原小程序游戏代码（wx.* 经 src/platform/wx.ts 适配）
│   ├── src/platform/ #   wx 适配层 + DOM 覆盖层（toast/modal/loading/actionsheet）
│   └── src/App.vue   #   canvas 挂载 → 注册 wx → new App()
└── tests/            # vitest 冒烟测试（规则引擎三端一致性）
```

## 本地开发

```bash
cd apps/dgc
pnpm install

# 一条命令起前端 + 云函数模拟运行时（函数改动热重载）：
npm run dev
#   → 前端 http://127.0.0.1:5173 （/api/* 代理到进程内 adep dev）
#   → 模拟函数 http://127.0.0.1:8787（可选直接打 /api）

# 数据：默认 .adep/sim/db.json；重置 = rm -rf .adep/sim 后重启 dev
```

常用脚本：

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 本地开发（vite + 进程内 adep dev + /api 代理） |
| `npm run dev:api` | 只起云函数模拟运行时（127.0.0.1:8787） |
| `npm run build` | 前端构建到 `web/dist` |
| `npm run start` | 本地 serve 已构建产物（adep serve --spa） |
| `npm run db:init` | 建库 + 执行 `functions/schema.sql` 迁移 |
| `npm run deploy` | 发布到平台 dev（6 云函数 + 前端）→ http://dgc.adep.localhost:3001 |
| `npm run test` | vitest 冒烟测试 |
| `npm run typecheck` | tsc strict 类型检查 |

> ⚠️ 发布务必用 `./node_modules/.bin/adep publish`（本地 shim 跑源码）。`npx adep`/全局 adep
> 走 `@adep/cli/dist` 内联旧常量，会误报前端草稿体积上限（见 porting-notes §3 PLAT-06）。

## 调试提示

- **后端联调脚本**：`curl` 全流程可参考仓库内已有脚本（登录 → 建房 → 加入 → 轮询 → 指令 → 结算）。
  - 登录：`POST /api/auth/login {code:"dev:<deviceId>", nick}` → token。
  - 建房：`POST /api/rooms {visibility}` → roomId。
  - 加入：`POST /api/rooms/:id/join`（满房返回 `seat:0` 观战快照）。
  - 轮询：`POST /api/rooms/:id/state {since}` → `{snapshot, events, evtSeq, realign}`。
  - 指令：`POST /api/rooms/:id/command {t:"move", edge:"h-0-0"}`（边 ID 串；实时房间内部转数组）。
  - 异步：`POST /api/async/games` 创建 → `/async/games/:id/join` → `/move`（edge 传边 ID 如 `h-0-0`）。
- **浏览器端到端**：打开 `http://dgc.adep.localhost:3001`（需平台 dev 已启动）。
  - 双人实测提示：同一浏览器两个标签页共享 localStorage = **同一设备**，第二个标签打开邀请链接会
    「复用座位」而非加入——这是设备身份语义，不是 bug。用另一浏览器/隐身窗口/另一设备才是真双人。
- **重置平台项目库**（schema 变更后）：`adep db drop` + `adep db migrate functions/schema.sql`。

## 测试

```bash
npm run test
```

规则引擎 `game-core` 三端共用（小程序 / 云函数 / web 前端），`tests/smoke.test.ts`
同时加载 `functions/_shared/game-core.js` 与 `web/src/game/core/index.js` 两份副本断言行为一致，
防止移植漂移。覆盖：边 ID 解析、落子/回合翻转、重复落子、围格得分继续走、终局判定。
