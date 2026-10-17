import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpdateService, validateManifest, type PackManifest } from './UpdateService'

/**
 * 更新器自检（`--updatetest`）：**起一个真的 HTTP 更新源**，把整条链跑一遍。
 *
 * 为什么不用 mock 对象：更新器的失败模式全在真实世界的边角——
 * Range 请求、哈希不符、断点到一半、替换到一半失败。用假对象测，恰好一个都测不到。
 *
 * 覆盖（每条都对应一种"玩家会遇到的真实故障"）：
 *  1. 全缺失 → 全下；第二次跑 → 一个都不下（幂等，不能每次重下 316 MB）
 *  2. 本地被改坏一个 jar → **只**重下那一个
 *  3. 服务端给的内容与清单哈希不符 → 拒收，且**不得覆盖**本地正确文件
 *  4. 下载地址非法（file://）→ 拒绝
 *  5. 清单形状不对（sha256 不是 64 位十六进制 / 重名 / files 非数组）→ 拒绝并说清原因
 *  6. `.pre-*` / `.pending-*` 部署留档 → **不算模组、不参与比对、不被删**
 *  7. 多余文件 → 隔离到可恢复备份，不再参与 Forge 握手
 */

interface Assertion {
  name: string
  ok: boolean
  detail?: string
}

export async function runUpdateSelfTest(): Promise<number> {
  const assertions: Assertion[] = []
  const check = (name: string, ok: boolean, detail?: string): void => {
    assertions.push({ name, ok, detail })
  }

  /** mock 更新源：内容在内存里，按 md5(内容) 定位，支持 Range。 */
  const contents = new Map<string, Buffer>()
  let dropRange = false
  let served = 0
  const key = (b: Buffer): string => createHash('md5').update(b).digest('hex')

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(currentManifest))
      return
    }
    const m = /^\/file\/([0-9a-f]{32})$/.exec(url)
    if (!m) {
      res.writeHead(404).end('not found')
      return
    }
    const buf = contents.get(m[1])
    if (!buf) {
      res.writeHead(404).end('no such content')
      return
    }
    served++
    const range = dropRange ? null : /^bytes=(\d+)-$/.exec(String(req.headers['range'] ?? ''))
    if (range) {
      const from = Number(range[1])
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${from}-${buf.length - 1}/${buf.length}`,
        'Content-Length': String(buf.length - from)
      })
      res.end(buf.subarray(from))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) })
    res.end(buf)
  })

  let currentManifest: unknown = null
  let base = ''
  const root = mkdtempSync(join(tmpdir(), 'delta-updatetest-'))
  const modsDir = join(root, 'mods')
  const staging = join(root, 'staging')
  const backup = join(root, 'backup')
  mkdirSync(modsDir, { recursive: true })

  const progressSeen: string[] = []
  const svc = (): UpdateService =>
    new UpdateService(modsDir, staging, backup, (p) => {
      const tag = `${p.phase}:${p.percent}`
      if (progressSeen.at(-1) !== tag) progressSeen.push(tag)
    })

  const mkEntry = (name: string, content: Buffer, badHash = false): Record<string, unknown> => {
    const k = key(content)
    contents.set(k, content)
    return {
      name,
      sha256: badHash ? 'f'.repeat(64) : createHash('sha256').update(content).digest('hex'),
      size: content.length,
      url: `${base}/file/${k}`
    }
  }

  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    console.log(`[updatetest] mock 更新源：${base}`)
    console.log(`[updatetest] 工作目录：${root}`)

    // 两个"模组"：一个纯文本、一个含 NUL 的二进制（避免只测文本才发现不了二进制问题）
    const jarA = Buffer.from('A'.repeat(2048))
    const jarB = Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.alloc(4096, 7)])
    const files = [mkEntry('mod-a.jar', jarA), mkEntry('mod-b-1.0.0.jar', jarB)]
    currentManifest = {
      packVersion: 'test-1',
      gameVersion: 'test',
      generatedAt: new Date().toISOString(),
      files
    }
    const manifest = (currentManifest as { files: unknown[] }).files as never[]

    // ---- 1) 全缺失 → 全下；第二次不重下 ----
    const r1 = await svc().apply(currentManifest as PackManifest)
    check('首次更新成功', r1.ok === true, JSON.stringify(r1))
    check('两个文件都到位', r1.applied?.length === 2, JSON.stringify(r1.applied))
    check('内容逐字节正确', readFileSync(join(modsDir, 'mod-a.jar')).equals(jarA))
    const baseline = join(root, 'config', 'deltaac-mods-baseline.properties')
    const baselineText = readFileSync(baseline, 'utf8')
    check('更新同步反作弊基线', files.every(f => baselineText.includes(`${f.name}=${f.sha256}\n`)))
    writeFileSync(baseline, '# stale release\nold.jar=' + '0'.repeat(64))
    const servedAfterFirst = served
    const r2 = await svc().apply(currentManifest as PackManifest)
    check('第二次跑：没有需要更新的文件', r2.ok === true && r2.applied.length === 0, JSON.stringify(r2))
    check('第二次跑：一个字节都没重新下载（幂等）', served === servedAfterFirst, `served=${served}`)
    check('模组无变化也修复旧基线', readFileSync(baseline, 'utf8') === baselineText)

    // ---- 2) 本地被改坏 → 只重下那一个 ----
    writeFileSync(join(modsDir, 'mod-a.jar'), 'tampered')
    const before = served
    const r3 = await svc().apply(currentManifest as PackManifest)
    check('篡改被识别', r3.applied.length === 1 && r3.applied[0] === 'mod-a.jar', JSON.stringify(r3.applied))
    check('只重下了被改的那一个', served - before === 1, `多下了 ${served - before} 个`)
    check('重下后内容恢复', readFileSync(join(modsDir, 'mod-a.jar')).equals(jarA))

    // ---- 3) 服务端内容与清单哈希不符 → 拒收，且不覆盖本地正确文件 ----
    // 声明一个"应该是坏内容"的哈希，但服务端发的是另一份内容
    const wrongContent = Buffer.from('this is not what the manifest promised')
    const wk = key(wrongContent)
    contents.set(wk, wrongContent)
    const badManifest = {
      packVersion: 'test-2',
      gameVersion: 'test',
      files: [
        {
          name: 'mod-a.jar',
          sha256: 'a'.repeat(64), // 与任何真实内容都不符
          size: wrongContent.length,
          url: `${base}/file/${wk}`
        }
      ]
    }
    const r4 = await svc().apply(badManifest as PackManifest)
    check('哈希不符 → 更新失败（不是"成功但有坏文件"）', r4.ok === false, JSON.stringify(r4))
    check('失败后本地正确文件**没有被覆盖**', readFileSync(join(modsDir, 'mod-a.jar')).equals(jarA))
    check('坏下载不能改写可信基线', readFileSync(baseline, 'utf8') === baselineText)

    // ---- 3b) 服务端不支持 Range 时仍能续传成功 ----
    dropRange = true
    writeFileSync(join(modsDir, 'mod-b-1.0.0.jar'), 'broken')
    const r5 = await svc().apply(currentManifest as PackManifest)
    check('对端忽略 Range 也能正确重下（不能拼出坏文件）', r5.ok === true && readFileSync(join(modsDir, 'mod-b-1.0.0.jar')).equals(jarB), JSON.stringify(r5))
    dropRange = false

    // ---- 4) 非法下载地址 ----
    const badUrlManifest = {
      packVersion: 't',
      gameVersion: 'test',
      files: [{ name: 'evil.jar', sha256: 'b'.repeat(64), size: 3, url: 'file:///C:/windows/system32/x.jar' }]
    }
    const v0 = validateManifest(badUrlManifest)
    check('file:// 下载地址被清单校验拒绝', v0.ok === false, JSON.stringify(v0))

    // ---- 5) 清单形状 ----
    check('files 非数组被拒', validateManifest({ files: null }).ok === false)
    check(
      'sha256 非 64 位十六进制被拒',
      validateManifest({ files: [{ name: 'x.jar', sha256: 'zz', size: 1, url: 'http://h/x' }] }).ok === false
    )
    check(
      '重名条目被拒',
      validateManifest({
        files: [
          { name: 'x.jar', sha256: 'a'.repeat(64), size: 1, url: 'http://h/x' },
          { name: 'x.jar', sha256: 'b'.repeat(64), size: 1, url: 'http://h/x' }
        ]
      }).ok === false
    )
    check('合法清单通过校验', validateManifest(currentManifest).ok === true)

    // ---- 6) 部署留档不算模组 ----
    writeFileSync(join(modsDir, 'delta-mod-0.4.42.jar.pre-20260917'), 'backup of old mod')
    writeFileSync(join(modsDir, '.pending-delta-mod.jar'), 'pending')
    const d = svc().diff(currentManifest as PackManifest)
    check('部署留档不进"多出"清单', !d.extra.some((n) => n.includes('pre-') || n.includes('pending')), JSON.stringify(d.extra))
    const r6 = await svc().apply(currentManifest as PackManifest)
    check('留档不会被更新器删掉', existsSync(join(modsDir, 'delta-mod-0.4.42.jar.pre-20260917')) && r6.ok)

    // ---- 7) 多余文件隔离但不删除 ----
    writeFileSync(join(modsDir, 'player-added-mod.jar'), 'user installed this themselves')
    const d2 = svc().diff(currentManifest as PackManifest)
    check('多余文件被报告', d2.extra.includes('player-added-mod.jar'), JSON.stringify(d2.extra))
    const r7 = await svc().apply(currentManifest as PackManifest)
    check('多余文件已隔离出 mods', r7.ok && !!r7.quarantined?.includes('player-added-mod.jar') && !existsSync(join(modsDir, 'player-added-mod.jar')), JSON.stringify(r7))
    check('多余文件仍在可恢复备份中', !!r7.backupDir && existsSync(join(r7.backupDir, 'extras', 'player-added-mod.jar')))

    check('进度事件覆盖 downloading → applying → done', progressSeen.some((s) => s.startsWith('downloading')) && progressSeen.includes('applying:99') && progressSeen.includes('done:100'), progressSeen.join(' '))
    check('清单条目数组与文件数一致', manifest.length === 2)
  } catch (e) {
    check('自检未抛异常', false, e instanceof Error ? e.stack?.slice(0, 300) : String(e))
  } finally {
    try {
      server.close()
    } catch {
      /* ignore */
    }
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  const failed = assertions.filter((a) => !a.ok)
  for (const a of assertions) {
    console.log(`  ${a.ok ? '[PASS]' : '[FAIL]'} ${a.name}${a.detail && !a.ok ? `  ← ${a.detail}` : ''}`)
  }
  console.log(`[updatetest] ${assertions.length - failed.length}/${assertions.length} 通过`)
  return failed.length === 0 ? 0 : 1
}

/* ------------------------------------------------------------ 打真服务器清单 */

/**
 * 活链验证（`--updatelive <base>`）：清单来自**真服务器**，文件来自本地替身。
 *
 * 为什么这么切一刀：真要端到端跑完整整合包（316 MB / 79 个 jar），
 * 需要一个能公网访问的对象存储 —— 现在还没有。但"清单接口的形状对不对、
 * 启动器认不认这份清单"**现在就能验**，而那正是最容易出错的一半
 * （字段名、size 类型、留档有没有被编进去、下载地址拼得对不对）。
 *
 * 做法：拉真清单 → 逐条**替换成指向本地 mock 源的地址 + 本地生成的内容**
 * （sha256/size 按本地内容重算，其余字段原样保留）→ 走完整的下载→校验→原子替换。
 * 于是验到的是：真清单能过 `validateManifest`、条数与留档过滤正确、
 * 下载链在真实清单形状下能跑通。
 *
 * 测完把临时目录删掉，**绝不碰真实 mods/**。
 */
export async function runUpdateLiveCheck(base: string): Promise<number> {
  const assertions: { name: string; ok: boolean; detail?: string }[] = []
  const check = (name: string, ok: boolean, detail?: string): void => {
    assertions.push({ name, ok, detail })
  }

  const contents = new Map<string, Buffer>()
  let served = 0
  const server: Server = createServer((req, res) => {
    const m = /^\/f\/([0-9a-f]{32})$/.exec(req.url ?? '')
    const buf = m ? contents.get(m[1]) : undefined
    if (!buf) {
      res.writeHead(404).end('nope')
      return
    }
    served++
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) })
    res.end(buf)
  })

  const root = mkdtempSync(join(tmpdir(), 'delta-updatelive-'))
  const modsDir = join(root, 'mods')
  mkdirSync(modsDir, { recursive: true })

  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const local = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    console.log(`[updatelive] 清单元数据来自：${base}`)
    console.log(`[updatelive] 文件替身源：${local}`)
    console.log(`[updatelive] 临时 mods：${modsDir}`)

    const res = await fetch(`${base}/api/pack/manifest`)
    const text = await res.text()
    check(`真服务器清单接口 HTTP ${res.status}`, res.ok, text.slice(0, 200))
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (e) {
      check('清单是合法 JSON', false, String(e))
      throw new Error('清单不是 JSON，后面的检查无法进行')
    }
    const v = validateManifest(raw)
    check('真清单通过 validateManifest', v.ok, v.ok ? undefined : v.error)
    if (!v.ok) throw new Error(v.error)

    const m = v.manifest
    check(`清单有文件（count=${m.files.length}）`, m.files.length > 0)
    check(
      '清单里没有部署留档（.pre-* / .pending-*）',
      !m.files.some((f) => /\.(pre|pending|bak|old|orig)[-._]/i.test(f.name)),
      m.files.map((f) => f.name).join(',')
    )
    check(
      '清单里全是 .jar',
      m.files.every((f) => f.name.toLowerCase().endsWith('.jar')),
      m.files.map((f) => f.name).join(',')
    )
    check(
      '每条都带 size 与 64 位 sha256',
      m.files.every((f) => typeof f.size === 'number' && /^[0-9a-f]{64}$/i.test(f.sha256))
    )
    const withUrl = m.files.filter((f) => f.url)
    if (withUrl.length === 0) {
      console.log('  [注意] 服务端 DELTA_MODS_BASE_URL 为空：清单已下发但没有下载地址')
    } else {
      console.log(`  [信息] 服务端下载基地址示例：${withUrl[0].url}`)
    }

    // 把每条换成"本地内容 + 本地地址"，再走真实下载链
    const patched = {
      ...m,
      files: m.files.map((f) => {
        const body = Buffer.concat([Buffer.from(f.name), Buffer.alloc((f.size % 4096) + 512, 3)])
        const k = createHash('md5').update(body).digest('hex')
        contents.set(k, body)
        return {
          name: f.name,
          size: body.length,
          sha256: createHash('sha256').update(body).digest('hex'),
          url: `${local}/f/${k}`
        }
      })
    }

    const svc = new UpdateService(modsDir, join(root, 'staging'), join(root, 'backup'))
    const r1 = await svc.apply(patched)
    check(`按真清单形状完成更新（${r1.applied.length} 个文件）`, r1.ok, r1.failed)
    check('下载的文件数与清单一致', r1.applied.length === patched.files.length)
    // 请求数必须等于文件数：多一个就说明有重复下载（幂等性破了）
    check('每个文件恰好请求一次', served === patched.files.length, `served=${served}`)
    const again = await svc.diff(patched)
    check('更新后差量比对为"无差异"', again.missing.length === 0 && again.changed.length === 0, JSON.stringify(again))
  } catch (e) {
    check('活链验证未抛异常', false, e instanceof Error ? e.message : String(e))
  } finally {
    try {
      server.close()
    } catch {
      /* ignore */
    }
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  const failed = assertions.filter((a) => !a.ok)
  for (const a of assertions) {
    console.log(`  ${a.ok ? '[PASS]' : '[FAIL]'} ${a.name}${a.detail && !a.ok ? `  ← ${a.detail}` : ''}`)
  }
  console.log(`[updatelive] ${assertions.length - failed.length}/${assertions.length} 通过`)
  return failed.length === 0 ? 0 : 1
}
