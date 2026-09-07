import type { LocalizationMap, SlashCommandBuilder, SlashCommandSubcommandsOnlyBuilder } from 'discord.js';
import { ja } from './locales/ja.js';
import { translate, type MessageKey } from './i18n.js';

interface LocalizableNode {
  description: string;
  description_localizations?: LocalizationMap | null;
  options?: readonly LocalizableNode[];
  choices?: readonly { name: string; name_localizations?: LocalizationMap | null }[];
}

function isMessageKey(source: string): source is MessageKey {
  return Object.hasOwn(ja, source);
}

function localized(source: MessageKey): LocalizationMap {
  return { ja: translate(source, [], 'ja'), 'zh-CN': source };
}

function localizeNode(node: LocalizableNode): void {
  if (!isMessageKey(node.description)) {
    throw new Error(`Missing command translation: ${node.description}`);
  }
  node.description_localizations = localized(node.description);
  for (const choice of node.choices ?? []) {
    if (isMessageKey(choice.name)) choice.name_localizations = localized(choice.name);
  }
  for (const option of node.options ?? []) localizeNode(option);
}

// Discord uses the client's language for command descriptions. Guild settings govern replies.
// The source description and choice name remain the Simplified Chinese fallback.
export function localizeCommand(command: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder) {
  const data = command.toJSON();
  localizeNode(data);
  return data;
}
