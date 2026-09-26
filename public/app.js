'use strict';

// ---------------- 状态 ----------------
let state = { cues: [], schedule: [], conflicts: [], graphErrors: [] };
let editingId = null;
let fragment = null; // 当前片段预览结果
let fragmentStale = false; // 原提示单发生增删改后，旧预览失效
let deferPlan = null; // 当前顺延预演结果
let deferStale = false; // 提示单发生增删改后，旧预演失效（确认时服务端也会再核对版本）
let rehearsal = null; // 当前排练实况视图（null = 未开始）
let rehBusy = false; // 排练登记请求进行中，防重复提交
let rehLoadSeq = 0; // 丢弃因快速输入产生的过期响应

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---------------- 工具 ----------------
function fmtNum(s) {
  if (s === null || s === undefined) return '—';
  return Number(s).toFixed(3).replace(/\.?0+$/, '');
}
function scheduleById() {
  const m = new Map();
  for (const s of state.schedule) m.set(s.id, s);
  return m;
}
function cueName(id) {
  const c = state.cues.find((x) => x.id === id);
  return c ? c.name : `（已删除 ${id}）`;
}

// ---------------- API ----------------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `请求失败（${res.status}）`;
    const rawErrors =
      (data && data.error && (data.error.errors || data.error.reasons)) || [msg];
    const errors = rawErrors.map((x) => (typeof x === 'string' ? x : x.message));
    const e = new Error(msg);
    e.errors = errors;
    e.status = res.status;
    throw e;
  }
  return data;
}

async function reload(notice) {
  const data = await api('GET', '/api/cues');
  state = data;
  markFragmentStale();
  markDeferStale();
  render();
  await loadRehearsal();
  if (notice) showBanner(notice, 'ok');
}

// ---------------- 排练实况 ----------------
function currentClockAt() {
  const raw = $('#rehClock').value;
  if (String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

async function loadRehearsal() {
  const at = rehearsal ? currentClockAt() : null;
  const qs = at === null ? '' : `?at=${encodeURIComponent(at)}`;
  const seq = ++rehLoadSeq;
  const data = await api('GET', `/api/rehearsal${qs}`);
  if (seq !== rehLoadSeq) return; // 已被更新的请求取代
  rehearsal = data.active ? data.rehearsal : null;
  renderRehearsal();
}

function renderRehearsal() {
  const idle = $('#rehIdle');
  const active = $('#rehActive');
  if (!rehearsal) {
    idle.hidden = false;
    active.hidden = true;
    const hasUnresolved = state.graphErrors && state.graphErrors.length > 0;
    $('#rehIdleHint').textContent = hasUnresolved
      ? '⚠️ 当前提示单存在时间未定的提示，需先解决引用 / 循环依赖问题后才能开始。'
      : `共 ${state.cues.length} 条提示，开始后将冻结此刻的重算计划。`;
    return;
  }
  idle.hidden = true;
  active.hidden = false;

  const summary = $('#rehSummary');
  summary.innerHTML = '';
  summary.append(
    el('span', 'reh-stat', `已完成 ${rehearsal.doneCount}/${rehearsal.frozenCueCount}`),
    el('span', 'reh-stat', `进行中 ${rehearsal.runningCount}`),
    el('span', 'reh-stat', `未开始 ${rehearsal.pendingCount}`)
  );
  if (rehearsal.allDone) summary.append(el('span', 'pill ok', '🎉 本轮全部登记完成'));
  const started = new Date(rehearsal.startedAt);
  summary.append(el('span', 'reh-stat', `冻结于 ${started.toLocaleString()}`));

  const stale = $('#rehStale');
  if (rehearsal.versionMismatch) {
    stale.className = 'banner info';
    stale.textContent = '⚠️ 开始排练后原提示单已被增删改；本轮仍按冻结时的计划与提示执行，不受影响。重置后再开始才会使用最新提示单。';
    stale.classList.remove('hidden');
  } else {
    stale.classList.add('hidden');
  }

  const tbody = $('#rehTbody');
  tbody.innerHTML = '';
  const at = currentClockAt();

  rehearsal.items.forEach((item) => {
    const tr = el('tr');
    tr.classList.add(`reh-${item.status}`);
    tr.append(el('td', 'num', String(item.order + 1)));
    tr.append(el('td', 'name-cell', item.name));
    tr.append(el('td', null, item.channel));
    tr.append(el('td', null, rehStartDesc(item)));
    tr.append(el('td', 'num', fmtNum(item.plannedStart)));
    tr.append(el('td', 'num', fmtNum(item.plannedEnd)));
    tr.append(el('td', 'num', fmtNum(item.actualStart)));
    tr.append(el('td', 'num', fmtNum(item.actualEnd)));
    tr.append(el('td', 'num reh-delta', rehDeltaText(item.startDelta)));
    tr.append(el('td', 'num reh-delta', rehDeltaText(item.endDelta)));

    const statusTd = el('td');
    if (item.status === 'done') statusTd.append(el('span', 'pill ok', '✅ 已完成'));
    else if (item.status === 'running') statusTd.append(el('span', 'pill reh-run', '🔴 进行中'));
    else statusTd.append(el('span', 'pill unknown', '⏳ 未开始'));
    tr.append(statusTd);

    tr.append(rehActionCell(item, at));
    tbody.append(tr);
  });
}

function rehStartDesc(item) {
  if (item.startType === 'fixed') return `固定第 ${fmtNum(item.fixedAt)}s`;
  return `「${item.predecessorName || '（已删除）'}」结束 +${fmtNum(item.delayAfter)}s`;
}

function rehDeltaText(delta) {
  if (delta === null || delta === undefined) return '—';
  if (Math.abs(delta) <= 1e-6) return '0';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${fmtNum(delta)}s`;
}

function rehActionCell(item, at) {
  const td = el('td', 'reh-actions');

  if (item.status === 'done') {
    td.append(el('span', 'rel-muted', '—'));
    return td;
  }

  if (item.status === 'running') {
    const reasons = [];
    if (at === null) reasons.push('请在上方填写当前演出秒数');
    else if (at + 1e-9 < item.actualStart) {
      reasons.push(`结束秒数（${fmtNum(at)}s）不得早于开始秒数（${fmtNum(item.actualStart)}s）`);
    }
    const btn = el('button', 'btn small primary', `登记结束 @${at === null ? '?' : fmtNum(at)}s`);
    btn.type = 'button';
    btn.disabled = reasons.length > 0 || rehBusy;
    btn.title = '登记本提示的实际结束秒数';
    btn.addEventListener('click', () => submitRehearsalMark(item.cueId, 'end'));
    td.append(btn);
    if (reasons.length) {
      const ul = rehReasonList(reasons);
      td.append(ul);
    }
    return td;
  }

  // pending：未开始
  const clockMissing = at === null;
  const blockers = item.blockers || [];
  const btn = el('button', 'btn small primary', `登记开始 @${at === null ? '?' : fmtNum(at)}s`);
  btn.type = 'button';
  btn.disabled = clockMissing || blockers.length > 0 || rehBusy;
  btn.title = clockMissing ? '请先在上方填写当前演出秒数' : '登记本提示的实际开始秒数';
  btn.addEventListener('click', () => submitRehearsalMark(item.cueId, 'start'));
  td.append(btn);

  // 与秒数无关的阻止原因（前置未结束 / 本通道忙）即使未填秒数也展示
  const staticBlockers = blockers
    .filter((b) => b.code === 'predecessor_open' || b.code === 'channel_busy')
    .map((b) => b.message);
  if (staticBlockers.length) {
    td.append(rehReasonList(staticBlockers));
  } else if (clockMissing) {
    td.append(rehReasonList(['请在上方填写当前演出秒数']));
  } else if (blockers.length) {
    td.append(rehReasonList(blockers.map((b) => b.message)));
  }
  return td;
}

function rehReasonList(messages) {
  const ul = el('ul', 'reh-block');
  for (const m of messages) ul.append(el('li', null, `⛔ ${m}`));
  return ul;
}

function showRehError(message, messages) {
  const box = $('#rehError');
  box.className = 'banner err';
  box.innerHTML = '';
  box.append(el('strong', null, message));
  if (messages && messages.length) {
    const ul = el('ul');
    ul.style.margin = '6px 0 0';
    ul.style.paddingLeft = '18px';
    for (const m of messages) ul.append(el('li', null, m));
    box.append(ul);
  }
  box.classList.remove('hidden');
}
function hideRehError() {
  $('#rehError').classList.add('hidden');
}

async function submitRehearsalMark(cueId, kind) {
  const at = currentClockAt();
  if (at === null) return;
  rehBusy = true;
  hideRehError();
  renderRehearsal();
  try {
    await api('POST', `/api/rehearsal/cues/${encodeURIComponent(cueId)}/${kind}`, { at });
    await loadRehearsal();
  } catch (err) {
    const head = kind === 'start' ? '开始登记被阻止：' : '结束登记被拒绝：';
    showRehError(head, err.errors || [err.message]);
    await loadRehearsal(); // 仍刷新一次，保证状态一致
  } finally {
    rehBusy = false;
    renderRehearsal();
  }
}

async function startRehearsal() {
  const btn = $('#rehStartBtn');
  btn.disabled = true;
  try {
    await api('POST', '/api/rehearsal/start');
    hideRehError();
    await loadRehearsal();
    showBanner('已开始排练：当前提示与重算计划已冻结，可逐条登记实际开始 / 结束', 'ok');
  } catch (err) {
    // 开始失败时活动面板仍隐藏，错误通过顶部横幅展示
    const b = $('#banner');
    b.className = 'banner err';
    b.innerHTML = '';
    b.append(el('strong', null, '无法开始排练：'));
    const ul = el('ul');
    ul.style.margin = '6px 0 0';
    ul.style.paddingLeft = '18px';
    for (const m of err.errors || [err.message]) ul.append(el('li', null, m));
    b.append(ul);
    b.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

async function resetRehearsal() {
  if (!rehearsal) return;
  const ok = confirm(
    '确定重置本轮排练？\n\n' +
    '· 冻结计划与全部实际开始 / 结束登记都会被清除；\n' +
    '· 原提示单不会被修改；\n' +
    '· 再次「开始排练」将按当前最新提示单重新冻结。'
  );
  if (!ok) return;
  try {
    await api('POST', '/api/rehearsal/reset');
    rehearsal = null;
    $('#rehClock').value = '';
    hideRehError();
    renderRehearsal();
    showBanner('已重置本轮排练，可开始新一轮', 'ok');
  } catch (err) {
    showBanner(err.message, 'err');
  }
}

// ---------------- 顶部提示条 ----------------
let bannerTimer = null;
function showBanner(message, kind = 'info', sticky = false) {
  const b = $('#banner');
  b.className = `banner ${kind}`;
  b.innerHTML = '';
  b.append(el('span', null, message));
  b.classList.remove('hidden');
  clearTimeout(bannerTimer);
  if (!sticky) {
    bannerTimer = setTimeout(() => {
      b.classList.add('hidden');
      bannerTimer = null;
    }, 4000);
  }
}
function hideBanner() {
  $('#banner').classList.add('hidden');
}

// ---------------- 渲染：错误 / 冲突 ----------------
function renderErrors() {
  // 图错误（缺失引用、循环依赖）以粘性信息条显示
  const persistent = state.graphErrors || [];
  if (persistent.length) {
    const b = $('#banner');
    b.className = 'banner err';
    b.innerHTML = '';
    b.append(el('strong', null, '存在无法排期的问题：'));
    const ul = el('ul');
    ul.style.margin = '6px 0 0';
    ul.style.paddingLeft = '18px';
    for (const e of persistent) ul.append(el('li', null, e.message));
    b.append(ul);
    b.classList.remove('hidden');
  } else if (!bannerTimer) {
    hideBanner();
  }
}

function renderConflicts(conflictIds) {
  const panel = $('#conflictPanel');
  const list = $('#conflictList');
  list.innerHTML = '';
  if (!state.conflicts.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  for (const cf of state.conflicts) {
    const [a, b] = cf.cueIds;
    const li = el('li');
    li.append(el('span', 'tag', cf.channel));
    li.append(document.createTextNode(
      `「${cueName(a)}」与「${cueName(b)}」在 ${fmtNum(cf.start)}s – ${fmtNum(cf.end)}s 重叠（左闭右开）`
    ));
    const acts = el('span', 'conflict-actions');
    for (const id of [a, b]) {
      const btn = el('button', 'btn small', `顺延「${cueName(id)}」`);
      btn.type = 'button';
      btn.title = '预演把该提示顺推到本通道最早完整空位';
      btn.addEventListener('click', () => previewDeferral(id));
      acts.append(btn);
    }
    li.append(acts);
    list.append(li);
    conflictIds.add(a);
    conflictIds.add(b);
  }
}

// ---------------- 渲染：时间轴 ----------------
function niceStep(span) {
  const target = span / 10; // 期望约 10 格
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const n = target / pow;
  let mult;
  if (n < 1.5) mult = 1;
  else if (n < 3) mult = 2;
  else if (n < 7) mult = 5;
  else mult = 10;
  return mult * pow;
}

function renderTimeline(conflictIds, schedMap) {
  const root = $('#timeline');
  root.innerHTML = '';

  const good = state.cues
    .map((c) => ({ c, t: schedMap.get(c.id) }))
    .filter((x) => x.t && x.t.start !== null);

  if (!good.length) {
    root.append(el('div', 'tl-empty', '暂无可绘制的提示（新增一条，或先解决引用/循环问题）'));
    return;
  }

  const maxEnd = Math.max(...good.map((x) => x.t.end));
  const span = Math.max(maxEnd * 1.05, 1);
  const pct = (sec) => `${(sec / span) * 100}%`;
  const step = niceStep(span);

  // 按通道分组
  const channels = new Map();
  for (const c of state.cues) {
    if (!channels.has(c.channel)) channels.set(c.channel, []);
    channels.get(c.channel).push(c);
  }

  for (const [channel, cues] of [...channels].sort((a, b) => a[0].localeCompare(b[0]))) {
    const wrapEl = el('div', 'tl-channel');
    wrapEl.append(el('div', 'tl-channel-name', `🔌 ${channel}`));

    const track = el('div', 'tl-track');

    // 网格
    for (let g = 0; g <= span; g += step) {
      const line = el('div', 'tl-grid');
      line.style.left = pct(g);
      const lab = el('div', 'tl-grid-label', fmtNum(g));
      lab.style.left = '2px';
      line.append(lab);
      track.append(line);
    }

    // 冲突红色覆盖层（先放，块在其上）
    for (const cf of state.conflicts) {
      if (cf.channel !== channel) continue;
      const ov = el('div', 'tl-overlap');
      ov.style.left = pct(cf.start);
      ov.style.width = `${((cf.end - cf.start) / span) * 100}%`;
      ov.title = `冲突 ${fmtNum(cf.start)}s – ${fmtNum(cf.end)}s`;
      track.append(ov);
    }

    // 提示块
    for (const c of cues) {
      const t = schedMap.get(c.id);
      if (!t || t.start === null) continue;
      const b = el('div', 'tl-block' + (conflictIds.has(c.id) ? ' has-conflict' : ''));
      b.style.left = pct(t.start);
      b.style.width = pct(Math.max(t.end - t.start, 0.0001));
      b.textContent = c.name;
      b.title = `${c.name}\n${fmtNum(t.start)}s → ${fmtNum(t.end)}s（持续 ${fmtNum(c.duration)}s）`;
      b.addEventListener('click', () => startEdit(c.id));
      track.append(b);
    }

    wrapEl.append(track);

    // 该通道下时间未定的提示（引用缺失 / 在环上）
    const unresolved = cues.filter((c) => {
      const t = schedMap.get(c.id);
      return !t || t.start === null;
    });
    if (unresolved.length) {
      const urow = el('div', 'tl-unresolved');
      for (const c of unresolved) {
        const pill = el('button', 'unk-pill', `⏳ ${c.name}（时间未定）`);
        pill.type = 'button';
        pill.addEventListener('click', () => startEdit(c.id));
        urow.append(pill);
      }
      wrapEl.append(urow);
    }

    root.append(wrapEl);
  }

  // 统一时间标尺
  const scale = el('div', 'tl-scale');
  for (let g = 0; g <= span; g += step) {
    const lab = el('div', 'tl-grid-label', fmtNum(g));
    lab.style.left = pct(g);
    lab.style.transform = 'none';
    scale.append(lab);
  }
  root.append(scale);
}

// ---------------- 渲染：表格 ----------------
function startDesc(c) {
  if (c.startType === 'fixed') {
    return `固定第 ${fmtNum(c.fixedAt)}s`;
  }
  return `「${cueName(c.afterCueId)}」结束 +${fmtNum(c.delayAfter)}s`;
}

function renderTable(conflictIds) {
  const tbody = $('#cueTbody');
  tbody.innerHTML = '';
  const schedMap = scheduleById();

  state.cues.forEach((c, i) => {
    const t = schedMap.get(c.id);
    const tr = el('tr');
    if (conflictIds.has(c.id)) tr.classList.add('row-conflict');
    if (!t || t.start === null) tr.classList.add('row-error');

    tr.append(el('td', 'num', String(i + 1)));
    tr.append(el('td', 'name-cell', c.name));
    tr.append(el('td', null, c.channel));
    tr.append(el('td', 'num', fmtNum(c.duration)));
    tr.append(el('td', null, startDesc(c)));

    const startTd = el('td', 'num');
    const endTd = el('td', 'num');
    const statusTd = el('td');
    if (!t || t.start === null) {
      startTd.textContent = '—';
      endTd.textContent = '—';
      statusTd.append(el('span', 'pill unknown', '时间未定'));
    } else {
      startTd.textContent = fmtNum(t.start);
      endTd.textContent = fmtNum(t.end);
      if (conflictIds.has(c.id)) {
        statusTd.append(el('span', 'pill bad', '通道冲突'));
      } else {
        statusTd.append(el('span', 'pill ok', '正常'));
      }
    }

    const actTd = el('td');
    const actWrap = el('div', 'actions');
    const editBtn = el('button', 'btn small', '编辑');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => startEdit(c.id));
    const delBtn = el('button', 'btn small danger', '删除');
    delBtn.type = 'button';
    delBtn.addEventListener('click', () => removeCue(c));
    actWrap.append(editBtn, delBtn);
    actTd.append(actWrap);

    tr.append(startTd, endTd, statusTd, actTd);
    tbody.append(tr);
  });
}

// ---------------- 渲染总入口 ----------------
function render() {
  const schedMap = scheduleById();
  const conflictIds = new Set();
  renderConflicts(conflictIds);
  renderErrors();
  renderTimeline(conflictIds, schedMap);
  renderTable(conflictIds);
  renderAfterOptions();
  updateFormMode();
}

// ---------------- 表单 ----------------
function renderAfterOptions() {
  const sel = $('#f-afterCueId');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const c of state.cues) {
    if (c.id === editingId) continue; // 不能以自己为前置
    const opt = el('option', null, `${c.name}（${c.channel}）`);
    opt.value = c.id;
    sel.append(opt);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function getStartType() {
  return document.querySelector('input[name="startType"]:checked').value;
}

function syncStartBoxes() {
  const isAfter = getStartType() === 'after';
  $('#fixedBox').hidden = isAfter;
  $('#afterBox').hidden = !isAfter;
  $('#f-fixedAt').disabled = isAfter;
  $('#f-afterCueId').disabled = !isAfter;
  $('#f-delayAfter').disabled = !isAfter;
}

function updateFormMode() {
  $('#formTitle').textContent = editingId ? '✏️ 编辑提示' : '➕ 新增提示';
  $('#submitBtn').textContent = editingId ? '保存修改并重算' : '保存新增';
  $('#cancelEdit').hidden = !editingId;
}

function resetForm() {
  $('#cueForm').reset();
  editingId = null;
  $('#f-id').value = '';
  document.querySelector('input[name="startType"][value="fixed"]').checked = true;
  $('#f-fixedAt').value = '0';
  $('#f-delayAfter').value = '0';
  syncStartBoxes();
  renderAfterOptions();
  updateFormMode();
}

function startEdit(id) {
  const c = state.cues.find((x) => x.id === id);
  if (!c) return;
  editingId = id;
  $('#f-id').value = id;
  $('#f-name').value = c.name;
  $('#f-channel').value = c.channel;
  $('#f-duration').value = c.duration;
  document.querySelector(`input[name="startType"][value="${c.startType}"]`).checked = true;
  renderAfterOptions();
  if (c.startType === 'fixed') {
    $('#f-fixedAt').value = c.fixedAt;
  } else {
    $('#f-afterCueId').value = c.afterCueId;
    $('#f-delayAfter').value = c.delayAfter;
  }
  syncStartBoxes();
  updateFormMode();
  document.querySelector('.cue-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitForm(e) {
  e.preventDefault();
  const isAfter = getStartType() === 'after';
  const body = {
    name: $('#f-name').value,
    channel: $('#f-channel').value,
    duration: $('#f-duration').value,
    startType: getStartType(),
    fixedAt: isAfter ? 0 : $('#f-fixedAt').value,
    afterCueId: isAfter ? $('#f-afterCueId').value : null,
    delayAfter: isAfter ? $('#f-delayAfter').value : 0,
  };

  const btn = $('#submitBtn');
  btn.disabled = true;
  try {
    if (editingId) {
      await api('PUT', `/api/cues/${encodeURIComponent(editingId)}`, body);
    } else {
      await api('POST', '/api/cues', body);
    }
    const wasEditing = editingId;
    resetForm();
    await reload(wasEditing ? '已保存，后继提示已全部重算' : '已新增，时间轴已重算');
  } catch (err) {
    showBanner(err.errors.join('\n') || err.message, 'err');
    // 让多条错误换行
    const b = $('#banner');
    b.innerHTML = '';
    b.append(el('strong', null, '保存被拒绝：'));
    const ul = el('ul');
    ul.style.margin = '6px 0 0';
    ul.style.paddingLeft = '18px';
    for (const m of err.errors) ul.append(el('li', null, m));
    b.append(ul);
  } finally {
    btn.disabled = false;
  }
}

async function removeCue(c) {
  if (!confirm(`确定删除「${c.name}」？\n删除后所有后继提示会立即重算。`)) return;
  try {
    await api('DELETE', `/api/cues/${encodeURIComponent(c.id)}`);
    if (editingId === c.id) resetForm();
    await reload('已删除并重算');
  } catch (err) {
    showBanner(err.message, 'err');
  }
}

// ---------------- 片段排练单 ----------------
function showFragError(messages) {
  const box = $('#fragError');
  box.className = 'banner err';
  box.innerHTML = '';
  box.append(el('strong', null, '无法生成片段：'));
  const ul = el('ul');
  ul.style.margin = '6px 0 0';
  ul.style.paddingLeft = '18px';
  for (const m of [].concat(messages)) ul.append(el('li', null, m));
  box.append(ul);
  box.classList.remove('hidden');
}
function hideFragError() {
  $('#fragError').classList.add('hidden');
}

function markFragmentStale() {
  if (!fragment) return;
  fragmentStale = true;
  $('#frDownloadBtn').disabled = true;
  const meta = $('#fragMeta');
  if (meta) {
    meta.classList.add('stale');
    meta.textContent = '原提示单已变更，当前预览已失效，请重新生成预览。';
  }
}

function renderFragmentTimeline() {
  const root = $('#fragTimeline');
  root.innerHTML = '';

  const schedMap = new Map(fragment.schedule.map((s) => [s.id, s]));
  const conflictIds = new Set();
  for (const cf of fragment.conflicts) cf.cueIds.forEach((id) => conflictIds.add(id));

  const span = Math.max(fragment.duration * 1.05, 1);
  const pct = (sec) => `${(sec / span) * 100}%`;
  const step = niceStep(span);

  const channels = new Map();
  for (const c of fragment.cues) {
    if (!channels.has(c.channel)) channels.set(c.channel, []);
    channels.get(c.channel).push(c);
  }

  for (const [channel, cues] of [...channels].sort((a, b) => a[0].localeCompare(b[0]))) {
    const wrapEl = el('div', 'tl-channel');
    wrapEl.append(el('div', 'tl-channel-name', `🔌 ${channel}`));
    const track = el('div', 'tl-track');

    for (let g = 0; g <= span; g += step) {
      const line = el('div', 'tl-grid');
      line.style.left = pct(g);
      const lab = el('div', 'tl-grid-label', fmtNum(g));
      lab.style.left = '2px';
      line.append(lab);
      track.append(line);
    }
    for (const cf of fragment.conflicts) {
      if (cf.channel !== channel) continue;
      const ov = el('div', 'tl-overlap');
      ov.style.left = pct(cf.start);
      ov.style.width = `${((cf.end - cf.start) / span) * 100}%`;
      ov.title = `冲突 ${fmtNum(cf.start)}s – ${fmtNum(cf.end)}s`;
      track.append(ov);
    }
    for (const c of cues) {
      const t = schedMap.get(c.id);
      if (!t || t.start === null) continue;
      const b = el('div', 'tl-block' + (conflictIds.has(c.id) ? ' has-conflict' : ''));
      b.style.left = pct(t.start);
      b.style.width = pct(Math.max(t.end - t.start, 0.0001));
      b.textContent = c.name;
      b.title = `${c.name}\n${fmtNum(t.start)}s → ${fmtNum(t.end)}s（持续 ${fmtNum(c.duration)}s）`;
      track.append(b);
    }
    wrapEl.append(track);
    root.append(wrapEl);
  }

  const scale = el('div', 'tl-scale');
  for (let g = 0; g <= span; g += step) {
    const lab = el('div', 'tl-grid-label', fmtNum(g));
    lab.style.left = pct(g);
    lab.style.transform = 'none';
    scale.append(lab);
  }
  root.append(scale);
}

function fragStartDesc(c) {
  if (c.startType === 'fixed') return `固定第 ${fmtNum(c.fixedAt)}s`;
  const dep = fragment.cues.find((x) => x.id === c.afterCueId);
  const depName = dep ? dep.name : `（未入选 ${c.afterCueId}）`;
  return `「${depName}」结束 +${fmtNum(c.delayAfter)}s`;
}

function renderFragmentTable() {
  const tbody = $('#fragTbody');
  tbody.innerHTML = '';
  const schedMap = new Map(fragment.schedule.map((s) => [s.id, s]));
  const selMap = new Map(fragment.selections.map((s) => [s.cueId, s]));
  const conflictIds = new Set();
  for (const cf of fragment.conflicts) cf.cueIds.forEach((id) => conflictIds.add(id));
  const changeMap = new Map(fragment.changes.map((ch) => [ch.cueId, ch]));

  fragment.cues.forEach((c, i) => {
    const t = schedMap.get(c.id);
    const sel = selMap.get(c.id);
    const ch = changeMap.get(c.id);
    const tr = el('tr');
    if (conflictIds.has(c.id)) tr.classList.add('row-conflict');

    tr.append(el('td', 'num', String(i + 1)));
    tr.append(el('td', 'name-cell', c.name));
    tr.append(el('td', null, c.channel));
    tr.append(el('td', 'num', fmtNum(c.duration)));
    tr.append(el('td', null, fragStartDesc(c)));
    tr.append(el('td', 'num', fmtNum(t.start)));
    tr.append(el('td', 'num', fmtNum(t.end)));
    tr.append(el('td', 'num', `${fmtNum(sel.origStart)} – ${fmtNum(sel.origEnd)}`));

    const noteTd = el('td');
    if (ch) {
      const text = ch.reason === 'crosses_left'
        ? '跨左边界，已改为固定开始'
        : '前置未入选片段，已改为固定开始';
      noteTd.append(el('span', 'pill unknown', text));
    } else if (c.startType === 'after') {
      noteTd.append(el('span', 'rel-muted', '保留相对前置'));
    } else {
      noteTd.append(el('span', 'rel-muted', '固定开始'));
    }
    tr.append(noteTd);
    tbody.append(tr);
  });
}

function renderFragmentConflicts() {
  const panel = $('#fragConflictPanel');
  const list = $('#fragConflictList');
  list.innerHTML = '';
  if (!fragment.conflicts.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const nameOf = (id) => {
    const c = fragment.cues.find((x) => x.id === id);
    return c ? c.name : id;
  };
  for (const cf of fragment.conflicts) {
    const [a, b] = cf.cueIds;
    const li = el('li');
    li.append(el('span', 'tag', cf.channel));
    li.append(document.createTextNode(
      `「${nameOf(a)}」与「${nameOf(b)}」在 ${fmtNum(cf.start)}s – ${fmtNum(cf.end)}s 重叠（左闭右开）`
    ));
    list.append(li);
  }
}

function renderFragment() {
  const box = $('#fragResult');
  if (!fragment) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const { start, end } = fragment.window;
  const fixedCount = fragment.changes.length;
  const meta = $('#fragMeta');
  meta.className = 'frag-meta' + (fragmentStale ? ' stale' : ' ok');
  meta.textContent =
    `原窗口 [${fmtNum(start)}, ${fmtNum(end)})（长 ${fmtNum(fragment.duration)}s）` +
    `｜入选 ${fragment.selectedCount} / ${fragment.totalCount} 条` +
    `｜${fixedCount} 条改为固定开始` +
    `｜冲突 ${fragment.conflicts.length} 处` +
    (fragmentStale ? '｜⚠️ 原提示单已变更，本预览已失效，请重新生成' : '');

  renderFragmentTimeline();
  renderFragmentConflicts();
  renderFragmentTable();
  $('#frDownloadBtn').disabled = fragmentStale;
}

async function previewFragment(e) {
  e.preventDefault();
  const body = {
    start: $('#fr-start').value,
    end: $('#fr-end').value,
  };
  const btn = $('#frPreviewBtn');
  btn.disabled = true;
  try {
    fragment = await api('POST', '/api/fragments/preview', body);
    fragmentStale = false;
    hideFragError();
    renderFragment();
  } catch (err) {
    fragment = null;
    $('#fragResult').hidden = true;
    $('#frDownloadBtn').disabled = true;
    showFragError(err.errors || [err.message]);
  } finally {
    btn.disabled = false;
  }
}

function downloadFragment() {
  if (!fragment || fragmentStale) return;
  const blob = new Blob([JSON.stringify(fragment.document, null, 2) + '\n'], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const { start, end } = fragment.window;
  const fmt = (n) => fmtNum(n).replace(/\./g, '-');
  a.href = url;
  a.download = `cue-fragment_${fmt(start)}-${fmt(end)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------- 冲突顺延预演 ----------------
function showDeferError(messages) {
  const panel = $('#deferPanel');
  panel.hidden = false;
  $('#deferResult').hidden = true;
  const box = $('#deferError');
  box.className = 'banner err';
  box.innerHTML = '';
  box.append(el('strong', null, '无法预演顺延：'));
  const ul = el('ul');
  ul.style.margin = '6px 0 0';
  ul.style.paddingLeft = '18px';
  for (const m of [].concat(messages)) ul.append(el('li', null, m));
  box.append(ul);
  box.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearDefer() {
  deferPlan = null;
  deferStale = false;
  $('#deferPanel').hidden = true;
  $('#deferResult').hidden = true;
  $('#deferError').classList.add('hidden');
}

function markDeferStale() {
  if (!deferPlan) return;
  deferStale = true;
  $('#deferConfirmBtn').disabled = true;
  const meta = $('#deferMeta');
  if (meta) {
    meta.classList.add('stale');
    meta.textContent = '提示单已变更，本预演已失效，请重新从冲突面板发起预演。';
  }
}

function deferConflictItems(listEl, items) {
  listEl.innerHTML = '';
  for (const cf of items) {
    const [a, b] = cf.cueIds;
    const li = el('li');
    li.append(el('span', 'tag', cf.channel));
    li.append(document.createTextNode(
      `「${cueName(a)}」与「${cueName(b)}」在 ${fmtNum(cf.start)}s – ${fmtNum(cf.end)}s 重叠（左闭右开）`
    ));
    listEl.append(li);
  }
}

function renderDefer() {
  const panel = $('#deferPanel');
  panel.hidden = false;
  $('#deferError').classList.add('hidden');
  $('#deferResult').hidden = false;

  const t = deferPlan.target;
  const adj = deferPlan.adjust;
  const meta = $('#deferMeta');
  meta.className = 'frag-meta' + (deferStale ? ' stale' : ' ok');
  if (!deferPlan.changed) {
    meta.textContent = `「${t.name}」（${deferPlan.channel}）当前位置已无冲突，无需顺延。`;
  } else {
    const how = adj.field === 'fixedAt'
      ? `固定开始 ${fmtNum(adj.from)}s → ${fmtNum(adj.to)}s`
      : `相对延迟 +${fmtNum(adj.from)}s → +${fmtNum(adj.to)}s（增加 ${fmtNum(adj.delta)}s）`;
    meta.textContent =
      `「${t.name}」（${deferPlan.channel}）顺推到最早完整空位：` +
      `${fmtNum(t.oldStart)}s – ${fmtNum(t.oldEnd)}s → ${fmtNum(t.newStart)}s – ${fmtNum(t.newEnd)}s` +
      `｜${how}｜被顺延 ${deferPlan.moved.length} 条` +
      `｜新增冲突 ${deferPlan.conflictsAdded.length} 处｜消失冲突 ${deferPlan.conflictsRemoved.length} 处` +
      (deferStale ? '｜⚠️ 提示单已变更，预演失效' : '｜确认后才会写入');
  }

  const tbody = $('#deferTbody');
  tbody.innerHTML = '';
  for (const m of deferPlan.moved) {
    const tr = el('tr');
    tr.append(el('td', 'name-cell', m.name));
    tr.append(el('td', null, m.channel));
    tr.append(el('td', 'num', fmtNum(m.oldStart)));
    tr.append(el('td', 'num', fmtNum(m.oldEnd)));
    tr.append(el('td', 'num', fmtNum(m.newStart)));
    tr.append(el('td', 'num', fmtNum(m.newEnd)));
    const noteTd = el('td');
    noteTd.append(el('span', m.isTarget ? 'pill ok' : 'pill unknown',
      m.isTarget ? '目标提示（顺推）' : '后继随调度器重算'));
    tr.append(noteTd);
    tbody.append(tr);
  }

  const addedPanel = $('#deferAddedPanel');
  addedPanel.hidden = !deferPlan.conflictsAdded.length;
  deferConflictItems($('#deferAddedList'), deferPlan.conflictsAdded);

  const removedPanel = $('#deferRemovedPanel');
  removedPanel.hidden = !deferPlan.conflictsRemoved.length;
  deferConflictItems($('#deferRemovedList'), deferPlan.conflictsRemoved);

  $('#deferConfirmBtn').disabled = deferStale || !deferPlan.changed;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function previewDeferral(cueId) {
  try {
    deferPlan = await api('POST', '/api/deferrals/preview', { cueId });
    deferStale = false;
    renderDefer();
  } catch (err) {
    deferPlan = null;
    showDeferError(err.errors || [err.message]);
  }
}

async function confirmDeferral() {
  if (!deferPlan || deferStale || !deferPlan.changed) return;
  const btn = $('#deferConfirmBtn');
  btn.disabled = true;
  try {
    await api('POST', '/api/deferrals/confirm', {
      cueId: deferPlan.cueId,
      baseVersion: deferPlan.baseVersion,
    });
    clearDefer();
    await reload('已顺延并保存，后继提示已重算');
  } catch (err) {
    if (err.status === 409) {
      // 版本不一致：预演所依据的提示单已变化，要求重新预演
      deferStale = true;
      $('#deferConfirmBtn').disabled = true;
      const meta = $('#deferMeta');
      meta.classList.add('stale');
      meta.textContent = '提示单在预演后已变化，本次确认被拒绝，请重新从冲突面板发起预演。';
      showBanner('提示单已变化，预演失效，请重新预演', 'err');
    } else {
      showBanner(err.errors.join('\n') || err.message, 'err');
      btn.disabled = false;
    }
  }
}

// ---------------- 初始化 ----------------
document.querySelectorAll('input[name="startType"]').forEach((r) =>
  r.addEventListener('change', syncStartBoxes)
);
$('#cueForm').addEventListener('submit', submitForm);
$('#cancelEdit').addEventListener('click', () => resetForm());
$('#fragmentForm').addEventListener('submit', previewFragment);
$('#frDownloadBtn').addEventListener('click', downloadFragment);
$('#deferConfirmBtn').addEventListener('click', confirmDeferral);
$('#deferCancelBtn').addEventListener('click', () => clearDefer());
$('#rehStartBtn').addEventListener('click', startRehearsal);
$('#rehResetBtn').addEventListener('click', resetRehearsal);
// 演出秒数变化即按该秒数重算各行的「可开始 / 被阻止原因」（只读刷新）
let rehClockTimer = null;
$('#rehClock').addEventListener('input', () => {
  if (!rehearsal) return;
  clearTimeout(rehClockTimer);
  rehClockTimer = setTimeout(() => {
    loadRehearsal().catch(() => {});
  }, 120);
});

syncStartBoxes();
reload().catch((err) => showBanner(`加载失败：${err.message}`, 'err', true));
