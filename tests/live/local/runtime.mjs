import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { webClient } from '../client.mjs'

export async function startHost(spec, launchId) {
  const log = join(spec.directory, `web-${launchId}.log`)
  await writeFile(log, '', { flag: 'wx', mode: 0o600 })
  // r2: the user's global dsh passed the frozen host version after r1 (0.1.5-rc.1 vs frozen
  // 0.1.2-rc.1); experiments pin the frozen binary through EXPERIMENT_DSH_BIN instead of PATH.
  const dshBin = spec.dshBin
  if (!dshBin) throw new Error('Explicit pinned host binary is required')
  const child = spawn(dshBin, ['--profile', spec.profile, '--patch', spec.patch, '--host', '127.0.0.1', '--port', String(spec.port), '--no-open'], { stdio: ['ignore','pipe','pipe'] })
  child.stdout.on('data', data => appendFileSync(log, data)); child.stderr.on('data', data => appendFileSync(log, data))
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM')
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 10000)
    await exited; clearTimeout(timer)
  }
  try { return { child, log, client: await webClient(log, spec.port), stop } }
  catch (error) { await stop(); throw error }
}
