import type { BestdoriEvent, BestdoriTopData } from '../types.js';
import { VERSION } from '../config.js';

const API = 'https://bestdori.com/api';
const TIMEOUT_MS = 15000;

// Bestdori 活动元数据原始结构，由 all.5.json 和单活动接口共用。
interface RawEventMeta {
  eventName?: string[] | string;
  eventType?: string;
  // 按语言分组的数组，索引 0 为日文，也可能是单个值。
  startAt?: (string | number)[] | string | number;
  endAt?: (string | number)[] | string | number;
}

async function getJson<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': `LiveBoost/${VERSION}` },
    });
    if (!res.ok) {
      console.warn(`[bestdori] ${path} -> HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[bestdori] ${path} 请求失败: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 字段可能是语言数组或单个值，取第一个非空项
function firstLocalized(
  value: (string | number)[] | string | number | undefined,
): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value || undefined;
  if (typeof value === 'number') return String(value);
  const found = value.find((s) => s != null && String(s).trim() !== '');
  return found === undefined ? undefined : String(found);
}

function pickName(raw: RawEventMeta['eventName']): string {
  return firstLocalized(raw) || '(未知活动)';
}

function normalizeEvent(id: string, meta: RawEventMeta): BestdoriEvent | null {
  if (!meta) return null;
  const startAt = Number(firstLocalized(meta.startAt));
  const endAt = Number(firstLocalized(meta.endAt));
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) return null;
  return {
    event_id: id,
    name: pickName(meta.eventName),
    event_type: meta.eventType || 'unknown',
    start_at: startAt,
    end_at: endAt,
  };
}

// 全部活动，返回 id -> 元数据
export async function getAllEvents(): Promise<Record<string, RawEventMeta> | null> {
  return getJson<Record<string, RawEventMeta>>('/events/all.5.json');
}

// 单个活动元数据
export async function getEventMeta(eventId: string): Promise<RawEventMeta | null> {
  return getJson<RawEventMeta>(`/events/${eventId}.json`);
}

// T10 实时数据：points 为逐分钟采样，users 为榜单玩家
export async function getTopData(eventId: string, server: string): Promise<BestdoriTopData | null> {
  return getJson<BestdoriTopData>(
    `/eventtop/data?server=${server}&event=${eventId}&mid=0&interval=60000`,
  );
}

// 元数据转统一的活动结构
export function toBestdoriEvent(id: string, meta: RawEventMeta | null): BestdoriEvent | null {
  return normalizeEvent(id, meta as RawEventMeta);
}
