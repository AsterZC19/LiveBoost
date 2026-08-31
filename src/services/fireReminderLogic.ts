import type { BestdoriPoint, FireReminderStatus } from '../types.js';

export interface FireCounterState {
  currentFire: number;
  status: FireReminderStatus;
  pendingGames: number;
  refillCycle: number;
}

export interface FireTransition {
  state: FireCounterState;
  reachedWarning: boolean;
  enteredAwaitingRefill: boolean;
  addedPendingGames: number;
}

export interface ScoreCursorResult {
  games: number;
  lastSampleTime: number;
  lastPointValue: number;
}

export type FireRefill =
  | { method: 'can' }
  | { method: 'star'; amount: number };

export function isValidFireAmount(amount: number): boolean {
  return Number.isInteger(amount) && amount >= 0 && amount <= 99;
}

export function isValidStarRefill(amount: number): boolean {
  return Number.isInteger(amount) && amount >= 10 && amount <= 90 && amount % 10 === 0;
}

// 一次新的 PT 正增长按一把 3 火计算。等待确认补火时只累计局数，不猜测补火方式。
export function consumeGames(input: FireCounterState, games: number): FireTransition {
  const state = { ...input };
  let reachedWarning = false;
  let enteredAwaitingRefill = false;
  let addedPendingGames = 0;

  for (let i = 0; i < Math.max(0, Math.floor(games)); i++) {
    if (state.status === 'awaiting_refill') {
      state.pendingGames++;
      addedPendingGames++;
      continue;
    }
    state.currentFire -= 3;
    if (state.currentFire >= 3 && state.currentFire < 6) reachedWarning = true;
    if (state.currentFire < 3) {
      state.status = 'awaiting_refill';
      state.pendingGames = 0;
      state.refillCycle++;
      enteredAwaitingRefill = true;
    }
  }

  return { state, reachedWarning, enteredAwaitingRefill, addedPendingGames };
}

export function confirmRefill(
  input: FireCounterState,
  refill: FireRefill,
): FireTransition {
  if (input.status !== 'awaiting_refill') throw new Error('当前不在等待补火状态');
  let refilled: number;
  if (refill.method === 'can') {
    refilled = 99;
  } else {
    if (!isValidStarRefill(refill.amount)) throw new Error('星石增加量必须是 10 到 90 之间的 10 的倍数');
    refilled = input.currentFire + refill.amount;
    if (refilled > 99) throw new Error('星石补火后不能超过 99');
  }

  const pendingGames = input.pendingGames;
  const base: FireCounterState = {
    currentFire: refilled,
    status: 'active',
    pendingGames: 0,
    refillCycle: input.refillCycle,
  };
  return consumeGames(base, pendingGames);
}

// 玩家每升一级恢复 10 火。轮询时先扣本轮歌曲，再加升级火量。
// 升级后重新可打时，把等待期间检测到的局数继续补扣。
export function applyLevelUps(input: FireCounterState, levels: number): FireTransition {
  const count = Math.max(0, Math.floor(levels));
  if (count === 0) {
    return {
      state: { ...input },
      reachedWarning: false,
      enteredAwaitingRefill: false,
      addedPendingGames: 0,
    };
  }
  const pendingGames = input.pendingGames;
  const revived: FireCounterState = {
    currentFire: Math.min(99, input.currentFire + count * 10),
    status: 'active',
    pendingGames: 0,
    refillCycle: input.refillCycle,
  };
  if (revived.currentFire < 3) revived.status = 'awaiting_refill';
  return revived.status === 'active' && pendingGames > 0
    ? consumeGames(revived, pendingGames)
    : {
        state: revived,
        reachedWarning: revived.currentFire >= 3 && revived.currentFire < 6,
        enteredAwaitingRefill: revived.status === 'awaiting_refill',
        addedPendingGames: 0,
      };
}

export function setFireAmount(input: FireCounterState, amount: number): FireTransition {
  if (!isValidFireAmount(amount)) throw new Error('火量必须是 0 到 99 的整数');
  const enteredAwaitingRefill = amount < 3;
  return {
    state: {
      currentFire: amount,
      status: enteredAwaitingRefill ? 'awaiting_refill' : 'active',
      pendingGames: 0,
      refillCycle: input.refillCycle + 1,
    },
    reachedWarning: amount >= 3 && amount < 6,
    enteredAwaitingRefill,
    addedPendingGames: 0,
  };
}

// 从持久化游标之后逐点扫描。PT 增长幅度不参与局数推算，一条正增长采样就是一把。
export function countNewScoreIncreases(
  points: BestdoriPoint[],
  uid: string,
  lastSampleTime: number,
  lastPointValue: number,
): ScoreCursorResult {
  const own = points
    .filter((p) => String(p.uid) === uid && p.time >= lastSampleTime)
    .sort((a, b) => a.time - b.time);
  let time = lastSampleTime;
  let value = lastPointValue;
  let games = 0;

  for (const point of own) {
    if (point.time < time) continue;
    if (point.time === time) {
      // 同一分钟的旧版本/重复点不回退游标；若数值后补上涨，只计一次并推进 value。
      if (point.value > value) {
        games++;
        value = point.value;
      }
      continue;
    }
    if (point.value > value) games++;
    time = point.time;
    value = point.value;
  }
  return { games, lastSampleTime: time, lastPointValue: value };
}
