// 从有界日志尾部确认结果。错误可以展示，凭据不能进入界面或状态文件。
import fs from 'node:fs';
import { readTailRecords } from './jsonl.mjs';

export function safeError(value) {
  return String(value || '')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
    .slice(0, 700);
}

function logTail(file) {
  if (!file) return '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, 65536), buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size-length);
    return buffer.toString('utf8');
  } catch { return ''; }
  finally { if (fd != null) fs.closeSync(fd); }
}

export function commandOutcome({source,sessionId,logFile,code,error,requireResult = true}) {
  let events = [];
  try { if (logFile) events = readTailRecords(logFile, {start:65536,enough:rs=>rs.some(r=>r.type==='result')}); } catch {}
  const result = events.findLast(e=>e.type==='result');
  const text = logTail(logFile);
  const line = text.split(/\r?\n/).findLast(s=>!s.startsWith('#') && /^(?:API Error:|Error:|ERROR\b)|Unable to connect to API|Authentication failed|Not logged in/i.test(s));
  if (error) return {code:code ?? 1,error:safeError(error)};
  if (source === 'claude' && result) {
    if (sessionId && result.session_id && result.session_id !== sessionId) return {code:1,error:'Claude 回复来自不同会话，未确认续接。'};
    if (result.subtype !== 'success' || result.is_error) return {code:code ?? 1,error:safeError(result.errors?.join('; ') || result.result || result.subtype || 'Claude 没有完成这一轮')};
    return {code:code ?? 0,confirmedBy:'result.success'};
  }
  const timeout=events.findLast(e=>e.type==='claudex' && e.subtype==='startup_timeout');
  if(timeout)return {code:1,error:safeError(timeout.error),errorCode:'startup_timeout',retryable:false};
  if (line) return {code:code ?? 1,error:safeError(line)};
  const retry=events.findLast(e=>e.type==='system'&&e.subtype==='api_retry');
  if(code!=null&&code!==0&&retry)return {code,error:`CLI 连接${retry.error_status?'返回 HTTP '+retry.error_status:''}，重试后仍未确认模型回复。`,errorCode:'network_retry'};
  if (code === 0 && source === 'claude' && requireResult) return {code:1,error:'Claude 已退出，但没有返回完整回合结果；请查看发送日志。'};
  return {code, ...(code != null && code !== 0 ? {error:`退出码 ${code}`} : {})};
}

export function commandProgress({logFile,sessionId}) {
  let events=[];
  try {if(logFile)events=readTailRecords(logFile,{start:65536,max:2*1024*1024,enough:()=>true});}catch{}
  for(const event of events.reverse()) {
    if(sessionId && event.session_id && event.session_id!==sessionId)continue;
    if(event.type==='result')return {phase:event.subtype==='success'&&!event.is_error?'complete':'failed'};
    if(event.type==='system'&&event.subtype==='api_retry')return {phase:'retrying',attempt:event.attempt,httpStatus:event.error_status || null};
    if(event.type==='assistant'&&!event.isApiErrorMessage&&!event.error || event.type==='stream_event'&&event.event?.type==='message_start')return {phase:'responding'};
    if(event.type==='system'&&event.subtype==='init')return {phase:'waiting_response'};
  }
  return {phase:'starting'};
}

export function processAlive(pid) {
  try { if (pid) {process.kill(pid,0);return true;} } catch {}
  return false;
}
