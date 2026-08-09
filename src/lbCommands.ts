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

// /lb 命令定义
export function lbCommandDefinitions(): SlashCommandSubcommandsOnlyBuilder[] {
  const cmd = new SlashCommandBuilder()
    .setName('lb')
    .setDescription('LiveBoost 语音朗读与 AI 中日互译（仅 bot 作者可用）')
    .addSubcommand((s) =>
      s
        .setName('join')
        .setDescription('加入你的语音频道并绑定文本频道')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('监听的文本频道（默认当前频道）')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        ),
    )
    .addSubcommand((s) => s.setName('leave').setDescription('退出语音并解除绑定'))
    .addSubcommand((s) =>
      s
        .setName('translate')
        .setDescription('AI 中日互译开关')
        .addStringOption((o) =>
          o
            .setName('state')
            .setDescription('on 开启 / off 关闭')
            .setRequired(true)
            .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('speak')
        .setDescription('TTS 朗读开关')
        .addStringOption((o) =>
          o
            .setName('state')
            .setDescription('on 开启 / off 关闭')
            .setRequired(true)
            .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
        ),
    )
    .addSubcommand((s) => s.setName('status').setDescription('查看当前绑定与开关状态'));

  return [cmd];
}

// 注册 interaction 分发
export function registerLbCommands(client: Client, assist: AssistService): void {
  client.on('interactionCreate', (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'lb') return;
    void handleLbCommand(interaction, assist);
  });
}

async function handleLbCommand(
  interaction: ChatInputCommandInteraction,
  assist: AssistService,
): Promise<void> {
  // 作者校验：BOT_OWNER_ID 未配置时任何人都不能用，并给出配置提示
  if (!config.botOwnerId) {
    await interaction.reply({
      content: '未配置 BOT_OWNER_ID，无法使用 /lb。请在 .env 中填入 bot 作者的 Discord 用户 ID。',
      ephemeral: true,
    });
    return;
  }
  if (interaction.user.id !== config.botOwnerId) {
    await interaction.reply({ content: '此命令仅 bot 作者可用。', ephemeral: true });
    return;
  }
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: '请在服务器频道中使用此命令。', ephemeral: true });
    return;
  }

  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();

  if (sub === 'join') {
    await handleJoin(interaction, assist);
  } else if (sub === 'leave') {
    await assist.clearSession(guildId);
    await interaction.reply('已退出语音并解除绑定。');
  } else if (sub === 'translate' || sub === 'speak') {
    const on = interaction.options.getString('state') === 'on';
    if (sub === 'translate') {
      await assist.setTranslate(guildId, on);
    } else {
      await assist.setSpeak(guildId, on);
    }
    const label = sub === 'translate' ? 'AI 互译' : 'TTS 朗读';
    await interaction.reply(`${label}已${on ? '开启' : '关闭'}。`);
  } else if (sub === 'status') {
    const session = getState().voiceSessions[guildId];
    const count = Object.keys(getState().voiceSessions).length;
    if (!session) {
      await interaction.reply(
        `本服务器未绑定会话，用 \`/lb join\` 开始。\n` +
          `当前连接：**${count}/${config.maxVoiceGuilds}** 个服务器`,
      );
      return;
    }
    await interaction.reply(
      `**当前会话**\n` +
        `语音频道：<#${session.voiceChannelId}>\n` +
        `监听频道：<#${session.textChannelId}>\n` +
        `TTS 朗读：${session.speakEnabled ? '开启' : '关闭'}\n` +
        `AI 互译：${session.translateEnabled ? '开启' : '关闭'}\n` +
        `当前连接：**${count}/${config.maxVoiceGuilds}** 个服务器`,
    );
  }
}

async function handleJoin(
  interaction: ChatInputCommandInteraction<'cached'>,
  assist: AssistService,
): Promise<void> {
  const voiceChannel = interaction.member.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: '你不在任何语音频道中，请先加入语音频道。', ephemeral: true });
    return;
  }

  // 绑定文本频道：选项优先，默认当前频道
  const opt = interaction.options.getChannel('channel');
  const textChannel =
    opt && !opt.isDMBased() && opt.isTextBased()
      ? opt
      : interaction.channel;
  if (!textChannel || textChannel.isDMBased() || !textChannel.isTextBased()) {
    await interaction.reply({ content: '请指定一个有效的文本频道。', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  try {
    await assist.bind(interaction.guildId, voiceChannel.id, textChannel.id);
    await interaction.editReply(
      `已加入语音频道 <#${voiceChannel.id}>，并绑定文本频道 <#${textChannel.id}>。`
    );
  } catch (err) {
    await interaction.editReply(`加入失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
