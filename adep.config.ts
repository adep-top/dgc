// adep 项目配置（移植自微信小游戏「云柯点格棋」，原仓库 /Users/yunke/WorkBuddy/dot-grid-chess）。
// - name：项目标识（deploy / db 等命令的缺省 project slug = dgc）
// - functionsDir：云函数目录（dev / serve / deploy 读取）
// - functions_prefix：云函数路由前缀 /api，访问形态为 /api/{fn}（与线上函数路由对齐）
export default {
  name: 'dgc',
  template: 'fullstack',
  functionsDir: 'functions',
  functions_prefix: '/api',
}
