// 这个进程由 Claude 的 SessionStart hook 启动；会话的临时 inbox token 只留在进程内。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { bridgeDirectory, registrationFile, receiptFile, readDesktopReceipt, writePrivateJson, validSessionId } from './claude-desktop.mjs';

export async function startDesktopAgent({home,id,transcriptFile,claudeSocket,claudeToken,heartbeatMs=30000,forwardTimeoutMs=3000}) {
  if(!validSessionId(id) || !claudeSocket || !claudeToken || path.basename(transcriptFile||'')!==`${id}.jsonl`)throw new Error('缺少会话接入信息');
  if(process.platform==='win32' && !/^\\\\\.\\pipe\\(?:LOCAL\\)?cc-msg-[0-9a-f]{32}$/i.test(claudeSocket))throw new Error('拒绝非本机会话地址');
  const nonce=crypto.randomBytes(16).toString('hex'),token=crypto.randomBytes(32).toString('hex');
  const endpoint=process.platform==='win32' ? `\\\\.\\pipe\\LOCAL\\claudex-${nonce}` : path.join(bridgeDirectory(home),`${nonce}.sock`);
  const pending=new Map();
  const authenticate=value=>typeof value==='string' && value.length===token.length && crypto.timingSafeEqual(Buffer.from(value),Buffer.from(token));
  async function send(request) {
    if(!/^[0-9a-f]{64}$/.test(request.key)||typeof request.message!=='string'||!request.message.trim()||request.message.length>500)return {error:'无效的续接请求',errorCode:'desktop_protocol'};
    const existing=readDesktopReceipt(home,request.key);
    if(existing) {
      if(existing.id!==id || existing.message!==request.message)return {error:'投递标识与内容不一致',errorCode:'desktop_protocol'};
      return {ok:true,status:existing.status};
    }
    if(pending.has(request.key))return pending.get(request.key);
    const operation=(async()=>{
      const receipt={id,key:request.key,message:request.message,uuid:crypto.randomUUID(),at:Date.now(),transcriptFile,status:'submitting'};
      // 在写入 inbox 之前落盘。重启、断连或响应丢失都不盲目重复同一次发送。
      writePrivateJson(receiptFile(home,request.key),receipt);
      const result=await new Promise(resolve=>{
        const socket=net.connect(claudeSocket);
        let finished=false;
        const finish=result=>{if(finished)return;finished=true;clearTimeout(timer);socket.destroy();resolve(result);};
        const timer=setTimeout(()=>finish({error:'连接原会话超时，投递结果需要核对',errorCode:'delivery_unknown'}),forwardTimeoutMs);
        socket.on('connect',()=>{
          const payload={type:'user',uuid:receipt.uuid,session_id:id,parent_tool_use_id:null,message:{role:'user',content:request.message}};
          socket.end(JSON.stringify({type:'auth',token:claudeToken})+'\n'+JSON.stringify(payload)+'\n',()=>finish({ok:true}));
        });
        socket.on('error',()=>finish({error:'原 Claude 会话连接已断开',errorCode:'desktop_unavailable'}));
      });
      receipt.status=result.ok?'submitted':'uncertain';
      if(result.error){receipt.error=result.error;receipt.errorCode=result.errorCode;receipt.retryable=false;}
      writePrivateJson(receiptFile(home,request.key),receipt);
      return result;
    })().finally(()=>pending.delete(request.key));
    pending.set(request.key,operation);
    return operation;
  }
  const clients=new Set();
  const server=net.createServer(socket=>{
    clients.add(socket);socket.once('close',()=>clients.delete(socket));
    socket.setTimeout(4000,()=>socket.destroy());
    let buffer='',handled=false;
    socket.on('error',()=>{});
    socket.on('data',async chunk=>{
      if(handled)return;
      buffer+=chunk.toString('utf8');
      if(buffer.length>8192){handled=true;socket.destroy();return;}
      if(!buffer.includes('\n'))return;
      handled=true;
      let result;
      try {
        const request=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));
        if(!authenticate(request.token))result={error:'本地接入验证失败',errorCode:'desktop_auth'};
        else if(request.type==='ping')result={ok:true,id,pid:process.pid};
        else if(request.type==='send')result=await send(request);
        else result={error:'未知的本地接入请求',errorCode:'desktop_protocol'};
      } catch {result={error:'桌面投递失败，请检查本地接入',errorCode:'desktop_protocol'};}
      if(!socket.destroyed)socket.end(JSON.stringify(result)+'\n');
    });
  });
  fs.mkdirSync(bridgeDirectory(home),{recursive:true,mode:0o700});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve);});
  writePrivateJson(registrationFile(home,id),{version:1,id,pid:process.pid,endpoint,token,claudeSocket,transcriptFile,createdAt:Date.now()});
  let failures=0,heartbeatBusy=false;
  const heartbeat=setInterval(()=>{
    if(heartbeatBusy)return;heartbeatBusy=true;
    const socket=net.connect(claudeSocket);
    const done=ok=>{if(!heartbeatBusy)return;heartbeatBusy=false;socket.destroy();failures=ok?0:failures+1;if(failures>=2)void close();};
    socket.setTimeout(3000,()=>done(false));
    socket.once('error',()=>done(false));
    socket.once('connect',()=>{socket.end(JSON.stringify({type:'auth',token:claudeToken})+'\n');done(true);});
  },heartbeatMs);
  async function close() {
    clearInterval(heartbeat);for(const client of clients)client.destroy();
    await new Promise(resolve=>server.close(resolve));
    try {const current=JSON.parse(fs.readFileSync(registrationFile(home,id),'utf8'));if(current.token===token)fs.unlinkSync(registrationFile(home,id));}catch{}
    if(process.platform!=='win32')try{fs.unlinkSync(endpoint);}catch{}
  }
  return {server,endpoint,token,close};
}
