#!/usr/bin/env node
// 可选：Claude Code 状态栏脚本。Claude Code 每次刷新状态栏时把会话信息从 stdin 传进来，
// 其中 rate_limits 是官方提供的 5 小时 / 7 天额度。这里把它存到 ~/.claudex/claude-usage.json 给 Claudex 读，
// 然后照常输出一行状态栏文字。需要你在 Claude Code 设置里把 statusLine 指向这个脚本才会生效。
import fs from 'node:fs';
import path from 'node:path';
import { claudexHome } from './lib/store.mjs';

let input = '';
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  let d = {};
  try { d = JSON.parse(input); } catch {}
  if (d.rate_limits) {
    const file = path.join(claudexHome(), 'claude-usage.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ observedAt: Date.now(), rate_limits: d.rate_limits }));
  }
  const h5 = d.rate_limits?.five_hour?.used_percentage;
  const wk = d.rate_limits?.seven_day?.used_percentage;
  const parts = [d.model?.display_name, h5 != null && `5h ${Math.round(h5)}%`, wk != null && `周 ${Math.round(wk)}%`].filter(Boolean);
  process.stdout.write(parts.join(' · '));
});
