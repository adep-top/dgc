// web/vite.config.ts —— 云柯点格棋前端（Vue 3 + Vite 壳，游戏本体为 Canvas 2D）。
//
// 本地开发（npm run dev，在 apps/dgc 根执行）：
//   - command === 'serve' 时动态加载 @adep/cli/vite：进程内 `adep dev`（模拟运行时，
//     cwd = 应用根 apps/dgc，读取 adep.config.ts 与 functions/），并把 /api/* 代理到它，
//     一条命令同时调试前端 + 云函数（函数改动热重载）。
//
// 平台构建（adep publish --only frontend 的服务端 vite build）：
//   - command === 'build'，不加载 @adep/cli/vite，保证发布产物独立构建。
import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'

export default defineConfig(async ({ command }) => {
  const plugins: Plugin[] = [vue()]

  if (command === 'serve') {
    const adep = (await import('@adep/cli/vite')).default
    plugins.push(adep({ cwd: fileURLToPath(new URL('..', import.meta.url)) }) as unknown as Plugin)
  }

  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins,
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      host: '127.0.0.1',
    },
  }
})
