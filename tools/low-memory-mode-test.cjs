const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),ts=require('typescript');
const source=path.resolve(__dirname,'../src/main/services/LowMemoryMode.ts'),mod={exports:{}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(require,mod,mod.exports);
const {applyLowMemoryMode,lowMemoryHeapMb}=mod.exports;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'低配启动 test '));
try{
 fs.mkdirSync(path.join(dir,'config'));fs.mkdirSync(path.join(dir,'mods'));
 const pref=path.join(dir,'config/deltaui-performance.json'),opts=path.join(dir,'options.txt'),backup=path.join(dir,'config/deltaui-launcher-low-memory-before.json');
 const initial={schemaVersion:1,guns2d:false,keepMe:'yes'};
 fs.writeFileSync(pref,JSON.stringify(initial));fs.writeFileSync(opts,'renderDistance:18\nmipmapLevels:4\nkey_key.forward:key.keyboard.w\n');
 const before=fs.readFileSync(pref,'utf8');applyLowMemoryMode(dir,undefined);assert.equal(fs.readFileSync(pref,'utf8'),before);
 assert.throws(()=>applyLowMemoryMode(dir,true),/先更新游戏包/);assert.equal(fs.existsSync(backup),false);
 // Readiness is a non-security feature marker; signed mod verification remains the normal launch gate.
 fs.writeFileSync(path.join(dir,'mods/breakline-mod-test.jar'),Buffer.from('cn/zifeng/deltaui/LowSpecStartupPacks.class'));
 applyLowMemoryMode(dir,true);const enabled=JSON.parse(fs.readFileSync(pref));assert.equal(enabled.collectibles2d,true);assert.equal(enabled.textures8x8,true);assert.equal(enabled.keepMe,'yes');assert.match(fs.readFileSync(opts,'utf8'),/mipmapLevels:0/);
 applyLowMemoryMode(dir,true);assert.equal(JSON.parse(fs.readFileSync(backup)).graphics.renderDistance,'18');
 const changed=JSON.parse(fs.readFileSync(pref));changed.unrelated='preserved';fs.writeFileSync(pref,JSON.stringify(changed));
 applyLowMemoryMode(dir,false);const restored=JSON.parse(fs.readFileSync(pref));assert.equal(restored.guns2d,false);assert.equal(restored.textures8x8,undefined);assert.equal(restored.unrelated,'preserved');assert.equal(fs.existsSync(backup),false);assert.match(fs.readFileSync(opts,'utf8'),/renderDistance:18/);assert.match(fs.readFileSync(opts,'utf8'),/mipmapLevels:4/);assert.match(fs.readFileSync(opts,'utf8'),/key_key.forward:key.keyboard.w/);
 assert.equal(lowMemoryHeapMb(6144,true),3072);assert.equal(lowMemoryHeapMb(2048,true),2048);assert.equal(lowMemoryHeapMb(6144,false),6144);
 fs.writeFileSync(pref,'broken');assert.throws(()=>applyLowMemoryMode(dir,true));assert.equal(fs.readFileSync(pref,'utf8'),'broken');
 console.log('PASS low-memory opt-in, unsupported-version guard, pre-start flags/graphics, idempotent snapshot, exact managed-key restore, unrelated preservation, heap cap, malformed-file protection');
}finally{fs.rmSync(dir,{recursive:true,force:true})}
