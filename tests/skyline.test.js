'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

test('Skyline: in the F4 cycle and the main menu, city shown only there, rain and its own music, sites and spawns clear', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'high', menu: true });
    // The main menu MAP button cycles maps and names the current one
    const menu = await evaluate(() => {
        const out = [];
        for (let i = 0; i < 7; i++) {
            document.querySelector('[data-act="map"]').click();
            out.push([game.mapPreset, document.getElementById('mm-map-val').textContent]);
        }
        return out;
    });
    assert.deepEqual(menu.map((m) => m[0]), ['bind', 'haven', 'icebox', 'lotus', 'split', 'skyline', 'ascent']);
    assert.deepEqual(menu[5], ['skyline', 'SKYLINE']);
    await evaluate(() => mainMenu.resume());

    // F4 order: split -> skyline -> ascent
    const cycle = await evaluate(() => {
        tacticalDirector.cycleMapPreset('split');
        tacticalDirector.cycleMapPreset();
        const onSkyline = game.mapPreset;
        const city = tacticalEnhancements.skylineGroup.visible;
        tacticalDirector.cycleMapPreset();
        return { onSkyline, city, next: game.mapPreset, cityAway: tacticalEnhancements.skylineGroup.visible };
    });
    assert.deepEqual(cycle, { onSkyline: 'skyline', city: true, next: 'ascent', cityAway: false });

    await evaluate(() => tacticalDirector.cycleMapPreset('skyline'));
    await frames(4);
    const s = await evaluate(() => {
        game.userSettings.weather = 'map';
        const near = (x, z, r) => mapPieces.some((p) => p.bounds.min.y < 1.6 &&
            x > p.bounds.min.x - r && x < p.bounds.max.x + r && z > p.bounds.min.z - r && z < p.bounds.max.z + r);
        const sites = tacticalDirector.spikeSites;
        return {
            weather: weatherFX.resolve(),
            audio: !!MAP_AUDIO.skyline,
            pieces: mapPieces.length,
            inside: mapPieces.every((p) => Math.abs(p.x) <= 50 && Math.abs(p.z) <= 50),
            sitesClear: !near(sites.A.pos.x, sites.A.pos.z, 3) && !near(sites.B.pos.x, sites.B.pos.z, 3),
            spawnsClear: !near(0, 15, 1) && !near(0, 27, 1),
            windows: tacticalEnhancements.skylineGroup.children.length,
            covers: (enemyTactics.covers || []).length
        };
    });
    assert.equal(s.weather, 'rain', 'Map weather rains on Skyline');
    assert.ok(s.audio, 'its own music and ambience');
    assert.ok(s.pieces > 50, `a full map (${s.pieces} pieces)`);
    assert.ok(s.inside, 'everything that collides is inside the arena');
    assert.ok(s.sitesClear, 'both spike sites are clear');
    assert.ok(s.spawnsClear, 'spawn points are clear');
    assert.ok(s.windows >= 10, 'the city around it is built');
    assert.ok(s.covers > 0, 'bots have cover spots');

    // Antenna lights blink
    const blink = await evaluate(() => {
        const seen = new Set();
        for (let t = 0; t < 3200; t += 100) { tacticalEnhancements.updateMapMechanics(1 / 60, t); seen.add(tacticalEnhancements.skylineBeaconMat.color.getHex()); }
        return seen.size;
    });
    assert.equal(blink, 2, 'antenna lights blink');

    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no new shader programs');
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

test('Skyline: you can climb the stairs onto a skybridge and walk across it, walk under it, and step up onto the decks and the helipad', { timeout: 300000 }, async () => {
    const { errors, evaluate } = await boot({ quality: 'medium' });
    const r = await evaluate(() => {
        window.updateEnemies = () => {};
        tacticalDirector.cycleMapPreset('skyline');
        const cc = characterController;
        // Walk with W towards a heading until past the target coordinate (or n ticks);
        // returns the final foot height
        const walk = (x, z, yaw, axis, target, n) => {
            if (x !== null) { cc.position.set(x, cc.standHeight, z); cc.velocity.set(0, 0, 0); cc.grounded = true; }
            camera.rotation.set(0, yaw, 0, 'YXZ');
            const start = cc.position[axis], dir = Math.sign(target - start);
            game.keys.w = true;
            for (let i = 0; i < n && (cc.position[axis] - target) * dir < 0; i++) cc.update(1 / 60);
            game.keys.w = false;
            cc.velocity.x = cc.velocity.z = 0;   // stop dead, then settle
            for (let i = 0; i < 30; i++) cc.update(1 / 60);
            return +(cc.position.y - cc.height).toFixed(2);
        };
        const out = {};
        // North stairs (west tower) rise towards -z; yaw 0 faces -z
        out.tower = walk(-14, -29, 0, 'z', -37, 200);
        // Turn east (yaw -PI/2 faces +x) and walk out onto the bridge
        out.bridge = walk(null, null, -Math.PI / 2, 'x', 0, 200);
        out.bridgeX = +cc.position.x.toFixed(1);
        // Under the bridge: straight through along z at floor level
        out.under = walk(0, -32, 0, 'z', -43, 200);
        out.underZ = +cc.position.z.toFixed(1);
        // Side deck steps (east deck, walking +x) and the helipad steps (walking -x)
        out.deck = walk(25, 0, -Math.PI / 2, 'x', 33, 200);
        out.helipad = walk(10, 0, Math.PI / 2, 'x', 2, 200);
        return out;
    });
    assert.equal(r.tower, 4, 'up the stairs onto the tower');
    assert.equal(r.bridge, 4, 'across the skybridge');
    assert.ok(r.bridgeX > -6, `walked out onto the bridge (x ${r.bridgeX})`);
    assert.equal(r.under, 0, 'under the bridge on the floor');
    assert.ok(r.underZ < -42, `walked through under the bridge (z ${r.underZ})`);
    assert.equal(r.deck, 2.2, 'up the steps onto the side deck');
    assert.equal(r.helipad, 3, 'up the steps onto the helipad');
    assert.deepEqual(errors, []);
});
