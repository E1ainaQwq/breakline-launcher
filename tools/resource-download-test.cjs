const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http'),assert=require('node:assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'breakline-resource-test-'));
const signing=crypto.generateKeyPairSync('ed25519');
const publicKey=signing.publicKey.export({type:'spki',format:'pem'});
// Test-only bundle substitutes an ephemeral public key; production always pins its own key.
const testServices=path.join(root,'services');fs.cpSync(path.resolve(__dirname,'../src/main/services'),testServices,{recursive:true});
const testVerifier=path.join(testServices,'ManifestAuth.ts');fs.writeFileSync(testVerifier,fs.readFileSync(testVerifier,'utf8').replace(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/,publicKey.trim()));
function signed(manifest,route){const now=Math.floor(Date.now()/1000);const envelope=Buffer.from(JSON.stringify({context:'breakline-manifest-v1',path:route,issuedAt:now,expiresAt:now+600,manifest}));return {...manifest,authentication:{algorithm:'Ed25519',keyId:'origin-ed25519-20261007',envelope:envelope.toString('base64'),signature:crypto.sign(null,envelope,signing.privateKey).toString('base64')}}}
fs.writeFileSync(path.join(root,'electron.cjs'),`exports.app={getPath:()=>${JSON.stringify(root)}}`);
require('../node_modules/esbuild').buildSync({entryPoints:[path.join(testServices,'ClientBundleProvision.ts')],outfile:path.join(root,'bundle.cjs'),bundle:true,platform:'node',format:'cjs',alias:{electron:path.join(root,'electron.cjs')}});
const {provisionClientBundle,installBundleFiles}=require(path.join(root,'bundle.cjs'));
require('../node_modules/esbuild').buildSync({entryPoints:[path.join(testServices,'RedResourcePackProvision.ts')],outfile:path.join(root,'red.cjs'),bundle:true,platform:'node',format:'cjs'});
const {provisionRedResourcePack}=require(path.join(root,'red.cjs'));
require('../node_modules/esbuild').buildSync({entryPoints:[path.resolve(__dirname,'../src/main/services/DownloadStream.ts')],outfile:path.join(root,'download.cjs'),bundle:true,platform:'node',format:'cjs'});
const {downloadVerifiedResource}=require(path.join(root,'download.cjs'));
const fixture=path.join(root,'fixture');fs.mkdirSync(path.join(fixture,'tacz'),{recursive:true});
const gun=Buffer.from('official gun resource');fs.writeFileSync(path.join(fixture,'tacz','gun.json'),gun);
fs.writeFileSync(path.join(fixture,'.delta-client-files.json'),JSON.stringify([{path:'tacz/gun.json',size:gun.length,sha256:crypto.createHash('sha256').update(gun).digest('hex')}]));
const archive=path.join(root,'fixture.zip');
require('node:child_process').execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${fixture.replace(/'/g,"''")}','${archive.replace(/'/g,"''")}')`],{windowsHide:true});
const data=fs.readFileSync(archive),sha=crypto.createHash('sha256').update(data).digest('hex');
let ranges=0,requests=0,stalls=0,mode='normal',base;
const server=http.createServer((req,res)=>{
 req.url=new URL(req.url,'http://localhost').pathname;
 if(req.url.endsWith('/manifest')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(signed({ok:true,name:req.url.includes('red3d')?'delta-red-items-3d.zip':'client-bundle.zip',size:data.length,sha256:sha,url:base+'/file'},req.url)))}
 requests++;
 if(mode==='error'){res.writeHead(503);return res.end()}
 if(mode==='headers-timeout')return;
 if(mode==='slow'){
  res.writeHead(200,{'Content-Length':data.length});res.flushHeaders();let sent=0;
  const timer=setInterval(()=>{res.write(data.subarray(sent,sent+16));sent+=16;if(sent>=data.length){clearInterval(timer);res.end()}},25);
  res.on('close',()=>clearInterval(timer));return;
 }
 if(mode==='stall'||(mode==='stall-once'&&stalls++===0)){
  const from=req.headers.range?Number(req.headers.range.match(/\d+/)[0]):0;
  res.writeHead(from?206:200,{'Content-Length':data.length-from,...(from?{'Content-Range':`bytes ${from}-${data.length-1}/${data.length}`}:{})});
  res.write(data.subarray(from,from+16));return;
 }
 if(req.headers.range){ranges++;
  const from=Number(req.headers.range.match(/\d+/)[0]);
  if(mode==='refuse'||from>=data.length){res.writeHead(416,{'Content-Range':'bytes */'+data.length});return res.end()}
  if(mode!=='ignore'){
   res.writeHead(206,{'Content-Range':`bytes ${mode==='badRange'?0:from}-${data.length-1}/${data.length}`,'Content-Length':data.length-from});return res.end(data.subarray(from));
  }
 }
 res.writeHead(200,{'Content-Length':data.length});res.end(data);
});
(async()=>{try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 const cache=path.join(root,'downloads');fs.mkdirSync(cache);fs.writeFileSync(path.join(cache,'client-bundle.zip.part'),Buffer.alloc(data.length+100));
 const game=path.join(root,'game');fs.mkdirSync(game);fs.writeFileSync(path.join(game,'options.txt'),'personal HUD and keys');
 const old=Buffer.from('old official resource'),oldHash=crypto.createHash('sha256').update(old).digest('hex');fs.mkdirSync(path.join(game,'tacz','old-version'),{recursive:true});fs.mkdirSync(path.join(game,'config'));
 fs.writeFileSync(path.join(game,'tacz','old-version','gun.json'),old);fs.writeFileSync(path.join(game,'tacz','personal.json'),'personal');fs.writeFileSync(path.join(game,'config','retired.toml'),old);fs.writeFileSync(path.join(game,'config','player-edited.toml'),'personal override');
 fs.writeFileSync(path.join(game,'.delta-client-files.json'),JSON.stringify(['tacz/old-version/gun.json','config/retired.toml','config/player-edited.toml'].map(p=>({path:p,size:old.length,sha256:oldHash}))));
 const result=await provisionClientBundle(base,game);console.log(JSON.stringify({ok:result.ok,error:result.error,requestsWithRange:ranges,personalConfigPreserved:fs.readFileSync(path.join(game,'options.txt'),'utf8')==='personal HUD and keys'}));
 assert(result.ok,'stale download offset still blocks resource update');
 assert(fs.readFileSync(path.join(cache,'client-bundle.zip')).equals(data),'fresh resource not downloaded and verified');
 assert(!fs.existsSync(path.join(cache,'client-bundle.zip.part')),'legacy versionless partial cache still exists');
 assert.equal(result.removed,2);assert(!fs.existsSync(path.join(game,'tacz','old-version')));assert(!fs.existsSync(path.join(game,'config','retired.toml')));assert.equal(fs.readFileSync(path.join(game,'tacz','personal.json'),'utf8'),'personal');assert.equal(fs.readFileSync(path.join(game,'config','player-edited.toml'),'utf8'),'personal override');
 console.log('PASS obsolete official files and empty version directory deleted, untracked files and personal configs preserved');
 console.log('PASS actual resource update, old versionless cache removal, personal configuration preservation');
 const unchanged=path.join(game,'tacz','gun.json');fs.utimesSync(unchanged,100,100);
 installBundleFiles(fixture,game,sha);
 assert.equal(fs.statSync(unchanged).mtimeMs,100000);
 console.log('PASS matching resource bytes are not backed up and copied again');
 let checks=5;
 const part=path.join(root,'resource.part');
 const run=async(label,content,nextMode)=>{
  fs.rmSync(part,{force:true});if(content)fs.writeFileSync(part,content);mode=nextMode;
  await downloadVerifiedResource(new URL(base+'/file'),part,data.length,sha);
  assert(fs.readFileSync(part).equals(data),label);checks++;console.log('PASS '+label);
 };
 await run('matching range resumes correct bytes',data.subarray(0,30),'normal');
 await run('HTTP 416 restarts full download',data.subarray(0,30),'refuse');
 await run('server ignores range without duplicating bytes',data.subarray(0,30),'ignore');
 await run('incorrect content range restarts safely',data.subarray(0,30),'badRange');
 await run('oversized partial cache discarded',Buffer.alloc(data.length+1),'normal');
 await run('complete corrupt cache discarded',Buffer.alloc(data.length),'normal');
 const before=requests;await run('complete valid cache needs no request',data,'error');assert.equal(requests,before);checks++;
 fs.writeFileSync(part,data.subarray(0,30));mode='error';await assert.rejects(downloadVerifiedResource(new URL(base+'/file'),part,data.length,sha),/HTTP 503/);assert(fs.readFileSync(part).equals(data.subarray(0,30)));checks++;console.log('PASS server failure keeps valid partial bytes');
 fs.rmSync(part);mode='normal';await assert.rejects(downloadVerifiedResource(new URL(base+'/file'),part,data.length,'a'.repeat(64)),/SHA-256/);assert(!fs.existsSync(part));checks++;console.log('PASS hash mismatch refused and corrupt cache removed');
 fs.rmSync(part,{force:true});mode='slow';let retries=0;const started=Date.now();
 await downloadVerifiedResource(new URL(base+'/file'),part,data.length,sha,()=>{},{idleTimeoutMs:120,retryDelayMs:0,onRetry:()=>retries++});
 assert(Date.now()-started>120&&retries===0&&fs.readFileSync(part).equals(data));checks++;console.log('PASS continuous slow progress exceeds the timeout without a false abort');
 fs.rmSync(part);mode='stall-once';stalls=0;let retained=0;
 await downloadVerifiedResource(new URL(base+'/file'),part,data.length,sha,()=>{},{idleTimeoutMs:120,retryDelayMs:0,onRetry:(_attempt,bytes)=>retained=bytes});
 assert.equal(retained,16);assert(fs.readFileSync(part).equals(data));checks++;console.log('PASS stalled body is aborted and resumed from actual retained bytes');
 fs.rmSync(part);mode='stall';
 await assert.rejects(downloadVerifiedResource(new URL(base+'/file'),part,data.length,sha,()=>{},{idleTimeoutMs:120,retryDelayMs:0}),/下载连接超时，已保留下载进度/);
 assert.equal(fs.statSync(part).size,64);checks++;console.log('PASS repeated stalls stop after four attempts with Chinese retry guidance and intact partial bytes');
 fs.rmSync(part);mode='headers-timeout';
 await assert.rejects(downloadVerifiedResource(new URL(base+'/file'),part,data.length,sha,()=>{},{idleTimeoutMs:120,retryDelayMs:0}),/下载连接超时/);
 assert(!fs.existsSync(part));checks++;console.log('PASS missing response headers also have a bounded timeout');
 mode='normal';const oldPart=path.join(cache,'client-bundle.'+'b'.repeat(64)+'.zip.part');fs.writeFileSync(oldPart,'obsolete');
 const again=await provisionClientBundle(base,game);assert(again.ok&&!again.changed);assert(!fs.existsSync(oldPart));checks++;console.log('PASS up-to-date install clears obsolete owned partial caches');
 const packs=path.join(game,'resourcepacks');fs.mkdirSync(packs);const target=path.join(packs,'delta-red-items-3d.zip');fs.writeFileSync(target,'old valid release');
 const originalOptions='lang:zh_cn\nkey_key.use:key.mouse.right\nresourcePacks:["vanilla","file/personal.zip"]\n';fs.writeFileSync(path.join(game,'options.txt'),originalOptions);
 mode='error';const failure=await provisionRedResourcePack(base,game);assert(!failure.ok);assert.equal(fs.readFileSync(target,'utf8'),'old valid release');assert.equal(fs.readFileSync(path.join(game,'options.txt'),'utf8'),originalOptions);checks++;console.log('PASS resource failure keeps installed pack and options intact');
 const redPart=path.join(packs,'.delta-red-items-3d.zip.'+sha+'.part');fs.writeFileSync(redPart,data.subarray(0,30));const oldRedPart=path.join(packs,'.delta-red-items-3d.zip.'+'b'.repeat(64)+'.part');fs.writeFileSync(oldRedPart,'obsolete');fs.writeFileSync(path.join(packs,'personal.zip'),'personal');mode='refuse';
 const red=await provisionRedResourcePack(base,game);assert(red.ok);assert(fs.readFileSync(target).equals(data));assert(!fs.existsSync(oldRedPart));assert.equal(fs.readFileSync(path.join(packs,'personal.zip'),'utf8'),'personal');checks++;console.log('PASS red resource pack handles HTTP 416 and clears only owned caches');
 const options=fs.readFileSync(path.join(game,'options.txt'),'utf8');assert(options.startsWith('lang:zh_cn\nkey_key.use:key.mouse.right\n'));assert(options.includes('"file/personal.zip"'));assert(options.includes('"file/delta-red-items-3d.zip"'));checks++;console.log('PASS language, keys and personal resource pack selection preserved');
 const priorInventory=fs.readFileSync(path.join(game,'.delta-client-files.json')),priorMarker=fs.readFileSync(path.join(game,'.delta-client-bundle.sha256'));
 const originalCopy=fs.copyFileSync;let copies=0;fs.copyFileSync=(...args)=>{if(++copies===2)throw Error('simulated disk failure after first replacement');return originalCopy(...args)};
 try{assert.throws(()=>installBundleFiles(fixture,game,sha),/simulated disk failure/)}finally{fs.copyFileSync=originalCopy}
 assert(fs.readFileSync(path.join(game,'tacz','gun.json')).equals(gun));assert(fs.readFileSync(path.join(game,'.delta-client-files.json')).equals(priorInventory));assert(fs.readFileSync(path.join(game,'.delta-client-bundle.sha256')).equals(priorMarker));assert(!fs.readdirSync(game).some(n=>n.startsWith('.delta-bundle-rollback-')));checks++;console.log('PASS mid-install disk failure restores files and release metadata');
 fs.writeFileSync(path.join(fixture,'tacz','gun.json'),'corrupt');assert.throws(()=>installBundleFiles(fixture,game,sha),/校验失败/);assert(fs.readFileSync(path.join(game,'tacz','gun.json')).equals(gun));checks++;console.log('PASS bad new resources refused before existing files are changed');
 console.log('Resource update checks passed: '+checks);
}finally{server.close();fs.rmSync(root,{recursive:true,force:true})}})().catch(e=>{console.error(e.message);process.exitCode=1});
