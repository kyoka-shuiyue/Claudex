// 只读 app-server RPC：不启动模型回合，不登录/登出，不读取或保存凭据。
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { proxyEnvironment } from './proxy.mjs';
import { planName, quotaFromRateLimits } from './codex.mjs';
import { safeError } from './send-result.mjs';

export function accountSnapshot(accountResult, limitsResult, now = Date.now()) {
  const account = accountResult?.account;
  const candidate = limitsResult?.rateLimits;
  const limits = limitsResult?.rateLimitsByLimitId?.codex ||
    (candidate && (!candidate.limitId || candidate.limitId==='codex') ? candidate : null);
  return {
    accountType:account?.type || null,
    plan:planName(account?.planType || limits?.planType),
    quota:quotaFromRateLimits(limits,{now}),
    checkedAt:now,
  };
}

export async function readCodexAccount({bin,codexHome,config={},env=process.env,timeoutMs=12000,spawnProcess=spawn,now=()=>Date.now()} = {}) {
  if (!bin || !fs.existsSync(bin)) return {error:'没有找到 Codex 程序；请安装或更新 Codex。',checkedAt:now()};
  const pending = new Map();
  let child, lines, timer, sequence=0, terminalError;
  const fail = error => {
    terminalError=error;
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  };
  const request = (method,params) => new Promise((resolve,reject)=>{
    if (terminalError) return reject(terminalError);
    const id=++sequence;
    pending.set(id,{resolve,reject});
    child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error) fail(error);});
  });
  try {
    child=spawnProcess(bin,['app-server','--listen','stdio://'],{
      env:{...proxyEnvironment(config,env),...(codexHome ? {CODEX_HOME:codexHome} : {})},
      windowsHide:true,stdio:['pipe','pipe','pipe'],
    });
    // 丢弃 stderr；RPC 错误经过脱敏后才返回，避免把运行环境或凭据写入状态。
    child.stderr.resume();
    child.on('error',fail);
    child.on('exit',()=>fail(Error('Codex 账户读取进程已结束')));
    child.stdin.on('error',fail);
    lines=readline.createInterface({input:child.stdout});
    lines.on('line',line=>{
      let message;try{message=JSON.parse(line);}catch{return;}
      const job=pending.get(message.id);
      if (!job) return;
      pending.delete(message.id);
      if (message.error) job.reject(Error(message.error.message || 'Codex 账户接口报错'));
      else job.resolve(message.result);
    });
    timer=setTimeout(()=>fail(Error('读取 Codex 实时账户超时，已保留历史额度。')),timeoutMs);
    await request('initialize',{clientInfo:{name:'claudex',title:'Claudex',version:'0.3.1'}});
    child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
    const [account,limits]=await Promise.allSettled([
      request('account/read',{refreshToken:false}),
      request('account/rateLimits/read',{}),
    ]);
    const snapshot=accountSnapshot(account.value,limits.value,now());
    const errors=[];
    if (account.status==='rejected') errors.push(account.reason.message);
    else if (!account.value?.account) errors.push('Codex 尚未登录账户。');
    if (limits.status==='rejected') errors.push(limits.reason.message);
    else if (!snapshot.quota) errors.push(snapshot.accountType==='apiKey' ? '当前使用 API Key，未返回订阅额度。' : '账户接口未返回额度窗口。');
    if (errors.length) snapshot.error=safeError([...new Set(errors)].join('；'));
    return snapshot;
  } catch(error) { return {error:safeError(error.message),checkedAt:now()}; }
  finally {
    clearTimeout(timer);
    lines?.close();
    if (child) {
      child.stdin.end();
      child.kill(); // 仅本次创建的只读 RPC 子进程，不影响 Codex 桌面或任务。
    }
  }
}
