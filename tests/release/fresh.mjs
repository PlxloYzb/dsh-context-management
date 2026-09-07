import { mkdtemp, cp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
const root=await mkdtemp(join(tmpdir(),'dsh-context-release-ci-'))
for(const path of ['src','tests','package.json','package-lock.json','tsconfig.json','tsup.config.ts','README.md','CHANGELOG.md','LICENSE','NOTICE.md','SOURCE_REUSE.md','THIRD_PARTY_LICENSES.md','cordis.patch.yml'])await cp(path,join(root,path),{recursive:true})
const report={schemaVersion:1,pluginVersion:'0.1.0',pluginCommit:null,hostVersion:'0.1.2-rc.1',startedAt:new Date().toISOString(),node:process.version,lockHash:createHash('sha256').update(await readFile('package-lock.json')).digest('hex'),steps:[],completed:false,failures:[]}
await mkdir('.test-runtime',{recursive:true});await mkdir('docs/evidence/release',{recursive:true})
for(const args of [['ci'],['run','check'],['run','test:release'],['audit','--json']]){
 const child=spawn('npm',args,{cwd:root,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>{output+=d});child.stderr.on('data',d=>{output+=d})
 const code=await new Promise(resolve=>child.once('exit',resolve));const log=resolve('.test-runtime',`fresh-${args.join('-').replace(/[^a-z0-9-]/g,'')}.log`);await writeFile(log,output)
 const step={command:`npm ${args.join(' ')}`,exitCode:code,tests:[...output.matchAll(/^# tests (\d+)$/gm)].map(m=>Number(m[1]))};report.steps.push(step)
 if(args[0]==='audit'){try{report.dependencyAudit=JSON.parse(output)}catch{report.failures.push('audit output unavailable')}}
 else if(code!==0){report.failures.push(`${step.command} failed`);break}
}
report.completed=report.failures.length===0;report.finishedAt=new Date().toISOString();report.workspace=root
await writeFile('docs/evidence/release/fresh-install.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({completed:report.completed,steps:report.steps,failures:report.failures,workspace:root}));if(!report.completed)process.exitCode=1
