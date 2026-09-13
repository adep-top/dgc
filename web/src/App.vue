<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'

const canvasRef = ref<HTMLCanvasElement | null>(null)
let game: unknown = null

onMounted(async () => {
  // 1) 安装 wx 适配层（必须在导入游戏模块之前，模块调用期读全局 wx）
  const { installWxAdapter, registerWx } = await import('./platform/wx')
  const canvas = canvasRef.value
  if (!canvas) return
  registerWx(installWxAdapter(canvas))

  // 2) 动态导入游戏入口并启动（渲染循环在 App 内部）
  try {
    const { App } = await import('./game/app.js')
    game = new App()
  } catch (e) {
    console.error('[dgc] 游戏启动失败', e)
  }
})

onBeforeUnmount(() => {
  game = null
})
</script>

<template>
  <div class="dgc-stage">
    <canvas ref="canvasRef" class="dgc-canvas" />
  </div>
</template>
