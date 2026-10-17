const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),esbuild=require('../node_modules/esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mugen-device-check-'));
const output=path.join(dir,'device.cjs');
esbuild.buildSync({entryPoints:[path.resolve(__dirname,'../src/main/services/DeviceIdentity.ts')],outfile:output,bundle:true,platform:'node',format:'cjs'});
const {DeviceIdentity,normalizeIdentity,isVirtualGuest}=require(output);
const raw={vendor:'ASUS',model:'VMKHD7219YY8031',hardware:'12345678-1234-5678-9abc-123456789abc',install:'abcdef12-1234-5678-9abc-123456789abc',environmentRead:true};
(async()=>{
 assert.equal(normalizeIdentity(raw,'win32').environment,'physical');
 // HypervisorPresent is intentionally not used; VBS and WSL physical hosts stay valid.
 for(const [vendor,model] of [['VMware, Inc.','VMware Virtual Platform'],['innotek GmbH','VirtualBox'],['QEMU','Standard PC'],['Microsoft Corporation','Virtual Machine'],['Amazon EC2','t3.medium'],['Parallels','Virtual Platform']])assert(isVirtualGuest(vendor,model));
 assert(!isVirtualGuest('Microsoft Corporation','Surface Pro 9'));
 assert(!isVirtualGuest('ASUS','VMKHD7219YY8031'));
 const result=normalizeIdentity(raw,'win32');assert.equal(result.device.signals.length,2);
 assert(!JSON.stringify(result).includes(raw.hardware));assert(!JSON.stringify(result).includes(raw.install));
 const reinstalled=normalizeIdentity({...raw,install:'99999999-1234-5678-9abc-123456789abc'},'win32');
 assert.equal(result.device.signals[0].hash,reinstalled.device.signals[0].hash);assert.notEqual(result.device.signals[1].hash,reinstalled.device.signals[1].hash);
 const linux=normalizeIdentity({...raw,install:'0123456789abcdef0123456789abcdef'},'linux');assert.equal(linux.device.signals[0].hash,result.device.signals[0].hash);
 assert.equal(normalizeIdentity({...raw,hardware:'0'.repeat(32),install:'f'.repeat(32)},'win32').environment,'unavailable');
 assert.equal(normalizeIdentity({...raw,environmentRead:false},'win32').environment,'unavailable');
 let count=0;const injected=new DeviceIdentity(async()=>{count++;return raw},'win32');await Promise.all([injected.collect(),injected.collect()]);assert.equal(count,1);
 assert.equal((await new DeviceIdentity(async()=>{throw Error('failure')}).collect()).environment,'unavailable');
 let attempts=0;const recoverable=new DeviceIdentity(async()=>{if(++attempts===1)throw Error('transient');return raw},'win32');assert.equal((await recoverable.collect()).environment,'unavailable');assert.equal((await recoverable.collect()).environment,'physical');
 const actual=await new DeviceIdentity().collect();assert.equal(actual.environment,'physical',actual.detail);assert(actual.device.signals.length>=1);
 console.log(JSON.stringify({fixtureCasesPassed:true,rawIdentifiersNeverSerialized:true,independentHashesSurviveReinstall:true,physicalHypervisorHostAllowed:true,actualLocalStableSignals:actual.device.signals.length,actualLocalEnvironment:actual.environment}));
})().catch(e=>{console.error(e.message);process.exitCode=1});
