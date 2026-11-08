// 读取本机 Codex（桌面应用 / CLI）的额度和因额度中断的会话。
import fs from 'node:fs';
import path from 'node:path';
import { readFirstRecord, readTailRecords, readAllLines, recentJsonl, readLastRecordOfType } from './jsonl.mjs';
import { parseCodexRetry } from './time.mjs';

const HOUR = 3600 * 1000;
const PLAN_NAMES = { free: 'Free', plus: 'Plus', pro: 'Pro', team: 'Business', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
export const planName = value => value ? (PLAN_NAMES[value] || value) : null;

function windowLabel(minutes) {
  if (!(minutes > 0)) return null;
  if (minutes === 10080) return '本周';
  if (minutes % 1440 === 0) return (minutes / 1440) + ' 天';
  if (minutes % 60 === 0) return (minutes / 60) + ' 小时';
  return minutes + ' 分钟';
}

function windowOf(w, now) {
  if (!w || typeof w.used_percent !== 'number') return null;
  const resetsAt = w.resets_at ? w.resets_at * 1000 : null;
  const reset = resetsAt != null && resetsAt <= now;
  return {
    usedPercent: reset ? 0 : w.used_percent,
    resetsAt,
    windowMinutes: w.window_minutes ?? null,
    label: windowLabel(w.window_minutes),
    estimated: reset, // 记录里的数值已过重置时间，按已重置估计
  };
}

// CLI 日志和账户接口共用窗口识别；primary 可能就是本周，缺失周期保持 null。
export function quotaFromRateLimits(rl, {now = Date.now(), observedAt = now, source = 'account'} = {}) {
  if (!rl) return null;
  const convert = w => !w ? null : {
    used_percent:w.usedPercent ?? w.used_percent,
    resets_at:w.resetsAt ?? w.resets_at,
    window_minutes:w.windowDurationMins ?? w.window_minutes,
  };
  let short=windowOf(convert(rl.primary),now), weekly=windowOf(convert(rl.secondary),now);
  if ((short?.windowMinutes===10080 && weekly?.windowMinutes!==10080) ||
      (weekly?.windowMinutes===300 && short?.windowMinutes!==300)) [short,weekly]=[weekly,short];
  return short || weekly ? {fiveHour:short,weekly,observedAt,source} : null;
}

const isLimitError = p =>
  p?.codex_error_info === 'usage_limit_exceeded' || /hit your usage limit/i.test(p?.message || '');

function planFromMessage(msg) {
  if (/Upgrade to Pro/i.test(msg)) return 'Plus';
  if (/Upgrade to Plus/i.test(msg)) return 'Free';
  return null;
}

// 判断一个会话现在是不是停在“额度用完”上
export function detectBlocked(records) {
  let lastLimit = null;
  for (const r of records) {
    const p = r.payload || {};
    if (r.type !== 'event_msg') continue;
    if (p.type === 'task_started' || p.type === 'user_message') lastLimit = null;
    else if (p.type === 'task_complete') lastLimit = isLimitError(p.error) ? { r, error: p.error } : null;
    else if (p.type === 'error' && isLimitError(p)) lastLimit = { r, error: p };
  }
  if (!lastLimit) return null;
  return { blockedAt: Date.parse(lastLimit.r.timestamp), message: lastLimit.error.message || '' };
}

const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];

// 会话最近一轮用的沙箱权限（turn_context 里的 sandbox_policy）
export function lastSandbox(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type !== 'turn_context') continue;
    const sp = records[i].payload?.sandbox_policy;
    const mode = typeof sp === 'string' ? sp : sp?.type;
    return SANDBOXES.includes(mode) ? mode : null;
  }
  return null;
}

function latestRateLimits(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const p = records[i].payload;
    if (p?.type === 'token_count' && (p.rate_limits?.primary || p.rate_limits?.secondary) && (p.rate_limits.limit_id ?? 'codex') === 'codex') {
      return { at: Date.parse(records[i].timestamp), rl: p.rate_limits };
    }
  }
  return null;
}

export function readSessionSandbox(file, records) {
  const context = records.findLast(r => r.type === 'turn_context')
    ?? readLastRecordOfType(file, 'turn_context');
  return lastSandbox(context ? [context] : []);
}

function loadTitles(codexHome) {
  const map = new Map();
  for (const r of readAllLines(path.join(codexHome, 'session_index.jsonl'))) {
    if (r.id && r.thread_name) map.set(r.id, r.thread_name);
  }
  return map;
}

export function scanCodex({ codexHome, now = Date.now(), maxAgeHours = 72, quotaDays = 8 } = {}) {
  const sessionsDir = path.join(codexHome, 'sessions');
  if (!fs.existsSync(sessionsDir)) return { available: false, quota: null, sessions: [], plan: null };

  const files = recentJsonl(sessionsDir, now - quotaDays * 24 * HOUR, { match: n => n.startsWith('rollout-') });
  const titles = loadTitles(codexHome);
  const sessions = [];
  let latest = null;
  let plan = null;
  let checked = 0;

  for (const { file, mtimeMs } of files) {
    const wantSession = mtimeMs >= now - maxAgeHours * HOUR;
    const wantQuota = checked < 4;
    if (!wantSession && !wantQuota) break;

    const records = readTailRecords(file, {
      enough: rs => rs.some(r => r.type === 'turn_context')
        && rs.some(r => r.payload?.type === 'task_complete' || r.payload?.type === 'task_started')
        && (!wantQuota || latestRateLimits(rs)),
    });
    const rl = latestRateLimits(records);
    if (rl) { checked++; if (!latest || rl.at > latest.at) latest = rl; }
    if (!wantSession) continue;

    const blocked = detectBlocked(records);
    if (!blocked) continue;
    const meta = readFirstRecord(file)?.payload || {};
    if (meta.thread_source === 'subagent') continue;
    const id = meta.id || path.basename(file).match(/([0-9a-f-]{36})\.jsonl$/)?.[1];
    if (!id) continue;
    plan ??= planFromMessage(blocked.message);
    const cwd = meta.cwd || null;
    sessions.push({
      source: 'codex',
      id,
      title: titles.get(id) || (cwd ? path.basename(cwd) : id.slice(0, 8)),
      cwd,
      project: cwd ? path.basename(cwd) : null,
      blockedAt: blocked.blockedAt,
      recoverAt: parseCodexRetry(blocked.message, blocked.blockedAt),
      kind: 'usage',
      sandbox: readSessionSandbox(file, records),
      message: blocked.message,
      file,
    });
  }

  let quota = null;
  if (latest) {
    quota = quotaFromRateLimits(latest.rl, {now,observedAt:latest.at,source:'rollout'});
  }
  if (latest?.rl.plan_type) plan = planName(latest.rl.plan_type);

  // 提示里没有恢复时间时，用额度窗口的重置时间补上
  for (const s of sessions) {
    if (s.recoverAt == null && quota) {
      const full = [quota.fiveHour, quota.weekly].filter(w => w && w.usedPercent >= 100 && w.resetsAt);
      s.recoverAt = full.length ? Math.max(...full.map(w => w.resetsAt)) : null;
    }
  }
  return { available: true, quota, sessions, plan };
}
