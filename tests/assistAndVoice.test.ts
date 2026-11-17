import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from 'discord.js';
import {
  applySpeechSpacingToSegments,
  buildSpeakerAttribution,
  cleanForSpeech,
  resolveUserMentions,
  segmentText,
} from '../src/services/assistService.js';
import { isSpeakableChunk, splitForTts } from '../src/services/voiceService.js';

test('buildSpeakerAttribution never emits standalone punctuation segments across languages', () => {
  const cross1 = buildSpeakerAttribution('张三', null, 'ja');
  assert.deepEqual(cross1, [{ text: '张三、', language: 'zh' }]);
  assert.ok(cross1.every((seg) => isSpeakableChunk(seg.text)));

  const cross2 = buildSpeakerAttribution('さくら', null, 'zh');
  assert.deepEqual(cross2, [{ text: 'さくら，', language: 'ja' }]);
  assert.ok(cross2.every((seg) => isSpeakableChunk(seg.text)));

  const same = buildSpeakerAttribution('Kanade', 'ja', 'ja');
  assert.deepEqual(same, [{ text: 'Kanade、', language: 'ja' }]);
});

test('resolveUserMentions replaces <@id> and <@!id> with member or user displayName', () => {
  const fakeMsg = {
    mentions: {
      members: new Map([['111', { displayName: 'GuildAlice' }]]),
      users: new Map([['222', { displayName: 'UserBob' }]]),
    },
  } as unknown as Message;

  assert.equal(
    resolveUserMentions(fakeMsg, '<@111> <@!222> <@999> hello'),
    'GuildAlice UserBob <@999> hello',
  );
});

test('cleanForSpeech strips kaomoji symbols and custom emojis while keeping CJK, kana, digits, and standard emoji', () => {
  assert.equal(
    cleanForSpeech('你好 ☆★´ω` <:stamp:123> 👍 世界'),
    '你好 👍 世界',
  );
  assert.equal(cleanForSpeech('你好 (test)'), '你好 (test)');
});

test('applySpeechSpacingToSegments preserves zh/ja boundaries while adopting inserted spaces', () => {
  const segs = applySpeechSpacingToSegments('晚上好 KiLL KiSS', [
    { text: '晚上好', language: 'zh' },
    { text: 'KiLLKiSS', language: 'ja' },
  ]);
  assert.deepEqual(segs, [
    { text: '晚上好', language: 'zh' },
    { text: 'KiLL KiSS', language: 'ja' },
  ]);
});

test('segmentText splits mixed Chinese and Japanese sentences by script', () => {
  const segs = segmentText('今天晚上打吗，よろしくおねがいします！');
  assert.deepEqual(segs, [
    { text: '今天晚上打吗，', language: 'zh' },
    { text: 'よろしくおねがいします！', language: 'ja' },
  ]);
});

test('isSpeakableChunk and splitForTts filter punctuation-only chunks and respect bounds', () => {
  assert.equal(isSpeakableChunk('、'), false);
  assert.equal(isSpeakableChunk('...！？'), false);
  assert.equal(isSpeakableChunk('ー'), true);
  assert.equal(isSpeakableChunk('々'), true);
  assert.equal(isSpeakableChunk('テスト'), true);
  assert.equal(isSpeakableChunk('00999'), true);

  const longText = '第一句话比较长所以需要按句切分。' + '第二句话继续写下去直到超过目标长度。'.repeat(5);
  const chunks = splitForTts(longText, 30, 50);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), longText);
  assert.ok(chunks.every((c) => Array.from(c).length <= 50));
});
