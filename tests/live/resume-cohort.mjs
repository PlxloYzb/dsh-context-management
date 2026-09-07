import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
const args=Object.fromEntries(process.argv.slice(2).map(a=>a.replace(/^--/,'').split('=')))
const manifest=JSON.parse(await readFile(args.manifest,'utf8'))
let next=0
async function worker(){while(next<manifest.samples.length){
 const sample=manifest.samples[next++];if(sample.status==='failed'||sample.status==='completed')continue
 const flags=Object.entries({arm:manifest.arm,log:args.log,port:args.port,seed:sample.seed,run:sample.run,resume:sample.report}).map(([k,v])=>`--${k}=${v}`)
 const child=spawn(process.execPath,['tests/live/run.mjs',...flags],{stdio:['ignore','inherit','inherit']})
 const code=await new Promise(resolve=>child.once('exit',resolve));sample.restartExitCode=code
 const report=JSON.parse(await readFile(sample.report,'utf8'));sample.status=report.completed?'completed':'failed'
 await writeFile(args.manifest,JSON.stringify(manifest,null,2)+'\n')
}}
await Promise.all([worker(),worker(),worker()]);console.log(JSON.stringify({manifest:args.manifest,statuses:manifest.samples.map(s=>s.status)}))
