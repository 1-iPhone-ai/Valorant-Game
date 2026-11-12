'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser } = require('./harness');

after(closeBrowser);

const rect = (page, sel) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const shown = cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05 && r.width > 0;
    return { x: r.left, y: r.top, r: r.right, b: r.bottom, shown };
}, sel);
const overlap = (a, b) => a && b && a.shown && b.shown && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;

test('HUD at 1280x720: FPS cluster clear of the mode bar; help clear of the ability bar, then collapses', { timeout: 300000 }, async () => {
    const { page, errors, frames } = await boot({ viewport: { width: 1280, height: 720 } });
    const top = await rect(page, '#tactical-top-bar');
    for (const sel of ['#fps-display', '#quality-toggle', '#fps-sparkline-widget']) {
        assert.ok(!overlap(await rect(page, sel), top), `${sel} must not cover the mode bar`);
    }
    // Shown at start, clear of the centred agent/ability bars
    const help = await rect(page, '#controls-hint-box');
    assert.ok(help.shown, 'help is shown at start');
    assert.ok(!overlap(help, await rect(page, '#ability-bar')), 'help must not cover the ability bar');
    assert.ok(!overlap(help, await rect(page, '#agent-switcher-bar')), 'help must not cover the agent bar');
    // Collapses to the pill after 12 s; I toggles it
    await page.waitForFunction(() => !controlsHelp.expanded, null, { timeout: 30000 });
    await frames(2);
    assert.equal((await rect(page, '#controls-hint-pill')).shown, true, 'pill shows after auto-collapse');
    await page.keyboard.press('KeyI');
    assert.equal(await page.evaluate(() => controlsHelp.expanded), true, 'I re-opens the help');
    await page.keyboard.press('KeyI');
    assert.equal(await page.evaluate(() => controlsHelp.expanded), false);
    // The HUD "hints" setting hides the pill too
    await page.evaluate(() => { game.userSettings.showHints = false; settingsManager.applyHudVisibility(); });
    assert.equal((await rect(page, '#controls-hint-pill')).shown, false);
    assert.deepEqual(errors, []);
});

test('HUD at 1024x600: help starts collapsed and the mode bar clears the minimap', { timeout: 300000 }, async () => {
    const { page, errors } = await boot({ viewport: { width: 1024, height: 600 } });
    assert.equal(await page.evaluate(() => controlsHelp.expanded), false, 'small windows start collapsed');
    assert.ok(!overlap(await rect(page, '#tactical-top-bar'), await rect(page, '#minimap-container')), 'mode bar must not run under the minimap');
    assert.deepEqual(errors, []);
});

test('settings are remembered across reloads by default, and the opt-out sticks', { timeout: 400000 }, async () => {
    const { page, errors } = await boot();
    const reload = async () => {
        await page.reload();
        await page.waitForFunction(() => window.perfTelemetry && perfTelemetry.programWatermark > 0, null, { timeout: 180000 });
    };
    // Fresh browser: saving is on, a change survives a reload
    await page.evaluate(() => localStorage.clear());
    await reload();
    assert.equal(await page.evaluate(() => game.userSettings.localStorageEnabled), true, 'saving is on by default');
    await page.evaluate(() => {
        game.userSettings.atmosphereMode = 'night';
        game.userSettings.brightness = 125;
        settingsManager.saveToStorage();
    });
    await reload();
    assert.deepEqual(await page.evaluate(() => [game.userSettings.atmosphereMode, game.userSettings.brightness]), ['night', 125], 'settings restored after reload');

    // Opting out clears the save and stays off after a reload
    await page.evaluate(() => document.getElementById('settings-ls-toggle-btn').click());
    assert.equal(await page.evaluate(() => game.userSettings.localStorageEnabled), false);
    await reload();
    const after = await page.evaluate(() => ({ on: game.userSettings.localStorageEnabled, atmo: game.userSettings.atmosphereMode, label: document.getElementById('settings-ls-toggle-btn').textContent }));
    assert.equal(after.on, false, 'opt-out is remembered');
    assert.equal(after.atmo, 'daylight', 'saved settings were cleared');
    assert.match(after.label, /OFF/);
    assert.deepEqual(errors, []);
});
