// 只观察本次投递所在的主会话分支。工具参数、结果正文和思考内容不进入产品状态。
import fs from 'node:fs';
import { safeError } from './send-result.mjs';

const readers = new Map();
const CHUNK = 128 * 1024;

function observe(turn, record) {
  const session = record.sessionId || record.session_id;
  if (record.isSidechain || (session && session !== turn.id)) return;
  const at = Date.parse(record.timestamp) || turn.lastAt;
  if (!turn.deliveredAt) {
    if (record.type === 'user' && record.uuid === turn.uuid) {
      turn.deliveredAt = turn.lastAt = at;
      turn.parents.add(record.uuid);
      turn.phase = 'delivered';
    }
    return;
  }
  if (record.parentUuid && !turn.parents.has(record.parentUuid)) return;
  if (record.uuid) turn.parents.add(record.uuid);
  const content = record.message?.content;
  const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{type:'text',text:content}] : [];
  if (record.type === 'user') {
    const results = blocks.filter(b => b?.type === 'tool_result');
    const newInput = record.origin?.kind === 'peer' || (!record.isMeta &&
      (!results.length || blocks.some(b => b?.type === 'text' && b.text?.trim())));
    if (newInput || !results.length) {
      if (newInput) turn.closed = true;
      return;
    }
    for (const result of results) {
      const call = turn.calls.get(result.tool_use_id);
      if (!call || call.done) continue;
      call.done = true;
      turn.lastTool = call.name;
      turn.lastAt = at;
      if (result.is_error) {
        turn.failed++;
        turn.phase = 'tool_error';
      } else {
        turn.completed++;
        turn.executedAt ??= at;
        turn.phase = 'tool_executed';
      }
    }
    return;
  }
  if (record.type === 'system' && record.subtype === 'stop_hook_summary') {
    turn.closed = true;
    turn.lastAt = at;
  }
  if (record.type !== 'assistant') return;
  turn.lastAt = at;
  if (record.isApiErrorMessage || record.error) {
    turn.error = safeError(blocks.map(b => b?.text || '').join(' ').trim() || record.error || 'Claude 返回错误');
    turn.closed = true;
    return;
  }
  for (const block of blocks) {
    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      if (!turn.responseAt) turn.phase = 'thinking';
    } else if (block?.type === 'text' && block.text?.trim()) {
      turn.responseAt ??= at;
      turn.hasText = true;
      turn.phase = 'responding';
    } else if (block?.type === 'tool_use' && block.id && !turn.calls.has(block.id)) {
      const name = String(block.name || '工具').slice(0,90);
      turn.calls.set(block.id, {name,done:false});
      turn.lastTool = name;
      turn.responseAt ??= at;
      turn.phase = 'tool_requested';
    }
  }
  // 流式记录中的思考块也可能携带 stop_reason。单独的思考块没有可见答复。
  if (blocks.some(b => b?.type === 'text' && b.text?.trim()) &&
      ['end_turn','stop_sequence','refusal'].includes(record.message?.stop_reason)) turn.closed = true;
}

function newReader(receipt, stat, startOffset) {
  return {id:receipt.id,uuid:receipt.uuid,needle:Buffer.from(receipt.uuid),parents:new Set(),calls:new Map(),
    cursor:startOffset <= stat.size ? startOffset : 0,ino:stat.ino,birth:stat.birthtimeMs,size:0,mtime:0,
    lastAt:receipt.at,phase:'submitting',completed:0,failed:0,closed:false};
}

// 正常投递从提交前的文件末尾开始。重启或读取旧记录时按块寻找 UUID；
// 后续轮询只读新增的完整行，长任务不会因 8 MB 尾部窗口移动而丢失回执。
function scan(file, turn, size) {
  if (turn.closed || turn.cursor >= size) return;
  const fd = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(CHUNK);
  let pos = turn.cursor, fragments = [];
  const consume = (part, end, final) => {
    const line = fragments.length ? Buffer.concat([...fragments, part]) : part;
    fragments = [];
    if (turn.deliveredAt || line.includes(turn.needle)) {
      let record;
      try { record = JSON.parse(line.toString('utf8')); } catch { if (final) return; }
      if (record) observe(turn, record);
    } else if (final) return;
    turn.cursor = end;
  };
  try {
    while (pos < size && !turn.closed) {
      const n = fs.readSync(fd, buffer, 0, Math.min(CHUNK, size-pos),pos);
      if (!n) break;
      const chunk = buffer.subarray(0,n);
      let begin = 0;
      for (let nl=chunk.indexOf(10); nl>=0 && !turn.closed; nl=chunk.indexOf(10,begin)) {
        consume(chunk.subarray(begin,nl),pos+nl+1,false);
        begin = nl+1;
      }
      pos += n;
      if (begin<n && !turn.closed) {
        if (pos===size) consume(chunk.subarray(begin),pos,true);
        else fragments.push(Buffer.from(chunk.subarray(begin)));
      }
    }
  } finally { fs.closeSync(fd); }
}

function readTurn(receipt,startOffset) {
  const file = receipt.transcriptFile, key = file+'|'+receipt.id+'|'+receipt.uuid;
  const stat = fs.statSync(file);
  let turn = readers.get(key);
  if (!turn || turn.ino!==stat.ino || turn.birth!==stat.birthtimeMs || turn.size>stat.size ||
      (turn.size===stat.size && turn.mtime!==stat.mtimeMs)) {
    turn = newReader(receipt,stat,Number.isSafeInteger(startOffset) && startOffset>=0 ? startOffset : 0);
  }
  readers.delete(key);
  readers.set(key,turn);
  if (readers.size>64) readers.delete(readers.keys().next().value);
  scan(file,turn,stat.size);
  turn.size=stat.size;turn.mtime=stat.mtimeMs;
  return turn;
}

export function desktopOutcome(receipt,{now=Date.now(),deliveryTimeoutMs=15000,responseTimeoutMs=180000,startOffset}={}) {
  if (!receipt || !['submitting','submitted','uncertain'].includes(receipt.status)) return receipt || {status:'failed',code:1,error:'没有桌面投递记录'};
  let turn;
  try {turn=readTurn(receipt,startOffset);} catch { /* 文件可能尚未创建或正由桌面替换。 */ }
  if (!turn?.deliveredAt) {
    if (now-receipt.at < deliveryTimeoutMs) return {status:'sent',progress:{phase:'submitting'}};
    return {status:'unconfirmed',code:1,errorCode:'delivery_unknown',retryable:false,error:'尚未在原桌面会话确认收信，保留投递记录并继续核对。',progress:{phase:'unconfirmed'}};
  }
  const {deliveredAt,responseAt,executedAt} = turn;
  const info = {deliveredAt,...(responseAt?{responseAt}:{}),...(executedAt?{executedAt}:{}),
    execution:{completedTools:turn.completed,failedTools:turn.failed,lastTool:turn.lastTool || null},
    progress:{phase:turn.phase}};
  if (turn.error) return {...info,status:'failed',code:1,retryable:!turn.completed,errorCode:'desktop_api_error',error:turn.error,progress:{phase:'failed'}};
  const pending = turn.calls.size-turn.completed-turn.failed;
  if (turn.closed && !pending) {
    if (turn.completed) return {...info,status:'resumed',code:0,finishedAt:turn.lastAt,confirmedBy:'desktop-transcript',progress:{phase:'tool_executed'}};
    if (!turn.failed && turn.hasText) return {...info,status:'replied',code:0,finishedAt:turn.lastAt,confirmedBy:'desktop-transcript',progress:{phase:'text_reply'}};
  }
  if (!turn.closed && now-turn.lastAt < responseTimeoutMs) return {...info,status:'sent'};
  const error = pending ? '已请求调用工具，尚未收到对应结果。请在 Claude 原会话查看是否需要确认。'
    : turn.failed ? 'Claude 的工具返回了错误，可在原会话查看原因。'
    : turn.completed ? '已有工具执行回执，尚未确认本轮结束。'
    : turn.hasText ? '已看到 Claude 的文字，尚未看到工具执行回执或本轮结束。'
    : '原桌面会话已收信，尚未看到可见回复或工具执行回执。';
  return {...info,status:'unconfirmed',code:1,errorCode:turn.failed?'tool_error':'reply_timeout',error,retryable:false};
}
