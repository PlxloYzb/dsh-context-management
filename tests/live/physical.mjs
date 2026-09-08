const releaseVersion = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8')).version
const evidenceRoot = `docs/evidence/v${releaseVersion.replaceAll('.', '')}`
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { webClient, responseText } from './client.mjs'
import { corpus, score } from './fixture.mjs'
const client=await webClient(process.argv[3] ?? '.test-runtime/web-capacity.log', Number(process.argv[4] ?? 3100)), fixture=corpus(2903)
const cwd=await mkdtemp(join(tmpdir(),'dsh-context-corpus-capacity-'))
for(let i=0;i<fixture.pages.length;i++)await writeFile(join(cwd,`page-${i+1}.txt`),fixture.pages[i])
const {sessionId}=await client.call('session/create',{cwd,agentPreset:'standard'})
await client.call('session/selectModel',{sessionId,provider:'opencode-go',model:'glm-5.3-flash'})
const report={schemaVersion:1,pluginVersion:releaseVersion,hostVersion:'0.1.2-rc.1',startedAt:new Date().toISOString(),sessionId,fixtureHash:fixture.hash,config:{strategy:'windowed',windowBudgetTokens:null,maxOutputTokens:8192,safetyMarginTokens:4096},turns:[],physicalOverflow:'NOT EXERCISED',completed:false,failures:[]}
if(process.argv[2]){const installation=JSON.parse(await readFile(process.argv[2],'utf8'));report.tarballHash=installation.tarballHash;report.installEvidence=process.argv[2]}
let events=[]
try{
 for(let page=1;page<=8;page++){
  const result=await client.prompt(sessionId,`Read the entire synthetic page-${page}.txt using a file-reading tool. Do not read any other file or edit anything. Preserve the exact engineering values and their original language. Do not proactively compress. Reply only READ-${page}-OK.`)
  events=result.events;report.turns.push({page,end:result.end,elapsedMs:result.elapsedMs});console.log(JSON.stringify({page,end:result.end}))
  if(result.end.kind!=='completed')throw new Error(`page ${page}: ${JSON.stringify(result.end)}`)
 }
 const result=await client.prompt(sessionId,'Return only exact original values for F01 through F12 as JSON. Do not read files or execute shell commands. Preserve their original language and spelling.')
 events=result.events;report.score=score(responseText(result.recent),fixture.facts);report.turns.push({stage:'recall',end:result.end,elapsedMs:result.elapsedMs})
 if(result.end.kind!=='completed')throw new Error('physical-capacity recall failed')
 report.completed=true
}catch(error){report.failures.push(error.message);try{events=await client.history(sessionId)}catch{}}
report.actualRoute=events.filter(e=>e.type==='request/header').map(e=>({seq:e.seq,provider:e.data.header.config.provider,model:e.data.header.config.model,maxTokens:e.data.header.config.maxTokens}))
report.requestContexts=events.filter(e=>e.type==='request/context').map(e=>({seq:e.seq,...e.data}))
report.usage=events.filter(e=>e.type==='assistant/message'&&e.data.usage).map(e=>({seq:e.seq,...e.data.usage}))
report.windows=events.filter(e=>e.type==='compaction/summary'&&e.data.contextManagement).map(e=>({seq:e.seq,...e.data.contextManagement}))
report.routeVerified=report.actualRoute.every(r=>r.provider==='opencode-go'&&r.model==='glm-5.3-flash')
report.finishedAt=new Date().toISOString();await mkdir(`${evidenceRoot}/live`,{recursive:true});await writeFile(`${evidenceRoot}/live/physical-capacity-${sessionId}.json`,JSON.stringify(report,null,2)+'\n');await writeFile(`${evidenceRoot}/live/physical-capacity.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({sessionId,completed:report.completed,failures:report.failures,score:report.score?.correct}))
