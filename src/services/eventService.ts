import { getAllEvents, toBestdoriEvent } from './bestdori.js';
import { config } from '../config.js';
import type { BestdoriEvent, BestdoriPoint, BestdoriTopData, TopPlayer } from '../types.js';

// 5001 是跨活动总榜，探测时跳过
const SKIP_IDS = new Set(['5001']);
const DAY_MS = 86400000;

// 复用同一时区的 DateTimeFormat。逐次创建会增加开销并显著拖慢热路径。
const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtfFor(timezone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timezone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timezone, dtf);
  }
  return dtf;
}

// 指定时区在 ts 时刻相对 UTC 的毫秒偏移
export function tzOffsetMs(timezone: string, ts: number): number {
  const dtf = dtfFor(timezone);
  const p = Object.fromEntries(
    dtf.formatToParts(new Date(ts)).map((x) => [x.type, x.value]),
  );
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - Math.floor(ts / 1000) * 1000;
}

// 活动类型中文标签，与 T10Web 前端保持一致。
const EVENT_TYPE_LABELS: Record<string, string> = {
  live_try: 'Live 试炼',
  challenge: '挑战 Live',
  mission_live: '任务 Live',
  versus: '竞演 Live',
  medley: '组曲',
  festival: '5 v 5',
};

// 各活动类型的分速推送间隔，单位为分钟。
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

// 按活动类型获取分速推送间隔，单位为分钟。
export function pushIntervalForType(raw: string): number {
  return PUSH_INTERVAL_MINUTES_BY_TYPE[raw] ?? DEFAULT_PUSH_INTERVAL_MINUTES;
}

// 探测当前活动。优先选择进行中的活动，并取最近开始的活动。
// 没有进行中的活动时，选择 ID 最大的已结束活动。
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
// 不能使用 new Date 加偏移后调用 getDate 取日期，因为结果会受到机器本地时区影响。
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

// 采样空洞容忍度：Bestdori 对仍在 T10 内的玩家约每分钟采样一次。
// 实测连续在榜玩家的相邻采样间隔通常为 1 到 3 分钟，偶尔为 5 分钟。
// 掉出 T10 后的真实空洞实测至少为 10 分钟。阈值取 6 分钟，位于正常采样抖动与真实空洞之间。
// 该设置既能识别掉榜回榜，也不会把正常采样间隔误判为空洞。
// 这是按时间窗口取值的取舍，对 2 分钟的分速窗口偏松，
// 但收紧到 5 分钟以下又会把正常采样抖动误判为空洞，故不随 windowMs 缩放。
const STALE_BASE_SLACK_MS = 6 * 60_000;

// 计算各 uid 在最近 windowMs 内的 PT 增量。
// 以数据中最新采样时刻为基准。Bestdori 数据有滞后，使用当前时间会误判为 0。
// 取最新值与窗口前最近采样点之差，不足一个窗口返回 -1。
// 若窗口起点或窗口末端任一侧已过期，说明玩家在窗口内并非连续在榜，
// 存在掉出 T10 的采样空洞——同样返回 -1。
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
    if (!base) {
      result.set(uid, -1);
      continue;
    }
    // 窗口起点或窗口末端离各自锚点太远，说明玩家在窗口内并非连续在榜：
    // 掉榜后回榜时基准是空洞前的旧采样，中途掉榜时最新采样已过期，都无法算真实窗口增量。
    if (
      cutoff - base.time > STALE_BASE_SLACK_MS ||
      refNow - l.time > STALE_BASE_SLACK_MS
    ) {
      result.set(uid, -1);
      continue;
    }
    result.set(uid, l.pt - base.pt);
  }
  return result;
}

// 计算每位玩家最近 hours 个小时的活跃分钟数，即用户所称的周回数。
// 统计每个墙钟小时内 PT 较上一采样点有所增长的采样点个数，时间按配置时区对齐。
// 一次增长约等于完成一次周回，也就是完成一次打歌并使 PT 上涨。
// 最新一小时取上一个已完成的小时。例如 17 点整更新时取 16 点到 17 点，不含当前小时。
// 与增量列「上一整点时速」的窗口一致；但以数据中最新采样时刻为上限，
// 避免 Bestdori 数据长时间滞后时指向一个没有采样的空小时、把整条热力条错位一小时。
// 返回 uid 到 number[hours] 的映射。index 0 为最旧小时，最后一项为最新已完成小时。
export function computeHourlyActivity(
  topData: BestdoriTopData,
  now: number,
  hours = 48,
): Map<string, number[]> {
  // 墙钟小时序号，按配置时区对齐，与 tzOffsetMs 一致。
  const hourFloor = (ts: number): number =>
    Math.floor((ts + tzOffsetMs(config.timezone, ts)) / 3600000);
  // 数据中最新采样时刻，与 computeSpeedIncrements 使用相同基准。
  let maxSample = now;
  for (const p of topData.points ?? []) {
    if (p.time > maxSample) maxSample = p.time;
  }
  // 最新一格对应上一个已完成的小时，也就是当前时间的前一个小时，但受数据范围限制：
  // 数据正常时两者相等。17 点整更新时取 16 点到 17 点。
  // 数据滞后时回退到最后一个有采样的小时，
  // 不会指向空小时。
  const newest = Math.min(hourFloor(now) - 1, hourFloor(maxSample));
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
