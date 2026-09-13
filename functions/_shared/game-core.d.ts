/** game-core.js（原样移植的共享游戏引擎）类型声明 */
export type GameState = {
  rows: number
  cols: number
  seq: number
  turn: number
  firstPlayer: number
  status: string
  winner: number
  scores: [number, number]
  moves: Array<{ seq: number; by: number; edge: string; gained: number[] }>
  boxes: number[]
  vertical: boolean[]
  horizontal: boolean[]
  seed: number
}

export const VERSION: number
export const STATUS: { WAITING: string; PLAYING: string; FINISHED: string }
export const DRAW: number
export function other(p: number): number
export function createGame(opts?: { rows?: number; cols?: number; firstPlayer?: number }): GameState
export function cloneState(s: GameState): GameState
export function startGame(s: GameState): GameState
export function applyMove(
  s: GameState,
  player: number,
  edgeId: string,
): { ok: true; state: GameState; edge: string; gained: number[]; finished: boolean; winner: number } | { ok: false; reason: string }
export function undoMove(s: GameState): GameState
export function pickMove(s: GameState, level?: string, rnd?: () => number): string | null
export function serialize(s: GameState): string
export function deserialize(raw: Record<string, unknown> | null | undefined): GameState | null
