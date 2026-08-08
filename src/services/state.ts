import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../config.js';
import type { BotState, ChannelPushFlags } from '../types.js';

const STATE_FILE = path.join(ROOT_DIR, 'state.json');

function defaultState(): BotState {
  return {
    currentEventId: null,
    enabledChannels: {},
    lastPushAt: null,
  };
}

// 内存中的状态（进程内单例）
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
    state = {
      ...defaultState(),
      ...parsed,
      enabledChannels,
    };
    console.log('[state] 已加载 state.json');
  } catch {
    state = defaultState();
    console.log('[state] state.json 不存在，使用默认状态');
  }
}

// 返回状态对象（可直接修改，修改后调用 saveState 持久化）
export function getState(): BotState {
  return state;
}

// 原子写入：先写临时文件再 rename
export async function saveState(): Promise<void> {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tmp, STATE_FILE);
  } catch (err) {
    console.error('[state] 保存 state.json 失败:', err);
  }
}
