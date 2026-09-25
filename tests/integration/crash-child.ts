import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { WindowController, resolveArchiveConfig } from '../../src/window-controller.ts'
import { oldWork, newInput } from './runtime.ts'

const [root, phase] = process.argv.slice(2)
if (!root || !phase) throw new Error('crash child needs root and phase')
const ctx = new Context(); new SessionStore(ctx); new SessionProjectionRegistry(ctx); new TokenMeter(ctx)
new JsonlSessionPersistence(ctx, { root, compression: 'none', writeBatchMaxDelayMs: 10000 })
const session = ctx.sessions.create(SessionId(`kill-${phase}`))
oldWork(session); newInput(session, 'Current requirement before process interruption')
await ctx.sessions.flush(session)
writeFileSync(`${root}/witness.json`, JSON.stringify({ phase, baselineCount: session.seq, baselineHash: createHash('sha256').update(JSON.stringify(session.snapshotEvents())).digest('hex') }))
function kill(): never { process.kill(process.pid, 'SIGKILL'); throw new Error('SIGKILL unexpectedly returned') }
if (phase === 'before-start') kill()
const append = session.append.bind(session)
session.append = ((type: string, ...args: unknown[]) => {
  if (phase === 'applied-no-end' && type === 'compaction/end') throw new Error('crash fixture withholds both end attempts')
  const event = Reflect.apply(append, session, [type, ...args])
  if ((phase === 'after-summary' && type === 'compaction/summary') || (phase === 'after-end' && type === 'compaction/end')) kill()
  return event
}) as typeof session.append
try {
  await new WindowController().turnover({ session, ctx, options: {} }, 'manual', new AbortController().signal, resolveArchiveConfig(), async () => { await ctx.sessions.flush(session) })
} catch (error) {
  if (phase !== 'applied-no-end') throw error
}
await ctx.sessions.flush(session)
kill()
