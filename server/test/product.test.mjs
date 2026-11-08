import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './fixtures.mjs';
import { createStore } from '../lib/store.mjs';
import { parseWindowsProxy, proxyEnvironment } from '../lib/proxy.mjs';
import { relocatedWorkspace, buildCommand } from '../lib/sender.mjs';
import { CodexDiagnostics } from '../lib/diagnostics.mjs';
import { Engine } from '../lib/engine.mjs';
import { createServer } from '../server.mjs';

test('系统代理仅补到子进程，保留现有代理值且可关闭', () => {
  const registry = 'ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    127.0.0.1:7890';
  assert.equal(parseWindowsProxy(registry), 'http://127.0.0.1:7890');
  assert.equal(parseWindowsProxy(registry.replace('0x1', '0x0')), null);
  assert.equal(parseWindowsProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=host:8080;https=secure:8443'), 'http://secure:8443');
  const env = { PATH: 'node', HTTPS_PROXY: 'http://custom:3128' };
  const result = proxyEnvironment({codex:{}}, env, 'http://127.0.0.1:7890');
  assert.equal(result.HTTPS_PROXY, env.HTTPS_PROXY);
  assert.equal(result.ALL_PROXY, env.HTTPS_PROXY);
  assert.equal(env.ALL_PROXY, undefined);
  assert.equal(proxyEnvironment({codex:{useSystemProxy:false}}, env, 'http://127.0.0.1:7890'), env);
});

test('迁移仅映射旧目录及其子目录，保留相似名字的其他目录', () => {
  const parent = tmpDir('move');
  const from = path.join(parent, 'old');
  const to = path.join(parent, 'new');
  const moves = [{from,to}];
  assert.equal(relocatedWorkspace(path.join(from, 'work'), moves), path.join(to, 'work'));
  assert.equal(relocatedWorkspace(from, moves), to);
  assert.equal(relocatedWorkspace(from + '-other', moves), from + '-other');
  assert.equal(buildCommand({source:'codex',id:'id',cwd:from}, '继续', {workspaceMoves:moves,codex:{useSystemProxy:false}}, {codex:'codex.exe'}).cwd, to);
});

function diagnosticSetup({ fail = false, withMarker = true } = {}) {
  const store = createStore(tmpDir('test-home'));
  const home = tmpDir('test-codex');
  let finish;
  let command;
  const diagnostic = new CodexDiagnostics({ store, bin:'codex.exe', codexHome:home, token:()=> 'UNIT_TEST', runner: (cmd, {logFile}) => {
    command = cmd;
    fs.mkdirSync(path.dirname(logFile),{recursive:true});
    fs.writeFileSync(logFile, [
      {type:'thread.started',thread_id:'test-only'},
      {type:'item.completed',item:{type:'agent_message',text:withMarker ? 'Claudex 连接成功。 CLAUDEX_TEST_UNIT_TEST' : '没有验证标记'}},
    ].map(x=>JSON.stringify(x)).join('\n'));
    return { pid: 123, done: new Promise(r => { finish = () => r({code:fail?1:0}); }) };
  }});
  return {store,diagnostic,finish:()=>finish(),command:()=>command};
}

test('单次真实测试与演练队列隔离，运行时防重入，成功后复用专用会话', async () => {
  const t = diagnosticSetup();
  assert.equal(t.diagnostic.start(),true);
  assert.equal(t.diagnostic.result.status,'running');
  assert.equal(t.diagnostic.start(),false);
  assert.deepEqual(t.command().args.slice(0,2),['exec','--skip-git-repo-check']);
  assert.ok(!t.command().args.includes(null));
  t.finish(); await new Promise(r=>setImmediate(r));
  assert.equal(t.diagnostic.result.status,'success');
  assert.equal(t.store.config.dryRun,true);
  assert.equal(t.store.config.codex.testSessionId,'test-only');
  assert.deepEqual(t.store.state.sends,{});
});

test('退出非零或没有验证标记时，单次测试不能报告成功', async () => {
  for (const option of [{fail:true},{withMarker:false}]) {
    const t=diagnosticSetup(option); t.diagnostic.start(); t.finish();
    await new Promise(r=>setImmediate(r));
    assert.equal(t.diagnostic.result.status,'failed');
    assert.equal(t.store.config.codex.testSessionId,null);
  }
});

test('服务重启后仍跟踪正在运行的专用测试，禁止重复发送', async () => {
  const t=diagnosticSetup(); t.diagnostic.start();
  // 用当前进程模拟仍存活的已启动子进程，不启动任何外部程序。
  t.store.state.codexTest.pid=process.pid;
  const recovered=new CodexDiagnostics({store:t.store,bin:'fake.exe',codexHome:tmpDir('restart-home'),runner:()=>{throw new Error('不应重启测试');}});
  assert.equal(recovered.result.status,'running');
  assert.equal(recovered.start(),false);
  clearInterval(recovered.recoveryTimer);
  t.finish(); await new Promise(r=>setImmediate(r));
});

test('模型完成且验证回复已到达时立即报告成功，不等待 CLI 清理进程', async () => {
  const t=diagnosticSetup(); t.diagnostic.start();
  fs.appendFileSync(t.diagnostic.result.logFile,'\n'+JSON.stringify({type:'turn.completed'})+'\n');
  await new Promise(r=>setTimeout(r,400));
  assert.equal(t.diagnostic.result.status,'success');
  assert.equal(t.diagnostic.result.confirmedBy,'turn.completed');
  t.finish();
});

test('真实本机接口提供运行身份、测试防重入和代理开关，设置响应保留运行状态', async () => {
  const store=createStore(tmpDir('api-product'));
  const engine=new Engine({store,env:{CLAUDEX_CODEX_BIN:'fake.exe',CLAUDEX_CLAUDE_BIN:'fake.exe'},homes:{codex:tmpDir('empty-codex'),claude:tmpDir('empty-claude')}});
  const diagnostics={result:{status:'idle'},start(){if(this.result.status==='running')return false;this.result={status:'running',startedAt:Date.now()};return true;}};
  const app=createServer({store,engine,diagnostics,port:0});
  const url=await app.start();
  const post=(route,body)=>fetch(url+route,{method:'POST',body:JSON.stringify(body)});
  try{
    const health=await (await fetch(url+'/api/health')).json();
    assert.equal(health.app,'Claudex');assert.equal(health.version,'0.3.1');assert.equal(health.mode,'dry');
    const first=await post('/api/test-codex',{});assert.equal(first.status,202);
    assert.equal((await first.json()).diagnostics.codex.status,'running');
    assert.equal((await post('/api/test-codex',{})).status,409);
    const config=await (await post('/api/config',{codex:{useSystemProxy:false}})).json();
    assert.equal(config.config.codex.useSystemProxy,false);
    assert.equal(config.runtime.app,'Claudex');
    assert.equal(config.diagnostics.codex.status,'running');
    assert.equal((await post('/api/config',{codex:{useSystemProxy:'yes'}})).status,400);
    const evil=await fetch(url+'/api/test-codex',{method:'POST',headers:{origin:'https://example.com'},body:'{}'});
    assert.equal(evil.status,403);
  }finally{app.stop();}
});
