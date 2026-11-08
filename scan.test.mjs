import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { scanCodex } from '../lib/codex.mjs';
import { scanClaude } from '../lib/claude.mjs';
import { tmpDir, codexSession, claudeSession } from './fixtures.mjs';
import { claudeResetText } from './fixtures.mjs';

const H = 3600 * 1000;

test('Codex：最后一轮权限距文件末尾超过 8MB 时仍能沿用', () => {
  const home = tmpDir('long-sandbox');
  const now = Date.now();
  codexSession(home, { id: 'long-sandbox', blockedAt: now - H, message: 'You have hit your usage limit' });
  const file = path.join(home, 'sessions/2026/11/01/rollout-2026-11-01T10-00-00-long-sandbox.jsonl');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.split('\n')[0] + '\n' + JSON.stringify({ type: 'turn_context', payload: { sandbox_policy: { type: 'workspace-write' } } }) + '\n');
  const padding = JSON.stringify({ type: 'response_item', payload: { text: '长记录'.repeat(60000) } }) + '\n';
  for (let i = 0; i < 18; i++) fs.appendFileSync(file, padding);
  fs.appendFileSync(file, original.split('\n').slice(1).join('\n'));
  assert.equal(scanCodex({ codexHome: home, now }).sessions[0].sandbox, 'workspace-write');
});

test('Codex：识别停在额度报错上的会话、标题和恢复时间', () => {
  const home = tmpDir('codex');
  const now = Date.now();
  codexSession(home, {
    id: '01a19522-1b05-7170-af9d-1a0186e64c0b', title: '重构支付回调的重试逻辑', blockedAt: now - H,
    message: 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) ... or try again at 11:59 PM.',
    rateLimits: { primary: { used_percent: 100, window_minutes: 300, resets_at: Math.floor((now + 2 * H) / 1000) }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: Math.floor((now + 50 * H) / 1000) } },
  });
  const r = scanCodex({ codexHome: home, now });
  assert.equal(r.sessions.length, 1);
  const s = r.sessions[0];
  assert.equal(s.title, '重构支付回调的重试逻辑');
  assert.equal(s.project, 'shop-api');
  assert.ok(s.recoverAt > s.blockedAt);
  assert.equal(r.plan, 'Plus');
  assert.equal(r.quota.fiveHour.usedPercent, 100);
  assert.equal(r.quota.weekly.usedPercent, 40);
});

test('Codex：之后又开始了新一轮的会话不算中断；子 Agent 线程排除', () => {
  const home = tmpDir('codex2');
  const now = Date.now();
  const msg = 'You’ve hit your usage limit. try again at 9:00 PM.';
  codexSession(home, { id: '01a19522-1b05-7170-af9d-1a0186e64c01', blockedAt: now - H, message: msg, resumedAfter: true });
  codexSession(home, { id: '01a19522-1b05-7170-af9d-1a0186e64c02', blockedAt: now - H, message: msg, threadSource: 'subagent' });
  assert.equal(scanCodex({ codexHome: home, now }).sessions.length, 0);
});

test('Codex：七天 primary 单独出现时放进本周额度，不冒充五小时', () => {
  const home = tmpDir('primary-week');
  const now = Date.now();
  codexSession(home, { id: 'weekly-only', title: '周额度', blockedAt: now - H, message: 'usage limit',
    rateLimits: { primary: { used_percent: 18, window_minutes: 10080, resets_at: Math.floor((now + H) / 1000) } } });
  const { quota } = scanCodex({ codexHome: home, now });
  assert.equal(quota.fiveHour, null);
  assert.equal(quota.weekly.usedPercent, 18);
  assert.equal(quota.weekly.label, '本周');
});

test('Codex：只出现 secondary 及自定义窗口时按记录时长标注', () => {
  const now = Date.now();
  for (const [minutes, field, label] of [[300, 'fiveHour', '5 小时'], [1440, 'weekly', '1 天']]) {
    const home = tmpDir('secondary-window');
    codexSession(home, { id: 'custom-cycle', blockedAt: now - H, message: 'usage limit',
      rateLimits: { secondary: { used_percent: 31, window_minutes: minutes } } });
    assert.equal(scanCodex({ codexHome: home, now }).quota[field].label, label);
  }
});

test('Codex：额度已过重置时间按已重置估计', () => {
  const home = tmpDir('codex3');
  const now = Date.now();
  codexSession(home, {
    id: '01a19522-1b05-7170-af9d-1a0186e64c03', blockedAt: now - H, message: 'try again at 1:00 AM.', resumedAfter: true,
    rateLimits: { primary: { used_percent: 100, window_minutes: 300, resets_at: Math.floor((now - 60000) / 1000) } },
  });
  const q = scanCodex({ codexHome: home, now }).quota.fiveHour;
  assert.equal(q.usedPercent, 0);
  assert.equal(q.estimated, true);
});

test('Claude：识别限额中断、标题、类型和恢复时间，并推断额度', () => {
  const home = tmpDir('claude');
  const now = Date.now();
  claudeSession(home, {
    id: 'dffe9aac-c84c-4cdd-8c80-683d1a36df96', title: '整理 Claudex 的额度解析模块', blockedAt: now - 10 * 60000,
    text: claudeResetText(now + 3 * H),
  });
  const r = scanClaude({ claudeHome: home, claudexHome: tmpDir('cx'), now });
  assert.equal(r.sessions.length, 1);
  const s = r.sessions[0];
  assert.equal(s.title, '整理 Claudex 的额度解析模块');
  assert.equal(s.kind, 'session');
  assert.equal(s.entrypoint, 'claude-desktop');
  assert.ok(s.recoverAt > now);
  assert.equal(r.quota.source, 'inferred');
  assert.equal(r.quota.fiveHour.usedPercent, 100);
});

test('Claude：报错之后用户又发过消息就不算中断', () => {
  const home = tmpDir('claude2');
  claudeSession(home, { id: 'a1', blockedAt: Date.now() - H, text: "You've hit your session limit · resets 1am (UTC)", resumedAfter: true });
  assert.equal(scanClaude({ claudeHome: home, claudexHome: tmpDir('cx'), now: Date.now() }).sessions.length, 0);
});

test('目录不存在时返回不可用而不是报错', () => {
  assert.equal(scanCodex({ codexHome: tmpDir('none') }).available, false);
  assert.equal(scanClaude({ claudeHome: tmpDir('none'), claudexHome: tmpDir('cx') }).available, false);
});

test('Codex：读出会话最近一轮的沙箱权限；打开沿用后命令里带上', async () => {
  const { lastSandbox } = await import('../lib/codex.mjs');
  const { buildCommand } = await import('../lib/sender.mjs');
  const recs = [
    { type: 'turn_context', payload: { sandbox_policy: { type: 'read-only' } } },
    { type: 'turn_context', payload: { sandbox_policy: { type: 'danger-full-access' } } },
  ];
  assert.equal(lastSandbox(recs), 'danger-full-access');
  assert.equal(lastSandbox([{ type: 'turn_context', payload: { sandbox_policy: { type: 'weird' } } }]), null);
  const s = { source: 'codex', id: 'abc', sandbox: 'workspace-write' };
  const off = buildCommand(s, '继续', { codex: { inheritSandbox: false } }, { codex: 'codex.exe' });
  assert.ok(!off.args.includes('-c'));
  const on = buildCommand(s, '继续', { codex: { inheritSandbox: true } }, { codex: 'codex.exe' });
  assert.deepEqual(on.args.slice(3, 5), ['-c', 'sandbox_mode="workspace-write"']);
});
