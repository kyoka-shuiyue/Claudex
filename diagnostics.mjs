// 单次真实连接测试独立于自动续跑队列，演练模式下也能显式运行。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { recentJsonl, readFirstRecord, readTailRecords } from './jsonl.mjs';
import { readSessionSandbox } from './codex.mjs';
import { buildCommand, runCommand } from './sender.mjs';

export class CodexDiagnostics {
  constructor({ store, bin, resolveBin, codexHome, runner = runCommand, token = () => randomUUID() } = {}) {
    Object.assign(this, { store, bin, resolveBin, codexHome, runner, token });
    this.result = store.state.codexTest || { status: 'idle' };
    if (this.result.status === 'running') this.recover();
  }

  save() { this.store.state.codexTest = this.result; this.store.saveState(); }

  // 服务重启不会结束 detached 的测试进程；保留锁并收集旧测试的结果。
  recover() {
    const observe = () => {
      let alive = false;
      try { if (this.result.pid) { process.kill(this.result.pid, 0); alive = true; } } catch {}
      const log = this.result.logFile && fs.existsSync(this.result.logFile) ? fs.readFileSync(this.result.logFile, 'utf8') : '';
      const complete = log.split(/\r?\n/).some(line => { try { return JSON.parse(line).type === 'turn.completed'; } catch { return false; } });
      if (alive && !complete) return;
      clearInterval(this.recoveryTimer);
      try { this.finish({code:complete ? 0 : 1}, log); }
      catch(e) { this.result = {...this.result,status:'failed',finishedAt:Date.now(),error:e.message}; this.save(); }
    };
    this.recoveryTimer = setInterval(observe, 1000);
    this.recoveryTimer.unref();
    observe();
  }

  start() {
    if (this.result.status === 'running') return false;
    this.result = { status: 'running', startedAt: Date.now(), useSystemProxy: this.store.config.codex.useSystemProxy !== false };
    this.save();
    this.execute().catch(e => {
      this.result = { ...this.result, status: 'failed', finishedAt: Date.now(), error: e.message };
      this.save();
    });
    return true;
  }

  async execute() {
    if (this.resolveBin) this.bin=this.resolveBin();
    if (!this.bin) throw new Error('没有找到 Codex 命令行程序，请先安装并登录 Codex。');
    const config = this.store.config;
    const marker = 'CLAUDEX_TEST_' + this.token();
    const prompt = '这是 Claudex 的独立连接测试。仅回复“Claudex 连接成功。”以及验证标记 ' + marker + '。不要调用工具、修改文件或执行其他任务。';
    const id = config.codex.testSessionId;
    const file = id && recentJsonl(path.join(this.codexHome, 'sessions'), 0).find(f => f.file.endsWith(id + '.jsonl'))?.file;
    let session;
    if (file) {
      const meta = readFirstRecord(file)?.payload;
      if (!meta || meta.id !== id) throw new Error('测试会话记录不匹配。');
      session = { source: 'codex', id, cwd: meta.cwd, sandbox: readSessionSandbox(file, readTailRecords(file, { enough: rs => rs.some(r => r.type === 'turn_context') })) };
    } else {
      const cwd = path.join(this.store.home, 'connection-test');
      fs.mkdirSync(cwd, { recursive: true });
      session = { source: 'codex', id: null, cwd, sandbox: 'read-only' };
    }
    const settings = { ...config, codex: { ...config.codex, extraArgs: [...(config.codex.extraArgs || []), '--json'] } };
    const command = buildCommand(session, prompt, settings, { codex: this.bin });
    const logFile = path.join(this.store.logsDir, 'codex-test-' + Date.now() + '.log');
    const run = this.runner(command, { logFile });
    if (run.error) throw new Error(run.error);
    this.result = { ...this.result, pid: run.pid, logFile, marker, sessionId: session.id, stage: '正在等待 Codex 回复' };
    this.save();
    let timer;
    let replyTimer;
    const replyReceived = new Promise(resolve => {
      replyTimer = setInterval(() => {
        // turn.completed 已确认模型完成这一轮；不必再等 CLI 关闭可选 MCP 的清理过程。
        try {
          const events = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
          if (events.some(e => e.type === 'turn.completed') && events.some(e => e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text?.includes(marker))) resolve({code:0,confirmedBy:'turn.completed'});
        } catch {}
      }, 250);
      replyTimer.unref();
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { if (run.pid) process.kill(run.pid); } catch {}
        reject(new Error('测试超过 3 分钟，请检查 Codex 登录与网络连接后重试。'));
      }, 180000);
      timer.unref();
    });
    let outcome;
    try { outcome = await Promise.race([run.done, replyReceived, timeout]); } finally { clearTimeout(timer); clearInterval(replyTimer); }
    this.finish(outcome, fs.readFileSync(logFile, 'utf8'));
  }

  finish(outcome, log) {
    const config = this.store.config;
    const marker = this.result.marker;
    const sessionId = this.result.sessionId;
    const events = log.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const threadId = events.find(e => e.type === 'thread.started')?.thread_id || sessionId;
    const replies = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text);
    const reply = marker && replies.find(t => t.includes(marker));
    const failure = events.findLast(e => e.type === 'turn.failed' || e.type === 'error');
    if (outcome.code !== 0 || !reply) throw new Error(outcome.error || failure?.error?.message || failure?.message || 'Codex 没有返回验证回复；请查看测试日志。');
    if (sessionId && threadId !== sessionId) throw new Error('回复来自不同会话，未通过续接验证。');
    if (threadId && threadId !== config.codex.testSessionId) this.store.updateConfig({ codex: { testSessionId: threadId } });
    this.result = {
      ...this.result, status: 'success', finishedAt: Date.now(), sessionId: threadId,
      stage: '已收到验证回复', confirmedBy: outcome.confirmedBy || 'process.exit',
      elapsedMs: Date.now() - this.result.startedAt, reply: reply.replace(marker, '').trim(),
      retries: (log.match(/retrying sampling request/g) || []).length,
    };
    this.save();
  }
}
