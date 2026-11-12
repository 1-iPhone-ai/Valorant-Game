'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

test('all 6 maps in all 3 atmosphere modes: no errors, no shader compiles', { timeout: 600000 }, async () => {
    const { page, errors, frames } = await boot();
    const [baseline] = await programState(page);
    for (const mode of ['daylight', 'competitive', 'night']) {
        await page.evaluate((mode) => { game.userSettings.atmosphereMode = mode; settingsManager.applyAtmosphereTheme(); }, mode);
        for (const map of ['ascent', 'bind', 'haven', 'icebox', 'lotus', 'split']) {
            await page.evaluate((map) => tacticalDirector.cycleMapPreset(map), map);
            await frames(3);
            const s = await page.evaluate(() => ({ map: game.mapPreset, env: !!scene.environment, programs: renderer.info.programs.length }));
            assert.equal(s.map, map);
            assert.ok(s.env, `environment map present on ${map}/${mode}`);
            assert.equal(s.programs, baseline, `${map}/${mode} must not compile shaders`);
        }
    }
    assert.deepEqual(errors, []);
});
