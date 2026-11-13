'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Offset of the rifle from its resting hip pose
const restDelta = (evaluate) => evaluate(() => {
    const w = game.weapons[game.activeWeapon], m = w.model, hip = w.hipPos || { x: 0.3, y: -0.3, z: -0.5 };
    return Math.hypot(m.position.x - hip.x, m.position.y - hip.y, m.position.z - hip.z) + Math.abs(m.rotation.x) + Math.abs(m.rotation.y) + Math.abs(m.rotation.z);
});

test('viewmodel: draw, recoil spring, reload choreography, inspect, shell casings; returns exactly to rest', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium' });
    await evaluate(() => { window.updateEnemies = () => {}; game.userSettings.infiniteAmmo = false; });

    // Draw: switching starts low and rolled, then settles
    await evaluate(() => switchWeapon('pistol'));
    const drawing = await evaluate(() => {
        switchWeapon('rifle');
        // One animator step 50 ms into the draw: the gun is still low
        const m = game.weapons.rifle.model, t = vmAnim.clip.start + 50;
        vmAnim.begin(m); vmAnim.end(m, t);
        return { clip: vmAnim.clip && vmAnim.clip.kind, py: vmAnim.last.py, rx: vmAnim.last.rx };
    });
    assert.equal(drawing.clip, 'draw');
    assert.ok(drawing.py < -0.05 && drawing.rx > 0.1, 'starts low and tipped');
    await page.waitForFunction(() => !vmAnim.clip, null, { timeout: 10000 });
    await frames(30);
    assert.ok((await restDelta(evaluate)) < 0.02, 'settles at rest after the draw');

    // Recoil: the spring kicks the gun and lets it go
    const kick = await evaluate(() => {
        vmAnim.fire(0.04);
        // Two 25 ms animator steps after the shot
        const m = game.weapons.rifle.model, t = performance.now();
        vmAnim.lastT = t;
        vmAnim.begin(m); vmAnim.end(m, t + 25);
        vmAnim.begin(m); vmAnim.end(m, t + 50);
        return { p: vmAnim.sp.p, z: vmAnim.sp.z };
    });
    assert.ok(kick.p > 0.03 && kick.z > 0.01, `gun kicks back and up (${kick.p.toFixed(3)}, ${kick.z.toFixed(3)})`);
    await page.waitForTimeout(800);
    await frames(10);
    assert.ok(await evaluate(() => Math.abs(vmAnim.sp.p) < 0.002 && Math.abs(vmAnim.sp.z) < 0.002), 'spring settles');

    // Reload: the magazine drops out and comes back; ammo refills
    await evaluate(() => { const w = game.weapons.rifle; w.ammo = 3; reload(); });
    const restY = await evaluate(() => game.weapons.rifle.magRestY !== undefined ? game.weapons.rifle.magRestY : game.weapons.rifle.magazine.position.y);
    let lowest = 0;
    const until = Date.now() + 15000;
    while (Date.now() < until && await evaluate(() => game.reloading)) {
        const y = await evaluate(() => game.weapons.rifle.magazine.position.y);
        lowest = Math.min(lowest, y);
        await frames(1);
    }
    assert.ok(lowest < restY - 0.2, `magazine drops out (lowest ${lowest.toFixed(2)})`);
    await frames(5);
    const after = await evaluate(() => ({ ammo: game.weapons.rifle.ammo, max: game.weapons.rifle.maxAmmo, y: game.weapons.rifle.magazine.position.y, vis: game.weapons.rifle.magazine.visible }));
    assert.equal(after.ammo, after.max);
    assert.ok(Math.abs(after.y - restY) < 1e-6 && after.vis, 'magazine back in place');

    // Inspect: turns the gun to show its sides
    await evaluate(() => inspectWeapon());
    await page.waitForTimeout(500);
    await frames(2);
    assert.ok(Math.abs(await evaluate(() => vmAnim.last.ry)) > 0.2, 'gun turns during inspect');
    await page.waitForFunction(() => !vmAnim.clip, null, { timeout: 15000 });
    await frames(30);
    assert.ok((await restDelta(evaluate)) < 0.02, 'back at rest after inspect (no drift)');

    // Shell casings: fly out, land on the floor, then clear
    await evaluate(() => { for (let i = 0; i < 4; i++) shellFX.eject(); });
    await frames(2);
    assert.ok(await evaluate(() => shellFX.mesh.count) >= 4, 'casings in the air');
    // Step the casing physics directly (the test browser's frames are slow)
    const landed = await evaluate(() => {
        for (let i = 0; i < 90; i++) shellFX.update(1 / 60);
        const live = shellFX.shells.filter((s) => s.alive);
        return { n: live.length, rest: live.every((s) => Math.abs(s.p.y - s.floor) < 0.02 && s.v.lengthSq() < 0.01) };
    });
    assert.ok(landed.n >= 4 && landed.rest, 'casings come to rest on the floor');
    const cleared = await evaluate(() => { for (let i = 0; i < 120; i++) shellFX.update(1 / 60); return shellFX.mesh.count; });
    assert.equal(cleared, 0, 'casings clear after a few seconds');

    // Pistol slide returns to its rest position after shots (it used to stop 9 cm forward)
    await evaluate(() => switchWeapon('pistol'));
    await page.waitForFunction(() => !vmAnim.clip, null, { timeout: 10000 });
    const slide = await evaluate(() => {
        vmAnim.fire(0.03);
        const m = game.weapons.pistol.model, t = vmAnim.slideKickAt;
        vmAnim.begin(m); vmAnim.end(m, t + 30);
        return game.weapons.pistol.slide.position.z - game.weapons.pistol.slideRestZ;
    });
    await page.waitForTimeout(400);
    await frames(3);
    assert.equal(await evaluate(() => game.weapons.pistol.slide.position.z), await evaluate(() => game.weapons.pistol.slideRestZ));
    assert.ok(slide > 0.02, 'slide kicks back on a shot');

    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no new shader programs');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});
