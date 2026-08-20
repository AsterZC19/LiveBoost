// Bestdori 活动元数据
export interface BestdoriEvent {
  event_id: string;
  name: string;
  event_type: string;
  start_at: number; // 毫秒
  end_at: number; // 毫秒
}

// eventtop 接口中的单个玩家
export interface BestdoriUser {
  uid: string;
  name: string;
  current_pt?: number;
  ranking?: number;
  introduction?: string | null;
}

// eventtop 接口中的单个 PT 采样点
export interface BestdoriPoint {
  uid: string;
  time: number; // 毫秒
  value: number; // PT
}

// eventtop 接口完整返回
export interface BestdoriTopData {
  points: BestdoriPoint[];
  users: BestdoriUser[];
}

// 榜单成员，保存前十名玩家。
export interface TopPlayer {
  uid: string;
  name: string;
  pt: number;
  rank: number; // 位次 1..10
  signature: string | null;
  speed: number; // 窗口增量；无数据为 -1
  speed_rank: number; // 增量名次；无数据为 -1
}

// 频道的推送类型。一个频道只能对应分速或时速中的一种。
export type ChannelPushFlags = 'interval' | 'hourly';

// 语音 TTS / AI 互译的绑定会话
export interface VoiceSessionState {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  translateEnabled: boolean; // AI 互译开关
  speakEnabled: boolean; // TTS 朗读开关
}

// 独立 AI 互译会话。不绑定语音，按文本频道 ID 索引。
export interface TranslateSessionState {
  guildId: string;
  textChannelId: string;
}

// 持久化状态
export interface BotState {
  currentEventId: string | null; // 当前推送的活动 ID，用于活动切换判断
  enabledChannels: Record<string, ChannelPushFlags>; // 频道 ID -> 推送类型
  lastPushAt: number | null;
  // 语音和翻译会话，按 guildId 索引，支持多服务器并行。
  voiceSessions: Record<string, VoiceSessionState>;
  // 独立 AI 互译会话，按文本频道 ID 索引，不依赖语音，所有成员均可使用。
  translateSessions: Record<string, TranslateSessionState>;
}
