// 把限额提示里的“几点恢复”换算成准确的时间戳（毫秒）。
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const DAY = 24 * 3600 * 1000;

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function zonedParts(ms, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month - 1, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

// 某时区在某一刻相对 UTC 的偏移（毫秒）
function offsetAt(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// 指定时区的墙上时间 → UTC 毫秒。日期溢出（如 d=32）由 Date.UTC 自动进位。
export function zonedToUtc({ y, mo, d, h, mi = 0 }, timeZone) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const off = offsetAt(guess, timeZone);
  let t = guess - off;
  const off2 = offsetAt(t, timeZone);
  if (off2 !== off) t = guess - off2;
  return t;
}

const to24 = (h, ampm) => (h % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);

function validZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// 只有时刻没有日期：取消息之后最近的那个时刻
function nextOccurrence(msgMs, h, mi, tz) {
  const p = zonedParts(msgMs, tz);
  let t = zonedToUtc({ y: p.y, mo: p.mo, d: p.d, h, mi }, tz);
  if (t <= msgMs) t = zonedToUtc({ y: p.y, mo: p.mo, d: p.d + 1, h, mi }, tz);
  return t;
}

// 有月日没有年份：取消息所在年份，若早于消息超过一天则算明年
function withMonthDay(msgMs, mon, day, h, mi, tz, year) {
  const mo = MONTHS[mon.slice(0, 3).toLowerCase()];
  if (mo === undefined) return null;
  const y = year ?? zonedParts(msgMs, tz).y;
  let t = zonedToUtc({ y, mo, d: day, h, mi }, tz);
  if (year == null && t < msgMs - DAY) t = zonedToUtc({ y: y + 1, mo, d: day, h, mi }, tz);
  return t;
}

/**
 * Claude Code 的限额提示，例如：
 *   "You've hit your session limit · resets 10:40pm (Asia/Singapore)"
 *   "You've hit your weekly limit · resets Oct 31, 1am (Asia/Singapore)"
 *   旧格式 "Claude AI usage limit reached|1730000000"
 */
export function parseClaudeLimit(text, msgMs, fallbackTz = localTimeZone()) {
  const kind = /weekly|7-day/i.test(text) ? 'weekly' : /session|5-hour/i.test(text) ? 'session' : 'unknown';
  const epoch = text.match(/usage limit reached\|(\d{9,13})/i);
  if (epoch) {
    const n = +epoch[1];
    return { kind: kind === 'unknown' ? 'session' : kind, resetsAt: n < 1e12 ? n * 1000 : n };
  }
  const m = text.match(/resets\s+(?:([A-Za-z]{3,9})\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i);
  if (!m) return { kind, resetsAt: null };
  const tz = m[6] && validZone(m[6].trim()) ? m[6].trim() : fallbackTz;
  const h = to24(+m[3], m[5]);
  const mi = +(m[4] || 0);
  const resetsAt = m[1] ? withMonthDay(msgMs, m[1], +m[2], h, mi, tz) : nextOccurrence(msgMs, h, mi, tz);
  return { kind, resetsAt };
}

/**
 * Codex 的限额提示（本机时区），例如：
 *   "... or try again at 10:01 PM."
 *   "... or try again at Nov 3rd, 2026 9:15 AM."
 */
export function parseCodexRetry(text, msgMs, tz = localTimeZone()) {
  const m = text.match(/try again at\s+(?:([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  const h = to24(+m[4], m[6]);
  const mi = +m[5];
  return m[1] ? withMonthDay(msgMs, m[1], +m[2], h, mi, tz, +m[3]) : nextOccurrence(msgMs, h, mi, tz);
}
