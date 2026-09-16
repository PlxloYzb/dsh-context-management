// Append-only supervisor event log and the checkpoint view derived from it.
// The log is the source of truth; the checkpoint is an atomic advisory view.
import { appendFileSync, readFileSync, existsSync, createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicJson } from './context.mjs'

export const CHECKPOINT_SCHEMA = 1

export function createEventLog(root) {
  const path = join(root, 'supervisor-events.jsonl')
  return {
    path,
    append(event) {
      const row = { time: new Date().toISOString(), monotonicMs: Date.now(), ...event }
      const line = JSON.stringify(row) + '\n'
      appendFileSync(path, line, { mode: 0o600 })
      return { bytes: Buffer.byteLength(line), row }
    },
    // Reads only complete lines. A torn trailing line is reported, never
    // silently dropped: callers must decide whether the writer still owns it.
    read() {
      if (!existsSync(path)) return { rows: [], completeBytes: 0, tornTail: '' }
      const text = readFileSync(path, 'utf8')
      const lastNewline = text.lastIndexOf('\n')
      const body = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1)
      const tornTail = lastNewline === -1 ? text : text.slice(lastNewline + 1)
      const rows = []
      for (const line of body.split('\n')) {
        if (!line) continue
        try { rows.push(JSON.parse(line)) } catch { rows.push({ malformed: true, line }) }
      }
      return { rows, completeBytes: Buffer.byteLength(body), tornTail }
    },
  }
}

export async function logDigest(path) {
  if (!existsSync(path)) return { bytes: 0, sha256: null }
  const { size } = await stat(path)
  const hash = createHash('sha256')
  await new Promise((resolvePromise, reject) => {
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('end', resolvePromise).on('error', reject)
  })
  return { bytes: size, sha256: hash.digest('hex') }
}

export async function writeCheckpoint(root, checkpoint) {
  const value = { schemaVersion: CHECKPOINT_SCHEMA, updatedAt: new Date().toISOString(), ...checkpoint }
  await atomicJson(join(root, 'checkpoint.json'), value)
  return value
}

export function readCheckpoint(root) {
  const path = join(root, 'checkpoint.json')
  if (!existsSync(path)) return null
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (value.schemaVersion !== CHECKPOINT_SCHEMA) throw new Error(`Unknown checkpoint schema ${value.schemaVersion}`)
  return value
}

// Prompt dispatch journal: durable intent before dispatch, terminal state after
// reconciliation. A planned row without an ack is the ambiguous-dispatch window.
// It is a separate append-only file so the monitor event log stays pure.
export function createPromptJournal(root) {
  const path = join(root, 'dispatch.jsonl')
  const read = () => {
    if (!existsSync(path)) return { rows: [], malformed: [], tornTail: '' }
    const text = readFileSync(path, 'utf8')
    const lastNewline = text.lastIndexOf('\n')
    const body = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1)
    const tornTail = lastNewline === -1 ? text : text.slice(lastNewline + 1)
    const rows = [], malformed = []
    for (const line of body.split('\n')) {
      if (!line) continue
      try { rows.push(JSON.parse(line)) } catch { malformed.push(line) }
    }
    return { rows, malformed, tornTail }
  }
  const append = row => appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), ...row }) + '\n', { mode: 0o600 })
  const rows = () => read().rows
  return {
    path,
    read,
    plan({ logicalPromptId, requestId, contentHash, expectedEpisode, beforeSeq }) {
      const existing = rows().find(row => row.logicalPromptId === logicalPromptId)
      if (existing) throw new Error(`PROMPT_ALREADY_PLANNED: ${logicalPromptId}`)
      append({ kind: 'prompt', phase: 'planned', logicalPromptId, requestId, contentHash, expectedEpisode, beforeSeq, dispatchState: 'planned' })
    },
    ack(logicalPromptId, evidence = {}) {
      append({ kind: 'prompt', phase: 'ack', logicalPromptId, dispatchState: 'accepted', ...evidence })
    },
    complete(logicalPromptId, evidence = {}) {
      append({ kind: 'prompt', phase: 'completed', logicalPromptId, dispatchState: 'completed', ...evidence })
    },
    fail(logicalPromptId, reason, evidence = {}) {
      append({ kind: 'prompt', phase: 'failed', logicalPromptId, dispatchState: 'failed', reason, ...evidence })
    },
    ambiguous(logicalPromptId, evidence = {}) {
      append({ kind: 'prompt', phase: 'ambiguous', logicalPromptId, dispatchState: 'ambiguous', ...evidence })
    },
    stateOf(logicalPromptId) {
      const matching = rows().filter(row => row.logicalPromptId === logicalPromptId)
      if (matching.some(row => row.dispatchState === 'ambiguous')) return 'ambiguous'
      if (matching.some(row => row.phase === 'completed')) return 'completed'
      if (matching.some(row => row.phase === 'failed')) return 'failed'
      if (matching.some(row => row.phase === 'ack')) return 'accepted'
      if (matching.some(row => row.phase === 'planned')) return 'planned'
      return 'unknown'
    },
    rows,
  }
}

export function newRequestId() {
  return randomUUID()
}
