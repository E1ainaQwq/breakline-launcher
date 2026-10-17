import {existsSync,readFileSync,writeFileSync,mkdirSync,readdirSync,chmodSync,unlinkSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {hostname,userInfo} from 'node:os'
import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline/promises'
import {UpdateService,validateManifest} from '../src/main/services/UpdateService'
import {PlayerApi,SessionStore} from '../src/main/services/PlayerApi'
import {YggdrasilAuth} from '../src/main/services/YggdrasilAuth'
import {LaunchLease} from '../src/main/services/LaunchLease'
import {buildLaunchArgs,versionJarIgnoreList} from '../src/main/services/LaunchArgs'
import {existingRuntime,verifyResourcePack} from './runtime'

// Linux frontend; pack checks, account admission and launch lease reuse production services.
const version='0.3.27',api='http://111.230.147.241:8787'
const [command,rootArg,...extra]=process.argv.slice(2)
const usage='用法：node breakline-linux.cjs login|update|check|launch|logout 已有.minecraft目录 [版本名]\n仅更新已有客户端；默认版本：BREAKLine OPs Beta。需要 Node.js 22+、Linux x64、Java 17 JDK。'
async function consent(state:string){
  const path=join(state,'consent.json')
  try{const cached=JSON.parse(readFileSync(path,'utf8'));if(cached.accepted===true&&cached.termsVersion==='2026-09-17.1'&&cached.launcherVersion?.split('.')[0]===version.split('.')[0])return}catch{}
  console.log('MUGEN AC 客户端条款 2026-09-17.1\n进入本服务器需要安装反作弊模组。可能采集：进程列表、驱动清单、游戏模块清单、JVM 参数、模组文件名与哈希；随机截图和设备标识默认关闭，仅取证时启用。Linux 版不提供 Windows 原生检测。不同意则不启动游戏；可随时卸载。条款变化或大版本更新后需重新同意。')
  if((await ask('同意并继续？输入 yes：')).toLowerCase()!=='yes')throw Error('未同意条款，已拒绝启动。')
  writeFileSync(path,JSON.stringify({accepted:true,termsVersion:'2026-09-17.1',launcherVersion:version,acceptedAt:Date.now()}))
}
async function ask(label:string,hidden=false):Promise<string>{
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('登录需要交互终端；请勿把密码写入命令或文件。')
  if(!hidden){const rl=createInterface({input:process.stdin,output:process.stdout});try{return (await rl.question(label)).trim()}finally{rl.close()}}
  process.stdout.write(label);process.stdin.setRawMode(true);process.stdin.resume()
  return new Promise((resolve,reject)=>{
    let value=''
    const done=(error?:Error)=>{process.stdin.removeListener('data',input);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');error?reject(error):resolve(value)}
    const input=(data:Buffer)=>{for(const c of data.toString('utf8')){if(c==='\u0003'||c==='\u0004'){done(Error('登录已取消'));return}if(c==='\r'||c==='\n'){done();return}if(c==='\u007f'||c==='\b')value=value.slice(0,-1);else if(c>=' ')value+=c}}
    process.stdin.on('data',input)
  })
}
async function main(){
  if(!rootArg||!['login','update','check','launch','logout'].includes(command)||extra.length>1){console.log(usage);process.exitCode=rootArg?1:0;return}
  if(process.platform!=='linux'||process.arch!=='x64')throw Error('此预览版支持 Linux x64。')
  if(Number(process.versions.node.split('.')[0])<22)throw Error('请安装 Node.js 22 或更新版本。')
  process.umask(0o077)
  const root=resolve(rootArg),profile=extra[0]??'BREAKLine OPs Beta'
  if(!profile||profile==='.'||profile==='..'||/[\\/]/.test(profile))throw Error('版本名无效')
  const game=join(root,'versions',profile),state=join(root,'.breakline-launcher')
  if(!existsSync(join(game,'mods'))||!readdirSync(join(game,'mods')).some(n=>n.endsWith('.jar')))throw Error('请选择已有正式客户端的 .minecraft 根目录。本启动器不下载整包。')
  mkdirSync(state,{recursive:true,mode:0o700});chmodSync(state,0o700)
  // Production HWID is a weak user/host signal; adapt its inputs without collecting hardware IDs.
  process.env.USERNAME=userInfo().username;process.env.COMPUTERNAME=hostname()
  const player=new PlayerApi(new SessionStore(join(state,'player-session.json')),api,version)
  const auth=new YggdrasilAuth(join(state,'auth.json'))
  if(command==='logout'){auth.logout();if(existsSync(join(state,'player-session.json')))unlinkSync(join(state,'player-session.json'));console.log('已清除本机登录缓存。');return}
  if(command==='login'){
    const name=await ask('BREAKLine 角色名：'),password=await ask('BREAKLine 账号密码（不显示）：',true)
    const account=await player.loginWithPassword(name,password)
    if(!account.ok)throw Error(account.message??'账号登录失败')
    const email=await ask('LittleSkin 登录邮箱：'),skinPassword=await ask('LittleSkin 密码（不显示）：',true)
    const skin=await auth.login(email,skinPassword)
    if(!skin.ok||!skin.session)throw Error(skin.error??'LittleSkin 登录失败')
    if(skin.session.username!==account.player?.name||skin.session.uuid.replace(/-/g,'')!==account.player?.uuid.replace(/-/g,'')){auth.logout();throw Error('LittleSkin 当前角色与服务器账号不一致，请在皮肤站选择正确角色后重试。')}
    console.log('登录成功。首次注册和邮箱验证请先在正式启动器完成。');return
  }
  const response=await fetch(api+'/api/pack/manifest',{headers:{'X-Delta-Launcher-Version':version},signal:AbortSignal.timeout(15000)})
  if(!response.ok)throw Error('更新清单不可用：HTTP '+response.status)
  const parsed=validateManifest(await response.json());if(!parsed.ok)throw Error(parsed.error)
  const manifest=parsed.manifest;let last=-1
  const updater=new UpdateService(join(game,'mods'),join(state,'staging'),join(state,'backup'),p=>{
    if(p.percent!==last){last=p.percent;console.log(JSON.stringify({phase:p.phase,percent:p.percent,files:p.doneFiles,total:p.totalFiles}))}
  })
  const before=updater.diff(manifest)
  console.log(JSON.stringify({packVersion:manifest.packVersion,ok:before.ok,total:before.total,missing:before.missing.length,changed:before.changed.length,extra:before.extra.length}))
  if(command==='update'){
    const result=await updater.apply(manifest);if(!result.ok)throw Error(result.failed)
    const after=updater.diff(manifest)
    const evidence={packVersion:manifest.packVersion,before:{ok:before.ok,missing:before.missing.length,changed:before.changed.length,extra:before.extra.length},after:{ok:after.ok,total:after.total,missing:after.missing.length,changed:after.changed.length,extra:after.extra.length},applied:result.applied,quarantined:result.quarantined}
    writeFileSync(join(state,'update-result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));return
  }
  if(before.ok!==manifest.files.length||before.missing.length||before.changed.length||before.extra.length)throw Error('客户端需要更新；请先执行 update。')
  await verifyResourcePack(game,api)
  if(command==='check'){console.log('模组和必要资源包校验通过。');return}
  await consent(state)
  const status=await player.status();if(status.state!=='ok')throw Error('账号不可用，请重新 login：'+status.state)
  console.log('服务器账号核验通过。')
  const identity=await auth.ensureFresh();if(!identity)throw Error('LittleSkin 登录已过期，请重新 login。')
  if(identity.username!==status.player.name||identity.uuid.replace(/-/g,'')!==status.player.uuid.replace(/-/g,''))throw Error('服务器账号与 LittleSkin 角色不一致，请重新 login。')
  console.log('LittleSkin 角色核验通过；正在校验 Linux 运行库。')
  const config=await existingRuntime(root,profile,state,identity,version)
  const initial=await player.launcherToken(identity.username);if(!initial.ok)throw Error(initial.error)
  const secrets=new Set([identity.accessToken,initial.token])
  const lease=await LaunchLease.start(initial,async()=>{const result=await player.launcherToken(identity.username);if(result.ok)secrets.add(result.token);return result});secrets.add(lease.key)
  try{
    const args=buildLaunchArgs(versionJarIgnoreList(config.jvmArgs,profile),config.programArgs,{memoryMb:3072,width:null,height:null,fullscreen:false,launcherToken:lease.initialToken,leaseUrl:lease.url,leaseKey:lease.key})
    console.log(JSON.stringify({authorization:'granted',platform:process.platform,launcherVersion:version,packVersion:manifest.packVersion}))
    const child=spawn(config.java,args,{cwd:game,stdio:['ignore','pipe','pipe']})
    const lines=(stream:NodeJS.ReadableStream)=>{
      const rl=createInterface({input:stream})
      rl.on('line',line=>{for(const secret of secrets)if(secret)line=line.split(secret).join('[REDACTED]');console.log(line)})
    }
    lines(child.stdout);lines(child.stderr)
    writeFileSync(join(state,'process.json'),JSON.stringify({launcher:process.pid,game:child.pid}))
    const stop=()=>child.kill('SIGTERM');process.on('SIGINT',stop);process.on('SIGTERM',stop)
    await new Promise<void>((resolve,reject)=>{child.once('error',()=>reject(Error('Java 无法启动，请检查 Java 17 和显示环境。')));child.once('close',code=>{console.log(JSON.stringify({gameExitCode:code}));process.exitCode=code??1;resolve()})})
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop)
  }finally{lease.close();if(existsSync(join(state,'process.json')))unlinkSync(join(state,'process.json'))}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'启动器执行失败');process.exitCode=1})
