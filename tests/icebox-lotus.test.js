'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser } = require('./harness');
const mapSuite = require('./map-suite');

after(closeBrowser);

// V2.1 Icebox and Lotus: their own layouts in Ascent's format. The shared checks are in
// map-suite.js; Icebox's rope ascenders and Lotus's stone doors and breakable wall below.

const MAPS = {
    icebox: {
        keys: ['A', 'B'],
        lanes: {
            ROW: [['rowW', { zMax: -14 }], ['rowN', { xMax: 0 }]],
            YARD: [['yard'], ['yardIn', { xMin: -33 }]],
            SIGNAL: [['signal', { zMax: -15 }], ['signalE', { xMax: -1 }]],
            WEIGH: [['weigh', { zMin: 15 }], ['weighE'], ['weighS', { zMax: 26 }]],
            FUEL: [['fuelW', { zMin: 14 }], ['fuelS', { xMax: -6 }]],
            GANTRY: [['gantryN', { zMax: -14 }], ['gantryW', { xMin: 24 }]],
            NET: [['netS', { zMin: 14 }], ['netW', { xMin: 24 }]],
            GATE: [['gateE', { xMax: 33 }], ['gateJog'], ['gateW', { xMin: -4 }]]
        },
        meet: [['SIGNAL', 'YARD'], ['WEIGH', 'YARD'], ['GATE', 'YARD']],
        siteRects: { A: 'aSite', B: 'bSite' },
        entrances: { A: [[5, -43.7], [2.3, -29.5], [17.7, -33.5]], B: [[2.3, 42], [7, 28.3], [17.7, 31.5]] },
        chokes: [['x', -20, 'rowN'], ['x', -32, 'yardIn'], ['z', -22, 'signal'], ['z', 16, 'weigh'], ['x', -28, 'fuelS'], ['x', 29.5, 'gantryW'], ['x', 29.5, 'netW'], ['x', 5, 'gateW']],
        heaven: { from: [6.6, -42.75], yaw: -Math.PI / 2, x: 14, zone: 'CRANE CAB' },
        zones: [[-44, -25, 'REEFER ROW'], [-20, -7, 'RAIL YARD'], [-18, -16, 'SIGNAL BOX'], [14.5, -36, 'A SITE'], [45, -22, 'GANTRY WALK'], [-10, 20, 'WEIGH STATION'],
            [-36, 43, 'FUEL DEPOT'], [8.5, 41, 'B SITE'], [45, 20, 'NET SHED'], [23, -5, 'HARBOUR GATE'], [29, -20, 'CUSTOMS YARD'], [-44, 0, 'ATTACKER SPAWN'], [44, 0, 'DEFENDER SPAWN']]
    },
    lotus: {
        keys: ['A', 'B', 'C'],
        smallest: 'B',
        nearest: 'B',
        lanes: {
            LION: [['lionN', { zMax: -13 }], ['lionE', { xMax: 1 }]],
            SCREE: [['screeW', { zMax: -14 }], ['screeN'], ['screeE', { xMax: 1 }]],
            COURT: [['court'], ['courtIn', { xMin: -33 }]],
            TORCH: [['torch1', { xMin: -12 }], ['torchJog'], ['torch2', { xMax: 15 }]],
            SERP: [['serpS', { zMin: 13 }], ['serpE', { xMax: 1 }]],
            RIVER: [['riverW', { zMin: 14 }], ['riverS'], ['riverBend'], ['riverE', { xMax: 1 }]],
            MONK: [['monkN', { zMax: -14 }], ['monkW', { xMin: 30 }]],
            RELIC: [['relicS', { zMin: 14 }], ['relicW', { xMin: 30 }]],
            INCENSE: [['incense', { zMin: -25, zMax: -10 }], ['bellLoft', { xMax: 39 }]],
            ASH: [['ash', { zMin: 10, zMax: 25 }], ['waterStair', { xMax: 39 }]]
        },
        meet: [['LION', 'COURT'], ['TORCH', 'COURT'], ['SERP', 'COURT'], ['INCENSE', 'MONK'], ['ASH', 'RELIC']],
        siteRects: { A: 'aSite', B: 'bSite', C: 'cSite' },
        entrances: { A: [[6.3, -31], [6.3, -41], [21.7, -30.5], [20, -28.3]], B: [[16.3, 4], [20, -6.7], [20, 6.7]], C: [[6.3, 31], [6.3, 40.5], [21.7, 30.5], [20, 28.3]] },
        chokes: [['x', -34, 'courtIn'], ['x', -28, 'screeN'], ['x', -28, 'riverS'], ['x', -9, 'torch1'], ['x', -7, 'lionE'], ['x', -7, 'serpE'], ['z', -13, 'incense'], ['z', 13, 'ash'],
            ['x', 31.5, 'monkW'], ['x', 31.5, 'relicW'], ['x', 35, 'bellLoft'], ['x', 35, 'waterStair']],
        heaven: { from: [10.6, -42.75], yaw: -Math.PI / 2, x: 17, zone: 'SUN TERRACE' },
        zones: [[-44, -25, 'SCREE PATH'], [-26, -15, 'LION GATE'], [-23, 7, 'OUTER COURT'], [-9, -4, 'TORCH PASSAGE'], [9, -41, 'A SITE'], [45, -22, 'MONKS STAIR'], [20, -18, 'INCENSE WALK'],
            [30, -19.5, 'BELL LOFT'], [21, 4.5, 'B SITE'], [20, 18, 'ASH WALK'], [30, 21.5, 'WATER STAIR'], [-21.5, 16, 'SERPENT GATE'], [-36, 44, 'RIVER WALK'], [-11, 44, 'LOTUS POOL'],
            [9, 41, 'C SITE'], [45, 22, 'RELIC STORE'], [-32, 24, 'PILGRIM HALL'], [-44, 0, 'ATTACKER SPAWN'], [44, 0, 'DEFENDER SPAWN']]
    }
};

mapSuite('Icebox and Lotus', MAPS);

test('Icebox rope ascenders: placed from the layout, hold F at a cable to climb onto its container stack, none on the other maps', { timeout: 300000 }, async () => {
    const { errors, frames, evaluate } = await boot({ quality: 'low' });
    await evaluate(() => { window.updateEnemies = () => {}; tacticalDirector.setGameMode('wave'); rebuildMapPreset('icebox'); });
    await frames(3);
    const r = await evaluate(() => {
        const te = tacticalEnhancements, L = mapLayout(), cc = characterController, out = { rigs: [], climbs: [] };
        te.updateMapMechanics(1 / 60, performance.now());
        for (const rig of te.layoutRopes) out.rigs.push([rig.group.visible, +rig.group.position.x.toFixed(2), +rig.group.position.z.toFixed(2)]);
        let t = performance.now();
        for (const rope of L.ropes) {
            cc.reset();
            cc.position.set(rope.x - 0.5, cc.standHeight, rope.z);
            cc.prevSimPosition.copy(cc.position);
            cc.velocity.set(0, 0, 0);
            game.keys.f = true;
            let stepped = false;
            for (let i = 0; i < 150 && !stepped; i++) {
                t += 1000 / 60;
                te.updateMapMechanics(1 / 60, t);
                stepped = cc.position.x === rope.exit.x && cc.position.z === rope.exit.z;
                cc.update(1 / 60);
            }
            game.keys.f = false;
            for (let i = 0; i < 60; i++) cc.update(1 / 60);   // settle on the deck
            out.climbs.push({ name: rope.name, stepped, foot: +(cc.position.y - cc.height).toFixed(2), at: [+cc.position.x.toFixed(2), +cc.position.z.toFixed(2)], exit: [rope.exit.x, rope.exit.z] });
        }
        rebuildMapPreset('ascent');
        te.updateMapMechanics(1 / 60, performance.now());
        out.ascent = te.layoutRopes.filter((g) => g.group.visible).length;
        return out;
    });
    const want = [[-24.4, 0], [7.3, -34.25], [7.5, 35.75]];
    assert.deepEqual(r.rigs.slice(0, 3), want.map((p) => [true, p[0], p[1]]), 'a rig at each of the layout\'s ropes');
    assert.ok(r.rigs.slice(3).every((g) => !g[0]), 'the spare rigs stay hidden');
    for (const c of r.climbs) {
        assert.ok(c.stepped, `${c.name}: stepped off at the top`);
        assert.ok(Math.abs(c.foot - 5.2) < 0.15, `${c.name}: standing on the stack (feet ${c.foot} m up)`);
        assert.ok(Math.hypot(c.at[0] - c.exit[0], c.at[1] - c.exit[1]) < 0.6, `${c.name}: at the exit (${c.at})`);
    }
    assert.equal(r.ascent, 0, 'no ropes on Ascent');
    await frames(2);
    assert.deepEqual(errors, []);
});

test('Lotus stone doors and wall: doors from the layout turn slowly on [F] and, shut, close their lane to players, bots and bullets; the wall stands until shot to pieces; both reset each round', { timeout: 300000 }, async () => {
    const { errors, frames, evaluate } = await boot({ quality: 'low' });
    await evaluate(() => { window.updateEnemies = () => {}; tacticalDirector.setGameMode('wave'); rebuildMapPreset('lotus'); });
    await frames(3);
    const r = await evaluate(() => {
        const te = tacticalEnhancements, cc = characterController, out = {};
        const sees = (ax, az, bx, bz) => agentSystem.hasWallLineOfSight(new THREE.Vector3(ax, 1.6, az), new THREE.Vector3(bx, 1.6, bz), Math.hypot(bx - ax, bz - az));
        const route = (ax, az, bx, bz) => navGrid.routeLength(ax, az, bx, bz);
        out.doors = te.lotusDoors.filter((d) => d.cfg).map((d) => [d.name, d.x, d.z, d.isOpen, d.pivot.visible]);
        // Lion Gate: a pivot at (-26, -22) in a lane running along z. Open, the slab stands along the
        // lane: a way past on either side, and sight past it
        const d = te.lotusDoors[0];
        out.openRoute = route(-27.6, -14, -27.6, -30);
        out.openSight = sees(-27.8, -15, -27.8, -29);
        // [F] beside it: a quarter turn, slow
        cc.position.set(-26, cc.standHeight, -18.4); cc.prevSimPosition.copy(cc.position);   // at the open slab's end
        let t = performance.now() + 5000;
        game.keys.f = true; te.updateMapMechanics(1 / 60, t); game.keys.f = false;
        out.turning = d.turning;
        let n = 0;
        while (d.turning && n < 900) { t += 1000 / 60; te.updateMapMechanics(1 / 60, t); n++; }
        out.turnSecs = +(n / 60).toFixed(2);
        out.shut = !d.isOpen;
        // Shut: bots go round (a much longer way), no sight through, and you stop at it
        out.shutRoute = route(-27.6, -14, -27.6, -30);
        out.shutSight = [-27.8, -26, -24.2].some((x) => sees(x, -15, x, -29));
        cc.position.set(-26, cc.standHeight, -17); cc.prevSimPosition.copy(cc.position); cc.velocity.set(0, 0, 0);
        camera.rotation.set(0, 0, 0, 'YXZ');
        game.keys.w = true; for (let i = 0; i < 180; i++) cc.update(1 / 60); game.keys.w = false;
        out.stoppedAt = +cc.position.z.toFixed(2);
        // The Incense Wall: whole, bots go round; shot to pieces, they go through
        const w = te.breakWall;
        out.wallWhole = !w.broken && w.mesh.visible;
        out.wallRoute = route(20, -30, 20, -20);
        out.wallSight = sees(20, -29, 20, -21);
        let shots = 0;
        while (!w.broken && shots < 30) { te.damageBreakWall(w, 40, null); shots++; }
        out.shots = shots;
        out.wallBroken = w.broken && !w.mesh.visible;
        out.brokenRoute = route(20, -30, 20, -20);
        out.brokenSight = sees(20, -29, 20, -21);
        // A new round: the door open and the wall whole again
        te.resetMapMechanics();
        out.reset = [d.isOpen, !w.broken, route(-27.6, -14, -27.6, -30)];
        // None on Ascent
        rebuildMapPreset('ascent');
        te.updateMapMechanics(1 / 60, t + 1000);
        out.ascent = [te.lotusDoors.filter((x) => x.pivot.visible).length, te.breakWall.mesh.visible];
        return out;
    });
    assert.deepEqual(r.doors, [['LION GATE', -26, -22, true, true], ['SERPENT GATE', -20, 22, true, true]], 'two doors from the layout, open');
    assert.ok(r.openRoute > 0 && r.openRoute < 20, `open: bots walk straight past (${r.openRoute} m)`);
    assert.ok(r.openSight, 'open: sight past the slab');
    assert.ok(r.turning, '[F] starts it turning');
    assert.ok(r.turnSecs > 2 && r.turnSecs < 3, `a slow turn (${r.turnSecs} s)`);
    assert.ok(r.shut, 'then it is shut');
    assert.ok(r.shutRoute < 0 || r.shutRoute > r.openRoute + 40, `shut: bots go the long way round (${r.shutRoute} m)`);
    assert.equal(r.shutSight, false, 'shut: no sight through it');
    assert.ok(r.stoppedAt > -21.8, `shut: you stop at it (z ${r.stoppedAt})`);
    assert.ok(r.wallWhole, 'the wall stands at the start');
    assert.ok(r.wallRoute < 0 || r.wallRoute > 30, `whole: bots go round (${r.wallRoute} m)`);
    assert.equal(r.wallSight, false, 'whole: no sight through it');
    assert.ok(r.shots >= 8 && r.shots <= 10, `about nine rifle hits break it (${r.shots})`);
    assert.ok(r.wallBroken, 'shot to pieces');
    assert.ok(r.brokenRoute > 0 && r.brokenRoute < 12, `broken: bots walk through (${r.brokenRoute} m)`);
    assert.ok(r.brokenSight, 'broken: sight through');
    assert.deepEqual(r.reset.slice(0, 2), [true, true], 'a new round: door open, wall whole');
    assert.ok(r.reset[2] > 0 && r.reset[2] < 20);
    assert.deepEqual(r.ascent, [0, false], 'none on Ascent');
    await frames(2);
    assert.deepEqual(errors, []);
});
