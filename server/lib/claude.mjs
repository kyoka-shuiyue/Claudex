// 读取本机 Claude Code（含 Claude 桌面应用）的额度和因额度中断的会话。
import fs from 'node:fs';
import path from 'node:path';
import { readTailRecords, recentJsonl } from './jsonl.mjs';
import { parseClaudeLimit } from './time.mjs';

const HOUR = 3600 * 1000;

const textOf = rec => {
  const c = rec?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => x?.text || '').join(' ');
  return '';
};

const isLimitRecord = r =>
  r.type === 'assistant' && (r.error === 'rate_limit' || (r.isApiErrorMessage && /limit/i.test(textOf(r))));

// 最后一条对话记录如果是“额度用完”的报错，这个会话就停在那里
export function detectBlocked(records) {
  let last = null;
  for (const r of records) if (r.type === 'user' || r.type === 'assistant') last = r;
  if (!last || !isLimitRecord(last)) return null;
  const blockedAt = Date.parse(last.timestamp);
  const text = textOf(last);
  return { blockedAt, text, ...parseClaudeLimit(text, blockedAt), last };
}

function titleOf(records) {
  let custom, agent, prompt;
  for (const r of records) {
    if (r.type === 'custom-title' && r.customTitle) custom = r.customTitle;
    else if (r.type === 'agent-name' && r.agentName) agent = r.agentName;
    else if (r.type === 'last-prompt' && r.lastPrompt) prompt = r.lastPrompt;
  }
  if (custom || agent) return custom || agent;
  if (prompt) {
    const line = prompt.replace(/\s+/g, ' ').trim();
    return line.length > 36 ? line.slice(0, 36) + '…' : line;
  }
  return null;
}

// 只认领本软件发出的那一轮 API 失败。用户的新消息或有效回复都会解除认领。
function failedContinuation(records, attempt, message) {
  if (!attempt || !['sent','failed'].includes(attempt.status)) return null;
  const last=records.findLast(r=>r.type==='assistant' || r.type==='user');
  const user=records.findLast(r=>r.type==='user');
  if (last?.type!=='assistant' || !last.isApiErrorMessage || !user) return null;
  const submitted=Date.parse(user.timestamp);
  if (user.entrypoint!=='sdk-cli' || submitted < attempt.at-2000 || submitted > attempt.at+120000 || textOf(user)!==(attempt.message || message)) return null;
  const original=records.find(r=>isLimitRecord(r) && Date.parse(r.timestamp)===attempt.blockedAt);
  if (!original && attempt.recoverAt == null) return null;
  const b = original ? {blockedAt:attempt.blockedAt,text:textOf(original),...parseClaudeLimit(textOf(original),attempt.blockedAt),last:original} :
    {blockedAt:attempt.blockedAt,text:'自动续接失败',resetsAt:attempt.recoverAt,kind:attempt.kind,last:{...attempt,sessionId:attempt.id}};
  // 再次撞到限额时更新等待时刻，仍沿用原中断的去重键。
  if (isLimitRecord(last)) b.resetsAt=parseClaudeLimit(textOf(last),Date.parse(last.timestamp)).resetsAt || b.resetsAt;
  return b;
}

// 状态栏同步脚本落盘的额度（可选，见 statusline.mjs）
function readStatuslineUsage(claudexHome, now) {
  const f = path.join(claudexHome, 'claude-usage.json');
  if (!fs.existsSync(f)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const win = w => {
      if (!w || typeof w.used_percentage !== 'number') return null;
      const resetsAt = w.resets_at ? w.resets_at * 1000 : null;
      const reset = resetsAt != null && resetsAt <= now;
      return { usedPercent: reset ? 0 : w.used_percentage, resetsAt, estimated: reset };
    };
    const tag = (w, m) => (w ? { ...w, windowMinutes: m } : null);
    return { fiveHour: tag(win(d.rate_limits?.five_hour), 300), weekly: tag(win(d.rate_limits?.seven_day), 10080), observedAt: d.observedAt, source: 'statusline' };
  } catch { return null; }
}

export function scanClaude({ claudeHome, claudexHome, now = Date.now(), maxAgeHours = 72, sends = {}, message } = {}) {
  const projects = path.join(claudeHome, 'projects');
  if (!fs.existsSync(projects)) return { available: false, quota: null, sessions: [] };

  // 只看 projects/<项目>/<会话>.jsonl，子 Agent 的记录在更深的 subagents 目录里
  const files = [];
  for (const d of fs.readdirSync(projects, { withFileTypes: true })) {
    if (d.isDirectory()) files.push(...recentJsonl(path.join(projects, d.name), now - maxAgeHours * HOUR, { recursive: false }));
  }

  const sessions = [];
  let latestLimit = null;
  for (const { file } of files) {
    const id=path.basename(file,'.jsonl');
    const attempt=Object.values(sends).filter(s=>s.source==='claude' && s.id===id && s.mode==='real').sort((a,b)=>b.at-a.at)[0];
    const records = readTailRecords(file, {
      start: 128 * 1024,
      enough: rs => rs.some(r => r.type === 'user' || r.type === 'assistant') &&
        (!attempt || rs.some(r=>Date.parse(r.timestamp)===attempt.blockedAt)),
    });
    const b = failedContinuation(records,attempt,message) || detectBlocked(records);
    if (!b) continue;
    if (!latestLimit || b.blockedAt > latestLimit.blockedAt) latestLimit = b;
    const cwd = b.last.cwd || null;
    const before=records.indexOf(b.last);
    const entrypoint = b.last.entrypoint || (before>=0 ? records.slice(0,before+1).findLast(r=>r.entrypoint)?.entrypoint : attempt?.entrypoint) || null;
    sessions.push({
      source: 'claude',
      id: b.last.sessionId || path.basename(file, '.jsonl'),
      title: titleOf(records) || (cwd ? path.basename(cwd) : path.basename(file, '.jsonl').slice(0, 8)),
      cwd,
      project: cwd ? path.basename(cwd) : null,
      blockedAt: b.blockedAt,
      recoverAt: b.resetsAt,
      kind: b.kind,
      message: b.text,
      entrypoint,
      file,
    });
  }

  // 额度：优先用状态栏同步的数值；最近一次限额提示更新时，用它覆盖对应窗口
  let quota = readStatuslineUsage(claudexHome, now);
  if (latestLimit?.resetsAt && latestLimit.resetsAt > now && (!quota || latestLimit.blockedAt > (quota.observedAt || 0))) {
    quota ??= { fiveHour: null, weekly: null, observedAt: latestLimit.blockedAt, source: 'inferred' };
    const weekly = latestLimit.kind === 'weekly';
    const win = { usedPercent: 100, resetsAt: latestLimit.resetsAt, estimated: false, windowMinutes: weekly ? 10080 : 300 };
    if (weekly) quota.weekly = win; else quota.fiveHour = win;
    if (quota.source !== 'statusline') quota.source = 'inferred';
  }
  return { available: true, quota, sessions };
}
