import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {accountSnapshot,readCodexAccount} from '../lib/codex-account.mjs';
import {commandOutcome,safeError} from '../lib/send-result.mjs';
import {tmpDir} from './fixtures.mjs';
import fs from 'node:fs';
import path from 'node:path';

test('新账户结构：仅七天 primary、未知套餐、其他产品额度与敏感字段隔离',()=>{
  const now=Date.now();
  const limits={limitId:'codex',planType:'prolite',primary:{usedPercent:30,windowDurationMins:10080,resetsAt:Math.floor(now/1000)+3600},secondary:null};
  const result=accountSnapshot({account:{type:'chatgpt',planType:'prolite',email:'private@example.invalid'}},{accountId:'private',rateLimits:{limitId:'review',primary:{usedPercent:99}},rateLimitsByLimitId:{codex:limits}},now);
  assert.equal(result.plan,'prolite');
  assert.equal(result.quota.fiveHour,null);
  assert.equal(result.quota.weekly.usedPercent,30);
  assert.equal(result.quota.source,'account');
  assert.doesNotMatch(JSON.stringify(result),/private|email|accountId/);
  assert.equal(accountSnapshot(null,{rateLimits:{limitId:'review',primary:{usedPercent:99}}},now).quota,null);
});

function rpcChild(respond) {
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin=new Writable({write(buffer,_encoding,done){
    for(const line of buffer.toString().trim().split('\n')){
      const req=JSON.parse(line); calls.push(req);
      const response=respond(req);
      if (response) queueMicrotask(()=>child.stdout.write(JSON.stringify({id:req.id,...response})+'\n'));
    }
    done();
  }});
  let killed=false;const calls=[];
  child.kill=()=>{killed=true;child.stdout.end();child.stderr.end();return true;};
  return {child,calls,killed:()=>killed};
}

test('RPC 只读账户与额度，初始化顺序正确，结束后释放自己的进程',async()=>{
  const t=rpcChild(req=>({result:req.method==='account/read'?{account:{type:'chatgpt',planType:'plus'}}:req.method==='account/rateLimits/read'?{rateLimits:{primary:{usedPercent:2,windowDurationMins:300}}}:{}}));
  const result=await readCodexAccount({bin:process.execPath,env:{},spawnProcess:()=>t.child});
  assert.equal(result.plan,'Plus');assert.equal(result.quota.fiveHour.usedPercent,2);
  assert.deepEqual(t.calls.map(r=>r.method),['initialize','initialized','account/read','account/rateLimits/read']);
  assert.deepEqual(t.calls[2].params,{refreshToken:false});
  assert.equal(t.killed(),true);
});

test('RPC 断开或超时会返回可显示错误，不让检测挂住',async()=>{
  for (const broken of ['timeout','exit']) {
    const t=rpcChild(()=>null);
    const pending=readCodexAccount({bin:process.execPath,env:{},timeoutMs:25,spawnProcess:()=>t.child});
    if(broken==='exit') queueMicrotask(()=>t.child.emit('exit',1));
    const result=await pending;
    assert.match(result.error,/超时|已结束/);assert.equal(t.killed(),true);
  }
});

test('套餐可单独识别；额度失败不丢掉套餐，不保存账户原文',async()=>{
  const t=rpcChild(req=>req.method==='account/read'?{result:{account:{type:'chatgpt',planType:'pro',email:'private@example.invalid'}}}:req.method==='account/rateLimits/read'?{error:{message:'network timeout'}}:{result:{}});
  const result=await readCodexAccount({bin:process.execPath,env:{},spawnProcess:()=>t.child});
  assert.equal(result.plan,'Pro');assert.equal(result.quota,null);assert.match(result.error,/timeout/);
  assert.doesNotMatch(JSON.stringify(result),/private/);
});

test('Claude 不能只凭退出码 0 报成功，必须确认同会话完整 result',()=>{
  const logFile=path.join(tmpDir('outcome'),'send.log');
  const args={source:'claude',sessionId:'same',logFile,code:0};
  fs.writeFileSync(logFile,'# command\n');
  assert.equal(commandOutcome(args).code,1);
  fs.appendFileSync(logFile,JSON.stringify({type:'result',subtype:'success',session_id:'other'})+'\n');
  assert.match(commandOutcome(args).error,/不同会话/);
  fs.appendFileSync(logFile,JSON.stringify({type:'result',subtype:'success',session_id:'same',is_error:false})+'\n');
  assert.equal(commandOutcome(args).confirmedBy,'result.success');
  fs.appendFileSync(logFile,'API Error: transient old error\n'+JSON.stringify({type:'result',subtype:'success',session_id:'same',is_error:false})+'\n');
  assert.equal(commandOutcome(args).confirmedBy,'result.success','完整成功结果优先于之前的瞬时错误');
  fs.appendFileSync(logFile,JSON.stringify({type:'result',subtype:'error_during_execution',session_id:'same',is_error:true,errors:['Unable to connect (EPROTO)']})+'\n');
  assert.match(commandOutcome(args).error,/EPROTO/);
});

test('错误消息过滤常见凭据与带认证信息的代理 URL',()=>{
  const result=safeError('Bearer secret-value api_key=private-key auth_token=hidden https://user:pass@proxy.invalid');
  assert.doesNotMatch(result,/secret-value|private-key|hidden|user:pass/);
});
