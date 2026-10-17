import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, delimiter } from 'path'

/** Additive Forge service provider; never patches an official library. */
export function provisionEarlyWindow(configRoot: string, gameDir: string, template: string[]): string[] {
  const source = join(configRoot, 'delta-early-window.jar')
  if (!existsSync(source)) throw new Error('缺少自定义加载界面组件，请修复启动器')
  const args = [...template]
  const legacy = args.findIndex(a => a.startsWith('-DlegacyClassPath='))
  const cp = args.findIndex(a => a === '-cp' || a === '-classpath' || a === '--class-path')
  if (cp < 0 || !args[cp + 1] || args[cp + 1].startsWith('-')) throw new Error('Forge 启动模板缺少服务加载路径')
  const folder = join(gameDir, 'delta-bootstrap')
  mkdirSync(folder, { recursive: true })
  const target = join(folder, 'delta-early-window.jar')
  if (!existsSync(target) || !readFileSync(source).equals(readFileSync(target))) {
    copyFileSync(source, target + '.next'); renameSync(target + '.next', target)
  }
  if (!args[cp + 1].split(delimiter).includes(target)) args[cp + 1] += delimiter + target
  if (legacy < 0) args.unshift('-DlegacyClassPath=' + args[cp + 1])
  else if (!args[legacy].split(delimiter).includes(target)) args[legacy] += delimiter + target
  const directory = join(gameDir, 'config'); mkdirSync(directory, { recursive: true })
  const file = join(directory, 'fml.toml')
  const original = existsSync(file) ? readFileSync(file, 'utf8') : ''
  // FML keys belong to the TOML root. Appending after a table silently sets a different key.
  const table = original.search(/^[ \t]*\[/m)
  const root = table < 0 ? original : original.slice(0, table)
  const rest = table < 0 ? '' : original.slice(table)
  const retained = root.replace(/^[ \t]*earlyWindow(?:Provider|Control)\s*=.*(?:\r?\n|$)/gm, '')
  const text = 'earlyWindowProvider = "deltaearlywindow"\nearlyWindowControl = true\n' + retained + rest
  if (text !== original) {
    if (existsSync(file) && !existsSync(file + '.before-delta-loading')) copyFileSync(file, file + '.before-delta-loading')
    writeFileSync(file + '.next', text, 'utf8'); renameSync(file + '.next', file)
  }
  return args
}
