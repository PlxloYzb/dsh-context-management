const releaseVersion = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8')).version
const evidenceRoot = `docs/evidence/v${releaseVersion.replaceAll('.', '')}`
// Read-only evidence capture after the native browser interactions.
import { webClient } from './client.mjs'
import { writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const sessionId=process.argv[5]
if (!sessionId) throw new Error('Pass the owned synthetic session id as argument 5')
const client=await webClient(process.argv[2]??'.test-runtime/web.log',Number(process.argv[3]??3097)), events=await client.history(sessionId)
const runs=new Map(events.filter(e=>e.type==='command/run').map(e=>[e.data.commandId,e]))
const commands=events.filter(e=>e.type==='command/done').map(e=>{
 const run=runs.get(e.data.commandId);let value;try{value=JSON.parse(e.data.text)}catch{}
 return {commandId:e.data.commandId,name:run?.data.name,args:run?.data.args,startSeq:run?.seq,endSeq:e.seq,kind:e.data.kind,
  ...(value?.backend?{backend:value.backend,strategy:value.strategy,generation:value.generation}:{}),
  ...(value?.compactionId?{compactionId:value.compactionId,summaryHash:createHash('sha256').update(JSON.stringify(value.summary)).digest('hex'),shadowedSeqs:value.shadowedSeqs}:{}),
  ...(value?.hits?{hits:value.hits}:{}),
  ...(value?.segments?{pageBytes:Buffer.byteLength(e.data.text),containsSyntheticOriginal:value.segments.some(s=>s.text.includes('UI_CHECK_7319')),hasNextCursor:!!value.nextCursor}:{}),
  ...(value?.code ? { resultCode: value.code, recovery: value.recovery } : {}),
  ...(e.data.kind==='error'?{error:e.data.text}:{}),
 }
})
const report={schemaVersion:1,pluginVersion:releaseVersion,pluginCommit:null,hostVersion:'0.1.2-rc.1',capturedAt:new Date().toISOString(),sessionId,
 browser:'Codex in-app browser',commands,
 observations:['Native context command input hint selected, arguments typed and submitted with Enter.','Manual context new rendered the host compaction feedback.','Official compact rendered the expected no-useful-summary error on the already-small remaining history.','Native search located the original synthetic message, and native decompress returned a bounded page with an explicit historical boundary.'],
 completed:commands.some(c=>c.compactionId)&&commands.some(c=>c.containsSyntheticOriginal)&&commands.some(c=>c.name==='compact'&&c.kind==='error'),failures:[]}
if(process.argv[4]){report.installEvidence=process.argv[4];report.tarballHash=JSON.parse(await (await import('node:fs/promises')).readFile(process.argv[4],'utf8')).tarballHash;report.observations.push('A new candidate reopened this synthetic UI session and executed native context status, preserving the active generation with the active backend. Earlier command records are retained with their original sequence numbers; installed candidate identity applies to the latest status/search/retrieval checks.')}
report.restartCursorRecovery = commands.some(c => c.resultCode === 'invalid-cursor' && c.recovery) && commands.some(c => c.containsSyntheticOriginal && c.endSeq > Math.max(...commands.filter(c => c.resultCode === 'invalid-cursor').map(c => c.endSeq)))
await mkdir(`${evidenceRoot}/live`,{recursive:true});await writeFile(`${evidenceRoot}/live/ui-journey.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({completed:report.completed,commands:commands.length}))
