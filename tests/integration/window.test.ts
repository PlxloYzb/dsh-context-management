import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { WindowController, frozenPrefix, resolveArchiveConfig, windowEvidenceIndex, windowIdentity } from '../../src/window-controller.ts'
import { ArcStateStore } from '../../src/state.ts'
import { blockRegistry, rebuildBlockLedger, runCompactionTransaction, assertNoActiveCompaction } from '../../src/region.ts'
import { resolveShadowedTokenCount, runEmergencyFallback } from '../../src/fallback.ts'
import { allLogMessages } from '../../src/messages.ts'
import { host, newSession, oldWork, newInput } from './runtime.ts'
import { appendAssistant, appendToolCall, appendToolResult, appendUser } from '../helpers.ts'

const config = resolveArchiveConfig()
const signal = () => new AbortController().signal

test('W01/W02: intent waits for a balanced pre-step; duplicates preserve the first handoff and durable request identity', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'pending-pair')
  oldWork(session); newInput(session, 'LATEST: retention is 47 days, overriding 30 days.')
  const original = session.snapshotEvents(), currentUser = session.surface.nodes.at(-1)!
  const windows = new WindowController(), agent = { session, ctx: h.ctx, options: {} }
  session.append('step/start', { turn: 2, step: 1 })
  appendToolCall(session, 'request turnover', 'window-call', 2, 1)
  const before = session.surface.replaceGeneration
  const first = windows.accept(session, 'First handoff', 'window-call')
  assert.deepEqual(windows.accept(session, 'Ignored replacement handoff', 'duplicate-call'), first)
  assert.equal(session.surface.replaceGeneration, before, 'acceptance cannot replace a half-paired tool call')
  appendToolResult(session, JSON.stringify(first), 'window-call', 2, 1)
  session.append('step/end', { turn: 2, step: 1 })
  const selected = frozenPrefix(session)
  const measurement = h.ctx.tokenMeter.measure(session)
  const result = await windows.commitPending(agent, signal(), config, async () => { assert.equal(await h.ctx.sessions.flush(session), true) })
  assert.ok(result)
  assert.deepEqual(session.snapshotEvents().slice(0, original.length), original)
  assert.ok(session.surface.nodes.includes(currentUser))
  assert.equal(toolPairingBalancedAfter(session, session.surface.nodes.at(-1)!), true)
  assert.equal(result.shadowedTokenCount, measurement.nodes.filter(n => selected.includes(n.seq)).reduce((sum, n) => sum + n.heuristicTokens, 0))
  assert.match(JSON.stringify(result.summary), /First handoff/)
  assert.doesNotMatch(JSON.stringify(result.summary), /Ignored replacement/)
  assert.equal(windowIdentity(session).generation, 1)
  assert.deepEqual(windows.accept(session, 'replayed', 'window-call'), { status: 'no-op', code: 'already-committed', requestId: (first as {requestId:string}).requestId, generation: 1 })
  const ledger = rebuildBlockLedger(session.snapshotEvents())
  assert.equal(ledger[0]!.contextManagement?.operationId, result.compactionId)
  assert.match(JSON.stringify(result.summary), new RegExp(result.compactionId), 'checkpoint gives a usable archive block ID')
  assert.equal(ledger[0]!.kernelBlockId, undefined)
  assert.deepEqual(blockRegistry(session), [])
  assert.deepEqual(new ArcStateStore().stateFor(session).blocks, [])
})

test('W02/W04: cancellation, end-of-turn and empty history never advance a window', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'cancelled-intent'), windows = new WindowController()
  oldWork(session); newInput(session, 'Keep current task')
  const agent = { session, ctx: h.ctx, options: {} }
  assert.equal((windows.accept(session, 'x'.repeat(8001)) as {status:string}).status, 'error')
  windows.accept(session, 'pending')
  const abort = new AbortController(); abort.abort()
  assert.equal(await windows.commitPending(agent, abort.signal, config, async () => {}), null)
  assert.equal(windowIdentity(session).generation, 0)
  windows.accept(session, 'end turn')
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.equal(await windows.commitPending(agent, signal(), config, async () => {}), null)
  const empty = newSession(h.ctx, 'empty-window'); newInput(empty, 'one enormous current user input '.repeat(4000), 1)
  const before = empty.seq
  assert.equal(await windows.turnover({ session: empty, ctx: h.ctx, options: {} }, 'pressure', signal(), config, async () => {}), null)
  assert.equal(empty.seq, before)
  assert.equal(windowIdentity(empty).generation, 0)
})

test('W03/L03/L04: three windows replace old seeds, retain originals, survive actual JSONL restore and keep ARC state separate', async t => {
  const h = await host('zstd'); t.after(h.close)
  const session = newSession(h.ctx, 'three-windows'), windows = new WindowController()
  oldWork(session)
  const origin = session.snapshotEvents()
  for (let generation = 1; generation <= 3; generation++) {
    newInput(session, `LATEST constraint version ${generation}`, generation + 1)
    const currentUser = session.surface.nodes.at(-1)!
    const result = await windows.turnover({ session, ctx: h.ctx, options: {} }, 'manual', signal(), config, async () => { await h.ctx.sessions.flush(session) })
    assert.ok(result)
    assert.ok(session.surface.nodes.includes(currentUser))
    assert.equal(windowIdentity(session).generation, generation)
    assert.equal(session.surface.nodes.filter(seq => session.eventAt(seq)?.type === 'user/message' && (session.eventAt(seq)!.data as {source?:{plugin?:string}}).source?.plugin === 'compact').length, 1)
    for (let step = 1; step <= 16; step++) {
      session.append('step/start', { turn: generation + 1, step })
      appendAssistant(session, `generation ${generation}: ${'completed synthetic work; preserve constraints. '.repeat(80)}`, generation + 1, step)
      session.append('step/end', { turn: generation + 1, step })
    }
    session.append('turn/end', { turn: generation + 1, reason: {kind:'completed'} })
  }
  await h.ctx.sessions.flush(session)
  const stored = await h.ctx.sessionPersistence.inspect(session.id)
  assert.deepEqual(stored.events.slice(0, origin.length), origin)
  const restored = Session.create(session.id, stored.events)
  assert.deepEqual(restored.deriveMessages(), session.deriveMessages())
  assert.deepEqual(windowIdentity(restored), windowIdentity(session))
  assert.deepEqual(new ArcStateStore().stateFor(restored).blocks, [])
  assert.equal(allLogMessages(restored).length, restored.surface.nodes.length, 'window originals stay out of the active ARC work set')
})

for (const phase of ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'] as const) {
  for (const when of ['before', 'after'] as const) {
    test(`L01/L02: failure ${when} ${phase} preserves the source prefix and distinguishes applied state`, async t => {
      const h = await host(); t.after(h.close)
      const session = newSession(h.ctx, `fault-${phase.replace('/','-')}-${when}`)
      oldWork(session); newInput(session, 'Protect current request')
      await h.ctx.sessions.flush(session)
      const original = session.snapshotEvents(), windows = new WindowController(), append = session.append.bind(session)
      let injected = false
      session.append = ((type: string, ...args: unknown[]) => {
        if (type === phase && !injected) {
          injected = true
          if (when === 'before') throw new Error(`injected ${when} ${phase}`)
          Reflect.apply(append, session, [type, ...args])
          throw new Error(`injected ${when} ${phase}`)
        }
        return Reflect.apply(append, session, [type, ...args])
      }) as typeof session.append
      await assert.rejects(windows.turnover({ session, ctx: h.ctx, options: {} }, 'pressure', signal(), config, async () => { await h.ctx.sessions.flush(session) }), /injected/)
      session.append = append
      assert.deepEqual(session.snapshotEvents().slice(0, original.length), original)
      const applied = session.surface.replaceGeneration > 0
      assert.equal(rebuildBlockLedger(session.snapshotEvents()).length, applied ? 1 : 0)
      assert.equal(windowIdentity(session).generation, applied ? 1 : 0)
      if (applied) assert.throws(() => windows.assertReady(session), /recovery-required/)
      else windows.assertReady(session)
      await h.ctx.sessions.flush(session)
      const stored = await h.ctx.sessionPersistence.inspect(session.id)
      assert.deepEqual(stored.events.slice(0, original.length), original)
      const restored = Session.create(session.id, stored.events)
      assert.equal(windowIdentity(restored).generation, applied ? 1 : 0)
      assertNoActiveCompaction(restored.snapshotEvents())
    })
  }
}

test('L02: flush rejection after replacement blocks all subsequent mutation; no second archive', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'flush-failure'), windows = new WindowController()
  oldWork(session); newInput(session, 'Keep latest')
  await assert.rejects(windows.turnover({ session, ctx:h.ctx, options:{} }, 'pressure', signal(), config, async () => { throw new Error('disk fault') }), /disk fault/)
  const revision = session.seq
  assert.equal(windowIdentity(session).generation, 1)
  await assert.rejects(windows.turnover({ session, ctx:h.ctx, options:{} }, 'pressure', signal(), config, async () => {}), /recovery-required/)
  assert.equal(session.seq, revision)
})

test('B03/C03: request image price differs from the persisted heuristic price; nonmonotonic exact range stays legal', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'nonmonotonic')
  oldWork(session); newInput(session, 'Protect this')
  const first = session.surface.nodes.slice(0, 3)
  const agent = { session, ctx: h.ctx, options: {} }
  const tx = runCompactionTransaction(session, { start:first[0]!, end:first.at(-1)!, shadowedSeqs:first, summary:[{type:'text',text:'older summary'}], shadowedTokenCount:resolveShadowedTokenCount(agent,first),provider:'local',model:'local',kernelBlockId:'b1' })
  const prefix = frozenPrefix(session)
  assert.ok(prefix[0]! > prefix.at(-1)!, 'checkpoint seq precedes older nodes on the surface')
  const before = h.ctx.tokenMeter.measure(session).totalTokens
  const result = await new WindowController().turnover(agent, 'pressure', signal(), config, async()=>{await h.ctx.sessions.flush(session)})
  assert.ok(result)
  assert.ok(h.ctx.tokenMeter.measure(session).totalTokens < before)
  assert.equal(blockRegistry(session).find(b=>b.blockId===tx.compactionId)?.active,false)
  assert.equal(new ArcStateStore().stateFor(session).blocks.find(b=>b.blockId==='b1')?.active,false)
  const fake = { ...agent, ctx: { get: () => ({measure:()=>({logRevision:session.seq,nodes:[{seq:SessionSeq(1),tokens:9999,heuristicTokens:77}]})}) } }
  assert.equal(resolveShadowedTokenCount(fake, [1]), 77)
})

test('W03: original user amendments survive successive locally indexed window handoffs', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'user-amendment')
  const controller = new WindowController(), agent = { session, ctx: h.ctx, options: {} }
  oldWork(session)
  newInput(session, 'Amendment: the delivery region is 华东 and the revised timeout is 3471ms. Later instructions supersede the original specification.')
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  for (let i = 0; i < 3; i++) {
    oldWork(session)
    newInput(session, `Continue stage ${i}, keeping existing requirements.`)
    const result = await controller.turnover(agent, 'pressure', new AbortController().signal, resolveArchiveConfig(), async () => { await h.ctx.sessions.flush(session) })
    assert.ok(result)
    const text = result.summary.map(block => block.type === 'text' ? block.text : '').join('')
    assert.match(text, /3471ms/)
    assert.match(text, /华东/)
    assert.ok(Buffer.byteLength(text) <= 4096)
  }
})

test('W03: bounded window index keeps exact structured tool evidence across parent checkpoints and translated model handoffs', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'structured-handoff'), controller = new WindowController()
  oldWork(session)
  newInput(session, 'Read configuration and preserve the exact deployment values.')
  session.append('step/start', { turn: 2, step: 1 })
  appendToolCall(session, 'read configuration', 'structured-call', 2, 1)
  appendToolResult(session, '3: "deployment_region": "华东-港口",\n4: "timeout_ms": 3741,\n' + 'repeated healthy telemetry\n'.repeat(1000), 'structured-call', 2, 1)
  session.append('step/end', { turn: 2, step: 1 }); session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  for (let i = 0; i < 3; i++) {
    newInput(session, `Continue current work ${i}`, i + 3)
    if (i > 0) controller.accept(session, 'Deployment region: East China Port. Continue the configuration migration. '.repeat(25), `handoff-${i}`)
    const result = i > 0
      ? await controller.commitPending({ session, ctx: h.ctx, options: {} }, signal(), config, async () => { await h.ctx.sessions.flush(session) })
      : await controller.turnover({ session, ctx: h.ctx, options: {} }, 'manual', signal(), config, async () => { await h.ctx.sessions.flush(session) })
    assert.ok(result)
    const text = result.summary.map(block => block.type === 'text' ? block.text : '').join('')
    assert.match(text, /"deployment_region": "华东-港口"/)
    assert.match(text, /"timeout_ms": 3741/)
    assert.ok(Buffer.byteLength(text) <= 4096)
    session.append('turn/end', { turn: i + 3, reason: { kind: 'completed' } })
    oldWork(session, i + 10, 5)
  }
})

test('W03/W04: a newly created ARC checkpoint is new work for turnover; a lone window seed remains a no-op', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'arc-after-window'), controller = new WindowController(), agent = { session, ctx: h.ctx, options: {} }
  oldWork(session); newInput(session, 'Work after first window')
  assert.ok(await controller.turnover(agent, 'pressure', signal(), config, async () => { await h.ctx.sessions.flush(session) }))
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  oldWork(session, 3); newInput(session, 'CURRENT: retain this original request', 4)
  const selected = session.surface.nodes.slice(1, -1)
  runCompactionTransaction(session, { start: selected[0]!, end: selected.at(-1)!, shadowedSeqs: selected, summary: [{ type: 'text', text: 'Locally compressed subsequent work. '.repeat(150) }], shadowedTokenCount: resolveShadowedTokenCount(agent, selected), provider: 'local', model: 'test' })
  const current = session.surface.nodes.at(-1)!
  const result = await controller.turnover(agent, 'pressure', signal(), config, async () => { await h.ctx.sessions.flush(session) })
  assert.ok(result); assert.equal(windowIdentity(session).generation, 2)
  assert.ok(session.surface.nodes.includes(current))
  assert.equal(await controller.turnover(agent, 'pressure', signal(), config, async () => {}), null)
  assert.equal(windowIdentity(session).generation, 2)
})


test('mid-turn emergency fallback never shadows the most recent surface nodes (150k iteration regression)', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'preserve-recent-midturn')
  session.append('turn/start', { turn: 1 }); appendUser(session, 'OLD small work.')
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 }); appendUser(session, 'LATEST phase instruction: read all pages.')
  session.append('step/start', { turn: 1, step: 1 })
  appendAssistant(session, 'Small compressible history. ', 1, 1)
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  for (let i = 0; i < 6; i++) {
    session.append('step/start', { turn: 2, step: i + 1 })
    appendToolCall(session, `operation ${i}`, `call-${i}`, 2, i + 1)
    appendToolResult(session, `recent tool payload ${i} with detail. `.repeat(200), `call-${i}`, 2, i + 1)
    session.append('step/end', { turn: 2, step: i + 1 })
  }
  const incomingUser = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'NEWEST instruction while the turn is in flight' }] })
  const agent = { session, ctx: h.ctx, options: {} }
  const result = runEmergencyFallback(agent, { incomingUser, includeCheckpoints: true })
  assert.ok(result, 'a compressible balanced range exists')
  const surface = session.surface.nodes
  const preservedFrom = surface[surface.length - 5]!
  assert.ok(result!.shadowedRange.end < preservedFrom, `emergency range end ${result!.shadowedRange.end} must stop before the preserved recent tail (from ${preservedFrom}); in-flight bookkeeping of the last tool exchanges must survive`)
})

test('emergency fallback takes multiple net-reducing bites and anchors recent work (150k mini regression)', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'fallback-bites')
  session.append('turn/start', { turn: 1 }); appendUser(session, 'OLD compressible work in three blocks.')
  for (let block = 0; block < 3; block++) {
    session.append('step/start', { turn: 1, step: block + 1 })
    appendToolCall(session, `operation ${block}`, `old-call-${block}`, 1, block + 1)
    appendToolResult(session, `Compressible historical tool payload ${block}. `.repeat(400), `old-call-${block}`, 1, block + 1)
    session.append('step/end', { turn: 1, step: block + 1 })
  }
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  appendToolCall(session, 'experiment_read_page', 'call-live', 2, 1)
  appendToolResult(session, 'page 217 content', 'call-live', 2, 1)
  session.append('step/end', { turn: 2, step: 1 })
  const agent = { session, ctx: h.ctx, options: {} }
  const summariesBefore = session.snapshotEvents().filter(event => event.type === 'compaction/summary').length
  const result = runEmergencyFallback(agent, { includeCheckpoints: true })
  assert.ok(result, 'fallback produced a transaction')
  const summaries = session.snapshotEvents().filter(event => event.type === 'compaction/summary')
  assert.ok(summaries.length - summariesBefore >= 1, 'fallback committed at least one transaction')
  // Step-aligned recency must take WHOLE historical steps (both completed tool
  // pairs) in one bite instead of splitting a pair at the recency boundary.
  const shadowed = new Set<number>(result!.shadowedSeqs)
  assert.ok(shadowed.has(3) && shadowed.has(4) && shadowed.has(7) && shadowed.has(8), `bite should cover both complete historical pairs, got ${[...shadowed]}`)
  assert.ok(!shadowed.has(11) && !shadowed.has(12), 'the preserved recent steps survive')
  const checkpoint = JSON.stringify(summaries.map(event => session.eventAt(SessionSeq(event.seq + 1))))
  assert.match(checkpoint, /RECENT WORK STILL VISIBLE/, 'checkpoint anchors the still-visible recent tool calls')
  assert.match(checkpoint, /bash\(/, 'the surviving tool call is enumerated in the anchor')
  assert.ok(session.surface.nodes.includes(session.surface.nodes.at(-1)!), 'latest surface node survives')
})

test('window seed evidence index keeps quoted identifier=value records, and emergency checkpoints keep early fact-dense lines under budget pressure (150k adaptive v9 regression)', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx, 'seed-fact-records')
  session.append('turn/start', { turn: 1 }); appendUser(session, 'Begin synthetic evidence.')
  // Early fact-dense tool result (the shape the JSON-only index missed).
  session.append('step/start', { turn: 1, step: 1 })
  appendToolCall(session, 'read', 'seed-call-0', 1, 1)
  appendToolResult(session, 'Observation header.\nAuthoritative historical fact: F01 = "alpha-nuance-4711".\nAuthoritative historical fact: F02 = "beta-caret-9932".\nObservation tail noise. '.repeat(40), 'seed-call-0', 1, 1)
  session.append('step/end', { turn: 1, step: 1 })
  // Many later noisy events that would evict the early one chronologically.
  for (let i = 1; i <= 24; i++) {
    session.append('step/start', { turn: 1, step: i + 1 })
    appendToolCall(session, `op ${i}`, `seed-call-${i}`, 1, i + 1)
    appendToolResult(session, `Routine telemetry block ${i}: state=warming replicas=3. `.repeat(60), `seed-call-${i}`, 1, i + 1)
    session.append('step/end', { turn: 1, step: i + 1 })
  }
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  const agent = { session, ctx: h.ctx, options: {} }
  // 1) Evidence index must carry the quoted identifier=value records.
  const evidence = windowEvidenceIndex(session, session.surface.nodes.filter((seq, index) => index < session.surface.nodes.length - 1), 4096)
  assert.match(evidence, /F01 = "alpha-nuance-4711"/, 'quoted identifier=value record enters the seed evidence index')
  assert.match(evidence, /F02 = "beta-caret-9932"/)
  // 2) Value-ranked emergency checkpoint keeps the fact-dense early line.
  const result = runEmergencyFallback(agent, { includeCheckpoints: true })
  assert.ok(result, 'fallback lands')
  const checkpoint = JSON.stringify(session.snapshotEvents().filter(event => event.type === 'compaction/summary').map(event => session.eventAt(SessionSeq(event.seq + 1))))
  assert.match(checkpoint, /alpha-nuance-4711/, 'early authoritative fact line survives the bounded emergency checkpoint')
})
