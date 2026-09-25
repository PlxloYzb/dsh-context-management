import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArchiveReader, resolveSources, eventTextParts } from '../../src/archive.ts'
import { runCompactionTransaction, rebuildBlockLedger } from '../../src/region.ts'
import { resolveShadowedTokenCount } from '../../src/fallback.ts'
import { WindowController, resolveArchiveConfig } from '../../src/window-controller.ts'
import { host, newSession, oldWork, newInput } from './runtime.ts'
import { appendToolCall, appendToolResult, appendUser } from '../helpers.ts'

interface Page { status: string; code?: string; segments: {seq:number;textBlockPath:number[];offset:number;text:string;nonText:{status:string}[]}[]; nextCursor: string | null; incomplete: boolean }
const signal = () => new AbortController().signal

test('R01: search cursor pages deduplicate shared parent sources without merging distinct identical messages', async t => {
  const h=await host();t.after(h.close)
  const session=newSession(h.ctx,'parent-search-duplicates')
  session.append('turn/start',{turn:1})
  appendUser(session,'ORIGINAL_DUPLICATE evidence');const first=session.surface.nodes.at(-1)!
  appendUser(session,'ORIGINAL_DUPLICATE evidence');const second=session.surface.nodes.at(-1)!
  appendUser(session,'Protect current request')
  const archive=(seqs:typeof session.surface.nodes)=>runCompactionTransaction(session,{start:seqs[0]!,end:seqs.at(-1)!,shadowedSeqs:seqs,summary:[{type:'text',text:'Parent checkpoint'}],shadowedTokenCount:resolveShadowedTokenCount({session,ctx:h.ctx,options:{}},seqs),provider:'local',model:'test'})
  archive([first]);archive(session.surface.nodes.slice(0,2));archive(session.surface.nodes.slice(0,1))
  const reader=new ArchiveReader()
  for(let pass=0;pass<2;pass++){
    let cursor:string|undefined;const found:number[]=[]
    for(let page=0;page<12;page++){
      const result=reader.search(session,{query:'ORIGINAL_DUPLICATE',limit:1,...(cursor?{cursor}:{})}) as {hits:{seq:number}[];nextCursor:string|null}
      found.push(...result.hits.map(hit=>hit.seq));cursor=result.nextCursor??undefined
      if(!cursor)break
    }
    assert.equal(cursor,undefined);assert.deepEqual(found,[first,second])
  }
})

test('R01: a warm source index follows newly committed nested archives and stays session-local', async t => {
  const h = await host(); t.after(h.close)
  const reader = new ArchiveReader()
  for (const name of ['source-index-first', 'source-index-second']) {
    const session = newSession(h.ctx, name)
    session.append('turn/start', { turn: 1 })
    appendUser(session, `${name} ORIGINAL_ONE`)
    const first = session.surface.nodes.at(-1)!
    appendUser(session, 'Current instruction')
    const archive = (operationId: string, selected: typeof session.surface.nodes) => runCompactionTransaction(session, {
      operationId, start: selected[0]!, end: selected.at(-1)!, shadowedSeqs: selected,
      summary: [{ type: 'text', text: 'Nested checkpoint' }],
      shadowedTokenCount: resolveShadowedTokenCount({ session, ctx: h.ctx, options: {} }, selected),
      provider: 'local', model: 'test',
    })
    archive('same-first-block-id', [first])
    assert.equal((reader.search(session, { query: 'ORIGINAL_ONE' }) as { hits: unknown[] }).hits.length, 1)
    const checkpoint = session.surface.nodes[0]!
    appendUser(session, `${name} ORIGINAL_TWO`)
    const second = session.surface.nodes.at(-1)!
    appendUser(session, 'Protect latest instruction')
    archive('same-second-block-id', [second])
    archive('same-parent-block-id', [checkpoint])
    const page = reader.decompress(session, { blockId: 'same-parent-block-id' }) as Page
    assert.equal(page.status, 'success'); assert.equal(page.incomplete, false)
    assert.equal(page.segments.map(segment => segment.text).join(''), `${name} ORIGINAL_ONE`)
    const search = reader.search(session, { query: 'ORIGINAL_TWO' }) as { hits: { seq: number; snippet: string }[] }
    assert.equal(search.hits.length, 1); assert.equal(search.hits[0]!.seq, second)
    assert.ok(search.hits[0]!.snippet.includes(name))
  }
})

test('R03: search packs multiple hits into a small grant without dropping byte-boundary matches', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'search-serialized-budget')
  session.append('turn/start', { turn: 1 })
  const original = Array.from({ length: 18 }, (_, i) => `item-${i}: needle ${'甲🙂"\\\r\n'.repeat(8)}`).join('')
  appendUser(session, original); const source = session.surface.nodes.at(-1)!
  appendUser(session, 'Protect latest instruction')
  runCompactionTransaction(session, {
    start: source, end: source, shadowedSeqs: [source], summary: [{ type: 'text', text: 'Search fixture' }],
    shadowedTokenCount: resolveShadowedTokenCount({ session, ctx: h.ctx, options: {} }, [source]), provider: 'local', model: 'test',
  })
  const expected = [...original.matchAll(/needle/g)].map(match => match.index)
  for (const budget of [1100, 1536, 4096]) {
    const reader = new ArchiveReader(), offsets: number[] = []
    let cursor: string | undefined
    for (let page = 0; page < 30; page++) {
      const result = reader.search(session, { query: 'needle', limit: 20, cursor }, budget) as {
        status: string; hits: { seq: number; offset: number }[]; nextCursor: string | null; incomplete: boolean
      }
      assert.equal(result.status, 'success'); assert.equal(result.incomplete, false)
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= budget)
      if (page === 0 && budget === 1536) assert.ok(result.hits.length > 1, 'Do not discard usable grant space')
      for (const hit of result.hits) { assert.equal(hit.seq, source); offsets.push(hit.offset) }
      cursor = result.nextCursor ?? undefined
      if (!cursor) break
    }
    assert.equal(cursor, undefined); assert.deepEqual(offsets, expected)
  }
})

test('R03/R04: paginated text blocks preserve Unicode, CRLF, whitespace and empty text exactly; cursors are scoped and tamper evident', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'unicode-archive')
  session.append('turn/start',{turn:1})
  const expected = ['  甲🙂\r\n e\u0301\t '.repeat(900), '', '尾部\r\n  空白  ']
  session.append('user/message',createUserMessage({source:{kind:'user'},content:expected.map(text=>({type:'text',text}))}),{surfaceOp:'append'})
  const source = session.surface.nodes[0]!
  appendUser(session, 'Latest instruction remains outside the archive')
  const block = runCompactionTransaction(session,{start:source,end:source,shadowedSeqs:[source],summary:[{type:'text',text:'Unicode text archive'}],shadowedTokenCount:resolveShadowedTokenCount({session,ctx:h.ctx,options:{}},[source]),provider:'local',model:'test'})
  const reader = new ArchiveReader(), recovered = new Map<string,string>()
  let cursor: string | undefined, pages = 0
  do {
    const result = reader.decompress(session,{blockId:block.compactionId,...(cursor?{cursor}:{})}) as Page
    assert.equal(result.status,'success'); assert.equal(result.incomplete,false)
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2048)
    for (const segment of result.segments) {
      const key = segment.textBlockPath.join('.')
      assert.equal(segment.offset, (recovered.get(key) ?? '').length)
      assert.ok(!/[\uD800-\uDBFF]$/u.test(segment.text), 'no high surrogate at a page boundary')
      recovered.set(key,(recovered.get(key)??'')+segment.text)
    }
    if (pages++ === 0) {
      const token = result.nextCursor!
      assert.ok(token.length <= 60)
      const forged = `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`
      assert.equal((reader.decompress(session,{blockId:block.compactionId,cursor:forged}) as Page).code,'invalid-cursor')
      assert.equal((new ArchiveReader().decompress(session,{blockId:block.compactionId,cursor:token}) as Page).code,'invalid-cursor')
      const foreign = Session.create(SessionId('foreign'),session.snapshotEvents())
      assert.equal((reader.decompress(foreign,{blockId:block.compactionId,cursor:token}) as Page).code,'invalid-cursor')
      appendUser(session,'Pure appends keep an existing source cursor usable')
    }
    cursor=result.nextCursor??undefined
    assert.ok(pages<1000)
  } while(cursor)
  assert.deepEqual([...recovered.values()],expected)
  assert.ok(pages>1)
  assert.equal((reader.decompress(session,{blockId:block.compactionId,maxTokens:4097}) as Page).code,'invalid-arguments')
  assert.equal((reader.decompress(session,{blockId:block.compactionId},500) as Page).code,'insufficient-headroom')
})

test('R01/R02: pruner replacement inside a window remains searchable and recoverable through original tool-result provenance',async t=>{
  const h=await host();t.after(h.close)
  const session=newSession(h.ctx,'pruned-source')
  session.append('turn/start',{turn:1});appendUser(session,'Consume tool evidence')
  session.append('step/start',{turn:1,step:1});appendToolCall(session,'read evidence','pruned-call')
  const original='noise '.repeat(5000)+'ORIGINAL_MIDDLE_7319'+' noise'.repeat(5000)
  appendToolResult(session,original,'pruned-call')
  const oldResult=session.surface.nodes.at(-1)!
  session.append('step/end',{turn:1,step:1});session.append('turn/end',{turn:1,reason:{kind:'completed'}})
  const oldEvent=session.eventAt(oldResult)!
  session.append('tool/result',{...oldEvent.data,message:{...(oldEvent.data as {message:object}).message,content:[{type:'text',text:'Pruned head and tail; full original retained in provenance.'}]}} as never,{surfaceOp:{op: 'replace', startSeq: oldResult, endSeq: oldResult },sourceEventSeqs:[oldResult]})
  newInput(session,'Continue with the current correction')
  // A small pruned surface still needs enough older material to shrink usefully.
  const selected=session.surface.nodes.slice(0,-1), reader=new ArchiveReader()
  const block=runCompactionTransaction(session,{start:selected[0]!,end:selected.at(-1)!,shadowedSeqs:selected,summary:[{type:'text',text:'Frozen pruned work'}],shadowedTokenCount:resolveShadowedTokenCount({session,ctx:h.ctx,options:{}},selected),provider:'local',model:'test'})
  const resolved=resolveSources(session,rebuildBlockLedger(session.snapshotEvents())[0]!.shadowedSeqs)
  assert.ok(resolved.seqs.includes(oldResult));assert.equal(resolved.incomplete,false)
  const search=reader.search(session,{query:'ORIGINAL_MIDDLE_7319'}) as {hits:{seq:number;snippet:string}[];incomplete:boolean}
  assert.equal(search.incomplete,false);assert.ok(search.hits.some(hit=>hit.seq===oldResult&&hit.snippet.includes('ORIGINAL_MIDDLE_7319')))
  let cursor:string|undefined, text=''
  for(let i=0;i<1000;i++){
    const page=reader.decompress(session,{blockId:block.compactionId,...(cursor?{cursor}:{})}) as Page
    for(const segment of page.segments) if(segment.seq===oldResult)text+=segment.text
    cursor=page.nextCursor??undefined;if(!cursor)break
  }
  assert.equal(text,original)
})

test('R04/L05: unique prefixes, unsupported schemas, source holes and missing attachments are explicit',async t=>{
  const h=await host();t.after(h.close)
  const session=newSession(h.ctx,'archive-errors');oldWork(session);newInput(session,'current')
  const agent={session,ctx:h.ctx,options:{}}
  for(const operationId of ['shared-prefix-one','shared-prefix-two']){
    const selected=session.surface.nodes.slice(1,3)
    runCompactionTransaction(session,{operationId,start:selected[0]!,end:selected.at(-1)!,shadowedSeqs:selected,summary:[{type:'text',text:'Archive checkpoint'}],shadowedTokenCount:resolveShadowedTokenCount(agent,selected),provider:'local',model:'test'})
  }
  const reader=new ArchiveReader()
  assert.equal((reader.decompress(session,{blockId:'shared-prefix'}) as Page).code,'ambiguous-block')
  assert.equal((reader.decompress(session,{blockId:'shared-prefix-one'}) as Page).status,'success')
  assert.equal(resolveSources(session,[999999]).incomplete,true)
  const image={type:'image',attachment:{attachmentId:'missing-image',mediaType:'image/png',bytes:30,width:1,height:1}}
  const parts=eventTextParts({type:'user/message',seq:0,time:0,data:{content:[image]}} as never,()=> 'missing-attachment')
  assert.equal(parts.nonText[0]!.status,'missing-attachment')
  const window=await new WindowController().turnover(agent,'pressure',signal(),resolveArchiveConfig(),async()=>{await h.ctx.sessions.flush(session)})
  assert.ok(window)
  const corrupted=session.snapshotEvents().map(event=>event.type==='compaction/summary'&&event.data.compactionId===window.compactionId?{...event,data:{...event.data,contextManagement:{schemaVersion:999}}}:event)
  const future=Session.create(SessionId('future-schema'),corrupted)
  assert.equal((reader.decompress(future,{blockId:window.compactionId}) as Page).code,'unsupported-schema')
})
