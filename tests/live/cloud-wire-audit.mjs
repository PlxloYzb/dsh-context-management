// Pair actual synthetic HTTP inputs and outputs without publishing headers or raw bodies.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const root = resolve(process.argv[2] ?? '')
assert.ok(root.startsWith(resolve('.test-runtime/turnover-muse-20260915') + '/'))
const report = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'))
assert.ok(report.completed && report.kind === 'foreground-input-diagnostic' && report.settingsUnchanged)
const marker = `fresh-${report.seed}-7e0183`, hash = bytes => createHash('sha256').update(bytes).digest('hex')
const rows = (await readFile(join(root, 'wire.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
const pairs = []
for (const request of rows.filter(r => r.phase === 'request')) {
  const response = rows.find(r => r.wireId === request.wireId && r.phase === 'response')
  assert.ok(response && response.status === 200)
  const body = await readFile(join(root, `wire-${request.wireId}.request.json`))
  const sse = await readFile(join(root, `wire-${request.wireId}.response.sse`))
  assert.equal(hash(body), request.payloadRefHash); assert.equal(hash(sse), response.responseRefHash)
  const input = JSON.parse(body), events = sse.toString().split('\n').filter(l => l.startsWith('data: ')).flatMap(line => { try { return [JSON.parse(line.slice(6))] } catch { return [] } })
  const completed = events.find(e => e.type === 'response.completed')?.response
  assert.ok(completed, 'A completed HTTP response is required for attribution')
  assert.equal(input.model, 'muse-spark-1.3-contributor'); assert.equal(input.reasoning.effort, 'minimal')
  const foreground = input.input.some(message => message.role === 'user' && JSON.stringify(message.content).includes(marker))
  const text = completed.output.flatMap(o => o.content ?? []).filter(c => c.type === 'output_text').map(c => c.text).join('\n')
  pairs.push({ role: foreground ? 'foreground' : 'summary', currentInstructionDelivered: foreground, inputItems: input.input.length, cacheKey: input.prompt_cache_key ?? null, responseId: completed.id, text, responseActions: completed.output.filter(o => o.type === 'function_call').map(o => ({ name: o.name, arguments: o.arguments })), requestHash: request.payloadRefHash, responseHash: response.responseRefHash })
}
const foreground = pairs.filter(p => p.role === 'foreground'), summaries = pairs.filter(p => p.role === 'summary')
assert.ok(foreground.length && summaries.length)
assert.equal(foreground.at(-1).text.trim(), report.stages[0].answer.trim(), 'The host must deliver the text from the corresponding foreground HTTP response')
const output = { name: report.name, capturedHttpRequests: pairs.length, allHttp200: true, allMuseMinimal: true, separateResponseIds: new Set(pairs.map(p => p.responseId)).size === pairs.length, sharedCacheKey: new Set(pairs.map(p => p.cacheKey)).size === 1 && pairs[0].cacheKey !== null, foregroundInstructionDelivered: true, hostOutputMatchesForegroundResponse: true, foregroundInstructionPassed: report.foregroundInstructionPassed, serverActions: foreground.flatMap(p => p.responseActions), pairs: pairs.map(({ role, currentInstructionDelivered, inputItems, responseActions, requestHash, responseHash }) => ({ role, currentInstructionDelivered, inputItems, responseActions, requestHash, responseHash })) }
await writeFile(join(root, 'wire-audit.json'), JSON.stringify(output, null, 2) + '\n')
console.log(JSON.stringify(output))
