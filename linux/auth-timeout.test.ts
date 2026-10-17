import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {YggdrasilAuth} from '../src/main/services/YggdrasilAuth'
async function main(){
  const server=createServer(()=>{}) // Deliberately silent local endpoint; no production account involved.
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  const address=server.address();assert(address&&typeof address!=='string')
  const api='http://127.0.0.1:'+address.port
  const dir=mkdtempSync(join(tmpdir(),'linux-auth-timeout-')),path=join(dir,'auth.json')
  const existing={api,username:'SyntheticTest',uuid:'0'.repeat(32),accessToken:'synthetic-expired',clientToken:'synthetic-local',refreshedAt:0}
  writeFileSync(path,JSON.stringify(existing));const saved=readFileSync(path,'utf8'),auth=new YggdrasilAuth(path),start=Date.now()
  try{
    const results=await Promise.all([auth.login('local-test','local-test',api),auth.refresh(existing)])
    assert(results.every(r=>!r.ok));assert(Date.now()-start<20000)
    assert.equal(readFileSync(path,'utf8'),saved)
    console.log('PASS unavailable skin login and refresh terminate; existing credential cache preserved')
  }finally{server.closeAllConnections();server.close();rmSync(dir,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
