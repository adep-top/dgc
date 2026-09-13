/**
 * 云柯点格棋 —— 规则引擎冒烟测试。
 *
 * 规则引擎 game-core 是「微信小游戏 / 云函数 / web 前端」三端共用的纯逻辑，
 * 本文件同时加载 functions/_shared/game-core.js（服务端）与
 * web/src/game/core/index.js（前端）两份副本，断言行为一致，防止移植漂移。
 *
 * 运行：pnpm test（apps/dgc 根目录，vitest）
 */
import { describe, it, expect } from 'vitest'
import * as serverCore from '../functions/_shared/game-core.js'
import * as webCore from '../web/src/game/core/index.js'

const cores = [
  { name: 'functions/_shared/game-core.js', core: serverCore },
  { name: 'web/src/game/core/index.js', core: webCore },
]

for (const { name, core } of cores) {
  describe(`game-core（${name}）`, () => {
    it('parseEdge 只认边 ID 格式 [hv]-r-c', () => {
      expect(core.parseEdge('h-0-0')).toEqual({ kind: 'h', r: 0, c: 0 })
      expect(core.parseEdge('v-3-5')).toEqual({ kind: 'v', r: 3, c: 5 })
      expect(core.parseEdge('h-0')).toBeNull()
      expect(core.parseEdge('x-0-0')).toBeNull()
      // 异步对局走边 ID 串；实时房间走 [x1,y1,x2,y2] 数组（在函数层转成边 ID）
      expect(core.parseEdge([1, 2])).toBeNull()
    })

    it('edgeCount 6x6 = 84 条边', () => {
      expect(core.edgeCount(6, 6)).toBe(84)
    })

    it('createGame 初始状态：空棋盘、先手 1、等待中', () => {
      const g = core.createGame({ rows: 6, cols: 6 })
      expect(g.edges).toBe('0'.repeat(84))
      expect(g.owner).toBe('0'.repeat(36))
      expect(g.turn).toBe(1)
      expect(g.status).toBe(core.STATUS.WAITING)
    })

    it('applyMove 落子后翻转回合并记录 move（返回新 state，不改原对象）', () => {
      let g = core.createGame({ rows: 6, cols: 6 })
      g = core.startGame(g)
      const r = core.applyMove(g, 1, 'h-0-0')
      expect(r.ok).toBe(true)
      expect(r.state.edges[core.edgeIndex('h-0-0', 6, 6)]).toBe('1')
      expect(r.state.turn).toBe(2)
      expect(r.state.moves).toHaveLength(1)
      // 原对象不被修改（纯函数）
      expect(g.turn).toBe(1)
    })

    it('重复落子无效', () => {
      let g = core.createGame({ rows: 6, cols: 6 })
      g = core.startGame(g)
      const r1 = core.applyMove(g, 1, 'h-0-0')
      const r2 = core.applyMove(r1.state, 2, 'h-0-0')
      expect(r2.ok).toBe(false)
      expect(r2.reason).toBe('edge_taken')
    })

    it('非本方回合无效', () => {
      let g = core.createGame({ rows: 6, cols: 6 })
      g = core.startGame(g)
      const r = core.applyMove(g, 2, 'h-0-0') // 先手是 1
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('not_your_turn')
    })

    it('围成格子得分并继续走（drops-and-boxes 规则）', () => {
      // 6x6 最小围格：h-0-0, v-0-0, h-1-0, v-0-1 围出左上角格子
      let g = core.createGame({ rows: 6, cols: 6 })
      g = core.startGame(g)
      for (const [p, edge] of [
        [1, 'h-0-0'],
        [2, 'v-0-0'],
        [1, 'h-1-0'],
        [2, 'v-0-1'],
      ] as const) {
        const r = core.applyMove(g, p, edge)
        expect(r.ok).toBe(true)
        g = r.state
      }
      // 最后一边由玩家 2 落下 → 玩家 2 得分 +1，且继续走（不翻转回合）
      expect(g.scores).toEqual([0, 1])
      expect(g.turn).toBe(2)
      expect(g.owner[0]).toBe('2')
    })

    it('终局判定：所有边占满 → finished + winner', () => {
      let g = core.createGame({ rows: 1, cols: 1 }) // 最小棋盘：4 条边、1 个格
      g = core.startGame(g)
      const edges = ['h-0-0', 'v-0-0', 'h-1-0', 'v-0-1']
      let last: { state: typeof g } | null = null
      for (let i = 0; i < edges.length; i++) {
        last = core.applyMove(g, i % 2 === 0 ? 1 : 2, edges[i])
        expect(last.ok).toBe(true)
        g = last.state
      }
      // 最后一边闭合格子 → 玩家 2 得 1 分并终结对局
      expect(g.status).toBe(core.STATUS.FINISHED)
      expect(g.winner).toBe(2)
      expect(g.scores).toEqual([0, 1])
    })
  })
}
