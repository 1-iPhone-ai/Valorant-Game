'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Stand at p and aim at t, then fire one shot with a full magazine (no cooldown)
const FIRE = `
    window.__fireAt = (p, t) => {
        characterController.position.set(p[0], p[1], p[2]);
        characterController.prevSimPosition.copy(characterController.position);
        camera.position.set(p[0], p[1], p[2]);
        camera.lookAt(t[0], t[1], t[2]);
        camera.updateMatrixWorld();
        game.lastShot = 0; game.reloading = false; game.recoilHeat = 0;
        game.recoilAccumYaw = 0; game.recoilAccumPitch = 0;
        const w = game.weapons[game.activeWeapon]; w.ammo = w.maxAmmo;
        shoot();
    };
`;

test('props on every map: glass and barrels on open floor, away from spawns, with no shader compiles', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium' });
    const [baseline] = await programState(page);
    for (const map of ['ascent', 'bind', 'haven', 'icebox', 'lotus', 'split', 'skyline']) {
        await evaluate((map) => tacticalDirector.cycleMapPreset(map), map);
        await frames(3);
        const r = await evaluate(() => {
            const props = breakables.glass.concat(breakables.barrels);
            const bad = [];
            for (const p of props) {
                if (Math.hypot(p.x - 42, p.z) < 11 || Math.hypot(p.x + 42, p.z) < 11) bad.push('spawn');
                if (!p.rec.indexed || !p.mesh.visible) bad.push('not solid');
                // No map collider overlaps the prop
                const near = collisionIndex.query(p.box.min.x, p.box.min.z, p.box.max.x, p.box.max.z, []);
                for (const c of near) if (c !== p.rec && c.maxY > 0.15 && c.maxX > p.box.min.x && c.minX < p.box.max.x && c.maxZ > p.box.min.z && c.minZ < p.box.max.z) bad.push('overlap');
            }
            return { glass: breakables.glass.length, barrels: breakables.barrels.length, bad, programs: renderer.info.programs.length };
        });
        assert.ok(r.glass >= 3 && r.barrels >= 4, `${map}: ${r.glass} panes, ${r.barrels} barrels`);
        assert.deepEqual(r.bad, [], `${map}: props placed cleanly`);
        assert.equal(r.programs, baseline, `${map}: no shader compiles`);
    }
    assert.deepEqual(errors, []);
});

test('material penetration: bullets go through a wood crate but not the same thickness of metal; exit holes', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'medium' });
    await page.addScriptTag({ content: FIRE });
    const r = await evaluate(() => {
        window.updateEnemies = () => {};
        game.activeWeapon = 'rifle';
        game.userSettings.headshotOnly = false;
        const out = {};
        // A 1.4 m thick block at x = 0, z = -20 with a bot behind it: wood, then metal
        const piece = createBox(0, 1.2, -20, 3, 2.4, 1.4, 0x6b4f2a);
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        const place = () => { e.health = e.maxHealth || 150; e.armor = 0; e.mesh.position.set(0, 0, -23); e.poseDirty = true; syncEnemyBroadphase(e); };
        for (const [name, surf] of [['wood', MAP_SURF.wood], ['metal', MAP_SURF.metal]]) {
            piece.surf = surf;
            place();
            const h0 = e.health;
            // Count the impact decals placed (the decal list itself is capped)
            let decals = 0;
            const orig = window.createBulletImpact;
            window.createBulletImpact = (pos, n) => { decals++; return orig(pos, n); };
            __fireAt([0, 1.4, -8], [0, 1.25, -23]);
            window.createBulletImpact = orig;
            out[name] = { dealt: h0 - e.health, decals: decals };
        }
        out.mat = [BREAK_MAT[MAP_SURF.wood].pen, BREAK_MAT[MAP_SURF.metal].pen];
        return out;
    });
    assert.ok(r.wood.dealt > 0, `through wood (${r.wood.dealt} damage)`);
    assert.ok(r.wood.decals >= 2, 'entry and exit holes');
    assert.equal(r.metal.dealt, 0, 'stopped by metal');
    assert.ok(r.mat[0] > 1 && r.mat[1] < 1);
    assert.deepEqual(errors, []);
});

test('glass shatters (shots, enemy fire), stops blocking, and comes back; barrels explode, hurt nearby, chain; setting off removes them', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'medium' });
    await page.addScriptTag({ content: FIRE });
    const r = await evaluate(() => {
        window.updateEnemies = () => {};
        const out = {};
        const g = breakables.glass[0];
        const solid = () => collisionIndex.query(g.x - 0.1, g.z - 0.1, g.x + 0.1, g.z + 0.1, []).indexOf(g.rec) !== -1;
        out.glassSolid = solid();
        const off = g.alongX ? [0, 7] : [7, 0];
        __fireAt([g.x + off[0], 1.6, g.z + off[1]], [g.x, 1.4, g.z]);
        out.glassBroken = g.broken;
        out.glassSolidAfter = solid();
        out.glassShown = g.mesh.visible;
        // Comes back after 30 s in Wave mode
        g.brokenAt = performance.now() - 31000;
        characterController.position.set(g.x + 10, 1.7, g.z + 10);
        breakables.update(performance.now());
        out.glassBack = [!g.broken, solid(), g.mesh.visible];
        // Enemy fire through a pane breaks it too
        const g2 = breakables.glass[1];
        const o = new THREE.Vector3(g2.x + (g2.alongX ? 0 : 5), 1.4, g2.z + (g2.alongX ? 5 : 0));
        const d = new THREE.Vector3(g2.x, 1.4, g2.z).sub(o).normalize();
        breakables.shatterAlong(o, d, 20);
        out.enemyBreaks = g2.broken;

        // Barrel: a bot and the player nearby
        const b = breakables.barrels[0];
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        e.mesh.position.set(b.x + 2, 0, b.z); e.poseDirty = true; syncEnemyBroadphase(e);
        const eh = e.health;
        game.health = 100; game.shield = 0;
        const shots = [];
        for (let i = 0; i < 6 && !b.broken; i++) {
            __fireAt([b.x, 1.7, b.z + 3.5], [b.x, 0.6, b.z]);
            shots.push(b.hp);
        }
        out.barrel = { broken: b.broken, shots: shots.length, botHurt: eh - e.health, playerHurt: 100 - game.health, solid: b.rec.indexed };
        // Chain reaction: a second barrel moved next to a third
        game.health = 100;
        const b2 = breakables.barrels[1], b3 = breakables.barrels[2];
        b3.x = b2.x + 2; b3.z = b2.z; b3.box.translate(new THREE.Vector3(b3.x - b3.box.getCenter(new THREE.Vector3()).x, 0, b3.z - b3.box.getCenter(new THREE.Vector3()).z));
        characterController.position.set(b2.x + 30, 1.7, b2.z);
        breakables.explode(b2);
        breakables.update(performance.now() + 500);
        out.chain = [b2.broken, b3.broken, breakables.explosions];
        // A new Match round brings everything back
        breakables.reset();
        out.reset = breakables.glass.concat(breakables.barrels).every((p) => !p.broken && p.mesh.visible && p.rec.indexed);
        // Setting off: hidden and not solid; on again: back
        document.querySelector('#setting-breakables-pills [data-breakables="off"]').click();
        out.off = breakables.glass.concat(breakables.barrels).every((p) => !p.mesh.visible && !p.rec.indexed);
        out.offShot = breakables.firstBarrel(new THREE.Ray(new THREE.Vector3(b.x, 1, b.z + 3), new THREE.Vector3(0, 0, -1)), 50);
        document.querySelector('#setting-breakables-pills [data-breakables="on"]').click();
        out.on = breakables.glass.concat(breakables.barrels).every((p) => p.mesh.visible && p.rec.indexed);
        out.saved = JSON.parse(localStorage.getItem('valorant_v16_user_settings') || '{}').breakables;
        return out;
    });
    assert.equal(r.glassSolid, true, 'intact glass blocks movement');
    assert.deepEqual([r.glassBroken, r.glassSolidAfter, r.glassShown], [true, false, false], 'shot glass shatters and stops blocking');
    assert.deepEqual(r.glassBack, [true, true, true], 'glass comes back after 30 s');
    assert.equal(r.enemyBreaks, true, 'enemy fire breaks glass');
    assert.ok(r.barrel.broken && r.barrel.shots <= 3, `barrel explodes (${r.barrel.shots} shots)`);
    assert.ok(r.barrel.botHurt > 0, 'nearby bot hurt');
    assert.ok(r.barrel.playerHurt > 0, 'nearby player hurt');
    assert.equal(r.barrel.solid, false);
    assert.deepEqual(r.chain.slice(0, 2), [true, true], 'chain reaction');
    assert.ok(r.reset, 'new round restores all props');
    assert.ok(r.off && r.offShot === null, 'setting off removes props');
    assert.ok(r.on && r.saved === true, 'and on brings them back');
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark);
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});
