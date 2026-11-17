import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLeaderboard,
  computeHourlyActivity,
  computeSpeedIncrements,
  eventDayNumber,
  pushIntervalForType,
} from '../src/services/eventService.js';
import { renderSpeedImage } from '../src/services/renderer.js';
import type { BestdoriEvent, BestdoriTopData } from '../src/types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

test('pushIntervalForType returns expected minute intervals', () => {
  assert.equal(pushIntervalForType('medley'), 5);
  assert.equal(pushIntervalForType('festival'), 3);
  assert.equal(pushIntervalForType('versus'), 2);
  assert.equal(pushIntervalForType('challenge'), 2);
  assert.equal(pushIntervalForType('mission_live'), 2);
  assert.equal(pushIntervalForType('unknown_type'), 2);
});

test('buildLeaderboard computes latest PT and sorts descending up to 10', () => {
  const users = Array.from({ length: 12 }, (_, i) => ({
    uid: String(i + 1),
    name: `Player ${i + 1}`,
    introduction: i === 0 ? 'hi' : null,
  }));
  const points = users.flatMap((u, i) => [
    { uid: u.uid, time: 1000, value: i * 100 },
    { uid: u.uid, time: 2000, value: (i + 1) * 1000 },
  ]);

  const board = buildLeaderboard({ users, points });
  assert.equal(board.length, 10);
  assert.equal(board[0].uid, '12');
  assert.equal(board[0].rank, 1);
  assert.equal(board[0].pt, 12000);
  assert.equal(board[9].uid, '3');
  assert.equal(board[9].rank, 10);
});

test('computeSpeedIncrements calculates window deltas and marks holes as -1', () => {
  const now = 1_700_000_000_000;
  const topData: BestdoriTopData = {
    users: [
      { uid: '1', name: 'Steady' },
      { uid: '2', name: 'DroppedIn' },
      { uid: '3', name: 'DroppedOut' },
    ],
    points: [
      { uid: '1', time: now - 3 * MIN, value: 1000 },
      { uid: '1', time: now - 2 * MIN, value: 1100 },
      { uid: '1', time: now, value: 1500 },
      // uid 2 has old sample before 6m slack (cutoff = now - 2m, 8m before cutoff > 6m)
      { uid: '2', time: now - 10 * MIN, value: 500 },
      { uid: '2', time: now, value: 900 },
      // uid 3 stopped sampling 8m before refNow (> 6m slack)
      { uid: '3', time: now - 10 * MIN, value: 200 },
      { uid: '3', time: now - 8 * MIN, value: 400 },
    ],
  };

  const inc = computeSpeedIncrements(topData, now, 2 * MIN);
  assert.equal(inc.get('1'), 400);
  assert.equal(inc.get('2'), -1);
  assert.equal(inc.get('3'), -1);
});

test('computeHourlyActivity counts PT increases in completed wall-clock hours', () => {
  const endOfHour = Date.UTC(2026, 8, 10, 10, 0, 0); // 19:00 JST
  const prevHour = endOfHour - HOUR;
  const topData: BestdoriTopData = {
    users: [{ uid: '1', name: 'Runner' }],
    points: [
      { uid: '1', time: prevHour + 1 * MIN, value: 100 },
      { uid: '1', time: prevHour + 3 * MIN, value: 200 }, // +1
      { uid: '1', time: prevHour + 5 * MIN, value: 200 }, // no increase
      { uid: '1', time: prevHour + 7 * MIN, value: 350 }, // +1
      { uid: '1', time: endOfHour + 1 * MIN, value: 500 }, // current in-progress hour (excluded when newest is completed hour)
    ],
  };

  const heatmap = computeHourlyActivity(topData, endOfHour + 5 * MIN, 48);
  const counts = heatmap.get('1');
  assert.ok(counts);
  assert.equal(counts.length, 48);
  assert.equal(counts[47], 2);
});

test('eventDayNumber respects configured Asia/Tokyo day boundaries', () => {
  const event: BestdoriEvent = {
    event_id: '300',
    name: 'Test Event',
    event_type: 'versus',
    // 2026-09-01 15:00 JST (06:00 UTC)
    start_at: Date.UTC(2026, 8, 1, 6, 0, 0),
    end_at: Date.UTC(2026, 8, 9, 11, 59, 59),
  };

  // 2026-09-01 23:30 JST (14:30 UTC) -> still Day 1
  assert.equal(eventDayNumber(event, Date.UTC(2026, 8, 1, 14, 30, 0)), 1);
  // 2026-09-02 00:10 JST (15:10 UTC on Sep 1) -> Day 2
  assert.equal(eventDayNumber(event, Date.UTC(2026, 8, 1, 15, 10, 0)), 2);
});

test('renderSpeedImage renders valid PNG in both locales with and without heatmap', async () => {
  const now = Date.UTC(2026, 8, 5, 12, 0, 0);
  const event: BestdoriEvent = {
    event_id: '301',
    name: 'Test Live Event',
    event_type: 'medley',
    start_at: now - 2 * 24 * HOUR,
    end_at: now + 5 * 24 * HOUR,
  };
  const players = [
    { uid: '1001', name: 'Kasumi', pt: 1_234_567, rank: 1, signature: 'キラキラドキドキ', speed: 12000, speed_rank: 1 },
    { uid: '1002', name: 'Yukina', pt: 1_100_000, rank: 2, signature: null, speed: 0, speed_rank: 2 },
  ];

  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const intervalBuf = await renderSpeedImage(event, players, {
    locale: 'zh-cn',
    pill: '分速',
    incrementLabel: '最近 5 分钟增量',
    windowStart: now - 5 * MIN,
    windowEnd: now,
  });
  assert.ok(intervalBuf.subarray(0, 8).equals(pngMagic));

  const heatmap = new Map<string, number[]>([
    ['1001', new Array(48).fill(3)],
    ['1002', new Array(48).fill(0)],
  ]);
  const hourlyJaBuf = await renderSpeedImage(event, players, {
    locale: 'ja',
    pill: '時速',
    incrementLabel: '前の1時間の増加P',
    windowStart: now - HOUR,
    windowEnd: now,
    heatmap,
  });
  assert.ok(hourlyJaBuf.subarray(0, 8).equals(pngMagic));
});
