import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendSystem, appendUser, appendAssistant } from '../helpers.ts'

export async function host(compression: 'none' | 'zstd' = 'none') {
  const root = await mkdtemp(join(tmpdir(), 'ctx-v010-host-'))
  const ctx = new Context()
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  new JsonlSessionPersistence(ctx, { root, compression, writeBatchMaxDelayMs: 10 })
  return { ctx, root, async close() { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
}
/** The rendered prompt a fixture session carries as its protected surface head. */
export const FIXTURE_SYSTEM_PROMPT = 'You are a synthetic fixture agent. Follow the current user instruction and preserve stated constraints.'
/**
 * One completed historical turn shaped like a real DSH 0.1.7 log: the first step
 * opens with the protected `system/message` head, then the user request, then the
 * assistant work. The head is load-bearing — the host refuses to read a stored
 * log whose first surface node is anything else — so fixtures must model it.
 */
export function oldWork(session: Session, turn = 1, size = 24) {
  session.append('turn/start', { turn })
  for (let step = 1; step <= size; step++) {
    session.append('step/start', { turn, step })
    if (step === 1) {
      appendSystem(session, FIXTURE_SYSTEM_PROMPT, turn, step)
      appendUser(session, `Original task ${turn}: preserve 12 factual constraints.`)
    }
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
 * DSH 0.1.7 persists a session only through an open write handle: the JSONL
 * backend routes `session/event` into `writers.get(id)` and drops the event when
 * no handle is registered. These fixtures append synchronously after creating a
 * session, before any handle can exist, so the first read materializes the log by
 * opening the handle and appending what the session already holds. Later reads
 * reuse it, because a second open would report the session as already owned.
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
    create(header: unknown, options?: unknown): Promise<{ append(events: readonly SessionEvent[]): Promise<void> }>
  }
  const session = ctx.sessions.get(id)
  if (session !== undefined && !materialized.has(id)) {
    materialized.add(id)
    try {
      const handle = await persistence.create(session.header, { inheritedEventCount: session.inheritedEventCount })
      const events = session.snapshotEvents()
      if (events.length > 0) await handle.append(events)
    } catch {
      // A real agent loop already opened the write handle and stored the log, so
      // there is nothing to materialize and appending again would duplicate it.
    }
  }
  await persistence.flush()
  const path = await persistence.resolveCurrentLog(id)
  if (path === undefined) return { events: [] }
  return { events: (await persistence.readStoredLog(path, id)).events }
}
/** Sessions this runtime has already opened a write handle for. */
const materialized = new Set<SessionId>()
