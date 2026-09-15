import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { budgetState, recordUsage, reserveCall } from './limits.mjs'

async function limitsDirectory(t, limits) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-limits-'))
  await writeFile(join(root, 'limits.json'), JSON.stringify(limits))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('null token ceiling records usage without rejecting calls for token accumulation', async t => {
  const root = await limitsDirectory(t, { tokenCeiling: null, perCallConservativeReserve: 10, stopAtMs: Date.now() + 60_000 })
  reserveCall(root, 'first', { purpose: 'synthetic' })
  recordUsage(root, 'first', { inputTokens: 700, outputTokens: 500, totalTokens: 1_200 })
  reserveCall(root, 'second', { purpose: 'synthetic' })
  assert.deepEqual(budgetState(root), {
    limits: { tokenCeiling: null, perCallConservativeReserve: 10, stopAtMs: JSON.parse(await readFile(join(root, 'limits.json'), 'utf8')).stopAtMs },
    reservedTokens: 1_210,
    reportedTokens: 1_200,
    callCount: 2,
  })
})

test('null token ceiling still enforces the wall-clock stop', async t => {
  const root = await limitsDirectory(t, { tokenCeiling: null, perCallConservativeReserve: 10, stopAtMs: Date.now() - 1 })
  assert.throws(() => reserveCall(root, 'expired', { purpose: 'synthetic' }), /EXPERIMENT_BATCH_LIMIT/)
  assert.equal(budgetState(root).callCount, 0)
})

test('a finite token ceiling still rejects a call over the reservation limit', async t => {
  const root = await limitsDirectory(t, { tokenCeiling: 100, perCallConservativeReserve: 60, stopAtMs: Date.now() + 60_000 })
  reserveCall(root, 'first', { purpose: 'synthetic' })
  assert.throws(() => reserveCall(root, 'second', { purpose: 'synthetic' }), /EXPERIMENT_BATCH_LIMIT/)
  assert.equal(budgetState(root).reservedTokens, 60)
})

test('recorded usage is retained in the ledger and replaces the conservative reserve', async t => {
  const root = await limitsDirectory(t, { tokenCeiling: 100, perCallConservativeReserve: 60, stopAtMs: Date.now() + 60_000 })
  reserveCall(root, 'reported', { purpose: 'synthetic' })
  recordUsage(root, 'reported', { inputTokens: 7, outputTokens: 5, totalTokens: 12 })
  assert.deepEqual(budgetState(root), {
    limits: { tokenCeiling: 100, perCallConservativeReserve: 60, stopAtMs: JSON.parse(await readFile(join(root, 'limits.json'), 'utf8')).stopAtMs },
    reservedTokens: 12,
    reportedTokens: 12,
    callCount: 1,
  })
  const rows = (await readFile(join(root, 'usage-ledger.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows.length, 2)
  assert.equal(rows[1].totalTokens, 12)
})
