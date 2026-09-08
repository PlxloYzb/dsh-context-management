const releaseVersion = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8')).version
const evidenceRoot = `docs/evidence/v${releaseVersion.replaceAll('.', '')}`
// Declared samples remain in the manifest even if a process fails.
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')))
if (!args.arm || !args.port || !args.log) throw new Error('Required --arm --port --log')
const output = resolve(args.output ?? `${evidenceRoot}/live/cohort-${args.arm}-${Date.now()}.json`)
const manifest = { schemaVersion: 1, startedAt: new Date().toISOString(), arm: args.arm, samples: [] }
for (const seed of [1701,2903,4307]) for (const run of [1,2,3]) manifest.samples.push({ seed, run, status: 'pending' })
await mkdir('.test-runtime/cohort', { recursive: true })
await mkdir(resolve(output, '..'), { recursive: true })
const save = () => writeFile(output, JSON.stringify(manifest,null,2)+'\n')
await save()
let next=0
async function worker() {
  while(next<manifest.samples.length) {
    const sample=manifest.samples[next++]
    sample.status='running'; await save()
    const flags = Object.entries(args).filter(([key])=>!['output','concurrency'].includes(key)).map(([key,value])=>`--${key}=${value}`)
    const child=spawn(process.execPath,['tests/live/run.mjs',...flags,`--seed=${sample.seed}`,`--run=${sample.run}`],{stdio:['ignore','pipe','pipe']})
    let stdout='',stderr='';child.stdout.on('data',data=>{stdout+=data;process.stdout.write(data)});child.stderr.on('data',data=>{stderr+=data})
    const code=await new Promise(resolve=>child.once('exit',resolve))
    const log=resolve(`.test-runtime/cohort/${args.arm}-${sample.seed}-${sample.run}.log`)
    await writeFile(log,stdout+stderr)
    const result=stdout.trim().split('\n').map(line=>{try{return JSON.parse(line)}catch{return{}}}).findLast(x=>x.report)
    Object.assign(sample,{ status:code===0?'awaiting-restart':'failed',exitCode:code,report:result?.report??null,log })
    await save()
  }
}
await Promise.all(Array.from({length:Number(args.concurrency??3)},worker))
manifest.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({manifest:output,samples:manifest.samples.map(s=>s.status)}))
