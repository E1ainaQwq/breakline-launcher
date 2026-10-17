import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {linuxAllowed,expandArguments,contained,verifyFile,loginAgentEndpoint} from './runtime'
const tests:[string,()=>void][]=[
  ['approved login endpoint canonicalized',()=>{assert.equal(loginAgentEndpoint('https://littleskin.cn/api/yggdrasil'),'https://littleskin.cn/api/yggdrasil/');assert.equal(loginAgentEndpoint('https://littleskin.cn/api/yggdrasil/'),'https://littleskin.cn/api/yggdrasil/')}],
  ['unapproved login endpoint refused',()=>{for(const api of ['http://littleskin.cn/api/yggdrasil/','https://other.invalid/api/yggdrasil/','https://littleskin.cn/api/yggdrasil/?x=1'])assert.throws(()=>loginAgentEndpoint(api))}],
  ['Linux libraries included',()=>assert.equal(linuxAllowed([{action:'allow',os:{name:'linux'}}]),true)],
  ['Windows native libraries excluded',()=>assert.equal(linuxAllowed([{action:'allow',os:{name:'windows'}}]),false)],
  ['macOS native libraries excluded',()=>assert.equal(linuxAllowed([{action:'allow',os:{name:'osx'}}]),false)],
  ['ARM native libraries excluded',()=>assert.equal(linuxAllowed([{action:'allow',os:{name:'linux',arch:'aarch64'}}]),false)],
  ['32 bit libraries excluded',()=>assert.equal(linuxAllowed([{action:'allow',os:{name:'universal',arch:'x86'}}]),false)],
  ['ordered exclusions respected',()=>assert.equal(linuxAllowed([{action:'allow'},{action:'disallow',os:{name:'linux'}}]),false)],
  ['demo / quick play feature arguments not emitted twice',()=>assert.deepEqual(expandArguments([{rules:[{action:'allow',features:{is_demo_user:true}}],value:'--demo'},'--uuid','${auth_uuid}'],{auth_uuid:'test-profile'}),['--uuid','test-profile'])],
  ['classpath and identity expanded without shell',()=>assert.deepEqual(expandArguments(['-cp','${classpath}','--username','${auth_player_name}'],{classpath:'/space in path/a.jar:/b.jar',auth_player_name:'Player'}),['-cp','/space in path/a.jar:/b.jar','--username','Player'])],
  ['unsupported placeholders fail closed',()=>assert.throws(()=>expandArguments(['${unresolved}'],{}))],
  ['relative escape refused',()=>assert.throws(()=>contained(join(tmpdir(),'fixture'),'../outside'))],
  ['absolute escape refused',()=>assert.throws(()=>contained(join(tmpdir(),'fixture'),join(tmpdir(),'outside')))],
  ['corrupt runtime refused',()=>{const dir=mkdtempSync(join(tmpdir(),'linux-runtime-test-'));try{const path=join(dir,'lib.jar');writeFileSync(path,'original');verifyFile(path,createHash('sha1').update('original').digest('hex'));writeFileSync(path,'changed');assert.throws(()=>verifyFile(path,createHash('sha1').update('original').digest('hex')))}finally{rmSync(dir,{recursive:true,force:true})}}]
]
for(const [name,test]of tests){test();console.log('PASS '+name)}
console.log('Linux runtime checks passed: '+tests.length)
