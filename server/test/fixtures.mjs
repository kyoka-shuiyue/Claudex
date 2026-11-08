// 在临时目录里造出最小的 Codex / Claude 会话记录
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `claudex-${name}-`));
}

const write = (file, records) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
};

export function codexSession(home, { id, cwd = 'C:\\work\\shop-api', title, blockedAt, message, threadSource = 'user', resumedAfter = false, rateLimits }) {
  const ts = new Date(blockedAt).toISOString();
  const recs = [
    { timestamp: ts, type: 'session_meta', payload: { id, cwd, thread_source: threadSource, originator: 'Codex Desktop' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'task_started' } },
  ];
  if (rateLimits) recs.push({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex', ...rateLimits } } });
  recs.push({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', error: { message, codex_error_info: 'usage_limit_exceeded' } } });
  if (resumedAfter) recs.push({ timestamp: ts, type: 'event_msg', payload: { type: 'task_started' } });
  write(path.join(home, 'sessions', '2026', '11', '01', `rollout-2026-11-01T10-00-00-${id}.jsonl`), recs);
  if (title) fs.appendFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id, thread_name: title }) + '\n');
}

export function claudeSession(home, { id, project = 'C--work-claudex', cwd = 'C:\\work\\claudex', title, blockedAt, text, resumedAfter = false }) {
  const ts = new Date(blockedAt).toISOString();
  const recs = [
    { type: 'user', sessionId: id, cwd, entrypoint: 'claude-desktop', timestamp: ts, message: { role: 'user', content: '开始吧' } },
    { type: 'assistant', sessionId: id, cwd, timestamp: ts, isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ type: 'text', text }] } },
  ];
  if (title) recs.push({ type: 'custom-title', customTitle: title, sessionId: id });
  if (resumedAfter) recs.push({ type: 'user', sessionId: id, cwd, timestamp: ts, message: { role: 'user', content: '继续' } });
  write(path.join(home, 'projects', project, `${id}.jsonl`), recs);
}

// 生成“resets 3:05pm (UTC)”这样的提示，时刻为 ms 对应的 UTC 时间
export function claudeResetText(ms, kind = 'session') {
  const d = new Date(ms);
  const h = d.getUTCHours();
  const t = `${(h % 12) || 12}:${String(d.getUTCMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
  return `You've hit your ${kind} limit · resets ${t} (UTC)`;
}
