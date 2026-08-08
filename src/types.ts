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

// 榜单成员（前 10 名）
export interface TopPlayer {
  uid: string;
  name: string;
  pt: number;
  rank: number; // 位次 1..10
  signature: string | null;
  speed: number; // 窗口增量；无数据为 -1
  speed_rank: number; // 增量名次；无数据为 -1
}

// 频道的推送类型（一个频道只对应一种：分速或时速）
export type ChannelPushFlags = 'interval' | 'hourly';

// 持久化状态
export interface BotState {
  currentEventId: string | null; // 当前推送的活动 ID，用于活动切换判断
  enabledChannels: Record<string, ChannelPushFlags>; // 频道 ID -> 推送类型
  lastPushAt: number | null;
}
