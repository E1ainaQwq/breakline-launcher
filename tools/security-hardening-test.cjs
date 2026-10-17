const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto'),esbuild=require('../node_modules/esbuild');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'breakline-security-proof-'));
function bundle(name){const target=path.join(root,name+'.cjs');esbuild.buildSync({entryPoints:[path.resolve(__dirname,'../src/main/services/'+name+'.ts')],outfile:target,bundle:true,platform:'node',format:'cjs'});return require(target)}
const {verifyAuthenticatedManifest}=bundle('ManifestAuth');
const {assertTrustedJvmArgs,trustedJavaEnvironment}=bundle('JvmTrust');
const {buildLaunchArgs}=bundle('LaunchArgs');
const pair=crypto.generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({type:'spki',format:'pem'}),now=Date.now(),seconds=Math.floor(now/1000);
const manifest={ok:true,url:'http://localhost/file',sha256:'1'.repeat(64),size:100};
const route='/api/client/bundle/manifest';
function signed(payload){const bytes=Buffer.from(JSON.stringify(payload));return {...payload.manifest,authentication:{algorithm:'Ed25519',keyId:'origin-ed25519-20261007',envelope:bytes.toString('base64'),signature:crypto.sign(null,bytes,pair.privateKey).toString('base64')}}}
const payload={context:'breakline-manifest-v1',path:route,issuedAt:seconds,expiresAt:seconds+600,manifest};
const good=signed(payload);
verifyAuthenticatedManifest(good,route,now,publicKey);
assert.throws(()=>verifyAuthenticatedManifest(manifest,route,now,publicKey));
assert.throws(()=>verifyAuthenticatedManifest({...good,sha256:'2'.repeat(64)},route,now,publicKey));
assert.throws(()=>verifyAuthenticatedManifest({...good,url:'https://untrusted.invalid/file'},route,now,publicKey));
assert.throws(()=>verifyAuthenticatedManifest({...good,authentication:{...good.authentication,signature:'A'.repeat(88)}},route,now,publicKey));
assert.throws(()=>verifyAuthenticatedManifest(good,'/api/pack/manifest',now,publicKey));
assert.throws(()=>verifyAuthenticatedManifest(good,route,now+800000,publicKey));
assert.throws(()=>verifyAuthenticatedManifest(good,route,now-300000,publicKey));
assert.throws(()=>verifyAuthenticatedManifest(good,route,now,crypto.generateKeyPairSync('ed25519').publicKey));
verifyAuthenticatedManifest({authentication:good.authentication,size:100,sha256:manifest.sha256,url:manifest.url,ok:true},route,now,publicKey);
assertTrustedJvmArgs(['-Xmx4G','-cp','safe.jar','Main']);
for(const entry of ['@hidden-args.txt','-agentpath:untrusted.dll','-agentlib:untrusted','-Xbootclasspath/a:extra.jar','-Djava.system.class.loader=Untrusted','-javaagent:renamed.jar=https://littleskin.cn/api/yggdrasil/'])assert.throws(()=>assertTrustedJvmArgs([entry]));
const login=process.env.BREAKLINE_AUTHLIB_TEST_JAR||path.resolve(__dirname,'../config/authlib-injector-1.2.8.jar');
if(fs.existsSync(login)){
assertTrustedJvmArgs(['-javaagent:'+login+'=https://littleskin.cn/api/yggdrasil/']);
const agent='-javaagent:'+login+'=https://littleskin.cn/api/yggdrasil/';assert.throws(()=>assertTrustedJvmArgs([agent,agent]));
const assembled=buildLaunchArgs([agent,'-XX:-DisableAttachMechanism','-XX:+EnableDynamicAgentLoading','-cp','safe.jar','Main'],[],{memoryMb:4096,width:null,height:null,fullscreen:false});
assert.equal(assembled.filter(x=>x.includes('DisableAttachMechanism')).join(),'-XX:+DisableAttachMechanism');
assert.equal(assembled.filter(x=>x.includes('EnableDynamicAgentLoading')).join(),'-XX:-EnableDynamicAgentLoading');
assertTrustedJvmArgs(assembled);assert(assembled.indexOf('-XX:+DisableAttachMechanism')<assembled.indexOf('Main'));
}else console.log('External authlib positive fixture not run: set BREAKLINE_AUTHLIB_TEST_JAR; negative injection checks remain active');
const hostile={...process.env,JAVA_TOOL_OPTIONS:'-DprobeInjected=1',_JAVA_OPTIONS:'-DprobeInjected=1',JDK_JAVA_OPTIONS:'-DprobeInjected=1',jdk_java_options:'-DprobeInjected=1'};
const clean=trustedJavaEnvironment(hostile);assert(hostile.JAVA_TOOL_OPTIONS);assert(clean.PATH===hostile.PATH);for(const k of Object.keys(clean))assert(!['JAVA_TOOL_OPTIONS','_JAVA_OPTIONS','JDK_JAVA_OPTIONS'].includes(k.toUpperCase()));
const probe=path.join(root,'EnvironmentProbe.java');fs.writeFileSync(probe,'class EnvironmentProbe { public static void main(String[] args) { if (System.getProperty("probeInjected") != null) throw new AssertionError("environment injected"); System.out.println("GAME_ENV_CLEAN"); } }');
const java=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java';const child=require('node:child_process').spawnSync(java,['-XX:+DisableAttachMechanism','-XX:-EnableDynamicAgentLoading',probe],{env:clean,encoding:'utf8',timeout:30000});assert.equal(child.status,0,child.stderr);assert(child.stdout.includes('GAME_ENV_CLEAN'));
console.log('PASS signed/unsigned/tampered hash/URL/signature/wrong key/path/expiry/future/reordered manifests; exact login helper; unapproved agents; attach flags');
if(process.argv.includes('--live')){(async()=>{for(const base of ['http://54.92.36.174','http://111.230.147.241:8787'])for(const route of ['/api/pack/manifest','/api/client/bundle/manifest','/api/client/resourcepack/red3d/manifest','/api/launcher-update/manifest']){const r=await fetch(base+route,{headers:{'X-Delta-Launcher-Version':'0.3.38'},signal:AbortSignal.timeout(20000)});assert(r.ok);const body=await r.json();verifyAuthenticatedManifest(body,route);console.log('LIVE signature verified: '+base+route)}})().catch(e=>{console.error(e.message);process.exitCode=1})}
