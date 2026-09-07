// Recompute the accepted cohort gates; per-run completed does not imply recall quality.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { corpus } from '../live/fixture.mjs'
const paths=process.argv.slice(2)
if(paths.length!==3)throw new Error('Pass A, B and C cohort manifests')
const arms=[]
for(const path of paths){
  const manifest=JSON.parse(await readFile(path,'utf8'))
  const samples=await Promise.all(manifest.samples.map(async sample=>({ ...sample, result:sample.report?JSON.parse(await readFile(sample.report,'utf8')):null })))
  const sum=key=>samples.reduce((n,s)=>n+(s.result?.[key]?.correct??0),0)
  const usage={inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0}
  const usageMissingFields={inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0}
  for(const sample of samples)for(const item of sample.result?.usage??[])for(const key of Object.keys(usage)){if(typeof item[key]==='number')usage[key]+=item[key];else usageMissingFields[key]++}
  arms.push({arm:manifest.arm,manifest:path,samples:samples.length,completed:samples.filter(s=>s.result?.completed).length,
    blindCorrect:sum('blindScore'),blindTotal:samples.length*12,restartCorrect:sum('restartScore'),restartTotal:samples.length*12,
    sourceVerified:samples.filter(s=>s.result?.sourceVerification?.sourceTextComplete&&s.result?.sourceVerification?.pairingBalanced).length,
    minimumWindows:Math.min(...samples.map(s=>s.result?.windows?.length??0)),
    latestCorrections:samples.filter(s=>Object.entries(corpus(s.seed).corrections).every(([id,value])=>s.result?.blindScore?.values[id]===value&&s.result?.restartScore?.values[id]===value)).length,
    routeVerified:samples.filter(s=>s.result?.routeVerified).length,
    restartVerified:samples.filter(s=>s.result?.restartVerified).length,
    failures:samples.flatMap(s=>(s.result?.failures??['missing report']).map(f=>({seed:s.seed,run:s.run,failure:f}))),
    usage,usageMissingFields,usageCalls:samples.reduce((n,s)=>n+(s.result?.usage?.length??0),0),
    elapsedMs:samples.reduce((n,s)=>n+(s.result?.turns??[]).reduce((n,t)=>n+t.elapsedMs,0),0),
    fixtureHashes:samples.map(s=>({seed:s.seed,run:s.run,hash:s.result?.fixtureHash})),
    tarballHashes:[...new Set(samples.map(s=>s.result?.tarballHash).filter(Boolean))]})
}
const [a,b,c]=arms
const checks={sampleCount:arms.every(a=>a.samples===9),sameFixtures:JSON.stringify(a.fixtureHashes)===JSON.stringify(b.fixtureHashes)&&JSON.stringify(a.fixtureHashes)===JSON.stringify(c.fixtureHashes),
  route:arms.every(a=>a.routeVerified===9),sourceText:arms.every(a=>a.sourceVerified===9),
  journey:c.completed===9&&c.restartVerified===9&&c.minimumWindows>=2&&c.failures.length===0,
  corrections:c.latestCorrections===9,blindQuality:c.blindCorrect/c.blindTotal>=.9&&c.blindCorrect/c.blindTotal>=a.blindCorrect/a.blindTotal}
const report={schemaVersion:1,pluginVersion:'0.1.0',pluginCommit:null,hostVersion:'0.1.2-rc.1',checkedAt:new Date().toISOString(),arms,checks,completed:Object.values(checks).every(Boolean),
  limitations:['Basic uses its native physical-capacity threshold; budgets are not directly comparable. No cost superiority claim.','In-place safe-budget stops remain failed comparator samples.','Only 27 fixed synthetic samples; no general accuracy guarantee.','Physical provider overflow: NOT EXERCISED.']}
await mkdir('docs/evidence/release',{recursive:true});await writeFile('docs/evidence/release/cohort-gates.json',JSON.stringify(report,null,2)+'\n')
await writeFile(`docs/evidence/release/gates-${basename(c.manifest)}`,JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({completed:report.completed,checks,arms:arms.map(({arm,completed,blindCorrect,restartCorrect,sourceVerified})=>({arm,completed,blindCorrect,restartCorrect,sourceVerified}))}))
if(!report.completed)process.exitCode=1
