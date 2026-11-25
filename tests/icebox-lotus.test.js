'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser } = require('./harness');
const mapSuite = require('./map-suite');

after(closeBrowser);

// V2.1 Icebox (and Lotus, once it is rebuilt): their own layouts in Ascent's format. The shared
// checks are in map-suite.js; Icebox's rope ascenders below.

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
    }
};

mapSuite('Icebox', MAPS);

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
