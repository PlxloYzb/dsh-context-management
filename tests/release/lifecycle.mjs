const releaseVersion = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8')).version
const evidenceRoot = `docs/evidence/v${releaseVersion.replaceAll('.', '')}`
// Real installed-package lifecycle in a new, explicitly isolated DSH profile.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, realpath, mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { webClient } from '../live/client.mjs'

const tarball = resolve(process.argv[2]), port = Number(process.argv[3] ?? 3101)
const profile = `ctx-v011-release-${Date.now()}`
const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profile)
const privateRoot = resolve('.test-runtime', profile), observed = join(privateRoot, 'observed')
const sha = value => createHash('sha256').update(value).digest('hex')
const binary = await realpath(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
const presets = join(dirname(dirname(binary)), 'node_modules/@deepseek-ai/dsh-agent-presets/presets')
async function presetHashes() {
  return Object.fromEntries(await Promise.all(['standard','minimal','ptc','cordis'].map(async name => [name, sha(await readFile(join(presets, name, 'agent.cordis.yml')))])))
}
const report = { schemaVersion:1, pluginVersion:releaseVersion, pluginCommit:null, hostVersion:'0.1.2-rc.1',
  startedAt:new Date().toISOString(), profile, tarballHash:sha(await readFile(tarball)),
  lockHash:sha(await readFile('package-lock.json')), presetsBefore:await presetHashes(), stages:[], completed:false, failures:[] }
await mkdir(root, { recursive:false }); await mkdir(observed, { recursive:true })
await writeFile(join(root, 'package.json'), JSON.stringify({name:`dsh-profile-${profile}`,private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'],patchReload:'live'}}},null,2))
const patch = join(privateRoot, 'observer.yml')
await writeFile(patch, `- insert:\n    - id: context-release-observer\n      name: ${JSON.stringify(resolve('tests/live/observer.mjs'))}\n      config:\n        output: ${JSON.stringify(observed)}\n        arm: release\n`)
const logPath = join(privateRoot, 'web.log')
let server
async function stop() {
  if (!server || server.exitCode !== null) return
  const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited
}
async function start() {
  await writeFile(logPath, '')
  server = spawn('dsh', ['--profile',profile,'--patch',patch,'--no-open','--port',String(port)], { stdio:['ignore','pipe','pipe'] })
  const { appendFileSync } = await import('node:fs')
  server.stdout.on('data', data => appendFileSync(logPath, data)); server.stderr.on('data', data => appendFileSync(logPath, data))
  for (let i=0;i<60;i++) {
    await new Promise(resolve => setTimeout(resolve,500))
    if (server.exitCode !== null) throw new Error('Isolated lifecycle server exited')
    try { return await webClient(logPath, port) } catch {}
  }
  throw new Error('Lifecycle Web did not become ready')
}
function plugin(action, name) {
  const output = execFileSync('dsh', ['plugin','--profile',profile,action,name], { encoding:'utf8',stdio:['ignore','pipe','pipe'] })
  return writeFile(join(privateRoot,`${action}.log`),output)
}
let sessionId, original
async function verify(client, stage, expectedBackend, text) {
  const result = await client.prompt(sessionId,text)
  assert.equal(result.end.kind,'completed')
  const headers=result.recent.filter(e=>e.type==='request/header').map(e=>({seq:e.seq,provider:e.data.header.config.provider,model:e.data.header.config.model,tools:e.data.header.tools?.map(t=>t.name)}))
  assert.ok(headers.length); assert.ok(headers.every(h=>h.provider==='opencode-go'&&h.model==='glm-5.3-flash'))
  const pressure=(await readFile(join(observed,`${sessionId}.pressure.jsonl`),'utf8')).trim().split('\n').map(line=>JSON.parse(line))
  assert.equal(pressure.at(-1).backend,expectedBackend)
  const events=JSON.parse(await readFile(join(observed,`${sessionId}.events.json`),'utf8'))
  if(original) assert.deepEqual(events.slice(0,original.length),original)
  original=events
  report.stages.push({stage,end:result.end,backend:pressure.at(-1).backend,headers,prefixPreserved:true,eventCount:events.length})
}
try {
  await plugin('add',tarball)
  let client=await start()
  const cwd=await mkdtemp(join(tmpdir(),'dsh-context-corpus-release-'))
  ;({sessionId}=await client.call('session/create',{cwd,agentPreset:'standard'}));report.sessionId=sessionId
  await client.call('session/selectModel',{sessionId,provider:'opencode-go',model:'glm-5.3-flash'})
  await verify(client,'installed-first-request','ArcCompactionEngine','This isolated release check stores the exact value RELEASE_7319. If arc_status exists, call it once, then reply READY. Do not use other tools.')
  await stop();client=await start()
  await verify(client,'installed-restart','ArcCompactionEngine','Recall the stored RELEASE value. Reply only with that value. Do not use any tools.')
  await stop();await plugin('remove','dsh-context-management');client=await start()
  await verify(client,'uninstalled-restart','BasicCompactionEngine','Recall the stored RELEASE value. Reply only with that value. Do not use any tools.')
  assert.ok(report.stages.at(-1).headers.every(h=>!h.tools.includes('new_context')&&!h.tools.includes('arc_status')))
  report.presetsAfter=await presetHashes();assert.deepEqual(report.presetsAfter,report.presetsBefore)
  report.completed=true
} catch(error) { report.failures.push(error.message);process.exitCode=1 }
finally {
  await stop();report.finishedAt=new Date().toISOString()
  await mkdir(`${evidenceRoot}/release`,{recursive:true})
  await writeFile(`${evidenceRoot}/release/lifecycle-${profile}.json`,JSON.stringify(report,null,2)+'\n')
  await writeFile(`${evidenceRoot}/release/lifecycle.json`,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({completed:report.completed,profile,stages:report.stages.map(s=>({stage:s.stage,backend:s.backend})),failures:report.failures}))
}
