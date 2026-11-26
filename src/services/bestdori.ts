import { t } from '../i18n.js';
import type { BestdoriEvent, BestdoriPoint, BestdoriTopData, BestdoriUser } from '../types.js';
import { VERSION } from '../config.js';
import { errorMessage } from '../errors.js';

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

// 仅合并尚未完成的同路径请求；完成后立即释放，下一次轮询仍读取最新数据。
const inFlight = new Map<string, Promise<unknown>>();

function getJson<T>(path: string, normalize?: (raw: unknown) => T | null): Promise<T | null> {
  const pending = inFlight.get(path);
  if (pending) return pending as Promise<T | null>;
  const request = fetchJson(path, normalize).finally(() => inFlight.delete(path));
  inFlight.set(path, request);
  return request;
}

async function fetchJson<T>(
  path: string,
  normalize?: (raw: unknown) => T | null,
): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json', 'User-Agent': `LiveBoost/${VERSION}` },
    });
    if (!res.ok) {
      console.warn(`[bestdori] ${path} -> HTTP ${res.status}`);
      return null;
    }
    const raw: unknown = await res.json();
    return normalize ? normalize(raw) : (raw as T);
  } catch (err) {
    console.warn(`[bestdori] ${path} 请求失败: ${errorMessage(err)}`);
    return null;
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

// 全部活动，返回 id -> 元数据
export function getAllEvents(): Promise<Record<string, RawEventMeta> | null> {
  return getJson<Record<string, RawEventMeta>>('/events/all.5.json');
}

// T10 实时数据：points 为逐分钟采样，users 为榜单玩家。
// 在外部 API 边界一次性规范化 points/users 数组和字符串 uid，避免下游各层重复兜底。
export function getTopData(eventId: string, server: string): Promise<BestdoriTopData | null> {
  return getJson<BestdoriTopData>(
    `/eventtop/data?server=${server}&event=${eventId}&mid=0&interval=60000`,
    (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const data = raw as { points?: unknown[]; users?: unknown[] };
      const points: BestdoriPoint[] = [];
      if (Array.isArray(data.points)) {
        for (const item of data.points) {
          if (!item || typeof item !== 'object') continue;
          const p = item as BestdoriPoint;
          if (typeof p.uid !== 'string') p.uid = String(p.uid);
          points.push(p);
        }
      }
      const users: BestdoriUser[] = [];
      if (Array.isArray(data.users)) {
        for (const item of data.users) {
          if (!item || typeof item !== 'object') continue;
          const u = item as BestdoriUser;
          if (typeof u.uid !== 'string') u.uid = String(u.uid);
          users.push(u);
        }
      }
      return { points, users };
    },
  );
}

// 元数据转统一的活动结构
export function toBestdoriEvent(id: string, meta: RawEventMeta | null): BestdoriEvent | null {
  if (!meta) return null;
  const startAt = Number(firstLocalized(meta.startAt));
  const endAt = Number(firstLocalized(meta.endAt));
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) return null;
  return {
    event_id: id,
    name: firstLocalized(meta.eventName) || t("(未知活动)"),
    event_type: meta.eventType || 'unknown',
    start_at: startAt,
    end_at: endAt,
  };
}
