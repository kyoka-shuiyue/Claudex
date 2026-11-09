import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { desktopOutcome } from '../lib/claude-desktop.mjs';
import { tmpDir } from './fixtures.mjs';

function conversation() {
  const id='example', uuid='delivery', at=Date.now(), transcriptFile=path.join(tmpDir('desktop-execution'),'session.jsonl');
  const receipt={id,uuid,at,transcriptFile,status:'submitted'};
  let last=uuid, seq=0;
  const add=(type,content,extra={})=>{
    const record={type,sessionId:id,uuid:'step-'+(++seq),parentUuid:last,timestamp:new Date(at+seq*100).toISOString(),message:{content},...extra};
    last=record.uuid;
    fs.appendFileSync(transcriptFile,JSON.stringify(record)+'\n');
    return record;
  };
  add('user','Another Claude session sent a message:\n继续',{uuid,isMeta:true,origin:{kind:'peer'}});
  return {at,add,result:(now=at+2000)=>desktopOutcome(receipt,{now})};
}
const textBlock=text=>({type:'text',text});
const use=(id,name)=>({type:'tool_use',id,name});
const result=(id,error=false)=>({type:'tool_result',tool_use_id:id,is_error:error,content:'private result contents'});

test('桌面依次出现思考、工具请求、匹配回执和本轮结束；只有匹配的成功回执算执行',()=>{
  const c=conversation();
  c.add('assistant',[{type:'thinking',thinking:'private'}]);
  assert.equal(c.result().status,'sent');assert.equal(c.result().progress.phase,'thinking');
  assert.equal(c.result().responseAt,undefined);
  c.add('assistant',[use('read','Read')]);c.add('user',[result('wrong')]);
  assert.equal(c.result().progress.phase,'tool_requested');assert.equal(c.result().execution.completedTools,0);
  c.add('user',[result('read')]);c.add('assistant',[use('write','Write')]);c.add('user',[result('write')]);
  const active=c.result();assert.equal(active.execution.completedTools,2);assert.equal(active.execution.lastTool,'Write');
  assert.ok(active.executedAt>=active.responseAt);assert.ok(!JSON.stringify(active).includes('private'));
  c.add('assistant',[],{message:{stop_reason:'end_turn',content:[textBlock('写入完毕')]}});
  const completed=c.result();assert.equal(completed.status,'resumed');assert.equal(completed.execution.completedTools,2);
});

test('仅文字答复和工具被拒，各自保留证据，不标记为执行成功',()=>{
  const c=conversation();
  c.add('assistant',[],{message:{stop_reason:'end_turn',content:[textBlock('好的，我这就去做。')]}});
  assert.equal(c.result().status,'replied');assert.equal(c.result().execution.completedTools,0);
  const d=conversation();d.add('assistant',[use('a','Write')]);d.add('user',[result('a',true)]);
  d.add('system',[],{subtype:'stop_hook_summary'});
  assert.equal(d.result().status,'unconfirmed');assert.equal(d.result().execution.failedTools,1);
  assert.equal(d.result().retryable,false);assert.equal(d.result().executedAt,undefined);
});

test('另一分支、重复回执、下一条桌面同伴消息均不冒充当前任务执行',()=>{
  const c=conversation();
  const request=c.add('assistant',[use('a','Read')]);
  c.add('user',[result('a')],{parentUuid:'foreign-branch'});
  assert.equal(c.result().execution.completedTools,0);
  const own=c.add('user',[result('a')],{parentUuid:request.uuid});
  c.add('user',[result('a')],{parentUuid:own.uuid});
  c.add('user','下一条独立消息',{isMeta:true,origin:{kind:'peer'}});
  c.add('assistant',[use('b','Write')]);c.add('user',[result('b')]);
  assert.equal(c.result().execution.completedTools,1);assert.equal(c.result().execution.lastTool,'Read');
});

test('长时间仅有工具请求时保留占位，迟到的成功回执可使状态前进',()=>{
  const c=conversation();c.add('assistant',[use('a','Write')]);
  const pending=c.result(c.at+240000);assert.equal(pending.status,'unconfirmed');assert.equal(pending.retryable,false);
  c.add('user',[result('a')]);c.add('system',[],{subtype:'stop_hook_summary'});
  assert.equal(c.result().status,'resumed');assert.equal(c.result().execution.completedTools,1);
});

test('重启后锚点距文件末尾超过 8 MB，分块扫描仍识别本轮回执和最后半行',()=>{
  const transcriptFile=path.join(tmpDir('desktop-long'),'large.jsonl'),id='long',uuid='large-delivery',at=Date.now();
  const receipt={id,uuid,at,transcriptFile,status:'submitted'};
  const line=r=>JSON.stringify({sessionId:id,...r})+'\n';
  fs.writeFileSync(transcriptFile,line({type:'user',uuid})+line({type:'assistant',uuid:'call',parentUuid:uuid,message:{content:[use('w','Write')]}}));
  const padding=line({type:'progress',note:'x'.repeat(12000)});
  fs.appendFileSync(transcriptFile,padding.repeat(720));
  const tail=line({type:'user',parentUuid:'call',uuid:'done',message:{content:[result('w')]}});
  fs.appendFileSync(transcriptFile,tail.slice(0,45));
  assert.equal(desktopOutcome(receipt).execution.completedTools,0);
  fs.appendFileSync(transcriptFile,tail.slice(45)+line({type:'system',parentUuid:'done',subtype:'stop_hook_summary'}).trimEnd());
  const outcome=desktopOutcome(receipt);assert.equal(outcome.status,'resumed');assert.equal(outcome.execution.completedTools,1);
});
