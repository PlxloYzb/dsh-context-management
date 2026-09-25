import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { inspectPersisted } from './runtime.ts'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { WindowController, resolveArchiveConfig, windowIdentity } from '../../src/window-controller.ts'
import { assertNoActiveCompaction, rebuildBlockLedger } from '../../src/region.ts'
import { archiveHealth } from '../../src/archive-health.ts'
import { PACKAGE_VERSION } from '../../src/version.ts'

test('L03: SIGKILL at transaction boundaries preserves the durable prefix; official resume never duplicates an applied window', async () => {
  const results = []
  for (const phase of ['before-start', 'after-summary', 'applied-no-end', 'after-end', 'after-flush']) {
    const root = await mkdtemp(join(tmpdir(), 'context-kill-'))
    const ctx = new Context()
    try {
      const child = spawn(process.execPath, ['--import', 'tsx', 'tests/integration/crash-child.ts', root, phase], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''; child.stderr.on('data', data => { stderr += String(data) })
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
      assert.equal(exit.signal, 'SIGKILL', stderr)
      const witness = JSON.parse(await readFile(join(root, 'witness.json'), 'utf8'))
      new SessionStore(ctx); new SessionProjectionRegistry(ctx); new TokenMeter(ctx)
      new JsonlSessionPersistence(ctx, { root, compression: 'none' })
      const id = SessionId(`kill-${phase}`)
      const disk = await inspectPersisted(ctx, id)
      assert.equal(createHash('sha256').update(JSON.stringify(disk.events.slice(0, witness.baselineCount))).digest('hex'), witness.baselineHash)
      const diskBlocks = rebuildBlockLedger(disk.events), integrity = archiveHealth(disk.events)
      if (phase === 'applied-no-end' || phase === 'after-flush') assert.equal(diskBlocks.length, 1)
      if (phase === 'before-start') assert.equal(diskBlocks.length, 0)
      new AgentRegistry(ctx); new LlmRuntime(ctx)
      new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false }); new ToolRuntime(ctx)
      new AgentLoop(ctx, AgentLoop.Config({ agents: [], maxParallelToolCalls: 10 }))
      const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'fixture', model: 'unused' } })
      const session = handle.agent.session, windows = new WindowController()
      assert.equal(windowIdentity(session).generation, diskBlocks.length)
      assertNoActiveCompaction(session.snapshotEvents())
      if (diskBlocks.length) {
        const result = await handle.agent.runMaintenance(signal => windows.turnover({ session, ctx, options: {} }, 'manual', signal, resolveArchiveConfig(), async () => { await ctx.sessions.flush(session) }))
        assert.equal(result, null, 'the already-applied seed cannot be archived again without new history')
        assert.equal(windowIdentity(session).generation, 1)
      }
      results.push({ phase, signal: exit.signal, durablePrefix: disk.events.length, baselineCount: witness.baselineCount, generation: windowIdentity(session).generation,
        integrity, resumed: true, endSeedObserved: session.snapshotEvents().some(event => event.type === 'session/end-seed') })
      await handle.dispose()
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  }
  const evidenceDirectory = process.env.CONTEXT_TEST_EVIDENCE_DIR ?? '.test-runtime/recovery'
  await mkdir(evidenceDirectory, { recursive: true })
  await writeFile(join(evidenceDirectory, 'sigkill.json'), JSON.stringify({ schemaVersion: 1, pluginVersion: PACKAGE_VERSION, pluginCommit: null, hostVersion: '0.1.2-rc.1',
    lockHash: createHash('sha256').update(await readFile('package-lock.json')).digest('hex'), testedAt: new Date().toISOString(), completed: true, results }, null, 2) + '\n')
})
