const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),esbuild=require('../node_modules/esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mugen-feedback-proof-'));
function bundle(name){const output=path.join(dir,name+'.cjs');esbuild.buildSync({entryPoints:[path.resolve(__dirname,'../src/main/services/'+name+'.ts')],outfile:output,bundle:true,platform:'node',format:'cjs'});return require(output)}
const {AcMonitor}=bundle('AcMonitor'),{LaunchLease}=bundle('LaunchLease');
const frame=['MUGEN1','client ok loaded 0','guard ok assembled 0','scan ok checked 8','processes disabled disabled 0','drivers unsupported unsupported 0','modules waiting baseline 0','jvm ok checked 0','device waiting consent 0','report ok received 7','screenshot waiting capture_trigger 0'].join('\n')+'\n';
(async()=>{
 const monitor=new AcMonitor();monitor.recordPack({ok:true,antiCheat:true,expected:72});assert(!monitor.receive(frame));monitor.recordState('starting');monitor.recordState('running');
 const lease=await LaunchLease.start({ok:true,token:'probe',ttlSeconds:300},async()=>({ok:true,token:'probe',ttlSeconds:300}),body=>monitor.receive(body));
 try{
  const url=lease.url.replace('/token','/status'),headers={Authorization:'Bearer '+lease.key};
  assert.equal((await fetch(url,{method:'POST',body:frame})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://untrusted.invalid'},body:frame})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers,body:frame.replace('jvm ok checked 0','jvm ok invented 0')})).status,400);
  assert.equal((await fetch(url,{method:'POST',headers,body:frame.replace('jvm ok checked 0','device ok checked 0')})).status,400);
  assert.equal((await fetch(url,{method:'POST',headers,body:frame})).status,204);
  assert.equal((await fetch(url,{method:'POST',headers,body:'x'.repeat(4097)})).status,413);
  let s=monitor.snapshot(true,'ok',lease.status());assert.equal(s.status,'running');assert.equal(s.tasks.find(t=>t.id==='report').state,'ok');assert(s.tasks.find(t=>t.id==='report').detail.includes('第 7 轮'));assert.equal(s.tasks.find(t=>t.id==='processes').state,'disabled');assert.equal(s.tasks.find(t=>t.id==='drivers').state,'unsupported');assert.equal(s.tasks.find(t=>t.id==='device').state,'waiting');
  const acClasspath=process.env.BREAKLINE_AC_TEST_CLASSPATH;
  if(acClasspath){
  const javaSource=path.join(dir,'MonitorTransportProbe.java');fs.writeFileSync(javaSource,'import dev.delta.ac.client.LauncherLeaseClient; class MonitorTransportProbe { public static void main(String[] args) throws Exception { LauncherLeaseClient.publishStatus(args[0],args[1],java.nio.file.Files.readString(java.nio.file.Path.of(args[2]))); System.out.println("STATUS_POSTED"); } }');
  fs.writeFileSync(path.join(dir,'frame.txt'),frame);
  const java=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java';
  const child=require('node:child_process').spawn(java,['-cp',acClasspath,javaSource,lease.url,lease.key,path.join(dir,'frame.txt')],{stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);assert.equal(await new Promise(resolve=>child.once('exit',resolve)),0,error);assert(output.includes('STATUS_POSTED'));
  }
  const oldNow=Date.now;try{Date.now=()=>oldNow()+21000;s=monitor.snapshot(true,'ok',lease.status());assert.equal(s.tasks.find(t=>t.id==='guard').state,'unknown');assert.notEqual(s.status,'running')}finally{Date.now=oldNow}
  assert.equal((await fetch(url,{method:'POST',headers,body:frame.replace('report ok received 7','report error ack_timeout 0')})).status,204);assert.equal(monitor.snapshot(true,'ok',lease.status()).status,'error');
  monitor.recordState('exited');assert.equal(monitor.snapshot(true,'ok',null).tasks.find(t=>t.id==='client').state,'waiting');assert(!monitor.receive(frame));
  console.log('PASS all per-item states; authenticated bounded loopback; server-receipt display; stale heartbeat; invalid/duplicate rejection; fault; exit reset');
  console.log(acClasspath?'PASS external Java client status transport':'External Java client transport not run: set BREAKLINE_AC_TEST_CLASSPATH to its compiled classes');
 }finally{lease.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
