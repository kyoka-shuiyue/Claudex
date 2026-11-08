import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../lib/engine.mjs';
import { createStore } from '../lib/store.mjs';
import { buildCommand } from '../lib/sender.mjs';
import { tmpDir,claudeSession,claudeResetText } from './fixtures.mjs';
import {writePrivateJson,receiptFile} from '../lib/claude-desktop.mjs';

const bins={claude:'fake-claude.exe',codex:'fake-codex.exe'};
const desktop={source:'claude',id:'12345678-1234-4234-8234-123456789abc',key:'desktop',entrypoint:'claude-desktop',blockedAt:1};
const setup=extra=>{
 const store=createStore(tmpDir('delivery'));
 store.updateConfig({dryRun:false,autoSend:false,retry:false,notify:false});
 return {store,engine:new Engine({store,homes:{claude:tmpDir('delivery-claude'),codex:tmpDir('delivery-codex')},findBins:()=>bins,accountReader:async()=>({error:'offline'}),...extra})};
};

test('桌面原会话必须走桌面投递，不能另起 headless CLI 换掉登录通道',()=>{
 const command=buildCommand(desktop,'继续',{claude:{},codex:{}},bins,{env:{},detectedProxy:null});
 assert.equal(command.transport,'claude-desktop');
 assert.ok(!command.args.includes('--print'));
});

test('缺少桌面接入时立即报告原因，不启动 CLI，也不能宣称正在续接',async()=>{
 let cliCalls=0;
 const {engine}=setup({runner:()=>{cliCalls++;return{pid:1,done:new Promise(()=>{})};}});
 const rec=await engine.sendOne(desktop,false);
 assert.equal(cliCalls,0);
 assert.equal(rec.status,'failed');
 assert.equal(rec.errorCode,'desktop_unavailable');
 assert.equal(rec.retryable,false);
});

test('仍活着的 Claude 请求在 524 重试时显示真实阶段，不把进程存活当送达',async()=>{
 const {engine,store}=setup();
 const logFile=path.join(store.logsDir,'524.log');
 fs.mkdirSync(store.logsDir,{recursive:true});
 fs.writeFileSync(logFile,JSON.stringify({type:'system',subtype:'api_retry',attempt:2,error_status:524,session_id:'native-cli'})+'\n');
 store.state.sends.pending={key:'pending',source:'claude',id:'native-cli',mode:'real',status:'sent',pid:process.pid,at:Date.now()-300000,logFile};
 engine.recoverSends();
 const rec=store.state.sends.pending;
 assert.equal(rec.progress?.phase,'retrying');
 assert.equal(rec.progress?.httpStatus,524);
 assert.equal(rec.deliveredAt,undefined);
});

test('投递回执断开后保留去重占位；后台恢复仍可认出迟到的原桌面回复',async()=>{
 let requestId;
 const {engine,store}=setup({desktopRunner:async command=>{requestId=command.requestId;return {status:'unconfirmed',error:'回执断开',errorCode:'delivery_unknown',retryable:false};}});
 const rec=await engine.sendOne(desktop,false);
 assert.equal(rec.status,'unconfirmed');assert.equal(rec.requestId,requestId);
 const uuid='12345678-aaaa-4234-8234-123456789abc';
 const transcriptFile=path.join(store.home,`${desktop.id}.jsonl`);
 fs.writeFileSync(transcriptFile,[{type:'user',sessionId:desktop.id,uuid,timestamp:new Date().toISOString()}, {type:'assistant',sessionId:desktop.id,message:{content:[{type:'text',text:'已经继续'}]}}].map(r=>JSON.stringify(r)).join('\n')+'\n');
 writePrivateJson(receiptFile(store.home,requestId),{id:desktop.id,uuid,at:rec.at,transcriptFile,status:'uncertain'});
 engine.recoverSends();
 assert.equal(rec.status,'resumed');assert.equal(rec.error,null);assert.equal(rec.confirmedBy,'desktop-transcript');
 assert.equal(rec.messageUuid,uuid);
});

test('CLI 请求在首个回复前失败，自己的用户消息仍可认领；接入失败重试后不丢原中断',async()=>{
 const {engine,store}=setup(),now=Date.now(),id=desktop.id,home=engine.homes.claude;
 claudeSession(home,{id,cwd:home,blockedAt:now-3600000,text:claudeResetText(now-120000)});
 await engine.check({send:false});
 const session=engine.classified()[0],file=path.join(home,'projects/C--work-claudex',`${id}.jsonl`);
 const attempt={...session,at:now-300000,mode:'real',status:'failed',message:store.config.message,transport:'cli'};
 store.state.sends[session.key]=attempt;
 fs.appendFileSync(file,JSON.stringify({type:'user',sessionId:id,entrypoint:'sdk-cli',timestamp:new Date(attempt.at+20).toISOString(),message:{content:store.config.message}})+'\n');
 await engine.check({send:false});
 assert.equal(engine.classified()[0]?.key,session.key,'没有 assistant 错误行也不能丢掉自己的失败请求');
 await engine.sendOne(engine.classified()[0],false);
 await engine.check({send:false});
 assert.equal(engine.classified()[0]?.key,session.key,'尚未发出新消息的桌面接入失败不应覆盖旧提交归属');
 fs.appendFileSync(file,JSON.stringify({type:'user',sessionId:id,entrypoint:'claude-desktop',timestamp:new Date().toISOString(),message:{content:'我已自行继续'}})+'\n');
 await engine.check({send:false});
 assert.equal(engine.classified().length,0);
});
