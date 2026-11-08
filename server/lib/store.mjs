// 配置与运行状态，保存在 ~/.claudex（可用 CLAUDEX_HOME 改位置）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MESSAGE = '额度已恢复，请从刚才中断的地方继续完成原来的任务。只做原任务范围内的事，不要扩大范围。';

export const DEFAULT_CONFIG = {
  intervalMinutes: 5,
  autoSend: true,          // 恢复后自动发送继续
  dryRun: true,            // 演练：只记录要执行的命令，不真的发送。确认无误后再关掉
  notify: true,            // 发送完成后用系统通知告诉你
  staggerSeconds: 30,      // 逐个发送的间隔
  retry: true,             // 发送失败自动重试 1 次
  graceSeconds: 60,        // 到恢复时间后再等多久才发，避开服务端刚重置的那几秒
  maxAgeHours: 24,         // 只处理这么久以内中断的会话
  catchUpHours: 2,         // 第一次看到时恢复时间已过去超过这么久的，不自动补发
  excludeTitlePatterns: ['续跑', '因额度中断', '因为额度而中断'], // 续跑类会话默认跳过，避免循环发送
  message: DEFAULT_MESSAGE,
  plans: { claude: null, codex: null }, // 手动指定套餐；null 表示自动识别
  workspaceMoves: [],      // 项目迁移时记录旧目录与新目录，不改写原会话历史
  codex: { extraArgs: [], inheritSandbox: false, useSystemProxy: true, testSessionId: null },
  claude: { extraArgs: [], useSystemProxy: true },
};

const DEFAULT_STATE = { seen: {}, overrides: {}, sends: {}, log: [], lastCheckAt: null, lastError: null };

export function claudexHome(env = process.env) {
  return env.CLAUDEX_HOME || path.join(os.homedir(), '.claudex');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const merge = (base, over) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? merge(base[k], v) : v;
  }
  return out;
};

export function createStore(home = claudexHome()) {
  const configFile = path.join(home, 'config.json');
  const stateFile = path.join(home, 'state.json');
  let config = merge(DEFAULT_CONFIG, readJson(configFile, {}));
  let state = merge(DEFAULT_STATE, readJson(stateFile, {}));
  return {
    home,
    logsDir: path.join(home, 'logs'),
    get config() { return config; },
    get state() { return state; },
    updateConfig(patch) {
      config = merge(config, patch);
      writeJson(configFile, config);
      return config;
    },
    saveState() {
      state.log = state.log.slice(0, 50);
      writeJson(stateFile, state);
    },
  };
}
