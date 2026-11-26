import { DEFAULT_LOCALE, isLocale, type Locale } from '../i18n.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { errorMessage } from '../errors.js';
import type {
  BotState,
  ChannelPushFlags,
  FireReminderSessionState,
  TranslationLinkState,
  VoiceSessionState,
} from '../types.js';

// state.json 路径可通过 STATE_FILE 环境变量外置到卷挂载目录，默认写入项目根目录。
const STATE_FILE = config.stateFile;
const DAY_MS = 24 * 60 * 60 * 1000;

function defaultState(): BotState {
  return {
    guildLanguages: {},
    currentEventId: null,
    enabledChannels: {},
    voiceSessions: {},
    translateSessions: {},
    translationLinks: {},
    fireReminderSessions: {},
  };
}

// 内存中的状态
let state: BotState = defaultState();

// 翻译关联只服务于“源消息随后被撤回”的场景。保留无限期会让 state.json 随消息量增长，
// 因此按时间和数量双重限制；清理发生在每次保存前，空闲期间也不会继续增长。
function pruneTranslationLinks(now = Date.now()): boolean {
  const links = state.translationLinks;
  const cutoff = now - config.translationLinkRetentionDays * DAY_MS;
  let changed = false;

  for (const [sourceMessageId, link] of Object.entries(links)) {
    if (link.translationMessageIds.length === 0 || link.createdAt < cutoff) {
      delete links[sourceMessageId];
      changed = true;
    }
  }

  const entries = Object.entries(links);
  if (entries.length > config.maxTranslationLinks) {
    entries
      .sort(([, left], [, right]) => left.createdAt - right.createdAt)
      .slice(0, entries.length - config.maxTranslationLinks)
      .forEach(([sourceMessageId]) => {
        delete links[sourceMessageId];
        changed = true;
      });
  }
  return changed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// 启动时从 state.json 读取；文件不存在或损坏时使用默认状态
export async function loadState(filePath = STATE_FILE): Promise<void> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BotState>;
    const enabledChannels: BotState['enabledChannels'] = {};
    // 兼容旧格式迁移：boolean 或 { interval, hourly } 对象 -> 单一推送类型
    for (const [id, val] of Object.entries(parsed.enabledChannels ?? {})) {
      let type: ChannelPushFlags | null = null;
      if (val === 'interval' || val === 'hourly') {
        type = val;
      } else if (val === true) {
        type = 'interval'; // 旧 boolean 默认分速
      } else if (isRecord(val)) {
        const f = val as { interval?: boolean; hourly?: boolean };
        if (f.interval && f.hourly) {
          // 旧格式允许同时开启，现在一个频道只能有一种，保留分速并提示
          console.warn(`[state] 频道 ${id} 同时启用了分速与时速，已自动保留分速推送`);
          type = 'interval';
        } else if (f.interval) {
          type = 'interval';
        } else if (f.hourly) {
          type = 'hourly';
        }
      }
      if (type) enabledChannels[id] = type;
    }
    // 语音会话使用新格式 voiceSessions，按 guildId 索引，同时兼容旧格式的单个 voiceSession。
    const voiceSessions: BotState['voiceSessions'] = {};
    if (isRecord(parsed.voiceSessions)) {
      for (const [gid, s] of Object.entries(parsed.voiceSessions)) {
        if (isRecord(s) && typeof s.guildId === 'string') {
          voiceSessions[gid] = s;
        }
      }
    }
    const legacySession = (parsed as { voiceSession?: VoiceSessionState | null }).voiceSession;
    if (legacySession && typeof legacySession.guildId === 'string') {
      voiceSessions[legacySession.guildId] = legacySession;
    }
    // 独立 AI 互译会话按文本频道 ID 索引。校验 textChannelId，非法项丢弃。
    const translateSessions: BotState['translateSessions'] = {};
    if (isRecord(parsed.translateSessions)) {
      for (const [cid, s] of Object.entries(parsed.translateSessions)) {
        if (isRecord(s) && typeof s.guildId === 'string' && typeof s.textChannelId === 'string') {
          translateSessions[cid] = { guildId: s.guildId, textChannelId: s.textChannelId };
        }
      }
    }

    // 源消息与翻译回复关联。损坏的单条关联不会影响其他 state。
    const translationLinks: BotState['translationLinks'] = {};
    if (isRecord(parsed.translationLinks)) {
      for (const [sourceMessageId, raw] of Object.entries(parsed.translationLinks)) {
        if (!isRecord(raw)) continue;
        const link = raw as Partial<TranslationLinkState>;
        if (
          typeof link.channelId !== 'string' ||
          !Array.isArray(link.translationMessageIds) ||
          !link.translationMessageIds.every((id) => typeof id === 'string') ||
          !isFiniteNumber(link.createdAt)
        ) continue;
        translationLinks[sourceMessageId] = {
          channelId: link.channelId,
          translationMessageIds: [...new Set(link.translationMessageIds)],
          createdAt: link.createdAt,
        };
      }
    }

    // 补火会话跨重启保留；逐字段校验，损坏的单条会话不会影响其他 state。
    const fireReminderSessions: BotState['fireReminderSessions'] = {};
    if (isRecord(parsed.fireReminderSessions)) {
      for (const raw of Object.values(parsed.fireReminderSessions)) {
        if (!isRecord(raw)) continue;
        const s = raw as Partial<FireReminderSessionState>;
        if (
          typeof s.guildId !== 'string' ||
          typeof s.channelId !== 'string' ||
          typeof s.runnerUserId !== 'string' ||
          typeof s.gameUid !== 'string' ||
          typeof s.gameName !== 'string' ||
          typeof s.eventId !== 'string' ||
          typeof s.eventName !== 'string' ||
          (s.status !== 'active' && s.status !== 'awaiting_refill') ||
          !isNonNegSafeInt(s.currentFire) || s.currentFire > 99 ||
          !isNonNegSafeInt(s.pendingGames) ||
          !isNonNegSafeInt(s.refillCycle) ||
          !isFiniteNumber(s.eventEndAt) ||
          !isFiniteNumber(s.lastSampleTime) ||
          !isFiniteNumber(s.lastPointValue) ||
          !isFiniteNumber(s.createdAt)
        ) continue;
        const normalizedKey = `${s.guildId}:${s.runnerUserId}`;
        const hasKnownFireCost = s.firePerScoreIncrease === 3 || s.firePerScoreIncrease === 9;
        fireReminderSessions[normalizedKey] = {
          guildId: s.guildId,
          channelId: s.channelId,
          runnerUserId: s.runnerUserId,
          gameUid: s.gameUid,
          gameName: s.gameName,
          eventId: s.eventId,
          eventName: s.eventName,
          eventEndAt: s.eventEndAt,
          firePerScoreIncrease: s.firePerScoreIncrease === 9 ? 9 : 3,
          fireCostNeedsMigration: !hasKnownFireCost || s.fireCostNeedsMigration === true,
          currentFire: s.currentFire,
          status: s.status,
          pendingGames: s.pendingGames,
          refillCycle: s.refillCycle,
          lastSampleTime: s.lastSampleTime,
          lastPointValue: s.lastPointValue,
          lastPlayerRank: isNonNegSafeInt(s.lastPlayerRank) ? s.lastPlayerRank : null,
          runnerMissingWarned: s.runnerMissingWarned === true,
          createdAt: s.createdAt,
        };
      }
    }

    const guildLanguages: Record<string, Locale> = {};
    for (const [id, locale] of Object.entries(parsed.guildLanguages ?? {})) {
      if (isLocale(locale)) guildLanguages[id] = locale;
    }

    state = {
      guildLanguages,
      currentEventId: typeof parsed.currentEventId === 'string' ? parsed.currentEventId : null,
      enabledChannels,
      voiceSessions,
      translateSessions,
      translationLinks,
      fireReminderSessions,
    };
    if (pruneTranslationLinks()) {
      try {
        await saveState(filePath);
        console.log('[state] 已清理过期或超限的翻译关联');
      } catch (err) {
        console.warn('[state] 清理翻译关联后写回失败: ' + errorMessage(err));
      }
    }
    console.log('[state] 已加载 state.json');
  } catch {
    state = defaultState();
    console.log('[state] state.json 不存在，使用默认状态');
  }
}

// 返回状态对象。可以直接修改，修改后调用 saveState 持久化。
export function getState(): BotState {
  return state;
}

// 多个定时服务和交互可能同时保存；串行化写入，避免它们争用同一个临时文件。
let saveChain: Promise<void> = Promise.resolve();

// 原子写入：先写临时文件再 rename
export async function saveState(filePath = STATE_FILE): Promise<void> {
  const save = saveChain.then(async () => {
    pruneTranslationLinks();
    const tmp = `${filePath}.${process.pid}.tmp`;
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
      await fs.rename(tmp, filePath);
    } catch (err) {
      console.error('[state] 保存 state.json 失败:', err);
      throw err;
    }
  });
  // 本次调用报告失败，同时允许后续保存继续重试。
  saveChain = save.catch(() => {});
  await save;
}

export function guildLocale(guildId: string | null | undefined): Locale {
  return (guildId && getState().guildLanguages[guildId]) || DEFAULT_LOCALE;
}
