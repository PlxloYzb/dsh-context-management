import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { ToolEnvironment } from './tools.ts'
import { ArchiveReader } from './archive.ts'

export function contextCommand(env: ToolEnvironment, name = 'context'): CommandDefinition {
  const reader = env.reader ?? new ArchiveReader()
  return {
    name, description: 'Manage context: status | new | search <query> | decompress <blockId> [cursor]',
    input: { hint: 'status | new | search <query> | decompress <blockId> [cursor]' },
    handler: async (invocation) => {
      const [action = 'status', ...args] = invocation.rawInput.trim().split(/\s+/)
      const agent = invocation.agent
      let result: unknown
      try {
        invocation.signal.throwIfAborted()
        switch (action || 'status') {
          case 'status': result = env.status ? await env.status(agent) : { archives: reader.ledger(agent.session).length }; break
          case 'new':
            if (!env.manualNew) return { kind: 'error', text: 'unsupported: manual window controller unavailable' }
            result = await env.manualNew(agent, invocation.signal)
            if (!result) result = { status: 'no-op', code: 'no-safe-range-or-no-reduction' }
            break
          case 'search': result = reader.search(agent.session, { query: args.join(' ') }, env.retrievalBudget?.(agent) ?? 4096, invocation.signal); break
          case 'decompress': result = reader.decompress(agent.session, { blockId: args[0] ?? '', ...(args[1] ? { cursor: args[1] } : {}) }, env.retrievalBudget?.(agent) ?? 4096, invocation.signal); break
          default: return { kind: 'error', text: 'Use status | new | search <query> | decompress <blockId> [cursor]' }
        }
        return { kind: 'success', text: JSON.stringify(result) }
      } catch (error) { return { kind: 'error', text: String(error) } }
    },
  }
}
export function arcCommand(env: ToolEnvironment): CommandDefinition { return contextCommand(env, 'arc') }
