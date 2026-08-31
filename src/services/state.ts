import { promises as fs } from 'node:fs';
import { config } from '../config.js';
import type {
  BotState,
  ChannelPushFlags,
  FireReminderSessionState,
  TranslateSessionState,
  VoiceSessionState,
} from '../types.js';

// state.json 路径可通过 STATE_FILE 环境变量外置到卷挂载目录，默认写入项目根目录。
const STATE_FILE = config.stateFile;

function defaultState(): BotState {
  return {
    currentEventId: null,
    enabledChannels: {},
    lastPushAt: null,
    voiceSessions: {},
    translateSessions: {},
    fireReminderSessions: {},
  };
}

// 内存中的状态
let state: BotState = defaultState();

// 启动时从 state.json 读取；文件不存在或损坏时使用默认状态
export async function loadState(): Promise<void> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BotState>;
    const enabledChannels: BotState['enabledChannels'] = {};
    // 兼容旧格式迁移：boolean 或 { interval, hourly } 对象 -> 单一推送类型
    for (const [id, val] of Object.entries(parsed.enabledChannels ?? {})) {
      let type: ChannelPushFlags | null = null;
      if (val === 'interval' || val === 'hourly') {
        type = val;
      } else if (val === true) {
        type = 'interval'; // 旧 boolean 默认分速
      } else if (val && typeof val === 'object') {
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
    if (parsed.voiceSessions && typeof parsed.voiceSessions === 'object') {
      for (const [gid, s] of Object.entries(parsed.voiceSessions)) {
        if (s && typeof s === 'object' && typeof (s as VoiceSessionState).guildId === 'string') {
          voiceSessions[gid] = s as VoiceSessionState;
        }
      }
    }
    const legacySession = (parsed as { voiceSession?: VoiceSessionState | null }).voiceSession;
    if (legacySession && typeof legacySession.guildId === 'string') {
      voiceSessions[legacySession.guildId] = legacySession;
    }
    // 独立 AI 互译会话按文本频道 ID 索引。校验 textChannelId，非法项丢弃。
    const translateSessions: BotState['translateSessions'] = {};
    if (parsed.translateSessions && typeof parsed.translateSessions === 'object') {
      for (const [cid, s] of Object.entries(parsed.translateSessions)) {
        if (
          s &&
          typeof s === 'object' &&
          typeof (s as TranslateSessionState).guildId === 'string' &&
          typeof (s as TranslateSessionState).textChannelId === 'string'
        ) {
          translateSessions[cid] = s as TranslateSessionState;
        }
      }
    }

    // 补火会话跨重启保留；逐字段校验，损坏的单条会话不会影响其他 state。
    const fireReminderSessions: BotState['fireReminderSessions'] = {};
    if (parsed.fireReminderSessions && typeof parsed.fireReminderSessions === 'object') {
      for (const raw of Object.values(parsed.fireReminderSessions)) {
        if (!raw || typeof raw !== 'object') continue;
        const s = raw as Partial<FireReminderSessionState>;
        if (
          typeof s.guildId !== 'string' ||
          typeof s.channelId !== 'string' ||
          typeof s.runnerUserId !== 'string' ||
          typeof s.gameUid !== 'string' ||
          typeof s.gameName !== 'string' ||
          typeof s.eventId !== 'string' ||
          typeof s.eventName !== 'string' ||
          typeof s.eventEndAt !== 'number' ||
          typeof s.currentFire !== 'number' ||
          (s.status !== 'active' && s.status !== 'awaiting_refill') ||
          typeof s.pendingGames !== 'number' ||
          typeof s.refillCycle !== 'number' ||
          typeof s.lastSampleTime !== 'number' ||
          typeof s.lastPointValue !== 'number' ||
          typeof s.createdAt !== 'number'
        ) continue;
        const normalizedKey = `${s.guildId}:${s.runnerUserId}`;
        const hasKnownFireCost = s.firePerScoreIncrease === 3 || s.firePerScoreIncrease === 9;
        fireReminderSessions[normalizedKey] = {
          ...(s as FireReminderSessionState),
          firePerScoreIncrease: s.firePerScoreIncrease === 9 ? 9 : 3,
          fireCostNeedsMigration: !hasKnownFireCost,
          lastPlayerRank: typeof s.lastPlayerRank === 'number' ? s.lastPlayerRank : null,
          runnerMissingWarned: s.runnerMissingWarned === true,
        };
      }
    }

    state = {
      ...defaultState(),
      ...parsed,
      enabledChannels,
      voiceSessions,
      translateSessions,
      fireReminderSessions,
    };
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
export async function saveState(): Promise<void> {
  saveChain = saveChain.then(async () => {
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
      await fs.rename(tmp, STATE_FILE);
    } catch (err) {
      console.error('[state] 保存 state.json 失败:', err);
    }
  });
  await saveChain;
}
