#!/usr/bin/env node
// 用法：
//   node server/cli.mjs scan            只读：列出额度和中断的会话，以及到点会执行的命令
//   node server/cli.mjs serve [--port 4317] [--open]   启动本地服务和界面
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.mjs';
import { Engine } from './lib/engine.mjs';
import { buildCommand, describeCommand } from './lib/sender.mjs';
import { createServer } from './server.mjs';

const [cmd = 'scan', ...rest] = process.argv.slice(2);
const flag = name => rest.includes(name);
const opt = (name, d) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : d; };
const fmt = ms => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');
const STATUS = { waiting: '等待恢复', due: '已到点', skipped: '跳过', simulated: '已演练', sent: '已发送', resumed: '已接上', failed: '失败' };
const REASON = { excluded: '续跑类会话，默认跳过', stale: '恢复已过去太久，不自动补发' };

function pct(w) { return w ? `${Math.round(w.usedPercent)}%（${fmt(w.resetsAt)} 重置${w.estimated ? '，估计' : ''}）` : '未知'; }

async function scan() {
  const store = createStore();
  const engine = new Engine({ store });
  await engine.check({ send: false }); // 只读，不发送
  const v = engine.view();
  console.log(`模式：${v.config.dryRun ? '演练（不真的发送）' : '真实发送'}　自动发送：${v.config.autoSend ? '开' : '关'}`);
  console.log(`codex：${v.tools.codex || '未找到'}\nclaude：${v.tools.claude || '未找到'}\n`);
  for (const src of ['codex', 'claude']) {
    const q = v.quota[src];
    console.log(`${src === 'codex' ? 'Codex' : 'Claude'}${v.plans[src] ? ` · ${v.plans[src]}` : ''}　${q?.fiveHour?.label || '5 小时'}：${pct(q?.fiveHour)}　${q?.weekly?.label || '本周'}：${pct(q?.weekly)}${q ? `　来源：${q.source}` : ''}`);
  }
  console.log(`\n中断的会话（${v.sessions.length}）：`);
  for (const s of v.sessions) {
    console.log(`- [${s.source}] ${s.title}`);
    console.log(`    ${STATUS[s.status] || s.status}${s.reason ? `（${REASON[s.reason]}）` : ''}　中断 ${fmt(s.blockedAt)}　恢复 ${fmt(s.recoverAt)}`);
    console.log(`    到点执行：${describeCommand(buildCommand(s, v.config.message, v.config, v.tools))}`);
  }
  if (v.lastError) console.log(`\n读取问题：${v.lastError}`);
}

async function serve() {
  const app = createServer({ port: +opt('--port', 4317) });
  const url = await app.start();
  console.log(`Claudex 已启动：${url}　（${app.store.config.dryRun ? '演练模式' : '真实发送'}，按 Ctrl+C 退出）`);
  if (flag('--open') && process.platform === 'win32') {
    const script = fileURLToPath(new URL('../launch/open-ego.ps1', import.meta.url));
    const opener = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Port', new URL(url).port], { windowsHide: true, stdio: 'inherit' });
    opener.once('error', e => console.error('无法打开 Ego Browser：' + e.message));
    opener.once('exit', code => { if (code) console.error('Ego Browser 启动失败，本机服务仍在运行。'); });
  }
}

if (cmd === 'scan') await scan();
else if (cmd === 'serve') await serve();
else { console.log('用法：node server/cli.mjs scan | serve [--port 4317] [--open]'); process.exitCode = 1; }
