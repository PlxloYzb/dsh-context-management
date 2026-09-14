// Identical bounded fixture tools and monotonic tool permissions for all arms.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { familyExpectation } from './fixtures.mjs'
export const inject = ['tools']
const historyTools = new Set(['arc_status', 'new_context', 'compress', 'decompress', 'search_context'])
const fixtureTools = new Set(['experiment_read_page', 'experiment_work_file', 'experiment_write_file', 'experiment_apply_operation'])
const sourceFiles = new Set(['policy.js', 'normalize.js', 'limits.js'])
const output = { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  render: (_args, value) => [{ type: 'text', text: value.text }] }
export function apply(ctx, config) {
  mkdirSync(config.controlRoot, { recursive: true })
  const cache = new Map()
  const owned = agent => String(agent?.session.header.cwd ?? '').includes('dsh-context-experiment-')
  const log = row => appendFileSync(join(config.controlRoot, 'tool-access.jsonl'), JSON.stringify({ time: new Date().toISOString(), ...row }) + '\n', { mode: 0o600 })
  function state(agent) {
    if (!owned(agent)) throw new Error('Fixture tool requires an owned experiment session')
    const control = JSON.parse(readFileSync(join(config.controlRoot, `${agent.session.id}.control.json`), 'utf8'))
    let local = cache.get(agent.session.id)
    if (!local) {
      const fixture = JSON.parse(readFileSync(control.fixturePath, 'utf8'))
      const journalPath = join(config.controlRoot, `${agent.session.id}.consumption.json`)
      const saved = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : { pages: [], operations: [] }
      local = { fixture, pages: new Set(saved.pages), operations: saved.operations, journalPath }
      cache.set(agent.session.id, local)
    }
    return { control, local }
  }
  function persist(local) {
    writeFileSync(local.journalPath, JSON.stringify({ pages: [...local.pages].sort((a,b) => a-b), operations: local.operations }), { mode: 0o600 })
  }
  ctx.tools.guard(exec => {
    if (!owned(exec.agent)) return
    if (historyTools.has(exec.name)) return
    if (!fixtureTools.has(exec.name)) {
      log({ sessionId: exec.agent.session.id, callId: exec.callId, name: exec.name, status: 'DENIED', reason: 'Only experiment and installed history tools are permitted' })
      return 'This experiment permits only its fixture tools and installed historical context tools. No shell, file, network or delegation access.'
    }
    try {
      const { control } = state(exec.agent)
      if (['probe','closed'].includes(control.phase)) {
        log({ sessionId: exec.agent.session.id, callId: exec.callId, name: exec.name, status: 'DENIED', reason: 'Blind probe: no external source access or modification' })
        return 'Blind probe: external source reads, writes and operations are disabled. Use conversation/history only.'
      }
    } catch {
      return 'Experiment session control unavailable; fixture tools fail closed.'
    }
  })
  const register = definition => ctx.tools.register({ ...definition, output })
  register({ name: 'experiment_read_page', description: 'Read one bounded historical page by its integer page number. Initial snapshot only: later user corrections take precedence. Call only assigned pages, up to 12 parallel reads per step. Disabled during blind probes.',
    parameters: { type: 'object', properties: { page: { type: 'integer', minimum: 1 } }, required: ['page'], additionalProperties: false },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const { control, local } = state(exec.agent)
      if (!Number.isSafeInteger(args.page) || args.page < control.firstPage || args.page > control.lastPage) {
        log({ sessionId: exec.agent.session.id, callId: exec.callId, name: exec.name, page: args.page, status: 'DENIED', reason: 'Unassigned page' })
        throw new Error('Page is outside the assigned range')
      }
      const text = local.fixture.pages[args.page - 1]
      if (typeof text !== 'string' || Array.from(text).length > 7800) throw new Error('Invalid or oversized fixture page')
      const repeated = local.pages.has(args.page)
      local.pages.add(args.page); persist(local)
      log({ sessionId: exec.agent.session.id, callId: exec.callId, name: exec.name, page: args.page, status: 'READ', repeated, chars: text.length })
      return { text }
    } })
  register({ name: 'experiment_work_file', description: 'Read one file from the isolated F2 code fixture: policy.js, normalize.js, limits.js or protected.txt. Unavailable during blind probes.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { local } = state(exec.agent); exec.signal.throwIfAborted()
      if (local.fixture.family !== 'F2' || (!sourceFiles.has(args.path) && args.path !== 'protected.txt')) throw new Error('Work file is not available')
      return { text: readFileSync(join(exec.agent.session.header.cwd, args.path), 'utf8') }
    } })
  register({ name: 'experiment_write_file', description: 'Replace one F2 source module with complete ESM code. Only policy.js, normalize.js and limits.js are writable. No imports outside these three modules. Maximum 10000 characters.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path','content'], additionalProperties: false },
    async execute(args, exec) {
      const { local } = state(exec.agent); exec.signal.throwIfAborted()
      if (local.fixture.family !== 'F2' || !sourceFiles.has(args.path) || typeof args.content !== 'string' || args.content.length > 10000) throw new Error('Invalid source module write')
      writeFileSync(join(exec.agent.session.header.cwd, args.path), args.content)
      log({ sessionId: exec.agent.session.id, callId: exec.callId, name: exec.name, path: args.path, status: 'WROTE', chars: args.content.length })
      return { text: `Updated ${args.path}. Hidden validation is performed independently after task completion.` }
    } })
  register({ name: 'experiment_apply_operation', description: 'F4 only: apply a documented operation once, in order, with the latest user release value. All pages must already be read. Repeated operations are forbidden.',
    parameters: { type: 'object', properties: { operation: { type: 'string' }, release: { type: 'string' } }, required: ['operation','release'], additionalProperties: false },
    async execute(args, exec) {
      const { control, local } = state(exec.agent); exec.signal.throwIfAborted()
      const expected = familyExpectation('F4', local.fixture.seed, 3)
      if (local.fixture.family !== 'F4' || local.pages.size !== local.fixture.pages.length || args.operation !== expected.applied[local.operations.length] || args.release !== expected.release) {
        log({ sessionId: exec.agent.session.id, callId: exec.callId, name: exec.name, status: 'DENIED', reason: 'Invalid, premature or duplicate operation' })
        throw new Error('Invalid, premature or duplicate operation')
      }
      local.operations.push(args.operation); persist(local)
      return { text: JSON.stringify({ applied: local.operations, release: args.release }) }
    } })
  ctx.on('dispose', () => cache.clear())
}
