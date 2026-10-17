import { downloadQueue } from './PinnedDownload'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { trustedJavaEnvironment } from './JvmTrust'

const FORGE = '1.20.1-47.4.13'
const MCP = '1.20.1-20230612.114412'
const INSTALLER_SHA256 = 'cce3c47e532ab19442435ad8c817ef4c9a76ea1cde9802fcdeb9bff9e39e8289'
// Extra/patched hashes are supplied by the verified Forge install profile.
// SRG hash is also checked against a fresh run of that exact official pipeline.
const GENERATED = [
  [`net/minecraft/client/${MCP}/client-${MCP}-srg.jar`, '3c8aa19b710a3a68f721210eb69b74594d13e218'],
  [`net/minecraft/client/${MCP}/client-${MCP}-extra.jar`, '8c5a95cbce940cfdb304376ae9fea47968d02587'],
  [`net/minecraftforge/forge/${FORGE}/forge-${FORGE}-client.jar`, '4d8a9a63dc16a45d7fc5c54c627234f601d0cc17']
] as const
export const FORGE_GENERATED_PATHS: readonly string[] = GENERATED.map(([path]) => path)
const REQUIRED = [
  ...GENERATED,
  [`net/minecraftforge/fmlcore/${FORGE}/fmlcore-${FORGE}.jar`, 'f77e3021d1eb31d61f8d1b92d18ed4fb3c2806e5'],
  [`net/minecraftforge/forge/${FORGE}/forge-${FORGE}-universal.jar`, '3a664ce8e261a072b0983082b4f4feef59cbc698'],
  [`net/minecraftforge/javafmllanguage/${FORGE}/javafmllanguage-${FORGE}.jar`, '0cf01e2179f72bd2829c65f5226d7dd0cfb6c686'],
  [`net/minecraftforge/lowcodelanguage/${FORGE}/lowcodelanguage-${FORGE}.jar`, 'e3f96129ea14eba84316f2d69816253e228e6e4c'],
  [`net/minecraftforge/mclanguage/${FORGE}/mclanguage-${FORGE}.jar`, '85796906112d9b621a7b2996f8bfda49da991ef0']
] as const
export const FORGE_RUNTIME_FILES = REQUIRED.length

function matches(file: string, expected: string, algorithm = 'sha1'): boolean {
  try { return createHash(algorithm).update(readFileSync(file)).digest('hex') === expected } catch { return false }
}

export function missingForgeRuntime(gameRoot: string): string[] {
  return REQUIRED.filter(([path, hash]) => !matches(join(gameRoot, 'libraries', path), hash)).map(([path]) => path)
}

type Artifact = { path: string; url: string; sha1: string }
type Meta = { downloads: { client: { url: string; sha1: string }; client_mappings: { url: string; sha1: string } } }
type Profile = { java: string; gameRoot: string; gameDir: string; version: string; launcherDataDir: string; reuseRoots?: string[] }
type Download = (url: string, target: string, hash: string, algorithm: 'sha1' | 'sha256') => Promise<boolean>

async function run(java: string, args: string[], cwd: string, report?: (message: string) => void): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(java, args, { cwd, windowsHide: true, env: trustedJavaEnvironment(process.env), stdio: 'ignore' })
    const started = Date.now()
    const heartbeat = setInterval(() => report?.(`正在处理 Forge 运行文件，已用 ${Math.round((Date.now() - started) / 1000)} 秒，请保持启动器打开`), 3000)
    const timer = setTimeout(() => { child.kill(); reject(new Error('Forge 安装处理超过 3 分钟，已有文件已保留，再点一次会继续')) }, 180_000)
    child.once('error', error => { clearTimeout(timer); clearInterval(heartbeat); reject(error) })
    child.once('close', code => { clearTimeout(timer); clearInterval(heartbeat); code === 0 ? accept() : reject(new Error(`Forge 安装处理失败（代码 ${code}）`)) })
  })
}

/** Run the official, pinned client processors in isolation; publish only verified outputs. */
export async function provisionForgeRuntime(profile: Profile, meta: Meta, download: Download, report: (message: string) => void): Promise<void> {
  for (const [path, expected] of REQUIRED) {
    const target = join(profile.gameRoot, 'libraries', path)
    if (matches(target, expected)) continue
    for (const root of profile.reuseRoots ?? []) {
      const source = join(root, 'libraries', path)
      if (!matches(source, expected)) continue
      mkdirSync(dirname(target), { recursive: true })
      const part = `${target}.${process.pid}.reuse`
      try { copyFileSync(source, part); if (matches(part, expected)) renameSync(part, target) }
      finally { rmSync(part, { force: true }) }
      report(`已复用本机 Forge 文件：${path}`)
      break
    }
  }
  if (missingForgeRuntime(profile.gameRoot).length === 0) return
  const cache = join(profile.launcherDataDir, 'runtime', 'forge')
  mkdirSync(cache, { recursive: true })
  const installer = join(cache, `forge-${FORGE}-installer.jar`)
  await download(`https://files.minecraftforge.net/maven/net/minecraftforge/forge/${FORGE}/forge-${FORGE}-installer.jar`, installer, INSTALLER_SHA256, 'sha256')
  const staged = mkdtempSync(join(cache, 'client-'))
  const jar = join(dirname(profile.java), process.platform === 'win32' ? 'jar.exe' : 'jar')
  const extract = (archive: string, files: string[], into: string): Promise<void> => existsSync(jar)
    ? run(jar, ['xf', archive, ...files], into)
    : process.platform === 'win32' ? run('tar.exe', ['-xf', archive, ...files], into)
    : run('unzip', ['-o', archive, ...files, '-d', into], into)
  try {
    await extract(installer, ['install_profile.json', 'data/client.lzma'], staged)
    const install = JSON.parse(readFileSync(join(staged, 'install_profile.json'), 'utf8')) as {
      libraries: Array<{ downloads: { artifact: Artifact } }>
      data: Record<string, { client: string }>
      processors: Array<{ sides?: string[]; jar: string; classpath: string[]; args: string[] }>
    }
    const libraries = join(staged, 'libraries')
    const safe = (path: string): string => {
      const file = resolve(libraries, path)
      if (!file.startsWith(resolve(libraries) + sep)) throw new Error('Forge 依赖路径无效')
      return file
    }
    const artifactPath = (coordinate: string): string => {
      const [gav, extension = 'jar'] = coordinate.replace(/^\[|\]$/g, '').split('@')
      const [group, name, version, classifier] = gav.split(':')
      return safe(`${group.replace(/\./g, '/')}/${name}/${version}/${name}-${version}${classifier ? '-' + classifier : ''}.${extension}`)
    }
    report('正在补齐 Forge 安装依赖…')
    await downloadQueue(install.libraries, 6, async ({ downloads: { artifact } }) => {
      const target = safe(artifact.path)
      mkdirSync(dirname(target), { recursive: true })
      const existing = join(profile.gameRoot, 'libraries', artifact.path)
      if (matches(existing, artifact.sha1)) copyFileSync(existing, target)
      else {
        const url = artifact.url.replace('https://maven.minecraftforge.net/', 'https://files.minecraftforge.net/maven/')
        const retained = resolve(cache, 'verified-libraries', artifact.path)
        if (!retained.startsWith(resolve(cache, 'verified-libraries') + sep)) throw new Error('Forge 缓存路径无效')
        await download(url, retained, artifact.sha1, 'sha1')
        copyFileSync(retained, target)
      }
    })
    const mapping = artifactPath(install.data.MOJMAPS.client)
    await download(meta.downloads.client_mappings.url, mapping, meta.downloads.client_mappings.sha1, 'sha1')
    const versionJar = join(profile.gameDir, `${profile.version}.jar`)
    if (!matches(versionJar, meta.downloads.client.sha1)) throw new Error('Minecraft 主程序未通过校验，请先完成修复')
    const values: Record<string, string> = { SIDE: 'client', ROOT: staged, LIBRARY_DIR: libraries, MINECRAFT_JAR: versionJar }
    for (const [name, data] of Object.entries(install.data)) {
      const value = data.client
      values[name] = value.startsWith('[') ? artifactPath(value) : value.startsWith("'") ? value.slice(1, -1) : join(staged, value.replace(/^\//, ''))
    }
    const expand = (arg: string): string => arg.startsWith('[') ? artifactPath(arg) : arg.replace(/\{([^}]+)\}/g, (_, key: string) => {
      if (!(key in values)) throw new Error('Forge 安装参数不完整')
      return values[key]
    })
    const processors = install.processors.filter(p => !p.sides || p.sides.includes('client'))
    for (let index = 0; index < processors.length; index++) {
      const processor = processors[index]
      // This mapping was downloaded above with Mojang's checksum, avoiding a second unchecked network fetch.
      if (processor.args.includes('DOWNLOAD_MOJMAPS')) continue
      report(`正在生成 Forge 客户端文件 ${index + 1}/${processors.length}…`)
      const mainJar = artifactPath(processor.jar)
      const manifestDir = join(staged, `manifest-${index}`)
      mkdirSync(manifestDir)
      await extract(mainJar, ['META-INF/MANIFEST.MF'], manifestDir)
      const manifest = readFileSync(join(manifestDir, 'META-INF/MANIFEST.MF'), 'utf8').replace(/\r?\n /g, '')
      const mainClass = /^Main-Class: (.+)$/m.exec(manifest)?.[1].trim()
      if (!mainClass) throw new Error('Forge 安装组件缺少入口')
      const args = processor.args.map(expand)
      for (const arg of args) if (arg.startsWith(staged + sep)) mkdirSync(dirname(arg), { recursive: true })
      await run(profile.java, ['-Xmx1024M', '-cp', [mainJar, ...processor.classpath.map(artifactPath)].join(delimiter), mainClass, ...args], staged, report)
    }
    for (const [path, expected] of GENERATED) {
      const source = safe(path)
      if (!matches(source, expected)) throw new Error(`Forge 生成文件校验失败：${path}`)
    }
    for (const [path] of GENERATED) {
      const target = join(profile.gameRoot, 'libraries', path)
      mkdirSync(dirname(target), { recursive: true })
      const part = `${target}.${process.pid}.part`
      copyFileSync(safe(path), part)
      renameSync(part, target)
    }
    // FML also locates language providers/core through libraryDirectory, outside -cp.
    for (const { downloads: { artifact } } of install.libraries) {
      const target = join(profile.gameRoot, 'libraries', artifact.path)
      if (matches(target, artifact.sha1)) continue
      mkdirSync(dirname(target), { recursive: true })
      const part = `${target}.${process.pid}.part`
      copyFileSync(safe(artifact.path), part)
      renameSync(part, target)
    }
    if (missingForgeRuntime(profile.gameRoot).length) throw new Error('Forge 生成文件安装未完成')
  } finally {
    if (!resolve(staged).startsWith(resolve(cache) + sep)) throw new Error('Forge 暂存目录越界')
    rmSync(staged, { recursive: true, force: true })
  }
}
