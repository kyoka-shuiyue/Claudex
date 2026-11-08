import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { startDesktopAgent } from '../lib/desktop-agent.mjs';
import { bridgeRequest,readRegistration,readDesktopReceipt,desktopOutcome,requestKey,runDesktopCommand,writePrivateJson,receiptFile } from '../lib/claude-desktop.mjs';
import { runCommand } from '../lib/sender.mjs';
import { tmpDir } from './fixtures.mjs';

const id='12345678-1234-4234-8234-123456789abc';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture({reply=true,accept=true}={}) {
 const home=tmpDir('desktop-ipc'),transcriptFile=path.join(home,`${id}.jsonl`),messages=[];
 fs.writeFileSync(transcriptFile,'');
 const claudeToken=crypto.randomBytes(16).toString('hex');
 const claudeSocket=process.platform==='win32'?`\\\\.\\pipe\\LOCAL\\cc-msg-${crypto.randomBytes(16).toString('hex')}`:path.join(home,'claude.sock');
 const server=net.createServer(socket=>{
  let data='';
  socket.on('error',()=>{});
  socket.on('data',chunk=>{data+=chunk;});
  socket.on('end',()=>{
   const records=data.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
   assert.equal(records.shift()?.token,claudeToken);
   for(const message of records) {
    messages.push(message);
    if(!accept)continue;
    const append=record=>fs.appendFileSync(transcriptFile,JSON.stringify({sessionId:id,entrypoint:'claude-desktop',timestamp:new Date().toISOString(),...record})+'\n');
    append(message);
    if(reply)append({type:'assistant',parentUuid:message.uuid,message:{content:[{type:'text',text:'已继续原任务'}]}});
   }
  });
 });
 await new Promise(resolve=>server.listen(claudeSocket,resolve));
 let agent=await startDesktopAgent({home,id,transcriptFile,claudeSocket,claudeToken,heartbeatMs:60000});
 const registration=readRegistration(home,id);
 return {home,transcriptFile,messages,registration,
  restart:async()=>{await agent.close();agent=await startDesktopAgent({home,id,transcriptFile,claudeSocket,claudeToken,heartbeatMs:60000});return readRegistration(home,id);},
  close:async()=>{await agent.close();await new Promise(resolve=>server.close(resolve));}};
}

test('会话子进程本地投递：消息 UUID 落入原桌面记录且模型回复才确认接上',async()=>{
 const f=await fixture();
 try {
  const key=requestKey('real-call-site'),logFile=path.join(f.home,'run.log'),updates=[];
  const run=await runDesktopCommand({sessionId:id,requestId:key,message:'继续'}, {home:f.home,logFile,pollMs:10,onProgress:o=>updates.push(o)});
  const result=await run.done;
  assert.equal(result.status,'resumed');assert.equal(result.confirmedBy,'desktop-transcript');
  assert.equal(f.messages.length,1);assert.equal(f.messages[0].uuid,run.messageUuid);
  assert.ok(result.deliveredAt);assert.ok(result.responseAt);
  assert.ok(!fs.readFileSync(logFile,'utf8').includes(f.registration.token));
 } finally {await f.close();}
});

test('1000 次并发重复请求只投递一次；重新连接仍沿用持久去重记录',async()=>{
 const f=await fixture();
 try {
  const key=requestKey('duplicate-1000'),request={type:'send',key,message:'继续'};
  // 分批限制连接数；同时覆盖每批并发和前一批完成后的重复点击。
  for(let batch=0;batch<20;batch++) {
   const results=await Promise.all(Array.from({length:50},()=>bridgeRequest(f.registration,request)));
   assert.ok(results.every(result=>result.ok));
  }
  await wait(20);
  assert.equal(f.messages.length,1);
  const receipt=readDesktopReceipt(f.home,key);
  assert.equal(desktopOutcome(receipt).status,'resumed');
  const replay=await bridgeRequest(readRegistration(f.home,id),request);
  assert.equal(replay.ok,true);assert.equal(f.messages.length,1);
 } finally {await f.close();}
});

test('持久记录已存在时，换一个接入进程也不会重新投递',async()=>{
 const f=await fixture();
 try {
  const request={type:'send',key:requestKey('restarted-bridge'),message:'继续'};
  await bridgeRequest(f.registration,request);await wait(10);
  const restarted=await f.restart();
  assert.notEqual(restarted.endpoint,f.registration.endpoint);
  assert.equal((await bridgeRequest(restarted,request)).ok,true);
  await wait(10);
  const receipt=readDesktopReceipt(f.home,request.key);
  assert.equal(receipt.status,'submitted');assert.equal(f.messages.length,1);
 } finally {await f.close();}
});

test('认证失败、超长内容和同一标识换内容都不会触发第二次发送',async()=>{
 const f=await fixture();
 try {
  const key=requestKey('validation');
  assert.equal((await bridgeRequest({...f.registration,token:'0'.repeat(64)},{type:'send',key,message:'继续'})).errorCode,'desktop_auth');
  assert.equal((await bridgeRequest(f.registration,{type:'send',key,message:'x'.repeat(501)})).errorCode,'desktop_protocol');
  assert.equal(f.messages.length,0);
  await bridgeRequest(f.registration,{type:'send',key,message:'继续'});await wait(10);
  assert.equal((await bridgeRequest(f.registration,{type:'send',key,message:'另一条消息'})).errorCode,'desktop_protocol');
  assert.equal(f.messages.length,1);
 } finally {await f.close();}
});

test('写入 socket 不等于送达：未落入原记录、无回复、API 错误分别有明确结果',async()=>{
 for(const accept of [false,true]) {
  const f=await fixture({reply:false,accept});
  try {
   const key=requestKey(`no-reply-${accept}`);
   await bridgeRequest(f.registration,{type:'send',key,message:'继续'});await wait(10);
   const receipt=readDesktopReceipt(f.home,key);
   const result=desktopOutcome(receipt,{now:receipt.at+300000});
   assert.equal(result.status,'unconfirmed');assert.equal(result.retryable,false);
   assert.equal(result.errorCode,accept?'reply_timeout':'delivery_unknown');
   if(accept) {
    fs.appendFileSync(f.transcriptFile,JSON.stringify({type:'assistant',isApiErrorMessage:true,error:'rate_limit',message:{content:[{type:'text',text:'额度尚未恢复'}]}})+'\n');
    assert.equal(desktopOutcome(receipt).status,'failed');
   }
  } finally {await f.close();}
 }
});

test('另一条用户消息之后的回复不能冒充这一次续接的成功',()=>{
 const home=tmpDir('foreign-reply'),transcriptFile=path.join(home,`${id}.jsonl`),uuid=crypto.randomUUID();
 const records=[{type:'user',uuid,timestamp:new Date().toISOString()},{type:'user',uuid:crypto.randomUUID()}, {type:'assistant',message:{content:[{type:'text',text:'另一轮回复'}]}}];
 fs.writeFileSync(transcriptFile,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
 assert.notEqual(desktopOutcome({id,uuid,at:Date.now(),transcriptFile,status:'submitted'}).status,'resumed');
});

test('回执丢失或收信确认迟到时，继续核对同一 UUID，不重复提交',async()=>{
 const f=await fixture({reply:false,accept:false});
 try {
  const key=requestKey('late-ack');
  await bridgeRequest(f.registration,{type:'send',key,message:'继续'});await wait(10);
  const receipt={...readDesktopReceipt(f.home,key),status:'uncertain'};
  writePrivateJson(receiptFile(f.home,key),receipt);
  assert.equal(desktopOutcome(receipt,{now:receipt.at+30000}).status,'unconfirmed');
  fs.appendFileSync(f.transcriptFile,JSON.stringify({type:'user',uuid:receipt.uuid,sessionId:id,timestamp:new Date().toISOString()})+'\n');
  fs.appendFileSync(f.transcriptFile,JSON.stringify({type:'assistant',sessionId:id,message:{content:[{type:'text',text:'收到迟到的消息并开始执行'}]}})+'\n');
  assert.equal(desktopOutcome(receipt).status,'resumed');
  await bridgeRequest(f.registration,{type:'send',key,message:'继续'});await wait(10);
  assert.equal(f.messages.length,1);
 } finally {await f.close();}
});

test('其他会话即使意外带同一 UUID，也不能确认原桌面收信',()=>{
 const home=tmpDir('wrong-desktop'),transcriptFile=path.join(home,`${id}.jsonl`),uuid=crypto.randomUUID();
 fs.writeFileSync(transcriptFile,JSON.stringify({type:'user',uuid,sessionId:'another-session',timestamp:new Date().toISOString()})+'\n');
 assert.equal(desktopOutcome({id,uuid,at:Date.now(),transcriptFile,status:'submitted'}).status,'sent');
});

test('CLI 首次回复超时有上限，仅停止自己创建的子进程',async()=>{
 const home=tmpDir('startup-timeout'),logFile=path.join(home,'log');
 const command={source:'claude',sessionId:id,bin:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:home};
 const run=runCommand(command,{logFile,startupTimeoutMs:80,pollMs:10});
 const result=await run.done;
 assert.equal(result.errorCode,'startup_timeout');assert.equal(result.retryable,false);
 assert.match(fs.readFileSync(logFile,'utf8'),/startup_timeout/);
});

test('已经开始回复的长任务不会被首次回复计时器杀掉',async()=>{
 const home=tmpDir('long-task'),logFile=path.join(home,'log');
 const events=[{type:'assistant',session_id:id,message:{content:[{type:'text',text:'开始执行'}]}},{type:'result',subtype:'success',session_id:id,is_error:false}];
 const script=`console.log(${JSON.stringify(JSON.stringify(events[0]))});setTimeout(()=>{console.log(${JSON.stringify(JSON.stringify(events[1]))});},500);`;
 const run=runCommand({source:'claude',sessionId:id,bin:process.execPath,args:['-e',script],cwd:home},{logFile,startupTimeoutMs:250,pollMs:10});
 const result=await run.done;
 assert.equal(result.code,0);assert.equal(result.confirmedBy,'result.success');
});
