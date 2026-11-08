(() => {
  if (document.documentElement.dataset.mode === 'live') return; /* 实时模式由 live.js 接管 */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pad = n => String(n).padStart(2, '0');
  const hm = s => pad(Math.floor(s / 3600) % 24) + ':' + pad(Math.floor(s / 60) % 60);
  const hms = s => hm(s) + ':' + pad(s % 60);
  const T = (h, m, s = 0) => h * 3600 + m * 60 + s;
  const wait = ms => new Promise(r => setTimeout(r, ms));

  const DEFAULT_MSG = '额度已恢复，请从刚才中断的地方继续完成原来的任务。只做原任务范围内的事，不要扩大范围。';
  const SRC = { codex: 'Codex', claude: 'Claude Code' };
  const GROUP_AT = { codex: '16:10', claude: '17:20' };
  const CHECK = '<svg class="ck" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.5"/></svg>';

  const params = new URLSearchParams(location.search);
  let state = params.get('state');
  if (!['waiting', 'sent', 'clear', 'error'].includes(state)) state = 'waiting';

  const sessions = [
    { id: 1, src: 'codex', title: '重构支付回调的重试逻辑', repo: 'shop-api', at: '14:05', step: 3, total: 5 },
    { id: 2, src: 'codex', title: '给 mirage 补齐端到端测试', repo: 'mirage', at: '14:22', step: 2, total: 4 },
    { id: 3, src: 'codex', title: '把 Token 查看器迁移到 Vite 6', repo: 'token-viewer', at: '14:40', step: 1, total: 3 },
    { id: 4, src: 'codex', title: '修复 Windows 路径大小写导致的缓存失效', repo: 'claudex', at: '15:02', step: 4, total: 6 },
    { id: 5, src: 'claude', title: '整理 Claudex 的额度解析模块', repo: 'claudex', at: '15:12', step: 2, total: 4 },
    { id: 6, src: 'claude', title: '给 prompt-refiner 动画补字幕', repo: 'prompt-refiner', at: '15:20', step: 1, total: 3 },
  ].map(s => ({ ...s, on: true, status: 'wait', sentAt: null }));
  const DONE = [
    { src: 'claude', title: '为 Claudex 托盘图标加暗色模式', repo: 'claudex', at: '13:48' },
    { src: 'codex', title: '修正 shop-api 的时区换算', repo: 'shop-api', at: '12:31' },
    { src: 'codex', title: '升级 mirage 依赖并修复类型错误', repo: 'mirage', at: '11:05' },
  ];
  const baseLogs = [{ when: '今天 10:02', n: 3 }, { when: '今天 03:00', n: 2 }];

  const S = {
    state, el: 0, interval: 5, auto: true, notify: true, gap: 30, retry: true,
    msg: DEFAULT_MSG, editing: false, sim: false, checking: false,
    tab: state === 'sent' ? 'sent' : 'wait',
    base: T(15, 32), cdTarget: T(15, 32) + 38 * 60 + 12, frozen: 38 * 60 + 12,
    last: '15:30', next: 168, logs: baseLogs.slice(),
  };
  if (state === 'sent') {
    S.base = T(16, 12); S.cdTarget = T(17, 20); S.last = '16:10'; S.next = 180;
    sessions.filter(s => s.src === 'codex').forEach((s, i) => { s.status = 'sent'; s.sentAt = hms(T(16, 10, 2) + i * S.gap); });
    S.logs.unshift({ when: '今天 16:10', n: 4 });
  }
  if (state === 'clear') sessions.forEach(s => (s.status = 'none'));
  const clock = () => S.base + S.el;
  const rec = () => S.state === 'sent' || S.sim;
  const count = st => sessions.filter(s => s.status === st).length;
  document.body.dataset.state = state;

  /* ---------- helpers ---------- */
  function swap(el, html, fade) {
    if (!fade || reduce) { el.innerHTML = html; return; }
    el.classList.add('out');
    setTimeout(() => { el.innerHTML = html; el.classList.remove('out'); el.classList.remove('in'); void el.offsetWidth; el.classList.add('in'); }, 140);
  }
  const mmss = s => { s = Math.max(0, s); return [pad(Math.floor(s / 60)), pad(s % 60)]; };

  /* ---------- header check status ---------- */
  function renderChk() {
    const el = $('#chk');
    el.classList.toggle('bad', S.state === 'error');
    if (S.checking) { el.innerHTML = '<i class="dot"></i>正在检测…'; return; }
    const nx = '<b class="num" id="next">' + mmss(S.next).join(':') + '</b>';
    el.innerHTML = S.state === 'error'
      ? '<i class="dot"></i><span class="bd">' + S.last + ' 检测失败</span> · 下次 ' + nx
      : '<i class="dot"></i>' + S.last + ' 已检测 · 下次 ' + nx;
  }

  /* ---------- band ---------- */
  function renderKick() {
    let h;
    if (S.state === 'error') h = '<span class="tag">检测失败</span>上次结果 · 距离 Codex 额度恢复还有';
    else if (S.state === 'clear') h = '<span class="tag ok">两边额度都够用</span>目前没有被卡住的会话';
    else if (rec()) {
      const n = count('sent'), tot = sessions.filter(s => s.src === 'codex').length;
      h = '<span class="tag ok">' + (S.sim ? 'Codex 已恢复 · 正在发送 ' + n + '/' + tot : 'Codex 已恢复 · 已自动发送 ' + n + ' 条继续') + '</span>距离 Claude 17:20 恢复还有';
    } else h = '<span class="tag">Codex 已用完</span>距离 Codex 额度恢复还有';
    $('#kick').innerHTML = h;
  }
  function renderCd() {
    const cd = $('#cd');
    cd.classList.toggle('stale', S.state === 'error');
    if (S.state === 'clear') {
      cd.innerHTML = '<span class="cdg"><span>54%</span><small>Claude 剩余</small></span>';
      return;
    }
    const [m, s] = mmss(S.state === 'error' ? S.frozen : S.cdTarget - clock());
    cd.innerHTML = '<span class="cdg"><span id="cdm">' + m + '</span><small>分</small></span><span class="cdg"><span>:</span><small>&nbsp;</small></span><span class="cdg"><span id="cds">' + s + '</span><small>秒</small></span>';
  }
  function etaCount() {
    const src = rec() ? 'claude' : 'codex';
    return sessions.filter(s => s.src === src && s.status === 'wait' && s.on).length;
  }
  function etaHTML() {
    const r = rec(), t = r ? '17:20' : '16:10', nm = r ? 'Claude' : 'Codex', n = etaCount();
    if (!S.auto) return '<em>' + t + '</em> ' + nm + ' 恢复后<br>只通知你，不自动发送';
    if (!n) return '<em>' + t + '</em> ' + nm + ' 恢复，<br>所有会话都已设为跳过';
    return '<em>' + t + '</em> ' + nm + ' 恢复，<br>自动给 <em>' + n + '</em> 个会话发送继续';
  }
  function barsMsg() {
    if (S.state === 'error') {
      return '<p class="eta"><em>' + S.last + '</em> 检测失败<br>无法读取 Codex 额度</p>' +
        '<p class="reason">Codex 登录已过期，重新登录后会自动恢复检测</p>' +
        '<div class="errbtn"><button class="btn p" type="button" id="retry">重试</button></div>';
    }
    if (S.state === 'clear') {
      return '<p class="eta">没有被卡住的会话</p><p class="sub">一旦中断，额度恢复后会自动发送继续</p>' +
        '<div class="ruler"><div class="mrow"><span>Codex 剩余</span><span class="rail"><i style="width:65%"></i></span><b>65%</b></div>' +
        '<div class="mrow"><span>Claude 剩余</span><span class="rail"><i style="width:54%"></i></span><b>54%</b></div></div>';
    }
    const r = rec();
    const sub = r
      ? '<span class="num">16:10</span> Codex 已恢复 · 已发送 <span class="num" id="subN">' + count('sent') + '</span> 条继续'
      : '<span class="num">17:20</span> Claude 恢复 · ' + sessions.filter(s => s.src === 'claude').length + ' 个会话';
    const a = r ? '15:12' : '14:05', b = r ? '17:20' : '16:10';
    return '<p class="eta" id="eta">' + etaHTML() + '</p><p class="sub">' + sub + '</p>' +
      '<div class="ruler"><div class="rail"><i id="rI"></i><u id="rU"></u></div>' +
      '<div class="ticks"><span><b>' + a + '</b> 用完</span><span>现在 <b id="rNow"></b></span><span><b>' + b + '</b> 恢复</span></div></div>';
  }
  function updRuler() {
    const i = $('#rI'); if (!i) return;
    const r = rec();
    const a = r ? T(15, 12) : T(14, 5), b = r ? T(17, 20) : S.cdTarget;
    const p = Math.min(100, Math.max(0, (clock() - a) / (b - a) * 100));
    i.style.width = p + '%'; $('#rU').style.left = p + '%'; $('#rNow').textContent = hm(clock());
  }
  function renderCtrl() {
    const hint = $('#sendHint');
    hint.textContent = S.state === 'error' ? '检测恢复后才能发送' : S.state === 'clear' ? '没有等待发送的会话' : rec() ? 'Claude 恢复后才能发送' : '额度恢复后才能发送';
  }
  function renderBand(fade) {
    renderKick(); renderCd(); renderCtrl();
    swap($('#bMsg'), barsMsg(), fade);
    if (fade && !reduce) setTimeout(updRuler, 150); else updRuler();
  }

  /* ---------- quotas ---------- */
  function quotaHTML(name, plan, q) {
    return '<div class="quota" tabindex="0"><div class="qt"><b>' + name + '</b><span>' + plan + '</span><span class="pct">' + q.rem + '%<small>剩余</small></span></div>' +
      '<div class="bars"><span>5 小时</span><span class="trk ' + (q.used5 >= 100 ? 'out' : '') + '"><i style="width:' + q.used5 + '%"></i></span><span class="r">' + q.l5 + '</span>' +
      '<span>本周</span><span class="trk"><i style="width:' + q.week + '%"></i></span><span class="r">周一 08:00 重置</span></div>' +
      '<p class="pace ' + (q.warn ? 'warn' : '') + '"><i class="dot"></i>已用 ' + q.week + '% · ' + q.pace + '</p></div>';
  }
  function renderQuotas() {
    const clear = S.state === 'clear', r = rec();
    const cx = clear ? { rem: 65, used5: 35, l5: '已用 35%' }
      : r ? { rem: 100, used5: 0, l5: '已恢复 16:10' } : { rem: 0, used5: 100, l5: '16:10 恢复' };
    const cl = clear ? { rem: 54, used5: 46, l5: '已用 46%' } : { rem: 0, used5: 100, l5: '17:20 恢复' };
    Object.assign(cx, { week: 88, warn: true, pace: '按本周速度，周日 21:00 用完' });
    Object.assign(cl, { week: 52, warn: false, pace: '节奏正常' });
    $('#quotas').innerHTML = quotaHTML('Codex', 'ChatGPT Pro', cx) + quotaHTML('Claude', 'Max 5x', cl);
  }

  /* ---------- tabs & list ---------- */
  const tabsEl = $('#tabs'), ind = $('.ind', tabsEl);
  function moveInd(anim) {
    const b = $('[aria-selected="true"]', tabsEl);
    if (!anim) ind.style.transition = 'none';
    ind.style.width = b.offsetWidth + 'px';
    ind.style.transform = 'translateX(' + b.offsetLeft + 'px)';
    if (!anim) { void ind.offsetWidth; ind.style.transition = ''; }
  }
  function updateTabs(bump = []) {
    const c = { wait: count('wait'), sent: count('sent'), done: 7 };
    $$('[role=tab]', tabsEl).forEach(b => {
      const em = $('em', b), v = String(c[b.dataset.tab]);
      if (em.textContent !== v) {
        em.textContent = v;
        if (bump.includes(b.dataset.tab) && !reduce) { em.classList.remove('bump'); void em.offsetWidth; em.classList.add('bump'); }
      }
    });
    moveInd(true);
  }
  function stepsHTML(s) {
    let h = '';
    for (let i = 1; i <= s.total; i++) h += '<i class="' + (i < s.step ? 'd' : i === s.step ? 'x' : '') + '"></i>';
    return '<span class="steps">' + h + '</span><span class="num">' + s.step + '/' + s.total + '</span>';
  }
  function pillHTML(s) {
    const sent = s.status === 'sent';
    return '<button class="pill' + (sent ? ' sent' : '') + '" type="button" aria-pressed="' + s.on + '" data-id="' + s.id + '">' +
      '<span class="pl a">' + CHECK + '<span class="t">' + (s.on ? '自动继续' : '跳过') + '</span></span>' +
      '<span class="pl b"><span>已发送 <span class="num ts">' + (s.sentAt || '') + '</span></span>' + CHECK + '<span>已接上</span></span></button>';
  }
  function rowHTML(s) {
    return '<div class="task' + (s.on ? '' : ' skip') + '" data-id="' + s.id + '"><div class="tx"><h4 title="' + s.title + '">' + s.title + '</h4>' +
      '<div class="meta"><span class="src ' + s.src + '">' + SRC[s.src] + '</span><span><b class="num" style="font-weight:400">' + s.at + '</b> 中断</span><span>' + s.repo + '</span>' + stepsHTML(s) + '</div></div>' +
      '<div class="acts"><button class="btn g sm open" type="button">打开</button>' + pillHTML(s) + '</div></div>';
  }
  const emptyHTML = (b, p) => '<p class="empty"><b>' + b + '</b>' + p + '</p>';
  function renderList(fade) {
    const list = $('#list'); let h = '';
    if (S.tab === 'wait') {
      ['codex', 'claude'].forEach(src => {
        const rows = sessions.filter(s => s.src === src && s.status === 'wait');
        if (!rows.length) return;
        h += '<div class="grp"><b>' + GROUP_AT[src] + '</b><span>· ' + SRC[src] + '</span><em>（' + rows.length + '）</em></div>' + rows.map(rowHTML).join('');
      });
      if (!h) h = emptyHTML('没有被卡住的会话', '额度够用时 Claudex 只在后台检测；一旦有会话因额度中断，会在这里排队，额度恢复后自动发送继续');
    } else if (S.tab === 'sent') {
      h = sessions.filter(s => s.status === 'sent').map(rowHTML).join('') ||
        emptyHTML('还没有发送记录', '额度恢复后，Claudex 自动发出的继续会记录在这里');
    } else {
      h = DONE.map(d => '<div class="task"><div class="tx"><h4>' + d.title + '</h4><div class="meta"><span class="src ' + d.src + '">' + SRC[d.src] + '</span><span><b class="num" style="font-weight:400">' + d.at + '</b> 完成</span><span>' + d.repo + '</span></div></div><div class="acts"><button class="btn g sm" type="button">查看</button></div></div>').join('');
    }
    list.innerHTML = h;
    list.classList.remove('fadein');
    if (fade && !reduce) { void list.offsetWidth; list.classList.add('fadein'); }
  }
  function setTab(t, fade = true) {
    S.tab = t;
    $$('[role=tab]', tabsEl).forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
    moveInd(true); renderList(fade);
  }
  tabsEl.addEventListener('click', e => {
    const b = e.target.closest('[role=tab]');
    if (b && b.dataset.tab !== S.tab) setTab(b.dataset.tab);
  });
  $('#list').addEventListener('click', e => {
    const p = e.target.closest('button.pill');
    if (!p || p.classList.contains('sent')) return;
    const s = sessions.find(x => x.id === +p.dataset.id);
    s.on = !s.on;
    p.setAttribute('aria-pressed', s.on);
    $('.t', p).textContent = s.on ? '自动继续' : '跳过';
    p.closest('.task').classList.toggle('skip', !s.on);
    if (s.on && !reduce) { p.classList.remove('draw'); void p.offsetWidth; p.classList.add('draw'); }
    const eta = $('#eta'); if (eta) eta.innerHTML = etaHTML();
  });

  /* ---------- card, settings, log ---------- */
  function renderCard() {
    const c = $('#card');
    document.body.classList.toggle('editing', S.editing);
    if (!S.editing) {
      c.innerHTML = '<div class="t"><span class="mark"></span><b>将要发送的“继续”</b><button class="btn g sm" type="button" data-act="edit">编辑</button></div><p class="txt">' + S.msg + '</p>';
      return;
    }
    c.innerHTML = '<div class="t"><span class="mark"></span><b>编辑内容</b><span class="count num" id="cnt"></span></div>' +
      '<textarea id="ta" maxlength="200" aria-label="继续内容"></textarea>' +
      '<div class="row"><button class="btn p sm" type="button" data-act="save" id="saveBtn">保存</button><button class="btn g sm" type="button" data-act="reset">恢复默认</button></div>';
    const ta = $('#ta'); ta.value = S.msg; updCount(); ta.focus();
  }
  function updCount() {
    const ta = $('#ta'), n = ta.value.length;
    const cnt = $('#cnt'); cnt.textContent = n + ' / 200'; cnt.classList.toggle('full', n >= 200);
    $('#saveBtn').disabled = !ta.value.trim();
  }
  $('#card').addEventListener('click', e => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    if (a.dataset.act === 'edit') { S.editing = true; renderCard(); }
    else if (a.dataset.act === 'save') { S.msg = $('#ta').value.trim(); S.editing = false; renderCard(); }
    else if (a.dataset.act === 'reset') { $('#ta').value = DEFAULT_MSG; updCount(); $('#ta').focus(); }
  });
  $('#card').addEventListener('input', e => { if (e.target.id === 'ta') updCount(); });
  $('#card').addEventListener('keydown', e => { if (e.key === 'Escape' && S.editing) { S.editing = false; renderCard(); } });

  function renderGap() {
    $('#gapLabel').textContent = S.gap === 0 ? '同时发送，不留间隔' : '逐个发送，间隔 ' + (S.gap === 30 ? '30 秒' : '2 分钟');
    $$('#gapSeg button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.gap === S.gap));
  }
  $('#gapSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { S.gap = +b.dataset.gap; renderGap(); } });
  function renderLog(newFirst) {
    $('#log').innerHTML = S.logs.slice(0, 2).map((l, i) =>
      '<div class="it' + (newFirst && i === 0 ? ' new' : '') + '"><b>' + l.when + '</b>向 ' + l.n + ' 个会话发送继续，<span class="ok">全部接上</span></div>').join('');
  }

  /* ---------- switches ---------- */
  function flip(el) { const v = el.getAttribute('aria-checked') !== 'true'; el.setAttribute('aria-checked', v); return v; }
  $('#swAuto').addEventListener('click', e => { S.auto = flip(e.currentTarget); swap($('#bMsg'), barsMsg(), true); setTimeout(updRuler, reduce ? 0 : 150); });
  $('#swNotify').addEventListener('click', e => { S.notify = flip(e.currentTarget); });
  $('#swRetry').addEventListener('click', e => { S.retry = flip(e.currentTarget); });

  /* ---------- check ---------- */
  function renderInterval() {
    $$('#intervalSeg button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.min === S.interval));
    $('#qNote').textContent = '每 ' + S.interval + ' 分钟更新';
  }
  $('#intervalSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.interval = +b.dataset.min; S.next = S.interval * 60; renderInterval(); renderChk();
  });
  function doCheck(btn) {
    if (S.checking) return;
    S.checking = true; renderChk();
    const main = $('#checkNow');
    [main, btn].filter(Boolean).forEach(b => { b.classList.add('spin'); b.setAttribute('aria-busy', 'true'); });
    const old = btn && btn.textContent; if (btn) btn.textContent = '重试中…';
    setTimeout(() => {
      S.checking = false; S.last = hm(clock()); S.next = S.interval * 60;
      [main, btn].filter(Boolean).forEach(b => { b.classList.remove('spin'); b.removeAttribute('aria-busy'); });
      renderChk();
      if (S.state === 'error') renderBand(true);
    }, 1000);
  }
  $('#checkNow').addEventListener('click', () => doCheck());
  $('#bMsg').addEventListener('click', e => { const r = e.target.closest('#retry'); if (r) doCheck(r); });

  /* ---------- tick ---------- */
  setInterval(() => {
    S.el++;
    if (S.state !== 'clear' && S.state !== 'error') {
      const [m, s] = mmss(S.cdTarget - clock());
      const a = $('#cdm'), b = $('#cds'); if (a) a.textContent = m; if (b) b.textContent = s;
    }
    updRuler();
    if (!S.checking) { S.next--; if (S.next <= 0) doCheck(); else { const n = $('#next'); if (n) n.textContent = mmss(S.next).join(':'); } }
  }, 1000);

  /* ---------- recovery playback ---------- */
  window.claudexSimulateRecovery = async function () {
    if (S.state !== 'waiting' || S.sim) return;
    S.sim = true;
    if (S.editing) { S.editing = false; renderCard(); }
    if (S.tab !== 'wait') setTab('wait');
    S.base = T(16, 10) - S.el; S.cdTarget = T(17, 20);
    S.last = '16:10'; S.next = S.interval * 60;
    renderChk(); renderQuotas(); renderBand(true);
    const step = reduce ? 0 : 600;
    const rows = sessions.filter(s => s.src === 'codex' && s.status === 'wait' && s.on);
    let i = 0;
    for (const s of rows) {
      await wait(step || 50);
      s.status = 'sent'; s.sentAt = hms(T(16, 10, 2) + i * S.gap); i++;
      const p = $('.pill[data-id="' + s.id + '"]');
      if (p) { $('.ts', p).textContent = s.sentAt; p.classList.add('sent'); p.classList.remove('draw'); }
      updateTabs(['sent', 'wait']);
      renderKick();
      const sn = $('#subN'); if (sn) sn.textContent = count('sent');
    }
    await wait(step ? 900 : 50);
    S.sim = false; S.state = 'sent';
    document.body.dataset.state = 'sent';
    history.replaceState(null, '', '?state=sent');
    if (rows.length) S.logs.unshift({ when: '今天 16:10', n: rows.length });
    renderBand(true); renderQuotas(); renderLog(true); updateTabs();
    setTab('sent');
  };

  /* ---------- init ---------- */
  $$('[role=tab]', tabsEl).forEach(b => b.setAttribute('aria-selected', b.dataset.tab === S.tab));
  renderInterval(); renderGap(); renderChk(); renderBand(false); renderQuotas();
  renderCard(); renderLog(false); updateTabs(); renderList(false);
  moveInd(false);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => moveInd(false));
  addEventListener('resize', () => moveInd(false));
  setTimeout(() => document.body.classList.remove('first'), 1100);
})();
