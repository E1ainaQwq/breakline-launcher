import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PlayerApi, SessionStore, resolveApiBase } from './PlayerApi'

/**
 * 玩家系统客户端自检：**在真实 HTTP 上跑**，不起 Electron 窗口、不碰生产服务器。
 *
 * <h2>为什么不是"单元测试"</h2>
 * 这一块的失败模式几乎全在**链路上**：端点写错、字段名对不上、
 * 会话没落盘、401 之后本地还留着旧 token……这些用 mock 对象测不出来。
 * 所以这里起一个**真的 HTTP 服务**（`node:http`），把 `PlayerApi` 当成真客户端打进去。
 *
 * <h2>覆盖的状态（每条都是一个真实会发生的场景）</h2>
 * 1. 本地无凭据 → `none`（不误报"已登录"）
 * 2. 发验证码 → 建号/登录 → 拿到会话，且**落盘**
 * 3. 重启启动器（新建一个 PlayerApi 实例）后**仍然有效** → 会话确实持久化了
 * 4. 服务端说 `invalid_session` → 本地凭据**必须被清掉**（否则界面一直显示"已登录"）
 * 5. 被封禁 → `banned`（与"没登录"必须分开）
 * 6. 连不上（端口没人听）→ `unreachable`，**不等于已授权**
 * 7. 一次性 bind_token 的用法正确：/api/login 必须带 token，而不是再传一次验证码
 *
 * 用法：`DeltaLauncher.exe --playertest`（脚本见 `tools/playertest.sh`）。
 */

interface Assertion {
  name: string
  ok: boolean
  detail?: string
}

/** mock 服务端记录下来的请求，用来断言"客户端到底发了什么"。 */
interface Seen {
  path: string
  body: Record<string, unknown>
  launcherVersion?: string | string[]
}

export async function runPlayerApiSelfTest(): Promise<number> {
  const assertions: Assertion[] = []
  const seen: Seen[] = []
  const check = (name: string, ok: boolean, detail?: string): void => {
    assertions.push({ name, ok, detail })
  }

  // 会话状态由 mock 控制：不同场景换一个 token 即可
  let sessionState: 'ok' | 'invalid' | 'banned' = 'ok'
  const GOOD = 'sess-good'
  const BAD = 'sess-invalid'
  const BANNED = 'sess-banned'

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    try {
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  const json = (res: ServerResponse, code: number, obj: unknown): void => {
    const b = Buffer.from(JSON.stringify(obj), 'utf8')
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(b.length) })
    res.end(b)
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0]
      const body = req.method === 'POST' ? await readBody(req) : {}
      seen.push({ path, body, launcherVersion: req.headers['x-delta-launcher-version'] })
      const query = (req.url ?? '').includes('?') ? (req.url ?? '').split('?')[1] : ''
      const token = new URLSearchParams(query).get('session') ?? ''

      if (path === '/api/register') {
        const name = String(body['name'] ?? '')
        if (name === 'NoSuchPlayer') return json(res, 400, { ok: false, error: 'identity_not_found' })
        // `Email2` 专用：测"已登记过的邮箱"那条分支（服务端应报 email_in_use）
        if (String(body['email'] ?? '') === 't2@example.invalid') {
          return json(res, 409, { ok: false, error: 'email_in_use' })
        }
        // `BoundName` 专用：**角色已绑过邮箱、你拿了另一个邮箱**这条分支。
        // 它与上面那条**错误码相同、方向相反**，客户端必须靠 `code` 区分，
        // 并把服务端给的 bound_email 原样透出来（2026-09-17 运维照错误码查错了方向）。
        if (name === 'BoundName') {
          return json(res, 409, {
            ok: false,
            error: 'email_in_use',
            code: 'email_mismatch',
            bound_email: '27***@qq.com',
            message: '这个角色已经绑定过邮箱（27***@qq.com）。请用那个邮箱登录；确实要换邮箱请联系管理员。'
          })
        }
        return json(res, 200, { ok: true, accepted: true, ttl: 600 })
      }
      if (path === '/api/verify') {
        if (String(body['code'] ?? '') !== '123456') return json(res, 400, { ok: false, error: 'bad_code' })
        // 带了 password 就是"首次绑定顺手设密码"那条路（2026-09-18）：如实回 has_password，
        // 客户端据此知道"这个人以后可以用密码登"。
        return json(res, 200, {
          ok: true,
          bind_token: 'bind-1',
          uuid: 'uuid-1',
          name: 'Tester',
          has_password: typeof body['password'] === 'string' && body['password'] !== ''
        })
      }
      if (path === '/api/account/status') {
        const name = String(body['name'] ?? '')
        if (name === 'NoSuchPlayer') return json(res, 200, { ok: true, exists: false, has_password: false })
        if (name === 'NoPwPlayer') {
          return json(res, 200, { ok: true, exists: true, has_password: false, email_masked: 'te***@example.invalid' })
        }
        return json(res, 200, {
          ok: true,
          exists: true,
          has_password: true,
          email_masked: 'te***@example.invalid'
        })
      }
      if (path === '/api/login-password') {
        const name = String(body['name'] ?? '')
        const pw = String(body['password'] ?? '')
        if (name === 'LockedPlayer') {
          return json(res, 429, {
            ok: false,
            error: 'too_many_attempts',
            retry_after: 120,
            message: '密码错误次数过多，请 120 秒后再试'
          })
        }
        if (pw !== 'goodpass1') return json(res, 401, { ok: false, error: 'bad_password' })
        return json(res, 200, {
          ok: true,
          session: GOOD,
          expires_in: 604800,
          user: { uuid: 'uuid-1', name: 'Tester', site: 'littleskin' },
          risk: { accounts_on_this_hwid: 1 }
        })
      }
      if (path === '/api/login') {
        if (String(body['token'] ?? '') !== 'bind-1') return json(res, 401, { ok: false, error: 'invalid_token' })
        return json(res, 200, {
          ok: true,
          session: GOOD,
          expires_in: 604800,
          user: { uuid: 'uuid-1', name: 'Tester', site: 'littleskin' },
          risk: { accounts_on_this_hwid: 1 }
        })
      }
      if (path === '/api/me') {
        if (token === BAD || sessionState === 'invalid') return json(res, 401, { ok: false, error: 'invalid_session' })
        const user = {
          uuid: 'uuid-1',
          name: 'Tester',
          site: 'littleskin',
          email: 't@example.invalid',
          status: token === BANNED || sessionState === 'banned' ? 'banned' : 'active',
          ban_until: null
        }
        return json(res, 200, { ok: true, user })
      }
      if (path === '/api/launch/token') {
        if (body['session'] !== GOOD || sessionState === 'invalid') return json(res, 401, { ok: false, error: 'invalid_session' })
        if (body['expectedPlayerName'] !== 'Tester') {
          return json(res, 409, { ok: false, error: 'identity_mismatch' })
        }
        return json(res, 200, {
          ok: true,
          token: `Tester|9999999999|${'a'.repeat(64)}`,
          ttlSeconds: 300
        })
      }
      return json(res, 404, { ok: false, error: 'not_found' })
    })()
  })

  const dir = mkdtempSync(join(tmpdir(), 'delta-playertest-'))
  const storePath = join(dir, 'player-session.json')
  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`
    console.log(`[playertest] mock 玩家系统：${base}`)
    console.log(`[playertest] 会话文件：${storePath}`)

    // ---- 1) 本地无凭据 ----
    const api1 = new PlayerApi(new SessionStore(storePath), base)
    check('无凭据时 status() = none', (await api1.status()).state === 'none')

    // ---- 2) 发验证码 / 登录 ----
    const code = await api1.sendCode('Tester', 'T@Example.invalid')
    check('sendCode 成功', code.ok === true, JSON.stringify(code))
    check(
      '邮箱被规范化成小写后再上报',
      String(seen.find((s) => s.path === '/api/register')?.body['email']) === 't@example.invalid'
    )
    check(
      '默认身份来源是 littleskin',
      String(seen.find((s) => s.path === '/api/register')?.body['site']) === 'littleskin'
    )
    // 登录方式选择器（2026-09-17 新增）：选"正版登录"时 `site` 必须真的传下去，
    // 否则界面切了、服务端还是按皮肤站查 —— 那就成了一个纯装饰的下拉框。
    const codePrem = await api1.sendCode('Tester', 't@example.invalid', 'premium')
    check('正版登录：site=premium 已上报', codePrem.ok === true, JSON.stringify(codePrem))
    check(
      '正版登录确实改变了请求体里的 site',
      seen.filter((s) => s.path === '/api/register').at(-1)?.body['site'] === 'premium'
    )
    const notFound = await api1.sendCode('NoSuchPlayer', 'x@example.invalid')
    check(
      '角色名不存在 → 中文说明指向"角色名"而不是网络',
      notFound.ok === false && (notFound.message ?? '').includes('找不到这个角色名'),
      notFound.message
    )
    // ---- 同码不同因：`email_in_use` 两个方向必须能分开 ----
    //
    // 这两条是 2026-09-17 那次排障的直接产物：运维拿新邮箱登已注册角色，
    // 界面说"这个邮箱已经绑过别的角色了"（方向反了），于是他照着查邮箱。
    // 判据：靠服务端的 `code` 区分，并把 `bound_email` 透给界面。
    const wrongMail = await api1.sendCode('BoundName', 'someone@example.invalid')
    check('角色已绑别的邮箱 → 失败', wrongMail.ok === false)
    check('且 code = email_mismatch（不是笼统的 email_in_use）', wrongMail.code === 'email_mismatch', JSON.stringify(wrongMail))
    check('且透出已绑邮箱（打码）', wrongMail.boundEmail === '27***@qq.com', String(wrongMail.boundEmail))
    check(
      '文案指向"该用哪个邮箱"，而不是说邮箱被占用',
      (wrongMail.message ?? '').includes('27***@qq.com') && !(wrongMail.message ?? '').includes('这个邮箱已经绑过别的角色'),
      wrongMail.message
    )
    const takenMail = await api1.sendCode('Tester', 't2@example.invalid')
    check('邮箱被别的角色占用 → 报 email_in_use', takenMail.ok === false && takenMail.error === 'email_in_use')
    check(
      '这两种情况的文案**不一样**（否则界面还是分不清）',
      takenMail.message !== wrongMail.message,
      `${takenMail.message} || ${wrongMail.message}`
    )
    const badCode = await api1.login('t@example.invalid', '000000')
    check('验证码错误 → 不建会话', badCode.ok === false && (await api1.status()).state === 'none')
    const ok = await api1.login('t@example.invalid', '123456')
    check('验证码正确 → 登录成功', ok.ok === true && ok.player?.name === 'Tester', JSON.stringify(ok))
    const loginReq = seen.find((s) => s.path === '/api/login')
    check(
      '/api/login 用的是 bind_token（不是再传一次验证码）',
      String(loginReq?.body['token'] ?? '') === 'bind-1' && loginReq?.body['code'] === undefined
    )
    check(
      'hwid 已上报且不是明文主机名',
      typeof loginReq?.body['hwid'] === 'string' && (loginReq?.body['hwid'] as string).length === 32
    )

    // ---- 3) 重启后仍然有效（会话确实落盘）----
    const api2 = new PlayerApi(new SessionStore(storePath), base, '0.3.23')
    check('重新构造 PlayerApi 后本地仍有凭据', api2.cached()?.player.name === 'Tester')
    check('重启后 status() = ok', (await api2.status()).state === 'ok')
    const proof = await api2.launcherToken('Tester')
    check('来源令牌按当前会话玩家签发', proof.ok && proof.token.startsWith('Tester|'), JSON.stringify(proof))
    const wrongProof = await api2.launcherToken('OtherPlayer')
    check('不能用自己的会话替另一个玩家签发令牌', !wrongProof.ok && wrongProof.error.includes('identity_mismatch'))
    const proofReq = seen.filter((s) => s.path === '/api/launch/token').at(-2)
    check('签发请求同时绑定会话与最终游戏名',
      proofReq?.body['session'] === GOOD && proofReq?.body['expectedPlayerName'] === 'Tester',
      JSON.stringify(proofReq?.body))
    check('签发请求带启动器版本供旧版升级提示判定', proofReq?.launcherVersion === '0.3.23')

    // ---- 2b) 密码登录（2026-09-18 运维要求）----
    //  ① 首次绑定：验证码那一步**带上密码**（服务端据此存下密码）
    //  ② 之后登录：只要密码，一步换会话
    //  这两条是"以后不用每次收验证码"的全部实现，所以必须钉在自测里。
    const withPw = await api1.login('t@example.invalid', '123456', 'goodpass1')
    const verifyReq = seen.filter((s) => s.path === '/api/verify').at(-1)
    check('首次绑定时把密码一起提交（服务端据此存密码）',
      verifyReq?.body['password'] === 'goodpass1', JSON.stringify(verifyReq?.body))
    check('带着密码也能正常登录', withPw.ok === true, JSON.stringify(withPw))
    // 不传密码时**不能**出现该字段：空字符串会让服务端把"没设密码"和"设了个空密码"混起来
    const noPw = await api1.login('t@example.invalid', '123456')
    check('不设密码时不带 password 字段（老流程一个字都没变）',
      noPw.ok === true && seen.filter((s) => s.path === '/api/verify').at(-1)?.body['password'] === undefined)

    const st1 = await api1.accountStatus('SomePlayer')
    check('accountStatus：有密码的账号回 has_password=true',
      st1.ok && st1.exists && st1.hasPassword === true, JSON.stringify(st1))
    check('accountStatus：邮箱是打码的（不回完整地址）',
      typeof st1.emailMasked === 'string' && st1.emailMasked.includes('***'), String(st1.emailMasked))
    const st2 = await api1.accountStatus('NoSuchPlayer')
    check('accountStatus：没登记过 ⇒ exists=false', st2.ok && st2.exists === false, JSON.stringify(st2))
    const st3 = await api1.accountStatus('NoPwPlayer')
    check('accountStatus：登记过但没密码 ⇒ hasPassword=false（界面据此走邮箱流程）',
      st3.ok && st3.exists && st3.hasPassword === false, JSON.stringify(st3))
    const statusReq = seen.filter((s) => s.path === '/api/account/status').at(-1)
    check('accountStatus 只发角色名与身份来源（不发邮箱，也不发密码）',
      statusReq?.body['name'] === 'NoPwPlayer' && statusReq?.body['email'] === undefined
        && statusReq?.body['password'] === undefined, JSON.stringify(statusReq?.body))

    // 记下调用次数再比：这套自测前面**故意**试了好几次发码（身份不存在 / 邮箱被占 / 绑错邮箱），
    // 所以绝对次数没有意义 —— 有意义的是"密码登录这一步没有新增发码"。
    const registersBefore = seen.filter((s) => s.path === '/api/register').length
    const pwOk = await api1.loginWithPassword('Tester', 'goodpass1')
    check('纯密码登录成功', pwOk.ok === true && pwOk.player?.name === 'Tester', JSON.stringify(pwOk))
    const pwReq = seen.filter((s) => s.path === '/api/login-password').at(-1)
    check('纯密码登录带上了 hwid（否则这条路上的风控会瞎）',
      typeof pwReq?.body['hwid'] === 'string' && (pwReq?.body['hwid'] as string).length === 32,
      JSON.stringify(pwReq?.body))
    check('纯密码登录不再发验证码（这一步不该新增 /api/register）',
      seen.filter((s) => s.path === '/api/register').length === registersBefore,
      `${registersBefore} → ${seen.filter((s) => s.path === '/api/register').length}`)
    check('密码登录后本地会话已落盘', api1.cached()?.player.name === 'Tester')

    const pwBad = await api1.loginWithPassword('Tester', 'wrong-pass')
    check('密码错 ⇒ 不登录，且文案来自服务端优先',
      pwBad.ok === false && !!pwBad.message, JSON.stringify(pwBad))
    const pwLocked = await api1.loginWithPassword('LockedPlayer', 'goodpass1')
    check('被锁定时如实透出 retry_after（界面要能说"多久后再试"）',
      pwLocked.ok === false && pwLocked.error === 'too_many_attempts' && pwLocked.retryAfter === 120,
      JSON.stringify(pwLocked))

    // Session can expire between /me and issuance; rejection must clear stale UI/cache without bypassing admission.
    const expiredApi = new PlayerApi(new SessionStore(storePath), base, '0.3.28')
    sessionState = 'invalid'
    const expiredProof = await expiredApi.launcherToken('Tester')
    check('签发时会话失效 → 明确提示重新登录', !expiredProof.ok && expiredProof.error.includes('重新登录'))
    check('签发时会话失效 → 清除内存和磁盘旧会话', expiredApi.cached() === null && new SessionStore(storePath).load() === null)
    check('失效后再次启动不会重复使用旧凭据签发', !(await expiredApi.launcherToken('Tester')).ok)
    sessionState = 'ok'
    await api2.loginWithPassword('Tester', 'goodpass1')
    // ---- 4) 服务端说失效 → 本地凭据必须被清掉 ----
    sessionState = 'invalid'
    const st4 = await api2.status()
    check('服务端 401 → state=none', st4.state === 'none')
    check('服务端 401 → 本地凭据被清除', api2.cached() === null)
    check(
      '清除后重新构造实例也读不到旧凭据',
      new PlayerApi(new SessionStore(storePath), base).cached() === null
    )
    sessionState = 'ok'

    // ---- 5) 封禁与"没登录"必须分开 ----
    const api3 = new PlayerApi(new SessionStore(storePath), base)
    await api3.login('t@example.invalid', '123456')
    const store = new SessionStore(storePath)
    const cur = store.load()
    if (cur) store.save({ ...cur, token: BANNED })
    const api4 = new PlayerApi(store, base)
    const st5 = await api4.status()
    check('被封禁 → state=banned（不是 none）', st5.state === 'banned', JSON.stringify(st5))

    // ---- 6) 连不上 ≠ 已授权 ----
    // 指向一个**已经关掉的**端口：这是"服务器挂了/网断了"的真实形状
    await new Promise<void>((r) => server.close(() => r()))
    const api5 = new PlayerApi(new SessionStore(storePath), base)
    const st6 = await api5.status()
    check('连不上 → state=unreachable（不得当成已登录）', st6.state === 'unreachable', JSON.stringify(st6))
    check('连不上时本地凭据**保留**（网络恢复后还能用）', api5.cached() !== null)

    // ---- 7) 超时保护 ----
    check('hwid 稳定（同一台机器两次一致）', api5.hwid() === api5.hwid())
  } catch (e) {
    check('自检未抛异常', false, e instanceof Error ? e.message : String(e))
  } finally {
    try {
      server.close()
    } catch {
      /* ignore */
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  const failed = assertions.filter((a) => !a.ok)
  for (const a of assertions) {
    console.log(`  ${a.ok ? '[PASS]' : '[FAIL]'} ${a.name}${a.detail && !a.ok ? `  ← ${a.detail}` : ''}`)
  }
  console.log(`[playertest] ${assertions.length - failed.length}/${assertions.length} 通过`)
  return failed.length === 0 ? 0 : 1
}

/* ------------------------------------------------------------------ 真实链路登录 */

/** 读验证码：优先 argv，其次环境变量，最后 stdin。 */
async function readCode(): Promise<string> {
  const i = process.argv.indexOf('--code')
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined
  if (fromArgv && !fromArgv.startsWith('--')) return fromArgv.trim()
  const fromEnv = process.env['DELTA_LOGIN_CODE']
  if (fromEnv) return fromEnv.trim()
  if (process.stdin.isTTY) {
    console.log('[playerlogin] 请输入邮件里的 6 位验证码后回车：')
    process.stdin.resume()
    return await new Promise<string>((resolve) => {
      process.stdin.once('data', (d) => resolve(String(d).trim()))
    })
  }
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

/**
 * 打**真实玩家系统**走一遍"发验证码 → 填码 → 登录"。
 *
 * 为什么要有它：mock 只证明"客户端按协议说话了"，证明不了"对面那台服务器
 * 真的按这个协议回话"。这两件事在 2026-09-17 各错过一次（服务端崩溃、
 * 已注册玩家撞 UNIQUE），只测一头都会漏。
 *
 * 用法：
 * ```
 * echo 123456 | DeltaLauncher.exe --playerlogin you@example.com \
 *     --session-out C:/tmp/test-session.json
 * ```
 * 验证码从服务端库里取（`server/peek-code.sh`），所以无需真的收到邮件。
 * ⚠️ `/api/register` 有 8 次/小时的 IP 限流——反复试会把自己限住，这是**刻意**的。
 */
export async function runRealLogin(
  email: string,
  name: string,
  sessionOut: string,
  skipSend = false
): Promise<number> {
  const code = await readCode()
  if (!code) {
    console.log('[playerlogin] 没有拿到验证码（argv --code / 环境变量 DELTA_LOGIN_CODE / stdin 都为空）')
    return 2
  }
  const store = new SessionStore(sessionOut)
  const api = new PlayerApi(store, resolveApiBase())
  console.log(`[playerlogin] 目标：${api.base}`)
  console.log(`[playerlogin] 角色名 ${name} / 邮箱 ${email}`)

  // `--skip-send`：不发新码，直接用已有的那一枚。
  //
  // 为什么需要：服务端有"同邮箱 60 秒冷却"（**这是刻意的防刷**）。
  // 而"取码"这条链本身要先调一次 sendCode，于是紧接着的第二次调用必然撞冷却，
  // 看起来像"发码坏了"。验收时应该复用刚取到的那一枚，而不是反复触发限流。
  if (skipSend) {
    console.log('[playerlogin] 跳过 sendCode（--skip-send）：直接用已有验证码')
  } else {
    const sent = await api.sendCode(name, email)
    console.log(
      `[playerlogin] sendCode → ok=${sent.ok} accepted=${sent.accepted} ttl=${sent.ttl} ` +
        `registered=${sent.registered ?? '-'} ${sent.message ?? ''}`
    )
    if (!sent.ok) return 3
  }

  const r = await api.login(email, code)
  if (!r.ok) {
    console.log(`[playerlogin] login 失败：${r.message ?? r.error}`)
    return 4
  }
  console.log(`[playerlogin] login 成功：${r.player?.name} (${r.player?.uuid})`)
  const st = await api.status()
  console.log(`[playerlogin] status → ${st.state}`)
  const cur = store.load()
  if (cur) {
    const copy = sessionOut.replace(/\.json$/, '.copy.json')
    writeFileSync(copy, JSON.stringify(cur, null, 2), 'utf8')
  }
  console.log(`[playerlogin] 会话文件：${sessionOut}`)
  return st.state === 'ok' ? 0 : 5
}
