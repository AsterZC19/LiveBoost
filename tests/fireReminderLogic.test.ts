import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLevelUps,
  confirmRefill,
  consumeGames,
  countNewScoreIncreases,
  isLastRunFire,
  setFireAmount,
  type FireCounterState,
} from '../src/services/fireReminderLogic.js';

function baseState(overrides: Partial<FireCounterState> = {}): FireCounterState {
  return {
    firePerScoreIncrease: 3,
    currentFire: 9,
    status: 'active',
    pendingGames: 0,
    refillCycle: 0,
    ...overrides,
  };
}

test('consumeGames warns on last run and enters awaiting_refill below cost', () => {
  const t1 = consumeGames(baseState({ currentFire: 8 }), 1);
  assert.equal(t1.state.currentFire, 5);
  assert.equal(t1.state.status, 'active');
  assert.equal(t1.reachedWarning, true);
  assert.equal(t1.enteredAwaitingRefill, false);
  assert.equal(isLastRunFire(t1.state), true);

  const t2 = consumeGames(t1.state, 1);
  assert.equal(t2.state.currentFire, 2);
  assert.equal(t2.state.status, 'awaiting_refill');
  assert.equal(t2.state.refillCycle, 1);
  assert.equal(t2.enteredAwaitingRefill, true);
  assert.equal(t2.state.pendingGames, 0);

  const t3 = consumeGames(t2.state, 2);
  assert.equal(t3.state.currentFire, 2);
  assert.equal(t3.state.pendingGames, 2);
  assert.equal(t3.addedPendingGames, 2);
});

test('medley uses 9 fire per score increase and warns between 9 and 17', () => {
  const t1 = consumeGames(baseState({ firePerScoreIncrease: 9, currentFire: 20 }), 1);
  assert.equal(t1.state.currentFire, 11);
  assert.equal(t1.reachedWarning, true);
  assert.equal(t1.state.status, 'active');

  const t2 = consumeGames(t1.state, 1);
  assert.equal(t2.state.currentFire, 2);
  assert.equal(t2.state.status, 'awaiting_refill');
  assert.equal(t2.enteredAwaitingRefill, true);
});

test('confirmRefill supports can and star refills and replays pending games', () => {
  const waiting = baseState({ currentFire: 2, status: 'awaiting_refill', pendingGames: 3, refillCycle: 1 });

  const canResult = confirmRefill(waiting, { method: 'can' });
  assert.equal(canResult.state.currentFire, 90);
  assert.equal(canResult.state.status, 'active');
  assert.equal(canResult.state.pendingGames, 0);

  const starResult = confirmRefill(waiting, { method: 'star', amount: 90 });
  assert.equal(starResult.state.currentFire, 83);
  assert.equal(starResult.state.status, 'active');

  assert.throws(() => confirmRefill(baseState(), { method: 'can' }));
  assert.throws(() => confirmRefill(waiting, { method: 'star', amount: 95 }));
  assert.throws(() => confirmRefill({ ...waiting, currentFire: 12 }, { method: 'star', amount: 90 }));
});

test('applyLevelUps caps at 99, revives waiting session, and replays pending games', () => {
  const waiting = baseState({ currentFire: 1, status: 'awaiting_refill', pendingGames: 2, refillCycle: 1 });
  const t = applyLevelUps(waiting, 1);
  assert.equal(t.state.currentFire, 5); // 1 + 10 - 2*3
  assert.equal(t.state.status, 'active');
  assert.equal(t.state.pendingGames, 0);
  assert.equal(t.reachedWarning, true);

  const medleyWaiting = baseState({
    firePerScoreIncrease: 9,
    currentFire: 1,
    status: 'awaiting_refill',
    pendingGames: 2,
    refillCycle: 1,
  });
  const m = applyLevelUps(medleyWaiting, 1);
  // 1 + 10 = 11 >= 9 -> consumes 2 pending games -> hits awaiting_refill after 1st game (2 fire left) and adds 1 pending
  assert.equal(m.state.currentFire, 2);
  assert.equal(m.state.status, 'awaiting_refill');
  assert.equal(m.state.pendingGames, 1);

  const capped = applyLevelUps(baseState({ currentFire: 95 }), 2);
  assert.equal(capped.state.currentFire, 99);
});

test('setFireAmount validates bounds and resets pending games', () => {
  const waiting = baseState({ currentFire: 1, status: 'awaiting_refill', pendingGames: 4, refillCycle: 2 });
  const active = setFireAmount(waiting, 5);
  assert.equal(active.state.currentFire, 5);
  assert.equal(active.state.status, 'active');
  assert.equal(active.state.pendingGames, 0);
  assert.equal(active.state.refillCycle, 3);
  assert.equal(active.reachedWarning, true);

  const stillLow = setFireAmount(waiting, 2);
  assert.equal(stillLow.state.status, 'awaiting_refill');
  assert.equal(stillLow.enteredAwaitingRefill, true);

  assert.throws(() => setFireAmount(waiting, -1));
  assert.throws(() => setFireAmount(waiting, 100));
  assert.throws(() => setFireAmount(waiting, 3.5));
});

test('countNewScoreIncreases advances cursor monotonically across samples', () => {
  const points = [
    { uid: '2', time: 1000, value: 500 },
    { uid: '1', time: 900, value: 50 },
    { uid: '1', time: 1000, value: 120 },
    { uid: '1', time: 1100, value: 120 },
    { uid: '1', time: 1200, value: 200 },
    { uid: '1', time: 1300, value: 300 },
  ];

  const r1 = countNewScoreIncreases(points, '1', 1000, 100);
  assert.deepEqual(r1, { games: 3, lastSampleTime: 1300, lastPointValue: 300 });

  const r2 = countNewScoreIncreases(points, '1', 1300, 300);
  assert.deepEqual(r2, { games: 0, lastSampleTime: 1300, lastPointValue: 300 });
});
