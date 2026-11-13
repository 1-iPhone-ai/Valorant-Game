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
    // Opens at start on a 1280x720 window. (Booting under load can take longer
    // than the 12 s auto-hide, so the start state is recorded, not sampled late.)
    assert.equal(await page.evaluate(() => controlsHelp.startedExpanded), true, 'help is shown at start');
    // Collapses to the pill after 12 s
    await page.waitForFunction(() => !controlsHelp.expanded, null, { timeout: 30000 });
    await frames(2);
    assert.equal((await rect(page, '#controls-hint-pill')).shown, true, 'pill shows after auto-collapse');
    // I re-opens it, clear of the centred agent/ability bars
    await page.keyboard.press('KeyI');
    assert.equal(await page.evaluate(() => controlsHelp.expanded), true, 'I re-opens the help');
    await page.waitForFunction(() => parseFloat(getComputedStyle(document.getElementById('controls-hint-box')).opacity) > 0.95, null, { timeout: 10000 });
    const help = await rect(page, '#controls-hint-box');
    assert.ok(help.shown);
    assert.ok(!overlap(help, await rect(page, '#ability-bar')), 'help must not cover the ability bar');
    assert.ok(!overlap(help, await rect(page, '#agent-switcher-bar')), 'help must not cover the agent bar');
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

// V1.7 HUD Size: every panel scales together, nothing overlaps or leaves the
// window at any size, and the size is capped on small windows
const PANELS = ['#minimap-container', '#tactical-top-bar', '#fps-display', '#quality-toggle', '#fps-sparkline-widget',
    '#controls-hint-box', '#ability-bar', '#agent-switcher-bar', '.vitals-panel', '.ammo-display', '.score', '#kill-feed'];
test('HUD Size 80-130%: panels scale together with no overlaps at 1280x720, 1920x1080 and 1024x600', { timeout: 600000 }, async () => {
    for (const [w, h] of [[1280, 720], [1920, 1080], [1024, 600]]) {
        const { page, errors, evaluate } = await boot({ viewport: { width: w, height: h } });
        // Show the help panel so it is checked too
        await evaluate(() => controlsHelp.set(true));
        for (const pct of [80, 100, 130]) {
            const r = await evaluate(([pct, PANELS]) => {
                const el = document.getElementById('setting-hud-scale');
                el.value = pct;
                el.dispatchEvent(new Event('input'));
                const rects = {};
                for (const q of PANELS) {
                    const node = document.querySelector(q);
                    if (!node) continue;
                    const cs = getComputedStyle(node);
                    const b = node.getBoundingClientRect();
                    if (b.width === 0 || cs.display === 'none' || parseFloat(cs.opacity) < 0.05) continue;
                    // The kill feed is empty here: reserve room for a few entries
                    rects[q] = q === '#kill-feed' ? { left: b.left, right: b.right, top: b.top, bottom: b.top + 120 } : b;
                }
                const keys = Object.keys(rects), overlaps = [];
                for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
                    const a = rects[keys[i]], b = rects[keys[j]];
                    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps.push(`${keys[i]} x ${keys[j]}`);
                }
                const offscreen = keys.filter((k) => rects[k].left < -1 || rects[k].top < -1 || rects[k].right > innerWidth + 1 || rects[k].bottom > innerHeight + 1);
                return {
                    overlaps, offscreen, scale: hudScale.value(),
                    minimap: document.getElementById('minimap-container').getBoundingClientRect().width,
                    saved: JSON.parse(localStorage.getItem('valorant_v16_user_settings') || '{}').hudScale
                };
            }, [pct, PANELS]);
            const tag = `${w}x${h} @ ${pct}%`;
            assert.deepEqual(r.overlaps, [], `${tag}: no overlapping panels`);
            assert.deepEqual(r.offscreen, [], `${tag}: everything on screen`);
            assert.ok(Math.abs(r.minimap - 186 * r.scale) < 2, `${tag}: minimap scaled to ${r.scale}`);
            assert.ok(r.scale <= pct / 100 + 1e-9 && r.scale >= 0.8, `${tag}: scale ${r.scale} within the chosen size`);
            assert.equal(r.saved, pct, `${tag}: saved`);
        }
        assert.deepEqual(errors, []);
    }
});
