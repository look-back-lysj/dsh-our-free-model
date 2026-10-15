import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {after,test} from 'node:test'
import {PluginUpdater,signManifest} from '../src/updater.js'
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'ofm-separated-update-'))
after(()=>fs.rmSync(scratch,{recursive:true,force:true}))
const pair=crypto.generateKeyPairSync('ed25519')
const publicKey=pair.publicKey.export({type:'spki',format:'der'}).toString('base64')
const sha=data=>crypto.createHash('sha256').update(data).digest('hex')
const content={'package.json':JSON.stringify({name:'dsh-our-free-model',version:'2.3.1'}),'index.js':'export const updated=true\n','src/extensions/account-connectors.js':'export const optionalBridge=true\n'}
const manifest=files=>{const value={version:'2.3.1',base:'../',publishedAt:0,notes:'',files:files.map(file=>({path:file,size:Buffer.byteLength(content[file]??'embedded'),sha256:sha(content[file]??'embedded')}))};return{...value,signature:signManifest(value,pair.privateKey)}}
const setup=(label,initial)=>{
 const pkgDir=path.join(scratch,label,'package'),dataDir=path.join(scratch,label,'data');fs.mkdirSync(pkgDir,{recursive:true});fs.writeFileSync(path.join(pkgDir,'package.json'),JSON.stringify({name:'dsh-our-free-model',version:'2.3.0'}));fs.writeFileSync(path.join(pkgDir,'index.js'),'old-separated-core')
 let offered=initial,downloads=0
 const fetchImpl=async url=>{if(String(url).endsWith('/feed/manifest.json'))return new Response(JSON.stringify(offered),{status:200,headers:{'content-type':'application/json'}});downloads++;const rel=new URL(String(url)).pathname.replace(/^\/repo\//,'');return new Response(content[rel]??'embedded',{status:200})}
 const updater=new PluginUpdater({pkgDir,dataDir,settings:()=>({}),manifestPublicKey:publicKey,defaultSources:['https://local.invalid/repo/feed/manifest.json'],fetchImpl,manifestLayout:'external-accounts-v1'})
 return{updater,pkgDir,dataDir,offer:value=>{offered=value},downloads:()=>downloads}
}
test('signed integrated update is refused before any download, backup, activation or installed mutation',async()=>{
 const fixture=setup('integrated',manifest(['package.json','index.js','vendor/channel-pack/pack.js']))
 await assert.rejects(fixture.updater.check(),/不能覆盖当前分离版/)
 await assert.rejects(fixture.updater.apply(),/不能覆盖当前分离版/)
 assert.equal(fixture.downloads(),0);assert.equal(fixture.updater.status().available,false)
 assert.equal(fs.readFileSync(path.join(fixture.pkgDir,'index.js'),'utf8'),'old-separated-core')
 assert.equal(fs.existsSync(path.join(fixture.dataDir,'upgrade-stage')),false)
 assert.equal(fs.existsSync(path.join(fixture.dataDir,'rollback')),false)
})
test('new separated signed manifest retains the normal staged upgrade and activation lifecycle',async()=>{
 const fixture=setup('separated',manifest(['package.json','index.js','src/extensions/account-connectors.js']))
 assert.equal((await fixture.updater.check()).available,true)
 let activated=0;const result=await fixture.updater.apply({activate:async()=>{activated++;return{ok:true,version:'2.3.1'}}})
 assert.equal(result.version,'2.3.1');assert.equal(activated,1);assert.equal(fixture.downloads(),3)
 assert.equal(fs.readFileSync(path.join(fixture.pkgDir,'index.js'),'utf8'),content['index.js'])
})
test('last-moment manifest changes clear stale availability and cannot bring back embedded providers',async()=>{
 const fixture=setup('raced',manifest(['package.json','index.js','src/extensions/account-connectors.js']))
 assert.equal((await fixture.updater.check()).available,true)
 fixture.offer(manifest(['package.json','index.js','src/extensions/account-connectors.js','vendor/channel-pack/pack.js']))
 await assert.rejects(fixture.updater.apply(),/独立账号插件重复注册/)
 assert.equal(fixture.updater.status().available,false);assert.equal(fixture.downloads(),0)
 assert.equal(fs.readFileSync(path.join(fixture.pkgDir,'index.js'),'utf8'),'old-separated-core')
})

for(const blocked of ['src/./chan-relay.js','vendor/./channel-pack/pack.js','packages/standalone/./channels/runtime.mjs','Vendor/channel-pack/pack.js']) {
  test('signed filesystem-equivalent embedded path is refused: '+blocked,async()=>{
    const fixture=setup('alias-'+sha(blocked).slice(0,10),manifest(['package.json','index.js','src/extensions/account-connectors.js',blocked]))
    await assert.rejects(fixture.updater.check(),/不能覆盖当前分离版/)
    await assert.rejects(fixture.updater.apply(),/不能覆盖当前分离版/)
    assert.equal(fixture.downloads(),0);assert.equal(fixture.updater.status().available,false)
    assert.equal(fs.existsSync(path.join(fixture.dataDir,'upgrade-stage')),false)
    assert.equal(fs.existsSync(path.join(fixture.dataDir,'rollback')),false)
    assert.equal(fs.readFileSync(path.join(fixture.pkgDir,'index.js'),'utf8'),'old-separated-core')
  })
}
