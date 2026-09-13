# dgc 云柯点格棋 —— 独立部署镜像（不依赖 adep 平台）
#
# 架构：单容器承载「云函数 + 前端静态站点 + 本地持久化」。
#   - 函数：@adep/cli 的 `adep serve`（本地模拟运行时，与平台同源执行器）
#   - 前端：vite build 产物 web/dist 由 serve 静态托管挂到 /
#   - 数据：sim 引擎持久化落 .adep/sim/（挂卷，容器重建不丢）
#   - 建表：`--schema functions/schema.sql` 启动时自动应用（IF NOT EXISTS 幂等）
#
# 构建：docker build -t dgc .
# 运行：docker compose up -d --build（或 docker run -p 8787:8787 -v dgc-data:/app/.adep dgc）

# —— 构建阶段：编译前端 ——
FROM node:20-alpine AS build
WORKDIR /build
# 先复制清单再装依赖（利用层缓存）；web/package.json 是自包含的（依赖均为 registry 版本）
COPY web/package.json web/tsconfig.json web/vite.config.ts web/index.html ./
COPY web/src ./src
RUN npm install --no-audit --no-fund
RUN npm run build
# 产物：/build/dist

# —— 运行阶段：@adep/cli 本地模拟运行时 ——
FROM node:20-alpine
WORKDIR /app

# 运行期依赖只有 @adep/cli（含 @adep/runtime / @adep/types 传递依赖，与平台同源实现）。
RUN printf '%s\n' \
  '{' \
  '  "name": "dgc-standalone",' \
  '  "private": true,' \
  '  "type": "module",' \
  '  "scripts": {' \
  '    "start": "adep serve --host 0.0.0.0 --schema functions/schema.sql --static ./web/dist --spa"' \
  '  },' \
  '  "dependencies": {' \
  '    "@adep/cli": "^0.1.10"' \
  '  }' \
  '}' > package.json
RUN npm install --omit=dev --no-audit --no-fund

# 应用代码（.dockerignore 已排除 node_modules / .adep / 构建产物等）
COPY functions ./functions
COPY adep.config.ts ./
# 前端构建产物
COPY --from=build /build/dist ./web/dist

EXPOSE 8787

# 健康检查：serve 的 /healthz（compose healthcheck 同打这里）
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

# 单实例语义：异常多实例形态拒绝启动（与离线部署包同口径）
ENV SINGLE_INSTANCE=true

CMD ["npm", "run", "start"]
