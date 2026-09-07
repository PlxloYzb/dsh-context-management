import test from 'node:test'
import assert from 'node:assert/strict'
import { createCore } from 'acp-kernel'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ArcStateStore } from '../../src/state.ts'
import { makeTools } from '../../src/tools.ts'
import { resolveCompactionInputBenefit, resolveRequestTokenCount } from '../../src/fallback.ts'
import { host, newSession } from './runtime.ts'
import { appendUser, appendAssistant } from '../helpers.ts'

test('B02: compression savings remain positive after the host reinjects its latest skill catalog', async t => {
  const h = await host(); t.after(h.close)
  const session = newSession(h.ctx,'catalog-refresh')
  session.append('turn/start',{turn:1});appendUser(session,'Preserve the current task.')
  const catalog = () => createUserMessage({content:[{type:'text',text:'Available skills:\n'+'Synthetic skill entry and description.\n'.repeat(700)}],source:{kind:'skill-catalog',form:'catalog',entries:[],update:true}})
  const start=session.append('user/message',catalog(),{surfaceOp:'append'}).seq
  for(let i=0;i<3;i++){
    session.append('step/start',{turn:1,step:i+1})
    appendAssistant(session,`Historical consumed output ${i}. `+'completed telemetry; no further action. '.repeat(140),1,i+1)
    session.append('step/end',{turn:1,step:i+1})
  }
  const end=session.surface.nodes.at(-1)!
  appendUser(session,'CURRENT: keep the latest user request.')
  for(let i=0;i<8;i++){
    session.append('step/start',{turn:1,step:i+4})
    appendAssistant(session,'Retained recent output. '.repeat(90),1,i+4)
    session.append('step/end',{turn:1,step:i+4})
  }
  const agent={session,ctx:h.ctx,options:{provider:'synthetic',model:'test'}} as unknown as Agent
  const selected=session.surface.nodes.filter(seq=>seq>=start&&seq<=end)
  assert.ok(resolveCompactionInputBenefit(agent,selected)<resolveRequestTokenCount(agent,selected))
  const before=h.ctx.tokenMeter.measure(session).totalTokens
  const compress=makeTools({kernel:createCore({}),store:new ArcStateStore(),modelContextLimit:128000}).find(tool=>tool.name==='compress')!
  const result=await compress.execute({content:[{startSeq:start,endSeq:end,summary:'Historical tool work is complete. Preserve all latest requirements and proceed using the current skill catalog.'}]},{agent,callId:'refresh-regression',signal:new AbortController().signal} as never)
  assert.match(result.text,/Compressed 1 block/)
  session.append('user/message',catalog(),{surfaceOp:'append'})
  assert.ok(h.ctx.tokenMeter.measure(session).totalTokens<before,'regenerated catalog must not reverse the reported savings')
})
