import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
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

/**
 * Read back the events a session has already committed to disk.
 *
 * DSH 0.1.7 replaced the single `sessionPersistence.inspect(id)` read with a
 * path lookup plus a stored-log decode, so the two steps are composed here for
 * the tests that assert on what actually reached storage.
 *
 * @param ctx - host context carrying the persistence service.
 * @param id - session whose stored log is read.
 * @returns the durable events, or an empty list when nothing was materialized.
 */
export async function inspectPersisted(ctx: Context, id: SessionId): Promise<{ events: readonly SessionEvent[] }> {
  const persistence = ctx.sessionPersistence as unknown as {
    flush(): Promise<void>
    resolveCurrentLog(id: SessionId, signal?: AbortSignal): Promise<string | undefined>
    readStoredLog(path: string, expectedId: SessionId, signal?: AbortSignal): Promise<{ events: readonly SessionEvent[] }>
  }
  // Sessions reach disk lazily in DSH 0.1.7, so a read of what is stored has to
  // let the pending batch land first.
  await persistence.flush()
  const path = await persistence.resolveCurrentLog(id)
  if (path === undefined) return { events: [] }
  return { events: (await persistence.readStoredLog(path, id)).events }
}
