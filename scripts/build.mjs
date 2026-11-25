import { spawnSync } from 'node:child_process'

/**
 * 生产构建入口：在 Windows 的 cmd 下 `NODE_ENV=production rspack build` 这种前置变量写法
 * 和 `rm -rf` 都不可用，这里用 Node 设置环境变量再调 rspack，
 * 清理 dist 交给 rspack 的 output.clean。
 */
const noSync = process.argv.includes('--no-sync')
const env = {
  ...process.env,
  NODE_ENV: 'production',
  ...(noSync ? { SYNC_SERVER: '0' } : {}),
}
const result = spawnSync('rspack', ['build', '-c', 'rspack.config.ts'], {
  stdio: 'inherit',
  env,
  shell: true,
})
process.exit(result.status ?? 1)
