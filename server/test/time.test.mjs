import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeLimit, parseCodexRetry, zonedToUtc } from '../lib/time.mjs';

const iso = ms => new Date(ms).toISOString();

test('zonedToUtc 换算新加坡时间', () => {
  assert.equal(iso(zonedToUtc({ y: 2026, mo: 9, d: 31, h: 1, mi: 0 }, 'Asia/Singapore')), '2026-10-30T17:00:00.000Z');
});

test('Claude：只有时刻，取消息之后最近的那个时刻', () => {
  const msg = Date.parse('2026-10-31T13:05:42.942Z'); // 新加坡 21:05
  const r = parseClaudeLimit("You've hit your session limit · resets 10:40pm (Asia/Singapore)", msg);
  assert.equal(r.kind, 'session');
  assert.equal(iso(r.resetsAt), '2026-10-31T14:40:00.000Z');
});

test('Claude：时刻早于消息时间就算第二天', () => {
  const msg = Date.parse('2026-10-30T13:05:37.618Z'); // 新加坡 21:05
  const r = parseClaudeLimit("You've hit your weekly limit · resets 1am (Asia/Singapore)", msg);
  assert.equal(r.kind, 'weekly');
  assert.equal(iso(r.resetsAt), '2026-10-30T17:00:00.000Z'); // 新加坡 10/31 01:00
});

test('Claude：带月日', () => {
  const msg = Date.parse('2026-10-28T13:05:04.041Z');
  const r = parseClaudeLimit("You've hit your weekly limit · resets Oct 31, 1am (Asia/Singapore)", msg);
  assert.equal(iso(r.resetsAt), '2026-10-30T17:00:00.000Z');
});

test('Claude：跨年的月日算到明年', () => {
  const msg = Date.parse('2026-12-30T10:00:00Z');
  const r = parseClaudeLimit("You've hit your weekly limit · resets Jan 2, 9am (UTC)", msg);
  assert.equal(iso(r.resetsAt), '2027-01-02T09:00:00.000Z');
});

test('Claude：旧格式时间戳', () => {
  const r = parseClaudeLimit('Claude AI usage limit reached|1793500000', 0);
  assert.equal(r.resetsAt, 1793500000 * 1000);
});

test('Claude：解析不了时返回 null', () => {
  assert.equal(parseClaudeLimit('Rate limited', Date.now()).resetsAt, null);
});

test('Codex：只有时刻（本机时区）', () => {
  const msg = Date.parse('2026-10-25T09:04:59.055Z'); // 东八区 17:04
  const r = parseCodexRetry('You’ve hit your usage limit. ... or try again at 7:13 PM.', msg, 'Asia/Taipei');
  assert.equal(iso(r), '2026-10-25T11:13:00.000Z');
});

test('Codex：带日期', () => {
  const msg = Date.parse('2026-10-28T02:00:00Z');
  const r = parseCodexRetry('... try again at Nov 3rd, 2026 9:15 AM.', msg, 'Asia/Taipei');
  assert.equal(iso(r), '2026-11-03T01:15:00.000Z');
});

test('Codex：没有时间返回 null', () => {
  assert.equal(parseCodexRetry('Something went wrong', Date.now()), null);
});
