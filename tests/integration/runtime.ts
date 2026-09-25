import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId, type Session } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendUser, appendAssistant } from '../helpers.ts'

export async function host(compression: 'none' | 'zstd' = 'none') {
  const root = await mkdtemp(join(tmpdir(), 'ctx-v010-host-'))
  const ctx = new Context()
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  new JsonlSessionPersistence(ctx, { root, compression, writeBatchMaxDelayMs: 10 })
  return { ctx, root, async close() { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
}
export function oldWork(session: Session, turn = 1, size = 24) {
  session.append('turn/start', { turn })
  appendUser(session, `Original task ${turn}: preserve 12 factual constraints.`)
  for (let step = 1; step <= size; step++) {
    session.append('step/start', { turn, step })
    appendAssistant(session, `FACT_${turn}_${step} = verified-${step}.\r\n${'Synthetic telemetry row: status=ok; user requirement remains unchanged. '.repeat(40)}`, turn, step)
    session.append('step/end', { turn, step })
  }
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}
export function newSession(ctx: Context, id: string): Session { return ctx.sessions.create(SessionId(id)) }
export function newInput(session: Session, text: string, turn = 2): void {
  session.append('turn/start', { turn })
  appendUser(session, text)
}
