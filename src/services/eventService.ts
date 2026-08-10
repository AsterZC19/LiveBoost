import { getAllEvents, toBestdoriEvent } from './bestdori.js';
import { config } from '../config.js';
import type { BestdoriEvent, BestdoriPoint, BestdoriTopData, TopPlayer } from '../types.js';

// 5001 是跨活动总榜，探测时跳过
const SKIP_IDS = new Set(['5001']);
const DAY_MS = 86400000;

// 指定时区在 ts 时刻相对 UTC 的毫秒偏移
export function tzOffsetMs(timezone: string, ts: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(
    dtf.formatToParts(new Date(ts)).map((x) => [x.type, x.value]),
  );
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - Math.floor(ts / 1000) * 1000;
}

// 活动类型中文标签（与 T10Web 前端一致）
const EVENT_TYPE_LABELS: Record<string, string> = {
  live_try: 'Live 试炼',
  challenge: '挑战 Live',
  mission_live: '任务 Live',
  versus: '竞演 Live',
  medley: '组曲',
  festival: '5 v 5',
};

// 各活动类型的分速推送间隔（分钟）
const PUSH_INTERVAL_MINUTES_BY_TYPE: Record<string, number> = {
  medley: 5, // 组曲
  versus: 2, // 对邦/竞演
  challenge: 2, // 挑战
  mission_live: 2, // 协力/任务
  festival: 3, // 5v5
};
// 未列出的类型使用此间隔
const DEFAULT_PUSH_INTERVAL_MINUTES = 2;

export function eventTypeLabel(raw: string): string {
  return EVENT_TYPE_LABELS[raw] ?? raw;
}

// 按活动类型取分速推送间隔（分钟）
export function pushIntervalForType(raw: string): number {
  return PUSH_INTERVAL_MINUTES_BY_TYPE[raw] ?? DEFAULT_PUSH_INTERVAL_MINUTES;
}

// 探测当前活动：优先进行中的（取最近开始的），否则取最大 ID 的已结束活动
export async function findCurrentEvent(): Promise<BestdoriEvent | null> {
  const metaMap = await getAllEvents();
  if (!metaMap) return null;

  const now = Date.now();
  const events: BestdoriEvent[] = [];
  for (const [id, meta] of Object.entries(metaMap)) {
    if (SKIP_IDS.has(id)) continue;
    const event = toBestdoriEvent(id, meta);
    if (event) events.push(event);
  }

  const ongoing = events
    .filter((e) => e.start_at <= now && now <= e.end_at)
    .sort((a, b) => a.start_at - b.start_at);
  if (ongoing.length > 0) return ongoing[ongoing.length - 1];

  const ended = events
    .filter((e) => e.start_at <= now)
    .sort((a, b) => Number(b.event_id) - Number(a.event_id));
  return ended[0] ?? null;
}

// 组装 T10 榜单：users 里没有 current_pt，需从 points 计算各 uid 的最新 PT，按 PT 降序取前 10。
// 本函数不计算增量，由调用方用 computeSpeedIncrements 注入 speed。
export function buildLeaderboard(topData: BestdoriTopData): TopPlayer[] {
  // 各 uid 的最新采样点
  const latest = new Map<string, { pt: number; time: number }>();
  for (const p of topData.points ?? []) {
    const key = String(p.uid);
    const prev = latest.get(key);
    if (!prev || p.time >= prev.time) latest.set(key, { pt: p.value, time: p.time });
  }

  let players = (topData.users ?? []).map((u) => {
    const l = latest.get(String(u.uid));
    return {
      uid: String(u.uid),
      name: u.name || String(u.uid),
      pt: l ? l.pt : 0,
      signature: u.introduction ?? null,
    };
  });

  // users 为空时退回用 latest
  if (players.length === 0) {
    players = [...latest.entries()].map(([uid, v]) => ({
      uid,
      name: uid,
      pt: v.pt,
      signature: null,
    }));
  }

  players.sort((a, b) => b.pt - a.pt);
  return players.slice(0, 10).map((p, i) => ({
    ...p,
    rank: i + 1,
    speed: -1, // 由调用方注入
    speed_rank: 0,
  }));
}

// 当前是活动第几天：按配置时区的自然日计算，活动开始当天为第 1 天。
// 例：活动 7.31~8.9，则 7.31 为第 1 天、8.1 为第 2 天、8.8 为第 9 天。
// 注意：不能用 new Date(ts + offset).getDate() 取日期，那会受机器本地时区影响；
// 必须用 Intl.DateTimeFormat 按配置时区直接取年月日。
export function eventDayNumber(event: BestdoriEvent, now: number): number {
  const dayStart = (ts: number): number => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: config.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .formatToParts(new Date(ts))
        .map((x) => [x.type, x.value]),
    );
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day);
  };
  const startDay = dayStart(event.start_at);
  const nowDay = dayStart(now);
  return Math.round((nowDay - startDay) / DAY_MS) + 1;
}

// 计算各 uid 在最近 windowMs 内的 PT 增量。
// 以数据中最新采样时刻为基准（Bestdori 数据有滞后，用 now 会误判为 0）；
// 取最新值与窗口前最近采样点之差，不足一个窗口返回 -1。
export function computeSpeedIncrements(
  topData: BestdoriTopData,
  now: number,
  windowMs: number,
): Map<string, number> {
  // 用数据中最新采样时刻作为基准
  let refNow = now;
  for (const p of topData.points ?? []) {
    if (p.time > refNow) refNow = p.time;
  }
  const cutoff = refNow - windowMs;
  const latest = new Map<string, { pt: number; time: number }>();
  const atCutoff = new Map<string, { pt: number; time: number }>();

  for (const p of topData.points ?? []) {
    const uid = String(p.uid);
    const l = latest.get(uid);
    if (!l || p.time >= l.time) latest.set(uid, { pt: p.value, time: p.time });
    if (p.time <= cutoff) {
      const prev = atCutoff.get(uid);
      if (!prev || p.time >= prev.time) atCutoff.set(uid, { pt: p.value, time: p.time });
    }
  }

  const result = new Map<string, number>();
  for (const [uid, l] of latest) {
    const base = atCutoff.get(uid);
    result.set(uid, base ? l.pt - base.pt : -1);
  }
  return result;
}

// 计算每位玩家最近 hours 个小时的「活跃分钟数」（即用户所称的周回数）：
// 统计每个墙钟小时（按配置时区对齐）内，PT 较上一采样点有所增长的采样点个数；
// 一次增长 ≈ 周回一次（打歌完成一次，PT 上涨一次）。
// 基准用数据中最新采样时刻（Bestdori 数据有滞后，用 now 会把最新小时算成 0）。
// 返回 uid -> number[hours]（index 0 最旧，index hours-1 为当前小时）。
export function computeHourlyActivity(
  topData: BestdoriTopData,
  now: number,
  hours = 48,
): Map<string, number[]> {
  // 用数据中最新采样时刻作为基准
  let refNow = now;
  for (const p of topData.points ?? []) {
    if (p.time > refNow) refNow = p.time;
  }

  // 墙钟小时序号（时区对齐），与 tzOffsetMs 一致
  const hourFloor = (ts: number): number =>
    Math.floor((ts + tzOffsetMs(config.timezone, ts)) / 3600000);
  const newest = hourFloor(refNow);
  const oldest = newest - (hours - 1);

  // 按 uid 聚合采样点
  const byUid = new Map<string, BestdoriPoint[]>();
  for (const p of topData.points ?? []) {
    const uid = String(p.uid);
    const arr = byUid.get(uid);
    if (arr) arr.push(p);
    else byUid.set(uid, [p]);
  }

  const result = new Map<string, number[]>();
  for (const [uid, raw] of byUid) {
    const counts = new Array<number>(hours).fill(0);
    raw.sort((a, b) => a.time - b.time);
    // 相邻点对：后值大于前值即一次增长，记入后值所在小时桶
    for (let i = 1; i < raw.length; i++) {
      const prev = raw[i - 1];
      const cur = raw[i];
      if (cur.value > prev.value) {
        const h = hourFloor(cur.time);
        if (h >= oldest && h <= newest) counts[h - oldest]++;
      }
    }
    result.set(uid, counts);
  }
  return result;
}
