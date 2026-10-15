import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {after, test} from 'node:test'
import {pathToFileURL} from 'node:url'

const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'ofm-session-isolation-'))
const dshHome=path.join(scratch,'dsh-home')
const sentinelFile=path.join(dshHome,'our-free-model','session-map.json')
const sentinel=JSON.stringify({version:1,sessions:{privateDshConversation:'sentinel-only'}})
fs.mkdirSync(path.dirname(sentinelFile),{recursive:true});fs.writeFileSync(sentinelFile,sentinel)
process.env.DSH_HOME=dshHome
const requests=[]
const model='space-bunny-free'
const server=http.createServer((req,res)=>{
  const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
    requests.push({method:req.method,path:req.url,session:req.headers['x-opencode-session-id'],body:Buffer.concat(chunks).toString()})
    if(req.method==='GET'&&['/inference/v1/models','/models'].includes(req.url)){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:req.url==='/models'?[]:[{id:model}]}));return}
    if(req.method!=='POST'||req.url!=='/inference/v1/chat/completions'){res.writeHead(404);res.end();return}
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'local-ok'}}]})+'\n\n'+'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}})+'\n\ndata: [DONE]\n\n')
  })
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const base='http://127.0.0.1:'+server.address().port
process.env.OUR_FREE_MODEL_BASE=base;process.env.OUR_FREE_MODEL_KILO_BASE=base
const nativeFetch=globalThis.fetch
let denied=0
// No accidental model or identity request may leave this machine in the suite.
globalThis.fetch=(url,opts)=>{if(new URL(String(url)).hostname!=='127.0.0.1'){denied++;throw Error('SESSION_TEST_EXTERNAL_FORBIDDEN')}return nativeFetch(url,opts)}
const {startStandalone}=await import('../packages/standalone/service.mjs')
const {createSessionMapper,mintSessionId}=await import('../src/upstream.js')
const services=[]
after(async()=>{for(const service of services)await service.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));globalThis.fetch=nativeFetch;fs.rmSync(scratch,{recursive:true,force:true})})
const readMap=dir=>JSON.parse(fs.readFileSync(path.join(dir,'session-map.json'),'utf8')).sessions

test('two real standalone HTTP runtimes isolate catalog, probe and generation sessions from DSH',async()=>{
  const dirs=[path.join(scratch,'desktop'),path.join(scratch,'separate-service')]
  for(const dataDir of dirs){
    const service=await startStandalone({dataDir,port:0,refresh:false,logger:{warn(){}}});services.push(service)
    await service.runtime.refreshCatalog({probe:false})
    await service.runtime.refreshAvailability(true)
    const key=JSON.parse(fs.readFileSync(service.keyFile,'utf8')).forwardKey
    const response=await fetch(service.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify({model,user:'same-conversation',messages:[{role:'user',content:'hello'}],stream:false}),signal:AbortSignal.timeout(5000)})
    assert.equal(response.status,200);assert.equal((await response.json()).choices[0].message.content,'local-ok')
  }
  const [first,second]=dirs.map(readMap)
  for(const seed of ['catalog:our-free-model','probe:our-free-model','forward:same-conversation']){
    assert.match(first[seed],/^ses_/);assert.match(second[seed],/^ses_/);assert.notEqual(first[seed],second[seed],seed)
    const method=seed.startsWith('catalog:')?'GET':'POST'
    const endpoint=method==='GET'?'/inference/v1/models':'/inference/v1/chat/completions'
    assert(requests.some(req=>req.session===first[seed]&&req.method===method&&req.path===endpoint),seed+' first runtime reaches the expected wire path')
    assert(requests.some(req=>req.session===second[seed]&&req.method===method&&req.path===endpoint),seed+' second runtime reaches the expected wire path')
  }
  assert.equal(fs.readFileSync(sentinelFile,'utf8'),sentinel)
  assert.equal(denied,0)
})

test('persisted mapping survives a new process and is reused by the same data directory',()=>{
  const dir=path.join(scratch,'restart')
  const expected=createSessionMapper({dataDir:dir})('persistent-conversation')
  const childFile=path.join(scratch,'read-map.mjs')
  const upstreamUrl=pathToFileURL(path.resolve('src/upstream.js')).href
  fs.writeFileSync(childFile,'import {createSessionMapper} from '+JSON.stringify(upstreamUrl)+';process.stdout.write(createSessionMapper({dataDir:process.argv[2]})("persistent-conversation"));')
  const actual=execFileSync(process.execPath,[childFile,dir],{encoding:'utf8',windowsHide:true,env:{...process.env,DSH_HOME:dshHome}})
  assert.equal(actual,expected)
  assert.equal(createSessionMapper({dataDir:dir})('persistent-conversation'),expected)
  assert.equal(fs.readFileSync(sentinelFile,'utf8'),sentinel)
})

test('canonical caller session passes through and relative storage is rejected before writing',()=>{
  const dir=path.join(scratch,'canonical-only')
  const canonical=mintSessionId()
  assert.equal(createSessionMapper({dataDir:dir})(canonical),canonical)
  assert.equal(fs.existsSync(dir),false)
  assert.throws(()=>createSessionMapper({dataDir:'relative-data'}),/absolute/)
})
