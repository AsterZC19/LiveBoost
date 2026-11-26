import { t } from './i18n.js';
import { errorMessage } from './errors.js';
import { runInteraction } from './interactionErrors.js';
import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  MessageFlags,
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
  isValidStarRefill,
  type FireRefill,
} from './services/fireReminderLogic.js';
import {
  type FireReminderService,
  type ParsedManualFireButton,
  type ParsedRefillButton,
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
      void runInteraction(interaction, () => handleFireCommand(interaction, fire));
      return;
    }
    if (interaction.isButton()) {
      const refill = parseRefillButtonId(interaction.customId);
      if (refill) {
        void runInteraction(interaction, () => handleRefillButton(interaction, fire, refill));
        return;
      }
      const manual = parseManualFireButtonId(interaction.customId);
      if (manual) {
        void runInteraction(interaction, () => handleManualFireButton(interaction, fire, manual));
      }
      return;
    }
    if (interaction.isModalSubmit()) {
      const manual = parseManualFireButtonId(interaction.customId);
      if (manual) {
        void runInteraction(interaction, () => handleManualFireModal(interaction, fire, manual));
      }
    }
  });
}

type CachedFireInteraction =
  | ChatInputCommandInteraction<'cached'>
  | ButtonInteraction<'cached'>
  | ModalSubmitInteraction<'cached'>;

function targetRunner(interaction: ChatInputCommandInteraction<'cached'>): User {
  return interaction.options.getUser('runner') ?? interaction.user;
}

function assertCanControl(interaction: CachedFireInteraction, runnerUserId: string): void {
  if (interaction.user.id !== runnerUserId && !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    throw new Error(t("只有主跑本人或服务器管理员可以操作这个补火会话"));
  }
}

function assertSessionForMessage(
  fire: FireReminderService,
  guildId: string,
  runnerUserId: string,
  messageCreatedAt: number,
): FireReminderSessionState {
  const session = fire.getSession(guildId, runnerUserId);
  if (!session || messageCreatedAt < session.createdAt) {
    throw new Error(t("这个补火提示属于已结束的会话，请使用最新提示"));
  }
  return session;
}

async function replyFireError(interaction: CachedFireInteraction, err: unknown): Promise<void> {
  const content = t("操作失败：{0}", [errorMessage(err)]);
  if (interaction.deferred && interaction.isChatInputCommand()) {
    await interaction.editReply(content);
  } else if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

async function handleFireCommand(
  interaction: ChatInputCommandInteraction,
  fire: FireReminderService,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: t("请在服务器频道中使用此命令。"), flags: MessageFlags.Ephemeral });
    return;
  }
  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({ content: t("请在可发送消息的服务器文本频道中使用。"), flags: MessageFlags.Ephemeral });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const runner = targetRunner(interaction);
  try {
    assertCanControl(interaction, runner.id);
    if (runner.bot) throw new Error(t("不能为机器人建立补火会话"));

    if (sub === 'start') {
      const rank = interaction.options.getInteger('rank', true);
      const initialFire = interaction.options.getInteger('fire') ?? 99;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const session = await fire.startSession({
        guildId: interaction.guildId,
        channelId: channel.id,
        runnerUserId: runner.id,
        rank,
        initialFire,
      });
      await interaction.editReply(
        t("已开始监控 **{0}**。\n启动时 PT#{1}，UID {2}。\n", [session.gameName, rank, session.gameUid]) +
        t("玩家等级：**{0}**。\n", [session.lastPlayerRank ?? t("未知")]) +
        t("当前火量：**{0}**；每次 PT 上涨扣 **{1} 火**。\n", [session.currentFire, session.firePerScoreIncrease]) +
        t("提醒频道：<#{0}>。", [session.channelId]),
      );
      return;
    }

    if (sub === 'refill') {
      const method = interaction.options.getString('method', true);
      const amount = interaction.options.getInteger('amount');
      let refill: FireRefill;
      if (method === 'can') {
        if (amount !== null) throw new Error(t("使用火罐时不需要填写增加量"));
        refill = { method: 'can' };
      } else {
        const starAmount = amount ?? 90;
        if (!isValidStarRefill(starAmount)) throw new Error(t("星石增加量必须是 10 到 90 之间的 10 的倍数"));
        refill = { method: 'star', amount: starAmount };
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const session = await fire.refill(interaction.guildId, runner.id, refill);
      await interaction.editReply(formatRefillResult(session, refill));
      return;
    }

    if (sub === 'set') {
      const amount = interaction.options.getInteger('amount', true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const session = await fire.setFire(interaction.guildId, runner.id, amount);
      await interaction.editReply(t("已将 **{0}** 的当前火量校正为 **{1}**。", [session.gameName, amount]));
      return;
    }

    if (sub === 'status') {
      const session = fire.getSession(interaction.guildId, runner.id);
      if (!session) throw new Error(t("找不到该主跑的补火会话"));
      const runUnit = session.firePerScoreIncrease === 9 ? t("轮组曲") : t("把");
      const status = session.status === 'active'
        ? t("计数中，剩余 **{0} 火**", [session.currentFire])
        : t("等待确认补火，期间已检测 **{0}** {1}", [session.pendingGames, runUnit]);
      await interaction.reply({
        content:
          `**${session.gameName}**\nUID ${session.gameUid}\n` +
          t("玩家等级：**{0}**\n", [session.lastPlayerRank ?? t("未知")]) +
          t("活动：**{0}**\n", [session.eventName]) +
          t("每次 PT 上涨：**{0} 火**\n", [session.firePerScoreIncrease]) +
          t("状态：{0}\n提醒频道：<#{1}>", [status, session.channelId]),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'stop') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const session = await fire.removeSession(interaction.guildId, runner.id);
      await interaction.editReply(t("已停止 **{0}** 的补火监控。", [session.gameName]));
    }
  } catch (err) {
    await replyFireError(interaction, err);
  }
}

async function handleRefillButton(
  interaction: ButtonInteraction,
  fire: FireReminderService,
  parsed: ParsedRefillButton,
): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  try {
    assertCanControl(interaction, parsed.runnerUserId);
    assertSessionForMessage(fire, interaction.guildId, parsed.runnerUserId, interaction.message.createdTimestamp);
    await interaction.deferUpdate();
    const session = await fire.refill(
      interaction.guildId,
      parsed.runnerUserId,
      parsed.refill,
      parsed.cycle,
    );
    await interaction.editReply({
      content: interaction.message.content,
      components: [],
    });
    await interaction.followUp({
      content: formatRefillResult(session, parsed.refill),
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    await replyFireError(interaction, err);
  }
}

async function handleManualFireButton(
  interaction: ButtonInteraction,
  fire: FireReminderService,
  parsed: ParsedManualFireButton,
): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  try {
    assertCanControl(interaction, parsed.runnerUserId);
    const session = assertSessionForMessage(
      fire,
      interaction.guildId,
      parsed.runnerUserId,
      interaction.message.createdTimestamp,
    );
    if (session.refillCycle !== parsed.cycle || session.status !== 'awaiting_refill') {
      throw new Error(t("这个补火提示已经过期，请使用最新提示"));
    }
    const input = new TextInputBuilder()
      .setCustomId('current_fire')
      .setLabel(t("现在实际剩余多少火"))
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(t("请输入 0 到 99"))
      .setMinLength(1)
      .setMaxLength(2)
      .setRequired(true);
    const modal = new ModalBuilder()
      .setCustomId(manualFireButtonId(parsed.runnerUserId, parsed.cycle))
      .setTitle(t("手动填写当前火量"))
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
  } catch (err) {
    await replyFireError(interaction, err);
  }
}

async function handleManualFireModal(
  interaction: ModalSubmitInteraction,
  fire: FireReminderService,
  parsed: ParsedManualFireButton,
): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  try {
    assertCanControl(interaction, parsed.runnerUserId);
    if (!interaction.isFromMessage()) throw new Error(t("找不到原补火提示"));
    assertSessionForMessage(fire, interaction.guildId, parsed.runnerUserId, interaction.message.createdTimestamp);
    const raw = interaction.fields.getTextInputValue('current_fire').trim();
    if (!/^(?:0|[1-9]\d?)$/.test(raw)) {
      throw new Error(t("当前火量必须是 0 到 99 的整数"));
    }
    await interaction.deferUpdate();
    const session = await fire.setFire(
      interaction.guildId,
      parsed.runnerUserId,
      Number(raw),
      parsed.cycle,
    );
    await interaction.editReply({
      content: interaction.message.content,
      components: [],
    });
    await interaction.followUp({
      content: t("已手动将当前火量设为 **{0} 火**。", [session.currentFire]),
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    await replyFireError(interaction, err);
  }
}

function formatRefillResult(
  session: FireReminderSessionState,
  refill: FireRefill,
): string {
  return t("已确认{0}，当前剩余 **{1} 火**。", [formatRefillLabel(refill), session.currentFire]);
}

function formatRefillLabel(refill: FireRefill): string {
  return refill.method === 'can' ? t("火罐补到 99") : t("星石增加 {0} 火", [refill.amount]);
}
