// 调度核心：检测 → 判断哪些会话到点 → 逐个发送“继续”（或演练）。
import os from 'node:os';
import path from 'node:path';
import { scanCodex } from './codex.mjs';
import { scanClaude } from './claude.mjs';
import { readCodexAccount } from './codex-account.mjs';
import { commandOutcome, commandProgress, processAlive } from './send-result.mjs';
import { runDesktopCommand, desktopOutcome, readDesktopReceipt, requestKey } from './claude-desktop.mjs';
import { findCodexBin, findClaudeBin, buildCommand, describeCommand, runCommand, relocatedWorkspace } from './sender.mjs';

const HOUR = 3600 * 1000;
export const sessionKey = s => `${s.source}:${s.id}:${s.blockedAt}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const submissionOf=rec=>({at:rec.at,transport:rec.transport||'cli',message:rec.message,messageUuid:rec.messageUuid});

// Codex：如果记录到的额度仍是满的且还没到重置时间，恢复时间以额度为准
function effectiveRecoverAt(s, quota, now) {
  let at = s.recoverAt;
  if (s.source === 'codex' && quota && (quota.observedAt || 0) >= s.blockedAt) {
    for (const w of [quota.fiveHour, quota.weekly]) {
      if (w && w.usedPercent >= 100 && w.resetsAt > now) at = Math.max(at ?? 0, w.resetsAt);
    }
  }
  return at;
}

/** 给一个中断的会话定状态：waiting / due / skipped，或已有的发送状态 */
export function classify(session, { config, state, quota, now }) {
  const key = sessionKey(session);
  let send = state.sends[key];
  if (send?.mode === 'dry' && !config.dryRun) send = null; // 演练记录不挡真实发送
  const firstSeen = state.seen[key] ?? now;
  const recoverAt = effectiveRecoverAt(session, quota, now);
  const excluded = (config.excludeTitlePatterns || []).some(p => p && (session.title || '').includes(p));
  const stale = recoverAt != null && recoverAt < firstSeen - config.catchUpHours * HOUR;
  const override = state.overrides[key];
  const auto = override ?? !(excluded || stale);
  const reason = override != null ? null : excluded ? 'excluded' : stale ? 'stale' : null;

  let status;
  if (send) status = send.status;
  else if (!auto) status = 'skipped';
  else if (recoverAt != null && now >= recoverAt + config.graceSeconds * 1000) status = 'due';
  else status = 'waiting';

  const { file, ...rest } = session;
  return { ...rest, key, recoverAt, auto, reason, status, send: send || null };
}

export class Engine {
  constructor({ store, env = process.env, now = () => Date.now(), runner = runCommand, desktopRunner = runDesktopCommand, notifier = () => {}, homes, wait = sleep, accountReader = readCodexAccount, findBins } = {}) {
    this.store = store;
    this.now = now;
    this.runner = runner;
    this.desktopRunner = desktopRunner;
    this.wait = wait;
    this.notifier = notifier;
    this.env = env;
    this.accountReader = accountReader;
    this.findBins = findBins || (() => ({codex:findCodexBin(this.env),claude:findClaudeBin(this.env)}));
    this.homes = homes || {
      codex: env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      claude: env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    };
    this.refreshTools();
    this.scan = { codex: null, claude: null };
    this.connections = {codex:{status:'pending'}};
    this.activeSends = new Set();
    this.sending = false;
    this.checking = false;
    // 服务重启后旧定时器已不存在；保留失败记录，只解除显式重发的占位。
    for (const rec of Object.values(this.state.sends)) {
      if (rec.retryPending) rec.retryPending = false;
    }
  }

  get config() { return this.store.config; }
  get state() { return this.store.state; }

  refreshTools() { this.bins = this.findBins(); }

  async refreshAccount(now) {
    let live;
    try { live = await this.accountReader({bin:this.bins.codex,codexHome:this.homes.codex,config:this.config,env:this.env,now:this.now}); }
    catch (error) { live = {error:error.message}; }
    const scan = this.scan.codex ||= {available:false,quota:null,sessions:[],plan:null};
    if (live.quota) this.state.codexAccount = live;
    // 请求失败时可沿用上次读数；如果接口明确返回另一种账户，不混用旧账户数据。
    const cached = !Object.hasOwn(live,'accountType') ? this.state.codexAccount : null;
    const fallback = [scan.quota,cached?.quota].filter(Boolean).sort((a,b)=>b.observedAt-a.observedAt)[0];
    scan.quota = live.quota || fallback || null;
    if (!live.quota && scan.quota) {
      const expired = w => w && w.resetsAt && w.resetsAt <= now ? {...w,usedPercent:0,estimated:true} : w;
      scan.quota = {...scan.quota,fiveHour:expired(scan.quota.fiveHour),weekly:expired(scan.quota.weekly)};
    }
    scan.plan = live.plan || scan.plan || cached?.plan || null;
    scan.available ||= !!this.bins.codex;
    for (const s of scan.sessions) {
      if (s.recoverAt != null || !scan.quota) continue;
      const full=[scan.quota.fiveHour,scan.quota.weekly].filter(w=>w?.usedPercent>=100 && w.resetsAt);
      if (full.length) s.recoverAt=Math.max(...full.map(w=>w.resetsAt));
    }
    this.connections.codex = {status:live.quota ? 'live' : scan.quota ? 'fallback' : 'unavailable',checkedAt:live.checkedAt || now,error:live.error || null,accountType:live.accountType || null};
  }

  recoverSends() {
    for (const rec of Object.values(this.state.sends)) {
      if (rec.mode !== 'real') continue;
      if(rec.transport==='claude-desktop') {
        // 旧版在首个思考块就停止观察。近期历史仅重新核对原回执，不重新投递。
        const legacy=rec.status==='resumed' && !rec.execution && this.now()-rec.at<24*HOUR;
        if((!legacy && !['sent','unconfirmed'].includes(rec.status)) || !rec.requestId)continue;
        const receipt=readDesktopReceipt(this.store.home,rec.requestId);
        if(!receipt)continue;
        const outcome=desktopOutcome(receipt,{now:this.now(),startOffset:rec.transcriptOffset});
        if(rec.deliveredAt && !outcome.deliveredAt)continue;
        const before=JSON.stringify(rec);
        if(legacy){delete rec.responseAt;delete rec.finishedAt;delete rec.confirmedBy;}
        Object.assign(rec,outcome);
        rec.messageUuid ||= receipt.uuid;
        if(outcome.deliveredAt)rec.lastConfirmedSubmission=submissionOf(rec);
        if(!outcome.error) {rec.error=null;rec.errorCode=null;}
        if(['replied','resumed'].includes(outcome.status)) rec.exitCode=0;
        if(before!==JSON.stringify(rec))this.updateBatch(rec);
        continue;
      }
      if(rec.source==='claude' && rec.status==='sent')rec.progress=commandProgress({logFile:rec.logFile,sessionId:rec.id});
      if(this.activeSends.has(rec.key))continue;
      if (rec.status === 'failed' && /^退出码 /.test(rec.error || '')) {
        rec.error = commandOutcome({...rec,sessionId:rec.id,code:rec.exitCode || 1,error:null}).error || rec.error;
      }
      if (rec.status !== 'sent') continue;
      const outcome=commandOutcome({...rec,sessionId:rec.id,requireResult:rec.command?.includes('stream-json')});
      if (!outcome.confirmedBy && processAlive(rec.pid)) continue;
      rec.status = outcome.confirmedBy && !outcome.error ? 'resumed' : 'failed';
      rec.finishedAt = this.now();
      rec.error = outcome.error || (rec.status==='failed' ? '原续接进程已结束，未确认完整回复。请检查后重试。' : null);
      this.updateBatch(rec);
    }
  }

  async check({ send = true } = {}) {
    if (this.checking) return;
    this.checking = true;
    const now = this.now();
    const errors = [];
    const opts = { now, maxAgeHours: this.config.maxAgeHours };
    this.refreshTools();
    this.recoverSends();
    try { this.scan.codex = scanCodex({ ...opts, codexHome: this.homes.codex }); }
    catch (e) { errors.push(`Codex 读取失败：${e.message}`); }
    try { this.scan.claude = scanClaude({ ...opts, claudeHome: this.homes.claude, claudexHome: this.store.home, sends:this.state.sends, message:this.config.message }); }
    catch (e) { errors.push(`Claude 读取失败：${e.message}`); }
    try { await this.refreshAccount(now); }
    finally { this.checking = false; }

    const blocked = this.blockedSessions();
    const keys = new Set(blocked.map(sessionKey));
    for (const k of keys) this.state.seen[k] ??= now;
    // 会话出现新一轮仅代表请求已提交；等进程正常结束后才确认续接完成。
    this.state.lastCheckAt = now;
    this.state.lastError = errors.join('；') || null;
    this.store.saveState();
    if (!send) return;
    if (this.config.autoSend) this.sendDue();
    else this.notifyRecovered();
  }

  // 自动发送关掉时，额度恢复只发一次通知，告诉你哪些会话可以继续了
  notifyRecovered() {
    this.state.notified ??= {};
    const fresh = this.classified().filter(s => s.status === 'due' && !this.state.notified[s.key]);
    if (!fresh.length) return;
    for (const s of fresh) this.state.notified[s.key] = this.now();
    this.store.saveState();
    if (this.config.notify) this.notifier({ kind: 'recovered', count: fresh.length });
  }

  blockedSessions() {
    return [...(this.scan.codex?.sessions || []), ...(this.scan.claude?.sessions || [])];
  }

  classified() {
    const ctx = { config: this.config, state: this.state, now: this.now() };
    return this.blockedSessions().map(s => {
      const cwd = relocatedWorkspace(s.cwd, this.config.workspaceMoves);
      const session = cwd !== s.cwd ? { ...s, cwd, project: path.basename(cwd) } : s;
      return classify(session, { ...ctx, quota: this.scan[s.source]?.quota });
    });
  }

  setAuto(key, auto) {
    if (!this.blockedSessions().some(s => sessionKey(s) === key) && !this.state.sends[key]) throw new Error('没有这个会话');
    this.state.overrides[key] = !!auto;
    this.store.saveState();
  }

  /** 逐个发送到点的会话；keys 给定时只发这些（“现在就发送”） */
  async sendDue({ keys = null } = {}) {
    if (this.sending) return { started: false, reason: '正在发送中' };
    const eligible = s => s.auto && (keys ? keys.includes(s.key) && (!s.send || (s.send.status === 'failed' && !s.send.retryPending && (s.send.retryable!==false || s.send.errorCode==='desktop_unavailable'))) : s.status === 'due');
    const list = this.classified().filter(eligible);
    if (!list.length) return { started: false, reason: '没有到点的会话' };
    this.sending = true;
    const dry = this.config.dryRun;
    const batch = this.now();
    const results = [];
    try {
      for (let i = 0; i < list.length; i++) {
        if (i > 0) await this.wait(this.config.staggerSeconds * 1000);
        if (!keys && !this.config.autoSend) break;
        // 等待期间允许用户跳过、切换演练或由最新扫描移除会话。
        const current = this.classified().find(s => s.key === list[i].key);
        if (!current || !eligible(current)) continue;
        results.push(await this.sendOne(current, dry || this.config.dryRun, 1, batch));
      }
    } finally { this.sending = false; }
    const ok = results.filter(r => r.status !== 'failed').length;
    this.state.log.unshift({ at: batch, mode: dry ? 'dry' : 'real', count: results.length, ok, items: results.map(r => ({ key: r.key, title: r.title, source: r.source, status: r.status })) });
    this.store.saveState();
    if (this.config.notify) this.notifier({ dry, count: results.length, ok });
    return { started: true, results };
  }

  // 重试保留原记录占位；期间的检测和手动发送都不能重复启动。
  async retryOne(s, rec, delay) {
    rec.retryPending = true;
    this.store.saveState();
    await this.wait(delay);
    if (this.state.sends[s.key] !== rec) return rec;
    rec.retryPending = false;
    this.store.saveState();
    await this.check({send:false});
    const current = this.classified().find(item => item.key === s.key);
    if (!current?.auto || !this.config.autoSend || this.config.dryRun || !this.config.retry) return rec;
    if (current.recoverAt != null && current.recoverAt + this.config.graceSeconds * 1000 > this.now()) return rec;
    const retried = await this.sendOne(current, false, 2, rec.batch);
    this.updateBatch(retried);
    return retried;
  }

  updateBatch(rec) {
    const entry = this.state.log.find(l => l.at === rec.batch);
    const item = entry?.items.find(it => it.key === rec.key);
    if (item) {
      item.status = rec.status;
      entry.ok = entry.items.filter(it => it.status !== 'failed').length;
    }
    this.store.saveState();
  }

  async sendOne(s, dry, attempt = 1, batch = this.now()) {
    if(this.activeSends.has(s.key))return this.state.sends[s.key];
    this.refreshTools();
    const cmd = buildCommand(s, this.config.message, this.config, this.bins, {env:this.env});
    const base = { key:s.key,source:s.source,id:s.id,title:s.title,project:s.project,cwd:s.cwd,entrypoint:s.entrypoint,blockedAt:s.blockedAt,recoverAt:s.recoverAt,kind:s.kind,message:this.config.message,at:this.now(),batch,command:describeCommand(cmd),attempt,transport:cmd.transport || 'cli' };
    const prior=this.state.sends[s.key];
    if(prior?.mode==='real')base.previousSubmission=prior.lastConfirmedSubmission||prior.previousSubmission||submissionOf(prior);
    if (dry) {
      const rec = { ...base, mode: 'dry', status: 'simulated' };
      this.state.sends[s.key] = rec;
      this.store.saveState();
      return rec;
    }
    const logFile = path.join(this.store.logsDir, `${s.source}-${s.id}-${base.at}.log`);
    const rec = { ...base, mode:'real',status:'sent',logFile,progress:{phase:'starting'} };
    this.activeSends.add(rec.key);
    this.state.sends[s.key]=rec;
    this.store.saveState();
    const onProgress=update=>{if(this.state.sends[s.key]===rec){const before=JSON.stringify(rec);Object.assign(rec,update);if(update.deliveredAt)rec.lastConfirmedSubmission=submissionOf(rec);if(before!==JSON.stringify(rec))this.store.saveState();}};
    cmd.requestId=requestKey(`${s.key}:${base.at}:${attempt}`);
    if(cmd.transport==='claude-desktop')rec.requestId=cmd.requestId;
    let run;
    try {run=cmd.transport==='claude-desktop' ? await this.desktopRunner(cmd,{home:this.store.home,claudeHome:this.homes.claude,logFile,onProgress}) : this.runner(cmd,{home:this.store.home,logFile,onProgress});}
    catch(error){run={error:error.message,retryable:false};}
    if (run.error) {
      this.activeSends.delete(rec.key);
      Object.assign(rec,{status:run.status||'failed',error:run.error,errorCode:run.errorCode,retryable:run.retryable,finishedAt:this.now()});
      this.store.saveState();
      if (this.config.retry && attempt === 1 && run.retryable!==false && rec.transport!=='claude-desktop') return this.retryOne(s, rec, 5000);
      return rec;
    }
    Object.assign(rec,{pid:run.pid,requestId:run.requestId,messageUuid:run.messageUuid});
    this.store.saveState();
    // 两分钟内就报错退出，多半是没接上（例如额度其实还没恢复）：等一分钟按设置重试一次
    run.done.then(async (outcome) => {
      this.activeSends.delete(rec.key);
      const cur = this.state.sends[s.key];
      if (cur !== rec) return;
      if(rec.transport!=='claude-desktop')outcome={...outcome,...commandOutcome({...rec,sessionId:rec.id,...outcome})};
      const {code,error}=outcome;
      Object.assign(cur,outcome);
      cur.exitCode = code;
      cur.finishedAt = outcome.finishedAt ?? this.now();
      if(outcome.status==='unconfirmed')cur.status='unconfirmed';
      else if (code !== 0 || error) {
        cur.status = 'failed';
        cur.error = error || `退出码 ${code}`;
      }
      else {
        cur.status = outcome.status === 'replied' ? 'replied' : 'resumed';
        cur.error=null;cur.errorCode=null;
      }
      this.updateBatch(cur);
      if (cur.status === 'failed' && cur.retryable!==false && rec.transport!=='claude-desktop' && this.config.retry && attempt === 1 && this.now() - base.at < 120000) {
        await this.retryOne(s, cur, 60000);
      }
    });
    return rec;
  }

  // 下一次该醒来的时间：常规检测，或最近一个会话的恢复时刻（到点立刻发，不等 5 分钟）
  nextWakeAt() {
    const now = this.now();
    const regular = (this.state.lastCheckAt || now) + this.config.intervalMinutes * 60000;
    const upcoming = this.classified()
      .filter(s => s.auto && !s.send && s.recoverAt && s.recoverAt + this.config.graceSeconds * 1000 > now)
      .map(s => s.recoverAt + this.config.graceSeconds * 1000 + 1000);
    return Math.min(regular, ...upcoming);
  }

  view() {
    this.recoverSends();
    const now = this.now();
    const sessions = this.classified()
      .sort((a, b) => (a.recoverAt ?? Infinity) - (b.recoverAt ?? Infinity))
      .map(s => ({ ...s, command: describeCommand(buildCommand(s, this.config.message, this.config, this.bins)) }));
    const waiting = sessions.filter(s => s.auto && !s.send);
    // 同一来源、恢复时间相差 10 分钟以内的算一组，组时间取最晚的那个
    const groups = [];
    for (const s of waiting) {
      const g = groups.find(x => x.source === s.source && x.at != null && s.recoverAt != null && Math.abs(x.at - s.recoverAt) <= 10 * 60000);
      if (g) { g.count++; g.keys.push(s.key); g.at = Math.max(g.at, s.recoverAt); g.from = Math.min(g.from, s.blockedAt); }
      else groups.push({ source: s.source, at: s.recoverAt, from: s.blockedAt, count: 1, keys: [s.key] });
    }
    const sent = Object.values(this.state.sends)
      .filter(r => now - r.at < 24 * HOUR && (r.mode === 'real' || this.config.dryRun))
      .sort((a, b) => b.at - a.at);
    return {
      now,
      config: this.config,
      checking: this.checking,
      sending: this.sending,
      lastCheckAt: this.state.lastCheckAt,
      nextCheckAt: this.nextWakeAt(),
      lastError: this.state.lastError,
      tools: this.bins,
      connections: this.connections,
      plans: {
        codex: this.config.plans.codex || this.scan.codex?.plan || null,
        claude: this.config.plans.claude || null,
      },
      quota: { codex: this.scan.codex?.quota || null, claude: this.scan.claude?.quota || null },
      available: { codex: !!this.scan.codex?.available, claude: !!this.scan.claude?.available },
      next: groups.find(g => g.at && g.at > now) || null,
      groups,
      sessions,
      sent,
      log: this.state.log.slice(0, 10),
    };
  }
}
