import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectTextLang,
  hasMeaningfulText,
  parseAiJson,
  validateSpeechText,
} from '../src/services/ai.js';

test('hasMeaningfulText and detectTextLang classify text accurately', () => {
  assert.equal(hasMeaningfulText('... (´・ω・`)'), false);
  assert.equal(hasMeaningfulText('こんにちは'), true);
  assert.equal(hasMeaningfulText('abc123'), true);

  assert.equal(detectTextLang('今天打几把'), 'zh');
  assert.equal(detectTextLang('今日よろしくお願いします'), 'ja');
  assert.equal(detectTextLang('カタカナ'), 'ja');
});

test('validateSpeechText permits only inserted whitespace', () => {
  assert.equal(validateSpeechText('KiLLKiSS bot', 'KiLL KiSS bot'), 'KiLL KiSS bot');
  assert.equal(validateSpeechText('hello world', 'hello  world'), 'hello  world');
  assert.equal(validateSpeechText('hello', 'hi'), null);
  assert.equal(validateSpeechText('hello', 'hello!'), null);
  assert.equal(validateSpeechText('hello', 'hell'), null);
});

test('parseAiJson handles fenced JSON, tag stripping, segment validation, and fallback', () => {
  const payload = '```json\n' + JSON.stringify({
    language: 'ja',
    mixed: true,
    translation_zh: '<user_message>晚上好 一起打吗</user_message>',
    translation_ja: 'こんばんは 一緒にやりますか',
    speech_text: '晚上好 KiLL KiSS',
    speech_name: 'Alice',
    segments: [
      { text: '晚上好', language: 'zh' },
      { text: 'KiLLKiSS', language: 'ja' },
    ],
    name_lang: 'ja',
  }) + '\n```';

  const res = parseAiJson(payload, '晚上好 KiLLKiSS', 'Alice');
  assert.equal(res.aiOk, true);
  assert.equal(res.language, 'ja');
  assert.equal(res.mixed, true);
  assert.equal(res.zh, '晚上好 一起打吗');
  assert.equal(res.ja, 'こんばんは 一緒にやりますか');
  assert.equal(res.speechText, '晚上好 KiLL KiSS');
  assert.equal(res.speechName, 'Alice');
  assert.equal(res.nameLang, 'ja');
  assert.deepEqual(res.segments, [
    { text: '晚上好', language: 'zh' },
    { text: 'KiLLKiSS', language: 'ja' },
  ]);

  // Mismatched segment text should be discarded (segments -> null)
  const badSegments = JSON.stringify({
    language: 'zh',
    mixed: true,
    translation_zh: '你好',
    translation_ja: 'こんにちは',
    segments: [{ text: '被篡改的文本', language: 'zh' }],
  });
  const res2 = parseAiJson(badSegments, '你好');
  assert.equal(res2.aiOk, true);
  assert.equal(res2.segments, null);

  // Invalid JSON falls back safely
  const bad = parseAiJson('not json at all', 'テスト');
  assert.equal(bad.aiOk, false);
  assert.equal(bad.language, 'ja');
  assert.equal(bad.zh, 'テスト');
  assert.equal(bad.ja, 'テスト');
});
