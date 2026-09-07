import { t } from './i18n.js';
import { runInteraction } from './interactionErrors.js';
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
import { formatTime } from './services/timeFormat.js';
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
    .addSubcommand((s) => s.setName('status').setDescription('查看当前活动与本频道推送状态'));

  if (config.requireAdmin) {
    cmd.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  }
  return [cmd];
}

// 注册 interaction 分发
export function registerCommands(client: Client, pusher: Pusher): void {
  client.on('interactionCreate', (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'push') return;
    void runInteraction(interaction, () => handlePushCommand(interaction, pusher));
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
    await interaction.reply({ content: t("请在服务器频道中使用此命令。"), ephemeral: true });
    return;
  }
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: t("你没有权限使用此命令（需要管理员权限）。"), ephemeral: true });
    return;
  }

  const channel = interaction.channel;
  if (!channel || channel.isDMBased() || !channel.isTextBased()) {
    await interaction.reply({ content: t("此命令只能在文本频道中使用。"), ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const state = getState();

  if (sub === 'interval' || sub === 'hourly') {
    await interaction.deferReply();
    const on = interaction.options.getString('state') === 'on';
    if (on) {
      // 一个频道只对应一种推送类型，开启时直接覆盖另一种
      state.enabledChannels[channel.id] = sub;
    } else if (state.enabledChannels[channel.id] === sub) {
      delete state.enabledChannels[channel.id];
    }
    await saveState();
    const label = sub === 'interval' ? t("分速推送") : t("时速推送");
    await interaction.editReply(t("已{0}本频道（<#{1}>）的{2}。", [on ? t("开启") : t("关闭"), channel.id, label]));
  } else if (sub === 'status') {
    await interaction.deferReply();
    const type = state.enabledChannels[channel.id];
    const typeLine = type === 'interval'
      ? t("分速推送（开启）")
      : type === 'hourly'
        ? t("时速推送（开启）")
        : t("未开启");
    const event = await findCurrentEvent();
    const eventLine = event
      ? `**${event.name}**\n\`${eventTypeLabel(event.event_type)}\`　${formatTime(event.start_at)} ~ ${formatTime(event.end_at)}`
      : t("未找到当前活动");
    await interaction.editReply(
      t("**本频道推送状态**\n") +
        t("当前：{0}\n\n", [typeLine]) +
        t("**当前活动**：{0}", [eventLine]),
    );
  }
}
