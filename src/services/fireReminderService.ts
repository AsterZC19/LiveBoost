import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type SendableChannels,
} from 'discord.js';
import { config } from '../config.js';
import type { FireReminderSessionState } from '../types.js';
import { getTopData } from './bestdori.js';
import { buildLeaderboard, findCurrentEvent } from './eventService.js';
import {
  confirmRefill,
  consumeGames,
  countNewScoreIncreases,
  applyLevelUps,
  isValidFireAmount,
  setFireAmount,
  type FireRefill,
  type FireTransition,
} from './fireReminderLogic.js';
import { getState, saveState } from './state.js';
import type { AssistService } from './assistService.js';

const POLL_INTERVAL_MS = 30_000;
const EVENT_END_GRACE_MS = 5 * 60_000;

export function fireSessionKey(guildId: string, runnerUserId: string): string {
  return `${guildId}:${runnerUserId}`;
}

export function refillButtonId(
  runnerUserId: string,
  cycle: number,
  refill: FireRefill,
): string {
  const token = refill.method === 'can' ? 'can' : `star${refill.amount}`;
  return `fire:refill:${runnerUserId}:${cycle}:${token}`;
}

export interface ParsedRefillButton {
  runnerUserId: string;
  cycle: number;
  refill: FireRefill;
}

export function parseRefillButtonId(customId: string): ParsedRefillButton | null {
  const match = /^fire:refill:(\d+):(\d+):(can|star(?:10|20|30|40|50|60|70|80|90)|90|99)$/.exec(customId);
  if (!match) return null;
  const token = match[3];
  const refill: FireRefill = token === 'can' || token === '99'
    ? { method: 'can' }
    : { method: 'star', amount: token === '90' ? 90 : Number(token.slice(4)) };
  return {
    runnerUserId: match[1],
    cycle: Number(match[2]),
    refill,
  };
}

export class FireReminderService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private readonly client: Client,
    private readonly assist: AssistService,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    console.log('[fire] 补火监控已启动：每 30 秒检查一次 Bestdori PT 采样');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSession(guildId: string, runnerUserId: string): FireReminderSessionState | null {
    return getState().fireReminderSessions[fireSessionKey(guildId, runnerUserId)] ?? null;
  }

  async startSession(params: {
    guildId: string;
    channelId: string;
    runnerUserId: string;
    rank: number;
    initialFire: number;
  }): Promise<FireReminderSessionState> {
    if (!isValidFireAmount(params.initialFire)) {
      throw new Error('初始火量必须是 0 到 99 的整数');
    }
    const key = fireSessionKey(params.guildId, params.runnerUserId);
    if (getState().fireReminderSessions[key]) {
      throw new Error('该主跑已经有补火会话，请先使用 /fire stop');
    }
    const event = await findCurrentEvent();
    const now = Date.now();
    if (!event || now < event.start_at || now > event.end_at) {
      throw new Error('当前没有正在进行的活动');
    }
    const topData = await getTopData(event.event_id, config.server);
    if (!topData) throw new Error('拉取当前 T10 数据失败');
    const player = buildLeaderboard(topData)[params.rank - 1];
    if (!player) throw new Error(`当前榜单没有第 ${params.rank} 名数据`);
    const duplicate = Object.values(getState().fireReminderSessions).find(
      (s) => s.guildId === params.guildId && s.gameUid === player.uid,
    );
    if (duplicate) throw new Error('这个游戏账号已经绑定了本服务器内的另一名主跑');

    const latest = (topData.points ?? [])
      .filter((p) => String(p.uid) === player.uid)
      .sort((a, b) => (b.time - a.time) || (b.value - a.value))[0];
    if (!latest) throw new Error('找不到该玩家的 PT 采样，暂时无法开始监控');

    const session: FireReminderSessionState = {
      guildId: params.guildId,
      channelId: params.channelId,
      runnerUserId: params.runnerUserId,
      gameUid: player.uid,
      gameName: player.name,
      eventId: event.event_id,
      eventName: event.name,
      eventEndAt: event.end_at,
      currentFire: params.initialFire,
      status: params.initialFire < 3 ? 'awaiting_refill' : 'active',
      pendingGames: 0,
      refillCycle: params.initialFire < 3 ? 1 : 0,
      lastSampleTime: latest.time,
      lastPointValue: latest.value,
      lastPlayerRank: (() => {
        const rank = (topData.users ?? []).find((u) => String(u.uid) === player.uid)?.rank;
        return Number.isInteger(rank) ? rank! : null;
      })(),
      runnerMissingWarned: false,
      createdAt: now,
    };
    getState().fireReminderSessions[key] = session;
    await saveState();
    if (session.currentFire >= 3 && session.currentFire < 6) await this.sendLastGameWarning(session);
    if (session.status === 'awaiting_refill') await this.sendRefillPrompt(session);
    return session;
  }

  async refill(
    guildId: string,
    runnerUserId: string,
    refill: FireRefill,
    expectedCycle?: number,
  ): Promise<FireReminderSessionState> {
    const session = this.getSession(guildId, runnerUserId);
    if (!session) throw new Error('找不到该主跑的补火会话');
    if (expectedCycle !== undefined && session.refillCycle !== expectedCycle) {
      throw new Error('这个补火按钮已经过期，请使用最新提示');
    }
    const transition = confirmRefill(session, refill);
    this.applyTransition(session, transition);
    await saveState();
    await this.sendTransitionAlerts(session, transition);
    return session;
  }

  async setFire(
    guildId: string,
    runnerUserId: string,
    amount: number,
  ): Promise<FireReminderSessionState> {
    const session = this.getSession(guildId, runnerUserId);
    if (!session) throw new Error('找不到该主跑的补火会话');
    const transition = setFireAmount(session, amount);
    this.applyTransition(session, transition);
    await saveState();
    await this.sendTransitionAlerts(session, transition);
    return session;
  }

  async removeSession(guildId: string, runnerUserId: string): Promise<FireReminderSessionState> {
    const key = fireSessionKey(guildId, runnerUserId);
    const session = getState().fireReminderSessions[key];
    if (!session) throw new Error('找不到该主跑的补火会话');
    delete getState().fireReminderSessions[key];
    await saveState();
    return session;
  }

  private applyTransition(session: FireReminderSessionState, transition: FireTransition): void {
    session.currentFire = transition.state.currentFire;
    session.status = transition.state.status;
    session.pendingGames = transition.state.pendingGames;
    session.refillCycle = transition.state.refillCycle;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollOnce();
    } catch (err) {
      console.error(`[fire] 轮询失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    const all = Object.entries(getState().fireReminderSessions);
    if (all.length === 0) return;
    const now = Date.now();
    const active: typeof all = [];
    let dirty = false;

    for (const [key, session] of all) {
      if (now > session.eventEndAt + EVENT_END_GRACE_MS) {
        delete getState().fireReminderSessions[key];
        dirty = true;
        await saveState();
        dirty = false;
        await this.sendText(
          session,
          `**${session.gameName}** 的补火会话已在活动结束 5 分钟后自动关闭。`,
          false,
        );
      } else {
        active.push([key, session]);
      }
    }

    const byEvent = new Map<string, FireReminderSessionState[]>();
    for (const [, session] of active) {
      const group = byEvent.get(session.eventId);
      if (group) group.push(session);
      else byEvent.set(session.eventId, [session]);
    }

    for (const [eventId, sessions] of byEvent) {
      const topData = await getTopData(eventId, config.server);
      if (!topData) {
        console.warn(`[fire] 拉取活动 #${eventId} T10 数据失败，本轮保留游标等待重试`);
        continue;
      }
      const currentUids = new Set((topData.users ?? []).map((u) => String(u.uid)));
      for (const session of sessions) {
        const currentUser = (topData.users ?? []).find((u) => String(u.uid) === session.gameUid);
        const isPresent = currentUids.has(session.gameUid);
        if (!isPresent && !session.runnerMissingWarned) {
          session.runnerMissingWarned = true;
          dirty = true;
          await saveState();
          dirty = false;
          await this.sendText(
            session,
            `<@${session.runnerUserId}> 已不在当前 T10，补火计数暂时无法继续；回到 T10 后会自动恢复。`,
            true,
          );
        } else if (isPresent && session.runnerMissingWarned) {
          session.runnerMissingWarned = false;
          dirty = true;
          await saveState();
          dirty = false;
          await this.sendText(session, `**${session.gameName}** 已回到 T10，补火计数恢复。`, false);
        }

        let levelDelta = 0;
        if (Number.isInteger(currentUser?.rank)) {
          const currentRank = currentUser!.rank!;
          if (session.lastPlayerRank === null) {
            session.lastPlayerRank = currentRank;
            dirty = true;
          } else if (currentRank > session.lastPlayerRank) {
            levelDelta = currentRank - session.lastPlayerRank;
            session.lastPlayerRank = currentRank;
            dirty = true;
          }
        }

        const cursor = countNewScoreIncreases(
          topData.points ?? [],
          session.gameUid,
          session.lastSampleTime,
          session.lastPointValue,
        );
        if (
          cursor.lastSampleTime !== session.lastSampleTime ||
          cursor.lastPointValue !== session.lastPointValue
        ) {
          session.lastSampleTime = cursor.lastSampleTime;
          session.lastPointValue = cursor.lastPointValue;
          dirty = true;
        }
        if (cursor.games === 0 && levelDelta === 0) continue;

        const previousCycle = session.refillCycle;
        const previousPending = session.pendingGames;
        let reachedWarning = false;
        if (cursor.games > 0) {
          const gameTransition = consumeGames(session, cursor.games);
          this.applyTransition(session, gameTransition);
          reachedWarning = gameTransition.reachedWarning;
        }
        if (levelDelta > 0) {
          const levelTransition = applyLevelUps(session, levelDelta);
          this.applyTransition(session, levelTransition);
          reachedWarning = levelTransition.reachedWarning;
        }
        const transition: FireTransition = {
          state: {
            currentFire: session.currentFire,
            status: session.status,
            pendingGames: session.pendingGames,
            refillCycle: session.refillCycle,
          },
          reachedWarning:
            reachedWarning && session.status === 'active' && session.currentFire >= 3 && session.currentFire < 6,
          enteredAwaitingRefill:
            session.status === 'awaiting_refill' && session.refillCycle > previousCycle,
          addedPendingGames: Math.max(0, session.pendingGames - previousPending),
        };
        dirty = true;
        // 先持久化游标和火量，再发提醒；进程若在发送后重启，不会重复扣火或重复提醒。
        await saveState();
        dirty = false;
        if (levelDelta > 0) {
          await this.sendText(
            session,
            `**${session.gameName}** 等级提升到 **${session.lastPlayerRank}**，当前剩余 **${session.currentFire} 火**。`,
            false,
          );
        }
        await this.sendTransitionAlerts(session, transition);
        if (
          transition.addedPendingGames > 0 &&
          previousPending === 0 &&
          !transition.enteredAwaitingRefill
        ) {
          await this.sendText(
            session,
            `**${session.gameName}** 在等待确认补火期间又检测到 PT 上涨；确认后会自动补扣。`,
            false,
          );
        }
      }
    }
    if (dirty) await saveState();
  }

  private async sendTransitionAlerts(
    session: FireReminderSessionState,
    transition: FireTransition,
  ): Promise<void> {
    // 同一轮轮询直接跨过最后一把时，不发送已经过时的强提醒。
    if (transition.reachedWarning && !transition.enteredAwaitingRefill) {
      await this.sendLastGameWarning(session);
    }
    if (transition.enteredAwaitingRefill) await this.sendRefillPrompt(session);
  }

  private async sendLastGameWarning(session: FireReminderSessionState): Promise<void> {
    await this.sendText(
      session,
      `<@${session.runnerUserId}> 当前剩余 **${session.currentFire} 火**，只够最后一把；这把结束后请补火。`,
      true,
    );
    this.assist.speakFireReminder(session.guildId, session.gameName);
  }

  private async sendRefillPrompt(session: FireReminderSessionState): Promise<void> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(refillButtonId(session.runnerUserId, session.refillCycle, { method: 'can' }))
        .setLabel('火罐补到 99')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(refillButtonId(session.runnerUserId, session.refillCycle, { method: 'star', amount: 90 }))
        .setLabel('星石增加 90')
        .setStyle(ButtonStyle.Secondary),
    );
    const pending = session.pendingGames > 0
      ? `\n等待确认期间已检测到 **${session.pendingGames}** 把，确认后会自动补扣。`
      : '';
    await this.sendText(
      session,
      `**${session.gameName}** 当前剩余 **${session.currentFire} 火**，请选择补火方式。${pending}`,
      false,
      row,
    );
  }

  private async sendText(
    session: FireReminderSessionState,
    content: string,
    mentionRunner: boolean,
    components?: ActionRowBuilder<ButtonBuilder>,
  ): Promise<void> {
    try {
      const cached = this.client.channels.cache.get(session.channelId);
      const channel = cached ?? await this.client.channels.fetch(session.channelId);
      if (!channel || !channel.isTextBased() || channel.isDMBased() || !channel.isSendable()) return;
      await (channel as SendableChannels).send({
        content,
        allowedMentions: mentionRunner ? { users: [session.runnerUserId] } : { parse: [] },
        components: components ? [components] : [],
      });
    } catch (err) {
      console.error(`[fire] 向频道 ${session.channelId} 发送提醒失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
