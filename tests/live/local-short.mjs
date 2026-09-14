// One bounded, review-between-runs local-model experiment. Never schedules a batch.
import {readFile,writeFile,mkdir,mkdtemp,unlink} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {homedir,tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {execFileSync,spawn} from 'node:child_process'
import {startHost} from './local/runtime.mjs'
import {atomicJson} from './local/protocol.mjs'
import {promptControlled,requestRecords} from './local/request-client.mjs'
import {makeFixture,familyBrief,correctionMessage,familyUpdate} from './local/fixtures.mjs'
import {scoreAnswer,finalQuestion,jsonObjects} from './local/scoring.mjs'
import {responseText} from './client.mjs'
import assert from 'node:assert/strict'
import {observedEvents} from './local/observed-events.mjs'
const args=Object.fromEntries(process.argv.slice(2).map(v=>{const i=v.indexOf('=');return[v.slice(2,i),v.slice(i+1)]}))
const arm=args.arm??'C400_WINDOWED',family=args.family??'F3',seed=Number(args.seed??91501),pageCount=Number(args.pages??48),pressure=Number(args.pressure??48000),batch=Number(args.batch??6)
const concise=args.concise==='true'
const forkName=args['fork-from']
const nudges=args.nudges
if(nudges!==undefined&&!['true','false'].includes(nudges))throw new Error('nudges must be true or false')
const restart=args.restart==='true',name=args.name,isPlugin=['C400_WINDOWED','B_IN_PLACE'].includes(arm)
if(!name||!/^[a-z0-9-]+$/.test(name)||!['A_NATIVE','C400_WINDOWED','B_IN_PLACE'].includes(arm)||!['F1','F3','F4','F5','F6'].includes(family))throw new Error('Invalid experiment configuration')
if(forkName&&!/^[a-z0-9-]+$/.test(forkName))throw new Error('Fork source must name a retained local run')
if(![seed,pageCount,pressure,batch].every(Number.isSafeInteger)||pageCount<24||pageCount>(forkName?1152:144)||pressure<24000||pressure>150000||batch<1||batch>12)throw new Error('Outside bounded reading/replay geometry')
const night=resolve('.test-runtime/nightly-20260915'),root=join(night,name),lock=join(night,'active.lock')
const pinned=resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/.bin/dsh')
const hostVersion=JSON.parse(await readFile(resolve('.test-runtime/host-pins/dsh-0.1.2-rc.1/node_modules/@deepseek-ai/dsh/package.json'),'utf8')).version
if(hostVersion!=='0.1.2-rc.1')throw new Error('Host version changed')
process.env.EXPERIMENT_DSH_BIN=pinned
const modelInfo=await fetch('http://127.0.0.1:18000/v1/models',{signal:AbortSignal.timeout(8000)}).then(r=>{if(!r.ok)throw new Error(`Local route HTTP ${r.status}`);return r.json()})
if(!modelInfo.data.some(m=>m.id==='Qwen3.8-27B-NVFP4KV-384K'&&m.max_model_len===393216))throw new Error('Local model identity/capacity mismatch')
await mkdir(night,{recursive:true})
await writeFile(lock,JSON.stringify({pid:process.pid,name,startedAt:new Date().toISOString()}),{flag:'wx',mode:0o600})
let host,sessionId,ticker,deadlineTimer,caffeine,summary,spec,finished=false,abortReject
const runAbort=new AbortController()
const deadline=new Promise((_,reject)=>{abortReject=reject});deadline.catch(()=>{})
async function abort(reason){if(finished)return;runAbort.abort(new Error(reason));abortReject(new Error(reason));if(host&&sessionId)await host.client.call('session/cancel',{sessionId}).catch(()=>{})}
process.once('SIGTERM',()=>{void abort('EXPERIMENT_INTERRUPTED_SIGTERM')})
process.once('SIGINT',()=>{void abort('EXPERIMENT_INTERRUPTED_SIGINT')})
const maxMs=25*60000,started=Date.now(),route={provider:'ubuntu-lora',model:'Qwen3.8-27B-NVFP4KV-384K'}
let maxTokens=8192
const hash=b=>createHash('sha256').update(b).digest('hex')
async function nightState(){
 const text=await readFile(join(night,'state.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return '{}';throw error})
 return JSON.parse(text)
}
async function events(){return JSON.parse(await readFile(join(spec.observed,`${sessionId}.events.json`),'utf8').catch(()=> '[]'))}
async function consumption(){return JSON.parse(await readFile(join(root,'control',`${sessionId}.consumption.json`),'utf8').catch(()=>'{"pages":[],"operations":[]}'))}
async function historyCalls(){return(await events()).filter(e=>e.type==='assistant/message').flatMap(e=>(e.data?.message?.content??[]).filter(b=>b.type==='tool-call'&&['search_context','decompress','arc_status'].includes(b.name))).length}
let progressTail=Promise.resolve()
function progress(){
 const pending=progressTail.then(writeProgress);progressTail=pending.catch(()=>{});return pending
}
async function writeProgress(){
 if(!summary||!spec)return
 const records=await requestRecords(join(spec.observed,'requests.jsonl')).catch(()=>[]),seen=await consumption().catch(()=>({pages:[]}))
 const inheritedPages=summary.fork?.inheritedPages??0
 const row={name,pid:process.pid,hostPid:host?.child.pid,stage:summary.stage,time:new Date().toISOString(),elapsedSeconds:Math.round((Date.now()-started)/1000),pagesRead:seen.pages.length,pagesExpected:pageCount,inheritedPages,newPagesRead:Math.max(0,seen.pages.length-inheritedPages),calls:records.length,pending:records.filter(r=>r.dispatched&&!r.terminal).map(r=>({callId:r.callId,ageSeconds:Math.round((Date.now()-Date.parse(r.time))/1000)})),finished}
 await atomicJson(join(root,'progress.json'),row)
}
async function persist(){await atomicJson(join(root,'summary.json'),summary);await progress()}
async function prompt(stage,text){
 summary.stage=stage;await persist()
 const result=await Promise.race([promptControlled(host.client,spec,sessionId,text,{turnSeconds:600,requestSeconds:420,signal:runAbort.signal}),deadline])
 if(result.end.kind!=='completed')throw new Error(`${stage}: turn ended ${JSON.stringify(result.end)}`)
 return result
}
try{
 await mkdir(root,{recursive:false})
 for(const sub of['control','observed','budget'])await mkdir(join(root,sub))
 caffeine=spawn('/usr/bin/caffeinate',['-i','-w',String(process.pid)],{stdio:'ignore'})
 deadlineTimer=setTimeout(()=>{void abort('EXPERIMENT_WALL_TIMEOUT: 25 minutes')},maxMs)
 let parent,throughSeq,inheritedEvents
 let lengthClass='short'
 if(forkName){
  const parentRoot=join(night,forkName)
  parent=JSON.parse(await readFile(join(parentRoot,'summary.json'),'utf8'))
  const parentFixture=JSON.parse(await readFile(join(parentRoot,'fixture.json'),'utf8'))
  const parentAudit=JSON.parse(await readFile(join(parentRoot,'audit.json'),'utf8'))
  assert.ok(parentAudit.completed&&parentAudit.archiveBytesVerified&&parentAudit.exactPagesInRequests===pageCount,'Fork requires an audited complete reading source')
  assert.equal(parent.hostVersion,hostVersion,'Fork host version changed')
  lengthClass=parentFixture.lengthClass
  assert.ok(['short','long'].includes(lengthClass),'Unknown source fixture class')
  maxTokens=parent.geometry.maxTokens
  assert.ok(Number.isSafeInteger(maxTokens)&&maxTokens>=8192&&maxTokens<=32768,'Unsupported parent output reserve')
 }
 const fixture=makeFixture({family,seed,lengthClass,pageCount}),fixturePath=join(root,'fixture.json')
 await atomicJson(fixturePath,fixture)
 if(forkName){
  const parentRoot=join(night,forkName)
  assert.ok(parent.finishedAt&&!parent.fork,'Fork only a stopped, original reading run')
  assert.ok(parent.phases.length===4&&parent.phases.every(p=>p.end==='completed'&&!p.missingPages.length),'Fork requires every assigned page read')
  assert.equal(parent.fixture.hash,fixture.hash,'Fork fixture changed')
  assert.equal(parent.arm,arm,'A probe fork cannot change experimental arm')
  assert.equal(parent.geometry.pressure,pressure,'Fork pressure changed')
  assert.equal(parent.geometry.batch,batch,'Fork reading geometry changed')
  assert.equal(parent.concise,concise,'Fork prompt configuration changed')
  const parentEvents=JSON.parse(await readFile(join(parentRoot,'observed',`${parent.sessionId}.events.json`),'utf8'))
  const boundary=parentEvents.find(e=>e.type==='turn/end'&&e.data.turn===4&&e.data.reason.kind==='completed')
  assert.ok(boundary,'Completed reading boundary missing')
  throughSeq=boundary.seq
  inheritedEvents=parentEvents.filter(e=>e.seq<=throughSeq)
 }
 const profile=isPlugin?'ctx-v012-smoke-c':'ctx-v012-mini-native'
 const built=await readFile('dist/index.js'),installed=await readFile(join(homedir(),'.dsh/profiles/ctx-v012-smoke-c/node_modules/dsh-context-management/dist/index.js'))
 if(isPlugin&&hash(built)!==hash(installed))throw new Error('Install current built candidate before running C')
 const effective=Math.ceil(pressure/0.9),windowBudget=effective+maxTokens+4096
 if(parent)assert.equal(parent.geometry.windowBudget,windowBudget,'Fork logical window changed')
 let ratio=pressure/393216;for(let i=0;Math.floor(393216*ratio)<pressure&&i<8;i++)ratio+=Number.EPSILON
 const insert=[...(!isPlugin?[{id:'experiment-configurator',name:resolve('tests/live/local/configurator.mjs'),config:{output:root,arm,basicRatio:ratio,mainMaxTokens:maxTokens}}]:[]),{id:'experiment-fixture-tools',name:resolve('tests/live/local/fixture-tools.mjs'),config:{controlRoot:join(root,'control')}},{id:'experiment-observer',name:resolve('tests/live/local/request-observer.mjs'),config:{output:join(root,'observed'),route,mainMaxTokens:maxTokens,expectedContextWindow:393216,budgetRoot:join(root,'budget')}}]
 const patches=[...(isPlugin?[{id:'compaction-context-management-bridge',config:{...(nudges===undefined?{}:{autoNudge:nudges==='true'}),adaptiveGovernor:{enabled:true,strategy:arm==='B_IN_PLACE'?'in-place':'windowed',windowBudgetTokens:windowBudget,maxOutputTokens:maxTokens,safetyMarginTokens:4096,nudgeAtEffectiveCapacityPct:0.75,emergencyAtEffectiveCapacityPct:0.9,targetAfterTurnoverPct:0.55,emergencyFallback:true},archive:{seedMaxTokens:4096,retrievalDefaultMaxTokens:2048,retrievalMaxTokens:4096}}}]:[]),{insert}]
 const patch=join(root,'host.patch.yml');await writeFile(patch,JSON.stringify(patches,null,2),{mode:0o600})
 await atomicJson(join(root,'budget','limits.json'),{tokenCeiling:8000000,perCallConservativeReserve:393216,stopAtMs:started+maxMs})
 spec={dshBin:pinned,root,directory:root,observed:join(root,'observed'),controlRoot:join(root,'control'),profile,patch,port:3311,route}
 summary={schemaVersion:1,name,arm,family,seed,startedAt:new Date(started).toISOString(),hostVersion,route,nodeVersion:process.version,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),candidateHash:hash(built),runnerHash:hash(await readFile(import.meta.filename)),fixture:{pageCount,hash:fixture.hash,newTextHeuristicTokens:fixture.newTextHeuristicTokens},geometry:{strategy:isPlugin?(arm==='B_IN_PLACE'?'in-place':'windowed'):'Basic',pressure,effective,windowBudget,maxTokens,batch,routeCapacity:393216},restart,concise,readingInstructionVersion:parent?(parent.readingInstructionVersion??1):2,limits:{wallSeconds:1500,turnSeconds:600,requestSeconds:420},stage:'starting',phases:[]}
 summary.autoNudge=isPlugin?(nudges===undefined||nudges==='true'):null
 if(parent)summary.fork={name:forkName,sessionId:parent.sessionId,throughSeq,candidateHash:parent.candidateHash,inheritedPages:pageCount,sourceOutputReserve:maxTokens,classification:'Probe-only boundary replay; not an independent end-to-end run'}
 await writeFile(join(root,'runner-snapshot.mjs'),await readFile(import.meta.filename),{mode:0o600})
 const helperNames=['runtime.mjs','protocol.mjs','request-client.mjs','fixtures.mjs','scoring.mjs','fixture-tools.mjs','request-observer.mjs','limits.mjs','configurator.mjs','observed-events.mjs']
 await mkdir(join(root,'helper-snapshot'))
 summary.helperHashes=Object.fromEntries(await Promise.all(helperNames.map(async file=>{const bytes=await readFile(new URL(`./local/${file}`,import.meta.url));await writeFile(join(root,'helper-snapshot',file),bytes,{mode:0o600});return[file,hash(bytes)]})))
 await persist()
 ticker=setInterval(()=>{void progress().catch(()=>{})},15000)
 const state=await nightState();await atomicJson(join(night,'state.json'),{...state,status:'running',currentRun:{name,pid:process.pid,root,startedAt:summary.startedAt},nextAction:'Inspect summary.json and progress.json; choose next run only after reviewing this result.'})
 const cwd=parent?undefined:await mkdtemp(join(tmpdir(),'dsh-context-experiment-short-'))
 host=await startHost(spec,`${name}-${Date.now()}`)
 sessionId=(parent?await host.client.call('session/fork',{sessionId:parent.sessionId,atSeq:throughSeq}):await host.client.call('session/create',{cwd,agentPreset:'standard'})).sessionId;summary.sessionId=sessionId
 await host.client.call('session/selectModel',{sessionId,...route})
 const controlPath=join(root,'control',`${sessionId}.control.json`)
 if(parent){
  await atomicJson(join(root,'control',`${sessionId}.consumption.json`),{pages:Array.from({length:pageCount},(_,i)=>i+1),operations:[],inheritedFrom:forkName})
  // Establish the prompt poller's inherited cursor before the first probe;
  // the observer replaces this with the complete real child snapshot at turn end.
  await atomicJson(join(spec.observed,`${sessionId}.events.json`),inheritedEvents)
 }
 let first=1
 for(let phase=0;!parent&&phase<fixture.phases.length;phase++){
  const last=fixture.phases[phase]
  await atomicJson(controlPath,{phase:'reading',fixturePath,firstPage:first,lastPage:last})
  const intro=phase===0?familyBrief(family,seed):`${correctionMessage(seed,phase)}\n${familyUpdate(family,seed,phase)}`
  const result=await prompt(`reading-${phase+1}`,`${intro}\nRead EVERY page ${first} through ${last} in ascending page-number order. Use up to ${batch} parallel experiment_read_page calls per step, filling each batch unless fewer assigned pages remain. Continue until all assigned pages are returned. ${phase===3&&family==='F4'?'Now apply the documented workflow exactly once in order.':''} ${concise?`After the final assigned page, respond with only PHASE_${phase+1}_COMPLETE. Do not write a recap, diagnosis or fact list in this reading turn. Continue the task in the next turn; optional context maintenance must not delay this phase-completion response.`:`Reply PHASE_${phase+1}_COMPLETE after finishing; do not invent facts from unread pages.`}`)
  const seen=new Set((await consumption()).pages),missing=Array.from({length:last-first+1},(_,i)=>first+i).filter(p=>!seen.has(p))
  summary.phases.push({phase:phase+1,elapsedMs:result.elapsedMs,missingPages:missing,end:result.end.kind});await persist()
  console.log(JSON.stringify({name,phase:phase+1,elapsedSeconds:Math.round(result.elapsedMs/1000),missing:missing.length}))
  if(missing.length)throw new Error(`INCOMPLETE_READING: phase ${phase+1} missing ${missing.length}`)
  first=last+1
 }
 await atomicJson(controlPath,{phase:'probe',fixturePath,firstPage:1,lastPage:1})
 if(restart){
  summary.stage='restarting';await persist()
  const before=await host.client.history(sessionId),beforePid=host.child.pid
  assert.ok(before.length>0,'Restart requires an existing persisted history')
  const throughSeq=before.at(-1).seq
  await host.stop()
  assert.ok(host.child.exitCode!==null||host.child.signalCode!==null,'Original host did not exit')
  host=await startHost(spec,`${name}-restart-${Date.now()}`)
  assert.notEqual(host.child.pid,beforePid,'Restart did not create a new host process')
  const after=(await host.client.history(sessionId)).filter(e=>e.seq<=throughSeq)
  assert.deepEqual(after,before,'Restart changed or lost persisted history')
  summary.restartEvidence={beforePid,afterPid:host.child.pid,throughSeq,eventCount:before.length,beforeHash:hash(JSON.stringify(before)),afterHash:hash(JSON.stringify(after))}
  summary.restartVerified=true
  await persist()
 }
 const beforeP1=await historyCalls(),p1=await prompt('facts-probe',finalQuestion(family))
 summary.score=scoreAnswer(responseText(p1.recent),fixture,{operations:(await consumption()).operations})
 summary.retrievalsDuringP1=(await historyCalls())-beforeP1;summary.p1ElapsedMs=p1.elapsedMs;await persist()
 const targetPages=[Math.max(1,Math.floor(pageCount*0.08)),Math.floor(pageCount*0.32),Math.floor(pageCount*0.62)]
 const truth=Object.fromEntries(targetPages.map(p=>[`PAGE-${p}`,fixture.pages[p-1].match(/checksum=([0-9a-f]+)/)?.[1]]))
 const beforeP2=await historyCalls(),p2=await prompt('verbatim-probe',`Independent blind probe: from ORIGINAL historical source pages, report the exact checksum= hexadecimal value of the FIRST observation line on ${targetPages.map(p=>`PAGE-${p}`).join(', ')}. Recover exact evidence with installed search_context/decompress if needed. Return JSON with these page IDs as keys and checksum strings as values. Unavailable values must be null.`)
 const answer=jsonObjects(responseText(p2.recent)).map(x=>x.value).findLast(o=>Object.keys(truth).some(k=>Object.hasOwn(o,k)))
 summary.score2={verbatimCorrect:Object.keys(truth).filter(k=>answer?.[k]===truth[k]).length,verbatimTotal:3,answer:answer??null}
 summary.retrievalsDuringP2=(await historyCalls())-beforeP2;summary.p2ElapsedMs=p2.elapsedMs
 summary.completed=true
 summary.verbatimPassed=summary.score2.verbatimCorrect===summary.score2.verbatimTotal
}catch(error){
 if(summary)summary.error=String(error.message??error)
 else console.error(String(error.message??error))
 process.exitCode=1
}finally{
 finished=true;clearInterval(ticker);clearTimeout(deadlineTimer)
 if(host)await host.stop().catch(()=>{});caffeine?.kill('SIGTERM')
 if(summary){
  summary.finishedAt=new Date().toISOString();summary.elapsedSeconds=Math.round((Date.now()-started)/1000);summary.stage='finished'
  try {
   const finalEvents=await observedEvents(spec.observed,sessionId)
   await atomicJson(join(spec.observed,`${sessionId}.events.json`),finalEvents)
  } catch(error) { summary.evidenceError=String(error.message??error);process.exitCode=1 }
  const rows=await requestRecords(join(spec.observed,'requests.jsonl')).catch(()=>[])
  summary.calls=rows.length;summary.reportedTokens=rows.reduce((n,r)=>n+(Number.isFinite(r.usage?.totalTokens)?r.usage.totalTokens:0),0)
  summary.modelElapsedMs=rows.reduce((n,r)=>n+(r.elapsedMs??0),0)
  summary.compactions=(await events().catch(()=>[])).filter(e=>e.type==='compaction/summary').map(e=>({seq:e.seq,kind:e.data.contextManagement?.kind??'in-place-fallback'}))
  const access=(await readFile(join(root,'control','tool-access.jsonl'),'utf8').catch(()=> '')).trim().split('\n').filter(Boolean).map(JSON.parse)
  summary.deniedTools=access.filter(r=>r.status==='DENIED').map(r=>({name:r.name,reason:r.reason}))
  summary.strictPassed=summary.completed===true&&!summary.evidenceError&&summary.score?.passed===true&&summary.deniedTools.length===0&&(!restart||summary.restartVerified===true)
  summary.allQualityPassed=summary.strictPassed&&summary.verbatimPassed===true
  await persist();console.log(JSON.stringify({name,completed:summary.completed??false,strictPassed:summary.strictPassed,facts:summary.score?.factsCorrect,corrections:summary.score?.correctionsCorrect,deliverable:summary.score?.deliverablePassed,verbatim:summary.score2?.verbatimCorrect,compactions:summary.compactions.length,calls:summary.calls,tokens:summary.reportedTokens,elapsedSeconds:summary.elapsedSeconds,error:summary.error??null}))
  const state=await nightState();await atomicJson(join(night,'state.json'),{...state,status:'awaiting-result-review',currentRun:null,lastRun:{name,root,strictPassed:summary.strictPassed,completed:summary.completed??false},nextAction:'Review the preserved result before another experiment; diagnose failure or select one new dimension.'})
 }
 await unlink(lock).catch(()=>{})
}
