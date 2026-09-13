/** 路径归一化：剥掉 /api 前缀，函数内按「前缀后路径」匹配（与 countdown 一致）。 */
export function routePath(ctxPath: string): string {
  if (ctxPath === '/api') return '/'
  if (ctxPath.startsWith('/api/')) return ctxPath.slice(4)
  return ctxPath
}
