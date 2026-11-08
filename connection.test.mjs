import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../lib/engine.mjs';
import { createStore } from '../lib/store.mjs';
import { createServer } from '../server.mjs';
import { buildCommand, findClaudeBin } from '../lib/sender.mjs';
import { claudeSession, claudeResetText, tmpDir } from './fixtures.mjs';

const bins = { codex: 'fake-codex.exe', claude: 'fake-claude.exe' };
const env = { CLAUDEX_CODEX_BIN: bins.codex, CLAUDEX_CLAUDE_BIN: bins.claude };
const setup = (extra = {}) => {
  const store = createStore(tmpDir('connections'));
  store.updateConfig({ autoSend:false, notify:false, retry:false });
  const homes = { codex:tmpDir('quota'), claude:tmpDir('claude') };
  return { store, homes, engine:new Engine({store,env,homes,...extra}) };
};

test('Claude 也得到子进程代理，Codex 的关闭选项不影响 Claude', () => {
  const command = buildCommand({source:'claude',id:'test'},'继续',
    {codex:{useSystemProxy:false},claude:{}},bins,
    {env:{},detectedProxy:'http://127.0.0.1:7890'});
  assert.equal(command.env?.HTTPS_PROXY,'http://127.0.0.1:7890');
  assert.ok(command.args.includes('stream-json'));
});

test('找到 Desktop 附带的新版 Claude CLI，显式路径仍优先', () => {
  const appData=tmpDir('desktop-cli');
  const first=path.join(appData,'Claude/claude-code/2.1.285/hash/claude.exe');
  const second=path.join(appData,'Claude/claude-code/2.1.317/hash/claude.exe');
  for (const file of [first,second]) {fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'');}
  fs.utimesSync(first,new Date(0),new Date(0));
  assert.equal(findClaudeBin({APPDATA:appData,PATH:''}),second);
  assert.equal(findClaudeBin({APPDATA:appData,CLAUDEX_CLAUDE_BIN:first}),first);
});

test('没有使用日志时也实时识别 Codex 套餐与仅有的本周窗口', async () => {
  const now=Date.now();
  const quota={fiveHour:null,weekly:{usedPercent:30,windowMinutes:10080,label:'本周',resetsAt:now+3600000},source:'account',observedAt:now};
  let call;
  const {engine}=setup({accountReader:async options=>{call=options;return {plan:'prolite',quota,accountType:'chatgpt'};}});
  await engine.check({send:false});
  assert.equal(engine.view().plans.codex,'prolite');
  assert.equal(engine.view().quota.codex.weekly.usedPercent,30);
  assert.equal(engine.view().quota.codex.fiveHour,null);
  assert.equal(engine.view().connections.codex.status,'live');
  assert.equal(call.bin,bins.codex);
});

test('程序升级后每次检测和发送重新发现路径', async () => {
  let current={...bins};
  const {engine,store}=setup({findBins:()=>current,accountReader:async()=>({error:'offline'})});
  current={...bins,codex:'new-codex.exe'};
  await engine.check({send:false});
  assert.equal(engine.view().tools.codex,'new-codex.exe');
  current={...bins,codex:'newer-codex.exe'};
  let used;
  engine.runner=command=>{used=command.bin;return {pid:1,done:new Promise(()=>{})};};
  await engine.sendOne({source:'codex',id:'test',key:'test',blockedAt:0},false);
  assert.equal(used,'newer-codex.exe');
  assert.equal(store.state.sends.test.status,'sent');
});

test('实时接口失败可显示带来源时间的上次读数，过重置时只作估计',async()=>{
  let now=Date.now(), online=true;
  const quota={fiveHour:null,weekly:{usedPercent:100,resetsAt:now+1000,windowMinutes:10080},source:'account',observedAt:now};
  const {engine}=setup({now:()=>now,accountReader:async()=>online ? {plan:'prolite',quota,accountType:'chatgpt'} : {error:'network timeout'}});
  await engine.check({send:false});
  online=false;now+=2000;
  await engine.check({send:false});
  const v=engine.view();
  assert.equal(v.connections.codex.status,'fallback');
  assert.match(v.connections.codex.error,/timeout/);
  assert.equal(v.plans.codex,'prolite');
  assert.equal(v.quota.codex.weekly.usedPercent,0);
  assert.equal(v.quota.codex.weekly.estimated,true);
  assert.equal(v.quota.codex.observedAt,quota.observedAt);
});

test('失败显示真正的网络错误；重启后旧请求不再永久停留正在续接', async () => {
  const {engine,store}=setup({accountReader:async()=>({error:'offline'})});
  const logFile=path.join(store.logsDir,'failed.log');
  fs.mkdirSync(store.logsDir,{recursive:true});
  fs.writeFileSync(logFile,'# header\nAPI Error: Unable to connect to API (EPROTO)\n');
  store.state.sends.old={key:'old',source:'claude',id:'old',mode:'real',status:'sent',at:Date.now()-300000,logFile,pid:2147483647};
  store.state.sends.legacy={key:'legacy',source:'claude',id:'legacy',mode:'real',status:'failed',at:Date.now()-300000,logFile,exitCode:1,error:'退出码 1'};
  await engine.check({send:false});
  assert.equal(store.state.sends.old.status,'failed');
  assert.match(store.state.sends.old.error,/EPROTO/);
  assert.match(store.state.sends.legacy.error,/EPROTO/);
});

test('Claude 自动续接失败后仍可安全找到原会话；用户手动继续后不再重试', async () => {
  const {engine,store,homes}=setup({accountReader:async()=>({error:'offline'})});
  const now=Date.now(), id='failed-resume';
  claudeSession(homes.claude,{id,blockedAt:now-3600000,text:claudeResetText(now-120000),cwd:homes.claude});
  await engine.check({send:false});
  const session=engine.classified()[0];
  const file=path.join(homes.claude,'projects/C--work-claudex/'+id+'.jsonl');
  store.state.sends[session.key]={...session,at:now,mode:'real',status:'failed',message:store.config.message};
  const append = r=>fs.appendFileSync(file,JSON.stringify({sessionId:id,cwd:homes.claude,entrypoint:'sdk-cli',timestamp:new Date(now+1).toISOString(),...r})+'\n');
  append({type:'user',message:{content:store.config.message}});
  append({type:'assistant',error:'server_error',isApiErrorMessage:true,message:{content:[{type:'text',text:'API Error: EPROTO'}]}});
  await engine.check({send:false});
  assert.equal(engine.classified()[0]?.key,session.key);
  assert.equal(engine.classified()[0]?.status,'failed');
  append({type:'user',message:{content:'我已经自行继续，请不要再次发送'}});
  await engine.check({send:false});
  assert.equal(engine.classified().length,0);
});

test('Claude CLI 即使退出码为 0，result 报错时也不能显示已接上',async()=>{
  const {engine,store}=setup({accountReader:async()=>({error:'offline'})});
  engine.runner=(_command,{logFile})=>{
    fs.mkdirSync(store.logsDir,{recursive:true});
    fs.writeFileSync(logFile,JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,session_id:'test',errors:['API Error: EPROTO']})+'\n');
    return {pid:1,done:Promise.resolve({code:0})};
  };
  const rec=await engine.sendOne({source:'claude',id:'test',key:'result-error',blockedAt:0},false);
  await new Promise(r=>setImmediate(r));
  assert.equal(rec.status,'failed');assert.match(rec.error,/EPROTO/);
});

test('手动发送接口在重试前重读会话，用户自行继续后拒绝旧请求',async()=>{
  let calls=0;
  const {engine,store,homes}=setup({accountReader:async()=>({error:'offline'}),runner:()=>{calls++;return {pid:1,done:new Promise(()=>{})};}});
  store.updateConfig({dryRun:false});
  const now=Date.now(),id='manual-after-failure';
  claudeSession(homes.claude,{id,blockedAt:now-3600000,text:claudeResetText(now-120000),cwd:homes.claude});
  const app=createServer({store,engine,port:0});const url=await app.start();
  try {
    const session=engine.classified()[0];
    fs.appendFileSync(path.join(homes.claude,'projects/C--work-claudex/'+id+'.jsonl'),JSON.stringify({type:'user',sessionId:id,timestamp:new Date().toISOString(),message:{content:'我已经继续了'}})+'\n');
    const response=await fetch(url+'/api/send-now',{method:'POST',body:JSON.stringify({keys:[session.key]})});
    assert.equal(response.status,409);assert.equal(calls,0);
  } finally {app.stop();}
});
