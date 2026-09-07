import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
const path=process.argv[2], manifest=JSON.parse(await readFile(path,'utf8'))
for(const sample of manifest.samples){
 if(!sample.report)continue
 const child=spawn(process.execPath,['--import','tsx','tests/live/verify-history.ts',sample.report],{stdio:['ignore','inherit','inherit']})
 const code=await new Promise(resolve=>child.once('exit',resolve));sample.sourceVerificationExitCode=code
 if(code!==0){const report=JSON.parse(await readFile(sample.report,'utf8'));report.failures.push('exact source/pairing verification failed');report.completed=false;await writeFile(sample.report,JSON.stringify(report,null,2)+'\n')}
}
await writeFile(path,JSON.stringify(manifest,null,2)+'\n')
