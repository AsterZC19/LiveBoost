import {
  type ChatInputCommandInteraction,
  type Client,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import { config } from './config.js';
import { eventTypeLabel, findCurrentEvent } from './services/eventService.js';
import type { Pusher } from './services/pusher.js';
import { formatTime } from './services/renderer.js';
import { getState, saveState } from './services/state.js';

// /push 命令定义
export function commandDefinitions(): SlashCommandSubcommandsOnlyBuilder[] {
  const cmd = new SlashCommandBuilder()
    .setName('push')
    .setDescription('T10 推送控制')
    .addSubcommand((s) =>
      s
        .setName('interval')
        .setDescription('分速推送开关')
        .addStringOption((o) =>
          o
            .setName('state')
            .setDescription('开启或关闭')
            .setRequired(true)
            .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('hourly')
        .setDescription('时速推送开关')
        .addStringOption((o) =>
          o
            .setName('state')
            .setDescription('开启或关闭')
            .setRequired(true)
            .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
        ),
    )
    .addSubcommand((s) => s.setName('status').setDescription('查看当前活动与本频道推送状态'))
    // .addSubcommand((s) => s.setName('now').setDescription('测试'));

  if (config.requireAdmin) {
    cmd.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  }
  return [cmd];
}

// 注册 interaction 分发
export function registerCommands(client: Client, pusher: Pusher): void {
  client.on('interactionCreate', (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'push') return;
    void handlePushCommand(interaction, pusher);
  });
}

function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  if (!config.requireAdmin) return true;
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

async function handlePushCommand(
  interaction: ChatInputCommandInteraction,
  pusher: Pusher,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: '请在服务器频道中使用此命令。', ephemeral: true });
    return;
  }
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: '你没有权限使用此命令（需要管理员权限）。', ephemeral: true });
    return;
  }

  const channel = interaction.channel;
  if (!channel || channel.isDMBased() || !channel.isTextBased()) {
    await interaction.reply({ content: '此命令只能在文本频道中使用。', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const state = getState();

  if (sub === 'interval' || sub === 'hourly') {
    const on = interaction.options.getString('state') === 'on';
    if (on) {
      // 一个频道只对应一种推送类型，开启时直接覆盖另一种
      state.enabledChannels[channel.id] = sub;
    } else if (state.enabledChannels[channel.id] === sub) {
      delete state.enabledChannels[channel.id];
    }
    await saveState();
    const label = sub === 'interval' ? '分速推送' : '时速推送';
    await interaction.reply(`已${on ? '开启' : '关闭'}本频道（<#${channel.id}>）的${label}。`);
  } else if (sub === 'status') {
    const type = state.enabledChannels[channel.id];
    const typeLine = type === 'interval'
      ? '分速推送（开启）'
      : type === 'hourly'
        ? '时速推送（开启）'
        : '未开启';
    const event = await findCurrentEvent();
    const eventLine = event
      ? `**${event.name}**\n\`${eventTypeLabel(event.event_type)}\`　${formatTime(event.start_at)} ~ ${formatTime(event.end_at)}`
      : '未找到当前活动';
    await interaction.reply(
      `**本频道推送状态**\n` +
        `当前：${typeLine}\n\n` +
        `**当前活动**：${eventLine}`,
    );
  } else if (sub === 'now') {
    await interaction.deferReply();
    try {
      await pusher.pushNow(channel);
      await interaction.editReply('已推送当前分速增量图片到本频道。');
    } catch (err) {
      await interaction.editReply(`推送失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
