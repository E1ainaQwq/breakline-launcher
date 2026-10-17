import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

/** Permit only the exact shipped authentication helper. Never trust an agent filename. */
export function assertTrustedJvmArgs(args: string[]): void {
  let agents = 0
  for (const arg of args) {
    if (arg.startsWith('@') || /^-agent(lib|path):/i.test(arg) || /^-Xbootclasspath/i.test(arg) || /^-Djava\.system\.class\.loader=/i.test(arg)) {
      throw new Error('游戏启动参数包含未经允许的注入入口，请恢复官方配置')
    }
    if (!/^-javaagent:/i.test(arg)) continue
    agents++
    const value = arg.slice('-javaagent:'.length)
    const index = value.indexOf('=')
    if (index < 1 || value.slice(index + 1) !== 'https://littleskin.cn/api/yggdrasil/') throw new Error('登录代理参数不符合官方配置')
    const file = value.slice(0, index)
    if (statSync(file).size > 2_000_000 || createHash('sha256').update(readFileSync(file)).digest('hex') !==
        '9c7f4343e6c82034958ffb48c14a2cb0c85928be7283103ce17da00c6d5a7b10') {
      throw new Error('登录组件校验失败，请重新修复客户端')
    }
  }
  if (agents > 1) throw new Error('游戏启动参数包含重复登录代理，请恢复官方配置')
}

/** Java reads these independently of argv. Scope removal to the game child. */
export function trustedJavaEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const name of Object.keys(env)) {
    if (['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS'].includes(name.toUpperCase())) delete env[name]
  }
  return env
}
