import test from 'node:test'
import assert from 'node:assert/strict'
import { SummaryJob, overlapMs } from '../turnover/summary-job.mjs'
const snapshot = { sessionId: 'synthetic', generation: 0, throughSeq: 40, prefixHash: 'frozen', route: 'local' }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('ready summary is single-use and bound to its prefix', async () => {
  const job = new SummaryJob(snapshot, async () => 'verified facts')
  await job.done
  assert.deepEqual(job.consume(snapshot), { status: 'ready', text: 'verified facts' })
  assert.equal(job.consume(snapshot).status, 'consumed')
})
test('late response cannot alter a committed fallback', async () => {
  const deferredResult = deferred(), job = new SummaryJob(snapshot, () => deferredResult.promise)
  assert.equal(job.consume(snapshot).status, 'pending')
  assert.equal(job.controller.signal.aborted, true)
  deferredResult.resolve('too late'); await job.done
  assert.equal(job.state, 'late'); assert.equal(job.text, undefined)
})
test('generation, session, route, and prefix mismatches all discard ready work', async () => {
  for (const key of Object.keys(snapshot)) {
    const job = new SummaryJob(snapshot, async () => 'facts'); await job.done
    assert.equal(job.consume({ ...snapshot, [key]: 'changed' }).status, 'stale')
    assert.equal(job.text, undefined)
  }
})
test('cancel and disposal own even providers that ignore abort', async () => {
  for (const reason of ['cancelled', 'disposed']) {
    const d = deferred(), job = new SummaryJob(snapshot, () => d.promise)
    job.cancel(reason); d.resolve('ignored abort'); await job.done
    assert.equal(job.state, reason); assert.equal(job.text, undefined)
  }
})
test('errors, empty and oversized summaries fail closed', async () => {
  for (const [generate, status] of [[async () => { throw new Error('synthetic') }, 'failed'], [async () => '', 'invalid'], [async () => 'x'.repeat(1401), 'invalid']]) {
    const job = new SummaryJob(snapshot, generate); await job.done
    assert.equal(job.consume(snapshot).status, status)
  }
})
test('timeout aborts pending work without awaiting the provider', async () => {
  const d = deferred(), job = new SummaryJob(snapshot, () => d.promise, { timeoutMs: 5 })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(job.state, 'timeout'); assert.equal(job.controller.signal.aborted, true)
  await job.settled
  d.resolve('late'); await job.done; assert.equal(job.text, undefined)
})
test('request overlap uses intersecting intervals, not concurrent dispatch alone', () => {
  assert.equal(overlapMs({ start: 0, end: 10 }, { start: 5, end: 15 }), 5)
  assert.equal(overlapMs({ start: 0, end: 10 }, { start: 10, end: 15 }), 0)
})
