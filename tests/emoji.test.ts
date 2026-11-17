import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containsEmojiName,
  removeDiscordCustomEmojis,
  replaceEmoji,
} from '../src/services/emoji.js';

test('removeDiscordCustomEmojis strips static, animated, and alias custom emojis', () => {
  assert.equal(
    removeDiscordCustomEmojis('hi <:kasumi:123456> <a:spin:789> :custom_alias: world'),
    'hi    world',
  );
  // Leaves colons with whitespace untouched
  assert.equal(removeDiscordCustomEmojis('10:30 meeting: hello'), '10:30 meeting: hello');
});

test('containsEmojiName and replaceEmoji handle standard, flag, keycap, and skin-tone emojis', () => {
  assert.equal(containsEmojiName('👍'), true);
  assert.equal(containsEmojiName('🇨🇳'), true);
  assert.equal(containsEmojiName('1️⃣'), true);
  assert.equal(containsEmojiName('<:myemoji:123>'), false);

  assert.equal(replaceEmoji('👍', 'zh'), '点赞');
  assert.equal(replaceEmoji('👍', 'ja'), 'いいね');
  assert.equal(replaceEmoji('👍🏻', 'zh'), '点赞：较浅肤色');
  assert.equal(replaceEmoji('🇨🇳', 'zh'), '中国国旗');
  assert.equal(replaceEmoji('1️⃣', 'ja'), '1のキー');
});
