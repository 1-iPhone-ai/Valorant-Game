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
        const sites = tacticalDirector.spikeSites, L = mapLayout();
        return {
            weather: weatherFX.resolve(),
            audio: !!MAP_AUDIO.skyline,
            pieces: mapPieces.length,
            inside: mapPieces.every((p) => Math.abs(p.x) <= 50 && Math.abs(p.z) <= 50),
            sitesClear: !near(sites.A.pos.x, sites.A.pos.z, 3) && !near(sites.B.pos.x, sites.B.pos.z, 3),
            spawnsClear: !near(L.spawns.attack.x, L.spawns.attack.z, 1) && !near(L.spawns.defend.x, L.spawns.defend.z, 1) && !near(L.start.x, L.start.z, 1),
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

test('Skyline: you can climb a tower onto the skybridge and walk across it, walk the Alley under it, and step up onto the helipad, the Control Booth and the Billboard deck', { timeout: 300000 }, async () => {
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
        // V2.1: the north tower's steps rise east (yaw -PI/2 faces +x) from the attackers' half of the Alley
        out.tower = walk(-9, -7, -Math.PI / 2, 'x', -1, 200);
        // Turn south (yaw PI faces +z) and walk across the bridge onto the south tower
        out.bridge = walk(null, null, Math.PI, 'z', 6, 300);
        out.bridgeZ = +cc.position.z.toFixed(1);
        // The Alley under the bridge: straight through along x at floor level
        out.under = walk(-10, 0.5, -Math.PI / 2, 'x', 7, 300);
        out.underX = +cc.position.x.toFixed(1);
        // The helipad block's steps, the Control Booth's and the Billboard deck's (all walking +x)
        out.helipad = walk(-5, -35, -Math.PI / 2, 'x', 3, 200);
        out.booth = walk(0.5, -44.75, -Math.PI / 2, 'x', 9, 300);
        out.billboard = walk(6, 44.75, -Math.PI / 2, 'x', 16, 300);
        return out;
    });
    assert.equal(r.tower, 4, 'up the stairs onto the tower');
    assert.equal(r.bridge, 4, 'across the skybridge');
    assert.ok(r.bridgeZ > 5, `walked across onto the south tower (z ${r.bridgeZ})`);
    assert.equal(r.under, 0, 'under the bridge on the floor');
    assert.ok(r.underX > 6.5, `walked through under the bridge (x ${r.underX})`);
    assert.equal(r.helipad, 3, 'up the steps onto the helipad');
    assert.equal(r.booth, 3, 'up the steps into the Control Booth');
    assert.equal(r.billboard, 3, 'up the steps onto the Billboard deck');
    assert.deepEqual(errors, []);
});
