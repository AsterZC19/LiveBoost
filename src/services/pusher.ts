import {
  AttachmentBuilder,
  type Client,
  type SendableChannels,
} from 'discord.js';
import { config } from '../config.js';
import type { BestdoriEvent, TopPlayer } from '../types.js';
import { getTopData } from './bestdori.js';
import {
  buildLeaderboard,
  computeHourlyActivity,
  computeSpeedIncrements,
  eventDayNumber,
  eventTypeLabel,
  findCurrentEvent,
  pushIntervalForType,
  tzOffsetMs,
} from './eventService.js';
import { renderSpeedImage, formatTime } from './renderer.js';
import { getState, saveState } from './state.js';

const HOUR = 3600000;

// 下一个对齐时间点按配置时区计算。间隔 N 分钟时落在整点的 :00、:N、:2N 等位置，N 为 60 时每个整点推送。
function nextAlignedTime(now: number, intervalMin: number, timezone: string): number {
  const offset = tzOffsetMs(timezone, now);
  const local = new Date(now + offset);
  local.setSeconds(0, 0);
  const rem = local.getMinutes() % intervalMin;
  if (rem !== 0) {
    local.setMinutes(local.getMinutes() + (intervalMin - rem));
  } else if (local.getTime() <= now + offset) {
    local.setMinutes(local.getMinutes() + intervalMin);
  }
  return local.getTime() - offset;
}

// 当前时间点，格式为 HH:mm，使用配置时区。
function timePointLabel(ts: number): string {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return fmt.format(ts);
}

// 推送调度：
// - 分速：按活动类型间隔推送。组曲为 5 分钟，对邦、挑战、协力和 cp 为 2 分钟，5v5 为 3 分钟，其他类型为 2 分钟。
//   对齐整点分钟网格，例 2 分钟 -> :00 :02 :04 :06 :08 ...
// - 时速：每个整点推送一次，活动进行中的整点全部推送。
// 两者都是独立计时，互不影响。
export class Pusher {
  private stopFlag = false;
  private intervalTimer: NodeJS.Timeout | null = null;
  private hourlyTimer: NodeJS.Timeout | null = null;

  constructor(private readonly client: Client) {}

  start(): void {
    this.stopFlag = false;
    this.scheduleInterval();
    if (config.hourlyPushEnabled) {
      this.scheduleHourly();
    }
    console.log(`[pusher] 已启动：分速按墙钟分钟网格、时速按整点推送（时区 ${config.timezone}）`);
  }

  stop(): void {
    this.stopFlag = true;
    if (this.intervalTimer) clearTimeout(this.intervalTimer);
    if (this.hourlyTimer) clearTimeout(this.hourlyTimer);
    this.intervalTimer = null;
    this.hourlyTimer = null;
  }

  // 取榜单并按毫秒窗口注入增量，保持 PT 降序。
  private playersWithIncrements(topData: NonNullable<Awaited<ReturnType<typeof getTopData>>>, windowMs: number): TopPlayer[] {
    const increments = computeSpeedIncrements(topData, Date.now(), windowMs);
    return buildLeaderboard(topData).map((p) => ({
      ...p,
      speed: increments.get(p.uid) ?? -1,
      speed_rank: 0,
    }));
  }

  // ================= 分速推送：墙钟分钟网格对齐 =================
  private scheduleInterval(): void {
    if (this.stopFlag) return;
    const now = Date.now();
    void findCurrentEvent()
      .then((event) => {
        const intervalMin = event
          ? pushIntervalForType(event.event_type)
          : config.checkIntervalMinutes;
        const fireAt = nextAlignedTime(now, intervalMin, config.timezone);
        const delay = Math.max(0, fireAt - now);
        this.intervalTimer = setTimeout(() => void this.doIntervalPush(), delay);
      })
      .catch((err) => {
        console.error(`[pusher] 调度分速失败: ${err instanceof Error ? err.message : String(err)}`);
        this.intervalTimer = setTimeout(() => void this.doIntervalPush(), 60_000);
      });
  }

  private async doIntervalPush(): Promise<void> {
    try {
      await this.checkAndPush();
    } catch (err) {
      console.error(`[pusher] 分速推送出错: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.scheduleInterval();
    }
  }

  private async checkAndPush(): Promise<void> {
    const event = await findCurrentEvent();
    if (!event) {
      console.warn('[pusher] 未找到当前活动，跳过本轮');
      return;
    }

    // 活动已结束。清空 state 中的推送频道配置并发送一次结束通知，不修改 Discord 频道内容。
    // 下期活动需要手动使用 /push 开启。
    if (Date.now() > event.end_at) {
      await this.handleEventEnded(event);
      return;
    }

    const state = getState();
    const isSwitch = state.currentEventId !== null && state.currentEventId !== event.event_id;

    if (state.currentEventId !== event.event_id) {
      console.log(`[pusher] 活动切换 -> #${event.event_id} ${event.name}`);
      state.currentEventId = event.event_id;
      await saveState();
      if (isSwitch) await this.announceSwitch(event);
    }

    const topData = await getTopData(event.event_id, config.server);
    if (!topData) {
      console.warn(`[pusher] 拉取 #${event.event_id} T10 数据失败，跳过本轮`);
      return;
    }

    const intervalMin = pushIntervalForType(event.event_type);
    const windowMs = intervalMin * 60_000;
    const players = this.playersWithIncrements(topData, windowMs);

    const channels = this.channelsFor('interval');
    if (players.length === 0) {
      console.log('[pusher] 当前活动暂无 T10 数据，跳过本轮推送');
      return;
    }
    if (channels.length === 0) {
      console.log('[pusher] 无启用分速推送的频道，跳过图片渲染与推送');
      return;
    }

    const now = Date.now();
    const image = await renderSpeedImage(event, players, {
      pill: '分速',
      incrementLabel: '分速增量',
      windowStart: now - windowMs,
      windowEnd: now,
    });
    await this.pushImageToChannels(channels, event, image, '分速');
  }

  // ================= 时速推送：每个整点 =================
  private scheduleHourly(): void {
    if (this.stopFlag) return;
    const now = Date.now();
    const fireAt = nextAlignedTime(now, 60, config.timezone);
    const delay = Math.max(0, fireAt - now);
    this.hourlyTimer = setTimeout(() => void this.doHourlyPush(), delay);
  }

  private async doHourlyPush(): Promise<void> {
    try {
      const event = await findCurrentEvent();
      if (event) {
        if (Date.now() > event.end_at) {
          await this.handleEventEnded(event);
          return;
        }
        const now = Date.now();
        // 从活动第一小时到最后一小时，整点推时速
        if (now >= event.start_at + HOUR && now <= event.end_at + 60_000) {
          const topData = await getTopData(event.event_id, config.server);
          if (topData) {
            const players = this.playersWithIncrements(topData, HOUR);
            const channels = this.channelsFor('hourly');
            if (players.length > 0 && channels.length > 0) {
              // 48h 热力图，展示每小时活跃分钟数，也就是周回数。
              const heatmap = computeHourlyActivity(topData, now);
              const image = await renderSpeedImage(event, players, {
                pill: '时速',
                incrementLabel: '上一整点时速',
                windowStart: now - HOUR,
                windowEnd: now,
                heatmap,
              });
              await this.pushImageToChannels(channels, event, image, '时速');
            }
          }
        }
      }
    } catch (err) {
      console.error(`[pusher] 时速推送出错: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.scheduleHourly();
    }
  }

  // ================= 公共 =================
  private async handleEventEnded(event: BestdoriEvent): Promise<void> {
    const state = getState();
    // 仅当已结束的活动正是当前推送的活动时才处理。
    // 第一次结束检测会触发处理，之后 currentEventId 已置空，避免重复通知。
    if (state.currentEventId !== event.event_id) return;
    const ids = Object.keys(state.enabledChannels);
    if (ids.length === 0) {
      state.currentEventId = null;
      await saveState();
      return;
    }

    const channels: SendableChannels[] = [];
    for (const id of ids) {
      const ch = this.client.channels.cache.get(id);
      if (ch && ch.isTextBased() && !ch.isDMBased() && ch.isSendable()) {
        channels.push(ch as SendableChannels);
      }
    }

    // 只清 state 里的推送频道配置，下期活动需手动 /push 重新开启
    state.enabledChannels = {};
    state.currentEventId = null;
    await saveState();
    console.log(`[pusher] 活动 #${event.event_id} 已结束，已清空 state 中的推送频道（下期需手动 /push 开启）`);

    if (channels.length === 0) return;
    const lines = [
      `**活动已结束**`,
      `**${event.name}**`,
    ];
    for (const ch of channels) {
      try {
        await ch.send(lines.join('\n'));
      } catch (err) {
        console.error(`[pusher] 向 ${ch.id} 发送活动结束通知失败: ${String(err)}`);
      }
    }
  }

  private async announceSwitch(event: BestdoriEvent): Promise<void> {
    const channels = this.anyPushChannels();
    if (channels.length === 0) return;
    const lines = [
      `**新活动已开始！**`,
      `**${event.name}**`,
      `\`${eventTypeLabel(event.event_type)}\`　${formatTime(event.start_at)} ~ ${formatTime(event.end_at)}`,
      `已自动切换到该活动的推送。`,
    ];
    for (const ch of channels) {
      try {
        await ch.send(lines.join('\n'));
      } catch (err) {
        console.error(`[pusher] 向 ${ch.id} 发送活动切换通知失败: ${String(err)}`);
      }
    }
  }

  private async pushImageToChannels(
    channels: SendableChannels[],
    event: BestdoriEvent,
    image: Buffer,
    label: string,
  ): Promise<void> {
    const attachment = new AttachmentBuilder(image, { name: 't10.png', description: `${event.name} ${label}` });
    const now = Date.now();
    const header = `${event.name} ｜ 第 ${eventDayNumber(event, now)} 日 ｜ ${timePointLabel(now)}`;
    for (const ch of channels) {
      try {
        await ch.send({ content: `**${header}**`, files: [attachment] });
      } catch (err) {
        console.error(`[pusher] 向 ${ch.id} 发送图片失败: ${String(err)}`);
      }
    }
  }

  // 立即渲染分速增量并推送到指定频道，供 /push now 调用。
  async pushNow(channel: SendableChannels): Promise<void> {
    const event = await findCurrentEvent();
    if (!event) {
      throw new Error('未找到当前活动');
    }
    const topData = await getTopData(event.event_id, config.server);
    if (!topData) {
      throw new Error('拉取 T10 数据失败');
    }
    const intervalMin = pushIntervalForType(event.event_type);
    const windowMs = intervalMin * 60_000;
    const players = this.playersWithIncrements(topData, windowMs);
    const now = Date.now();
    const image = await renderSpeedImage(event, players, {
      pill: '分速',
      incrementLabel: '分速增量',
      windowStart: now - windowMs,
      windowEnd: now,
    });
    const attachment = new AttachmentBuilder(image, { name: 't10.png', description: `${event.name} 分速` });
    const header = `${event.name} ｜ 第 ${eventDayNumber(event, now)} 日 ｜ ${timePointLabel(now)}`;
    await channel.send({ content: `**${header}**`, files: [attachment] });
  }

  // 开启了指定功能的文本频道
  channelsFor(feature: 'interval' | 'hourly'): SendableChannels[] {
    const state = getState();
    const result: SendableChannels[] = [];
    for (const [id, type] of Object.entries(state.enabledChannels)) {
      if (type !== feature) continue;
      const ch = this.client.channels.cache.get(id);
      if (ch && ch.isTextBased() && !ch.isDMBased() && ch.isSendable()) {
        result.push(ch as SendableChannels);
      }
    }
    return result;
  }

  // 开启任一推送功能的文本频道，用于发送活动切换通知。
  anyPushChannels(): SendableChannels[] {
    const state = getState();
    const result: SendableChannels[] = [];
    for (const [id, type] of Object.entries(state.enabledChannels)) {
      if (!type) continue;
      const ch = this.client.channels.cache.get(id);
      if (ch && ch.isTextBased() && !ch.isDMBased() && ch.isSendable()) {
        result.push(ch as SendableChannels);
      }
    }
    return result;
  }
}
