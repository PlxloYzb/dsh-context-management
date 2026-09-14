// Offline byte/provenance audit of one local Web/model run; no provider calls.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { Session } from '@deepseek-ai/dsh-session'
import { ArchiveReader, resolveSources, eventTextParts } from '../../src/archive.ts'
import { observedEvents } from './local/observed-events.mjs'
const root=resolve(process.argv[2]??'')
assert.ok(root.startsWith(resolve('.test-runtime')+'/'),'Audit only retained private experiment output')
const summary=JSON.parse(await readFile(join(root,'summary.json'),'utf8'))
assert.ok(summary.finishedAt,'Audit a stopped run, never racing its evidence writer')
const fixture=JSON.parse(await readFile(join(root,'fixture.json'),'utf8'))
const observed=join(root,'observed')
const rows=await observedEvents(observed,summary.sessionId)
// The run may have used an older candidate. Record the current reader separately
// so an offline compatibility audit cannot be mistaken for a new model journey.
const readerArchiveSourceHash=createHash('sha256').update(await readFile(new URL('../../src/archive.ts',import.meta.url))).digest('hex')
const session=Session.create(summary.sessionId,rows),reader=new ArchiveReader(),ledger=reader.ledger(session)
const inputs=[{observed,sessionId:summary.sessionId}],exposed=new Set()
if(summary.fork){
 assert.match(summary.fork.name,/^[a-z0-9-]+$/)
 const parentRoot=resolve(root,'..',summary.fork.name),parent=JSON.parse(await readFile(join(parentRoot,'summary.json'),'utf8'))
 assert.equal(parent.fixture.hash,fixture.hash);assert.equal(parent.sessionId,summary.fork.sessionId)
 const parentObserved=join(parentRoot,'observed'),parentEvents=await observedEvents(parentObserved,parent.sessionId)
 assert.deepEqual(rows.filter(e=>e.seq<=summary.fork.throughSeq),parentEvents.filter(e=>e.seq<=summary.fork.throughSeq),'Fork changed its inherited event prefix')
 inputs.push({observed:parentObserved,sessionId:parent.sessionId,throughSeq:summary.fork.throughSeq})
}
let requestObjectsVerified=0
const pageByText=new Map(fixture.pages.map((text,index)=>[text,index+1]))
function strings(value){
 const out=[],stack=[value]
 while(stack.length){
  const item=stack.pop()
  if(typeof item==='string')out.push(item)
  else if(Array.isArray(item))stack.push(...item)
  else if(item&&typeof item==='object')stack.push(...Object.values(item))
 }
 return out
}
for(const input of inputs){
 const requestRows=(await readFile(join(input.observed,`${input.sessionId}.provider-messages.jsonl`),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(row=>input.throughSeq===undefined||row.seq<=input.throughSeq)
 const refs=new Set(requestRows.flatMap(row=>row.messageRefs));requestObjectsVerified+=refs.size
 for(const ref of refs){
 const object=JSON.parse(await readFile(join(input.observed,'objects',`${ref}.json`),'utf8'))
 assert.equal(createHash('sha256').update(JSON.stringify(object)).digest('hex'),ref,'Observed object hash changed')
 for(const text of strings(object)){
  const exact=pageByText.get(text)
  if(exact)exposed.add(exact)
  // Adapters may wrap a returned page in a bounded diagnostic envelope.
  else if(text.length>=fixture.pageChars)for(let i=0;i<fixture.pages.length;i++)if(text.includes(fixture.pages[i]))exposed.add(i+1)
 }
}
}
let restoredBytes=0,segments=0
for(const block of ledger){
 const sources=resolveSources(session,block.shadowedSeqs,ledger)
 assert.equal(sources.incomplete,false,'Synthetic archive has missing/corrupt sources')
 const expected=new Map()
 for(const seq of sources.seqs)for(const part of eventTextParts(session.eventAt(seq)).texts)expected.set(`${seq}:${JSON.stringify(part.path)}`,part.text)
 const recovered=new Map();let cursor
 for(let page=0;page<5000;page++){
  const result=reader.decompress(session,{blockId:block.blockId,maxTokens:4096,...(cursor?{cursor}:{})})
  assert.equal(result.status,'success');assert.equal(result.incomplete,false)
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=4096)
  for(const segment of result.segments){
   // Tool-call-only messages have no original text block.
   if(!expected.has(`${segment.seq}:${JSON.stringify(segment.textBlockPath)}`)&&segment.text==='')continue
   const key=`${segment.seq}:${JSON.stringify(segment.textBlockPath)}`
   const before=recovered.get(key)??''
   assert.equal(segment.offset,before.length,'Continuation offset skipped or repeated original text')
   recovered.set(key,before+segment.text);restoredBytes+=Buffer.byteLength(segment.text);segments++
  }
  cursor=result.nextCursor
  if(!cursor)break
 }
 assert.equal(cursor,null,'Archive audit cursor did not finish')
 assert.deepEqual(recovered,expected,'Archive retrieval changed original bytes or dropped a text part')
}
const consumption=JSON.parse(await readFile(join(root,'control',`${summary.sessionId}.consumption.json`),'utf8'))
const notExposed=consumption.pages.filter(page=>!exposed.has(page))
const report={schemaVersion:1,name:summary.name,checkedAt:new Date().toISOString(),fixtureHash:fixture.hash,candidateHash:summary.candidateHash,stoppedRunError:summary.error??null,taskCompleted:summary.completed===true,probeOnly:!!summary.fork,inheritedPages:summary.fork?.inheritedPages??0,declaredPages:fixture.pageCount,toolReadPages:summary.fork?0:consumption.pages.length,exactPagesInRequests:exposed.size,notExposed,requestObjectsVerified,archives:ledger.length,restoredBytes,segments,archiveBytesVerified:true,completed:notExposed.length===0}
report.compactionsObserved=rows.filter(e=>e.type==='compaction/summary').map(e=>({seq:e.seq,kind:e.data.contextManagement?.kind??'in-place-fallback'}))
report.readerArchiveSourceHash=readerArchiveSourceHash
await writeFile(join(root,'audit.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})
console.log(JSON.stringify(report))
if(notExposed.length)process.exitCode=1
