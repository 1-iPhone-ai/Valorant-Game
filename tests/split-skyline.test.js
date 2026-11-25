'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser } = require('./harness');
const mapSuite = require('./map-suite');

after(closeBrowser);

// V2.1 Split and Skyline: their own layouts in Ascent's format. The shared checks are in map-suite.js;
// Split's rope ascenders below (Skyline's skybridge, landmarks and city are in skyline.test.js).

const MAPS = {
    split: {
        keys: ['A', 'B'],
        lanes: {
            TRAM: [['tramN', { zMax: -13 }], ['tramJog'], ['tramE'], ['tramIn', { xMax: 0 }]],
            CROSSING: [['crossing'], ['crossIn', { xMin: -33 }]],
            UNDER: [['under', { zMax: -12 }], ['underE', { xMax: 0 }]],
            PARK: [['parkS', { zMin: 13 }], ['parkJog'], ['parkE'], ['parking', { xMax: 0 }]],
            ARCADE: [['arcade', { zMin: 12 }], ['arcadeE', { xMax: 0 }]],
            NEON: [['neonN', { zMax: -13 }], ['neonW', { xMin: 25 }]],
            RAMEN: [['ramenS', { zMin: 13 }], ['ramenW', { xMin: 25 }]],
            CONC: [['concE', { xMax: 33 }], ['concJog'], ['concW', { xMin: -4 }]]
        },
        meet: [['UNDER', 'CROSSING'], ['ARCADE', 'CROSSING'], ['CONC', 'CROSSING']],
        siteRects: { A: 'aSite', B: 'bSite' },
        entrances: { A: [[3.3, -43.5], [5.5, -29.3], [18.7, -35.5]], B: [[3.3, 43], [5.5, 29.3], [18.7, 35.5]] },
        chokes: [['z', -22, 'tramN'], ['x', -32, 'crossIn'], ['z', -20, 'under'], ['z', 22, 'parkS'], ['z', 20, 'arcade'], ['x', 29.5, 'neonW'], ['x', 29.5, 'ramenW'], ['x', 5, 'concW']],
        heaven: { from: [7, -44.75], yaw: -Math.PI / 2, x: 15.5, zone: 'CAPSULE DECK' },
        zones: [[-44, -28, 'TRAM WALK'], [-8, -43.5, 'TRAM WALK'], [-13, -14, 'UNDERPASS'], [-4, -26.5, 'UNDERPASS'], [-22, -6, 'THE CROSSING'], [11, -42, 'A SITE'],
            [45, -22, 'NEON ALLEY'], [-21, 14, 'GAME ARCADE'], [-44, 28, 'CAR PARK'], [-8, 43, 'CAR PARK'], [11, 42, 'B SITE'], [45, 22, 'RAMEN ROW'], [12, 7, 'CONCOURSE'],
            [29, -20, 'SHRINE GARDEN'], [-44, 0, 'ATTACKER SPAWN'], [44, 0, 'DEFENDER SPAWN']]
    },
    skyline: {
        keys: ['A', 'B'],
        // The brief's callouts name the sites themselves (there is no 'A SITE' on Skyline)
        siteCallouts: ['HELIPAD', 'SERVER ROOF'],
        lanes: {
            ALOBBY: [['lobbyAIn', { zMax: -13 }], ['lobbyA'], ['stairsA', { xMax: -13 }]],
            MID: [['water'], ['waterIn', { xMin: -33 }], ['waterOut'], ['plaza']],
            ALLEYN: [['alleyN', { zMax: -12, zMin: -25 }]],
            ALLEYS: [['alleyS', { zMin: 12 }], ['alleySJ', { xMax: 0 }]],
            VENT: [['vent'], ['ventIn', { xMax: 33 }], ['ventOut']],
            BLOBBY: [['lobbyBIn', { zMin: 13 }], ['lobbyB'], ['bLane', { xMax: 0 }]],
            LINKA: [['linkAN', { zMax: -13 }], ['linkAW', { xMin: 18 }]],
            LINKB: [['linkBS', { zMin: 13 }], ['linkBW', { xMin: 25 }]]
        },
        meet: [['MID', 'ALLEYN'], ['MID', 'ALLEYS'], ['MID', 'VENT']],
        siteRects: { A: 'aSite', B: 'bSite' },
        entrances: { A: [[-9.7, -43], [8, -28.3], [11.7, -37]], B: [[3.3, 43], [6, 30.3], [18.7, 35]] },
        chokes: [['z', -22, 'lobbyAIn'], ['z', 22, 'lobbyBIn'], ['x', -33.5, 'waterIn'], ['z', -19, 'alleyN'], ['z', 17, 'alleyS'], ['x', 32.5, 'ventIn'], ['x', 29.5, 'linkAW'], ['x', 29.5, 'linkBW']],
        heaven: { from: [0.5, -44.75], yaw: -Math.PI / 2, x: 8.5, zone: 'CONTROL BOOTH' },
        zones: [[-44, -28, 'A LOBBY'], [-41, -38, 'A LOBBY'], [-28, -43, 'A STAIRS'], [-6.5, -31.5, 'HELIPAD'], [-24, 4, 'WATER TOWER'], [-12, 5, 'ALLEY'], [8, -24, 'ALLEY'],
            [-6, 21, 'ALLEY'], [20, 0, 'VENT FARM'], [45, -22, 'VENT FARM'], [-44, 28, 'B LOBBY'], [-28, 43, 'B LOBBY'], [12.5, 36.5, 'SERVER ROOF'], [45, 22, 'BILLBOARD'],
            [-44, 0, 'ATTACKER SPAWN'], [44, 0, 'DEFENDER SPAWN']]
    }
};

mapSuite('Split and Skyline', MAPS);

test('Split rope ascenders: placed from the layout, hold F at a cable to climb onto the Vent Loft and the Ticket Roof, none on the other maps', { timeout: 300000 }, async () => {
    const { errors, frames, evaluate } = await boot({ quality: 'low' });
    await evaluate(() => { window.updateEnemies = () => {}; tacticalDirector.setGameMode('wave'); rebuildMapPreset('split'); });
    await frames(3);
    const r = await evaluate(() => {
        const te = tacticalEnhancements, L = mapLayout(), cc = characterController, out = { rigs: [], climbs: [] };
        te.updateMapMechanics(1 / 60, performance.now());
        for (const rig of te.layoutRopes) out.rigs.push([rig.group.visible, +rig.group.position.x.toFixed(2), +rig.group.position.z.toFixed(2)]);
        out.oldZiplines = 'splitZiplines' in te || 'splitGroup' in te;
        let t = performance.now();
        for (const rope of L.ropes) {
            // Start half a metre off the cable, on the side away from the deck
            const dx = rope.exit.x - rope.x, dz = rope.exit.z - rope.z, d = Math.hypot(dx, dz);
            cc.reset();
            cc.position.set(rope.x - 0.5 * dx / d, cc.standHeight, rope.z - 0.5 * dz / d);
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
            out.climbs.push({ name: rope.name, stepped, foot: +(cc.position.y - cc.height).toFixed(2), at: [+cc.position.x.toFixed(2), +cc.position.z.toFixed(2)], exit: [rope.exit.x, rope.exit.z],
                zone: tacticalRadar.getZoneName(cc.position.x, cc.position.y, cc.position.z) });
        }
        rebuildMapPreset('ascent');
        te.updateMapMechanics(1 / 60, performance.now());
        out.ascent = te.layoutRopes.filter((g) => g.group.visible).length;
        return out;
    });
    assert.equal(r.oldZiplines, false, 'the old open-arena ziplines are gone');
    const want = [[-12.1, -27.5], [-20.4, 0]];
    assert.deepEqual(r.rigs.slice(0, 2), want.map((p) => [true, p[0], p[1]]), 'a rig at each of the layout\'s ropes');
    assert.ok(r.rigs.slice(2).every((g) => !g[0]), 'the spare rigs stay hidden');
    const decks = { 'UNDERPASS ASCENDER': [3, 'VENT LOFT'], 'CROSSING ASCENDER': [5.2, 'TICKET ROOF'] };
    for (const c of r.climbs) {
        assert.ok(c.stepped, `${c.name}: stepped off at the top`);
        assert.ok(Math.abs(c.foot - decks[c.name][0]) < 0.15, `${c.name}: standing on the deck (feet ${c.foot} m up)`);
        assert.ok(Math.hypot(c.at[0] - c.exit[0], c.at[1] - c.exit[1]) < 0.6, `${c.name}: at the exit (${c.at})`);
        assert.equal(c.zone, decks[c.name][1]);
    }
    assert.equal(r.ascent, 0, 'no ropes on Ascent');
    await frames(2);
    assert.deepEqual(errors, []);
});
