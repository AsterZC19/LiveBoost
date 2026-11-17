import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getState, guildLocale, loadState, saveState } from '../src/services/state.js';

test('state loadState and saveState handle directory creation, migrations, and link pruning', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'liveboost-state-'));
  try {
    const nestedFile = path.join(tmpDir, 'nested', 'state.json');

    // Missing file resets to default state cleanly
    await loadState(nestedFile);
    assert.equal(getState().currentEventId, null);
    assert.deepEqual(getState().enabledChannels, {});

    // Saving creates missing parent directories atomically
    getState().guildLanguages['g1'] = 'ja';
    getState().enabledChannels['c1'] = 'interval';
    await saveState(nestedFile);
    assert.equal(guildLocale('g1'), 'ja');
    assert.equal(guildLocale('unknown'), 'zh-cn');

    // Legacy migrations & malformed item filtering + translation link pruning
    const now = Date.now();
    const expiredTs = now - 60 * 24 * 60 * 60 * 1000;
    await fs.writeFile(
      nestedFile,
      JSON.stringify({
        guildLanguages: { g1: 'ja', gBad: 'fr' },
        enabledChannels: {
          cBool: true,
          cObjBoth: { interval: true, hourly: true },
          cObjHourly: { hourly: true },
        },
        voiceSession: {
          guildId: 'gLegacy',
          voiceChannelId: 'vc1',
          textChannelId: 'tc1',
          translateEnabled: true,
          speakEnabled: false,
        },
        translationLinks: {
          oldLink: { channelId: 'c1', translationMessageIds: ['m1'], createdAt: expiredTs },
          emptyLink: { channelId: 'c1', translationMessageIds: [], createdAt: now },
          validLink: { channelId: 'c1', translationMessageIds: ['m2', 'm2'], createdAt: now },
        },
        fireReminderSessions: {
          broken: { guildId: 'g1', currentFire: 999 },
          valid: {
            guildId: 'g1',
            channelId: 'c1',
            runnerUserId: 'u1',
            gameUid: '123',
            gameName: 'Runner',
            eventId: '300',
            eventName: 'Event',
            eventEndAt: now + 10_000,
            firePerScoreIncrease: 3,
            currentFire: 50,
            status: 'active',
            pendingGames: 0,
            refillCycle: 0,
            lastSampleTime: now,
            lastPointValue: 1000,
            createdAt: now,
          },
        },
      }),
      'utf-8',
    );

    await loadState(nestedFile);
    const loaded = getState();
    assert.deepEqual(loaded.guildLanguages, { g1: 'ja' });
    assert.deepEqual(loaded.enabledChannels, {
      cBool: 'interval',
      cObjBoth: 'interval',
      cObjHourly: 'hourly',
    });
    assert.equal(loaded.voiceSessions['gLegacy']?.voiceChannelId, 'vc1');
    assert.deepEqual(Object.keys(loaded.translationLinks), ['validLink']);
    assert.deepEqual(loaded.translationLinks['validLink'].translationMessageIds, ['m2']);
    assert.deepEqual(Object.keys(loaded.fireReminderSessions), ['g1:u1']);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
