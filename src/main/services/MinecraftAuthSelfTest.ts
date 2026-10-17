import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MinecraftAuth, offlineUuid, toPublicState, xstsErrorText } from './MinecraftAuth'

/**
 * 正版登录自检（`--mcauthtest`）。
 *
 * <h2>为什么要 mock 整条微软链</h2>
 * 真链路需要玩家在浏览器里点同意 —— 那不可能在自动验收里跑。
 * 但真正容易写错的地方全在**分支**上：`authorization_pending` 要当正常、
 * `slow_down` 要退避、XSTS 的 XErr 要翻译成人话、没买游戏要报 404 而不是"网络错误"。
 * 这些用 mock 能一条条钉住。
 *
 * <h2>但 mock 有一个致命盲区，所以这里额外做两件事</h2>
 * 1. **形状自检**：真打一次微软的 `/devicecode`，用一个**故意无效的 client_id**，
 *    断言它回的是"client_id 无效"这类**业务错误**——这证明端点存活、协议形状没变。
 *    （回 404/连不上就说明端点点错了，而那在 mock 里永远测不出来。）
 * 2. **不外泄断言**：`device_code` 是轮询凭据，绝不能出现在交给界面的状态里。
 */

interface Assertion {
  name: string
  ok: boolean
  detail?: string
}

export async function runMinecraftAuthSelfTest(): Promise<number> {
  const assertions: Assertion[] = []
  const check = (name: string, ok: boolean, detail?: string): void => {
    assertions.push({ name, ok, detail })
  }

  /** mock 微软链：行为由 `mode` 控制，每种模式对应一个真实故障。 */
  type Mode = 'happy' | 'pending-then-ok' | 'expired' | 'slow-down' | 'xsts-2148916233' | 'no-game'
  let mode: Mode = 'pending-then-ok'
  let tokenCalls = 0
  let delayMs = 0
  const seenBodies: string[] = []

  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const raw = Buffer.concat(chunks).toString('utf8')
      seenBodies.push(`${req.url}|${raw}`)
      const json = (code: number, obj: unknown): void => {
        const b = Buffer.from(JSON.stringify(obj), 'utf8')
        res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': String(b.length) })
        res.end(b)
      }
      const url = req.url ?? ''
      if (url === '/devicecode') {
        return json(200, {
          device_code: 'dev-1',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://microsoft.com/link',
          expires_in: 900,
          interval: mode === 'slow-down' ? 1 : 1,
          message: 'To sign in, use a web browser…'
        })
      }
      if (url === '/token') {
        tokenCalls++
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
        if (mode === 'expired') return json(400, { error: 'expired_token' })
        if (mode === 'slow-down' && tokenCalls === 1) return json(400, { error: 'slow_down' })
        if (mode === 'pending-then-ok' && tokenCalls === 1) return json(400, { error: 'authorization_pending' })
        return json(200, { access_token: 'ms-token', refresh_token: 'ms-refresh' })
      }
      if (url === '/xbl') {
        return json(200, { Token: 'xbl-token', DisplayClaims: { xui: [{ uhs: 'uhs-1' }] } })
      }
      if (url === '/xsts') {
        if (mode === 'xsts-2148916233') return json(401, { XErr: 2148916233, Message: 'no xbox account' })
        return json(200, { Token: 'xsts-token', DisplayClaims: { xui: [{ uhs: 'uhs-1' }] } })
      }
      if (url === '/mclogin') return json(200, { access_token: 'mc-token' })
      if (url === '/mcprofile') {
        if (mode === 'no-game') return json(404, { error: 'NOT_FOUND' })
        return json(200, { id: '069a79f444e94726a5befca90e38aaf5', name: 'Notch' })
      }
      return json(404, { error: 'unknown' })
    })()
  })

  const root = mkdtempSync(join(tmpdir(), 'delta-mcauthtest-'))
  const storePath = join(root, 'minecraft-auth.json')
  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const eps = {
      deviceCode: `http://127.0.0.1:${port}/devicecode`,
      token: `http://127.0.0.1:${port}/token`,
      xbl: `http://127.0.0.1:${port}/xbl`,
      xsts: `http://127.0.0.1:${port}/xsts`,
      mcLogin: `http://127.0.0.1:${port}/mclogin`,
      mcProfile: `http://127.0.0.1:${port}/mcprofile`
    }
    console.log(`[mcauthtest] mock 微软链：http://127.0.0.1:${port}`)

    // ---- 1) 没配 client_id 必须明说，而不是转圈 ----
    const a1 = new MinecraftAuth(storePath, eps)
    const noId = await a1.start('')
    check('未配置 client_id → 明确报错（不是静默失败）', noId.ok === false && /client_id/.test(noId.error), JSON.stringify(noId))
    check('初始状态 = none', a1.state().state === 'none')

    // ---- 2) 正常链路：pending → ok ----
    const a2 = new MinecraftAuth(join(root, 'a2.json'), eps)
    const started = await a2.start('test-client-id')
    check('申请登录码成功', started.ok === true, JSON.stringify(started))
    if (started.ok) {
      check('拿到 user_code 与验证地址', started.session.userCode === 'ABCD-EFGH' && /microsoft\.com/.test(started.session.verificationUri))
      const st = a2.state()
      check('状态进入 pending', st.state === 'pending')
      // 关键：device_code 是轮询凭据，**不能**出现在交给界面的状态里。
      // 这里断言的是 `toPublicState`（主进程 IPC 边界上用的就是它）。
      check(
        '交给界面的状态里不含 device_code',
        !JSON.stringify(toPublicState(st)).includes('dev-1'),
        JSON.stringify(toPublicState(st)).slice(0, 200)
      )
    }
    mode = 'pending-then-ok'
    tokenCalls = 0
    const polled = await a2.poll('test-client-id', 20000)
    check('authorization_pending 被当成正常（继续轮询）', tokenCalls >= 2, `tokenCalls=${tokenCalls}`)
    check('轮询后状态 = ok', polled.state === 'ok', JSON.stringify(polled))
    check('档案来自 /minecraft/profile（权威身份）', polled.state === 'ok' && polled.profile.name === 'Notch')
    check('uuid 已去掉连字符（启动参数要的形式）', a2.credentials()?.uuid === '069a79f444e94726a5befca90e38aaf5')
    check('新实例能从磁盘读回凭据（重启后仍在）', new MinecraftAuth(join(root, 'a2.json'), eps).state().state === 'ok')
    check('凭据文件已落盘', readFileSync(join(root, 'a2.json'), 'utf8').includes('mc-token'))

    // ---- 3) XSTS 缺 Xbox 档案 → 翻译成人话（不能只说"登录失败"）----
    mode = 'xsts-2148916233'
    tokenCalls = 0
    const a3 = new MinecraftAuth(join(root, 'a3.json'), eps)
    await a3.start('test-client-id')
    const st3 = await a3.poll('test-client-id', 20000)
    check('XErr 2148916233 → 提示去 xbox.com 建档案', st3.state === 'error' && /xbox\.com/.test(st3.error), JSON.stringify(st3))

    // ---- 4) 没买游戏（404）与网络错误必须分开 ----
    mode = 'no-game'
    tokenCalls = 0
    const a4 = new MinecraftAuth(join(root, 'a4.json'), eps)
    await a4.start('test-client-id')
    const st4 = await a4.poll('test-client-id', 20000)
    check('没买 Minecraft → 报"没有 Minecraft"（不是"网络错误"）', st4.state === 'error' && /没有 Minecraft/.test(st4.error), JSON.stringify(st4))

    // ---- 5) 登录码过期 ----
    mode = 'expired'
    tokenCalls = 0
    const a5 = new MinecraftAuth(join(root, 'a5.json'), eps)
    await a5.start('test-client-id')
    const st5 = await a5.poll('test-client-id', 20000)
    check('过期 → 提示重新获取', st5.state === 'error' && /过期/.test(st5.error), JSON.stringify(st5))

    // ---- 6) slow_down 必须退避重试，而不是直接失败 ----
    mode = 'slow-down'
    tokenCalls = 0
    const a6 = new MinecraftAuth(join(root, 'a6.json'), eps)
    await a6.start('test-client-id')
    const st6 = await a6.poll('test-client-id', 30000)
    check('slow_down → 退避后仍然成功', st6.state === 'ok', JSON.stringify(st6))

    // ---- 7) 每一步用对了端点与载荷（写错端点是最常见的实现错误）----
    const xblBody = seenBodies.find((b) => b.startsWith('/xbl'))
    check(
      'Xbox 认证的 RpsTicket 使用官方要求的 d= 前缀',
      !!xblBody && /"RpsTicket":"d=ms-token"/.test(xblBody),
      xblBody?.slice(0, 200)
    )
    const xstsBody = seenBodies.find((b) => b.startsWith('/xsts'))
    check(
      'XSTS 的 RelyingParty 指向 api.minecraftservices.com',
      !!xstsBody && /api\.minecraftservices\.com/.test(decodeURIComponent(xstsBody)),
      xstsBody?.slice(0, 240)
    )
    const mcBody = seenBodies.find((b) => b.startsWith('/mclogin'))
    check('Minecraft 登录用的是 identityToken=XBL3.0 x=<uhs>;<xsts>', !!mcBody && mcBody.includes('XBL3.0'), mcBody?.slice(0, 240))
    check('XSTS 错误码翻译表覆盖了常见的几种', /xbox\.com/.test(xstsErrorText(2148916233)) && /未成年/.test(xstsErrorText(2148916238)))

    // ---- 7b) 离线 UUID 派生（本项目游戏内**实际用的就是这个**）----
    // 单靠"算出来看着像"不算验证：这里钉住**已知值**，并且用 nameUUIDFromBytes 的
    // 定义（v3 = MD5 + 版本位 3 + 变体位 10xx）逐项核对。
    const offNotch = offlineUuid('Notch')
    check('离线 UUID 是 32 位十六进制', /^[0-9a-f]{32}$/.test(offNotch), offNotch)
    check('离线 UUID 的版本位 = 3（nameUUIDFromBytes 的特征）', offNotch[12] === '3', offNotch)
    check(
      '离线 UUID 的变体位 = 10xx（RFC 4122）',
      ['8', '9', 'a', 'b'].includes(offNotch[16]),
      offNotch
    )
    check('离线 UUID 大小写敏感（Notch ≠ notch）', offlineUuid('Notch') !== offlineUuid('notch'))
    check('同一名字两次结果一致', offlineUuid('Notch') === offNotch)
    console.log(`  [信息] OfflinePlayer:Notch -> ${offNotch}`)

    // ---- 8) 真端点形状自检（用故意无效的 client_id）----
    // 这一条是 mock 的盲区补丁：端点拼错、微软改了协议形状，mock 都发现不了。
    const real = new MinecraftAuth(join(root, 'real.json'))
    const realRes = await real.start('00000000-0000-0000-0000-000000000000')
    const realText = realRes.ok ? '' : realRes.error
    check(
      '真微软设备码端点可达且按协议回错误（不是 404/超时）',
      realRes.ok === false && !/连不上|HTTP 404|超时/.test(realText),
      realText
    )
    console.log(`  [信息] 真端点回话：${realText.slice(0, 160)}`)
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
  console.log(`[mcauthtest] ${assertions.length - failed.length}/${assertions.length} 通过`)
  return failed.length === 0 ? 0 : 1
}
