'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { JsonStore, RehearsalStore } = require('./store');
const { evaluate, validateCueBody } = require('./scheduler');
const { buildFragment } = require('./fragment');
const { cuesVersion, planDeferral } = require('./defer');
const {
  createSession,
  markStart,
  markEnd,
  parseAt,
  sessionView,
} = require('./rehearsal');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'cues.json');
const REHEARSAL_FILE =
  process.env.REHEARSAL_FILE || path.join(path.dirname(DATA_FILE), 'rehearsal.json');

const store = new JsonStore(DATA_FILE);
const seeded = store.init();
const rehearsalStore = new RehearsalStore(REHEARSAL_FILE);
rehearsalStore.load(); // 文件不存在时返回 null（尚未开始排练），刷新后仍可继续

const app = express();
app.use(express.json());

// ---- helpers ----

function snapshot() {
  const result = evaluate(store.cues);
  return {
    cues: store.cues,
    schedule: result.schedule,
    conflicts: result.conflicts,
    graphErrors: result.errors,
  };
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ error: { message, ...extra } });
}

function rehearsalSnapshot(at) {
  if (!rehearsalStore.session) return { active: false };
  return { active: true, rehearsal: sessionView(rehearsalStore.session, store.cues, at) };
}

// 从 query（GET）或 body 读取可选的当前演出秒数；非法时抛出带 status 的错误
function readAt(src) {
  if (src === undefined || src === null || String(src).trim() === '') return null;
  return parseAt(src, '当前演出秒数');
}

// ---- API ----

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/cues', (req, res) => {
  res.json(snapshot());
});

app.post('/api/cues', (req, res) => {
  let payload;
  try {
    payload = validateCueBody(req.body);
  } catch (e) {
    return fail(res, e.status || 400, e.message, { errors: e.errors || [e.message] });
  }

  const id = `cue-${crypto.randomBytes(4).toString('hex')}`;
  const cue = { id, ...payload };
  store.cues.push(cue);

  // 新增后全量重算；若引入了缺失引用/环（缺失引用实际不可能，但仍统一走检查）
  const result = evaluate(store.cues);
  if (result.errors.length) {
    store.cues.pop(); // 拒绝写入
    return fail(res, 400, '该提示引入了无效引用或循环依赖', {
      errors: result.errors.map((e) => e.message),
    });
  }

  store.persist();
  res.status(201).json(snapshot());
});

app.put('/api/cues/:id', (req, res) => {
  const idx = store.cues.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return fail(res, 404, '提示不存在');

  let payload;
  try {
    payload = validateCueBody(req.body);
  } catch (e) {
    return fail(res, e.status || 400, e.message, { errors: e.errors || [e.message] });
  }

  // 不允许把自己设为前置（最简单的一环；多节点环由全量检查兜底）
  if (payload.startType === 'after' && payload.afterCueId === req.params.id) {
    return fail(res, 400, '不能将提示自身设为前置提示', {
      errors: ['不能将提示自身设为前置提示'],
    });
  }

  const oldCue = store.cues[idx];
  const nextCue = { id: oldCue.id, ...payload };
  store.cues[idx] = nextCue;

  const result = evaluate(store.cues);
  if (result.errors.length) {
    store.cues[idx] = oldCue; // 拒绝修改，回滚
    return fail(res, 400, '修改引入了无效引用或循环依赖，已拒绝保存', {
      errors: result.errors.map((e) => e.message),
    });
  }

  store.persist();
  res.json(snapshot());
});

app.delete('/api/cues/:id', (req, res) => {
  const idx = store.cues.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return fail(res, 404, '提示不存在');

  const referencedBy = store.cues.filter(
    (c) => c.startType === 'after' && c.afterCueId === req.params.id
  );
  if (referencedBy.length) {
    const names = referencedBy.map((c) => `「${c.name}」`).join('、');
    return fail(res, 409, `仍有 ${referencedBy.length} 条提示以它为前置：${names}，请先调整这些提示`, {
      errors: [`仍有提示 ${names} 引用它`],
    });
  }

  const [removed] = store.cues.splice(idx, 1);
  // 删除后全部后继（链路上的相对提示）时间会随下次 evaluate 自动重算
  store.persist();
  res.json({ ok: true, removedId: removed.id, ...snapshot() });
});

// ---- 冲突顺延预演（预演只读；确认时核对版本，一致才原子保存）----

app.post('/api/deferrals/preview', (req, res) => {
  const cueId = req.body && req.body.cueId;
  if (typeof cueId !== 'string' || !cueId.trim()) {
    return fail(res, 400, '缺少要顺延的提示 cueId');
  }
  try {
    res.json(planDeferral(store.cues, cueId.trim()));
  } catch (e) {
    return fail(res, e.status || 400, e.message, { errors: e.errors || [e.message] });
  }
});

app.post('/api/deferrals/confirm', (req, res) => {
  const body = req.body || {};
  const cueId = typeof body.cueId === 'string' ? body.cueId.trim() : '';
  if (!cueId) return fail(res, 400, '缺少要顺延的提示 cueId');

  // 重新核对预演所依据的提示单版本：已变化则拒绝并要求重新预演
  if (typeof body.baseVersion !== 'string' || body.baseVersion !== cuesVersion(store.cues)) {
    return fail(res, 409, '提示单在预演后已发生变化，预演结果失效，请重新预演', {
      code: 'version_mismatch',
    });
  }

  // 版本一致 ⇒ 数据与预演时完全相同，重算同一计划再应用
  let plan;
  try {
    plan = planDeferral(store.cues, cueId);
  } catch (e) {
    return fail(res, e.status || 400, e.message, { errors: e.errors || [e.message] });
  }
  if (!plan.changed) {
    return fail(res, 400, '该提示当前位置已无冲突，无需顺延');
  }

  const idx = store.cues.findIndex((c) => c.id === cueId);
  const cue = store.cues[idx];
  store.cues[idx] =
    cue.startType === 'fixed'
      ? { ...cue, fixedAt: plan.adjust.to }
      : { ...cue, delayAfter: plan.adjust.to };

  store.persist(); // 原子写入（临时文件 + rename）
  res.json({ ok: true, applied: plan, ...snapshot() });
});

// ---- 单次排练实况执行台（冻结计划；登记持久化；重置不改原提示单）----

app.get('/api/rehearsal', (req, res) => {
  let at = null;
  try {
    at = readAt(req.query.at);
  } catch (e) {
    return fail(res, e.status || 400, e.message);
  }
  res.json(rehearsalSnapshot(at));
});

app.post('/api/rehearsal/start', (req, res) => {
  if (rehearsalStore.session) {
    return fail(res, 409, '已有一轮排练进行中，请先重置后再开始新一轮', {
      code: 'already_active',
    });
  }
  let session;
  try {
    session = createSession(store.cues); // 存在时间未定的提示时返回 400
  } catch (e) {
    return fail(res, e.status || 400, e.message, { reasons: e.reasons || [e.message] });
  }
  rehearsalStore.save(session);
  res.status(201).json({ ok: true, ...rehearsalSnapshot(null) });
});

app.post('/api/rehearsal/cues/:id/start', (req, res) => {
  if (!rehearsalStore.session) return fail(res, 409, '尚未开始排练', { code: 'not_active' });
  let at;
  try {
    at = parseAt(req.body && req.body.at, '实际开始秒数');
  } catch (e) {
    return fail(res, e.status || 400, e.message);
  }
  try {
    markStart(rehearsalStore.session, req.params.id, at);
  } catch (e) {
    return fail(res, e.status || 400, e.message, { reasons: e.reasons || [e.message] });
  }
  rehearsalStore.save(rehearsalStore.session);
  res.json({ ok: true, ...rehearsalSnapshot(at) });
});

app.post('/api/rehearsal/cues/:id/end', (req, res) => {
  if (!rehearsalStore.session) return fail(res, 409, '尚未开始排练', { code: 'not_active' });
  let at;
  try {
    at = parseAt(req.body && req.body.at, '实际结束秒数');
  } catch (e) {
    return fail(res, e.status || 400, e.message);
  }
  try {
    markEnd(rehearsalStore.session, req.params.id, at);
  } catch (e) {
    return fail(res, e.status || 400, e.message, { reasons: e.reasons || [e.message] });
  }
  rehearsalStore.save(rehearsalStore.session);
  res.json({ ok: true, ...rehearsalSnapshot(at) });
});

app.post('/api/rehearsal/reset', (req, res) => {
  // 仅删除排练记录（冻结快照与实际登记），原提示单不做任何修改
  rehearsalStore.clear();
  res.json({ ok: true, active: false });
});

// ---- 片段排练单（只读，不修改原提示单）----

function fragmentParams(req) {
  // GET /api/fragments/download 用 query，POST /api/fragments/preview 用 JSON body
  const src = req.method === 'GET' ? req.query : req.body || {};
  return buildFragment(store.cues, src.start, src.end);
}

app.post('/api/fragments/preview', (req, res) => {
  try {
    res.json(fragmentParams(req));
  } catch (e) {
    return fail(res, e.status || 400, e.message, { errors: e.errors || [e.message] });
  }
});

app.get('/api/fragments/download', (req, res) => {
  let result;
  try {
    result = fragmentParams(req);
  } catch (e) {
    return fail(res, e.status || 400, e.message, { errors: e.errors || [e.message] });
  }
  const { start, end } = result.window;
  const fmt = (n) => String(n).replace(/\./g, '-');
  const filename = `cue-fragment_${fmt(start)}-${fmt(end)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(JSON.stringify(result.document, null, 2) + '\n');
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return fail(res, 400, '请求体不是合法 JSON');
  }
  return fail(res, 500, '服务器内部错误');
});

// ---- 静态前端 ----
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = app.listen(PORT, () => {
  console.log(`[cue-sheet] 数据文件: ${DATA_FILE}${seeded ? '（不存在，已初始化示例数据）' : ''}`);
  console.log(`[cue-sheet] 排练记录文件: ${REHEARSAL_FILE}${rehearsalStore.session ? '（检测到未结束的排练，可继续登记）' : ''}`);
  console.log(`[cue-sheet] 服务已启动: http://localhost:${PORT}`);
});

module.exports = { app, server };
