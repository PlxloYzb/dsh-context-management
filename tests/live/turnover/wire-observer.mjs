// Test-only wire evidence for one explicitly selected OpenAI Responses route.
// It observes cloned bodies only; the original fetch arguments and response are
// passed through unchanged.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const REQUEST_LIMIT = 2 * 1024 * 1024
const RESPONSE_LIMIT = 2 * 1024 * 1024
const TARGET_MODEL = 'muse-spark-1.3-contributor'
const digest = value => createHash('sha256').update(value).digest('hex')
const bytes = value => Buffer.byteLength(value)

function urlOf(input) {
  if (typeof input === 'string') return new URL(input)
  if (input instanceof URL) return input
  if (input && typeof input.url === 'string') return new URL(input.url)
  return undefined
}

function requestBody(init) {
  if (typeof init?.body === 'string') return init.body
  if (init?.body instanceof Uint8Array) return Buffer.from(init.body).toString('utf8')
  return undefined
}

async function boundedCloneText(response) {
  let clone
  try { clone = response.clone() }
  catch { return { code: 'response-clone-failed' } }
  if (!clone.body) return { code: 'response-body-unavailable' }
  const reader = clone.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > RESPONSE_LIMIT) {
        await reader.cancel('wire-observer response limit')
        return { code: 'response-too-large', bytes: total }
      }
      chunks.push(next.value)
    }
    return { text: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'), bytes: total }
  } catch {
    return { code: 'response-clone-read-failed' }
  } finally {
    reader.releaseLock()
  }
}

export function apply(ctx, config) {
  const output = config.output
  mkdirSync(output, { recursive: true, mode: 0o700 })
  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== 'function') throw new Error('wire-observer requires globalThis.fetch')
  let restored = false
  const record = row => appendFileSync(join(output, 'wire.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 })
  const restore = () => {
    if (restored) return
    restored = true
    if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch
  }
  const captureResponse = async (wireId, response, row) => {
    const captured = await boundedCloneText(response)
    if (captured.text === undefined) {
      record({ ...row, phase: 'response-skipped', completedAtMs: Date.now(), code: captured.code, responseBytes: captured.bytes ?? null })
      return
    }
    const responsePath = join(output, `wire-${wireId}.response.sse`)
    writeFileSync(responsePath, captured.text, { mode: 0o600 })
    record({ ...row, phase: 'response', completedAtMs: Date.now(), responseBytes: captured.bytes, responseRefHash: digest(captured.text) })
  }
  const wrappedFetch = async function wireObservedFetch(input, init) {
    const url = urlOf(input)
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase()
    const body = requestBody(init)
    let row
    if (method === 'POST' && url?.pathname.endsWith('/responses')) {
      if (body === undefined) {
        record({ phase: 'request-skipped', time: Date.now(), code: 'request-body-unavailable' })
      } else if (bytes(body) > REQUEST_LIMIT) {
        record({ phase: 'request-skipped', time: Date.now(), code: 'request-too-large', requestBytes: bytes(body) })
      } else {
        try {
          const payload = JSON.parse(body)
          if (payload?.model === TARGET_MODEL) {
            const wireId = randomUUID()
            const requestPath = join(output, `wire-${wireId}.request.json`)
            writeFileSync(requestPath, body, { mode: 0o600 })
            row = { wireId, time: Date.now(), status: null, requestBytes: bytes(body), payloadRefHash: digest(body) }
            record({ ...row, phase: 'request' })
          }
        } catch {
          record({ phase: 'request-skipped', time: Date.now(), code: 'request-json-invalid' })
        }
      }
    }
    const response = await originalFetch.apply(this, arguments)
    if (row) {
      const requestId = response.headers.get('x-request-id')
      void captureResponse(row.wireId, response, { ...row, status: response.status, ...(requestId ? { requestId } : {}) })
    }
    return response
  }
  globalThis.fetch = wrappedFetch
  ctx.on?.('dispose', restore)
  return restore
}
