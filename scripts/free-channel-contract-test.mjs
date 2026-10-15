import assert from 'node:assert/strict'
import {after,test} from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {chatFrames,stubUpstream} from './lib/fake-kernel.mjs'
const testHome=fs.mkdtempSync(path.join(os.tmpdir(),'ofm-free-contract-'))
const previousDshHome=process.env.DSH_HOME
process.env.DSH_HOME=testHome
let answer={body:chatFrames('ok')}
const gateway=await stubUpstream({answer:()=>answer})
process.env.OUR_FREE_MODEL_BASE=gateway.base
const {CODE,classifyFailure}=await import('../src/http.js')
const {classifyFailure:routeFailure,shouldAdvance}=await import('../src/route/classify.js')
const {buildCatalog}=await import('../src/catalog.js')
const {probeModel,STATE}=await import('../src/probe.js')
const {computeMembership,createRuntimeStores}=await import('../src/core/runtime.js')
const {ROUTE_MAIN}=await import('../src/adapter.js')
const envelope={type:'error',error:{type:'FreeTierError',message:"OpenCode's free tier can only be used from within OpenCode."}}
const sse=payload=>'data: '+JSON.stringify(payload)+'\n\n'
const probe=async body=>{answer={body};return probeModel(buildCatalog(['space-bunny-free'])[0])}
after(async()=>{await gateway.close();if(previousDshHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousDshHome;fs.rmSync(testHome,{recursive:true,force:true})})
test('the recorded free-client refusal preserves policy type instead of invalid credential or quota',()=>{
 for(const status of [403,undefined]){const error=classifyFailure(status,envelope);assert.equal(error.code,'LANE_LOCKED');assert.equal(error.type,'FreeTierError');assert.equal(error.message,envelope.error.message);assert.equal(error.unavailable,undefined)}
 const error=classifyFailure(403,{error:{type:'FreeTierError',message:'no credentials; rate limit'}});assert.equal(error.code,'LANE_LOCKED')
})
test('a policy refusal neither retries the same turn nor rotates or penalizes a credential',()=>{
 const error=classifyFailure(403,envelope)
 for(const message of [error.message,'no credentials; rate limit']){const verdict=routeFailure({status:error.status,code:error.code,message});assert.equal(verdict.retryable,false);assert.equal(verdict.scope,'provider');assert.equal(verdict.cooldownMs,0);assert.equal(shouldAdvance(verdict),false)}
})
test('real bad credential, region, quota, and EAC authorization remain distinct',()=>{
 assert.equal(classifyFailure(401,{error:{message:'invalid API key'}}).code,CODE.credential)
 assert.equal(classifyFailure(403,{error:{type:'RegionError',message:'not available in your country'}}).code,CODE.region)
 assert.equal(classifyFailure(429,{error:{type:'FreeUsageLimitError',message:'usage limit'}},2300).providerRetryAfterMs,2300)
 assert.equal(classifyFailure(401,{error:{type:'AuthorizationRequired',message:'需要 GitHub 授权'}}).code,CODE.authorization)
})
test('free chat catalog includes the confirmed suffixless model and excludes structured-only Jev',()=>{
 const models=buildCatalog(['big-pickle','jev-1.13-free','mimo-v2.6-flash-free','paid-model','big-pickle'])
 assert.deepEqual(models.map(row=>row.id),['big-pickle','mimo-v2.6-flash-free']);assert.equal(models[0].name,'Big Pickle');assert.equal(models[0].wire,'chat')
})
test('chat catalog wire agrees with actual Responses and Messages routes',()=>{
 const models=buildCatalog(['muse-spark-1.3-contributor-free','union-alpha']);assert.deepEqual(models.map(row=>row.wire),['responses','messages'])
})
test('probe green requires nonempty answer and an explicit model terminal',async()=>{
 assert.equal((await probe(chatFrames('OK'))).state,STATE.available)
 for(const body of [chatFrames(''),sse({choices:[{delta:{content:'partial'}}]}),sse({choices:[{delta:{role:'assistant'}}]})+'data: [DONE]\n\n']){const verdict=await probe(body);assert.equal(verdict.state,STATE.unknown);assert(verdict.detail)}
})
test('HTTP and stream free-policy failures share the upstream lane-locked verdict',async()=>{
 answer={status:403,body:JSON.stringify(envelope)};assert.equal((await probeModel(buildCatalog(['space-bunny-free'])[0])).state,STATE.unavailable)
 assert.equal((await probe(sse(envelope))).state,STATE.unavailable)
})
test('an error after useful output is not a successful probe',async()=>{
 const content=sse({choices:[{delta:{content:'OK'}}]})
 assert.equal((await probe(content+sse(envelope))).state,STATE.unavailable)
 assert.equal((await probe(content+sse({error:{type:'ModelError',message:'Model is unavailable'}}))).state,STATE.unavailable)
})
test('failed Responses is not a green verdict even with partial text',async()=>{
 answer={body:sse({type:'response.output_text.delta',item_id:'m',output_index:0,delta:'partial'})+sse({type:'response.failed',response:{status:'failed',error:{type:'FreeTierError',message:envelope.error.message}}})}
 const verdict=await probeModel(buildCatalog(['muse-spark-1.3-contributor-free'])[0]);assert.equal(verdict.state,STATE.unavailable)
})
test('native completed Responses and Messages can produce honest probe successes',async()=>{
 answer={body:sse({type:'response.output_text.delta',item_id:'m',output_index:0,delta:'OK'})+sse({type:'response.completed',response:{status:'completed'}})}
 assert.equal((await probeModel(buildCatalog(['muse-spark-1.3-contributor-free'])[0])).state,STATE.available)
 answer={body:sse({type:'content_block_start',index:0,content_block:{type:'text',text:''}})+sse({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OK'}})+sse({type:'content_block_stop',index:0})+sse({type:'message_delta',delta:{stop_reason:'end_turn'}})+sse({type:'message_stop'})}
 assert.equal((await probeModel(buildCatalog(['union-alpha'])[0])).state,STATE.available)
 const sent=gateway.requests.at(-1);assert.equal(sent.path,'/inference/v1/messages')
 for(const name of ['bash','read']){const tool=sent.body.tools.find(tool=>tool.name===name);assert.ok(tool,name+' has a top-level Messages tool name');assert.equal(tool.function,undefined);assert.equal(tool.input_schema?.type,'object');assert.ok(Object.keys(tool.input_schema?.properties??{}).length>0,name+' has declared properties')}
})
test('access-restricted models stay out of routable membership without hiding other lanes',()=>{
 const catalog=[...buildCatalog(['big-pickle','space-bunny-free']),{id:'eac/fixture',channel:'eac',wire:'chat'}]
 const availability={results:{'big-pickle':{state:'access-restricted'},'space-bunny-free':{state:'available'}}}
 assert.deepEqual(computeMembership(catalog,availability,{})[ROUTE_MAIN],['space-bunny-free','eac/fixture'])
 const allRestricted={results:{'big-pickle':{state:'access-restricted'},'space-bunny-free':{state:'access-restricted'}}};assert.deepEqual(computeMembership(catalog,allRestricted,{})[ROUTE_MAIN],['eac/fixture'])
})

test('old green probe cache is downgraded once without erasing useful negative evidence',()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ofm-probe-upgrade-'))
 fs.writeFileSync(path.join(dataDir,'availability.json'),JSON.stringify({version:1,at:100,results:{old:{state:'available',at:100},denied:{state:'region-blocked',detail:'region'},quota:{state:'throttled'}}}))
 const stores=createRuntimeStores({dataDir,logger:{warn(){}}})
 try{const state=stores.availability.get();assert.equal(state.version,2);assert.equal(state.results.old.state,'unknown');assert.equal(state.results.old.at,0);assert.equal(state.results.denied.state,'region-blocked');assert.equal(state.results.quota.state,'throttled')}finally{stores.dispose()}
 const reopened=createRuntimeStores({dataDir,logger:{warn(){}}})
 try{assert.equal(reopened.availability.get().results.old.state,'unknown')}finally{reopened.dispose()}
})

test('probe total deadline includes waiting for headers and for EOF after terminal frames',async()=>{
 let mode='headers';const slow=await import('node:http').then(({default:http})=>http.createServer((req,res)=>{req.resume();req.on('end',()=>{if(mode==='headers'){setTimeout(()=>{if(!res.destroyed){res.writeHead(200,{'content-type':'text/event-stream'});res.end(chatFrames('OK'))}},160)}else{res.writeHead(200,{'content-type':'text/event-stream'});res.write(chatFrames('OK'));setTimeout(()=>res.end(),160)}})}))
 await new Promise(resolve=>slow.listen(0,'127.0.0.1',resolve))
 const originalFetch=globalThis.fetch
 globalThis.fetch=(input,options)=>originalFetch('http://127.0.0.1:'+slow.address().port+new URL(input).pathname,options)
 try{for(mode of ['headers','eof']){const at=performance.now();const verdict=await probeModel(buildCatalog(['space-bunny-free'])[0],{timeoutMs:30});assert.equal(verdict.state,STATE.unknown);assert.match(verdict.detail,/超时/);assert(performance.now()-at<140,'deadline must not await the 160ms delayed success')}}finally{globalThis.fetch=originalFetch;slow.closeAllConnections();await new Promise(resolve=>slow.close(resolve))}
})
test('shared generation parser preserves nested Responses policy refusal after partial output',async()=>{
 const {readStream}=await import('../src/stream.js');async function* lines(){yield JSON.stringify({type:'response.output_text.delta',item_id:'m',output_index:0,delta:'partial'});yield JSON.stringify({type:'response.failed',response:{status:'failed',error:envelope.error}})}
 await assert.rejects(async()=>{for await(const chunk of readStream(lines(),'responses',new Map())){}},{code:'LANE_LOCKED',type:'FreeTierError'})
})
test('unversioned old green cache does not inherit the new schema before migration',()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ofm-probe-legacy-'));fs.writeFileSync(path.join(dataDir,'availability.json'),JSON.stringify({results:{old:{state:'available',at:98765},region:{state:'region-blocked'}}}));const stores=createRuntimeStores({dataDir,logger:{warn(){}}});try{assert.equal(stores.availability.get().version,2);assert.equal(stores.availability.get().results.old.state,'unknown');assert.equal(stores.availability.get().results.old.at,0);assert.equal(stores.availability.get().results.region.state,'region-blocked')}finally{stores.dispose()}
})
