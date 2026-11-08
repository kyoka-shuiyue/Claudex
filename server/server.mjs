// Claudex 本地服务：定时检测、到点发送，并给界面提供接口。只监听本机。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import metadata from '../package.json' with { type: 'json' };
import { createStore } from './lib/store.mjs';
import { Engine } from './lib/engine.mjs';
import { notify } from './lib/notify.mjs';
import { CodexDiagnostics } from './lib/diagnostics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const CONFIG_KEYS = ['intervalMinutes', 'autoSend', 'dryRun', 'notify', 'staggerSeconds', 'retry', 'message', 'plans', 'codex'];

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 64 * 1024) reject(new Error('请求太大')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('JSON 格式不对')); } });
  });
}

function validConfig(patch) {
  const out = {};
  for (const k of CONFIG_KEYS) if (k in patch) out[k] = patch[k];
  if ('intervalMinutes' in out && ![1, 5, 15].includes(out.intervalMinutes)) throw new Error('检测间隔只能是 1、5、15 分钟');
  if ('staggerSeconds' in out && ![0, 30, 120].includes(out.staggerSeconds)) throw new Error('发送间隔只能是 0、30、120 秒');
  if ('message' in out && (typeof out.message !== 'string' || !out.message.trim() || out.message.length > 500)) throw new Error('继续内容不能为空，最多 500 字');
  for (const k of ['autoSend', 'dryRun', 'notify', 'retry']) if (k in out && typeof out[k] !== 'boolean') throw new Error(`${k} 必须是 true 或 false`);
  if ('codex' in out) {
    const c = out.codex;
    if (!c || typeof c !== 'object' || Object.keys(c).some(k => !['inheritSandbox', 'useSystemProxy'].includes(k))) throw new Error('Codex 设置格式不对');
    if ('inheritSandbox' in c && typeof c.inheritSandbox !== 'boolean') throw new Error('inheritSandbox 必须是 true 或 false');
    if ('useSystemProxy' in c && typeof c.useSystemProxy !== 'boolean') throw new Error('useSystemProxy 必须是 true 或 false');
  }
  if ('plans' in out) {
    const p = out.plans;
    const ok = v => v === null || (typeof v === 'string' && v.trim() && v.length <= 20);
    if (!p || typeof p !== 'object' || Object.keys(p).some(k => !['claude', 'codex'].includes(k) || !ok(p[k]))) throw new Error('套餐格式不对');
  }
  return out;
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.resolve(ROOT, '.' + rel);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

export function createServer({ store = createStore(), engine, diagnostics, port = 4317, host = '127.0.0.1' } = {}) {
  engine ??= new Engine({ store, notifier: notify });
  diagnostics ??= new CodexDiagnostics({ store, resolveBin:()=>{engine.refreshTools();return engine.bins.codex;}, codexHome: engine.homes.codex });
  const startedAt = Date.now();
  const view = () => ({ ...engine.view(), runtime: { app: 'Claudex', version: metadata.version, startedAt, root: path.dirname(ROOT) }, diagnostics: { codex: diagnostics.result } });
  let timer = null;

  const schedule = () => {
    clearTimeout(timer);
    const wait = Math.max(1000, engine.nextWakeAt() - Date.now());
    timer = setTimeout(async () => { await engine.check(); schedule(); }, Math.min(wait, 2 ** 31 - 1));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // 只接受来自本机页面的写请求，防止别的网页借浏览器调用接口
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return send(res, 403, { error: '只允许本机访问' });
    }
    try {
      if (url.pathname === '/api/health' && req.method === 'GET') return send(res, 200, { app: 'Claudex', version: metadata.version, pid: process.pid, root: path.dirname(ROOT), mode: store.config.dryRun ? 'dry' : 'real' });
      if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, view());
      if (url.pathname === '/api/test-codex' && req.method === 'POST') {
        await readBody(req);
        if (!diagnostics.start()) return send(res, 409, { error: '测试正在运行，请等待本次结果', ...view() });
        return send(res, 202, view());
      }
      if (url.pathname === '/api/check' && req.method === 'POST') { await engine.check(); schedule(); return send(res, 200, view()); }
      if (url.pathname === '/api/config' && req.method === 'POST') {
        const patch = validConfig(await readBody(req));
        store.updateConfig(patch);
        // 切到真实发送或打开自动发送后，已到点的会话立刻处理，不等下一次检测
        if (patch.dryRun === false || patch.autoSend === true) await engine.check();
        schedule();
        return send(res, 200, view());
      }
      if (url.pathname === '/api/session' && req.method === 'POST') {
        const { key, auto } = await readBody(req);
        if (typeof key !== 'string' || typeof auto !== 'boolean') throw new Error('需要 key 和 auto');
        engine.setAuto(key, auto);
        return send(res, 200, view());
      }
      if (url.pathname === '/api/send-now' && req.method === 'POST') {
        const { keys } = await readBody(req);
        // 手动重试前刷新原会话，避免发送到用户已自行继续的任务。
        await engine.check({send:false});
        const now = Date.now();
        const ready = engine.classified().filter(s => s.auto && (!keys || keys.includes(s.key)) && (!s.send || (s.send.status === 'failed' && !s.send.retryPending)) && s.recoverAt && s.recoverAt <= now);
        if (!ready.length) return send(res, 409, { error: '没有额度已恢复、可以发送的会话', ...view() });
        engine.sendDue({ keys: ready.map(s => s.key) });
        return send(res, 202, view());
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: '没有这个接口' });
      if (req.method === 'GET') return serveStatic(req, res);
      send(res, 405, { error: '不支持的请求' });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  });

  return {
    server, engine, store,
    async start() {
      await engine.check();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      schedule();
      return `http://${host}:${server.address().port}`;
    },
    stop() { clearTimeout(timer); server.close(); },
  };
}
