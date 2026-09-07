import { guildLocale } from './services/state.js';
import { translator, withLocale } from './i18n.js';
import type { RepliableInteraction } from 'discord.js';

// 事件回调不等待 Promise；集中捕获最终失败，避免命令无响应或二次回复再次拒绝。
export async function reportInteractionError(interaction: RepliableInteraction, err: unknown): Promise<void> {
  console.error('[commands] 交互处理失败:', err);
  try {
    const content = translator(guildLocale(interaction.guildId))("操作失败，请稍后重试。");
    if (interaction.deferred && interaction.isChatInputCommand()) {
      await interaction.editReply(content);
    } else if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch (replyError) {
    console.error('[commands] 发送失败提示失败:', replyError);
  }
}

// All command/button/modal entry points share locale isolation and final error handling.
export async function runInteraction(
  interaction: RepliableInteraction,
  handle: () => Promise<void>,
): Promise<void> {
  try {
    await withLocale(guildLocale(interaction.guildId), handle);
  } catch (err) {
    await reportInteractionError(interaction, err);
  }
}
