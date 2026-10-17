import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 自身更新验证（`--updatertest`）：**真的让 electron-updater 走一遍下载链**。
 *
 * <h2>为什么不能只测"配置写对了"</h2>
 * "feedUrl 有值、latest.yml 能 HTTP 拿到"只证明**一半**。真正容易坏的是
 * `electron-updater` 自己的那一半：它按 `provider/url` 拼下载地址、
 * 校验 `sha512`、用 `.blockmap` 做差分、挑安装包文件名……
 * 这些用我手写的 HTTP 请求**测不出来**（我可能恰好按我以为的协议测了）。
 *
 * <h2>所以这里起一个本地更新源，喂给真的 autoUpdater</h2>
 * 本地源提供：
 *   · `latest.yml`（含一个**真实计算**的 sha512 与一个真实的安装包文件）
 *   · 安装包本体（内容是随机字节 —— electron-updater 只校验哈希，不解析 NSIS）
 *   · blockmap（提供与不提供都要能跑：差分是优化，不是前提）
 * 然后调用 `checkForUpdates()` + `downloadUpdate()`，断言：
 *   ① 检测到新版本，且版本号与 latest.yml 一致
 *   ② 下载成功，落盘文件的 sha512 与清单一致
 *
 * <h2>它证明什么、不证明什么（必须说清）</h2>
 * ✅ 证明：版本比对、地址拼接、下载、**sha512 校验**这条链是通的。
 * ❌ 不证明：`quitAndInstall()` 真的能静默装好（那需要真的装一次；
 *    留作人工验证项，见 LAUNCHER.md）。
 */

interface Assertion {
  name: string
  ok: boolean
  detail?: string
}

export async function runUpdaterSelfTest(currentVersion: string): Promise<number> {
  const assertions: Assertion[] = []
  const check = (name: string, ok: boolean, detail?: string): void => {
    assertions.push({ name, ok, detail })
  }

  // 假的"安装包"：随机字节。electron-updater 不解析它，只按 sha512 校验大小与内容。
  const installer = Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 7), Buffer.from(currentVersion)])
  const sha512 = createHash('sha512').update(installer).digest('base64')
  const newVersion = '99.0.0' // 一定比当前版本"新"，这样才走更新路径
  const installerName = `BreaklineLauncher-${newVersion}-setup.exe`
  const latestYml = [
    `version: ${newVersion}`,
    'files:',
    `  - url: ${installerName}`,
    `    sha512: ${sha512}`,
    `    size: ${installer.length}`,
    `path: ${installerName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    ''
  ].join('\n')

  let hits: string[] = []
  const server: Server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    hits.push(url)
    if (url === '/latest.yml') {
      const b = Buffer.from(latestYml, 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/yaml', 'Content-Length': String(b.length) })
      res.end(b)
      return
    }
    if (url === `/${installerName}`) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers['range'] ?? ''))
      if (range) {
        const from = Number(range[1])
        const to = range[2] ? Math.min(Number(range[2]), installer.length - 1) : installer.length - 1
        const part = installer.subarray(from, to + 1)
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(part.length),
          'Content-Range': `bytes ${from}-${to}/${installer.length}`,
          'Accept-Ranges': 'bytes'
        })
        res.end(part)
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(installer.length) })
      res.end(installer)
      return
    }
    res.writeHead(404).end('nope')
  })

  const cacheDir = mkdtempSync(join(tmpdir(), 'delta-updatertest-'))
  /**
   * `forceDevUpdateConfig` 会强制去**开发目录根**读 `dev-app-update.yml`。
   *
   * 不建这个文件时报错是 `ENOENT ... dev-app-update.yml` —— 看起来像"下载坏了"，
   * 实际只是缺一个配置。所以测试自己建、跑完删（不留垃圾在工程根目录里）。
   */
  const devCfg = join(process.cwd(), 'dev-app-update.yml')
  let createdDevCfg = false
  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`
    console.log(`[updatertest] 本地更新源：${base}`)
    console.log(`[updatertest] 当前版本 ${currentVersion} → 声称新版本 ${newVersion}`)
    console.log(`[updatertest] 安装包（假）：${installer.length} 字节，sha512 ${sha512.slice(0, 20)}…`)

    // ⚠️ **不要用 `autoUpdater` 这个导出**。
    //
    // 它是 `electron-updater` 里的一个**惰性 getter**：首次访问时才
    // `new NsisUpdater()`，而这个构造函数走的是 CommonJS 的
    // `require('electron').app` —— 在 electron-vite 打出的 ESM bundle 里
    // 那一步拿到的是 `undefined`，于是 `autoUpdater` 直接是 `undefined`，
    // 报错是 `Cannot set properties of undefined (setting 'autoDownload')`，
    // 看起来像我的代码写错了（实测 2026-09-17）。
    //
    // Windows 上 electron-updater 用的就是 `NsisUpdater`（`autoUpdater` 最后也是它），
    // 所以直接实例化它：**行为一致，且不依赖那个脆弱的 getter**。
    const { NsisUpdater } = await import('electron-updater')
    // ⚠️ **必须先把上次运行的缓存清掉**。
    //
    // 为什么：electron-updater 按文件名在缓存目录里找已下好的安装包，
    // 找到就**直接复用、不再发请求**。于是第二次跑自检时：
    //   · 服务端只收到 /latest.yml，没有安装包请求
    //   · 但文件在、sha512 也对 ⇒ 测试报告"校验通过"
    // 那是一条**假绿**：它证明的是"缓存里的旧文件没坏"，而不是"下载链能工作"。
    // 实测靠服务端请求记录（只有 /latest.yml）才发现 —— 光看"哈希一致"永远发现不了。
    const cacheRootForTest = join(process.env['LOCALAPPDATA'] ?? tmpdir(), 'delta-updatertest')
    try {
      rmSync(cacheRootForTest, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    const autoUpdater = new NsisUpdater({ provider: 'generic', url: base })
    // 进度监听**必须在下载开始前**挂上。
    // 第一版挂在 downloadUpdate 之后 —— 小文件下得很快，事件已经发完，
    // 于是永远收不到，报"没发出过进度事件"（又是一次"测试自己的错"）。
    let progressSeen = false
    autoUpdater.on('download-progress', () => {
      progressSeen = true
    })
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    // 未打包环境下让它走"开发配置"路径：否则它会去找 resources/app-update.yml，
    // 找不到就直接放弃检查（症状就是 updateInfo 为 undefined，且**不报错**）。
    ;(autoUpdater as unknown as { forceDevUpdateConfig?: boolean }).forceDevUpdateConfig = true
    // 建那份 dev 配置（见上方注释）。内容就是 feed 指向我们的 mock 源。
    if (!existsSync(devCfg)) {
      writeFileSync(devCfg, `provider: generic\nurl: ${base}\nchannel: latest\nupdaterCacheDirName: delta-updatertest\n`, 'utf8')
      createdDevCfg = true
    }
    console.log('[updatertest] 用真实 NsisUpdater（Windows 上 autoUpdater 也是它）')

    // ---- ⓪ 先确认"源是好的" ----
    // 这一步把"我的 mock 源有问题"与"updater 行为不符预期"分开。
    // 没有它的话，两者都表现为"没检测到新版本"，得靠猜（实测踩到）。
    const probe = await fetch(`${base}/latest.yml`)
    const probeText = await probe.text()
    check('mock 源能提供 latest.yml', probe.ok && probeText.includes(newVersion), `HTTP ${probe.status}`)
    console.log(`  mock latest.yml 首行：${probeText.split('\n')[0]}`)

    // ---- ① 检查 ----
    const r = await autoUpdater.checkForUpdates()
    const found = r?.updateInfo?.version
    check('检测到新版本', found === newVersion, `updateInfo.version=${found}`)
    check(
      '拉的是我们那个 latest.yml',
      hits.includes('/latest.yml'),
      hits.join(',')
    )

    // ---- ② 下载（真的走 electron-updater 的下载器）----
    await autoUpdater.downloadUpdate()
    check('下载完成且发出过进度事件', progressSeen)

    // electron-updater 把文件放在自己的缓存里，**路径随版本与平台变化**。
    // 这里不猜路径：在几个候选根目录下**递归搜文件名**，找到再验哈希。
    // （第一版硬编码 `%LOCALAPPDATA%\breakline-launcher-updater\pending\...`，
    //   结果找不到就说"未找到" —— 那是**我的假设错了**，不是下载失败。
    //   硬编码别人的内部目录结构，本来就是不可靠的做法。）
    const searchRoots = [
      join(process.env['LOCALAPPDATA'] ?? cacheDir, 'delta-updatertest'),
      join(process.env['LOCALAPPDATA'] ?? cacheDir, 'breakline-launcher-updater'),
      join(process.env['LOCALAPPDATA'] ?? cacheDir),
      cacheDir,
      join(tmpdir(), 'delta-updatertest')
    ]
    let foundPath: string | undefined
    const walk = (dir: string, depth: number): void => {
      if (foundPath || depth > 4) return
      let entries: import('node:fs').Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isFile() && e.name === installerName) {
          foundPath = p
          return
        }
        if (e.isDirectory()) walk(p, depth + 1)
        if (foundPath) return
      }
    }
    for (const root of searchRoots) {
      if (existsSync(root)) walk(root, 0)
      if (foundPath) break
    }
    if (!foundPath) {
      // 找不到就**如实报失败**（不假绿），并给出实际搜过的位置
      check('下载的文件落盘且能被找到', false, `搜过：${searchRoots.join(' | ')}`)
    } else {
      const got = createHash('sha512').update(readFileSync(foundPath)).digest('base64')
      check('下载文件 sha512 与清单一致（这就是防篡改那一步）', got === sha512, `${got.slice(0, 20)}…`)
      console.log(`  落盘位置：${foundPath}`)
      // 顺手清掉：这是测试产物，不该留在玩家/开发机的缓存里
      try {
        rmSync(foundPath, { force: true })
      } catch {
        /* ignore */
      }
    }
    check('下载过程对安装包发过请求', hits.some((h) => h.includes(installerName)), hits.join(','))
  } catch (e) {
    check('自检未抛异常', false, e instanceof Error ? e.message : String(e))
  } finally {
    try {
      if (createdDevCfg) rmSync(devCfg, { force: true })
    } catch {
      /* ignore */
    }
    try {
      server.close()
    } catch {
      /* ignore */
    }
    try {
      rmSync(cacheDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  const failed = assertions.filter((a) => !a.ok)
  for (const a of assertions) {
    console.log(`  ${a.ok ? '[PASS]' : '[FAIL]'} ${a.name}${a.detail && !a.ok ? `  ← ${a.detail}` : ''}`)
  }
  console.log(`[updatertest] ${assertions.length - failed.length}/${assertions.length} 通过`)
  console.log('  说明：本项证明"检查→下载→sha512 校验"这条链通；')
  console.log('        "quitAndInstall 真的装上去"需要真装一次，属人工验证项。')
  return failed.length === 0 ? 0 : 1
}

/**
 * 真实更新源自检（`--selfupdatecheck`）：打**线上 feedUrl**，只查不装。
 *
 * 这是"配好没有"的最终判据：能在打包版里真连上我们的 8787 更新源、
 * 读到 latest.yml、报出准确的当前/最新版本。
 */
export async function runSelfUpdateCheck(feedUrl: string, currentVersion: string): Promise<number> {
  console.log(`[selfupdatecheck] feedUrl = ${feedUrl || '(未配置)'}`)
  console.log(`[selfupdatecheck] 当前版本 = ${currentVersion}`)
  if (!feedUrl) {
    console.log('  [FAIL] 未配置 feedUrl')
    return 1
  }
  let ok = true
  /**
   * 远端是否**真的**比本地新。
   *
   * 这个标志决定下面"换实例下载"那一条怎么判：
   * electron-updater 只在**真有新版本**时才把检查结果记在实例上，
   * 所以本地版本已经 ≥ feed 时，下载报 `Please check update first` 是它的**正常行为**，
   * 不是我们的缺陷 —— 无条件要求下载成功会得到一个假红（2026-09-18 实测踩到）。
   */
  let updateAvailable: boolean | null = null
  try {
    const res = await fetch(`${feedUrl.replace(/\/+$/, '')}/latest.yml`, {
      signal: AbortSignal.timeout(20000)
    })
    console.log(`  GET ${feedUrl}/latest.yml → HTTP ${res.status}`)
    if (!res.ok) ok = false
    const text = await res.text()
    if (ok) {
      // ⚠️ 不能写 `/(?m)^version:.../` —— `(?m)` 是 **Python** 的行内标志写法，
      // JS 正则里没有它（JS 用 `/.../m`）。写了会直接变成**语法错误**，
      // 而且报错指向行内位置，看起来像别的问题。
      const m = /^version:\s*(.+)$/m.exec(text)
      const latest = m ? m[1].trim() : ''
      console.log(`  远端版本 = ${latest}`)
      // 逐段比数字（不能用 !== 判"有新版本"：那会把降级也当成更新）
      const seg = (v: string): number[] => v.split('.').map((x) => Number.parseInt(x, 10))
      const ra = seg(latest)
      const la = seg(currentVersion)
      updateAvailable =
        ra.length > 0 && !ra.some(Number.isNaN) && !la.some(Number.isNaN)
          ? ra.some((n, i) => n !== (la[i] ?? 0) && n > (la[i] ?? 0) && ra.slice(0, i).every((p, j) => p === (la[j] ?? 0)))
          : null
      console.log(`  需要更新 = ${updateAvailable === true}${updateAvailable === null ? '（版本号解析不了，跳过该判定）' : ''}`)
      const p = /^path:\s*(.+)$/m.exec(text)
      if (p) {
        const url = `${feedUrl.replace(/\/+$/, '')}/${p[1].trim()}`
        // ⚠️ 这里**不能**用 HEAD：我们的 player-api 只实现了 do_GET / do_POST，
        //    HEAD 会得到 501 —— 而 501 会被下面读成"更新源有问题"。
        //    2026-09-18 实测就是这样：feed 明明好的（sha512/size/Range 全部核过），
        //    自查却报红。**假红比不查更贵**：它会让人去改本来正确的东西。
        //    改用 `Range: bytes=0-0` 的 GET：支持断点续传时回 206 + Content-Range，
        //    于是"总大小"和"electron-updater 分块下载要用的那个能力"一起验了。
        const probe = await fetch(url, {
          headers: { Range: 'bytes=0-0' },
          signal: AbortSignal.timeout(20000)
        })
        const contentRange = probe.headers.get('content-range') ?? ''
        const total = contentRange.includes('/')
          ? contentRange.split('/')[1]
          : probe.headers.get('content-length')
        console.log(
          `  GET(Range: bytes=0-0) ${p[1].trim()} → HTTP ${probe.status}，总大小=${total}`
        )
        console.log(`  Accept-Ranges=${probe.headers.get('accept-ranges')}（electron-updater 分块下载靠它）`)
        // 206 = 支持断点续传（期望）；200 = 服务端忽略了 Range（仍可整体下载，不算错）。
        if (probe.status !== 206 && probe.status !== 200) ok = false
      }
    }
  } catch (e) {
    console.log(`  [FAIL] ${e instanceof Error ? e.message : String(e)}`)
    ok = false
  }

  // ---- 关键补测：走**界面按钮真正走的那条路**（SelfUpdateService.check()）----
  //
  // 为什么必须补：上面那些 HTTP 检查只证明"feed 是好的"，**证明不了"检查更新能跑"**。
  // 0.2.1 的实际情况正是如此：feed 全绿，而界面报
  //   `检查失败：Cannot set properties of undefined (setting 'autoDownload')`
  // —— 因为 `electron-updater` 的 `autoUpdater` 导出是惰性 getter，在打包后的 bundle 里
  // 是 `undefined`（详见 UpdaterSelfTest 里那段注释与 SelfUpdateService.updaterInstance()）。
  // 手写 HTTP 永远测不出这个：它压根没碰那个模块。
  console.log('')
  console.log('  —— 界面按钮那条路（SelfUpdateService.check）——')
  try {
    const { SelfUpdateService } = await import('./SelfUpdateService')
    const service = new SelfUpdateService(feedUrl)
    const info = await service.check()
    console.log(`  当前版本 = ${info.currentVersion}（packaged=${info.packaged}）`)
    console.log(`  有新版本 = ${info.available}${info.version ? '，远端 ' + info.version : ''}`)
    if (info.error) {
      console.log(`  [FAIL] 检查更新报错：${info.error}`)
      ok = false
    } else {
      console.log('  [PASS] 检查更新返回了结论（没有抛错、没有 undefined）')
    }
  } catch (e) {
    console.log(`  [FAIL] SelfUpdateService 直接抛异常：${e instanceof Error ? e.message : String(e)}`)
    ok = false
  }

  console.log(ok ? '[selfupdatecheck] ✅ 更新源可用' : '[selfupdatecheck] ❌ 更新源有问题')

  // ---- 关键补测 ②：**换一个实例**再下载（这才是界面上真实的调用顺序）----
  //
  // 为什么必须补：界面上的「检查启动器更新」与「更新到 X」是**两次 IPC**，
  // 主进程每次都会 `new SelfUpdateService(...)`。如果 updater 实例不是在**模块级**共享的，
  // 下载就会在一张白纸上被调用，报 `Please check update first` ——
  // **2026-09-18 运维截图实测就是这个**（上面那条 HTTP 检查当时是绿的，因为它压根不碰这一步）。
  console.log('')
  console.log('  —— 检查与下载是不是**同一个实例**（这才是 `Please check update first` 的根因）——')
  try {
    const { SelfUpdateService } = await import('./SelfUpdateService')
    const checker = new SelfUpdateService(feedUrl)
    const downloader = new SelfUpdateService(feedUrl) // 界面上"立即更新"那一次 IPC 就是这个
    const a = await checker.updaterForTest()
    const b = await downloader.updaterForTest()
    if (a && a === b) {
      console.log('  [PASS] 两次调用拿到的是同一个 updater 实例（检查结果会被下载那一步看到）')
    } else {
      console.log('  [FAIL] 两次调用拿到了**不同**实例 ⇒ 下载必然报 Please check update first')
      ok = false
    }
  } catch (e) {
    console.log(`  [FAIL] 取实例时抛异常：${e instanceof Error ? e.message : String(e)}`)
    ok = false
  }

  // 行为侧的补充：只有在"真有新版本"时下载才会成功，所以这里**按可用性分支**判断，
  // 而不是无条件要求下载成功（否则本地版本领先 feed 时会得到一个假红）。
  console.log('')
  console.log('  —— 换一个实例再下载（界面上真实的调用顺序）——')
  try {
    const { SelfUpdateService } = await import('./SelfUpdateService')
    const fresh = new SelfUpdateService(feedUrl)
    const raced = await Promise.race([
      fresh.doDownload().then((r) => ({ done: true as const, r })),
      new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 4000))
    ])
    if (!raced.done) {
      console.log('  [PASS] 换实例后下载已经开始（没有抛「请先检查更新」）')
    } else if (raced.r.ok) {
      console.log('  [PASS] 换实例后下载成功')
    } else if (updateAvailable === false && /check update first/i.test(String(raced.r.error))) {
      // 本地版本已经 ≥ feed：electron-updater 根本不会记住检查结果，
      // 此时报这句话是**它的正常行为**，不是我们的缺陷（上面那条同一性断言才是判据）。
      console.log(`  [PASS] 本地版本不低于 feed，下载被拒是 electron-updater 的正常行为：${raced.r.error}`)
    } else {
      console.log(`  [FAIL] 换实例后下载失败：${raced.r.error}`)
      ok = false
    }
  } catch (e) {
    console.log(`  [FAIL] 换实例下载时直接抛异常：${e instanceof Error ? e.message : String(e)}`)
    ok = false
  }

  console.log(ok ? '[selfupdatecheck] ✅ 结论：检查与下载都可用' : '[selfupdatecheck] ❌ 结论：有问题')
  return ok ? 0 : 1
}
