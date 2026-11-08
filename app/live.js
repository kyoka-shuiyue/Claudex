/* Claudex 实时模式：把界面接到本地服务（server/server.mjs，接口见 work/api.md）。
   只在 html[data-mode="live"] 下运行；演示模式由 claudex.js 负责。
   数据流：GET /api/state → V；所有操作 POST 后用响应里的完整状态重绘。 */
(() => {
  if (document.documentElement.dataset.mode !== 'live') return;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pad = n => String(n).padStart(2, '0');
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const SRC = { codex: 'Codex', claude: 'Claude Code' };
  const NAME = { codex: 'Codex', claude: 'Claude' };
  const DEFAULT_MSG = '额度已恢复，请从刚才中断的地方继续完成原来的任务。只做原任务范围内的事，不要扩大范围。';
  const MAX_MSG = 500;
  const PLANS = { claude: ['Pro', 'Max 5x', 'Max 20x', 'Team', 'Enterprise'], codex: ['Free', 'Plus', 'Pro', 'Business', 'Enterprise'] };
  const CHECK = '<svg class="ck" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.5"/></svg>';
  const TERM = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8l4.5 4L5 16"/><path d="M12.5 17H19"/></svg>';
  const REASON = { excluded: '续跑类会话，默认跳过，避免重复发送', stale: '恢复已过去太久，没有自动补发' };

  /* ---------- 状态 ---------- */
  let V = null;               // 最近一次 /api/state
  let offset = 0;             // 服务端时间 - 本地时间
  let offline = false;
  let loading = true;
  let polling = false, lastTry = 0, pollTimer = null;
  let seqReq = 0, seqApplied = 0;
  let prevCounts = null, lastModel = null, lastLogAt = null;
  const ui = { tab: 'wait', expanded: new Set(), checkBusy: false, listLock: false, pendingList: false, dk: '' };
  const cache = new Map();
  const nowMs = () => Date.now() + offset;

  /* ---------- 时间格式 ---------- */
  const D = ts => new Date(ts);
  const hm = ts => pad(D(ts).getHours()) + ':' + pad(D(ts).getMinutes());
  const hms = ts => hm(ts) + ':' + pad(D(ts).getSeconds());
  const dayDiff = ts => {
    const a = new Date(nowMs()); a.setHours(0, 0, 0, 0);
    const b = D(ts); b.setHours(0, 0, 0, 0);
    return Math.round((b - a) / 864e5);
  };
  const md = ts => (D(ts).getMonth() + 1) + '月' + D(ts).getDate() + '日';
  const stamp = ts => { const k = dayDiff(ts); return k === 0 ? hm(ts) : k === 1 ? '明天 ' + hm(ts) : k === -1 ? '昨天 ' + hm(ts) : md(ts) + ' ' + hm(ts); };
  const dayStamp = ts => { const k = dayDiff(ts); return k === 0 ? '今天 ' + hm(ts) : k === -1 ? '昨天 ' + hm(ts) : md(ts) + ' ' + hm(ts); };
  const weekStamp = ts => { const k = dayDiff(ts); return k === 0 ? hm(ts) : k > 0 && k < 7 ? '周' + '日一二三四五六'[D(ts).getDay()] + ' ' + hm(ts) : (D(ts).getMonth() + 1) + '/' + D(ts).getDate() + ' ' + hm(ts); };
  const mmss = s => { s = Math.max(0, Math.ceil(s)); return pad(Math.floor(s / 60)) + ':' + pad(s % 60); };
  function cdParts(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000)), m = Math.floor(s / 60);
    if (m < 100) return { a: pad(m), b: pad(s % 60), ua: '分', ub: '秒' };
    if (m < 6000) return { a: pad(Math.floor(m / 60)), b: pad(m % 60), ua: '时', ub: '分' };
    return { a: pad(Math.floor(m / 1440)), b: pad(Math.floor(m % 1440 / 60)), ua: '天', ub: '时' };
  }
  const gapText = s => s === 0 ? '同时发送，不留间隔' : '逐个发送，间隔 ' + (s === 30 ? '30 秒' : '2 分钟');

  /* ---------- 小工具 ---------- */
  function put(el, html, key = el.id) {
    if (cache.get(key) === html) return false;
    cache.set(key, html); el.innerHTML = html; return true;
  }
  function swap(el, html, fade) {
    if (cache.get(el.id) === html) return;
    cache.set(el.id, html);
    if (!fade || reduce) { el.innerHTML = html; return; }
    el.classList.add('out');
    setTimeout(() => { el.innerHTML = html; el.classList.remove('out', 'in'); void el.offsetWidth; el.classList.add('in'); updRuler(); }, 140);
  }
  const setSwitch = (el, v) => el.setAttribute('aria-checked', String(!!v));
  function flashErr(anchor, text) {
    $$('.oerr').forEach(e => e.remove());
    const el = document.createElement('div');
    el.className = 'oerr'; el.setAttribute('role', 'alert'); el.textContent = text; el.title = text;
    document.body.appendChild(el);
    const r = (anchor && anchor.isConnected ? anchor : document.body).getBoundingClientRect();
    const w = el.offsetWidth;
    el.style.top = Math.min(innerHeight - el.offsetHeight - 8, r.bottom + 6) + 'px';
    el.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
    setTimeout(() => el.classList.add('fade'), 2650);
    setTimeout(() => el.remove(), 3100);
  }

  /* ---------- 接口 ---------- */
  async function request(path, body) {
    const my = ++seqReq, t0 = Date.now();
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),body===undefined?8000:20000);
    let res, data = null;
    try {
      res = await fetch(path, body === undefined ? { cache: 'no-store',signal:controller.signal } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),signal:controller.signal });
    } catch { clearTimeout(timer);setOffline(true); return { net: true, err: controller.signal.aborted?'请求超时，正在重新连接；提交结果请以发送记录为准。':'Claudex 服务没有响应' }; }
    try { data = await res.json(); } catch {}
    finally {clearTimeout(timer);}
    const hasState = data && typeof data.now === 'number';
    if (hasState && my >= seqApplied) { seqApplied = my; offset = data.now - (t0 + Date.now()) / 2; apply(data); }
    if (res.ok && hasState) return { ok: true };
    return { err: (data && data.error) || '操作没有成功（' + res.status + '）' };
  }
  async function refresh() {
    if (polling) return;
    polling = true; lastTry = Date.now();
    try { await request('/api/state'); } finally { polling = false; schedulePoll(); }
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    const d = offline ? 5000 : V?.diagnostics?.codex?.status === 'running' ? 1000 : V && (V.sending || V.checking || V.sent.some(r => ['sent','unconfirmed'].includes(r.status))) ? 2000 : 15000;
    pollTimer = setTimeout(refresh, d);
  }
  function setOffline(v) {
    if (offline === v) return;
    offline = v;
    if (loading && v) endLoading();
    renderChk();
    if (!V) { renderPlans(); renderBand(false); renderCtrl(); renderDry(); renderList(false, true); renderCard(); }
    if (v) schedulePoll();
  }
  function endLoading() {
    loading = false;
    document.body.classList.remove('loading');
    document.body.classList.add('first');
    setTimeout(() => document.body.classList.remove('first'), 1100);
  }
  async function post(path, body, anchor) {
    const r = await request(path, body);
    if (!r.ok) { flashErr(anchor, r.err); renderAll(false); }
    return !!r.ok;
  }
  const setConfig = (patch, anchor) => post('/api/config', patch, anchor);

  function apply(data) {
    V = data; offline = false;
    const first = loading;
    if (first) endLoading();
    ui.dk = derivedKey();
    renderAll(!first);
    schedulePoll();
  }

  /* ---------- 派生数据 ---------- */
  const pending = () => V.sessions.filter(s => s.auto && !s.send);
  const dueNow = () => pending().filter(s => s.recoverAt != null && s.recoverAt <= nowMs());
  function derivedKey() {
    if (!V) return '';
    const t = nowMs(), g = V.groups.find(x => x.at != null && x.at > t);
    return dueNow().length + '|' + (g ? g.at : '') + '|' + V.sending;
  }
  const exhausted = src => { const q = V.quota[src]; return !!q && [q.fiveHour, q.weekly].some(w => w && !w.estimated && w.usedPercent >= 100); };
  function remainingLabel(src) {
    const q = V.quota[src];
    if (q?.weekly && !q.fiveHour) return (q.weekly.label || '本周') + '剩余';
    if (q?.fiveHour && !q.weekly) return (q.fiveHour.label || '5 小时') + '剩余';
    return '剩余';
  }
  function remain(src) {
    const q = V.quota[src]; if (!q) return null;
    const ws = [q.fiveHour, q.weekly].filter(Boolean); if (!ws.length) return null;
    return Math.max(0, Math.min(...ws.map(w => 100 - Math.round(w.usedPercent))));
  }

  /* ---------- 顶栏 ---------- */
  function renderChk() {
    const el = $('#chk');
    el.classList.toggle('bad', offline || !!(V && V.lastError));
    let h = '';
    const nx = '<b class="num" id="next" aria-hidden="true"></b>';
    if (offline) h = '<i class="dot"></i><span class="bd">Claudex 服务没有响应</span>' + (V ? ' · 显示的是上次的数据' : '');
    else if (!V) h = '';
    else if (ui.checkBusy || V.checking) h = '<i class="dot"></i>正在检测…';
    else {
      const last = V.lastCheckAt ? hm(V.lastCheckAt) : '--:--';
      h = V.lastError ? '<i class="dot"></i><span class="bd">' + last + ' 检测失败</span> · 下次 ' + nx : '<i class="dot"></i>运行中 · ' + last + ' 检测 · 下次 ' + nx;
    }
    put(el, h, 'chk'); updNext();
  }
  function updNext() {
    const n = $('#next'); if (n && V) n.textContent = mmss((V.nextCheckAt - nowMs()) / 1000);
  }
  function renderPlans() {
    $('#planClaude').textContent = (V && V.plans.claude) || '未识别';
    $('#planCodex').textContent = (V && V.plans.codex) || '未识别';
    const manual = V && (V.config.plans.claude || V.config.plans.codex);
    $('#planEdit').textContent = '更改套餐';
    $('#planEdit').title = manual ? '当前含手动设置的套餐' : '查看或更改自动识别的套餐';
    $('#planEdit').disabled = !V;
  }
  function renderInterval() {
    const m = V ? V.config.intervalMinutes : 5;
    $$('#intervalSeg button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.min === m)));
    $('#qNote').textContent = '每 ' + m + ' 分钟更新';
  }

  /* ---------- 报头 ---------- */
  function otherGroups(skip) {
    return V.groups.filter(g => g !== skip).map(g => (g.at != null ? stamp(g.at) + ' ' + NAME[g.source] + ' 恢复' : NAME[g.source] + ' 恢复时间未知') + ' · ' + g.count + ' 个会话');
  }
  function rulerHTML(a, b) {
    return '<div class="ruler"><div class="rail"><i id="rI"></i><u id="rU"></u></div><div class="ticks"><span><b>' + stamp(a) + '</b> 中断</span><span>现在 <b id="rNow"></b></span><span><b>' + stamp(b) + '</b> 恢复</span></div></div>';
  }
  function bandModel() {
    if (!V) {
      return {
        state: 'error', kick: '<span class="tag">服务没有响应</span>无法连接本地服务', cd: { mode: 'dash', txt: '--', stale: true }, ruler: null,
        msg: '<p class="eta">连不上 Claudex 服务</p><p class="reason">请确认服务正在运行，页面会自动重试。</p><div class="errbtn"><button class="btn p" type="button" id="retry">重试</button></div>',
      };
    }
    const t = nowMs(), c = V.config;
    const next = V.groups.find(g => g.at != null && g.at > t) || null;
    const due = dueNow();
    const gap = c.staggerSeconds === 0 ? '到点后同时发送，不留间隔' : '到点后逐个发送，间隔 ' + (c.staggerSeconds === 30 ? '30 秒' : '2 分钟');

    if (V.lastError) {
      const bad = []; if (/Codex 读取失败/.test(V.lastError)) bad.push('Codex'); if (/Claude 读取失败/.test(V.lastError)) bad.push('Claude');
      return {
        state: 'error',
        kick: '<span class="tag">检测失败</span>上次结果 · ' + (next ? '距离 ' + NAME[next.source] + ' 额度恢复还有' : '目前没有等待中的会话'),
        cd: next ? { mode: 'count', target: next.at, stale: true } : { mode: 'dash', txt: '--', stale: true },
        msg: '<p class="eta">无法读取 ' + (bad.length ? bad.join(' 和 ') + ' 的额度' : '本机额度') + '</p>' +
          '<div class="errbtn"><button class="btn p sm" type="button" id="retry">重试</button><button class="btn g sm" type="button" data-details="scan">错误详情</button></div>',
        ruler: null,
      };
    }
    if (V.sending || due.length) {
      const names = [...new Set(due.map(s => NAME[s.source]))].join(' / ');
      const tag = V.sending ? '正在发送继续' + (due.length ? ' · 还剩 ' + due.length + ' 个' : '') : (names || '额度') + ' 已恢复';
      return {
        state: 'sending',
        kick: '<span class="tag ok">' + esc(tag) + '</span>' + (next ? '距离 ' + NAME[next.source] + ' ' + stamp(next.at) + ' 恢复还有' : '目前没有其他等待的会话'),
        cd: next ? { mode: 'count', target: next.at } : { mode: 'dash', txt: '00' },
        msg: '<p class="eta">' + (names ? esc(names) + ' ' : '') + '额度已恢复，<br>' + (V.sending ? '正在发送继续' : '马上发送继续') + '</p>' +
          '<p class="sub">' + (c.dryRun ? '演练模式：只记录要执行的命令' : gapText(c.staggerSeconds)) + '</p>' + (next ? rulerHTML(next.from, next.at) : ''),
        ruler: next ? { a: next.from, b: next.at } : null,
      };
    }
    if (next) {
      const nm = NAME[next.source], others = otherGroups(next);
      const eta = c.autoSend
        ? '<em>' + stamp(next.at) + '</em> ' + nm + ' 恢复，<br>' + (c.dryRun ? '演练 <em>' + next.count + '</em> 条继续请求' : '自动给 <em>' + next.count + '</em> 个会话发送继续')
        : '<em>' + stamp(next.at) + '</em> ' + nm + ' 恢复后<br>只通知你，不自动发送';
      return {
        state: 'waiting',
        kick: '<span class="tag">' + nm + ' 已用完</span>距离 ' + nm + ' 额度恢复还有',
        cd: { mode: 'count', target: next.at },
        msg: '<p class="eta" id="eta">' + eta + '</p><p class="sub" title="' + esc(others.join('；')) + '">' + (others.length > 1 ? '另有 ' + others.length + ' 批会话，恢复时间见下方列表' : others.length ? esc(others[0]) : gap) + '</p>' + rulerHTML(next.from, next.at),
        ruler: { a: next.from, b: next.at },
      };
    }
    const unknown = V.groups.filter(g => g.at == null);
    if (unknown.length) {
      const n = unknown.reduce((a, g) => a + g.count, 0);
      return {
        state: 'waiting',
        kick: '<span class="tag">恢复时间未知</span>' + n + ' 个会话停在额度提示上',
        cd: { mode: 'dash', txt: '--', stale: true },
        msg: '<p class="eta">还没读到恢复时间<br>读到后会自动安排发送</p><p class="sub">' + esc(otherGroups(null).join('　')) + '</p>', ruler: null,
      };
    }
    // 没有等待中的会话
    const skipped = V.sessions.filter(s => !s.auto && !s.send).length;
    const rem = { codex: remain('codex'), claude: remain('claude') };
    const known = ['codex', 'claude'].filter(k => rem[k] != null);
    const ex = ['codex', 'claude'].filter(exhausted);
    const best = known.slice().sort((a, b) => rem[b] - rem[a])[0];
    const idle = skipped ? '目前没有等待发送的会话' : '目前没有被卡住的会话';
    let kick;
    if (ex.length) kick = '<span class="tag">' + ex.map(k => NAME[k]).join(' 和 ') + ' 已用完</span>目前没有等待发送的会话';
    else if (known.length) kick = '<span class="tag ok">' + known.map(k => NAME[k]).join(' / ') + ' 额度</span>' + idle;
    else kick = '<span class="tag ok">暂未读到额度</span>' + idle;
    const recent = V.log[0] && t - V.log[0].at < 3600e3 ? V.log[0] : null;
    const sub = recent
      ? hm(recent.at) + (recent.mode === 'dry' ? ' 演练 · 已记录 ' : ' · 已提交 ') + recent.count + ' 条继续请求'
      : skipped ? skipped + ' 个中断会话已设为跳过' : c.dryRun ? '演练模式会记录到点的续接命令' : c.autoSend ? '额度恢复后会向原会话发送继续' : '已关闭自动发送';
    const row = k => '<div class="mrow"><span>' + NAME[k] + ' ' + esc(remainingLabel(k)) + '</span><span class="rail"><i style="width:' + rem[k] + '%"></i></span><b>' + rem[k] + '%</b></div>';
    return {
      state: 'clear', kick,
      cd: best ? { mode: 'pct', value: rem[best] + '%', label: NAME[best] + ' ' + remainingLabel(best) } : { mode: 'pct', value: '--', label: '暂未读到额度', stale: true },
      msg: '<p class="eta">' + (skipped ? '没有等待发送的会话' : '没有被卡住的会话') + '</p><p class="sub">' + esc(sub) + '</p>' + (known.length ? '<div class="ruler">' + known.map(row).join('') + '</div>' : ''),
      ruler: null,
    };
  }
  const cdState = { mode: null, unit: '', target: 0 };
  function renderCd(m) {
    const cd = $('#cd'), c = m.cd;
    cd.classList.toggle('stale', !!c.stale && c.mode === 'count');
    cd.classList.toggle('dim', !!c.stale && c.mode !== 'count');
    cdState.mode = c.mode; cdState.target = c.target;
    let h;
    if (c.mode === 'count') {
      const p = cdParts(c.target - nowMs()); cdState.unit = p.ua + p.ub;
      h = '<span class="cdg"><span id="cdm">' + p.a + '</span><small>' + p.ua + '</small></span><span class="cdg"><span>:</span><small>&nbsp;</small></span><span class="cdg"><span id="cds">' + p.b + '</span><small>' + p.ub + '</small></span>';
    } else if (c.mode === 'pct') h = '<span class="cdg"><span>' + esc(c.value) + '</span><small>' + esc(c.label) + '</small></span>';
    else h = '<span class="cdg"><span class="dash">' + c.txt + '</span><small>分</small></span><span class="cdg"><span>:</span><small>&nbsp;</small></span><span class="cdg"><span class="dash">' + c.txt + '</span><small>秒</small></span>';
    put(cd, h, 'cd:' + c.mode + (c.mode === 'count' ? ':' + c.target : ''));
    if (c.mode === 'count') tickCd();
  }
  function tickCd() {
    if (cdState.mode !== 'count') return;
    const p = cdParts(cdState.target - nowMs());
    if (p.ua + p.ub !== cdState.unit) { renderCd(lastModel); return; }
    const a = $('#cdm'), b = $('#cds');
    if (a) a.textContent = p.a; if (b) b.textContent = p.b;
  }
  function updRuler() {
    const i = $('#rI'); if (!i || !lastModel || !lastModel.ruler) return;
    const { a, b } = lastModel.ruler, t = nowMs();
    const p = b > a ? Math.min(100, Math.max(0, (t - a) / (b - a) * 100)) : 100;
    i.style.width = p + '%'; $('#rU').style.left = p + '%'; $('#rNow').textContent = hm(t);
  }
  function renderBand(fade) {
    const m = bandModel(); lastModel = m;
    document.body.dataset.state = m.state;
    put($('#kick'), m.kick, 'kick');
    renderCd(m);
    swap($('#bMsg'), m.msg, fade);
    if (!fade || reduce) updRuler(); else setTimeout(updRuler, 160);
  }
  function renderSwitches() {
    if (!V) return;
    setSwitch($('#swAuto'), V.config.autoSend); setSwitch($('#swNotify'), V.config.notify);
  }
  function renderCtrl() {
    const btn = $('#sendNow'), hint = $('#sendHint');
    if (!V) { btn.disabled = true; hint.textContent = '服务没有响应'; return; }
    const ready = dueNow();
    btn.disabled = !ready.length || V.sending;
    hint.textContent = V.sending ? '正在发送…' : ready.length ? (V.config.dryRun ? '演练：只记录 ' + ready.length + ' 个会话' : '可发送 ' + ready.length + ' 个会话') : pending().length ? '额度恢复后才能发送' : '没有等待发送的会话';
  }
  function renderDry() {
    const el = $('#dry'); if (!el) return;
    el.hidden = !V;
    if (!V) return;
    const dry = V.config.dryRun;
    el.classList.toggle('real', !dry);
    put(el, dry
      ? '<span class="tagd"><i></i>演练模式 · 仅记录</span><button class="btn g sm" type="button" id="dryBtn" data-act="go-real">开启真实发送</button>'
      : '<span class="tagd"><i></i><b>真实发送</b> · 后台执行</span><button class="btn g sm" type="button" id="dryBtn" data-act="go-dry">切回演练</button>', 'dry');
  }

  /* ---------- 左栏额度 ---------- */
  function barRow(label, w, kind, missing = '暂无数据') {
    const used = w ? Math.max(0, Math.min(100, Math.round(w.usedPercent))) : null;
    const time = !w ? missing : !w.resetsAt ? '时间未知' :
      (kind === 'wk' ? weekStamp(w.resetsAt) : stamp(w.resetsAt)) +
      (w.estimated ? ' · 估计' : used === 100 ? ' 恢复' : ' 重置');
    const description = w ? '已用 ' + used + '%' : '';
    return '<div class="quota-window"><div class="window-line"><span>' + label + '</span><b>' + description + '</b><span class="r">' + time + '</span></div>' +
      '<div class="trk' + (used === 100 ? ' out' : '') + (w ? '' : ' none') + '">' + (w ? '<i style="width:' + used + '%"></i>' : '') + '</div></div>';
  }
  function pace(q) {
    const wk = q.weekly, fh = q.fiveHour, t = nowMs();
    if (wk && !wk.estimated && wk.usedPercent >= 100) return { warn: true, text: (wk.label || '本周') + '额度已用完 · ' + (wk.resetsAt ? weekStamp(wk.resetsAt) + ' 重置' : '重置时间未知') };
    if (wk) {
      const used = Math.round(wk.usedPercent), head = '已用 ' + used + '%';
      if (wk.resetsAt && !wk.estimated && wk.usedPercent > 0) {
        const win = (wk.windowMinutes || 10080) * 60000, start = wk.resetsAt - win, el = t - start;
        if (el > 3 * 3600e3) {
          const proj = start + el / (wk.usedPercent / 100);
          if (proj < wk.resetsAt - 3600e3) return { warn: true, text: '按当前速度，预计 ' + weekStamp(proj) + ' 用完' };
        }
      }
      return { warn: false, text: head + ' · 节奏正常' };
    }
    if (fh) return fh.usedPercent >= 100 && !fh.estimated ? { warn: true, text: (fh.label || '5 小时') + '额度已用完' + (fh.resetsAt ? ' · ' + stamp(fh.resetsAt) + ' 恢复' : '') } : { warn: false, text: (fh.label || '5 小时') + '已用 ' + Math.round(fh.usedPercent) + '%' };
    return null;
  }
  function quotaHTML(src) {
    const plan = V.plans[src] || '未识别', q = V.quota[src];
    const connection = V.connections?.[src];
    const head = '<div class="quota" tabindex="0"><div class="qt"><b>' + NAME[src] + '</b><span>' + esc(plan) + '</span>';
    if (!q || (!q.fiveHour && !q.weekly)) {
      return head + '<span class="pct none">暂未读到额度</span></div><p class="qnone">' + (src === 'claude' ? 'Claude 打开状态栏同步后可显示百分比' : !V.tools.codex ? '没有找到 Codex 程序' : '暂未取得账户额度') + '</p>' +
        (connection?.error ? '<button class="lnk qsrc" type="button" data-quota-error="codex">查看读取原因</button>' : '') + '</div>';
    }
    const rem = remain(src), p = pace(q);
    const origin = src === 'codex' ? '<' + (connection?.error ? 'button type="button" class="lnk qsrc" data-quota-error="codex"' : 'p class="qsrc"') + '>' +
      (q.source === 'account' && connection?.status !== 'fallback' ? '实时账户' : '历史读数') + ' · ' + hm(q.observedAt) + (connection?.error ? ' · 查看读取原因</button>' : '</p>') : '';
    return head + '<span class="pct">' + rem + '%<small>' + esc(remainingLabel(src)) + '</small></span></div>' +
      '<div class="bars">' + barRow(q.fiveHour?.label || '5 小时', q.fiveHour, '5h', q.source==='account' ? '账户未返回' : '暂无数据') + barRow(q.weekly?.label || '本周', q.weekly, 'wk', q.source==='account' ? '账户未返回' : '暂无数据') + '</div>' +
      (p ? '<p class="pace' + (p.warn ? ' warn' : '') + '"><i class="dot"></i>' + esc(p.text) + '</p>' : '') +
      (q.source === 'inferred' ? '<p class="qsrc">根据限额提示推断</p>' : origin) + '</div>';
  }
  function renderQuotas() {
    const el = $('#quotas');
    put(el, V ? quotaHTML('codex') + quotaHTML('claude') : '', 'quotas');
  }

  /* ---------- 会话列表 ---------- */
  const counts = () => V ? { wait: pending().length, sent: V.sent.length, skip: V.sessions.filter(s => !s.auto && !s.send).length } : { wait: 0, sent: 0, skip: 0 };
  const tabsEl = $('#tabs'), ind = $('.ind', tabsEl);
  function moveInd(anim) {
    const b = $('[aria-selected="true"]', tabsEl); if (!b) return;
    if (!anim) ind.style.transition = 'none';
    ind.style.width = b.offsetWidth + 'px';
    ind.style.transform = 'translateX(' + b.offsetLeft + 'px)';
    if (!anim) { void ind.offsetWidth; ind.style.transition = ''; }
  }
  function renderTabs() {
    const c = counts();
    $$('[role=tab]', tabsEl).forEach(b => {
      const em = $('em', b), v = String(c[b.dataset.tab]);
      if (em.textContent !== v) {
        em.textContent = v;
        if (prevCounts && !reduce) { em.classList.remove('bump'); void em.offsetWidth; em.classList.add('bump'); }
      }
    });
    prevCounts = c;
    moveInd(true);
  }
  function setTab(t, fade = true) {
    ui.tab = t; ui.listLock = false; ui.pendingList = false;
    $$('[role=tab]', tabsEl).forEach(b => { const on = b.dataset.tab === t; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    moveInd(true); renderList(fade, true);
  }

  const emptyHTML = (b, p) => '<p class="empty"><b>' + b + '</b>' + p + '</p>';
  function pillHTML(s) {
    return '<button class="pill" type="button" aria-pressed="' + s.auto + '" data-act="toggle" title="' + (s.auto ? '到点自动发送“继续”，点一下改为跳过' : '已跳过，点一下改为自动继续') + '">' +
      '<span class="pl a">' + CHECK + '<span class="t">' + (s.auto ? '自动继续' : '跳过') + '</span></span></button>';
  }
  function statHTML(r) {
    const t = '<span class="num">' + hms(r.at) + '</span>';
    if (r.status === 'simulated') return '<span class="stat sim" title="演练：只记录了命令，没有真的发送">已演练 ' + t + '</span>';
    if (r.status === 'sent') {
      const phase=r.progress?.phase,labels={starting:'正在连接',submitting:'正在投递',waiting_response:'等待模型回复',delivered:'桌面已收信',responding:'模型正在回复',retrying:'连接重试中'};
      return '<span class="stat pending" title="'+esc(sendExplanation(r))+'">'+(labels[phase]||'等待续接确认')+' '+t+'</span>';
    }
    if(r.status==='unconfirmed')return '<button class="stat pending" type="button" data-act="details">'+(r.deliveredAt?'已送达 · 待回复':'投递待核对')+'</button>';
    if (r.status === 'resumed') return '<span class="stat">已接上'+(r.source==='claude'?(r.transport==='claude-desktop'?' · 桌面':' · CLI'):'')+' ' + CHECK + '</span>';
    const session = V.sessions.find(s=>s.key===r.key);
    const retry = !V.config.dryRun && session?.auto && session.recoverAt && session.recoverAt<=nowMs() && !r.retryPending && (r.retryable!==false || r.errorCode==='desktop_unavailable');
    return '<span class="stat bad">' + (r.retryPending ? '等待重试' : '失败') + '</span>' + (retry ? '<button class="btn g sm" type="button" data-act="retry">重试</button>' : '');
  }
  function sendExplanation(r) {
    if(r.error)return r.error;
    const seconds=Math.max(0,Math.floor((nowMs()-r.at)/1000));
    if(r.progress?.phase==='retrying')return '连接失败，正在重试'+(r.progress.httpStatus?' · HTTP '+r.progress.httpStatus:'')+'；已等待 '+seconds+' 秒，尚未确认模型回复。';
    if(r.status==='sent')return r.deliveredAt?'消息已进入原 Claude 桌面会话，正在等待模型回复。':'正在连接'+(r.transport==='claude-desktop'?'原 Claude 桌面会话':' CLI')+'；已等待 '+seconds+' 秒。';
    return '';
  }
  function rowHTML(o) {
    const open = ui.expanded.has(ui.tab + '|' + o.key);
    return '<div class="task' + (o.skip ? ' skip' : '') + (open ? ' open' : '') + '" data-key="' + esc(o.key) + '">' +
      '<div class="tx"><h4 title="' + esc(o.title) + '">' + esc(o.title) + '</h4><div class="meta">' + o.meta + '</div>' +
      (o.why ? '<p class="why' + (o.bad ? ' bad' : '') + '" title="' + esc(o.why) + '">' + esc(o.why) + '</p>' : '') + '</div>' +
      '<div class="acts"><button class="btn g sm cmdbtn" type="button" data-act="cmd" aria-expanded="' + open + '" aria-label="查看到点会执行的命令" title="查看命令">' + TERM + '</button>' + o.right + '</div>' +
      '<div class="cmd"' + (open ? '' : ' inert') + '><div><div class="cmd-in"><code title="' + esc(o.cmd) + '">' + esc(o.cmd) + '</code><button class="btn g sm" type="button" data-act="copy">复制命令</button></div></div></div></div>';
  }
  const chip = src => '<span class="src ' + src + '">' + SRC[src] + '</span>';
  const project = p => p ? '<span class="pj" title="' + esc(p) + '">' + esc(p) + '</span>' : '';
  function sessionRow(s) {
    const due = s.auto && s.recoverAt != null && s.recoverAt <= nowMs();
    return rowHTML({
      key: s.key, title: s.title, skip: !s.auto, cmd: s.command, right: pillHTML(s),
      meta: chip(s.source) + '<span><b class="num">' + stamp(s.blockedAt) + '</b> 中断</span>' + project(s.project) + (due ? '<span class="due">已到点，马上发送</span>' : ''),
      why: s.auto ? '' : REASON[s.reason] || '已手动跳过',
    });
  }
  function listHTML() {
    if (!V) return emptyHTML('暂时没有数据', '连上 Claudex 服务后会显示被额度卡住的会话');
    if (ui.tab === 'wait') {
      const byKey = new Map(V.sessions.map(s => [s.key, s]));
      let h = '';
      for (const g of V.groups) {
        const rows = g.keys.map(k => byKey.get(k)).filter(Boolean);
        if (!rows.length) continue;
        h += '<div class="grp">' + (g.at != null ? '<b>' + stamp(g.at) + '</b>' : '<b class="uk">恢复时间未知</b>') + '<span>· ' + SRC[g.source] + '</span><em>（' + rows.length + '）</em></div>' + rows.map(sessionRow).join('');
      }
      return h || emptyHTML('没有等待继续的会话', V.config.dryRun ? '因额度中断的会话会在这里排队，演练模式仅记录续接命令。' : '因额度中断的会话会在这里排队，可逐个选择是否自动继续。');
    }
    if (ui.tab === 'sent') {
      return V.sent.map(r => rowHTML({
        key: r.key, title: r.title, cmd: r.command, right: statHTML(r),
        meta: chip(r.source) + project(r.project) + '',
        why: sendExplanation(r), bad: r.status==='failed',
      })).join('') || emptyHTML('还没有发送记录', '额度恢复后，Claudex 自动发出的继续会记录在这里');
    }
    return V.sessions.filter(s => !s.auto && !s.send).map(sessionRow).join('') || emptyHTML('没有跳过的会话', '续跑类会话、恢复已过去太久的会话，以及你手动跳过的会话，会放在这里');
  }
  function renderList(fade, force) {
    if (ui.listLock) { ui.pendingList = true; return; }
    const list = $('#list'), html = listHTML();
    if (!force && cache.get('list') === html) return;
    cache.set('list', html);
    const top = list.scrollTop, a = document.activeElement;
    const focus = a && list.contains(a) && a.closest('.task') ? { k: a.closest('.task').dataset.key, act: a.dataset.act } : null;
    list.innerHTML = html;
    list.scrollTop = fade ? 0 : top;
    list.classList.remove('fadein');
    if (fade && !reduce) { void list.offsetWidth; list.classList.add('fadein'); }
    if (focus) { const el = $$('.task', list).find(r => r.dataset.key === focus.k); const b = el && $('[data-act="' + focus.act + '"]', el); if (b) b.focus({ preventScroll: true }); }
  }
  function leaveRow(row, done) {
    if (reduce) { done(); return; }
    row.style.height = row.offsetHeight + 'px'; row.style.overflow = 'hidden';
    void row.offsetHeight;
    row.classList.add('leave'); row.style.height = '0px';
    setTimeout(done, 290);
  }
  async function toggleSession(row, pill) {
    if (pill.dataset.busy) return;
    const s = V.sessions.find(x => x.key === row.dataset.key); if (!s) return;
    const want = !s.auto, hadFocus = document.activeElement === pill;
    pill.dataset.busy = '1'; ui.listLock = true;
    pill.setAttribute('aria-pressed', String(want)); $('.t', pill).textContent = want ? '自动继续' : '跳过';
    row.classList.toggle('skip', !want);
    if (want && !reduce) { pill.classList.remove('draw'); void pill.offsetWidth; pill.classList.add('draw'); }
    const req = request('/api/session', { key: s.key, auto: want });
    await wait(reduce ? 0 : 230);
    const r = await req;
    if (!r.ok) {
      ui.listLock = false; ui.pendingList = false; cache.delete('list'); renderList(false, true);
      const back = $$('.task', $('#list')).find(x => x.dataset.key === s.key);
      flashErr(back ? $('.pill', back) : $('#list'), r.err);
      return;
    }
    const next = row.nextElementSibling && row.nextElementSibling.classList.contains('task') ? row.nextElementSibling.dataset.key : null;
    leaveRow(row, () => {
      ui.listLock = false; ui.pendingList = false; cache.delete('list'); renderList(false, true);
      if (hadFocus) {
        const nr = next && $$('.task', $('#list')).find(x => x.dataset.key === next);
        (nr ? $('.pill', nr) : $('[aria-selected="true"]', tabsEl)).focus({ preventScroll: true });
      }
    });
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch {}
    ta.remove(); return ok;
  }
  $('#list').addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); const row = e.target.closest('.task'); if (!b || !row) return;
    if (b.dataset.act === 'toggle') toggleSession(row, b);
    else if (b.dataset.act === 'retry') {
      if (b.disabled) return;
      b.disabled=true;b.textContent='提交中…';
      const result=await request('/api/send-now',{keys:[row.dataset.key]});
      if (!result.ok) {b.disabled=false;b.textContent='重试';flashErr(b,result.err);}
    }
    else if(b.dataset.act==='details') {
      const send=V.sent.find(item=>item.key===row.dataset.key);
      if(send)showDetail('续接状态',sendExplanation(send));
    }
    else if (b.dataset.act === 'cmd') {
      const k = ui.tab + '|' + row.dataset.key, open = !row.classList.contains('open');
      row.classList.toggle('open', open); b.setAttribute('aria-expanded', String(open));
      $('.cmd', row).toggleAttribute('inert', !open);
      open ? ui.expanded.add(k) : ui.expanded.delete(k);
      cache.set('list', listHTML());
    } else if (b.dataset.act === 'copy') {
      const ok = await copyText($('code', row).textContent);
      if (!ok) { flashErr(b, '复制失败，请手动选中命令'); return; }
      b.textContent = '已复制'; clearTimeout(b._t); b._t = setTimeout(() => { b.textContent = '复制命令'; }, 1400);
    }
  });
  tabsEl.addEventListener('click', e => { const b = e.target.closest('[role=tab]'); if (b && b.dataset.tab !== ui.tab) setTab(b.dataset.tab); });
  tabsEl.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tabs = $$('[role=tab]', tabsEl), i = tabs.findIndex(b => b.dataset.tab === ui.tab);
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setTab(n.dataset.tab); n.focus(); e.preventDefault();
  });

  /* ---------- 右栏：继续内容、发送设置、记录 ---------- */
  let editor = null;
  function renderCard() {
    if (editor) return;
    const c = $('#card'), message = V ? V.config.message : DEFAULT_MSG;
    const chars = Array.from(message);
    const preview = chars.length > 64 ? chars.slice(0, 60).join('') + '…' : message;
    put(c, '<div class="t"><span class="mark"></span><b>续接消息</b><button class="btn g sm" type="button" data-act="edit"' + (V ? '' : ' disabled') + '>' +
      (chars.length > 64 ? '全文与编辑' : '编辑') + '</button></div><p class="txt">' + esc(preview) + '</p>', 'card');
  }
  function openEditor() {
    if (!V || editor) return;
    editor = document.createElement('dialog');
    editor.className = 'detail-dialog'; editor.setAttribute('aria-labelledby', 'edit-title');
    editor.innerHTML = '<div class="t"><h3 id="edit-title">编辑续接消息</h3><span class="count num" id="cnt"></span></div>' +
      '<textarea id="ta" maxlength="' + MAX_MSG + '" aria-label="继续内容"></textarea>' +
      '<div class="row"><button class="btn g sm" type="button" data-act="reset">恢复默认</button><button class="btn g sm" type="button" data-act="cancel-edit">取消</button><button class="btn p sm" type="button" data-act="save" id="saveBtn">保存</button></div>';
    $('#card').appendChild(editor); $('#ta').value = V.config.message; updCount();
    editor.addEventListener('cancel', e => { e.preventDefault(); closeEdit(); });
    editor.showModal(); $('#ta').focus();
  }
  function updCount() {
    const ta = $('#ta'), n = ta.value.length, cnt = $('#cnt');
    cnt.textContent = n + ' / ' + MAX_MSG; cnt.classList.toggle('full', n >= MAX_MSG);
    $('#saveBtn').disabled = !ta.value.trim();
  }
  function closeEdit() {
    if (!editor) return;
    editor.close(); editor.remove(); editor = null; renderCard();
    $('[data-act="edit"]', $('#card'))?.focus({ preventScroll: true });
  }
  $('#card').addEventListener('click', async e => {
    const a = e.target.closest('[data-act]'); if (!a || !V) return;
    if (a.dataset.act === 'edit') openEditor();
    else if (a.dataset.act === 'cancel-edit') closeEdit();
    else if (a.dataset.act === 'reset') { $('#ta').value = DEFAULT_MSG; updCount(); $('#ta').focus(); }
    else if (a.dataset.act === 'save') {
      const v = $('#ta').value.trim(); if (!v) return;
      if (v === V.config.message) { closeEdit(); return; }
      a.disabled = true; a.textContent = '保存中…';
      const r = await request('/api/config', { message: v });
      if (r.ok) closeEdit();
      else { a.disabled = false; a.textContent = '保存'; flashErr(a, r.err); }
    }
  });
  $('#card').addEventListener('input', e => { if (e.target.id === 'ta') updCount(); });

  function renderSettings() {
    if (!V) return;
    const g = V.config.staggerSeconds;
    $('#gapLabel').textContent = innerHeight<=560?'发送间隔':gapText(g);
    $('#gapLabel').title=gapText(g);
    $$('#gapSeg button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.gap === g)));
    setSwitch($('#swRetry'), V.config.retry);
  }
  addEventListener('resize',()=>{if(V)renderSettings();});
  const history = $('.log');
  $('#quotas').after(history);
  const logTitle = history.querySelector('h3');
  const logHead = document.createElement('div');
  logHead.className = 'log-head'; history.prepend(logHead); logHead.append(logTitle);
  const logNav = document.createElement('div');
  logNav.className = 'log-nav'; logNav.hidden = true;
  logNav.innerHTML = '<button class="btn g sm" type="button" data-log="newer" aria-label="较新的记录">‹</button><output aria-label="记录页码"></output><button class="btn g sm" type="button" data-log="older" aria-label="较早的记录">›</button>';
  logHead.append(logNav);
  let historyAt = null;
  logNav.addEventListener('click', e => {
    const step = e.target.closest('[data-log]')?.dataset.log;
    if (!step || !V?.log.length) return;
    const i = Math.max(0, V.log.findIndex(l => l.at === historyAt));
    const item = V.log[i + (step === 'older' ? 1 : -1)];
    if (item) { historyAt = item === V.log[0] ? null : item.at; renderLog(); }
  });
  function renderLog() {
    const logs = V?.log || [];
    const index = Math.max(0, logs.findIndex(l => l.at === historyAt));
    const l = logs[index];
    logNav.hidden = logs.length < 2;
    $('output', logNav).value = (index + 1) + ' / ' + logs.length;
    $('[data-log="newer"]', logNav).disabled = index === 0;
    $('[data-log="older"]', logNav).disabled = index >= logs.length - 1;
    if (!l) { put($('#log'), '<div class="it none">还没有发送记录</div>', 'log'); return; }
    const failed = l.count - l.ok;
    const active = l.items?.filter(r => ['sent','unconfirmed'].includes(r.status)).length || 0;
    const body = l.mode === 'dry' ? '演练 · 已记录 ' + l.count + ' 条继续请求'
      : failed ? l.count + ' 条继续请求 · <span class="bad">' + failed + ' 个失败</span>'
      : active ? '处理 ' + l.count + ' 条继续 · ' + active + ' 个等待确认'
      : '已向 ' + l.count + ' 个会话发送继续 · <span class="ok">全部接上</span>';
    const changed = put($('#log'), '<div class="it"><b>' + dayStamp(l.at) + '</b>' + body + '</div>', 'log');
    if (changed && index === 0 && lastLogAt != null && l.at > lastLogAt && !reduce) $('#log .it').classList.add('new');
    lastLogAt = logs[0].at;
  }

  /* ---------- 独立连接测试：明确点击才向专用测试会话真实发送 ---------- */
  const detailDialog = document.createElement('dialog');
  detailDialog.className = 'detail-dialog';
  detailDialog.setAttribute('aria-labelledby', 'detail-title');
  detailDialog.innerHTML = '<h3 id="detail-title"></h3><p></p><div class="row"><button class="btn p sm" type="button">关闭</button></div>';
  document.body.append(detailDialog);
  $('button', detailDialog).addEventListener('click', () => detailDialog.close());
  function showDetail(title, message) {
    $('#detail-title').textContent = title; $('p', detailDialog).textContent = message;
    detailDialog.showModal();
  }
  $('#bMsg').addEventListener('click', e => {
    if (e.target.closest('[data-details="scan"]') && V?.lastError) showDetail('检测错误详情', V.lastError);
  });
  $('#quotas').addEventListener('click', e => {
    const source=e.target.closest('[data-quota-error]')?.dataset.quotaError;
    if (source && V?.connections?.[source]?.error) showDetail('额度读取原因',V.connections[source].error);
  });
  const connectionEl = document.createElement('div');
  connectionEl.className = 'connection'; connectionEl.id = 'connection';
  $('.set').appendChild(connectionEl);
  function renderConnection() {
    if (!V) return;
    const d = V.diagnostics?.codex || { status: 'idle' };
    const busy = d.status === 'running';
    const elapsed = d.startedAt ? ((d.finishedAt || nowMs()) - d.startedAt) / 1000 : 0;
    const text = busy ? '正在等待回复 · ' + Math.max(0, Math.floor(elapsed)) + ' 秒'
      : d.status === 'success' ? 'Codex 已回复 · ' + (d.elapsedMs / 1000).toFixed(1) + ' 秒'
      : d.status === 'failed' ? '测试未通过' : '尚未测试';
    put(connectionEl, '<div class="connection-head"><h3>Codex 连接</h3><span class="connection-status ' + (d.status === 'success' ? 'ok' : d.status === 'failed' ? 'bad' : '') + '"' + (busy ? ' aria-live="off"' : ' role="status"') + '>' + esc(text) + '</span></div>' +
      '<div class="connection-actions"><button class="sw" type="button" role="switch" aria-checked="' + (V.config.codex?.useSystemProxy !== false) + '" id="proxySwitch"' + (busy ? ' disabled' : '') + '><i></i>跟随系统代理</button><button class="btn g sm" type="button" id="testCodex"' + (busy || !V.tools.codex ? ' disabled' : '') + '>' + (busy ? '测试中…' : '试发 Codex') + '</button></div>' +
      '<p class="connection-hint">试发会向专用测试会话发送真实消息。</p>' +
      (d.status === 'failed' ? '<button type="button" class="lnk connection-error" data-details="connection">查看失败原因</button>' : '')+
      '<div class="desktop-connection"><b>Claude 桌面</b><span>'+(V.claudeDesktop?.connected?V.claudeDesktop.connected+' 个会话已接入':V.claudeDesktop?.installed?'接入已安装 · 等待会话启动':'尚未接入')+'</span><button class="lnk" type="button" id="claudeIntegration">'+(V.claudeDesktop?.installed?'接入说明':'启用本地接入')+'</button></div>', 'connection');
  }
  connectionEl.addEventListener('click', async e => {
    const button = e.target.closest('button'); if (!button || !V) return;
    if (button.dataset.details === 'connection') {
      showDetail('Codex 连接失败', V.diagnostics?.codex?.error || '请检查 Codex 登录与网络后重试');
    } else if(button.id==='claudeIntegration') {
      showIntegration();
    } else if (button.id === 'proxySwitch') {
      button.disabled = true;
      await setConfig({ codex: { useSystemProxy: V.config.codex?.useSystemProxy === false } }, button);
    } else if (button.id === 'testCodex') {
      button.disabled = true; button.textContent = '正在启动…';
      const status = $('.connection-status', connectionEl);
      status.className = 'connection-status'; status.textContent = '正在启动测试…';
      cache.delete('connection');
      const r = await request('/api/test-codex', {});
      if (!r.ok) { flashErr(button, r.err); renderConnection(); }
    }
  });
  async function showIntegration() {
    let preview;
    try {const response=await fetch('/api/claude-integration',{signal:AbortSignal.timeout(8000)});preview=await response.json();if(!response.ok)throw new Error(preview.error);}
    catch(error){showDetail('Claude 接入',error.message||'无法读取接入设置');return;}
    if(preview.alreadyInstalled){showDetail('Claude 桌面接入已安装','新启动或恢复的会话会自动接入。已经运行但尚未接入的会话，需要重新启动该会话进程。投递通过原桌面会话处理，消息送达与模型回复分别确认。');return;}
    const dialog=document.createElement('dialog');dialog.className='detail-dialog';
    dialog.innerHTML='<h3>启用 Claude 桌面接入</h3><p>将为 Claude 添加一个 SessionStart 钩子，让 Claudex 能向已登录的原桌面会话发送续接消息。会先备份设置，并保留已有条目。</p><p class="integration-path"></p><p>新启动或恢复的会话接入后生效。</p><div class="row"><button class="btn g sm" data-integration="cancel">取消</button><button class="btn p sm" data-integration="install">备份并安装接入</button></div>';
    $('.integration-path',dialog).textContent=preview.file+'\n'+preview.command;
    document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});
    dialog.addEventListener('click',async event=>{
      const action=event.target.closest('[data-integration]');if(!action)return;
      if(action.dataset.integration==='cancel')return dialog.close();
      action.disabled=true;action.textContent='正在安装…';
      const result=await request('/api/claude-integration/install',{expectedHash:preview.expectedHash});
      if(result.ok){dialog.close();showDetail('本地接入已安装','设置已备份。请重新启动尚未接入的 Claude 会话，让本地投递生效。');}
      else {action.disabled=false;action.textContent='备份并安装接入';flashErr(action,result.err);}
    });
    dialog.showModal();$('[data-integration="cancel"]',dialog).focus();
  }

  /* ---------- 开关与分段 ---------- */
  const flip = el => el.getAttribute('aria-checked') !== 'true';
  function bindSwitch(id, key) {
    $(id).addEventListener('click', e => {
      if (!V) return;
      const el = e.currentTarget, v = flip(el);
      setSwitch(el, v); setConfig({ [key]: v }, el);
    });
  }
  bindSwitch('#swAuto', 'autoSend'); bindSwitch('#swNotify', 'notify'); bindSwitch('#swRetry', 'retry');
  $('#intervalSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !V || +b.dataset.min === V.config.intervalMinutes) return;
    $$('#intervalSeg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    setConfig({ intervalMinutes: +b.dataset.min }, b);
  });
  $('#gapSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !V || +b.dataset.gap === V.config.staggerSeconds) return;
    $$('#gapSeg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    setConfig({ staggerSeconds: +b.dataset.gap }, b);
  });

  async function doCheck(btn) {
    if (ui.checkBusy) return;
    ui.checkBusy = true; renderChk();
    const main = $('#checkNow'), old = btn && btn.textContent;
    [main, btn].filter(Boolean).forEach(b => { b.classList.add('spin'); b.setAttribute('aria-busy', 'true'); });
    if (btn) btn.textContent = '重试中…';
    const [r] = await Promise.all([request('/api/check', {}), wait(reduce ? 0 : 500)]);
    ui.checkBusy = false;
    [main, btn].filter(Boolean).forEach(b => { b.classList.remove('spin'); b.removeAttribute('aria-busy'); });
    if (btn && btn.isConnected) btn.textContent = old;
    renderChk();
    if (!r.ok) flashErr(btn && btn.isConnected ? btn : main, r.err);
  }
  $('#checkNow').addEventListener('click', () => doCheck());
  $('#bMsg').addEventListener('click', e => { const r = e.target.closest('#retry'); if (r) (V ? doCheck(r) : refresh()); });
  $('#sendNow').addEventListener('click', async e => {
    const btn = e.currentTarget; if (btn.disabled || !V) return;
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    const r = await request('/api/send-now', {});
    btn.removeAttribute('aria-busy');
    if (!r.ok) flashErr(btn, r.err);
    renderCtrl();
  });

  /* ---------- 套餐下拉 ---------- */
  let pop = null;
  const planBtn = $('#planEdit');
  planBtn.setAttribute('aria-haspopup', 'dialog'); planBtn.setAttribute('aria-expanded', 'false');
  function closePlans(focus) {
    if (!pop) return;
    pop.remove(); pop = null; planBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outsidePlans, true);
    if (focus) planBtn.focus();
  }
  function outsidePlans(e) { if (pop && !pop.contains(e.target) && !planBtn.contains(e.target)) closePlans(); }
  function openPlans() {
    if (pop) { closePlans(true); return; }
    if (!V) return;
    pop = document.createElement('div');
    pop.className = 'pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', '更改套餐');
    const group = src => {
      const cur = V.config.plans[src] || null;
      const list = PLANS[src].slice(); if (cur && !list.includes(cur)) list.unshift(cur);
      const opt = (val, label, on) => '<button type="button" role="radio" aria-checked="' + on + '" data-src="' + src + '" data-val="' + esc(val) + '" tabindex="' + (on ? 0 : -1) + '"><span>' + label + '</span>' + CHECK + '</button>';
      const auto = opt('', '自动识别' + (!cur && V.plans[src] ? ' <small>' + esc(V.plans[src]) + '</small>' : ''), !cur);
      return '<div><h3 id="pg-' + src + '">' + NAME[src] + '</h3><div class="opts" role="radiogroup" aria-labelledby="pg-' + src + '">' +
        list.map(p => opt(p, esc(p), p === cur)).join('') + auto + '</div></div>';
    };
    pop.innerHTML = group('claude') + group('codex');
    document.body.appendChild(pop);
    const r = planBtn.getBoundingClientRect();
    pop.style.top = r.bottom + 8 + 'px'; pop.style.left = Math.max(12, Math.min(innerWidth - pop.offsetWidth - 12, r.left)) + 'px';
    planBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outsidePlans, true);
    ($('[aria-checked="true"]', pop) || $('[role=radio]', pop)).focus();
  }
  planBtn.addEventListener('click', openPlans);
  document.addEventListener('click', e => {
    const o = e.target.closest && e.target.closest('.pop [role=radio]'); if (!o) return;
    const src = o.dataset.src, val = o.dataset.val || null;
    closePlans(true);
    if ((V.config.plans[src] || null) !== val) setConfig({ plans: { [src]: val } }, planBtn);
  });
  document.addEventListener('keydown', e => {
    if (!pop || !pop.contains(document.activeElement)) return;
    const k = e.key;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(k)) return;
    const groups = $$('.opts', pop), cur = document.activeElement, gi = groups.findIndex(g => g.contains(cur));
    if (gi < 0) return;
    const opts = $$('[role=radio]', groups[gi]), i = opts.indexOf(cur);
    let t;
    if (k === 'ArrowDown') t = opts[(i + 1) % opts.length];
    else if (k === 'ArrowUp') t = opts[(i + opts.length - 1) % opts.length];
    else if (k === 'Home') t = opts[0];
    else if (k === 'End') t = opts[opts.length - 1];
    else { const og = $$('[role=radio]', groups[(gi + 1) % groups.length]); t = og[Math.min(i, og.length - 1)]; }
    t.focus(); e.preventDefault();
  });

  /* ---------- 开启真实发送：确认框 ---------- */
  const band = $('#band');
  const dryEl = document.createElement('div');
  dryEl.className = 'dry'; dryEl.id = 'dry'; dryEl.hidden = true;
  const bandFoot = document.createElement('div');
  bandFoot.className = 'band-foot';
  bandFoot.append(dryEl, $('.ctrl', band)); band.append(bandFoot);
  let dlg = null;
  const PAGE = ['header', 'main', 'section.body'];
  function closeConfirm() {
    if (!dlg) return;
    dlg.remove(); dlg = null;
    PAGE.forEach(s => $(s).removeAttribute('inert'));
    document.removeEventListener('keydown', trapKeys, true);
    const b = $('#dryBtn'); if (b) b.focus();
  }
  function trapKeys(e) {
    if (!dlg) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeConfirm(); return; }
    if (e.key !== 'Tab') return;
    const f = $$('button:not([disabled]), [tabindex="0"]', dlg); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!dlg.contains(document.activeElement)) { first.focus(); e.preventDefault(); }
    else if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  }
  function openConfirm() {
    if (dlg || !V) return;
    const pend = pending();
    const missing = ['codex', 'claude'].filter(s => !V.tools[s] && pend.some(x => x.source === s)).map(s => NAME[s]);
    const dueN = dueNow().length, demoN = V.sent.filter(r => r.status === 'simulated').length;
    const items = pend.map(s => '<div class="ci"><div class="tt">' + chip(s.source) + '<span class="t" title="' + esc(s.title) + '">' + esc(s.title) + '</span></div><code title="' + esc(s.command) + '">' + esc(s.command) + '</code></div>').join('');
    dlg = document.createElement('div');
    dlg.className = 'scrim';
    dlg.innerHTML = '<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlgT" aria-describedby="dlgD">' +
      '<h3 id="dlgT">开启真实发送？</h3>' +
      '<p id="dlgD">开启后，到点会在后台执行下面列出的 codex / claude 命令，让这些会话接着跑。</p>' +
      (V.config.codex?.inheritSandbox ? '<p class="warnline">Codex 将沿用原会话的沙箱模式；原本为完全访问的会话，可以在后台修改文件、运行命令。</p><p>此设置仅沿用沙箱模式，其他权限由 Codex 当前配置决定；无法识别原模式时，使用命令行默认设置。</p>' : '') +
      (items ? '<div class="cmds" tabindex="0" role="group" aria-label="将要执行的命令">' + items + '</div>' : '<p><b>现在没有等待发送的会话。</b>开启后，之后因额度中断的会话，到点会直接按设置发送。</p>') +
      '<p>建议先在 <button type="button" class="lnk" data-act="peek">“已发送”</button> 里看过演练记录再开' + (demoN ? '。' : '（现在还没有演练记录）。') + '</p>' +
      (dueN ? '<p>其中 ' + dueN + ' 个会话额度已经恢复，' + (V.config.autoSend ? '开启后会立即检查并安排发送。' : '打开自动发送后才会安排发送。') + '</p>' : '') +
      (missing.length ? '<p class="warnline">没有找到 ' + esc(missing.join('、')) + ' 的命令行程序，对应会话到点会发送失败。</p>' : '') +
      '<p>' + gapText(V.config.staggerSeconds) + '；失败' + (V.config.retry ? '自动重试 1 次' : '不重试') + '。随时可以切回演练。</p>' +
      '<div class="foot"><button type="button" class="btn g" data-act="cancel">取消</button><button type="button" class="btn p" data-act="confirm">开启真实发送</button></div></div>';
    document.body.appendChild(dlg);
    PAGE.forEach(s => $(s).setAttribute('inert', ''));
    document.addEventListener('keydown', trapKeys, true);
    dlg.addEventListener('mousedown', e => { if (e.target === dlg) closeConfirm(); });
    dlg.addEventListener('click', async e => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      if (a.dataset.act === 'cancel') closeConfirm();
      else if (a.dataset.act === 'peek') { closeConfirm(); setTab('sent'); }
      else if (a.dataset.act === 'confirm') {
        a.disabled = true; a.textContent = '正在开启…';
        const r = await request('/api/config', { dryRun: false });
        if (r.ok) closeConfirm();
        else if (dlg) { a.disabled = false; a.textContent = '开启真实发送'; flashErr(a, r.err); }
      }
    });
    $('[data-act="cancel"]', dlg).focus();
  }
  dryEl.addEventListener('click', e => {
    const a = e.target.closest('[data-act]'); if (!a || !V) return;
    if (a.dataset.act === 'go-real') openConfirm();
    else if (a.dataset.act === 'go-dry') setConfig({ dryRun: true }, a);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && pop && !dlg) closePlans(true); });

  /* ---------- 总渲染与定时 ---------- */
  function renderAll(fade) {
    renderChk(); renderPlans(); renderInterval();
    renderBand(fade); renderSwitches(); renderCtrl(); renderDry();
    renderQuotas(); renderTabs(); renderList(false); renderCard(); renderSettings(); renderLog();
    renderConnection();
  }
  setInterval(() => {
    if (!V) return;
    tickCd(); updRuler(); updNext(); renderCtrl();
    if (V.diagnostics?.codex?.status === 'running') renderConnection();
    const dk = derivedKey();
    if (dk !== ui.dk) { ui.dk = dk; renderBand(true); renderDry(); renderTabs(); renderList(false); }
    if (!polling && nowMs() > V.nextCheckAt + 1500 && Date.now() - lastTry > 4000) refresh();
  }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  addEventListener('resize', () => moveInd(false));

  /* ---------- 初始化 ---------- */
  document.body.classList.remove('first');
  document.body.classList.add('loading');
  const t3 = $('[data-tab="done"]', tabsEl);
  t3.dataset.tab = 'skip'; t3.childNodes[0].textContent = '已跳过 ';
  $$('[role=tab]', tabsEl).forEach(b => { const on = b.dataset.tab === ui.tab; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
  renderCard();
  moveInd(false);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => moveInd(false));
  refresh();
})();
