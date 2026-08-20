import {
  type ChatInputCommandInteraction,
  type Client,
  ChannelType,
  SlashCommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import { config } from './config.js';
import { getState } from './services/state.js';
import type { AssistService } from './services/assistService.js';

// /trans 命令定义。此功能独立进行 AI 中日互译，不依赖语音，所有服务器成员均可使用。
export function transCommandDefinitions(): SlashCommandSubcommandsOnlyBuilder[] {
  const cmd = new SlashCommandBuilder()
    .setName('trans')
    .setDescription('AI 中日互译（独立于语音，所有成员可用）')
    .addSubcommand((s) =>
      s
        .setName('on')
        .setDescription('在本频道（或指定频道）启用 AI 中日互译')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('启用互译的文本频道（默认当前频道）')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('off')
        .setDescription('关闭本频道（或指定频道）的 AI 中日互译')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('关闭互译的文本频道（默认当前频道）')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        ),
    )
    .addSubcommand((s) => s.setName('status').setDescription('查看独立 AI 互译状态与占用数'));

  return [cmd];
}

// 注册 interaction 分发。不设置作者和管理员限制，所有成员均可使用。
export function registerTransCommands(client: Client, assist: AssistService): void {
  client.on('interactionCreate', (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'trans') return;
    void handleTransCommand(interaction, assist);
  });
}

async function handleTransCommand(
  interaction: ChatInputCommandInteraction,
  assist: AssistService,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: '请在服务器频道中使用此命令。', ephemeral: true });
    return;
  }
  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();

  if (sub === 'on' || sub === 'off') {
    // 目标频道：选项优先，默认当前频道
    const opt = interaction.options.getChannel('channel');
    const textChannel =
      opt && !opt.isDMBased() && opt.isTextBased()
        ? opt
        : interaction.channel;
    if (!textChannel || textChannel.isDMBased() || !textChannel.isTextBased()) {
      await interaction.reply({ content: '请指定一个有效的文本频道。', ephemeral: true });
      return;
    }

    if (sub === 'on') {
      if (!config.aiApiKey) {
        await interaction.reply({
          content: '未配置 AI_API_KEY，AI 互译不可用。请联系管理员配置。',
          ephemeral: true,
        });
        return;
      }
      try {
        await assist.bindTranslate(guildId, textChannel.id);
        await interaction.reply(`已在本频道 <#${textChannel.id}> 启用 AI 中日互译。`);
      } catch (err) {
        await interaction.reply({
          content: `启用失败：${err instanceof Error ? err.message : String(err)}`,
          ephemeral: true,
        });
      }
    } else {
      await assist.unbindTranslate(textChannel.id);
      await interaction.reply(`已关闭本频道 <#${textChannel.id}> 的 AI 中日互译。`);
    }
  } else if (sub === 'status') {
    const current = getState().translateSessions[interaction.channelId];
    const count = Object.keys(getState().translateSessions).length;
    await interaction.reply(
      `**独立 AI 互译状态**\n` +
        `本频道：${current ? '已启用' : '未启用'}\n` +
        `当前占用：**${count}/${config.maxTranslateChannels}** 个互译频道`,
    );
  }
}
