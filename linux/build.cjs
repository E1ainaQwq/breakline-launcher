const {buildSync}=require('../node_modules/esbuild')
const {resolve}=require('node:path')
for(const name of ['cli','runtime.test','auth-timeout.test'])buildSync({entryPoints:[resolve(__dirname,name+'.ts')],outfile:resolve(__dirname,'dist',name==='cli'?'breakline-linux.cjs':name+'.cjs'),bundle:true,platform:'node',format:'cjs',target:'node22'})
