import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  ModalBuilder,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
  type User,
} from 'discord.js';
import type { FireReminderSessionState } from './types.js';
import {
  isValidFireAmount,
  isValidStarRefill,
  type FireRefill,
} from './services/fireReminderLogic.js';
import {
  type FireReminderService,
  manualFireButtonId,
  parseManualFireButtonId,
  parseRefillButtonId,
} from './services/fireReminderService.js';

// /fire 命令定义。runner 省略时操作自己；管理员可代其他主跑管理。
export function fireCommandDefinitions(): SlashCommandSubcommandsOnlyBuilder[] {
  const cmd = new SlashCommandBuilder()
    .setName('fire')
    .setDescription('主跑补火提醒')
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('按当前 T10 名次开始补火监控')
        .addIntegerOption((o) =>
          o.setName('rank').setDescription('当前 T10 名次 1 到 10').setMinValue(1).setMaxValue(10).setRequired(true),
        )
        .addIntegerOption((o) =>
          o.setName('fire').setDescription('当前火量，默认 99').setMinValue(0).setMaxValue(99),
        )
        .addUserOption((o) => o.setName('runner').setDescription('主跑 Discord 用户，默认自己')),
    )
    .addSubcommand((s) =>
      s
        .setName('refill')
        .setDescription('确认已经补火')
        .addStringOption((o) =>
          o
            .setName('method')
            .setDescription('补火方式')
            .setRequired(true)
            .addChoices({ name: '火罐补到 99', value: 'can' }, { name: '星石增加火量', value: 'star' }),
        )
        .addIntegerOption((o) =>
          o.setName('amount').setDescription('星石增加量，默认 90').setMinValue(10).setMaxValue(90),
        )
        .addUserOption((o) => o.setName('runner').setDescription('要操作的主跑，默认自己')),
    )
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('手动校正当前火量')
        .addIntegerOption((o) =>
          o.setName('amount').setDescription('当前火量 0 到 99').setMinValue(0).setMaxValue(99).setRequired(true),
        )
        .addUserOption((o) => o.setName('runner').setDescription('要操作的主跑，默认自己')),
    )
    .addSubcommand((s) =>
      s
        .setName('status')
        .setDescription('查看补火会话状态')
        .addUserOption((o) => o.setName('runner').setDescription('要查看的主跑，默认自己')),
    )
    .addSubcommand((s) =>
      s
        .setName('stop')
        .setDescription('停止补火监控')
        .addUserOption((o) => o.setName('runner').setDescription('要停止的主跑，默认自己')),
    );
  return [cmd];
}

export function registerFireCommands(client: Client, fire: FireReminderService): void {
  client.on('interactionCreate', (interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'fire') {
      void handleFireCommand(interaction, fire);
      return;
    }
    if (interaction.isButton()) {
      if (parseRefillButtonId(interaction.customId)) {
        void handleRefillButton(interaction, fire);
        return;
      }
      if (parseManualFireButtonId(interaction.customId)) {
        void handleManualFireButton(interaction, fire);
      }
      return;
    }
    if (interaction.isModalSubmit() && parseManualFireButtonId(interaction.customId)) {
      void handleManualFireModal(interaction, fire);
    }
  });
}

function isAdmin(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

function targetRunner(interaction: ChatInputCommandInteraction): User {
  return interaction.options.getUser('runner') ?? interaction.user;
}

function assertCanControl(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  runnerUserId: string,
): void {
  if (interaction.user.id !== runnerUserId && !isAdmin(interaction)) {
    throw new Error('只有主跑本人或服务器管理员可以操作这个补火会话');
  }
}

async function handleFireCommand(
  interaction: ChatInputCommandInteraction,
  fire: FireReminderService,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: '请在服务器频道中使用此命令。', ephemeral: true });
    return;
  }
  const channel = interaction.channel;
  if (!channel || channel.isDMBased() || !channel.isTextBased() || !channel.isSendable()) {
    await interaction.reply({ content: '请在可发送消息的服务器文本频道中使用。', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const runner = targetRunner(interaction);
  try {
    assertCanControl(interaction, runner.id);
    if (runner.bot) throw new Error('不能为机器人建立补火会话');

    if (sub === 'start') {
      const rank = interaction.options.getInteger('rank', true);
      const initialFire = interaction.options.getInteger('fire') ?? 99;
      if (!isValidFireAmount(initialFire)) throw new Error('初始火量必须是 0 到 99 的整数');
      await interaction.deferReply({ ephemeral: true });
      const session = await fire.startSession({
        guildId: interaction.guildId,
        channelId: channel.id,
        runnerUserId: runner.id,
        rank,
        initialFire,
      });
      await interaction.editReply(
        `已开始监控 **${session.gameName}**。\n启动时 PT#${rank}，UID ${session.gameUid}。\n` +
        `玩家等级：**${session.lastPlayerRank ?? '未知'}**。\n` +
        `当前火量：**${session.currentFire}**；每次 PT 上涨扣 **${session.firePerScoreIncrease} 火**。\n` +
        `提醒频道：<#${session.channelId}>。`,
      );
      return;
    }

    if (sub === 'refill') {
      const method = interaction.options.getString('method', true);
      const amount = interaction.options.getInteger('amount');
      let refill: FireRefill;
      if (method === 'can') {
        if (amount !== null) throw new Error('使用火罐时不需要填写增加量');
        refill = { method: 'can' };
      } else {
        const starAmount = amount ?? 90;
        if (!isValidStarRefill(starAmount)) throw new Error('星石增加量必须是 10 到 90 之间的 10 的倍数');
        refill = { method: 'star', amount: starAmount };
      }
      await interaction.deferReply({ ephemeral: true });
      const session = await fire.refill(interaction.guildId, runner.id, refill);
      await interaction.editReply(formatRefillResult(session, refill));
      return;
    }

    if (sub === 'set') {
      const amount = interaction.options.getInteger('amount', true);
      if (!isValidFireAmount(amount)) throw new Error('火量必须是 0 到 99 的整数');
      await interaction.deferReply({ ephemeral: true });
      const session = await fire.setFire(interaction.guildId, runner.id, amount);
      await interaction.editReply(`已将 **${session.gameName}** 的当前火量校正为 **${amount}**。`);
      return;
    }

    if (sub === 'status') {
      const session = fire.getSession(interaction.guildId, runner.id);
      if (!session) throw new Error('找不到该主跑的补火会话');
      const runUnit = session.firePerScoreIncrease === 9 ? '轮组曲' : '把';
      const status = session.status === 'active'
        ? `计数中，剩余 **${session.currentFire} 火**`
        : `等待确认补火，期间已检测 **${session.pendingGames}** ${runUnit}`;
      await interaction.reply({
        content:
          `**${session.gameName}**\nUID ${session.gameUid}\n` +
          `玩家等级：**${session.lastPlayerRank ?? '未知'}**\n` +
          `活动：**${session.eventName}**\n` +
          `每次 PT 上涨：**${session.firePerScoreIncrease} 火**\n` +
          `状态：${status}\n提醒频道：<#${session.channelId}>`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'stop') {
      await interaction.deferReply({ ephemeral: true });
      const session = await fire.removeSession(interaction.guildId, runner.id);
      await interaction.editReply(`已停止 **${session.gameName}** 的补火监控。`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`操作失败：${message}`);
    } else {
      await interaction.reply({ content: `操作失败：${message}`, ephemeral: true });
    }
  }
}

async function handleRefillButton(
  interaction: ButtonInteraction,
  fire: FireReminderService,
): Promise<void> {
  const parsed = parseRefillButtonId(interaction.customId);
  if (!parsed || !interaction.inCachedGuild()) return;
  try {
    assertCanControl(interaction, parsed.runnerUserId);
    await interaction.deferUpdate();
    const session = await fire.refill(
      interaction.guildId,
      parsed.runnerUserId,
      parsed.refill,
      parsed.cycle,
    );
    const label = formatRefillLabel(parsed.refill);
    await interaction.editReply({
      content: `${interaction.message.content}\n已确认${label}，当前剩余 **${session.currentFire} 火**。`,
      components: [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: `操作失败：${message}`, ephemeral: true });
    } else {
      await interaction.reply({ content: `操作失败：${message}`, ephemeral: true });
    }
  }
}

async function handleManualFireButton(
  interaction: ButtonInteraction,
  fire: FireReminderService,
): Promise<void> {
  const parsed = parseManualFireButtonId(interaction.customId);
  if (!parsed || !interaction.inCachedGuild()) return;
  try {
    assertCanControl(interaction, parsed.runnerUserId);
    const session = fire.getSession(interaction.guildId, parsed.runnerUserId);
    if (
      !session ||
      session.refillCycle !== parsed.cycle ||
      session.status !== 'awaiting_refill'
    ) {
      throw new Error('这个补火提示已经过期，请使用最新提示');
    }
    const input = new TextInputBuilder()
      .setCustomId('current_fire')
      .setLabel('现在实际剩余多少火')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('请输入 0 到 99')
      .setMinLength(1)
      .setMaxLength(2)
      .setRequired(true);
    const modal = new ModalBuilder()
      .setCustomId(manualFireButtonId(parsed.runnerUserId, parsed.cycle))
      .setTitle('手动填写当前火量')
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await interaction.reply({ content: `操作失败：${message}`, ephemeral: true });
  }
}

async function handleManualFireModal(
  interaction: ModalSubmitInteraction,
  fire: FireReminderService,
): Promise<void> {
  const parsed = parseManualFireButtonId(interaction.customId);
  if (!parsed || !interaction.inCachedGuild()) return;
  try {
    assertCanControl(interaction, parsed.runnerUserId);
    const raw = interaction.fields.getTextInputValue('current_fire').trim();
    if (!/^(?:0|[1-9]\d?)$/.test(raw)) {
      throw new Error('当前火量必须是 0 到 99 的整数');
    }
    const amount = Number(raw);
    if (!isValidFireAmount(amount)) throw new Error('当前火量必须是 0 到 99 的整数');
    if (!interaction.isFromMessage()) throw new Error('找不到原补火提示');
    await interaction.deferUpdate();
    const session = await fire.setFire(
      interaction.guildId,
      parsed.runnerUserId,
      amount,
      parsed.cycle,
    );
    await interaction.editReply({
      content:
        `${interaction.message.content}\n已手动将当前火量设为 **${session.currentFire} 火**。`,
      components: [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: `操作失败：${message}`, ephemeral: true });
    } else {
      await interaction.reply({ content: `操作失败：${message}`, ephemeral: true });
    }
  }
}

function formatRefillResult(
  session: FireReminderSessionState,
  refill: FireRefill,
): string {
  return `已确认${formatRefillLabel(refill)}，当前剩余 **${session.currentFire} 火**。`;
}

function formatRefillLabel(refill: FireRefill): string {
  return refill.method === 'can' ? '火罐补到 99' : `星石增加 ${refill.amount} 火`;
}
