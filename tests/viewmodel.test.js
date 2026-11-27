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

    // V2.2 final check: the magazine's drop and the inspect's turn are read on every animator step, inside the
    // page. The test read them once per round trip, which on a slow renderer can be three reads in a 3.3 s reload,
    // so it could miss the bottom of the drop or the turn's widest swing on any build (main's included; the clips
    // are the same value for value). The thresholds are as before.
    await evaluate(() => {
        const end = vmAnim.end;
        window.__vmRec = { minY: Infinity, maxRy: 0 };
        vmAnim.end = function () {
            const r = end.apply(this, arguments);
            const w = game.weapons.rifle;
            if (w && w.magazine) __vmRec.minY = Math.min(__vmRec.minY, w.magazine.position.y);
            __vmRec.maxRy = Math.max(__vmRec.maxRy, Math.abs(vmAnim.last.ry || 0));
            return r;
        };
    });

    // Reload: the magazine drops out and comes back; ammo refills
    await evaluate(() => { const w = game.weapons.rifle; w.ammo = 3; __vmRec.minY = Infinity; reload(); });
    const restY = await evaluate(() => game.weapons.rifle.magRestY !== undefined ? game.weapons.rifle.magRestY : game.weapons.rifle.magazine.position.y);
    await page.waitForFunction(() => !game.reloading, null, { timeout: 15000, polling: 50 });
    const lowest = await evaluate(() => __vmRec.minY);
    assert.ok(lowest < restY - 0.2, `magazine drops out (lowest ${lowest.toFixed(2)})`);
    await frames(5);
    const after = await evaluate(() => ({ ammo: game.weapons.rifle.ammo, max: game.weapons.rifle.maxAmmo, y: game.weapons.rifle.magazine.position.y, vis: game.weapons.rifle.magazine.visible }));
    assert.equal(after.ammo, after.max);
    assert.ok(Math.abs(after.y - restY) < 1e-6 && after.vis, 'magazine back in place');

    // Inspect: turns the gun to show its sides
    await evaluate(() => { __vmRec.maxRy = 0; inspectWeapon(); });
    await page.waitForFunction(() => !vmAnim.clip, null, { timeout: 15000 });
    assert.ok((await evaluate(() => __vmRec.maxRy)) > 0.2, 'gun turns during inspect');
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

// V2.2 final check: the gun took the camera's pitch and yaw in another rotation order (XYZ against the camera's
// YXZ), so facing away from yaw 0 it tipped off the view: 28.6 degrees at yaw pi looking 14 degrees down.
test('viewmodel: the gun turns with the view whichever way you face and look', { timeout: 300000 }, async () => {
    const { errors, frames, evaluate } = await boot({ quality: 'medium' });
    await evaluate(() => { window.updateEnemies = () => {}; });
    const off = [];
    for (const [pitch, yaw] of [[-0.25, Math.PI], [0.3, -2.2], [0.2, Math.PI / 2], [-0.4, 0.8], [0, 0]]) {
        await evaluate(([p, y]) => {
            const cc = characterController;
            camera.rotation.set(p, y, 0, 'YXZ');
            if (cc.targetRotation) { cc.targetRotation.x = p; cc.targetRotation.y = y; }
        }, [pitch, yaw]);
        await frames(2);
        off.push(await evaluate(() => {
            weaponGroup.updateMatrixWorld(true);
            const q = new THREE.Quaternion();
            weaponGroup.getWorldQuaternion(q);
            return +(q.angleTo(viewmodelCamera.quaternion) * 180 / Math.PI).toFixed(3);
        }));
    }
    // the slide/strafe tilt eases back to 0 (rotation.z), so standing still the gun turns exactly as the view
    for (const a of off) assert.ok(a < 0.05, `the gun turns as the view does (off by ${off.join(', ')} degrees)`);
    assert.deepEqual(errors, []);
});
