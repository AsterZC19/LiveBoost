import { PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from 'discord.js';
import { isLocale, translator, type Locale } from './i18n.js';
import { getState, guildLocale, saveState } from './services/state.js';
import { runInteraction } from './interactionErrors.js';

export function settingCommandDefinitions() {
  return [new SlashCommandBuilder()
    .setName('setting')
    .setDescription('服务器设置')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('language').setDescription('设置本服务器的显示语言')
      .addStringOption(o => o.setName('language').setDescription('语言').setRequired(true)
        .addChoices({ name: '日本語', value: 'ja' }, { name: '简体中文', value: 'zh-cn' })))
    .addSubcommand(s => s.setName('status').setDescription('查看本服务器的语言设置'))];
}

export function registerSettingCommands(client: Client): void {
  client.on('interactionCreate', interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'setting') return;
    void runInteraction(interaction, () => handleSettingCommand(interaction));
  });
}

const languageName = (locale: Locale) => locale === 'ja' ? '日本語' : '简体中文';

export async function handleSettingCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const t = translator(guildLocale(interaction.guildId));
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: t('请在服务器频道中使用此命令。'), ephemeral: true });
    return;
  }
  if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: t('你没有权限使用此命令（需要管理员权限）。'), ephemeral: true });
    return;
  }
  if (interaction.options.getSubcommand() === 'status') {
    await interaction.reply({ content: t('本服务器语言：{0}', [languageName(guildLocale(interaction.guildId))]), ephemeral: true });
    return;
  }
  const locale = interaction.options.getString('language', true);
  if (!isLocale(locale)) {
    await interaction.reply({ content: t('不支持的语言。请选择 ja 或 zh-cn。'), ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const languages = getState().guildLanguages;
  const previous = languages[interaction.guildId];
  languages[interaction.guildId] = locale;
  try {
    await saveState();
  } catch (err) {
    if (languages[interaction.guildId] === locale) {
      if (previous) languages[interaction.guildId] = previous;
      else delete languages[interaction.guildId];
    }
    throw err;
  }
  await interaction.editReply(translator(locale)('已将本服务器语言设为 {0}。', [languageName(locale)]));
}
