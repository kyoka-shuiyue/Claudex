// 通过 SessionStart 启动的会话子进程投递。只使用本机 inbox，不读取桌面账户凭据。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTailRecords } from './jsonl.mjs';
import { safeError } from './send-result.mjs';
import { integrationPreview } from './claude-integration.mjs';

export const validSessionId = value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value || '');
export const requestKey = value => crypto.createHash('sha256').update(value).digest('hex');
export const bridgeDirectory = home => path.join(home, 'desktop-bridge');
export const registrationFile = (home,id) => path.join(bridgeDirectory(home), `${id}.json`);
export const receiptFile = (home,key) => path.join(bridgeDirectory(home), 'receipts', `${key}.json`);

export function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
  if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) throw new Error('拒绝写入链接目录');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('拒绝覆盖链接文件');
  const tmp=`${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600,flag:'wx'});
  fs.renameSync(tmp,file);
}

function readSmallJson(file,max=16384) {
  const stat=fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size>max) throw new Error('无效的本机会话记录');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}

export function readRegistration(home,id) {
  if (!validSessionId(id)) return null;
  try {
    const rec=readSmallJson(registrationFile(home,id));
    if (rec.version!==1 || rec.id!==id || !/^[0-9a-f]{64}$/.test(rec.token) || !Number.isInteger(rec.pid)) return null;
    if (process.platform==='win32' && !/^\\\\\.\\pipe\\LOCAL\\claudex-[0-9a-f]{32}$/i.test(rec.endpoint)) return null;
    if (process.platform!=='win32' && path.dirname(rec.endpoint)!==bridgeDirectory(home)) return null;
    if (typeof rec.transcriptFile!=='string' || path.basename(rec.transcriptFile)!==`${id}.jsonl`) return null;
    try {process.kill(rec.pid,0);} catch {return null;}
    return rec;
  } catch {return null;}
}

export function bridgeRequest(registration, request, {timeoutMs=3000}={}) {
  return new Promise(resolve=>{
    const socket=net.connect(registration.endpoint);
    let text='',finished=false;
    const finish=result=>{if(finished)return;finished=true;clearTimeout(timer);socket.destroy();resolve(result);};
    const timer=setTimeout(()=>finish({error:'桌面会话接入未响应',errorCode:'desktop_unavailable'}),timeoutMs);
    socket.on('connect',()=>socket.write(JSON.stringify({token:registration.token,...request})+'\n'));
    socket.on('data',chunk=>{
      text+=chunk.toString('utf8');
      if(text.length>16384)return finish({error:'桌面接入返回无效数据',errorCode:'desktop_protocol'});
      if(!text.includes('\n'))return;
      try {finish(JSON.parse(text.slice(0,text.indexOf('\n'))));}
      catch {finish({error:'桌面接入返回无效数据',errorCode:'desktop_protocol'});}
    });
    socket.on('error',()=>finish({error:'原桌面会话未连接，请在 Claude 中打开该会话后重试',errorCode:'desktop_unavailable'}));
    socket.on('end',()=>finish({error:'桌面接入已断开，投递结果需要核对',errorCode:'delivery_unknown'}));
  });
}

const textOf = rec => typeof rec?.message?.content==='string' ? rec.message.content :
  (rec?.message?.content || []).map(block=>block.text || '').join(' ');

export function openDesktopSession(id) {
  if(process.platform!=='win32'||!validSessionId(id))return Promise.resolve(false);
  return new Promise(resolve=>{
    execFile('powershell.exe',['-NoProfile','-WindowStyle','Hidden','-Command','Start-Process -FilePath $env:CLAUDEX_SESSION_URL -WindowStyle Hidden'],
      {env:{...process.env,CLAUDEX_SESSION_URL:`claude://resume?session=${id}`},windowsHide:true,timeout:8000},error=>resolve(!error));
  });
}

export function desktopOutcome(receipt,{now=Date.now(),deliveryTimeoutMs=15000,responseTimeoutMs=180000}={}) {
  if (!receipt || !['submitting','submitted','uncertain'].includes(receipt.status)) return receipt || {status:'failed',code:1,error:'没有桌面投递记录'};
  let records=[];
  try {records=readTailRecords(receipt.transcriptFile,{start:65536,enough:rs=>rs.some(r=>r.uuid===receipt.uuid)});} catch {}
  const sameSession=record=>!(record.sessionId||record.session_id)||(record.sessionId||record.session_id)===receipt.id;
  const userIndex=records.findIndex(r=>r.type==='user' && r.uuid===receipt.uuid && sameSession(r));
  const user=records[userIndex];
  if (!user) {
    if(now-receipt.at>=deliveryTimeoutMs)return {status:'unconfirmed',code:1,errorCode:'delivery_unknown',retryable:false,error:'尚未在原桌面会话确认收信，请查看 Claude；为避免重复，没有自动重发。',progress:{phase:'unconfirmed'}};
    return {status:'sent',progress:{phase:'submitting'}};
  }
  const deliveredAt=Date.parse(user.timestamp)||receipt.at;
  // 不把之后由用户另发的一轮回复算作本次续接的成功。
  for(const record of records.slice(userIndex+1)) {
    if(!sameSession(record))continue;
    if(record.type==='user' && record.uuid!==receipt.uuid)break;
    if(record.type!=='assistant')continue;
    if(record.isApiErrorMessage || record.error)return {status:'failed',code:1,deliveredAt,errorCode:'desktop_api_error',retryable:true,error:safeError(textOf(record)||record.error),progress:{phase:'failed'}};
    if(record.message?.content?.length)return {status:'resumed',code:0,deliveredAt,responseAt:Date.parse(record.timestamp)||now,confirmedBy:'desktop-transcript',progress:{phase:'responding'}};
  }
  if(now-deliveredAt>=responseTimeoutMs)return {status:'unconfirmed',code:1,deliveredAt,errorCode:'reply_timeout',retryable:false,error:'消息已到原桌面会话，暂未看到模型回复；仍在监测，请在 Claude 查看当前状态。',progress:{phase:'waiting_response'}};
  return {status:'sent',deliveredAt,progress:{phase:'delivered'}};
}

export function readDesktopReceipt(home,key) {
  try {return readSmallJson(receiptFile(home,key));} catch {return null;}
}

export async function runDesktopCommand(command,{home,claudeHome,logFile,onProgress=()=>{},pollMs=500,openSession=openDesktopSession,openTimeoutMs=15000}={}) {
  let registration=readRegistration(home,command.sessionId);
  let installed=false;
  if(!registration && claudeHome)try {installed=integrationPreview({claudeHome,root:fileURLToPath(new URL('../../',import.meta.url))}).alreadyInstalled;}catch{}
  if(!registration && installed && await openSession(command.sessionId)) {
    const deadline=Date.now()+openTimeoutMs;
    while(!registration && Date.now()<deadline) {
      await new Promise(resolve=>setTimeout(resolve,200));
      registration=readRegistration(home,command.sessionId);
    }
  }
  if(!registration)return {error:'原会话尚未接入 Claude 桌面。启用本地会话接入并重新打开该会话后重试。',errorCode:'desktop_unavailable',retryable:false};
  const key=command.requestId;
  const response=await bridgeRequest(registration,{type:'send',key,message:command.message});
  const receipt=readDesktopReceipt(home,key);
  if(response.error && !receipt)return {...response,requestId:key,status:response.errorCode==='delivery_unknown'?'unconfirmed':'failed',retryable:false};
  if(!receipt || receipt.id!==command.sessionId)return {error:'桌面接入没有返回可核对的投递记录',status:'unconfirmed',requestId:key,errorCode:'delivery_unknown',retryable:false};
  fs.mkdirSync(path.dirname(logFile),{recursive:true});
  fs.appendFileSync(logFile,JSON.stringify({transport:'claude-desktop',sessionId:command.sessionId,requestId:key,uuid:receipt.uuid,at:receipt.at})+'\n');
  const done=new Promise(resolve=>{
    const poll=()=>{
      const outcome=desktopOutcome(readDesktopReceipt(home,key));
      onProgress(outcome);
      if(outcome.status!=='sent')return resolve(outcome);
      const timer=setTimeout(poll,pollMs);timer.unref();
    };
    setImmediate(poll);
  });
  return {pid:registration.pid,requestId:key,messageUuid:receipt.uuid,done};
}
