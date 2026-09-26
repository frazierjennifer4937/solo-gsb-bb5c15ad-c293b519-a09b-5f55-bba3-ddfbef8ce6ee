'use strict';

/**
 * 单次排练实况执行台：
 * - 开始排练时冻结当前全部提示及重算计划（snapshot），之后提示单的增删改不影响本轮排练
 * - 按演出秒数逐条登记每条提示的实际开始 / 实际结束，持久化到独立 JSON，刷新后可继续
 * - 开始登记必须同时满足：
 *   1) 固定提示：实际开始 >= 固定秒数；
 *      相对提示：前置提示本轮已结束，且实际开始 >= 前置实际结束 + 延迟秒数；
 *   2) 本通道当前无进行中（已开始未结束）的提示；
 *   3) 实际开始不早于本通道最后一次实际结束。
 * - 结束登记：结束秒数不得早于本提示的实际开始秒数。
 * - 重置仅删除本轮排练记录，原提示单不做任何修改。
 */

const crypto = require('crypto');
const { round, evaluate } = require('./scheduler');

const EPS = 1e-9; // 与冲突检测一致的浮点容差

const STATUS = { PENDING: 'pending', RUNNING: 'running', DONE: 'done' };

function httpError(status, message, reasons) {
  const err = new Error(message);
  err.status = status;
  if (reasons) err.reasons = reasons;
  return err;
}

/** 校验并规整传入的演出秒数（必须是非负有限数字） */
function parseAt(raw, label = '演出秒数') {
  if (typeof raw === 'boolean' || raw === null || String(raw).trim() === '') {
    throw httpError(400, `${label}必须填写数字`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw httpError(400, `${label}必须是数字`);
  if (n < 0) throw httpError(400, `${label}不能为负数`);
  return round(n);
}

/** 冻结计划版本：对冻结时的提示单内容取哈希，用于判断开始后原提示单是否被改动 */
function snapshotVersion(cues) {
  return crypto.createHash('sha256').update(JSON.stringify(cues)).digest('hex');
}

function recordOf(session, cueId) {
  return session.records.find((r) => r.cueId === cueId) || null;
}

function isRunning(rec) {
  return !!rec && rec.actualStart !== null && rec.actualEnd === null;
}
function isDone(rec) {
  return !!rec && rec.actualStart !== null && rec.actualEnd !== null;
}
function cueStatus(rec) {
  if (!rec) return STATUS.PENDING;
  if (rec.actualEnd !== null) return STATUS.DONE;
  if (rec.actualStart !== null) return STATUS.RUNNING;
  return STATUS.PENDING;
}

/**
 * 计算某条未开始提示被阻止开始的全部原因。
 * at 为演出秒数（非负数字）时进行完整校验；at 为 null 时只给出与时间无关的原因
 * （前置未结束、本通道忙），用于尚未填写秒数时的展示。
 * 返回 [] 表示允许开始；否则返回原因代码与说明（至少一条）。
 */
function startBlockers(session, cueId, at) {
  const idx = session.cues.findIndex((c) => c.id === cueId);
  if (idx === -1) {
    throw httpError(404, '提示不存在（或不在本轮冻结的提示单中）');
  }
  const cue = session.cues[idx];
  const rec = recordOf(session, cueId);
  if (cueStatus(rec) !== STATUS.PENDING) return []; // 已开始/已完成的提示不走开始校验

  const reasons = [];
  const recById = new Map(session.records.map((r) => [r.cueId, r]));
  const cueById = new Map(session.cues.map((c) => [c.id, c]));
  const checkTime = at !== null; // 未填写秒数时只报与时间无关的原因

  // 规则 1a：固定提示必须达到固定秒数
  if (cue.startType === 'fixed') {
    if (checkTime && at + EPS < cue.fixedAt) {
      reasons.push({
        code: 'before_fixed',
        message: `未到固定开始时刻：实际开始不得早于固定第 ${round(cue.fixedAt)}s（当前 ${at}s）`,
      });
    }
  } else {
    // 规则 1b：相对提示要求前置本轮已结束，且达到「前置实际结束 + 延迟」
    const dep = cueById.get(cue.afterCueId);
    const depRec = recById.get(cue.afterCueId);
    if (!dep) {
      // 冻结快照内不应当出现悬空引用（开始时已全量校验）
      reasons.push({ code: 'predecessor_missing', message: '前置提示不在本轮冻结的提示单中' });
    } else if (!isDone(depRec)) {
      reasons.push({
        code: 'predecessor_open',
        message: `前置提示「${dep.name}」尚未在本轮结束（需先登记其实际结束）`,
      });
    } else if (checkTime) {
      const earliest = round(depRec.actualEnd + cue.delayAfter);
      if (at + EPS < earliest) {
        reasons.push({
          code: 'before_predecessor_end',
          message:
            `未达到前置实际结束 + 延迟：「${dep.name}」实际结束于 ${round(depRec.actualEnd)}s` +
            `，延迟 ${round(cue.delayAfter)}s，最早 ${earliest}s 才能开始（当前 ${at}s）`,
        });
      }
    }
  }

  // 规则 2：本通道当前无进行中提示
  const busy = session.cues.find((c) => {
    if (c.channel !== cue.channel || c.id === cueId) return false;
    return isRunning(recById.get(c.id));
  });
  if (busy) {
    reasons.push({
      code: 'channel_busy',
      message: `本通道「${cue.channel}」有进行中的提示「${busy.name}」，需先结束它`,
    });
  }

  // 规则 3：不得早于本通道最后一次实际结束
  let lastEnd = null;
  for (const c of session.cues) {
    if (c.channel !== cue.channel || c.id === cueId) continue;
    const r = recById.get(c.id);
    if (r && r.actualEnd !== null) {
      if (lastEnd === null || r.actualEnd > lastEnd) lastEnd = r.actualEnd;
    }
  }
  if (lastEnd !== null && checkTime && at + EPS < lastEnd) {
    reasons.push({
      code: 'before_channel_last_end',
      message: `早于本通道最后一次实际结束（${round(lastEnd)}s）：实际开始不得早于该时刻（当前 ${at}s）`,
    });
  }

  return reasons;
}

/** 开始一轮排练：冻结当前提示与重算计划；任何提示时间未定则拒绝 */
function createSession(cues) {
  const result = evaluate(cues);
  if (result.errors.length) {
    throw httpError(
      400,
      '提示单存在时间未定的提示（无效引用或循环依赖），请先解决后再开始排练',
      result.errors.map((e) => ({ code: 'schedule_invalid', message: e.message }))
    );
  }
  const timeById = new Map(result.schedule.map((s) => [s.id, s]));
  const now = new Date().toISOString();
  const session = {
    id: `run-${crypto.randomBytes(4).toString('hex')}`,
    startedAt: now,
    baseVersion: snapshotVersion(cues),
    cues: cues.map((c) => {
      const t = timeById.get(c.id);
      return {
        id: c.id,
        name: c.name,
        channel: c.channel,
        duration: round(c.duration),
        startType: c.startType,
        fixedAt: c.startType === 'fixed' ? round(c.fixedAt) : null,
        afterCueId: c.startType === 'after' ? c.afterCueId : null,
        delayAfter: c.startType === 'after' ? round(c.delayAfter) : 0,
        plannedStart: t.start,
        plannedEnd: t.end,
      };
    }),
    records: [],
    createdAt: now,
    updatedAt: now,
  };
  return session;
}

function touch(session) {
  session.updatedAt = new Date().toISOString();
}

/** 登记实际开始；不满足开始条件时抛出 400（附带全部阻止原因） */
function markStart(session, cueId, at) {
  const cue = session.cues.find((c) => c.id === cueId);
  if (!cue) throw httpError(404, '提示不存在（或不在本轮冻结的提示单中）');

  const rec = recordOf(session, cueId);
  if (isDone(rec)) {
    throw httpError(400, `「${cue.name}」已完成本轮登记，不能重复开始`, [
      { code: 'already_done', message: '该提示已登记实际开始与实际结束' },
    ]);
  }
  if (isRunning(rec)) {
    throw httpError(400, `「${cue.name}」已在进行中（${round(rec.actualStart)}s 开始），不能重复登记开始`, [
      { code: 'already_running', message: `该提示已在 ${round(rec.actualStart)}s 开始，请先登记结束` },
    ]);
  }

  const blockers = startBlockers(session, cueId, at);
  if (blockers.length) {
    throw httpError(400, `现在还不能开始「${cue.name}」：${blockers.map((b) => b.message).join('；')}`, blockers);
  }

  session.records.push({ cueId, actualStart: round(at), actualEnd: null });
  touch(session);
}

/** 登记实际结束；结束秒数早于实际开始时抛出 400 */
function markEnd(session, cueId, at) {
  const cue = session.cues.find((c) => c.id === cueId);
  if (!cue) throw httpError(404, '提示不存在（或不在本轮冻结的提示单中）');

  const rec = recordOf(session, cueId);
  if (!rec || rec.actualStart === null) {
    throw httpError(400, `「${cue.name}」尚未登记实际开始，不能登记结束`, [
      { code: 'not_started', message: '请先登记该提示的实际开始' },
    ]);
  }
  if (rec.actualEnd !== null) {
    throw httpError(400, `「${cue.name}」已在 ${round(rec.actualEnd)}s 结束，不能重复登记结束`, [
      { code: 'already_ended', message: `该提示已在 ${round(rec.actualEnd)}s 结束` },
    ]);
  }
  if (at + EPS < rec.actualStart) {
    throw httpError(
      400,
      `结束秒数（${at}s）不得早于开始秒数（${round(rec.actualStart)}s）`,
      [{ code: 'end_before_start', message: `结束秒数不得早于开始秒数（${round(rec.actualStart)}s）` }]
    );
  }

  rec.actualEnd = round(at);
  touch(session);
}

/**
 * 组装对外视图：冻结提示 + 每条状态 + 计划/实际偏差 + 当前演出秒数下的开始阻止原因。
 * at 为 null 时只给出与时间无关的阻止原因（通道忙等）。
 */
function sessionView(session, currentCues, at) {
  const recById = new Map(session.records.map((r) => [r.cueId, r]));
  const cueById = new Map(session.cues.map((c) => [c.id, c]));

  const items = session.cues.map((cue, order) => {
    const rec = recById.get(cue.id) || null;
    const status = cueStatus(rec);
    const actualStart = rec ? rec.actualStart : null;
    const actualEnd = rec ? rec.actualEnd : null;

    const item = {
      cueId: cue.id,
      order,
      name: cue.name,
      channel: cue.channel,
      duration: cue.duration,
      startType: cue.startType,
      fixedAt: cue.fixedAt,
      afterCueId: cue.afterCueId,
      delayAfter: cue.delayAfter,
      predecessorName: cue.startType === 'after' && cueById.has(cue.afterCueId)
        ? cueById.get(cue.afterCueId).name
        : null,
      plannedStart: cue.plannedStart,
      plannedEnd: cue.plannedEnd,
      status,
      actualStart,
      actualEnd,
      startDelta: actualStart === null ? null : round(actualStart - cue.plannedStart),
      endDelta: actualEnd === null ? null : round(actualEnd - cue.plannedEnd),
      blockers: [],
    };

    if (status === STATUS.PENDING) {
      item.blockers = startBlockers(session, cue.id, at);
    }
    return item;
  });

  const runningCount = items.filter((i) => i.status === STATUS.RUNNING).length;
  const doneCount = items.filter((i) => i.status === STATUS.DONE).length;
  const versionMismatch = snapshotVersion(currentCues) !== session.baseVersion;

  return {
    id: session.id,
    startedAt: session.startedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    frozenCueCount: session.cues.length,
    doneCount,
    runningCount,
    pendingCount: items.length - doneCount - runningCount,
    allDone: doneCount === items.length && items.length > 0,
    versionMismatch,
    at: at,
    items,
  };
}

module.exports = {
  STATUS,
  parseAt,
  snapshotVersion,
  createSession,
  markStart,
  markEnd,
  startBlockers,
  sessionView,
};
