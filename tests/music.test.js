'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser } = require('./harness');

after(closeBrowser);

test('music and ambience are off by default and make no sound', { timeout: 240000 }, async () => {
    const { page, errors, evaluate } = await boot();
    await page.waitForTimeout(1500);
    const s = await evaluate(() => ({
        music: game.userSettings.musicEnabled, amb: game.userSettings.ambienceEnabled,
        built: !!ambientAudio.ctx, chords: ambientAudio.chordsPlayed, events: ambientAudio.eventsPlayed,
        pills: [document.querySelector('#setting-music-pills .active').dataset.music, document.querySelector('#setting-ambience-pills .active').dataset.ambience]
    }));
    assert.deepEqual(s, { music: false, amb: false, built: false, chords: 0, events: 0, pills: ['off', 'off'] });
    assert.deepEqual(errors, []);
});

test('music plays per map, builds on a planted spike, and fades out when switched off; ambience is independent', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot();
    await evaluate(() => document.querySelector('#setting-music-pills [data-music="on"]').click());
    await page.waitForFunction(() => ambientAudio.chordsPlayed > 0, null, { timeout: 30000 });
    await page.waitForFunction(() => ambientAudio.musicBus.gain.value > 0.05, null, { timeout: 30000 });
    const m = await evaluate(() => ({
        preset: ambientAudio.presetId, amb: ambientAudio.ambBus.gain.value, events: ambientAudio.eventsPlayed,
        saved: JSON.parse(localStorage.getItem('valorant_v16_user_settings') || '{}').musicEnabled
    }));
    assert.equal(m.preset, 'ascent');
    assert.ok(m.amb < 0.001 && m.events === 0, 'ambience stays off');
    assert.equal(m.saved, true);

    // Planted spike: tension rises and the bass pulse joins
    await evaluate(() => { tacticalDirector.spikeState = 'planted'; for (let i = 0; i < 12; i++) ambientAudio.tick(); });
    assert.ok(await evaluate(() => ambientAudio.tension) > 0.5, 'tension builds while the spike is planted');
    await evaluate(() => { tacticalDirector.spikeState = 'unplanted'; });

    // Ambience on: the bed follows the map, and placed sounds play
    await evaluate(() => document.querySelector('#setting-ambience-pills [data-ambience="on"]').click());
    await evaluate(() => tacticalDirector.cycleMapPreset('icebox'));
    await evaluate(() => { ambientAudio.nextEventAt = 0; ambientAudio.tick(); });
    const a = await evaluate(() => ({ preset: ambientAudio.presetId, bed: ambientAudio.bedFilter.type, events: ambientAudio.eventsPlayed }));
    assert.deepEqual([a.preset, a.bed], ['icebox', 'bandpass'], 'the bed follows the map');
    assert.ok(a.events >= 1, 'placed ambient sounds play');
    await page.waitForFunction(() => ambientAudio.ambBus.gain.value > 0.03, null, { timeout: 30000 });

    // Volume slider and switch-off
    await evaluate(() => { const el = document.getElementById('setting-music-vol'); el.value = 0; el.dispatchEvent(new Event('input')); });
    assert.equal(await evaluate(() => game.userSettings.musicVolume), 0);
    await evaluate(() => document.querySelector('#setting-music-pills [data-music="off"]').click());
    await evaluate(() => document.querySelector('#setting-ambience-pills [data-ambience="off"]').click());
    await page.waitForFunction(() => ambientAudio.musicBus.gain.value < 0.005 && ambientAudio.ambBus.gain.value < 0.005, null, { timeout: 30000 });
    const chords = await evaluate(() => ambientAudio.chordsPlayed);
    await page.waitForTimeout(8000);
    assert.equal(await evaluate(() => ambientAudio.chordsPlayed), chords, 'no new chords once switched off');
    assert.deepEqual(errors, []);
});
