const releaseVersion = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8')).version
const evidenceRoot = `docs/evidence/v${releaseVersion.replaceAll('.', '')}`
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
const entry=resolve(process.argv[2]), installation=JSON.parse(await readFile(process.argv[3],'utf8'))
const dir=await mkdtemp(join(tmpdir(),'dsh-context-consumer-'))
await writeFile(join(dir,'consumer.mts'),`import { ContextManagementEngine } from ${JSON.stringify(entry)};\nconst engine: typeof ContextManagementEngine = ContextManagementEngine;\nvoid engine;\n`)
const args=['--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','--lib','ESNext','--types','node','--typeRoots',resolve('node_modules/@types'),'--skipLibCheck','false','consumer.mts']
let completed=true,output=''
try{output=execFileSync(resolve('node_modules/.bin/tsc'),args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']})}
catch(error){completed=false;output=String(error.stdout)+String(error.stderr)}
await writeFile('.test-runtime/consumer-types.log',output)
await writeFile(`${evidenceRoot}/release/consumer-types.json`,JSON.stringify({schemaVersion:1,pluginVersion:releaseVersion,hostVersion:'0.1.2-rc.1',tarballHash:installation.tarballHash,checkedAt:new Date().toISOString(),compilerOptions:args.slice(0,-1),notes:['Node project with ESNext.Disposable (included by ESNext), required by the DSH public Session API.'],completed,failures:completed?[]:[output]},null,2)+'\n')
console.log(JSON.stringify({consumerTypes:completed}));if(!completed)process.exitCode=1
