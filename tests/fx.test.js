'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

const alive = (evaluate) => evaluate(() => ({
    add: fxKit.parts.filter((r) => r.alive).length,
    smoke: fxKit.smokes.filter((r) => r.alive).length,
    sparks: fxKit.parts.filter((r) => r.alive && r.kind === FX_KIND.spark).length,
    glow: fxKit.parts.filter((r) => r.alive && r.kind === FX_KIND.glow).length,
    embers: fxKit.parts.filter((r) => r.alive && r.kind === FX_KIND.ember).length
}));

test('ability effects kit: bursts, rings, smokes and fire zones emit particles that expire; off on Low', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'high' });
    await evaluate(() => { window.updateEnemies = () => {}; fxKit.update = (() => { const u = fxKit.update.bind(fxKit); window.__fxUpdate = u; return () => {}; })(); });
    const step = (n) => evaluate((n) => { for (let i = 0; i < n; i++) __fxUpdate(1 / 60, performance.now()); }, n);

    // An ability flash burst (used by most kits): sparks, a glow flash, smoke for a big one
    await evaluate(() => agentSystem.spawnFlashBurst(0, 1.2, 20, 0xff5500, 4.5, 400, performance.now()));
    let a = await alive(evaluate);
    assert.ok(a.sparks >= 20 && a.glow === 1 && a.smoke >= 3, `burst: ${JSON.stringify(a)}`);
    await step(240);
    a = await alive(evaluate);
    assert.deepEqual([a.add, a.smoke], [0, 0], 'everything expires');

    // Ground rings (dashes, stomps): dust and a few sparks
    await evaluate(() => agentSystem.spawnWindRing(0, 0.3, 20, 0x38f6ff, 3, performance.now()));
    a = await alive(evaluate);
    assert.ok(a.smoke >= 5 && a.sparks >= 4, `ring: ${JSON.stringify(a)}`);
    await step(240);

    // Smoke grenade: rolling puffs; fire zone: embers every frame
    await evaluate(() => agentSystem.spawnSmokeSphere(4, 1, 18, 0x38f6ff, 3.5, 8000, performance.now()));
    a = await alive(evaluate);
    assert.ok(a.smoke >= 16, `smoke cloud: ${JSON.stringify(a)}`);
    await evaluate(() => { for (let i = 0; i < 60; i++) fxKit.embers(-4, 0.02, 21, 0xff7b00, 4.5, 1 / 60); });
    a = await alive(evaluate);
    assert.ok(a.embers >= 10, `embers: ${JSON.stringify(a)}`);

    // Drawn as two instanced batches
    await evaluate(() => __fxUpdate(1 / 60, performance.now()));
    await frames(2);
    assert.ok(await evaluate(() => fxKit.add.count > 0 && fxKit.smoke.count > 0));

    // Low quality: no extra effects
    await evaluate(() => { setQualitySettings('low'); for (const r of fxKit.parts) r.alive = false; for (const r of fxKit.smokes) r.alive = false; });
    await evaluate(() => agentSystem.spawnFlashBurst(0, 1.2, 20, 0xff5500, 4.5, 400, performance.now()));
    a = await alive(evaluate);
    assert.deepEqual([a.add, a.smoke], [0, 0], 'off on Low');
    await evaluate(() => setQualitySettings('high'));

    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'particle shaders were compiled in the warm-up');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

test('camera shake: nearby blasts shake the view and it returns exactly; off by setting and with Reduce Flashes', { timeout: 240000 }, async () => {
    const { errors, evaluate } = await boot({ quality: 'high' });
    const r = await evaluate(() => {
        const out = {};
        const p = camera.position;
        const rot0 = [camera.rotation.x, camera.rotation.y];
        fxKit.trauma = 0;
        fxKit.burst(p.x + 3, p.y, p.z, 0xff5500, 5);
        out.trauma = fxKit.trauma;
        let maxOff = 0;
        let t = performance.now();
        for (let i = 0; i < 120; i++) {
            t += 16;
            fxKit.applyShake(t, 1 / 60);
            maxOff = Math.max(maxOff, Math.abs(camera.rotation.x - rot0[0]) + Math.abs(camera.rotation.y - rot0[1]));
        }
        out.maxOff = maxOff;
        out.back = Math.abs(camera.rotation.x - rot0[0]) + Math.abs(camera.rotation.y - rot0[1]);
        // A far blast does nothing
        fxKit.trauma = 0;
        fxKit.burst(p.x + 60, p.y, p.z, 0xff5500, 5);
        out.far = fxKit.trauma;
        // Setting off, and Reduce Flashes
        game.userSettings.cameraShake = false;
        fxKit.burst(p.x + 3, p.y, p.z, 0xff5500, 5);
        out.off = fxKit.trauma;
        game.userSettings.cameraShake = true;
        game.userSettings.reduceFlashes = true;
        fxKit.burst(p.x + 3, p.y, p.z, 0xff5500, 5);
        out.reduced = fxKit.trauma;
        game.userSettings.reduceFlashes = false;
        out.pill = !!document.querySelector('#setting-camera-shake-pills [data-camshake="off"]');
        return out;
    });
    assert.ok(r.trauma > 0.3, `nearby blast shakes (${r.trauma})`);
    assert.ok(r.maxOff > 0.002, 'the view moves');
    assert.ok(r.back < 1e-9, 'and returns exactly once the shake dies down');
    assert.equal(r.far, 0, 'far blasts do not shake');
    assert.equal(r.off, 0, 'Camera Shake OFF');
    assert.equal(r.reduced, 0, 'Reduce Flashes also stops shake');
    assert.ok(r.pill);
    assert.deepEqual(errors, []);
});
