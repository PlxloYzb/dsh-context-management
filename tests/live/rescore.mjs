// Recompute every retained report with the same answer-selection rule, keeping old scores.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { corpus, score } from './fixture.mjs'
const changed=[]
for(const file of await readdir('docs/evidence/live')) {
  if(!/^[ABC]-\d+-\d+-\d+\.json$/.test(file))continue
  const path=`docs/evidence/live/${file}`, report=JSON.parse(await readFile(path,'utf8'))
  const fixture=corpus(report.seed), expected={...fixture.facts,...fixture.corrections}
  for(const [key,stage] of [['blindScore','blind-recall'],['restartScore','restart-recall']]) {
    const turn=report.turns?.findLast(turn=>turn.stage===stage&&turn.end?.kind==='completed')
    if(!turn)continue
    const next=score(turn.response,expected)
    if(report[key]?.scorerVersion===2)continue
    if(report[key]){report.previousScores??={};report.previousScores[key]=report[key]}
    if(report[key]?.correct!==next.correct)changed.push({file,stage,previous:report[key]?.correct,current:next.correct})
    report[key]=next
  }
  await writeFile(path,JSON.stringify(report,null,2)+'\n')
}
await writeFile('docs/evidence/live/scoring-revision.json',JSON.stringify({schemaVersion:1,scorerVersion:2,changed,rule:'Highest expected-field coverage; last object for ties. Selection never compares values to expected answers. Original responses, failures and prior scores retained.'},null,2)+'\n')
console.log(JSON.stringify({changed}))
