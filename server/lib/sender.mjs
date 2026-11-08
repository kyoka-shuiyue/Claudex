// 找到 codex / claude 可执行文件，拼出“给某个会话发送继续”的命令并执行。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { proxyEnvironment, systemProxy } from './proxy.mjs';
import { commandOutcome, commandProgress } from './send-result.mjs';

function newestFile(candidates) {
  return candidates
    .flatMap(file => {try { const stat=fs.statSync(file);return stat.isFile() ? [{file,mtime:stat.mtimeMs}] : []; } catch {return [];} })
    .sort((a,b)=>b.mtime-a.mtime)[0]?.file || null;
}

function directories(folder) {
  if (!folder) return [];
  try { return fs.readdirSync(folder,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>path.join(folder,e.name)); }
  catch { return []; } // 更新器可能正在替换版本目录，下一次检测会重新发现。
}

function whereAll(name, env = process.env) {
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    return execFileSync(cmd, process.platform === 'win32' ? [name] : ['-a', name], { env, encoding: 'utf8', windowsHide: true, timeout: 2000 })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

// npm 生成的 .cmd 转发脚本里写着真正的 exe 路径，直接调用 exe 可以避开命令行外壳的转义问题
function exeFromCmdShim(cmdFile) {
  try {
    const m = fs.readFileSync(cmdFile, 'utf8').match(/"%dp0%\\([^"]+\.exe)"/i);
    if (!m) return null;
    const exe = path.join(path.dirname(cmdFile), m[1]);
    return fs.existsSync(exe) ? exe : null;
  } catch { return null; }
}

// Codex 桌面应用把 CLI 放在 %LOCALAPPDATA%\OpenAI\Codex\bin\<版本号>\codex.exe，升级后目录名会变
export function findCodexBin(env = process.env) {
  if (env.CLAUDEX_CODEX_BIN) return env.CLAUDEX_CODEX_BIN;
  const base = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : null;
  if (base) {
    const hit = newestFile(directories(base).map(d => path.join(d, 'codex.exe')));
    if (hit) return hit;
  }
  const found = whereAll('codex', env);
  return found.find(f => /\.exe$/i.test(f)) || found.map(exeFromCmdShim).find(Boolean) || found[0] || null;
}

export function findClaudeBin(env = process.env) {
  if (env.CLAUDEX_CLAUDE_BIN) return env.CLAUDEX_CLAUDE_BIN;
  const base = env.APPDATA && path.join(env.APPDATA, 'Claude', 'claude-code');
  if (base) {
    const candidates = [];
    for (const folder of directories(base)) {
      candidates.push(path.join(folder, 'claude.exe'));
      for (const build of directories(folder)) candidates.push(path.join(build, 'claude.exe'));
    }
    const bundled = newestFile(candidates);
    if (bundled) return bundled;
  }
  const found = whereAll('claude', env);
  return found.find(f => /\.exe$/i.test(f))
    || found.filter(f => /\.cmd$/i.test(f)).map(exeFromCmdShim).find(Boolean)
    || found[0] || null;
}

export function relocatedWorkspace(cwd, moves = []) {
  if (!cwd) return cwd;
  for (const move of [...moves].reverse()) {
    if (!move?.from || !move?.to) continue;
    const rel = path.relative(move.from, cwd);
    if (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)) return path.join(move.to, rel);
  }
  return cwd;
}

export function buildCommand(session, message, config, bins, {env = process.env, detectedProxy = systemProxy()} = {}) {
  const cwd = relocatedWorkspace(session.cwd, config.workspaceMoves);
  if (session.source === 'codex') {
    // codex exec 默认只读；打开“沿用原权限”后，按会话最近一轮的沙箱权限接上
    const inherit = config.codex?.inheritSandbox && session.sandbox ? ['-c', `sandbox_mode="${session.sandbox}"`] : [];
    return {
      bin: bins.codex,
      args: ['exec', ...(session.id ? ['resume'] : []), '--skip-git-repo-check', ...inherit, ...(config.codex?.extraArgs || []), ...(session.id ? [session.id] : []), message],
      cwd,
      env: proxyEnvironment(config, env, detectedProxy),
    };
  }
  if (session.entrypoint === 'claude-desktop') {
    return {source:'claude',transport:'claude-desktop',sessionId:session.id,message,cwd,args:[]};
  }
  return {
    source: 'claude',
    sessionId: session.id,
    bin: bins.claude,
    args: ['--print', ...(config.claude?.extraArgs || []), '--output-format', 'stream-json', '--verbose', '--resume', session.id, message],
    cwd,
    env: {...proxyEnvironment(config, env, detectedProxy, 'claude'),API_TIMEOUT_MS:env.API_TIMEOUT_MS || '60000'},
  };
}

const quote = a => (/[\s"'&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
export const describeCommand = cmd => cmd.transport==='claude-desktop' ?
  `Claude Desktop 原会话 ${cmd.sessionId}：${cmd.message}` :
  [cmd.bin ? path.basename(cmd.bin) : '(未找到程序)', ...cmd.args].map(quote).join(' ');

/**
 * 启动命令。会话恢复后可能要跑很久，所以子进程独立运行、输出写进日志，
 * Claudex 关掉也不影响它。返回 { pid, done }，done 在进程结束时给出退出码。
 */
export function runCommand(cmd, { logFile, onProgress=()=>{}, startupTimeoutMs=120000, pollMs=500 }) {
  if (!cmd.bin) return { error: '没有找到对应的命令行程序' };
  if (cmd.cwd && !fs.existsSync(cmd.cwd)) return { error: `会话的工作目录不存在：${cmd.cwd}` };
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  fs.writeSync(out, `# ${new Date().toISOString()}  ${describeCommand(cmd)}\n# cwd: ${cmd.cwd || process.cwd()}\n`);
  let child;
  try {
    child = spawn(cmd.bin, cmd.args, {
      env: cmd.env || process.env,
      cwd: cmd.cwd || undefined, detached: true, windowsHide: true, stdio: ['ignore', out, out],
    });
  } catch (e) {
    fs.closeSync(out);
    return { error: e.message };
  }
  let timer,forced,responded=false,progressKey='';
  const startedAt=Date.now();
  if(cmd.source==='claude') {
    timer=setInterval(()=>{
      const progress=commandProgress({logFile,sessionId:cmd.sessionId});
      responded ||= progress.phase==='responding' || progress.phase==='complete';
      const nextKey=JSON.stringify(progress);
      if(nextKey!==progressKey){progressKey=nextKey;onProgress({progress});}
      if(!responded && !forced && Date.now()-startedAt>=startupTimeoutMs) {
        forced={code:1,error:'Claude 在两分钟内没有开始回复，已停止本次 CLI 请求；请检查连接或服务商。',errorCode:'startup_timeout',retryable:false};
        fs.writeSync(out,JSON.stringify({type:'claudex',subtype:'startup_timeout',error:forced.error})+'\n');
        child.kill(); // 仅停止本函数持有的子进程，不按 PID 猜测或终止桌面进程。
      }
    },pollMs);
  }
  const done = new Promise(resolve => {
    child.on('error', e => resolve({ code: -1, error: e.message }));
    child.on('close', code => resolve(forced || commandOutcome({ source:cmd.source, sessionId:cmd.sessionId, logFile, code })));
  }).finally(() => {clearInterval(timer);try { fs.closeSync(out); } catch {} });
  child.unref();
  return { pid: child.pid, done };
}
