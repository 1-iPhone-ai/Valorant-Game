'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

test('loads, warms shaders, renders, and shows the V1.7 label', { timeout: 240000 }, async () => {
    const { page, errors, frames } = await boot();
    await frames(10);
    const state = await page.evaluate(() => ({
        loadingHidden: getComputedStyle(document.getElementById('loading-screen')).display === 'none',
        label: document.querySelector('.loading-text').textContent,
        hasEnv: !!scene.environment,
        mapBatches: mapBatches.length,
        enemies: enemyObjects.length
    }));
    assert.ok(state.loadingHidden, 'loading screen should be hidden once the game runs');
    assert.match(state.label, /V1\.7/);
    assert.ok(state.hasEnv, 'environment map should be built before play');
    assert.ok(state.mapBatches > 0 && state.enemies > 0, 'map and enemies should exist');
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no shader compiles after warm-up');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

test('quality switches never compile shaders and Low suspends shadows', { timeout: 240000 }, async () => {
    const { page, errors, frames } = await boot();
    const [baseline] = await programState(page);
    for (const q of ['high', 'ultra', 'low', 'medium', 'low', 'high']) {
        await page.evaluate((q) => setQualitySettings(q), q);
        await frames(4);
        const s = await page.evaluate(() => ({ suspended: shadowManager.suspended, programs: renderer.info.programs.length }));
        assert.equal(s.programs, baseline, `switching to ${q} must not add programs`);
        assert.equal(s.suspended, q === 'low', `shadows should be ${q === 'low' ? 'suspended' : 'active'} on ${q}`);
    }
    // Settings shadow pill OFF uses the same no-recompile path
    await page.evaluate(() => settingsManager.applyShadowOverride(0));
    await frames(3);
    assert.equal(await page.evaluate(() => shadowManager.suspended), true);
    assert.equal((await programState(page))[0], baseline);
    assert.deepEqual(errors, []);
});

test('gameplay: shooting, weapon switches and enemy fire raise no errors', { timeout: 240000 }, async () => {
    const { page, errors, frames } = await boot();
    for (const w of ['rifle', 'sniper', 'pistol', 'knife', 'rifle']) {
        await page.evaluate((w) => { switchWeapon(w); for (let i = 0; i < 3; i++) shoot(); }, w);
        await frames(4);
    }
    // Stand in the open so enemies engage
    await page.evaluate(() => { characterController.position.set(0, 1.7, 22); characterController.prevSimPosition.copy(characterController.position); });
    await frames(40);
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});
