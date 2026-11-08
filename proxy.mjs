// 系统代理仅补到各自子进程；不修改注册表、全局环境或账户配置。
import { execFileSync } from 'node:child_process';

let cached;
let checkedAt = 0;
export function parseWindowsProxy(text) {
  if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(text)) return null;
  const value = text.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
  if (!value) return null;
  const entries = Object.fromEntries(value.split(';').filter(x => x.includes('=')).map(x => x.split('=')));
  const selected = entries.https || entries.http || (value.includes('=') ? null : value);
  if (!selected) return null;
  const url = /^[a-z]+:\/\//i.test(selected) ? selected : 'http://' + selected;
  try { const u = new URL(url); return ['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol) ? url : null; } catch { return null; }
}

export function systemProxy() {
  if (process.platform !== 'win32') return null;
  if (Date.now() - checkedAt < 30000) return cached;
  checkedAt = Date.now();
  try {
    cached = parseWindowsProxy(execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', windowsHide: true, timeout: 2000 }));
  } catch { cached = null; }
  return cached;
}

export function proxyEnvironment(config, env = process.env, detected = systemProxy(), source = 'codex') {
  if (config[source]?.useSystemProxy === false) return env;
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy || detected;
  if (!proxy) return env;
  // Claude 官方 SDK 不支持 SOCKS，不能把仅 SOCKS 的系统代理强塞给它。
  if (source === 'claude' && /^socks/i.test(proxy)) return env;
  const out = { ...env };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) out[name] ??= proxy;
  return out;
}
