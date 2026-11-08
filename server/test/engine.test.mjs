import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.mjs';
import { Engine, classify } from '../lib/engine.mjs';
import { createServer } from '../server.mjs';
import { tmpDir, codexSession, claudeSession } from './fixtures.mjs';
import { claudeResetText } from './fixtures.mjs';

const H = 3600 * 1000;
const ENV = { CLAUDEX_CODEX_BIN: 'C:\\bin\\codex.exe', CLAUDEX_CLAUDE_BIN: 'C:\\bin\\claude.exe' };

function setup({ dryRun = true, recoverInMs = -2 * 60000, now = Date.now() } = {}) {
  const codex = tmpDir('e-codex');
  const claude = tmpDir('e-claude');
  const recover = new Date(now + recoverInMs);
  const hhmm = `${(recover.getHours() % 12) || 12}:${String(recover.getMinutes()).padStart(2, '0')} ${recover.getHours() < 12 ? 'AM' : 'PM'}`;
  codexSession(codex, { id: '01a19522-1b05-7170-af9d-1a0186e64c0b', title: '重构支付回调的重试逻辑', blockedAt: now - H, message: `You’ve hit your usage limit. try again at ${hhmm}.`, cwd: codex });
  codexSession(codex, { id: '01a19522-1b05-7170-af9d-1a0186e64c0c', title: '帮我看看有没有因为额度而中断的任务，输入继续', blockedAt: now - H, message: `try again at ${hhmm}.`, cwd: codex });
  claudeSession(claude, { id: 'c1', title: '给 prompt-refiner 动画补字幕', blockedAt: now - H, text: claudeResetText(now + 3 * H), cwd: claude });
  const store = createStore(tmpDir('e-home'));
  store.updateConfig({ dryRun, staggerSeconds: 0, retry: false, notify: false });
  const runs = [];
  const runner = (cmd, { logFile }) => { runs.push({ cmd, logFile }); return { pid: 1234, done: new Promise(() => {}) }; };
  const engine = new Engine({ store, env: ENV, now: () => now, runner, homes: { codex, claude } });
  return { engine, store, runs, now };
}

test('到点的会话被演练发送，续跑类会话默认跳过，未到点的继续等待', async () => {
  const { engine, runs } = setup();
  await engine.check({ send: false });
  const byTitle = Object.fromEntries(engine.classified().map(s => [s.title, s]));
  assert.equal(byTitle['重构支付回调的重试逻辑'].status, 'due');
  assert.equal(byTitle['帮我看看有没有因为额度而中断的任务，输入继续'].status, 'skipped');
  assert.equal(byTitle['帮我看看有没有因为额度而中断的任务，输入继续'].reason, 'excluded');
  assert.equal(byTitle['给 prompt-refiner 动画补字幕'].status, 'waiting');

  const r = await engine.sendDue();
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].status, 'simulated');
  assert.equal(runs.length, 0, '演练模式不应执行命令');
  assert.match(r.results[0].command, /codex\.exe exec resume --skip-git-repo-check 01a19522-1b05-7170-af9d-1a0186e64c0b/);
  assert.equal((await engine.sendDue()).started, false, '同一次中断不会重复发送');
});

test('真实模式执行命令；之前的演练记录不挡真实发送', async () => {
  const { engine, store, runs } = setup();
  await engine.check({ send: false });
  await engine.sendDue();
  store.updateConfig({ dryRun: false });
  const r = await engine.sendDue();
  assert.equal(r.results[0].status, 'sent');
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].cmd.args.slice(0, 3), ['exec', 'resume', '--skip-git-repo-check']);
  assert.equal(runs[0].cmd.args.at(-1), store.config.message);
});

test('手动打开被跳过的会话后会发送；关掉的不会', async () => {
  const { engine } = setup();
  await engine.check({ send: false });
  const skipped = engine.classified().find(s => s.reason === 'excluded');
  const due = engine.classified().find(s => s.status === 'due');
  engine.setAuto(skipped.key, true);
  engine.setAuto(due.key, false);
  const r = await engine.sendDue();
  assert.deepEqual(r.results.map(x => x.key), [skipped.key]);
});

test('第一次看到时恢复已过去很久的会话不自动补发', () => {
  const now = Date.now();
  const s = { source: 'codex', id: 'x', title: 'A', blockedAt: now - 10 * H, recoverAt: now - 5 * H };
  const c = classify(s, { config: createStore(tmpDir('c')).config, state: { seen: {}, overrides: {}, sends: {} }, quota: null, now });
  assert.equal(c.status, 'skipped');
  assert.equal(c.reason, 'stale');
});

test('Codex 记录到的额度仍是满的，就按额度的重置时间等', () => {
  const now = Date.now();
  const s = { source: 'codex', id: 'x', title: 'A', blockedAt: now - H, recoverAt: now - 5 * 60000 };
  const quota = { observedAt: now - 30 * 60000, fiveHour: { usedPercent: 100, resetsAt: now + H } };
  const c = classify(s, { config: createStore(tmpDir('c')).config, state: { seen: {}, overrides: {}, sends: {} }, quota, now });
  assert.equal(c.status, 'waiting');
  assert.equal(c.recoverAt, now + H);
});

test('醒来时间取最近一个会话的恢复时刻', async () => {
  const { engine, now } = setup({ recoverInMs: 10 * 60000 });
  await engine.check({ send: false });
  const wake = engine.nextWakeAt();
  assert.ok(wake < now + 5 * 60000 + 1, '不晚于常规检测');
});

test('本地接口：读状态、改配置校验、切换会话、只接受本机来源', async () => {
  const { engine, store } = setup();
  const app = createServer({ store, engine, port: 0 });
  const base = await app.start();
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.ok(Array.isArray(state.sessions));
    assert.equal(state.config.dryRun, true);

    const bad = await fetch(`${base}/api/config`, { method: 'POST', body: JSON.stringify({ intervalMinutes: 7 }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/api/config`, { method: 'POST', body: JSON.stringify({ intervalMinutes: 15, message: '继续' }) });
    assert.equal((await ok.json()).config.intervalMinutes, 15);

    const key = state.sessions[0].key;
    const t = await (await fetch(`${base}/api/session`, { method: 'POST', body: JSON.stringify({ key, auto: false }) })).json();
    assert.equal(t.sessions.find(s => s.key === key).auto, false);

    const evil = await fetch(`${base}/api/config`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' });
    assert.equal(evil.status, 403);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal((await fetch(`${base}/../server/server.mjs`)).status, 404);
  } finally { app.stop(); }
});

test('自动发送关掉时，到点只通知一次，不发送', async () => {
  const { engine, store, runs } = setup({ dryRun: false });
  const notes = [];
  engine.notifier = n => notes.push(n);
  store.updateConfig({ autoSend: false, notify: true });
  await engine.check();
  await engine.check();
  assert.equal(runs.length, 0);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'recovered');
  assert.equal(notes[0].count, 1);
});

test('启动就失败的会话记为失败，可以用“现在就发送”重发', async () => {
  const { engine, store } = setup({ dryRun: false });
  await engine.check({ send: false });
  let fail = true;
  engine.runner = () => (fail ? { error: '没有找到对应的命令行程序' } : { pid: 9, done: new Promise(() => {}) });
  const r1 = await engine.sendDue();
  assert.equal(r1.results[0].status, 'failed');
  assert.equal(store.state.log[0].ok, 0);
  fail = false;
  const key = r1.results[0].key;
  const r2 = await engine.sendDue({ keys: [key] });
  assert.equal(r2.results[0].status, 'sent');
});

test('进程之后报错退出时，日志里的批次结果跟着更新', async () => {
  const { engine, store } = setup({ dryRun: false });
  store.updateConfig({ retry: false });
  await engine.check({ send: false });
  let finish;
  engine.runner = () => ({ pid: 7, done: new Promise(r => { finish = r; }) });
  await engine.sendDue();
  assert.equal(store.state.log[0].ok, 1);
  finish({ code: 1 });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(store.state.log[0].ok, 0);
  assert.equal(store.state.log[0].items[0].status, 'failed');
});

test('请求从中断列表消失不提前报告成功，进程正常结束才标记已接上', async () => {
  const { engine, store } = setup({ dryRun: false });
  await engine.check({ send: false });
  let finish;
  engine.runner = () => ({pid:456,done:new Promise(r=>{finish=r;})});
  const sent = await engine.sendDue();
  engine.blockedSessions = () => [];
  await engine.check({send:false});
  const key=sent.results[0].key;
  assert.equal(store.state.sends[key].status,'sent');
  finish({code:0}); await new Promise(r=>setImmediate(r));
  assert.equal(store.state.sends[key].status,'resumed');
  assert.equal(store.state.log[0].items[0].status,'resumed');
});

test('不存在的会话不能切换；套餐要校验；切到真实发送立刻处理到点的会话', async () => {
  const { engine, store, runs } = setup();
  const app = createServer({ store, engine, port: 0 });
  const base = await app.start();
  try {
    const post = (p, b) => fetch(`${base}${p}`, { method: 'POST', body: JSON.stringify(b) });
    assert.equal((await post('/api/session', { key: 'codex:nope:1', auto: true })).status, 400);
    assert.equal((await post('/api/config', { plans: { claude: 123 } })).status, 400);
    assert.equal((await post('/api/config', { plans: { codex: 'Pro', claude: null } })).status, 200);
    // setup 里 check 已经演练过一次；切到真实发送后，演练记录不挡真实发送，应立刻执行
    const res = await post('/api/config', { dryRun: false });
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(runs.length, 1);
  } finally { app.stop(); }
});

test('现在就发送不能覆盖手动跳过或默认排除', async () => {
  const { engine } = setup();
  await engine.check({ send: false });
  const due = engine.classified().find(s => s.status === 'due');
  engine.setAuto(due.key, false);
  const skipped = engine.classified().filter(s => !s.auto);
  assert.equal((await engine.sendDue({ keys: skipped.map(s => s.key) })).started, false);
});

test('发送批次等待期间跳过的会话不再发送', async () => {
  const { engine, store, runs } = setup({ dryRun: false });
  await engine.check({ send: false });
  const excluded = engine.classified().find(s => s.reason === 'excluded');
  engine.setAuto(excluded.key, true);
  const ordered = engine.classified().filter(s => s.status === 'due');
  let release;
  engine.wait = () => new Promise(r => { release = r; });
  store.updateConfig({ staggerSeconds: 30 });
  const pending = engine.sendDue();
  await new Promise(r => setImmediate(r));
  engine.setAuto(ordered[1].key, false);
  release();
  const result = await pending;
  assert.equal(runs.length, 1);
  assert.deepEqual(result.results.map(r => r.key), [ordered[0].key]);
});

test('真实批次等待期间切回演练，后续会话只演练', async () => {
  const { engine, store, runs } = setup({ dryRun: false });
  await engine.check({ send: false });
  engine.setAuto(engine.classified().find(s => s.reason === 'excluded').key, true);
  let release;
  engine.wait = () => new Promise(r => { release = r; });
  const pending = engine.sendDue();
  await new Promise(r => setImmediate(r));
  store.updateConfig({ dryRun: true });
  release();
  const result = await pending;
  assert.equal(runs.length, 1);
  assert.equal(result.results[1].status, 'simulated');
});

for (const cancel of [null, 'skip', 'dry', 'retry-off']) {
  test(`异步失败等待期间保留去重记录，只允许一次配置重试：${cancel || '重试'}`, async () => {
    const { engine, store } = setup({ dryRun: false });
    store.updateConfig({ retry: true });
    await engine.check({ send: false });
    let finish, release, calls = 0;
    engine.runner = () => ({ pid: ++calls, done: new Promise(r => { finish = r; }) });
    engine.wait = () => new Promise(r => { release = r; });
    const result = await engine.sendDue();
    const key = result.results[0].key;
    finish({ code: 1 });
    await new Promise(r => setImmediate(r));
    assert.ok(store.state.sends[key], '等待重试时不能删除去重记录');
    assert.equal((await engine.sendDue()).started, false);
    assert.equal((await engine.sendDue({ keys: [key] })).started, false);
    if (cancel === 'skip') engine.setAuto(key, false);
    if (cancel === 'dry') store.updateConfig({ dryRun: true });
    if (cancel === 'retry-off') store.updateConfig({ retry: false });
    release();
    await new Promise(r => setImmediate(r));
    assert.equal(calls, cancel ? 1 : 2);
    if (!cancel) {
      finish({ code: 1 });
      await new Promise(r => setImmediate(r));
      assert.equal(store.state.sends[key].attempt, 2);
      assert.equal(store.state.log[0].ok, 0);
      assert.equal((await engine.sendDue()).started, false);
      assert.equal(calls, 2);
    }
  });
}

test('现在就发送接口拒绝跳过的会话', async () => {
  const { engine, store, runs } = setup({ dryRun: false });
  store.updateConfig({ autoSend: false });
  const app = createServer({ store, engine, port: 0 });
  const base = await app.start();
  try {
    const due = engine.classified().find(s => s.status === 'due');
    engine.setAuto(due.key, false);
    const response = await fetch(`${base}/api/send-now`, { method: 'POST', body: JSON.stringify({ keys: [due.key] }) });
    assert.equal(response.status, 409);
    assert.equal(runs.length, 0);
  } finally { app.stop(); }
});

for (const cancel of [false, true]) {
  test(`启动失败的配置重试也遵守跳过且最多一次：${cancel}`, async () => {
    const { engine, store } = setup({ dryRun: false });
    store.updateConfig({ retry: true });
    await engine.check({ send: false });
    let calls = 0, release;
    engine.runner = () => { calls++; return { error: '启动失败' }; };
    engine.wait = () => new Promise(r => { release = r; });
    const pending = engine.sendDue();
    const key = engine.classified().find(s => s.send).key;
    assert.ok(store.state.sends[key].retryPending);
    if (cancel) engine.setAuto(key, false);
    release();
    await pending;
    assert.equal(calls, cancel ? 1 : 2);
    assert.equal(store.state.sends[key].status, 'failed');
    assert.equal((await engine.sendDue()).started, false);
  });
}

test('重启保留失败去重记录，解除已失效的重试占位，允许显式重发', async () => {
  const { engine, store } = setup({ dryRun: false });
  await engine.check({ send: false });
  const session = engine.classified().find(s => s.status === 'due');
  store.state.sends[session.key] = { key: session.key, status: 'failed', mode: 'real', retryPending: true, attempt: 1 };
  store.saveState();
  const restored = createStore(store.home);
  let calls = 0;
  const restarted = new Engine({ store: restored, env: ENV, now: engine.now, homes: engine.homes,
    runner: () => { calls++; return { pid: 1, done: new Promise(() => {}) }; } });
  await restarted.check({ send: false });
  assert.equal((await restarted.sendDue()).started, false);
  assert.equal((await restarted.sendDue({ keys: [session.key] })).started, true);
  assert.equal(calls, 1);
});
