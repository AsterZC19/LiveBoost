import test from 'node:test';
import assert from 'node:assert/strict';
import { currentLocale, t, withLocale } from '../src/i18n.js';
import { localizeCommand } from '../src/commandLocalization.js';
import { commandDefinitions } from '../src/commands.js';
import { lbCommandDefinitions } from '../src/lbCommands.js';
import { transCommandDefinitions } from '../src/translate.js';
import { fireCommandDefinitions } from '../src/fireCommands.js';
import { settingCommandDefinitions } from '../src/settingCommands.js';

test('translate interpolates placeholders once without re-interpolating user data', () => {
  const rendered = withLocale('ja', () =>
    t('已{0}本频道（<#{1}>）的{2}。', ['{1}', '999', '通知']),
  );
  assert.equal(rendered, 'このチャンネル（<#999>）の通知を{1}にしました。');
});

test('withLocale isolates locale across concurrent async operations', async () => {
  const [rJa, rZh] = await Promise.all([
    withLocale('ja', async () => {
      await new Promise((r) => setTimeout(r, 10));
      return currentLocale();
    }),
    withLocale('zh-cn', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return currentLocale();
    }),
  ]);
  assert.equal(rJa, 'ja');
  assert.equal(rZh, 'zh-cn');
  assert.equal(currentLocale(), 'zh-cn');
});

test('all slash commands localize cleanly with ja and zh-CN descriptions', () => {
  const defs = [
    ...commandDefinitions(),
    ...lbCommandDefinitions(),
    ...transCommandDefinitions(),
    ...fireCommandDefinitions(),
    ...settingCommandDefinitions(),
  ];

  assert.equal(defs.length, 5);
  for (const def of defs) {
    const localized = localizeCommand(def);
    assert.ok(localized.description_localizations?.ja);
    assert.ok(localized.description_localizations?.['zh-CN']);
    for (const opt of localized.options ?? []) {
      assert.ok(opt.description_localizations?.ja, `missing ja localization for option ${opt.name}`);
    }
  }
});
