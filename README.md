# 云柯点格棋（adep 应用 · 开源镜像）

微信小游戏「云柯点格棋」移植为 adep 平台应用：**functions/ 云函数 + web/ Canvas 前端**。
界面/体验与原始小程序保持一致，代码结构为本地开发调试而设计。

> 完整移植决策、平台缺陷修复记录、与原版差异见 [`docs/porting-notes.md`](docs/porting-notes.md)。

## 这是什么

- 原始小游戏：微信小游戏「云柯点格棋」（Dots and Boxes），Canvas 逐帧绘制 + WebSocket 实时对战；
- 本仓库：adep 应用形态的完整源码（6 个云函数 + Canvas 前端），可在 adep 平台上部署运行，
  也可以本地一键起全栈开发环境；
- 移植方式：前端 Canvas 代码近乎逐行保留，`wx.*` 经一层适配层映射到 Web；实时对战以
  **800ms 轮询**替代 WebSocket（云函数无长连接），类名与事件接口不变，游戏主循环零改动。

## 运行前提

本应用运行在 **adep 平台**之上（`@adep/cli` 提供 dev / serve / publish 等命令）。两种运行方式：

1. **在 adep monorepo 内开发**（推荐，功能最全）：把本仓库放到 adep 仓库的 `apps/dgc/`，
   由 monorepo 的 `pnpm-workspace.yaml` 统一管理依赖（`workspace:*`），`npm run dev` 一条命令起全部。
2. **独立运行**（本开源镜像默认形态）：在仓库根执行

   ```bash
   pnpm install                      # 需先把 @adep/cli 等依赖指向已发布的 npm 版本
   npm run dev                       # vite + 进程内 adep dev（模拟运行时）
   npm run build && npm run start    # 本地独立部署（adep serve）
   ```

   > 说明：仓库内 `@adep/cli` 以 `workspace:*` 声明，独立使用前请将其改为 npm 已发布版本
   > （如 `"@adep/cli": "^0.1.9"`），或按方式 1 在 adep monorepo 中运行。

## 目录结构

```
dgc/
├── adep.config.ts    # 项目配置（name=dgc、functionsDir=functions、/api 前缀）
├── package.json      # 应用级脚本（dev / build / start / test / deploy / db:init …）
├── functions/        # 6 个云函数 + _shared/ 共用模块 + schema.sql
│   ├── auth.ts       # 设备身份登录（wx.login 的 dev:<deviceId> 等价物）
│   ├── rooms.ts      # 实时房间：建房/加入/指令/轮询增量事件
│   ├── match.ts      # 快速匹配
│   ├── ranking.ts    # 积分排行榜
│   ├── matches.ts    # 战绩列表/详情
│   ├── async.ts      # 异步对战（每步落库）
│   └── _shared/      # 房间引擎 room.ts / 规则引擎 game-core.js / 协议常量 protocol.js …
├── web/              # 前端（Vue 3 壳 + Canvas 游戏本体）
│   ├── src/game/     #   原小程序游戏代码（wx.* 经 src/platform/wx.ts 适配）
│   ├── src/platform/ #   wx 适配层 + DOM 覆盖层（toast/modal/loading/actionsheet）
│   └── src/App.vue   #   canvas 挂载 → 注册 wx → new App()
├── tests/            # vitest 冒烟测试（规则引擎三端一致性，16/16 通过）
└── docs/porting-notes.md
```

## 本地开发

```bash
cd apps/dgc            # 方式 1：adep monorepo 内
pnpm install

# 一条命令起前端 + 云函数模拟运行时（函数改动热重载）：
npm run dev
#   → 前端 http://127.0.0.1:5173 （/api/* 代理到进程内 adep dev）
#   → 模拟函数 http://127.0.0.1:8787（可选直接打 /api）
```

> ⚠️ 若本地 vite 报 `@adep/cli/vite` 解析失败，先执行
> `bun run scripts/build-package.ts cli vite-plugin`（adep monorepo 根）重建 dist。

常用脚本：

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 本地开发（vite + 进程内 adep dev + /api 代理） |
| `npm run dev:api` | 只起云函数模拟运行时（127.0.0.1:8787） |
| `npm run build` | 前端构建到 `web/dist` |
| `npm run start` | 本地 serve 已构建产物（adep serve --spa） |
| `npm run db:init` | 建库 + 执行 `functions/schema.sql` 迁移 |
| `npm run deploy` | 发布到 adep 平台（6 云函数 + 前端） |
| `npm run test` | vitest 冒烟测试 |
| `npm run typecheck` | tsc strict 类型检查 |

## 调试提示

- **双人实测**：同一浏览器两个标签页共享 localStorage = **同一设备**，第二个标签打开邀请链接会
  「复用座位」而非加入——这是设备身份语义，不是 bug。真双人用另一浏览器/隐身窗口/另一设备。
- **后端联调**：`POST /api/auth/login {code:"dev:<deviceId>", nick}` 换 token；
  建房 `POST /api/rooms`；加入 `POST /api/rooms/:id/join`；轮询 `POST /api/rooms/:id/state {since}`；
  指令 `POST /api/rooms/:id/command {t:"move", edge:"h-0-0"}`。
- **重置本地数据**：`rm -rf .adep/sim` 后重启 dev。

## 测试

```bash
npm run test
```

规则引擎 `game-core` 三端共用（小程序 / 云函数 / web 前端），`tests/smoke.test.ts`
同时加载 `functions/_shared/game-core.js` 与 `web/src/game/core/index.js` 两份副本断言行为一致，
防止移植漂移。
