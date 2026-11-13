'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

test('bots spawn in their archetype colours (not black), and the highlight colour applies to live bots', { timeout: 240000 }, async () => {
    const { errors, evaluate } = await boot();
    const colours = () => evaluate(() => enemyObjects.filter((e) => e.isActive).map((e) => {
        const arch = ENEMY_ARCHETYPES[e.archetype] || ENEMY_ARCHETYPES.standard;
        const want = enemyPartPalette(arch);
        return {
            torso: e.leaves[0].material.color.getHex(), head: e.leaves[1].material.color.getHex(),
            wantTorso: new THREE.Color(want[0]).convertSRGBToLinear().getHex(), wantHead: new THREE.Color(want[1]).convertSRGBToLinear().getHex()
        };
    }));
    const start = await colours();
    assert.ok(start.length > 0);
    for (const c of start) {
        assert.notEqual(c.torso, 0, 'torso is not black');
        assert.notEqual(c.head, 0, 'head is not black');
        assert.equal(c.torso, c.wantTorso);
        assert.equal(c.head, c.wantHead);
    }
    // Switching the highlight colour recolours bots already on the map, and back
    await evaluate(() => { game.userSettings.enemyHighlightColor = 'yellow'; settingsManager.applyEnemyHighlightColor(); });
    for (const c of await colours()) assert.equal(c.torso, c.wantTorso, 'yellow highlight applied');
    await evaluate(() => { game.userSettings.enemyHighlightColor = 'red'; settingsManager.applyEnemyHighlightColor(); });
    for (const c of await colours()) assert.equal(c.torso, c.wantTorso, 'archetype colour restored');
    assert.deepEqual(errors, []);
});

test('bots walk, flinch, recoil and topple over; hitboxes stay put; no shader compiles', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'high' });
    await evaluate(() => { game.userSettings.charDetail = 'on'; applyVisualOverrides(); });
    await frames(3);
    const r = await evaluate(() => {
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        const out = {};
        // Walking: 1 m per second for 1 s of simulation ticks
        for (let i = 0; i < 60; i++) { e.mesh.position.x += 1 / 60; updateEnemyAnimation(1 / 60); }
        out.walkAmt = e.animAmt;
        out.phase = e.animPhase;
        packEnemyBatches();
        const page = e.page, slot = page.members.indexOf(e);
        const a = page.meshes[0].geometry.attributes.instanceAnim;
        out.attr = [a.getX(slot), a.getY(slot)];
        // Hit proxies keep their plain transform (identity relative to the bot)
        e.mesh.updateMatrixWorld(true);
        out.proxiesStill = e.leaves.every((l) => l.matrixWorld.equals(e.mesh.matrixWorld));
        // Standing still: the walk fades out
        for (let i = 0; i < 60; i++) updateEnemyAnimation(1 / 60);
        out.restAmt = e.animAmt;
        // Non-lethal hit: flinch; it decays within half a second
        e.health = 1000;
        damageEnemyActor(e, 10, performance.now(), Date.now(), 'Test', 'torso');
        out.flinch = e.animFlinch;
        for (let i = 0; i < 40; i++) updateEnemyAnimation(1 / 60);
        out.flinchAfter = e.animFlinch;
        // Shooting: recoil (low content skips some shots at random, so try a few)
        game.health = 1000;
        for (let i = 0; i < 20 && !e.animRecoil; i++) enemyShoot(e);
        out.recoil = e.animRecoil;
        game.health = 100;
        // Death: topples backwards onto the floor, then leaves the scene
        e.health = 1;
        e.armor = 0;
        damageEnemyActor(e, 999, performance.now(), Date.now(), 'Test', 'torso');
        let maxTilt = 0, minY = 1e9, ticks = 0;
        for (; ticks < 400 && e.renderActive; ticks++) {
            stepActorAnimations();
            maxTilt = Math.max(maxTilt, e.mesh.rotation.x);
            if (e.mesh.rotation.x > 1.3 && ticks < 120) minY = Math.min(minY, e.mesh.position.y);
        }
        out.maxTilt = maxTilt;
        out.lyingY = minY;
        out.deathTicks = ticks;
        out.gone = !e.renderActive;
        // Respawn resets the pose
        respawnEnemy(e);
        out.respawn = [e.mesh.rotation.x, e.mesh.rotation.z, e.animAmt, e.animFlinch];
        return out;
    });
    assert.ok(r.walkAmt > 0.2, `walk amount builds up (${r.walkAmt})`);
    assert.ok(r.phase > 0, 'walk phase advances');
    assert.ok(Math.abs(r.attr[0] - r.phase) < 1e-5 && Math.abs(r.attr[1] - r.walkAmt) < 1e-5, 'the batch carries the animation state');
    assert.ok(r.proxiesStill, 'hit proxies are not animated');
    assert.ok(r.restAmt < 0.01, 'walk fades out when standing');
    assert.ok(r.flinch > 0.5 && r.flinchAfter < 0.1, `flinch on hit, then settles (${r.flinch} -> ${r.flinchAfter})`);
    assert.ok(r.recoil > 0.5, 'rifle recoil on a shot');
    assert.ok(r.maxTilt > 1.3 && r.maxTilt < 1.5, `falls onto its back (${r.maxTilt})`);
    assert.ok(r.lyingY >= 0, 'lies on the floor, not through it');
    assert.ok(r.gone && r.deathTicks > 90 && r.deathTicks < 300, `stays down for a moment, then is cleared (${r.deathTicks} ticks)`);
    assert.deepEqual(r.respawn, [0, 0, 0, 0], 'respawn resets the pose');
    await frames(5);
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no new shader programs');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});
