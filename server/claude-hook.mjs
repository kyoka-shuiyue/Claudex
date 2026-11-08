// 可选接入，须由用户授权添加到 Claude SessionStart hooks 后才运行。
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRegistration,bridgeRequest,validSessionId } from './lib/claude-desktop.mjs';
import { startDesktopAgent } from './lib/desktop-agent.mjs';

let input='';
for await(const chunk of process.stdin){input+=chunk;if(input.length>65536)process.exit(0);}
try {
  const data=JSON.parse(input),homeArg=process.argv.indexOf('--home');
  const home=(homeArg>=0?process.argv[homeArg+1]:null)||process.env.CLAUDEX_HOME||path.join(os.homedir(),'.claudex');
  const id=data.session_id;
  if(!validSessionId(id)||!process.env.CLAUDE_CODE_MESSAGING_SOCKET||!process.env.CLAUDE_CODE_MESSAGING_TOKEN)process.exit(0);
  if(process.argv.includes('--agent')) {
    await startDesktopAgent({home,id,transcriptFile:data.transcript_path,claudeSocket:process.env.CLAUDE_CODE_MESSAGING_SOCKET,claudeToken:process.env.CLAUDE_CODE_MESSAGING_TOKEN});
  } else {
    const previous=readRegistration(home,id);
    if(previous?.claudeSocket===process.env.CLAUDE_CODE_MESSAGING_SOCKET && (await bridgeRequest(previous,{type:'ping'})).ok)process.exit(0);
    const agentEnv=Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','HOME','PATH','APPDATA','LOCALAPPDATA','CLAUDE_CODE_MESSAGING_SOCKET','CLAUDE_CODE_MESSAGING_TOKEN'].filter(key=>process.env[key]!=null).map(key=>[key,process.env[key]]));
    agentEnv.CLAUDEX_HOME=home;
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--agent'],{env:agentEnv,detached:true,windowsHide:true,stdio:['pipe','ignore','ignore']});
    child.on('error',()=>{});child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify(data));child.unref();
  }
} catch { /* 不阻塞原会话；Claudex 会明确显示尚未接入。 */ }
