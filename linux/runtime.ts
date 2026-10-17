import {existsSync,readFileSync,mkdirSync,renameSync,rmSync,realpathSync,copyFileSync} from 'node:fs'
import {resolve,join,dirname,sep} from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync,spawnSync} from 'node:child_process'
import {saveDownload} from '../src/main/services/DownloadStream'
import type {YggdrasilSession} from '../src/main/services/YggdrasilAuth'

type Rule={action:string;os?:{name?:string;arch?:string;version?:string};features?:Record<string,boolean>}
type Argument=string|{rules?:Rule[];value:string|string[]}
export function loginAgentEndpoint(api:string):string{
  if(api!=='https://littleskin.cn/api/yggdrasil'&&api!=='https://littleskin.cn/api/yggdrasil/')throw Error('登录服务地址不受支持，请重新登录。')
  return 'https://littleskin.cn/api/yggdrasil/'
}
export function linuxAllowed(rules?:Rule[]):boolean{
  if(!rules?.length)return true
  let allow=false
  for(const rule of rules){
    const os=rule.os
    if(os?.name&&!['linux','universal'].includes(os.name))continue
    if(os?.arch&&!['x86_64','amd64'].includes(os.arch))continue
    if(os?.version&&!new RegExp(os.version).test(execFileSync('uname',['-r'],{encoding:'utf8'}).trim()))continue
    if(Object.entries(rule.features??{}).some(([,expected])=>expected!==false))continue
    allow=rule.action==='allow'
  }
  return allow
}
export function expandArguments(items:Argument[],values:Record<string,string>):string[]{
  return items.flatMap(item=>{
    if(typeof item!=='string'&&!linuxAllowed(item.rules))return []
    const value=typeof item==='string'?item:item.value
    return (Array.isArray(value)?value:[value]).map(v=>v.replace(/\$\{([^}]+)\}/g,(_,key)=>{if(!(key in values))throw Error('版本参数尚未支持：'+key);return values[key]}))
  })
}
export function contained(root:string,relative:string):string{
  if(!relative||relative.includes('\\'))throw Error('客户端路径无效')
  const path=resolve(root,relative)
  if(!path.startsWith(resolve(root)+sep))throw Error('客户端路径越界')
  return path
}
export function verifyFile(path:string,expected:string,algorithm='sha1'):void{
  if(!existsSync(path)||!expected||createHash(algorithm).update(readFileSync(path)).digest('hex')!==expected.toLowerCase())throw Error('客户端运行文件缺失或校验失败：'+path+'。请用现有 Minecraft 启动器修复 Linux 运行库。')
}
export async function verifyResourcePack(game:string,api:string):Promise<void>{
  const res=await fetch(api+'/api/client/resourcepack/red3d/manifest',{signal:AbortSignal.timeout(15000)})
  if(!res.ok)throw Error('必要资源包清单不可用')
  const pack=await res.json() as {name:string;sha256:string}
  verifyFile(contained(join(game,'resourcepacks'),pack.name),pack.sha256,'sha256')
}
export async function existingRuntime(root:string,profile:string,state:string,identity:YggdrasilSession,version:string){
  const game=contained(join(root,'versions'),profile),meta=JSON.parse(readFileSync(join(game,profile+'.json'),'utf8'))
  if(meta.mainClass!=='cpw.mods.bootstraplauncher.BootstrapLauncher'||!meta.arguments?.jvm||!meta.arguments?.game||!meta.assetIndex)throw Error('需要已有的完整 Minecraft 1.20.1 Forge 47.4.13 版本配置；请先在 Minecraft 启动器完成安装。')
  const java=process.env.BREAKLINE_JAVA??'java'
  const check=spawnSync(java,['-version'],{encoding:'utf8',timeout:15000})
  const major=Number((check.stderr??'').match(/version "(\d+)/)?.[1])
  if(check.error||check.status!==0||major!==17)throw Error('请安装并选择 Java 17 JDK；可用 BREAKLINE_JAVA 指定 java 路径。')
  const libroot=join(root,'libraries'),selected=meta.libraries.filter((l:any)=>linuxAllowed(l.rules))
  const classpath:string[]=[],natives=join(game,'natives-linux');mkdirSync(natives,{recursive:true})
  const jarTool=process.env.BREAKLINE_JAR??(java==='java'?'jar':join(dirname(realpathSync(java)),'jar'))
  for(const lib of selected){
    const artifact=lib.downloads?.artifact
    if(!artifact?.path||!artifact.sha1)throw Error('版本运行库缺少校验信息：'+lib.name)
    const path=contained(libroot,artifact.path);verifyFile(path,artifact.sha1);classpath.push(path)
    if(lib.name.includes(':natives-linux')){
      const entries=execFileSync(jarTool,['tf',path],{encoding:'utf8',timeout:30000}).split(/\r?\n/).filter(e=>e.endsWith('.so'))
      for(const entry of entries)contained(natives,entry)
      if(entries.length)execFileSync(jarTool,['xf',path,...entries],{cwd:natives,timeout:30000})
    }
  }
  const jar=join(game,profile+'.jar');verifyFile(jar,meta.downloads?.client?.sha1);classpath.push(jar)
  for(const file of [
    'net/minecraft/client/1.20.1-20230612.114412/client-1.20.1-20230612.114412-srg.jar',
    'net/minecraft/client/1.20.1-20230612.114412/client-1.20.1-20230612.114412-extra.jar',
    'net/minecraftforge/forge/1.20.1-47.4.13/forge-1.20.1-47.4.13-client.jar'
  ])if(!existsSync(contained(libroot,file)))throw Error('Forge 客户端安装不完整，缺少 '+file+'。请先用现有 Minecraft 启动器完成 Forge 安装。')
  verifyFile(contained(join(root,'assets','indexes'),meta.assetIndex.id+'.json'),meta.assetIndex.sha1)
  const injector=join(state,'authlib-injector-1.2.8.jar'),expected='9c7f4343e6c82034958ffb48c14a2cb0c85928be7283103ce17da00c6d5a7b10'
  if(!existsSync(injector))for(const candidate of [join(root,'authlib-injector.jar'),join(root,'runtime','authlib-injector-1.2.8.jar')]){
    try{verifyFile(candidate,expected,'sha256');copyFileSync(candidate,injector);break}catch{}
  }
  try{verifyFile(injector,expected,'sha256')}catch{
    const part=injector+'.part'
    try{
      const res=await fetch('https://github.com/yushijinhun/authlib-injector/releases/download/v1.2.8/authlib-injector-1.2.8.jar',{signal:AbortSignal.timeout(60000)})
      if(!res.ok)throw Error('登录组件下载失败')
      await saveDownload(res,part);verifyFile(part,expected,'sha256');renameSync(part,injector)
    }finally{rmSync(part,{force:true})}
  }
  const values={natives_directory:natives,launcher_name:'Breakline-Linux',launcher_version:version,classpath:classpath.join(':'),library_directory:libroot,classpath_separator:':',version_name:profile,primary_jar_name:profile+'.jar',game_directory:game,assets_root:join(root,'assets'),assets_index_name:meta.assetIndex.id,auth_player_name:identity.username,auth_uuid:identity.uuid,auth_access_token:identity.accessToken,clientid:'',auth_xuid:'',user_type:'mojang',version_type:'release'}
  const jvmArgs=[...expandArguments(meta.arguments.jvm,values),'-Dfile.encoding=UTF-8','-javaagent:'+injector+'='+loginAgentEndpoint(identity.api),meta.mainClass]
  const programArgs=[...expandArguments(meta.arguments.game,values),'--quickPlayMultiplayer','zzbgp2.coreyun.net:35442']
  const mc=programArgs.indexOf('--fml.mcVersion'),forge=programArgs.indexOf('--fml.forgeVersion')
  if(programArgs[mc+1]!=='1.20.1'||programArgs[forge+1]!=='47.4.13')throw Error('此版本需要 Minecraft 1.20.1 / Forge 47.4.13。')
  return {java,jvmArgs,programArgs}
}
